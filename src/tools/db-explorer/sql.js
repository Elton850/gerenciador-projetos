// Explorador de Banco — a parte que fala com o SQL Server. Roda DENTRO do processo-filho (src/dbworker.js → op "tool:dbx-*"),
// como todo acesso ao banco do app (ADR-004): consulta pendurada (VPN, servidor lento) é encerrada pelo pai sem travar o app.
//
// SOMENTE LEITURA: catálogo (sys.*), amostras TOP (N), perfil limitado a uma amostra e o Console SQL (trava readonly.js revalidada
// aqui). Tudo roda numa transação que é SEMPRE desfeita no final (nada é confirmado) e com LOCK_TIMEOUT, para não esperar bloqueios.
// Nomes de tabela/coluna chegam já conferidos contra o catálogo (api.js) e vão entre colchetes ([..]] escapado).
const { checkReadOnly } = require('./readonly');

const q = (s) => `[${String(s).replace(/\]/g, ']]')}]`;
const ref = (t) => `${q(t.schema)}.${q(t.name)}`;
const LOCK_TIMEOUT_MS = 15000;
const CELL_MAX = 2000;
const NO_DISTINCT = new Set(['text', 'ntext', 'image', 'xml', 'geography', 'geometry', 'hierarchyid', 'sql_variant', 'timestamp', 'rowversion', 'varbinary', 'binary']);

const cell = (v) => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().replace('T', ' ').replace(/\.000Z$|Z$/, '');
  if (Buffer.isBuffer(v)) return `0x${v.toString('hex').slice(0, 64)}${v.length > 32 ? '…' : ''}`;
  if (typeof v === 'object') return JSON.stringify(v).slice(0, CELL_MAX);
  if (typeof v === 'string') return v.length > CELL_MAX ? `${v.slice(0, CELL_MAX)}…` : v;
  return v;
};

// Transação só de leitura: confere o banco aberto, aplica LOCK_TIMEOUT e desfaz no final (mesmo sem erro).
async function readTx(core, conn, password, fn) {
  return core.withPool(conn, password, async (h) => {
    const who = await core.identity(h);
    if (conn.database && who.database.toLowerCase() !== conn.database.toLowerCase()) throw new Error(`A conexão abriu o banco "${who.database}", diferente do escolhido ("${conn.database}"). Nada foi lido.`);
    const tx = new h.sql.Transaction(h.pool);
    await tx.begin();
    try {
      await new h.sql.Request(tx).batch(`SET LOCK_TIMEOUT ${LOCK_TIMEOUT_MS}`);
      const out = await fn(() => new h.sql.Request(tx), h, who);
      return out;
    } finally {
      try { await tx.rollback(); } catch { /* já encerrada */ }
    }
  });
}

// Lê no máximo `limit` linhas (streaming: para de receber e cancela o resto). Devolve { columns, rows (arrays), truncated }.
function readLimited(req, sql, limit) {
  return new Promise((resolve, reject) => {
    req.stream = true;
    req.arrayRowMode = true; // colunas com o mesmo nome (ex.: a.*, b.*) não se misturam
    let columns = null; const rows = []; let truncated = false; let done = false;
    const finish = (e) => { if (done) return; done = true; if (e) reject(e); else resolve({ columns: columns || [], rows, truncated }); };
    req.on('recordset', (cols) => { if (!columns) columns = (Array.isArray(cols) ? cols : Object.values(cols).sort((a, b) => a.index - b.index)).map((c) => c.name); });
    req.on('row', (r) => {
      if (done) return;
      if (rows.length >= limit) { truncated = true; try { req.cancel(); } catch { /* ignora */ } finish(); return; }
      rows.push(columns.map((c, i) => cell(Array.isArray(r) ? r[i] : r[c])));
    });
    req.on('error', (e) => { if (truncated || done) return finish(); finish(e); });
    req.on('done', () => finish());
    req.query(sql);
  });
}

// ---------- Bancos do servidor ----------
async function databases(core, conn, password) {
  return core.withPool({ ...conn, database: 'master' }, password, async (h) => {
    const who = await core.identity(h);
    const r = await h.pool.request().query(`SELECT name, state_desc AS state, CAST(HAS_DBACCESS(name) AS int) AS access, database_id AS id
      FROM sys.databases ORDER BY CASE WHEN database_id <= 4 THEN 1 ELSE 0 END, name`);
    return { identity: who, databases: r.recordset.map((d) => ({ name: d.name, state: d.state, access: d.access === 1, system: d.id <= 4 })) };
  });
}

// ---------- Catálogo (metadados) ----------
async function catalog(core, conn, password) {
  return readTx(core, conn, password, async (req, h, who) => {
    const rs = async (sql) => (await req().query(sql)).recordset;
    const tables = await rs(`SELECT t.object_id AS objectId, s.name AS [schema], t.name AS name,
        (SELECT SUM(p.rows) FROM sys.partitions p WHERE p.object_id = t.object_id AND p.index_id IN (0,1)) AS [rows]
      FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id WHERE t.is_ms_shipped = 0`);
    const columns = await rs(`SELECT c.object_id AS objectId, c.name, ty.name AS type, c.max_length AS maxLength, c.precision, c.scale,
        c.is_nullable AS nullable, c.is_identity AS [identity], c.is_computed AS computed, CASE WHEN c.default_object_id <> 0 THEN 1 ELSE 0 END AS hasDefault, c.column_id AS ord
      FROM sys.columns c JOIN sys.tables t ON t.object_id = c.object_id JOIN sys.types ty ON ty.user_type_id = c.user_type_id WHERE t.is_ms_shipped = 0`);
    const ixRows = await rs(`SELECT i.object_id AS objectId, i.index_id AS indexId, i.name, i.is_primary_key AS pk, i.is_unique AS [unique], c.name AS col, ic.key_ordinal AS ord
      FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
      JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id JOIN sys.tables t ON t.object_id = i.object_id
      WHERE t.is_ms_shipped = 0 AND i.is_hypothetical = 0 ORDER BY i.object_id, i.index_id, ic.key_ordinal`);
    const fkRows = await rs(`SELECT fk.object_id AS fkId, fk.name, fk.parent_object_id AS fromId, fk.referenced_object_id AS toId, fk.is_disabled AS disabled, fk.is_not_trusted AS untrusted,
        pc.name AS src, rc.name AS dst, fkc.constraint_column_id AS ord
      FROM sys.foreign_keys fk JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
      JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
      JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
      ORDER BY fk.object_id, fkc.constraint_column_id`);
    let descriptions = [];
    try {
      descriptions = await rs(`SELECT ep.major_id AS objectId, c.name AS [column], CAST(ep.value AS nvarchar(1000)) AS text
        FROM sys.extended_properties ep LEFT JOIN sys.columns c ON ep.minor_id <> 0 AND c.object_id = ep.major_id AND c.column_id = ep.minor_id
        WHERE ep.class = 1 AND ep.name = 'MS_Description'`);
    } catch { /* sem permissão para propriedades estendidas: segue sem descrições */ }
    const counts = (await rs(`SELECT (SELECT COUNT(*) FROM sys.views WHERE is_ms_shipped = 0) AS views,
        (SELECT COUNT(*) FROM sys.procedures WHERE is_ms_shipped = 0) AS procedures`))[0];
    const indexes = []; const ixMap = new Map();
    for (const r of ixRows) {
      const k = `${r.objectId}:${r.indexId}`;
      if (!ixMap.has(k)) { const ix = { objectId: r.objectId, name: r.name, pk: !!r.pk, unique: !!r.unique, cols: [] }; ixMap.set(k, ix); indexes.push(ix); }
      ixMap.get(k).cols.push(r.col);
    }
    const fks = []; const fkMap = new Map();
    for (const r of fkRows) {
      if (!fkMap.has(r.fkId)) { const f = { name: r.name, fromId: r.fromId, toId: r.toId, disabled: !!r.disabled, untrusted: !!r.untrusted, pairs: [] }; fkMap.set(r.fkId, f); fks.push(f); }
      fkMap.get(r.fkId).pairs.push([r.src, r.dst]);
    }
    return {
      identity: who, database: who.database, counts: { views: counts.views, procedures: counts.procedures },
      tables: tables.map((t) => ({ ...t, rows: Number(t.rows) || 0 })),
      columns: columns.map((c) => ({ ...c, nullable: !!c.nullable, identity: !!c.identity, computed: !!c.computed, hasDefault: !!c.hasDefault })),
      indexes, fks, descriptions: descriptions.filter((d) => d.text),
    };
  });
}

// ---------- Amostra de linhas ----------
async function sample(core, conn, password, { table, limit, columns }) {
  const n = Math.max(1, Math.min(1000, Number(limit) || 100));
  return readTx(core, conn, password, async (req) => {
    const t0 = Date.now();
    const cols = columns && columns.length ? columns.map(q).join(', ') : '*';
    const r = await readLimited(req(), `SELECT TOP (${n}) ${cols} FROM ${ref(table)}`, n);
    return { ...r, ms: Date.now() - t0 };
  });
}

// ---------- Perfil das colunas (sobre uma amostra de até N linhas) ----------
async function profile(core, conn, password, { table, columns, sampleRows }) {
  const n = Math.max(100, Math.min(1000000, Number(sampleRows) || 50000));
  return readTx(core, conn, password, async (req) => {
    const t0 = Date.now();
    const parts = ['COUNT_BIG(*) AS [__total]'];
    columns.forEach((c, i) => {
      const col = `s.${q(c.name)}`;
      parts.push(`SUM(CASE WHEN ${col} IS NULL THEN 1 ELSE 0 END) AS [n${i}]`);
      if (!NO_DISTINCT.has(c.type) && !(c.maxLength === -1 && ['varchar', 'nvarchar'].includes(c.type))) {
        parts.push(`COUNT(DISTINCT ${col}) AS [d${i}]`);
        if (['varchar', 'nvarchar', 'char', 'nchar'].includes(c.type)) parts.push(`MIN(LEN(${col})) AS [lmin${i}]`, `MAX(LEN(${col})) AS [lmax${i}]`);
        else if (!['bit', 'uniqueidentifier'].includes(c.type)) parts.push(`MIN(${col}) AS [min${i}]`, `MAX(${col}) AS [max${i}]`);
      }
    });
    const sql = `SELECT ${parts.join(', ')} FROM (SELECT TOP (${n}) ${columns.map((c) => q(c.name)).join(', ')} FROM ${ref(table)}) AS s`;
    const row = (await req().query(sql)).recordset[0] || {};
    const total = Number(row.__total) || 0;
    return {
      sampled: total, sampleLimit: n, ms: Date.now() - t0,
      columns: columns.map((c, i) => {
        const nulls = Number(row[`n${i}`]) || 0;
        return { name: c.name, nulls, filledPct: total ? Math.round(((total - nulls) / total) * 1000) / 10 : null,
          distinct: row[`d${i}`] === undefined ? null : Number(row[`d${i}`]),
          min: row[`min${i}`] === undefined ? null : cell(row[`min${i}`]), max: row[`max${i}`] === undefined ? null : cell(row[`max${i}`]),
          minLen: row[`lmin${i}`] ?? null, maxLen: row[`lmax${i}`] ?? null };
      }),
    };
  });
}

// ---------- Conferir um relacionamento (hipótese ou FK) numa amostra ----------
// Pega até N linhas da origem com as colunas preenchidas e conta quantas encontram par no destino; lista os valores sem par.
async function checkRelationship(core, conn, password, { from, to, pairs, sampleRows }) {
  const n = Math.max(100, Math.min(200000, Number(sampleRows) || 10000));
  return readTx(core, conn, password, async (req) => {
    const t0 = Date.now();
    const cols = pairs.map(([s]) => `a.${q(s)}`);
    const where = cols.map((c) => `${c} IS NOT NULL`).join(' AND ');
    const match = pairs.map(([s, d]) => `b.${q(d)} = s.${q(s)}`).join(' AND ');
    const base = `WITH s AS (SELECT TOP (${n}) ${pairs.map(([s]) => `a.${q(s)}`).join(', ')} FROM ${ref(from)} AS a WHERE ${where})`;
    const r = (await req().query(`${base}, m AS (SELECT CASE WHEN EXISTS (SELECT 1 FROM ${ref(to)} AS b WHERE ${match}) THEN 1 ELSE 0 END AS hit FROM s)
      SELECT COUNT_BIG(*) AS sampled, SUM(hit) AS matched FROM m`)).recordset[0];
    const orphans = await readLimited(req(), `${base} SELECT TOP (10) ${pairs.map(([s]) => `s.${q(s)}`).join(', ')}, COUNT_BIG(*) AS [ocorrencias] FROM s
      WHERE NOT EXISTS (SELECT 1 FROM ${ref(to)} AS b WHERE ${match}) GROUP BY ${pairs.map(([s]) => `s.${q(s)}`).join(', ')} ORDER BY COUNT_BIG(*) DESC`, 10);
    const sampled = Number(r.sampled) || 0; const matched = Number(r.matched) || 0;
    return { sampled, matched, orphans: sampled - matched, matchPct: sampled ? Math.round((matched / sampled) * 1000) / 10 : null, topOrphans: orphans, sampleLimit: n, ms: Date.now() - t0 };
  });
}

// ---------- Console SQL (somente leitura) ----------
async function query(core, conn, password, { sql, limit }) {
  const chk = checkReadOnly(sql); // revalida dentro do processo-filho
  if (!chk.ok) throw Object.assign(new Error(chk.errors.join(' ')), { status: 400 });
  const n = Math.max(1, Math.min(5000, Number(limit) || 500));
  return readTx(core, conn, password, async (req) => {
    const t0 = Date.now();
    const r = await readLimited(req(), chk.sql, n);
    return { ...r, ms: Date.now() - t0, limit: n };
  });
}

module.exports = { databases, catalog, sample, profile, checkRelationship, query, readLimited };
