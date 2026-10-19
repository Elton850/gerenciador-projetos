// Importador BT → SQL: a parte que fala com o SQL Server. Roda DENTRO do processo-filho (src/dbworker.js), como todo acesso
// ao banco do app (ADR-004): a leitura do .bt em streaming e os INSERTs não travam o servidor web, e cancelar/derrubar o
// processo faz o SQL Server desfazer a transação aberta.
//
// importFile(adapter, …) é a mesma regra do app original (append_dataframe), com as operações de banco num "adaptador":
// o adaptador SQL (abaixo) e o adaptador em memória do teste de paridade executam exatamente o mesmo fluxo.
//
// Segurança: valores SEMPRE como parâmetros (@p0, @p1…); nomes de banco/tabela/coluna validados (plan.js) e entre colchetes
// com ]] escapado; cada comando gerado é conferido contra o formato esperado antes de ir ao banco.
const { parseFile } = require('./parse');
const { alignColumns, isAllowedFn, quoteIdent, dbNameError, identError } = require('./plan');

const MAX_PARAMS = 2000; // SQL Server aceita 2100 parâmetros por comando
const MAX_VALUES_ROWS = 1000; // e até 1000 linhas por VALUES
const rowsPerInsert = (ncols) => Math.max(1, Math.min(MAX_VALUES_ROWS, Math.floor(MAX_PARAMS / Math.max(1, ncols))));

const cancelledError = () => Object.assign(new Error('Importação cancelada. O arquivo em andamento foi desfeito (a transação não foi confirmada).'), { cancelled: true, status: 499 });

// Aplica a regra do original lote a lote: 1ª vez da tabela → cria (todas NVARCHAR(MAX) NULL); depois alinha colunas sem
// diferenciar maiúsculas e acrescenta as que faltam (ou falha, se "Adicionar colunas que faltam" estiver desligado).
async function importFile(adapter, { filePath, expectedSha = null, settings, onProgress = () => {}, isCancelled = () => false }) {
  const cache = new Map();
  const tables = {};
  const created = []; const altered = [];
  let rows = 0;
  const res = await parseFile(filePath, {
    isAllowed: isAllowedFn(settings),
    batchSize: settings.batchSize,
    shouldStop: isCancelled,
    onChunk: (bytes) => onProgress({ bytes, rows }),
    onBatch: async (table, fields, batch) => {
      if (isCancelled()) throw cancelledError();
      const tErr = identError(table, 'Nome de tabela') || fields.map((c) => identError(c, 'Nome de coluna')).find(Boolean);
      if (tErr) throw new Error(`${table}: ${tErr}`);
      let cols = cache.has(table) ? cache.get(table) : await adapter.getColumns(table);
      const a = alignColumns(cols, fields);
      if (a.create) {
        await adapter.createTable(table, fields);
        cols = [...fields]; created.push(table);
      } else if (a.addColumns.length) {
        if (!settings.addMissingColumns) throw Object.assign(new Error(`Tabela destino incompatível: dbo.${table} não tem as colunas ${a.addColumns.join(', ')} (e "Adicionar colunas que faltam" está desligado).`), { code: 'BT_INCOMPATIBLE' });
        await adapter.addColumns(table, a.addColumns);
        cols = [...cols, ...a.addColumns]; altered.push({ table, columns: a.addColumns });
      }
      cache.set(table, cols);
      const n = await adapter.insert(table, a.insertColumns, batch);
      if (n !== batch.length) throw new Error(`dbo.${table}: o banco confirmou ${n} de ${batch.length} linha(s) do lote. Arquivo desfeito.`);
      tables[table] = (tables[table] || 0) + n;
      rows += n;
      onProgress({ rows, table });
    },
  });
  if (res.stopped || isCancelled()) throw cancelledError();
  if (expectedSha && res.sha256 !== expectedSha) throw Object.assign(new Error('O arquivo mudou depois da validação (conteúdo diferente). Ele foi desfeito; valide de novo.'), { code: 'BT_FILE_CHANGED' });
  return { tables, rows, created, altered, bytes: res.bytes, sha256: res.sha256, malformed: res.malformed, encountered: res.encountered };
}

// ---------- Adaptador SQL Server (mssql, dentro de uma transação) ----------
const SAFE = {
  create: /^CREATE TABLE \[dbo\]\.\[(?:[^\]]|\]\])+\] \((?:\[(?:[^\]]|\]\])+\] NVARCHAR\(MAX\) NULL(?:, )?)+\)$/,
  alter: /^ALTER TABLE \[dbo\]\.\[(?:[^\]]|\]\])+\] ADD (?:\[(?:[^\]]|\]\])+\] NVARCHAR\(MAX\) NULL(?:, )?)+$/,
  insert: /^INSERT INTO \[dbo\]\.\[(?:[^\]]|\]\])+\] \((?:\[(?:[^\]]|\]\])+\](?:, )?)+\) VALUES (?:\((?:@bt\d+(?:, )?)+\)(?:, )?)+$/,
  createdb: /^CREATE DATABASE \[(?:[^\]]|\]\])+\]$/,
};
function assertGenerated(kind, sql) {
  if (!SAFE[kind] || !SAFE[kind].test(sql)) throw new Error(`Comando bloqueado pela trava de segurança do Importador BT (${kind}).`);
  return sql;
}

function sqlAdapter(h, tx) {
  const req = () => new h.sql.Request(tx);
  const full = (t) => `[dbo].${quoteIdent(t)}`;
  return {
    async getColumns(table) {
      const r = await req().input('t', h.sql.NVarChar(400), full(table))
        .query("SELECT c.name FROM sys.columns c WHERE c.object_id = OBJECT_ID(@t, 'U') ORDER BY c.column_id");
      return r.recordset.length ? r.recordset.map((x) => x.name) : null;
    },
    async createTable(table, cols) {
      await req().batch(assertGenerated('create', `CREATE TABLE ${full(table)} (${cols.map((c) => `${quoteIdent(c)} NVARCHAR(MAX) NULL`).join(', ')})`));
    },
    async addColumns(table, cols) {
      await req().batch(assertGenerated('alter', `ALTER TABLE ${full(table)} ADD ${cols.map((c) => `${quoteIdent(c)} NVARCHAR(MAX) NULL`).join(', ')}`));
    },
    async insert(table, cols, rows) {
      const per = rowsPerInsert(cols.length);
      const head = `INSERT INTO ${full(table)} (${cols.map(quoteIdent).join(', ')}) VALUES `;
      let total = 0;
      for (let i = 0; i < rows.length; i += per) {
        const chunk = rows.slice(i, i + per);
        const r = req();
        let k = 0;
        const values = chunk.map((row) => `(${row.map((v) => {
          const name = `bt${k++}`; // nunca @p<n>: o ODBC nomeia os parâmetros posicionais @P1…@Pn por dentro e o SQL Server não diferencia caixa
          r.input(name, v !== null && v.length > 4000 ? h.sql.NVarChar(h.sql.MAX) : h.sql.NVarChar(4000), v);
          return `@${name}`;
        }).join(', ')})`).join(', ');
        const out = await r.query(assertGenerated('insert', head + values));
        total += (out.rowsAffected || []).reduce((n, x) => n + (Number(x) || 0), 0);
      }
      return total;
    },
  };
}

// ---------- Operações do processo-filho ----------
// Pré-checagem SOMENTE LEITURA conectada ao master: identidade, permissão de criar banco e, por banco, situação, permissões
// e colunas das tabelas que os arquivos vão usar.
async function precheck(core, conn, password, { databases }) {
  return core.withPool({ ...conn, database: 'master' }, password, async (h) => {
    const who = await core.identity(h);
    const perm = await h.pool.request().query("SELECT HAS_PERMS_BY_NAME(NULL, NULL, 'CREATE ANY DATABASE') AS can_create_db");
    const out = { identity: who, canCreateDatabase: perm.recordset[0].can_create_db === 1, databases: {} };
    for (const d of databases) {
      if (dbNameError(d.name)) continue;
      const r = await h.pool.request().input('n', h.sql.NVarChar(128), d.name)
        .query('SELECT name, state_desc, HAS_DBACCESS(name) AS has_access FROM sys.databases WHERE name = @n');
      const row = r.recordset[0];
      const info = { name: row ? row.name : d.name, exists: !!row, online: row ? row.state_desc === 'ONLINE' : false, state: row ? row.state_desc : null, accessible: row ? row.has_access === 1 : false, tables: {} };
      if (row && info.online && info.accessible) {
        // sp_executesql do próprio banco: as funções de permissão e o catálogo respondem no contexto dele.
        const exec = `EXEC ${quoteIdent(row.name)}.sys.sp_executesql`;
        const p = await h.pool.request().query(`${exec} N'SELECT HAS_PERMS_BY_NAME(DB_NAME(), ''DATABASE'', ''CREATE TABLE'') AS can_create, HAS_PERMS_BY_NAME(''dbo'', ''SCHEMA'', ''INSERT'') AS can_insert, HAS_PERMS_BY_NAME(''dbo'', ''SCHEMA'', ''ALTER'') AS can_alter'`);
        const pr = p.recordset[0];
        Object.assign(info, { canCreateTable: pr.can_create === 1, canInsert: pr.can_insert === 1, canAlter: pr.can_alter === 1 });
        for (const t of d.tables || []) {
          if (identError(t, 'tabela')) continue;
          const c = await h.pool.request().input('t', h.sql.NVarChar(400), `[dbo].${quoteIdent(t)}`)
            .query(`${exec} N'SELECT c.name, c.is_nullable, c.is_identity, c.is_computed, CASE WHEN c.default_object_id <> 0 THEN 1 ELSE 0 END AS has_default, ty.name AS type_name FROM sys.columns c JOIN sys.types ty ON ty.user_type_id = c.user_type_id WHERE c.object_id = OBJECT_ID(@t, ''U'') ORDER BY c.column_id', N'@t nvarchar(400)', @t = @t`);
          if (c.recordset.length) {
            info.tables[t] = { columns: c.recordset.map((x) => ({ name: x.name, nullable: !!x.is_nullable, identity: !!x.is_identity, computed: !!x.is_computed, hasDefault: x.has_default === 1, type: x.type_name })) };
          }
        }
      }
      out.databases[d.name.toLowerCase()] = info;
    }
    return out;
  });
}

// CREATE DATABASE não pode rodar dentro de transação: roda sozinho, conectado ao master, só para bancos que ainda não existem.
async function createDatabases(core, conn, password, { names }) {
  return core.withPool({ ...conn, database: 'master' }, password, async (h) => {
    const created = [];
    for (const name of names) {
      const err = dbNameError(name);
      if (err) throw new Error(err);
      const r = await h.pool.request().input('n', h.sql.NVarChar(128), name).query('SELECT DB_ID(@n) AS id');
      if (r.recordset[0].id !== null) continue;
      await h.pool.request().batch(assertGenerated('createdb', `CREATE DATABASE ${quoteIdent(name)}`));
      created.push(name);
    }
    return { created };
  });
}

// Um arquivo = uma transação no banco de destino (SET XACT_ABORT ON): erro, cancelamento ou arquivo alterado → ROLLBACK.
async function importOne(core, conn, password, { filePath, expectedSha, settings }, { progress, isCancelled }) {
  return core.withPool(conn, password, async (h) => {
    const who = await core.identity(h);
    if (who.database.toLowerCase() !== conn.database.toLowerCase()) throw new Error(`A conexão abriu o banco "${who.database}", diferente do destino ("${conn.database}"). Nada foi importado.`);
    const tx = new h.sql.Transaction(h.pool);
    await tx.begin();
    try {
      await new h.sql.Request(tx).batch('SET XACT_ABORT ON;');
      const r = await importFile(sqlAdapter(h, tx), { filePath, expectedSha, settings, onProgress: progress, isCancelled });
      if (isCancelled()) throw cancelledError();
      await tx.commit();
      return r;
    } catch (e) {
      try { await tx.rollback(); } catch { /* já encerrada */ }
      if (!e.cancelled) e.message = core.friendly(e);
      throw e;
    }
  });
}

module.exports = { importFile, sqlAdapter, precheck, createDatabases, importOne, rowsPerInsert, assertGenerated };
