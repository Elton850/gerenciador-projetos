// Validação de Carga — a parte que fala com o SQL Server (base de migração). Roda DENTRO do processo-filho (src/dbworker.js →
// op "tool:lv-*"), como todo acesso ao banco do app.
//
// LEITURA (transação sempre desfeita + LOCK_TIMEOUT): precheck (identidade, permissões, tabelas e contagens), dump (cópia da
// tabela atual em CSV antes de substituir), validate (consultas de validação embutidas, revalidadas pela trava de leitura) e
// keys (colunas de chave para o complemento).
// ESCRITA: replace — substitui UMA tabela da lista do modelo numa transação (DROP + CREATE + carga com XACT_ABORT): erro ou
// contagem diferente → ROLLBACK e a tabela anterior fica intacta. Todo SQL gerado passa por expressões regulares (assertGenerated).
// Carga: gravação em massa (bulk do driver, em blocos, na mesma transação) — muito mais rápida que INSERT em lotes. Se o bulk
// falhar (driver/servidor que não aceite), a transação é desfeita e a tabela é gravada de novo pelo INSERT em lotes (plano B).
'use strict';
const fs = require('fs');
const { checkReadOnly } = require('../db-explorer/readonly');

const q = (s) => `[${String(s).replace(/\]/g, ']]')}]`;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const LOCK_TIMEOUT_MS = 30000;
const BULK_ROWS = 20000; // linhas por bloco da gravação em massa
const SAFE = {
  drop: /^DROP TABLE IF EXISTS \[dbo\]\.\[[A-Z][A-Z0-9_]{0,63}\]$/,
  create: /^CREATE TABLE \[dbo\]\.\[[A-Z][A-Z0-9_]{0,63}\] \((?:\[[A-Za-z_][A-Za-z0-9_]{0,127}\] NVARCHAR\((?:MAX|\d{1,4})\) NULL(?:, )?)+\)$/,
  insert: /^INSERT INTO \[dbo\]\.\[[A-Z][A-Z0-9_]{0,63}\] \((?:\[[A-Za-z_][A-Za-z0-9_]{0,127}\](?:, )?)+\) VALUES (?:\((?:@lv\d+(?:, )?)+\)(?:, )?)+$/,
};
function assertGenerated(kind, sql) {
  if (!SAFE[kind] || !SAFE[kind].test(sql)) throw new Error(`Comando bloqueado pela trava de segurança da Validação de Carga (${kind}).`);
  return sql;
}
const checkName = (n, what) => { if (!NAME_RE.test(String(n))) throw new Error(`Nome de ${what} inválido: ${n}`); return String(n); };

async function readTx(core, conn, password, fn) {
  return core.withPool(conn, password, async (h) => {
    const who = await core.identity(h);
    if (conn.database && who.database.toLowerCase() !== conn.database.toLowerCase()) throw new Error(`A conexão abriu o banco "${who.database}", diferente do escolhido ("${conn.database}"). Nada foi feito.`);
    const tx = new h.sql.Transaction(h.pool);
    await tx.begin();
    try {
      await new h.sql.Request(tx).batch(`SET LOCK_TIMEOUT ${LOCK_TIMEOUT_MS}`);
      return await fn(() => new h.sql.Request(tx), h, who);
    } finally { try { await tx.rollback(); } catch { /* já encerrada */ } }
  });
}

async function countOf(req, table) {
  const r = await req().input('t', `[dbo].${q(table)}`).query("SELECT OBJECT_ID(@t, 'U') AS id");
  if (r.recordset[0].id === null) return null;
  return Number((await req().query(`SELECT COUNT_BIG(*) AS n FROM [dbo].${q(table)}`)).recordset[0].n);
}

// Pré-checagem SOMENTE LEITURA: identidade, permissões e contagens das tabelas do RM (destino) e da carga (origem das validações).
async function precheck(core, conn, password, { rmTables, sourceTables }) {
  return readTx(core, conn, password, async (req, h, who) => {
    const p = (await req().query("SELECT HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'CREATE TABLE') AS can_create, HAS_PERMS_BY_NAME('dbo', 'SCHEMA', 'ALTER') AS can_alter, HAS_PERMS_BY_NAME('dbo', 'SCHEMA', 'INSERT') AS can_insert, HAS_PERMS_BY_NAME('dbo', 'SCHEMA', 'SELECT') AS can_select")).recordset[0];
    const rm = {}; const src = {};
    for (const t of rmTables || []) rm[checkName(t, 'tabela')] = await countOf(req, t);
    for (const t of sourceTables || []) src[checkName(t, 'tabela')] = await countOf(req, t);
    return { identity: who, canCreate: p.can_create === 1, canAlter: p.can_alter === 1, canInsert: p.can_insert === 1, canSelect: p.can_select === 1, rm, src };
  });
}

const csvCell = (v) => { if (v === null || v === undefined) return ''; if (v instanceof Date) v = v.toISOString().replace('T', ' ').replace(/\.000Z$|Z$/, ''); const s = String(v); return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
// Lê uma consulta em streaming e grava em CSV (;, UTF-8 com BOM). Devolve { columns, rows }.
function streamToCsv(req, sql, file) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file, { encoding: 'utf8' });
    out.write('﻿');
    let columns = null; let rows = 0; let failed = null;
    req.stream = true; req.arrayRowMode = true;
    req.on('recordset', (cols) => { columns = (Array.isArray(cols) ? cols : Object.values(cols).sort((a, b) => a.index - b.index)).map((c) => c.name); out.write(`${columns.map(csvCell).join(';')}\r\n`); });
    req.on('row', (r) => { rows++; out.write(`${columns.map((c, i) => csvCell(Array.isArray(r) ? r[i] : r[c])).join(';')}\r\n`); });
    req.on('error', (e) => { failed = e; });
    req.on('done', () => out.end(() => (failed ? reject(failed) : resolve({ columns: columns || [], rows }))));
    req.query(sql);
  });
}

// Cópia da tabela atual (antes de substituir). Só leitura.
async function dump(core, conn, password, { table, file }) {
  return readTx(core, conn, password, async (req) => {
    if ((await countOf(req, checkName(table, 'tabela'))) === null) return { rows: 0, missing: true };
    return streamToCsv(req(), `SELECT * FROM [dbo].${q(table)}`, file);
  });
}

// Substitui UMA tabela numa transação. rowsFile: JSON { columns, rows: [[...]] } gravado pela api (dados do RM).
async function replace(core, conn, password, { table, rowsFile, allowed, forceInsert = false }, { progress, isCancelled }) {
  if (!Array.isArray(allowed) || !allowed.includes(table)) throw new Error(`Tabela fora da lista do modelo: ${table}`);
  const { columns, rows } = JSON.parse(fs.readFileSync(rowsFile, 'utf8'));
  if (!columns.length) throw new Error(`${table}: o RM não devolveu colunas.`);
  columns.forEach((c) => checkName(c, 'coluna'));
  checkName(table, 'tabela');
  const width = columns.map((_, i) => rows.reduce((m, r) => Math.max(m, r[i] === null ? 0 : String(r[i]).length), 1));
  const size = width.map((w) => (w > 4000 ? 'MAX' : Math.max(50, w)));
  const defs = columns.map((c, i) => `${q(c)} NVARCHAR(${size[i]}) NULL`).join(', ');
  const cancelled = () => Object.assign(new Error('Cancelado: nada desta tabela foi gravado (transação desfeita).'), { cancelled: true });

  // Gravação em massa: blocos de BULK_ROWS linhas (progresso e cancelamento entre blocos), colunas iguais às do CREATE.
  async function loadBulk(h, req) {
    for (let i = 0; i < rows.length || i === 0; i += BULK_ROWS) {
      if (isCancelled()) throw cancelled();
      const t = new h.sql.Table(`[dbo].${q(table)}`);
      t.create = false;
      columns.forEach((c, k) => t.columns.add(c, size[k] === 'MAX' ? h.sql.NVarChar(h.sql.MAX) : h.sql.NVarChar(size[k]), { nullable: true }));
      for (const row of rows.slice(i, i + BULK_ROWS)) t.rows.add(...row.map((v) => (v === null ? null : String(v))));
      if (!t.rows.length) break;
      await req().bulk(t);
      progress({ done: Math.min(rows.length, i + BULK_ROWS), total: rows.length, table });
    }
  }
  // Plano B (o método de antes): INSERT em lotes com parâmetros, cada comando conferido pela trava.
  async function loadInsert(h, req) {
    const per = Math.max(1, Math.min(1000, Math.floor(2000 / columns.length)));
    const head = `INSERT INTO [dbo].${q(table)} (${columns.map(q).join(', ')}) VALUES `;
    for (let i = 0; i < rows.length; i += per) {
      if (isCancelled()) throw cancelled();
      const r = req(); let k = 0;
      const values = rows.slice(i, i + per).map((row) => `(${row.map((v) => { const n = `lv${k++}`; r.input(n, v !== null && String(v).length > 4000 ? h.sql.NVarChar(h.sql.MAX) : h.sql.NVarChar(4000), v === null ? null : String(v)); return `@${n}`; }).join(', ')})`).join(', ');
      await r.query(assertGenerated('insert', head + values));
      progress({ done: Math.min(rows.length, i + per), total: rows.length, table });
    }
  }
  async function once(h, load) {
    const tx = new h.sql.Transaction(h.pool);
    await tx.begin();
    try {
      const req = () => new h.sql.Request(tx);
      await req().batch('SET XACT_ABORT ON;');
      await req().batch(assertGenerated('drop', `DROP TABLE IF EXISTS [dbo].${q(table)}`));
      await req().batch(assertGenerated('create', `CREATE TABLE [dbo].${q(table)} (${defs})`));
      await load(h, req);
      const n = Number((await req().query(`SELECT COUNT_BIG(*) AS n FROM [dbo].${q(table)}`)).recordset[0].n);
      if (n !== rows.length) throw Object.assign(new Error(`${table}: contagem após gravar (${n}) diferente do RM (${rows.length}). Nada foi gravado.`), { countMismatch: true });
      await tx.commit();
      return n;
    } catch (e) {
      try { await tx.rollback(); } catch { /* já encerrada */ }
      throw e;
    }
  }

  return core.withPool(conn, password, async (h) => {
    const who = await core.identity(h);
    if (who.database.toLowerCase() !== conn.database.toLowerCase()) throw new Error(`A conexão abriu o banco "${who.database}", diferente do escolhido ("${conn.database}"). Nada foi gravado.`);
    try {
      if (!forceInsert) {
        try { return { rows: await once(h, loadBulk), mode: 'bulk' }; } catch (e) {
          if (e.cancelled) throw e;
          // bulk recusado: transação desfeita; grava de novo pelo INSERT em lotes
          const bulkError = core.friendly(e);
          return { rows: await once(h, loadInsert), mode: 'insert', bulkError };
        }
      }
      return { rows: await once(h, loadInsert), mode: 'insert' };
    } catch (e) {
      if (!e.cancelled) e.message = core.friendly(e);
      throw e;
    }
  });
}

// Validações embutidas (só leitura): por consulta, a contagem da carga e as linhas que não estão no RM (gravadas em CSV).
async function validate(core, conn, password, { items }, { progress }) {
  return readTx(core, conn, password, async (req) => {
    const out = [];
    let done = 0;
    for (const it of items) {
      const chk = checkReadOnly(it.sql);
      if (!chk.ok) throw new Error(`Validação ${it.label} bloqueada: ${chk.errors.join(' ')}`);
      try {
        const carga = await countOf(req, checkName(it.source, 'tabela'));
        if (carga === null) out.push({ label: it.label, source: it.source, error: `Tabela da carga ${it.source} não existe na base.` });
        else {
          const r = await streamToCsv(req(), chk.sql, it.file);
          if (!r.rows) fs.rmSync(it.file, { force: true });
          out.push({ label: it.label, source: it.source, carga, missing: r.rows, file: r.rows ? it.file : null });
        }
      } catch (e) {
        fs.rmSync(it.file, { force: true });
        out.push({ label: it.label, source: it.source, error: core.friendly(e) });
      }
      progress({ done: ++done, total: items.length, table: it.label });
    }
    return out;
  });
}

// Colunas da chave de uma tabela do RM gravada na base (para o complemento). Só leitura.
async function keys(core, conn, password, { table, columns }) {
  return readTx(core, conn, password, async (req) => {
    if ((await countOf(req, checkName(table, 'tabela'))) === null) return { missing: true, rows: [] };
    const have = new Set((await req().input('t', `[dbo].${q(table)}`).query("SELECT name FROM sys.columns WHERE object_id = OBJECT_ID(@t, 'U')")).recordset.map((x) => x.name.toUpperCase()));
    const want = [...new Set(columns.map((c) => checkName(c, 'coluna').toUpperCase()))];
    const lacking = want.filter((c) => !have.has(c));
    if (lacking.length) return { lacking, rows: [] };
    const cols = have.has('CODCOLIGADA') && !want.includes('CODCOLIGADA') ? [...want, 'CODCOLIGADA'] : want;
    const r = await req().query(`SELECT ${cols.map(q).join(', ')} FROM [dbo].${q(table)}`);
    return { rows: r.recordset };
  });
}

module.exports = { precheck, dump, replace, validate, keys, assertGenerated, csvCell };
