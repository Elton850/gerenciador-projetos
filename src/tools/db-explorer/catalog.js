// Explorador de Banco — regras puras sobre o catálogo (metadados) de UM banco do SQL Server. Sem HTTP, sem disco, sem SQL Server:
// recebe as linhas lidas do catálogo (sql.js → op "tool:dbx-catalog") e responde visão geral, tabelas, mapa relacional,
// caminhos entre tabelas, montador de JOIN, busca e dicionário de dados.
//
// Referência funcional: app Python "SQL Server Migration Explorer" (C:\data_analisys). Diferenças deliberadas:
//  - relacionamento = CONSTRAINT inteira (chave composta vira um JOIN com AND), não uma linha por coluna;
//  - hipóteses (relacionamentos inferidos) apontam sempre para a CHAVE PRIMÁRIA da tabela de destino (mesmos nomes e tipos
//    compatíveis), em vez de comparar todas as colunas com todas — escala para bancos grandes (ex.: RM) e erra menos;
//  - caminhos com poda por distância (BFS) e opção de evitar "tabelas hub" (ex.: GCOLIGADA), que ligam tudo a tudo.
// Hipótese NUNCA é certeza: a tela mostra os motivos e oferece "Conferir no banco" (amostra de correspondência).

const MAX_INFERRED = 5000;

// ---------- Identificadores e nomes ----------
const quoteIdent = (s) => `[${String(s).replace(/\]/g, ']]')}]`;
const keyOf = (schema, name) => `${schema}.${name}`;
const lower = (s) => String(s || '').toLowerCase();
const tableRef = (t) => `${quoteIdent(t.schema)}.${quoteIdent(t.name)}`;

// Famílias de tipo: colunas só "casam" (hipótese) se forem da mesma família (inteiro × decimal também casam).
const FAMILY = {
  bigint: 'num', int: 'num', smallint: 'num', tinyint: 'num', numeric: 'num', decimal: 'num', bit: 'num', money: 'num', smallmoney: 'num',
  float: 'float', real: 'float',
  varchar: 'str', nvarchar: 'str', char: 'str', nchar: 'str', text: 'text', ntext: 'text', sysname: 'str',
  date: 'date', datetime: 'date', datetime2: 'date', smalldatetime: 'date', datetimeoffset: 'date', time: 'time',
  uniqueidentifier: 'guid', binary: 'bin', varbinary: 'bin', image: 'bin', timestamp: 'bin', rowversion: 'bin',
};
const familyOf = (type) => FAMILY[lower(type)] || 'other';
const typeCompatible = (a, b) => { const fa = familyOf(a); const fb = familyOf(b); return fa === fb && !['text', 'bin', 'other', 'float'].includes(fa); };

function typeLabel(c) {
  const t = lower(c.type);
  if (['varchar', 'char', 'varbinary', 'binary'].includes(t)) return `${t}(${c.maxLength === -1 ? 'max' : c.maxLength})`;
  if (['nvarchar', 'nchar'].includes(t)) return `${t}(${c.maxLength === -1 ? 'max' : c.maxLength / 2})`;
  if (['decimal', 'numeric'].includes(t)) return `${t}(${c.precision},${c.scale})`;
  if (['datetime2', 'time', 'datetimeoffset'].includes(t) && c.scale !== 7) return `${t}(${c.scale})`;
  return t;
}

// Classificação e campos sensíveis (mesmas pistas do app original).
const SENSITIVE_RE = /(senha|password|passwd|cpf|cnpj|\brg\b|^rg|email|e_mail|telefone|celular|fone|endereco|cep|token|secret|chave|salario|conta|agencia)/i;
const isSensitive = (name) => SENSITIVE_RE.test(String(name || ''));
function classifyColumn(name) {
  const n = lower(name);
  if (/cpf|cnpj|(^|_)rg($|_)/.test(n)) return 'identificador sensível';
  if (/(^|_)id|id($|_)|cod|codigo|matricula|chapa|(^|_)ra($|_)/.test(n)) return 'chave/identificador';
  if (/descricao|nome|status|situacao|tipo|curso|turma|serie|periodo|classif/.test(n)) return 'candidato a de-para';
  return 'atributo';
}
function maskValue(v) {
  if (v === null || v === undefined) return v;
  const t = String(v);
  return t.length <= 4 ? '*'.repeat(t.length) : t.slice(0, 2) + '*'.repeat(Math.max(t.length - 4, 1)) + t.slice(-2);
}
// Mascara as colunas sensíveis de um resultado { columns, rows } (linhas como arrays).
function maskResult(res) {
  const idx = res.columns.map((c, i) => (isSensitive(c) ? i : -1)).filter((i) => i >= 0);
  if (!idx.length) return { ...res, masked: [] };
  return { ...res, rows: res.rows.map((r) => { const o = [...r]; for (const i of idx) o[i] = maskValue(o[i]); return o; }), masked: idx.map((i) => res.columns[i]) };
}

// ---------- Montagem do catálogo ----------
// raw (sql.js): { identity, database, tables[{schema,name,rows,objectId}], columns[{objectId,name,type,maxLength,precision,scale,nullable,identity,computed,hasDefault,ord}],
//   indexes[{objectId,name,pk,unique,cols:[name]}], fks[{name,fromId,toId,pairs:[[src,tgt]],disabled,untrusted}], descriptions[{objectId,column,text}], counts }
function buildCatalog(raw) {
  const byId = new Map();
  const tables = [];
  for (const t of raw.tables || []) {
    const tb = { key: keyOf(t.schema, t.name), schema: t.schema, name: t.name, rows: Number(t.rows) || 0, columns: [], pk: [], uniques: [], indexes: [], description: '' };
    byId.set(t.objectId, tb);
    tables.push(tb);
  }
  for (const c of raw.columns || []) {
    const tb = byId.get(c.objectId);
    if (!tb) continue;
    tb.columns.push({ name: c.name, type: lower(c.type), maxLength: c.maxLength, precision: c.precision, scale: c.scale, nullable: !!c.nullable, identity: !!c.identity, computed: !!c.computed, hasDefault: !!c.hasDefault, ord: c.ord, description: '' });
  }
  for (const tb of tables) tb.columns.sort((a, b) => a.ord - b.ord);
  for (const ix of raw.indexes || []) {
    const tb = byId.get(ix.objectId);
    if (!tb || !ix.cols?.length) continue;
    tb.indexes.push({ name: ix.name, pk: !!ix.pk, unique: !!ix.unique, cols: ix.cols });
    if (ix.pk) tb.pk = [...ix.cols];
    else if (ix.unique) tb.uniques.push([...ix.cols]);
  }
  for (const d of raw.descriptions || []) {
    const tb = byId.get(d.objectId);
    if (!tb) continue;
    if (!d.column) tb.description = String(d.text || '').slice(0, 1000);
    else { const c = tb.columns.find((x) => x.name === d.column); if (c) c.description = String(d.text || '').slice(0, 1000); }
  }
  const rels = [];
  for (const fk of raw.fks || []) {
    const a = byId.get(fk.fromId); const b = byId.get(fk.toId);
    if (!a || !b || !fk.pairs?.length) continue;
    rels.push({ id: `fk:${a.key}:${fk.name}`, kind: 'fk', name: fk.name, from: a.key, to: b.key, pairs: fk.pairs, disabled: !!fk.disabled, untrusted: !!fk.untrusted, score: fk.disabled ? 90 : 100 });
  }
  const cat = { database: raw.database, identity: raw.identity || null, counts: raw.counts || {}, tables, rels, inferred: [], inferredAt: null };
  return index(cat);
}

// Índices em memória (recalculados ao gerar hipóteses).
function index(cat) {
  cat.byKey = new Map(cat.tables.map((t) => [t.key, t]));
  cat.byLower = new Map(cat.tables.map((t) => [lower(t.key), t]));
  for (const t of cat.tables) {
    t.colByLower = new Map(t.columns.map((c) => [lower(c.name), c]));
    t.fkCols = new Set(); t.refCols = new Set();
    t.indexed = new Set(t.indexes.flatMap((i) => i.cols.map(lower)));
  }
  for (const r of cat.rels) {
    const a = cat.byKey.get(r.from); const b = cat.byKey.get(r.to);
    for (const [s, d] of r.pairs) { a.fkCols.add(lower(s)); b.refCols.add(lower(d)); }
  }
  cat.adj = { fk: buildAdj(cat, cat.rels), all: buildAdj(cat, [...cat.rels, ...cat.inferred]) };
  return cat;
}
function buildAdj(cat, rels) {
  const m = new Map(cat.tables.map((t) => [t.key, []]));
  for (const r of rels) {
    if (r.from === r.to) { m.get(r.from).push({ rel: r, other: r.to, dir: 'self' }); continue; }
    m.get(r.from).push({ rel: r, other: r.to, dir: 'out' });
    m.get(r.to).push({ rel: r, other: r.from, dir: 'in' });
  }
  return m;
}
const adjOf = (cat, includeInferred) => (includeInferred ? cat.adj.all : cat.adj.fk);
const neighborsOf = (cat, key, includeInferred) => new Set((adjOf(cat, includeInferred).get(key) || []).filter((e) => e.other !== key).map((e) => e.other));
const degreeOf = (cat, key, includeInferred = false) => neighborsOf(cat, key, includeInferred).size;

function findTable(cat, key) {
  const t = cat.byKey.get(key) || cat.byLower.get(lower(key)) || (!String(key).includes('.') ? cat.byLower.get(`dbo.${lower(key)}`) : null);
  return t || null;
}

// ---------- Hipóteses (relacionamentos inferidos) ----------
// Para cada tabela de destino B com chave primária (k1..kn) procura tabelas A que têm TODAS as colunas da chave (mesmo nome, sem
// diferenciar maiúsculas, tipo compatível). Chave de uma coluna genérica ("ID", "CODIGO") também casa com <TABELA>ID / ID<TABELA> /
// <TABELA>_ID / COD<TABELA>. Já existe FK real cobrindo as mesmas colunas → não vira hipótese.
const GENERIC_PK = new Set(['id', 'codigo', 'cod', 'code', 'chave']);
const nameStem = (s) => lower(s).replace(/[^a-z0-9]/g, '');
function inferRelationships(cat, { minScore = 55, max = MAX_INFERRED } = {}) {
  const real = new Set(cat.rels.map((r) => `${r.from}>${r.to}>${r.pairs.map(([s]) => lower(s)).sort().join(',')}`));
  const out = [];
  for (const b of cat.tables) {
    if (!b.pk.length || b.pk.length > 6) continue;
    const pkCols = b.pk.map((n) => b.colByLower.get(lower(n))).filter(Boolean);
    if (pkCols.length !== b.pk.length) continue;
    const generic = pkCols.length === 1 && GENERIC_PK.has(lower(pkCols[0].name));
    const stem = nameStem(b.name);
    const aliases = generic ? [`${stem}${lower(pkCols[0].name)}`, `${lower(pkCols[0].name)}${stem}`, `${stem}_${lower(pkCols[0].name)}`, `${lower(pkCols[0].name)}_${stem}`, `cod${stem}`] : null;
    for (const a of cat.tables) {
      if (a === b) continue;
      const pairs = []; let viaAlias = false; let ok = true;
      for (const k of pkCols) {
        let c = !generic ? a.colByLower.get(lower(k.name)) : null;
        if (generic) { for (const al of aliases) { c = a.colByLower.get(al) || [...a.colByLower.values()].find((x) => nameStem(x.name) === al.replace(/_/g, '')); if (c) break; } viaAlias = !!c; }
        if (!c || !typeCompatible(c.type, k.type)) { ok = false; break; }
        pairs.push([c.name, k.name]);
      }
      if (!ok) continue;
      const sig = `${a.key}>${b.key}>${pairs.map(([s]) => lower(s)).sort().join(',')}`;
      if (real.has(sig)) continue;
      const samePk = a.pk.length === pkCols.length && pairs.every(([s]) => a.pk.some((p) => lower(p) === lower(s)));
      // A tabela A "é" a mesma entidade (mesma chave) e é maior que B → B é que provavelmente aponta para A; evita o par duplicado.
      if (samePk && (a.rows > b.rows || (a.rows === b.rows && a.key > b.key))) continue;
      let score = 45; const reasons = [];
      if (viaAlias) { score += 10; reasons.push(`coluna ${pairs[0][0]} segue o padrão do nome da tabela ${b.name}`); } else reasons.push(pairs.length > 1 ? `mesmas ${pairs.length} colunas da chave primária de ${b.name}` : `mesmo nome da chave primária de ${b.name}`);
      reasons.push('tipos compatíveis'); score += 10;
      if (pairs.length > 1) { score += 10; reasons.push('chave composta inteira'); }
      if (pairs.every(([s]) => a.indexed.has(lower(s)))) { score += 10; reasons.push('colunas de origem indexadas'); }
      if (pairs.every(([s]) => !a.colByLower.get(lower(s)).nullable)) { score += 5; reasons.push('origem não aceita nulo'); }
      if (samePk) { score -= 15; reasons.push('origem tem a mesma chave primária (possível 1:1 / extensão)'); }
      if (pairs.length === 1 && !viaAlias && !generic && pkCols.length === 1 && !b.refCols.size && b.columns.length <= 3) { score -= 5; }
      if (b.refCols.size) { score += 5; reasons.push(`${b.name} já é referenciada por FKs reais`); }
      score = Math.max(1, Math.min(95, score));
      if (score < minScore) continue;
      out.push({ id: `inf:${a.key}>${b.key}:${pairs.map(([s]) => s).join('+')}`, kind: 'inferred', name: 'hipótese', from: a.key, to: b.key, pairs, score, reasons });
    }
  }
  out.sort((x, y) => y.score - x.score || x.from.localeCompare(y.from));
  const truncated = out.length > max;
  cat.inferred = out.slice(0, max);
  cat.inferredAt = new Date().toISOString();
  index(cat);
  return { count: cat.inferred.length, truncated, total: out.length };
}
const confidence = (score) => (score >= 80 ? 'alta' : score >= 55 ? 'média' : 'baixa');

// ---------- Visão geral ----------
const BRIDGE_NAME = /(matric|vinc|item|mov|hist|contrato|turma|pessoa|aluno|assoc|relac|ligacao|map|x$)/i;
const RELEVANT_COL = /(cpf|cnpj|matric|codigo|cod|pessoa|aluno|cliente|contrato|curso|turma|serie|status|situacao|chapa)/i;
function bridgeScore(cat, t) {
  const deg = degreeOf(cat, t.key);
  const outs = new Set((cat.adj.fk.get(t.key) || []).filter((e) => e.dir === 'out').map((e) => e.other)).size;
  const keyCols = new Set([...t.pk.map(lower), ...t.fkCols]).size;
  const descriptive = Math.max(t.columns.length - keyCols, 0);
  let s = Math.min(outs, 6) * 14;
  if (outs >= 2) s += 15;
  if (BRIDGE_NAME.test(t.name)) s += 10;
  if (descriptive <= Math.max(keyCols, 3)) s += 10;
  return outs >= 2 ? Math.min(100, s + Math.min(deg, 5)) : 0;
}
function relevance(cat, t) {
  const deg = degreeOf(cat, t.key, true);
  const relCols = t.columns.filter((c) => RELEVANT_COL.test(c.name)).length;
  let s = (t.pk.length ? 12 : 0) + (t.fkCols.size ? 14 : 0) + Math.min(relCols * 5, 25) + Math.min(deg * 5, 25) + Math.min(Math.floor(Math.log10(t.rows + 1) * 4), 20);
  if (bridgeScore(cat, t) >= 40) s += 12;
  return Math.min(100, s);
}

function tableSummary(cat, t) {
  const fkAdj = cat.adj.fk.get(t.key) || []; const allAdj = cat.adj.all.get(t.key) || [];
  return {
    key: t.key, schema: t.schema, name: t.name, rows: t.rows, columns: t.columns.length, pk: t.pk,
    fkOut: fkAdj.filter((e) => e.dir === 'out').length, fkIn: fkAdj.filter((e) => e.dir === 'in').length,
    inferred: allAdj.filter((e) => e.rel.kind === 'inferred').length, degree: degreeOf(cat, t.key), degreeAll: degreeOf(cat, t.key, true),
    description: t.description || '', sensitive: t.columns.filter((c) => isSensitive(c.name)).length,
  };
}

function hubThreshold(cat, configured) {
  if (configured > 0) return configured;
  return Math.max(25, Math.ceil(Math.sqrt(cat.tables.length) * 2));
}
function hubs(cat, { includeInferred = false, threshold = 0 } = {}) {
  const th = hubThreshold(cat, threshold);
  return cat.tables.filter((t) => degreeOf(cat, t.key, includeInferred) >= th).map((t) => t.key);
}

function overview(cat, { hubThreshold: th = 0 } = {}) {
  const T = cat.tables;
  const sum = (f) => T.reduce((n, t) => n + f(t), 0);
  const isolated = T.filter((t) => degreeOf(cat, t.key) === 0);
  const noPk = T.filter((t) => !t.pk.length);
  const empty = T.filter((t) => !t.rows);
  const schemas = {}; for (const t of T) schemas[t.schema] = (schemas[t.schema] || 0) + 1;
  const types = {}; for (const t of T) for (const c of t.columns) types[c.type] = (types[c.type] || 0) + 1;
  const colTables = new Map(); for (const t of T) for (const c of t.columns) { const k = c.name.toUpperCase(); colTables.set(k, (colTables.get(k) || 0) + 1); }
  const top = (list, f, n = 12) => [...list].sort((a, b) => f(b) - f(a) || a.key.localeCompare(b.key)).slice(0, n);
  const threshold = hubThreshold(cat, th);
  return {
    database: cat.database, identity: cat.identity,
    counts: {
      tables: T.length, columns: sum((t) => t.columns.length), rows: sum((t) => t.rows), fks: cat.rels.length, inferred: cat.inferred.length,
      noPk: noPk.length, isolated: isolated.length, empty: empty.length, schemas: Object.keys(schemas).length,
      views: cat.counts.views || 0, procedures: cat.counts.procedures || 0, sensitiveColumns: sum((t) => t.columns.filter((c) => isSensitive(c.name)).length),
    },
    inferredAt: cat.inferredAt,
    largest: top(T, (t) => t.rows).filter((t) => t.rows > 0).map((t) => ({ key: t.key, rows: t.rows, columns: t.columns.length })),
    connected: top(T, (t) => degreeOf(cat, t.key)).filter((t) => degreeOf(cat, t.key) > 0).map((t) => ({ key: t.key, degree: degreeOf(cat, t.key), rows: t.rows, hub: degreeOf(cat, t.key) >= threshold })),
    bridges: top(T.filter((t) => bridgeScore(cat, t) >= 40), (t) => bridgeScore(cat, t), 10).map((t) => ({ key: t.key, score: bridgeScore(cat, t), fkOut: (cat.adj.fk.get(t.key) || []).filter((e) => e.dir === 'out').length })),
    relevant: top(T, (t) => relevance(cat, t), 10).map((t) => ({ key: t.key, score: relevance(cat, t) })),
    recurring: [...colTables.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 20).map(([column, tables]) => ({ column, tables })),
    schemas: Object.entries(schemas).sort((a, b) => b[1] - a[1]).map(([schema, tables]) => ({ schema, tables })),
    types: Object.entries(types).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([type, columns]) => ({ type, columns })),
    noPkSample: noPk.slice(0, 30).map((t) => t.key), isolatedSample: isolated.slice(0, 30).map((t) => t.key),
    hubThreshold: threshold, hubs: hubs(cat, { threshold: th }).length,
  };
}

// ---------- Lista de tabelas ----------
const FILTERS = {
  all: () => true,
  noPk: (cat, t) => !t.pk.length,
  isolated: (cat, t) => degreeOf(cat, t.key) === 0,
  empty: (cat, t) => !t.rows,
  inferred: (cat, t) => (cat.adj.all.get(t.key) || []).some((e) => e.rel.kind === 'inferred'),
  sensitive: (cat, t) => t.columns.some((c) => isSensitive(c.name)),
  noted: (cat, t, ctx) => !!ctx.noted?.has(t.key),
};
function tableList(cat, { q = '', schema = '', filter = 'all', sort = 'name', limit = 200, offset = 0, noted = null } = {}) {
  const term = lower(q).trim();
  const f = FILTERS[filter] || FILTERS.all;
  let list = cat.tables.filter((t) => (!schema || t.schema === schema) && f(cat, t, { noted }) &&
    (!term || lower(t.key).includes(term) || lower(t.description).includes(term) || (term.length >= 3 && t.columns.some((c) => lower(c.name) === term))));
  const sorters = {
    name: (a, b) => a.key.localeCompare(b.key),
    rows: (a, b) => b.rows - a.rows || a.key.localeCompare(b.key),
    degree: (a, b) => degreeOf(cat, b.key, true) - degreeOf(cat, a.key, true) || a.key.localeCompare(b.key),
    columns: (a, b) => b.columns.length - a.columns.length || a.key.localeCompare(b.key),
    relevance: (a, b) => relevance(cat, b) - relevance(cat, a) || a.key.localeCompare(b.key),
  };
  list = list.sort(sorters[sort] || sorters.name);
  const lim = Math.max(1, Math.min(1000, Number(limit) || 200)); const off = Math.max(0, Number(offset) || 0);
  return { total: list.length, offset: off, items: list.slice(off, off + lim).map((t) => ({ ...tableSummary(cat, t), relevance: relevance(cat, t) })) };
}

// ---------- Detalhe de uma tabela ----------
const relView = (cat, r, perspective) => ({
  id: r.id, kind: r.kind, name: r.name, from: r.from, to: r.to, pairs: r.pairs, score: r.score, confidence: confidence(r.score),
  reasons: r.reasons || null, disabled: r.disabled || false, untrusted: r.untrusted || false,
  direction: perspective === r.from && perspective === r.to ? 'self' : perspective === r.from ? 'out' : 'in',
});
function tableDetail(cat, key) {
  const t = findTable(cat, key);
  if (!t) return null;
  const adj = cat.adj.all.get(t.key) || [];
  const seen = new Set(); const rels = [];
  for (const e of adj) if (!seen.has(e.rel.id)) { seen.add(e.rel.id); rels.push(relView(cat, e.rel, t.key)); }
  rels.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'fk' ? -1 : 1) || a.direction.localeCompare(b.direction) || b.score - a.score);
  return {
    ...tableSummary(cat, t), relevance: relevance(cat, t), bridge: bridgeScore(cat, t),
    columns: t.columns.map((c) => ({
      name: c.name, type: typeLabel(c), family: familyOf(c.type), nullable: c.nullable, identity: c.identity, computed: c.computed, hasDefault: c.hasDefault,
      pk: t.pk.some((p) => lower(p) === lower(c.name)), fk: t.fkCols.has(lower(c.name)), referenced: t.refCols.has(lower(c.name)), indexed: t.indexed.has(lower(c.name)),
      sensitive: isSensitive(c.name), classification: classifyColumn(c.name), description: c.description || '',
    })),
    indexes: t.indexes, uniques: t.uniques, relationships: rels,
    selectSql: `SELECT TOP (100)\n    ${t.columns.slice(0, 60).map((c) => quoteIdent(c.name)).join(',\n    ')}${t.columns.length > 60 ? ',\n    *' : ''}\nFROM ${tableRef(t)};`,
  };
}

// ---------- Mapa relacional (recortes) ----------
function edgesAmong(cat, keys, includeInferred) {
  const set = new Set(keys); const out = []; const seen = new Set();
  for (const k of keys) for (const e of adjOf(cat, includeInferred).get(k) || []) {
    if (!set.has(e.other) || seen.has(e.rel.id)) continue;
    seen.add(e.rel.id);
    out.push({ id: e.rel.id, kind: e.rel.kind, name: e.rel.name, from: e.rel.from, to: e.rel.to, pairs: e.rel.pairs, score: e.rel.score, confidence: confidence(e.rel.score), reasons: e.rel.reasons || null });
  }
  return out;
}
function graphPayload(cat, keys, { includeInferred, center = null, highlighted = [], depth = null, truncated = false, hidden = [] }) {
  const hl = new Set(highlighted);
  const nodes = keys.map((k) => {
    const t = cat.byKey.get(k);
    return { key: t.key, schema: t.schema, name: t.name, rows: t.rows, columns: t.columns.length, pk: t.pk, degree: degreeOf(cat, t.key, includeInferred),
      center: t.key === center, highlighted: hl.has(t.key), depth: depth ? depth.get(t.key) ?? null : null };
  });
  return { nodes, edges: edgesAmong(cat, keys, includeInferred), truncated, hidden };
}

// Vizinhança de uma tabela central: camadas por profundidade e direção (saída = tabelas que ela referencia; entrada = que a referenciam).
function neighborhood(cat, centerKey, { depth = 1, direction = 'both', maxNodes = 80, includeInferred = false, avoidHubs = true, hubThreshold: th = 0 } = {}) {
  const c = findTable(cat, centerKey);
  if (!c) return null;
  const hubSet = avoidHubs ? new Set(hubs(cat, { includeInferred, threshold: th })) : new Set();
  hubSet.delete(c.key);
  const dist = new Map([[c.key, 0]]); const order = [c.key]; const hidden = new Set();
  let frontier = [c.key]; let truncated = false;
  for (let d = 1; d <= Math.max(1, Math.min(4, depth)) && frontier.length && !truncated; d++) {
    const next = [];
    for (const k of frontier) {
      if (k !== c.key && hubSet.has(k)) continue; // hub entra no mapa, mas não é expandido
      const cand = (adjOf(cat, includeInferred).get(k) || []).filter((e) => direction === 'both' || e.dir === direction || e.dir === 'self')
        .map((e) => e.other).filter((o) => !dist.has(o));
      const uniq = [...new Set(cand)].sort((a, b) => degreeOf(cat, b, includeInferred) - degreeOf(cat, a, includeInferred) || a.localeCompare(b));
      for (const o of uniq) {
        if (dist.has(o)) continue;
        if (order.length >= maxNodes) { truncated = true; break; }
        if (hubSet.has(o) && d > 1) { hidden.add(o); continue; }
        dist.set(o, d); order.push(o); next.push(o);
      }
      if (truncated) break;
    }
    frontier = next;
  }
  return graphPayload(cat, order, { includeInferred, center: c.key, depth: dist, truncated, hidden: [...hidden].slice(0, 30) });
}

// Tabelas escolhidas (com opção de incluir as intermediárias dos caminhos mais curtos entre elas).
function selection(cat, keys, { intermediates = true, maxDepth = 4, maxNodes = 80, includeInferred = false, avoidHubs = true, hubThreshold: th = 0 } = {}) {
  const chosen = [...new Set(keys.map((k) => findTable(cat, k)).filter(Boolean).map((t) => t.key))];
  const set = new Set(chosen);
  if (intermediates && chosen.length > 1) {
    const avoid = avoidHubs ? new Set(hubs(cat, { includeInferred, threshold: th })) : new Set();
    for (let i = 1; i < chosen.length; i++) {
      // Liga a i-ésima escolhida ao que já está no recorte (as anteriores e as intermediárias já incluídas).
      const sources = [...set].filter((k) => k !== chosen[i] && (chosen.indexOf(k) < i || !chosen.includes(k)));
      const p = shortestPath(cat, sources, chosen[i], { includeInferred, avoid, maxDepth });
      if (p) for (const k of p.nodes) set.add(k);
      if (set.size >= maxNodes) break;
    }
  }
  const all = [...set].slice(0, maxNodes);
  return graphPayload(cat, all, { includeInferred, highlighted: chosen, truncated: set.size > maxNodes });
}

// Panorama: as tabelas mais conectadas (opcionalmente de um schema), limitado a maxNodes.
function panorama(cat, { maxNodes = 80, includeInferred = false, schema = '' } = {}) {
  const list = cat.tables.filter((t) => (!schema || t.schema === schema) && degreeOf(cat, t.key, includeInferred) > 0)
    .sort((a, b) => degreeOf(cat, b.key, includeInferred) - degreeOf(cat, a.key, includeInferred) || a.key.localeCompare(b.key));
  return graphPayload(cat, list.slice(0, maxNodes).map((t) => t.key), { includeInferred, truncated: list.length > maxNodes });
}

// ---------- Caminhos entre tabelas ----------
// BFS a partir do destino (distâncias) + DFS podada: só segue para um vizinho se ainda dá para chegar ao destino no limite.
function bfsDist(cat, target, { includeInferred, avoid, maxDepth }) {
  const dist = new Map([[target, 0]]); let frontier = [target];
  for (let d = 1; d <= maxDepth && frontier.length; d++) {
    const next = [];
    for (const k of frontier) {
      if (d > 1 && avoid.has(k)) continue;
      for (const e of adjOf(cat, includeInferred).get(k) || []) if (!dist.has(e.other)) { dist.set(e.other, d); next.push(e.other); }
    }
    frontier = next;
  }
  return dist;
}
// Entre duas tabelas vizinhas: FK declarada sempre antes de hipótese; depois a maior pontuação.
const relRank = (r) => (r.kind === 'fk' ? 1000 : 0) + r.score;
function bestRel(cat, a, b, includeInferred) {
  let best = null;
  for (const e of adjOf(cat, includeInferred).get(a) || []) if (e.other === b && (!best || relRank(e.rel) > relRank(best))) best = e.rel;
  return best;
}
// Caminho "convergente" (A → X ← B): A e B só apontam para a mesma tabela X (empresa, filial, tipo…). Liga, mas não relaciona
// A com B de verdade (o JOIN multiplica linhas). Fica no fim da lista e com aviso; o montador evita quando há alternativa.
// "Dono" da linha: as colunas da ligação fazem parte da chave primária da origem (ex.: CODCOLIGADA em PFUNC e em SNOTAS). Duas tabelas
// que só se encontram no dono são irmãs, não relacionadas; já CODPESSOA (fora da PK) em SALUNO e PFUNC = mesma pessoa, ligação real.
const ownerKey = (cat, r) => { const t = cat.byKey.get(r.from); return r.pairs.every(([s]) => t.pk.some((p) => lower(p) === lower(s))); };
const comparePaths = (x, y) => x.weakVia.length - y.weakVia.length || x.length - y.length || y.minScore - x.minScore || x.inferredSteps - y.inferredSteps;
function rankedPaths(cat, a, b, { depthMax, includeInferred, limit, avoid }) {
  const dist = bfsDist(cat, b, { includeInferred, avoid, maxDepth: depthMax });
  const found = []; let budget = 200000;
  const walk = (node, path, seen) => {
    if (found.length >= limit * 8 || --budget <= 0) return;
    if (node === b) { found.push([...path]); return; }
    const left = depthMax - (path.length - 1);
    const next = [...neighborsOf(cat, node, includeInferred)].filter((o) => !seen.has(o) && (dist.get(o) ?? Infinity) <= left - 1 && (o === b || !avoid.has(o)))
      .sort((x, y) => dist.get(x) - dist.get(y) || x.localeCompare(y));
    for (const o of next) { seen.add(o); path.push(o); walk(o, path, seen); path.pop(); seen.delete(o); }
  };
  walk(a, [a], new Set([a]));
  const paths = found.map((nodes) => {
    const steps = nodes.slice(1).map((k, i) => { const r = bestRel(cat, nodes[i], k, includeInferred); return { from: nodes[i], to: k, rel: relView(cat, r, nodes[i]) }; });
    const minScore = Math.min(...steps.map((s) => s.rel.score));
    const weakVia = nodes.slice(1, -1).filter((x, i) => [steps[i].rel, steps[i + 1].rel].every((r) => r.to === x && r.from !== x && ownerKey(cat, r)));
    return { nodes, steps, length: steps.length, minScore, confidence: confidence(minScore), inferredSteps: steps.filter((s) => s.rel.kind === 'inferred').length, weakVia };
  }).sort(comparePaths).slice(0, limit);
  return { paths, dist, partial: budget <= 0 };
}
function findPaths(cat, fromKey, toKey, { maxDepth = 4, includeInferred = false, limit = 15, avoidHubs = true, hubThreshold: th = 0 } = {}) {
  const a = findTable(cat, fromKey); const b = findTable(cat, toKey);
  if (!a || !b) return null;
  if (a.key === b.key) return { paths: [], avoided: [] };
  const avoid = avoidHubs ? new Set(hubs(cat, { includeInferred, threshold: th })) : new Set();
  avoid.delete(a.key); avoid.delete(b.key);
  const r = rankedPaths(cat, a.key, b.key, { depthMax: Math.max(1, Math.min(6, maxDepth)), includeInferred, limit, avoid });
  for (const p of r.paths) p.sql = joinSql(cat, planFromNodes(cat, p.nodes, includeInferred), { top: 100 });
  return { paths: r.paths, avoided: [...avoid].filter((k) => r.dist.has(k)).slice(0, 20), searched: r.partial ? 'parcial' : 'completo' };
}

// Caminho mais curto de qualquer tabela do conjunto `sources` até `target` (BFS multi-origem).
function shortestPath(cat, sources, target, { includeInferred = false, avoid = new Set(), maxDepth = 6 } = {}) {
  const prev = new Map(); let frontier = [];
  for (const s of sources) { prev.set(s, null); frontier.push(s); }
  if (prev.has(target)) return { nodes: [target] };
  for (let d = 1; d <= maxDepth && frontier.length; d++) {
    const next = [];
    for (const k of frontier) {
      if (d > 1 && avoid.has(k) && !sources.includes(k)) continue;
      for (const o of [...neighborsOf(cat, k, includeInferred)].sort()) {
        if (prev.has(o)) continue;
        prev.set(o, k);
        if (o === target) { const nodes = [o]; let c = k; while (c !== null) { nodes.unshift(c); c = prev.get(c); } return { nodes }; }
        next.push(o);
      }
    }
    frontier = next;
  }
  return null;
}

// ---------- Montador de consulta (JOIN) ----------
// Liga as tabelas na ordem escolhida: a 1ª é a base; cada próxima é ligada pela rota mais curta até qualquer tabela já no
// plano (as intermediárias entram sozinhas). Tabela sem ligação no limite → fica em `missing` (a tela avisa).
function planFromNodes(cat, nodes, includeInferred) {
  const joins = []; const alias = new Map([[nodes[0], 't0']]);
  for (let i = 1; i < nodes.length; i++) {
    const r = bestRel(cat, nodes[i - 1], nodes[i], includeInferred);
    alias.set(nodes[i], `t${i}`);
    joins.push(orientJoin(r, nodes[i - 1], nodes[i], alias));
  }
  return { base: nodes[0], joins, alias: Object.fromEntries(alias), missing: [] };
}
function orientJoin(r, known, added, alias) {
  // Condição escrita como <tabela nova>.<col> = <tabela já no plano>.<col>
  const on = r.from === added ? r.pairs.map(([s, d]) => [s, d]) : r.pairs.map(([s, d]) => [d, s]);
  return { table: added, alias: alias.get(added), with: known, withAlias: alias.get(known), on, rel: { id: r.id, kind: r.kind, name: r.name, score: r.score, confidence: confidence(r.score), from: r.from, to: r.to } };
}
function buildJoinPlan(cat, keys, { includeInferred = false, avoidHubs = false, hubThreshold: th = 0, maxDepth = 5 } = {}) {
  const chosen = [...new Set(keys.map((k) => findTable(cat, k)).filter(Boolean).map((t) => t.key))];
  if (!chosen.length) return null;
  const avoid = avoidHubs ? new Set(hubs(cat, { includeInferred, threshold: th })) : new Set();
  for (const k of chosen) avoid.delete(k);
  const inPlan = [chosen[0]]; const alias = new Map([[chosen[0], 't0']]); const joins = []; const missing = [];
  const weak = [];
  for (const k of chosen.slice(1)) {
    if (alias.has(k)) continue;
    // Melhor rota a partir de qualquer tabela já no plano (mesmo ranking dos Caminhos: evita A → X ← B quando há outra).
    const cands = inPlan.flatMap((s) => rankedPaths(cat, s, k, { depthMax: Math.max(1, Math.min(6, maxDepth)), includeInferred, limit: 3, avoid }).paths);
    const p = cands.sort(comparePaths)[0];
    if (!p) { missing.push(k); continue; }
    for (const x of p.weakVia) weak.push({ table: k, via: x });
    for (let i = 1; i < p.nodes.length; i++) {
      const n = p.nodes[i];
      if (alias.has(n)) continue;
      alias.set(n, `t${alias.size}`);
      joins.push({ ...orientJoin(bestRel(cat, p.nodes[i - 1], n, includeInferred), p.nodes[i - 1], n, alias), intermediate: !chosen.includes(n) });
      inPlan.push(n);
    }
  }
  return { base: chosen[0], joins, alias: Object.fromEntries(alias), missing, chosen, weak };
}
// columns: { '<schema.tabela>': ['COL', ...] } (vazio = todas da tabela base, chaves das demais)
function joinSql(cat, plan, { top = 100, joinType = 'INNER', columns = {}, star = false } = {}) {
  if (!plan) return '';
  const jt = joinType === 'LEFT' ? 'LEFT JOIN' : 'INNER JOIN';
  const keys = [plan.base, ...plan.joins.map((j) => j.table)];
  const sel = [];
  for (const k of keys) {
    const t = cat.byKey.get(k); const a = plan.alias[k];
    const pick = (columns[k] || []).map((n) => t.colByLower.get(lower(n))).filter(Boolean);
    if (star) { sel.push(`${a}.*`); continue; }
    if (pick.length) { for (const c of pick) sel.push(`${a}.${quoteIdent(c.name)}`); continue; }
    if (k === plan.base && !Object.keys(columns).length) { sel.push(`${a}.*`); continue; }
    for (const c of (t.pk.length ? t.pk : t.columns.slice(0, 1).map((c) => c.name))) sel.push(`${a}.${quoteIdent(c)}${k !== plan.base ? ` AS ${quoteIdent(`${t.name}_${c}`)}` : ''}`);
  }
  const lines = [`SELECT${top ? ` TOP (${Math.max(1, Math.min(100000, Number(top) || 100))})` : ''}`, `    ${[...new Set(sel)].join(',\n    ')}`, `FROM ${tableRef(cat.byKey.get(plan.base))} AS ${plan.alias[plan.base]}`];
  for (const j of plan.joins) {
    const note = j.rel.kind === 'inferred' ? `  -- HIPÓTESE (${j.rel.confidence}): conferir antes de usar` : `  -- FK ${j.rel.name}`;
    lines.push(`${jt} ${tableRef(cat.byKey.get(j.table))} AS ${j.alias}${note}`);
    lines.push(`    ON ${j.on.map(([mine, theirs]) => `${j.alias}.${quoteIdent(mine)} = ${j.withAlias}.${quoteIdent(theirs)}`).join('\n   AND ')}`);
  }
  return `${lines.join('\n')};`;
}

// ---------- Busca global ----------
function search(cat, q, { limit = 60 } = {}) {
  const term = lower(q).trim();
  if (term.length < 2) return { tables: [], columns: [], relationships: [] };
  const tables = []; const columns = []; const relationships = [];
  for (const t of cat.tables) {
    if (lower(t.key).includes(term) || lower(t.description).includes(term)) tables.push({ key: t.key, rows: t.rows, columns: t.columns.length, description: t.description, exact: lower(t.name) === term });
    for (const c of t.columns) if (lower(c.name).includes(term) || lower(c.description).includes(term)) columns.push({ table: t.key, column: c.name, type: typeLabel(c), pk: t.pk.some((p) => lower(p) === lower(c.name)), fk: t.fkCols.has(lower(c.name)), sensitive: isSensitive(c.name), classification: classifyColumn(c.name), exact: lower(c.name) === term });
  }
  for (const r of [...cat.rels, ...cat.inferred]) if (lower(r.name).includes(term) || r.pairs.some(([s, d]) => lower(s).includes(term) || lower(d).includes(term))) relationships.push(relView(cat, r, r.from));
  const ex = (a, b) => (b.exact ? 1 : 0) - (a.exact ? 1 : 0);
  return { tables: tables.sort(ex).slice(0, limit), columns: columns.sort(ex).slice(0, limit * 2), relationships: relationships.slice(0, limit), totals: { tables: tables.length, columns: columns.length, relationships: relationships.length } };
}

// ---------- Dicionário de dados (exportação) ----------
function exportKeys(cat, keys) {
  const list = keys && keys.length ? keys.map((k) => findTable(cat, k)).filter(Boolean) : cat.tables;
  return [...new Set(list)];
}
function dictionaryJson(cat, keys, { notes = {} } = {}) {
  const list = exportKeys(cat, keys); const set = new Set(list.map((t) => t.key));
  return {
    database: cat.database, server: cat.identity?.server || null, generatedAt: new Date().toISOString(),
    tables: list.map((t) => { const d = tableDetail(cat, t.key); return { key: t.key, schema: t.schema, name: t.name, rows: t.rows, description: t.description || undefined, note: notes[t.key] || undefined, primaryKey: t.pk, columns: d.columns.map(({ family, ...c }) => c), indexes: t.indexes }; }),
    relationships: [...cat.rels, ...cat.inferred].filter((r) => set.has(r.from) || set.has(r.to)).map((r) => ({ kind: r.kind === 'fk' ? 'FK real' : 'hipótese', name: r.name, from: r.from, to: r.to, columns: r.pairs.map(([s, d]) => `${s} = ${d}`), confidence: confidence(r.score), reasons: r.reasons || undefined })),
  };
}
const mdCell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
function dictionaryMarkdown(cat, keys, opts = {}) {
  const j = dictionaryJson(cat, keys, opts);
  const out = [`# Dicionário de dados — ${j.database}`, '', `Servidor: ${j.server || '—'} · Gerado em ${new Date(j.generatedAt).toLocaleString('pt-BR')} · ${j.tables.length} tabela(s) · ${j.relationships.length} relacionamento(s)`, ''];
  for (const t of j.tables) {
    out.push(`## ${t.key}`, '', `Linhas (aprox.): ${t.rows.toLocaleString('pt-BR')} · Chave primária: ${t.primaryKey.length ? t.primaryKey.join(', ') : '— (sem PK)'}`);
    if (t.description) out.push('', `> ${mdCell(t.description)}`);
    if (t.note) out.push('', `Anotação: ${mdCell(t.note.text || t.note)}`);
    out.push('', '| Coluna | Tipo | Nulo | Chave | Descrição |', '|---|---|---|---|---|');
    for (const c of t.columns) out.push(`| ${mdCell(c.name)} | ${c.type} | ${c.nullable ? 'sim' : 'não'} | ${[c.pk && 'PK', c.fk && 'FK', c.identity && 'identity', c.sensitive && 'sensível'].filter(Boolean).join(', ')} | ${mdCell(c.description)} |`);
    const rels = j.relationships.filter((r) => r.from === t.key || r.to === t.key);
    if (rels.length) { out.push('', 'Relacionamentos:'); for (const r of rels) out.push(`- ${r.kind}${r.kind === 'hipótese' ? ` (${r.confidence})` : ` ${r.name}`}: ${r.from} → ${r.to} (${r.columns.join(' AND ')})`); }
    out.push('');
  }
  return out.join('\n');
}

module.exports = {
  buildCatalog, inferRelationships, overview, tableList, tableDetail, neighborhood, selection, panorama, findPaths, buildJoinPlan, joinSql,
  search, dictionaryJson, dictionaryMarkdown, findTable, hubs, hubThreshold, degreeOf, isSensitive, classifyColumn, maskValue, maskResult,
  typeCompatible, familyOf, quoteIdent, tableRef, confidence, MAX_INFERRED,
};
