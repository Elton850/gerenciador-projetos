// Regras puras do Importador BT → SQL (sem HTTP, disco ou banco). Reproduzem o app de referência "bt sql gui":
//   - destino de cada ARQUIVO = um BANCO (padrão MIGRA_<ARQUIVO>); cada BLOCO do arquivo = uma tabela dbo.<bloco>;
//   - arquivos com o mesmo banco (sem diferenciar maiúsculas; vale a 1ª grafia) alimentam as mesmas tabelas (append);
//   - tabela nova: todas as colunas NVARCHAR(MAX) NULL; tabela existente: alinha colunas sem diferenciar maiúsculas e
//     acrescenta as que faltam (ALTER TABLE ADD ... NVARCHAR(MAX) NULL) — nunca apaga nada.
// Diferenças deliberadas (documentadas no Vault): sem "Recriar bancos" (DROP DATABASE); nome de banco mais restrito porque
// entra na connection string; validação antes de executar; transação por arquivo.
const crypto = require('crypto');

// Lista "Somente tabelas configuradas no layout atual" do app original (REQUIRED_TABLES). Comparação exata (com caixa).
const DEFAULT_ALLOWED_TABLES = [
  'EVE', 'EPG', 'SEP', 'DEP', 'CAR', 'CBA', 'EMP', 'SIN', 'AVI', 'PAE',
  'PVE', 'AGE', 'MUN', 'UFD', 'BAN', 'DRM', 'EBC', 'EED', 'EFP', 'EPR',
  'ERF', 'EST', 'FOL', 'FPG', 'GPS', 'HOR', 'LOT', 'TLI', 'LIC', 'REC',
  'EFO', 'TRC', 'TFO', 'VID', 'TB_MOT_DES', 'PAF', 'FER', 'IND', 'EPC',
  'ASO', 'ESO', 'PRS',
];
const DEFAULT_SETTINGS = { onlyAllowed: true, allowedTables: DEFAULT_ALLOWED_TABLES, addMissingColumns: true, batchSize: 5000, namePattern: 'MIGRA_[ARQUIVO]', recursive: false, stopOnError: false };
const SYSTEM_DATABASES = new Set(['master', 'model', 'msdb', 'tempdb']);
const MAX_FILES = 500;
const HISTORY_MAX = 50;

// Nome do arquivo sem a última extensão (Path.stem do Python), em maiúsculas e só [A-Z0-9_] (make_default_database_name).
function fileBase(fileName) {
  const name = String(fileName).split(/[\\/]/).pop();
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return stem.toUpperCase().replace(/[^A-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'BT';
}
const defaultDbName = (fileName) => `MIGRA_${fileBase(fileName)}`.slice(0, 128);
// AUTO do original: [ARQUIVO] vira o nome do arquivo; sem [ARQUIVO], todos vão para o mesmo banco.
const applyPattern = (pattern, fileName) => (String(pattern).includes('[ARQUIVO]') ? String(pattern).split('[ARQUIVO]').join(fileBase(fileName)) : String(pattern));

// validate_database_name do original + restrição de caracteres: o nome entra na connection string (mesmo conjunto aceito
// por src/db-core.js, sem a barra invertida) e entre colchetes no SQL.
const DB_NAME_RE = /^[\p{L}\p{N}_][\p{L}\p{N}_\-. ]*$/u;
function dbNameError(raw) {
  const name = String(raw ?? '').trim();
  if (!name) return 'Há arquivo sem banco de destino informado.';
  if (name.length > 128) return `Nome de banco maior que 128 caracteres: ${name.slice(0, 40)}…`;
  if (/[\u0000-\u001f]/.test(name)) return 'Nome de banco contém caractere de controle.';
  if (SYSTEM_DATABASES.has(name.toLowerCase())) return `O banco de sistema "${name}" não pode ser usado como destino.`;
  if (!DB_NAME_RE.test(name)) return `Nome de banco inválido: "${name}". Use letras, números, _ - . e espaço (começando por letra, número ou _).`;
  return null;
}
// Nome de tabela/coluna vindo do arquivo: qualquer texto (o SQL usa colchetes), menos caractere de controle e > 128.
function identError(name, what) {
  if (!name) return `${what} vazio.`;
  if (name.length > 128) return `${what} maior que 128 caracteres: ${name.slice(0, 40)}…`;
  if (/[\u0000-\u001f]/.test(name)) return `${what} com caractere de controle.`;
  return null;
}
const quoteIdent = (name) => `[${String(name).replace(/]/g, ']]')}]`;

// Mesmo banco escrito com caixas diferentes = um banco só; vale a primeira grafia (como o _processing_worker original).
function canonicalizeDatabases(mappings) {
  const canon = new Map();
  return mappings.map((m) => {
    const key = m.database.trim().toLowerCase();
    if (!canon.has(key)) canon.set(key, m.database.trim());
    return { ...m, database: canon.get(key) };
  });
}

// append_dataframe: como as colunas do lote entram numa tabela. existing = colunas atuais (null = tabela não existe).
//  → { create, insertColumns (na ordem do lote, já com a grafia da tabela), addColumns }
function alignColumns(existing, fields) {
  if (!existing) return { create: true, insertColumns: [...fields], addColumns: [] };
  const canonical = new Map(existing.map((c) => [c.toLowerCase(), c]));
  const insertColumns = fields.map((f) => canonical.get(f.toLowerCase()) || f);
  const addColumns = fields.filter((f) => !canonical.has(f.toLowerCase()));
  return { create: false, insertColumns, addColumns };
}

const isAllowedFn = (settings) => {
  if (!settings.onlyAllowed) return () => true;
  const set = new Set(settings.allowedTables || []);
  return (t) => set.has(t);
};

function cleanSettings(input = {}, current = DEFAULT_SETTINGS) {
  const s = { ...DEFAULT_SETTINGS, ...current };
  if (input.onlyAllowed !== undefined) s.onlyAllowed = !!input.onlyAllowed;
  if (input.addMissingColumns !== undefined) s.addMissingColumns = !!input.addMissingColumns;
  if (input.recursive !== undefined) s.recursive = !!input.recursive;
  if (input.stopOnError !== undefined) s.stopOnError = !!input.stopOnError;
  if (input.batchSize !== undefined) {
    const n = Math.round(Number(input.batchSize));
    if (!(n >= 100 && n <= 50000)) throw Object.assign(new Error('Linhas por lote: informe um número entre 100 e 50.000.'), { status: 400 });
    s.batchSize = n;
  }
  if (input.namePattern !== undefined) {
    const p = String(input.namePattern || '').trim();
    const err = p ? dbNameError(applyPattern(p, 'ARQUIVO.bt')) : 'Informe o padrão do banco de destino.';
    if (err) throw Object.assign(new Error(`Padrão do banco: ${err}`), { status: 400 });
    s.namePattern = p;
  }
  if (input.allowedTables !== undefined) {
    const list = Array.isArray(input.allowedTables) ? input.allowedTables : String(input.allowedTables).split(/[\s,;]+/);
    const out = [];
    for (const raw of list) {
      const t = String(raw).trim();
      if (!t) continue;
      const err = identError(t, 'Nome de tabela');
      if (err) throw Object.assign(new Error(`Tabelas permitidas: ${err}`), { status: 400 });
      if (!out.includes(t)) out.push(t);
    }
    if (out.length > 1000) throw Object.assign(new Error('Tabelas permitidas: no máximo 1000 nomes.'), { status: 400 });
    s.allowedTables = out;
  }
  return s;
}

// ---------- Validação (plano) ----------
// files: [{ path, name, size, sha256, database, scan: resultado de parse.scanFile | { error } }]
// target: resultado da pré-checagem { canCreateDatabase, databases: { [nome]: { exists, online, canCreateTable, canInsert, canAlter, tables: { [nome]: { columns: [{name, nullable, identity, computed, hasDefault, type}] } } } } }
// Devolve { items (por arquivo), groups (por banco → tabelas), issues (bloqueios gerais), hash }.
function buildValidation({ files, settings, target, connection }) {
  const issues = [];
  const allowed = isAllowedFn(settings);
  const mapped = canonicalizeDatabases(files.map((f) => ({ ...f, database: String(f.database || '').trim() })));
  const groups = new Map(); // banco (canônico) → { database, files: [], tables: Map, ... }

  const items = mapped.map((f) => {
    const it = { path: f.path, name: f.name, size: f.size, sha256: f.sha256, database: f.database, status: 'ok', reasons: [], warnings: [], tables: [], rows: 0 };
    const dbErr = dbNameError(f.database);
    if (dbErr) { it.status = 'blocked'; it.reasons.push(dbErr); }
    const sc = f.scan;
    if (!sc || sc.error) { it.status = 'blocked'; it.reasons.push(sc?.error || 'Arquivo não pôde ser lido.'); return it; }
    if (sc.sawNul) { it.status = 'blocked'; it.reasons.push('Arquivo inválido: contém bytes nulos (parece binário, não texto .bt).'); return it; }
    if (!sc.bytes) { it.status = 'empty'; it.warnings.push('Arquivo vazio: nada a importar.'); return it; }
    if (!sc.blockLines) { it.status = 'blocked'; it.reasons.push('Formato BT não reconhecido: nenhum bloco [TABELA] encontrado.'); return it; }
    if (sc.malformed) it.warnings.push(`${sc.malformed} linha(s) com quantidade de campos diferente do cabeçalho serão ajustadas (como no app original).`);
    if (sc.ignoredLines) it.warnings.push(`${sc.ignoredLines} linha(s) fora de bloco ou de bloco sem cabeçalho serão ignoradas (como no app original).`);
    for (const t of sc.tables) {
      const inList = allowed(t.name);
      const fieldSets = t.fieldSets || [];
      const tableErr = identError(t.name, 'Nome de tabela');
      const colErr = fieldSets.flat().map((c) => identError(c, 'Nome de coluna')).find(Boolean);
      const entry = { name: t.name, rows: t.rows, columns: fieldSets[0] || [], fieldSets, included: inList && t.rows > 0 && fieldSets.length > 0, skipReason: !inList ? 'fora da lista de tabelas' : !fieldSets.length ? 'bloco sem cabeçalho' : !t.rows ? 'sem linhas' : null };
      if (entry.included && (tableErr || colErr)) { it.status = 'blocked'; it.reasons.push(`${t.name}: ${tableErr || colErr}`); }
      it.tables.push(entry);
      if (entry.included) it.rows += t.rows;
    }
    if (!it.tables.some((t) => t.included) && it.status === 'ok') { it.status = 'empty'; it.warnings.push('Nenhuma tabela com dados para importar neste arquivo (como o app original, ele é pulado).'); }
    return it;
  });

  // Agrupa por banco e por tabela, simulando a ordem real (arquivo a arquivo) para saber o que será criado/acrescentado.
  for (const it of items) {
    if (it.status === 'blocked' && dbNameError(it.database)) continue;
    const key = it.database.toLowerCase();
    if (!groups.has(key)) {
      const info = target?.databases?.[key] || null; // pré-checagem: chave = nome do banco em minúsculas
      groups.set(key, { database: it.database, exists: !!info?.exists, info, files: [], tables: new Map(), issues: [], createDatabase: !info?.exists });
    }
    const g = groups.get(key);
    g.files.push(it.name);
    if (it.status !== 'ok') continue;
    for (const t of it.tables.filter((x) => x.included)) {
      const tkey = t.name; // a tabela do SQL Server é a do nome do bloco (o cache do original é por nome exato)
      let gt = g.tables.get(tkey);
      if (!gt) {
        const existing = g.info?.tables?.[t.name] || null;
        gt = { name: t.name, existed: !!existing, existingColumns: existing ? existing.columns : null, columns: existing ? existing.columns.map((c) => c.name) : null, files: [], rows: 0, create: false, addColumns: [], issues: [], warnings: [] };
        g.tables.set(tkey, gt);
      }
      gt.files.push(it.name);
      gt.rows += t.rows;
      for (const fields of t.fieldSets) {
        const a = alignColumns(gt.columns, fields);
        if (a.create) { gt.create = true; gt.columns = [...fields]; continue; }
        if (a.addColumns.length) {
          if (!settings.addMissingColumns) {
            gt.issues.push(`${it.name}: colunas ${a.addColumns.join(', ')} não existem em ${g.database}.dbo.${t.name} e "Adicionar colunas que faltam" está desligado.`);
          } else {
            for (const c of a.addColumns) if (!gt.addColumns.some((x) => x.toLowerCase() === c.toLowerCase())) gt.addColumns.push(c);
            gt.columns = [...gt.columns, ...a.addColumns];
          }
        }
        // Estrutura incompatível de uma tabela que JÁ existia: colunas obrigatórias que o arquivo não preenche, ou colunas
        // que o SQL Server não deixa inserir (identity/computada). Bloqueia esse destino (nada dele é importado).
        if (gt.existingColumns) {
          const lower = new Set(fields.map((x) => x.toLowerCase()));
          const required = gt.existingColumns.filter((c) => !c.nullable && !c.hasDefault && !c.identity && !c.computed && !lower.has(c.name.toLowerCase()));
          if (required.length) gt.issues.push(`${it.name}: a tabela existente exige ${required.map((c) => c.name).join(', ')} (NOT NULL sem padrão), que o arquivo não tem.`);
          const blockedCols = gt.existingColumns.filter((c) => (c.identity || c.computed) && lower.has(c.name.toLowerCase()));
          if (blockedCols.length) gt.issues.push(`${it.name}: ${blockedCols.map((c) => c.name).join(', ')} é identity/computada na tabela existente e não aceita valores.`);
          const nonText = gt.existingColumns.filter((c) => lower.has(c.name.toLowerCase()) && c.type && !/char|text/i.test(c.type));
          if (nonText.length) { const w = `Colunas não-texto na tabela existente (${nonText.map((c) => `${c.name} ${c.type}`).join(', ')}): valores inválidos farão o arquivo falhar e ser desfeito.`; if (!gt.warnings.includes(w)) gt.warnings.push(w); }
        }
      }
    }
  }

  // Permissões e situação de cada banco (pré-checagem somente leitura).
  for (const g of groups.values()) {
    const info = g.info;
    const runnable = [...g.tables.values()];
    if (!runnable.length) continue;
    if (!info || !info.exists) {
      if (!target?.canCreateDatabase) g.issues.push(`O banco ${g.database} não existe e o login não tem permissão para criar bancos (CREATE ANY DATABASE).`);
    } else {
      if (!info.online) g.issues.push(`O banco ${g.database} não está ONLINE (${info.state || 'estado desconhecido'}).`);
      if (!info.accessible) g.issues.push(`O login não tem acesso ao banco ${g.database}.`);
      else {
        if (runnable.some((t) => t.create) && !info.canCreateTable) g.issues.push(`Sem permissão para criar tabelas em ${g.database} (CREATE TABLE).`);
        if (!info.canInsert) g.issues.push(`Sem permissão para inserir em ${g.database}.dbo (INSERT).`);
        if (runnable.some((t) => t.addColumns.length && t.existed) && !info.canAlter) g.issues.push(`Sem permissão para acrescentar colunas em ${g.database}.dbo (ALTER).`);
      }
    }
  }

  // Situação final por arquivo: bloqueio do banco/tabela de destino vale para todos os arquivos daquele destino.
  for (const it of items) {
    if (it.status !== 'ok') continue;
    const g = groups.get(it.database.toLowerCase());
    if (!g) continue;
    if (g.issues.length) { it.status = 'blocked'; it.reasons.push(...g.issues); continue; }
    for (const t of it.tables.filter((x) => x.included)) {
      const gt = g.tables.get(t.name);
      if (gt?.issues.length) { it.status = 'blocked'; it.reasons.push(...gt.issues.filter((m) => !it.reasons.includes(m))); }
      if (gt?.warnings.length) for (const w of gt.warnings) if (!it.warnings.includes(w)) it.warnings.push(w);
    }
  }

  const runnable = items.filter((i) => i.status === 'ok');
  const blocked = items.filter((i) => i.status === 'blocked');
  if (!items.length) issues.push('Nenhum arquivo selecionado.');
  else if (!runnable.length && !blocked.length) issues.push('Nenhum arquivo tem dados para importar.');
  if (blocked.length) issues.push(`${blocked.length} arquivo(s) com problema: desmarque-os ou corrija antes de importar (a importação não começa parcialmente).`);

  const groupList = [...groups.values()].map((g) => ({
    database: g.database, exists: g.exists, createDatabase: g.createDatabase && [...g.tables.values()].length > 0, files: g.files, issues: g.issues,
    tables: [...g.tables.values()].map((t) => ({ name: t.name, existed: t.existed, create: t.create, addColumns: t.addColumns, files: t.files, rows: t.rows, columns: t.columns || [], issues: t.issues, warnings: t.warnings })),
  }));
  const hash = crypto.createHash('sha256').update(JSON.stringify({
    v: 1, connection, settings: { onlyAllowed: settings.onlyAllowed, allowedTables: settings.onlyAllowed ? settings.allowedTables : null, addMissingColumns: settings.addMissingColumns, batchSize: settings.batchSize, stopOnError: settings.stopOnError },
    files: runnable.map((i) => [i.path, i.size, i.sha256, i.database]),
  })).digest('hex');
  return { items, groups: groupList, issues, hash, canExecute: !issues.length && runnable.length > 0, totals: { files: runnable.length, rows: runnable.reduce((n, i) => n + i.rows, 0), databases: groupList.filter((g) => g.tables.length).length } };
}

// Mensagem de erro sem dados: tira trechos entre aspas (o SQL Server cita valores em erros de conversão) e limita o tamanho.
const sanitizeError = (msg) => String(msg || '').replace(/'[^']*'/g, "'…'").replace(/"[^"]{60,}"/g, '"…"').slice(0, 500);

// Resumo final (por banco → tabela): arquivos e registros adicionados.
function summarize(results) {
  const dbs = new Map();
  for (const r of results) {
    if (r.status !== 'done') continue;
    for (const [table, rows] of Object.entries(r.tables || {})) {
      const d = dbs.get(r.database) || new Map(); dbs.set(r.database, d);
      const t = d.get(table) || { table, files: 0, rows: 0 }; d.set(table, t);
      t.files++; t.rows += rows;
    }
  }
  return [...dbs.entries()].map(([database, t]) => ({ database, tables: [...t.values()].sort((a, b) => a.table.localeCompare(b.table)) }));
}

// Dados persistidos da ferramenta (data.tools.btImporter): configuração e histórico resumido (sem conteúdo dos arquivos,
// sem senha). Idempotente: completa o que faltar e nunca altera o que o usuário já configurou.
function ensureData(data) {
  if (!data.tools || typeof data.tools !== 'object') data.tools = {};
  const t = data.tools.btImporter && typeof data.tools.btImporter === 'object' ? data.tools.btImporter : (data.tools.btImporter = {});
  t.settings = { ...DEFAULT_SETTINGS, ...(t.settings && typeof t.settings === 'object' ? t.settings : {}) };
  if (!Array.isArray(t.settings.allowedTables)) t.settings.allowedTables = [...DEFAULT_ALLOWED_TABLES];
  if (!Array.isArray(t.history)) t.history = [];
  return t;
}

module.exports = {
  ensureData, DEFAULT_ALLOWED_TABLES, DEFAULT_SETTINGS, SYSTEM_DATABASES, MAX_FILES, HISTORY_MAX,
  fileBase, defaultDbName, applyPattern, dbNameError, identError, quoteIdent, canonicalizeDatabases, alignColumns, isAllowedFn, cleanSettings,
  buildValidation, sanitizeError, summarize,
};
