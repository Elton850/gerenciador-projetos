// Explorador de Banco — rotas (sob /api/tools/db-explorer). Fluxo: conexão cadastrada → banco → carregar catálogo (processo-filho,
// somente leitura) → visão geral, tabelas, mapa relacional, caminhos, montador de consulta, busca, amostras/perfil e Console SQL.
//
// O catálogo carregado fica EM MEMÓRIA (até MAX_CATALOGS, o mais antigo sai); nada do banco é gravado em disco. Persistido só:
// configurações e anotações por tabela (data.tools.dbExplorer). Auditoria só com metadados (conexão, banco, tabela, quantidades) —
// nunca o texto da consulta nem valores lidos. Reaproveita conexões cadastradas (resolveConn/connPassword/DPAPI) e db.runWorker.
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const { httpError, str } = require('../../util');
const C = require('./catalog');
const S = require('./settings');
const { checkReadOnly } = require('./readonly');

const MAX_CATALOGS = 4;
const DB_NAME_RE = /^[\p{L}\p{N}_][\p{L}\p{N}_\-. ]{0,127}$/u;

function mount(app, { store, audit, db, resolveConn, connPassword, whoAmI }, base) {
  const state = () => S.ensureData(store.data);
  const catalogs = new Map();

  // ---------- Conexão (só cadastrada) ----------
  function savedConnection(id, database) {
    const saved = store.data.connections.find((c) => c.id === str(id, 40));
    if (!saved) throw httpError(400, 'Escolha uma conexão cadastrada (Configurações → Conexões).', { code: 'DBX_NO_CONNECTION' });
    const conn = resolveConn({ connectionId: saved.id, database: database || 'master' });
    return { saved, conn: { ...conn, database: database || 'master' } };
  }
  const fingerprint = (c) => crypto.createHash('sha256').update(JSON.stringify([c.id, c.server, c.port || null, c.auth, c.user || ''])).digest('hex');
  const info = (saved) => ({ connectionId: saved.id, connectionName: saved.name, env: saved.env, server: db.label(saved) });

  // Abre a senha só na hora e roda a operação no processo-filho. Se a pessoa fechar a tela/cancelar, o processo é encerrado.
  async function run(req, res, saved, conn, op, input) {
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableFinished) ac.abort(); });
    db.validateConnection(conn);
    try {
      await db.assertReachable(conn);
      return await db.runWorker(`tool:${op}`, { conn, password: await connPassword(conn), input }, { signal: ac.signal });
    } catch (e) {
      if (e.cancelled) throw httpError(499, 'Consulta cancelada.');
      throw httpError(e.status && e.status < 500 ? e.status : 502, `${saved.name}: ${db.friendly(e)}`, { code: e.code });
    }
  }

  function entryOf(id) {
    const e = catalogs.get(str(id, 40));
    if (!e) throw httpError(404, 'A estrutura deste banco não está mais carregada (o app foi reiniciado ou ela saiu da memória). Carregue de novo.', { code: 'DBX_NO_CATALOG' });
    e.lastUsed = Date.now();
    return e;
  }
  function connOf(e) {
    const { saved, conn } = savedConnection(e.connectionId, e.database);
    if (fingerprint(saved) !== e.fingerprint) throw httpError(409, 'A conexão foi alterada depois de carregar a estrutura. Carregue de novo.', { code: 'DBX_NO_CATALOG' });
    return { saved, conn };
  }
  const tableOf = (e, key) => {
    const t = C.findTable(e.cat, str(key, 300));
    if (!t) throw httpError(404, `Tabela não encontrada na estrutura carregada: ${key}`);
    return t;
  };
  const notesFor = (e) => {
    const prefix = `${e.connectionId}|${e.database.toLowerCase()}|`; const out = {};
    for (const [k, v] of Object.entries(state().notes)) if (k.startsWith(prefix)) { const t = C.findTable(e.cat, k.slice(prefix.length)); if (t) out[t.key] = v; }
    return out;
  };
  const opts = (b) => {
    const s = state().settings;
    return { includeInferred: !!b.includeInferred, avoidHubs: b.avoidHubs !== false, hubThreshold: s.hubThreshold, maxNodes: Math.max(5, Math.min(250, Number(b.maxNodes) || s.maxNodes)) };
  };
  const publicEntry = (e) => ({ id: e.id, ...info(e.saved), database: e.database, loadedAt: e.loadedAt, ms: e.ms, tables: e.cat.tables.length, inferred: e.cat.inferred.length, identity: e.cat.identity });

  // ---------- Configurações ----------
  app.get(`${base}/settings`, (req, res) => res.json({ settings: state().settings, defaults: S.DEFAULT_SETTINGS }));
  app.put(`${base}/settings`, (req, res) => {
    const s = state();
    s.settings = S.cleanSettings(req.body || {}, s.settings);
    store.save();
    audit.log({ action: 'dbx-config-alterada', detalhe: `Explorador de Banco: amostra ${s.settings.sampleRows}, console ${s.settings.queryLimit} linhas, mascarar sensíveis: ${s.settings.maskSensitive ? 'sim' : 'não'}` });
    res.json({ settings: s.settings });
  });

  // ---------- Bancos do servidor ----------
  app.post(`${base}/databases`, async (req, res) => {
    const { saved, conn } = savedConnection(req.body?.connectionId, 'master');
    const r = await run(req, res, saved, conn, 'dbx-databases', {});
    res.json({ ...info(saved), defaultDatabase: saved.database || null, identity: r.identity, databases: r.databases });
  });

  // ---------- Carregar a estrutura ----------
  app.get(`${base}/catalogs`, (req, res) => res.json([...catalogs.values()].sort((a, b) => b.lastUsed - a.lastUsed).map(publicEntry)));
  app.post(`${base}/catalogs`, async (req, res) => {
    const b = req.body || {};
    const database = str(b.database, 128).trim();
    if (!DB_NAME_RE.test(database)) throw httpError(400, 'Escolha um banco válido.');
    const { saved, conn } = savedConnection(b.connectionId, database);
    const t0 = Date.now();
    const raw = await run(req, res, saved, conn, 'dbx-catalog', {});
    const cat = C.buildCatalog(raw);
    const s = state().settings;
    C.inferRelationships(cat, { minScore: s.inferMinScore }); // hipóteses calculadas já na carga (só metadados, sem ler dados)
    const id = crypto.createHash('sha256').update(`${saved.id}|${database.toLowerCase()}`).digest('hex').slice(0, 16);
    const e = { id, connectionId: saved.id, saved, database: cat.database || database, fingerprint: fingerprint(saved), cat, loadedAt: new Date().toISOString(), ms: Date.now() - t0, lastUsed: Date.now() };
    catalogs.set(id, e);
    if (catalogs.size > MAX_CATALOGS) catalogs.delete([...catalogs.values()].sort((x, y) => x.lastUsed - y.lastUsed)[0].id);
    audit.log({ action: 'dbx-catalogo-carregado', by: whoAmI(), detalhe: `${saved.name} · ${e.database}: ${cat.tables.length} tabela(s), ${cat.rels.length} FK(s), ${cat.inferred.length} hipótese(s)`, server: db.label(saved), env: saved.env, database: e.database });
    res.json({ catalog: publicEntry(e), overview: C.overview(cat, { hubThreshold: s.hubThreshold }) });
  });

  app.get(`${base}/catalogs/:id/overview`, (req, res) => { const e = entryOf(req.params.id); res.json({ catalog: publicEntry(e), overview: C.overview(e.cat, { hubThreshold: state().settings.hubThreshold }) }); });
  app.get(`${base}/catalogs/:id/keys`, (req, res) => { const e = entryOf(req.params.id); res.json(e.cat.tables.map((t) => t.key).sort((a, b) => a.localeCompare(b))); });

  app.post(`${base}/catalogs/:id/infer`, (req, res) => {
    const e = entryOf(req.params.id);
    const minScore = Math.max(30, Math.min(95, Number(req.body?.minScore) || state().settings.inferMinScore));
    const r = C.inferRelationships(e.cat, { minScore });
    res.json({ ...r, minScore, overview: C.overview(e.cat, { hubThreshold: state().settings.hubThreshold }) });
  });

  // ---------- Tabelas ----------
  app.get(`${base}/catalogs/:id/tables`, (req, res) => {
    const e = entryOf(req.params.id); const qy = req.query;
    const noted = qy.filter === 'noted' ? new Set(Object.keys(notesFor(e))) : null;
    const r = C.tableList(e.cat, { q: str(qy.q, 200), schema: str(qy.schema, 128), filter: str(qy.filter, 20), sort: str(qy.sort, 20), limit: qy.limit, offset: qy.offset, noted });
    const notes = notesFor(e);
    for (const it of r.items) it.noted = !!notes[it.key];
    res.json(r);
  });
  app.get(`${base}/catalogs/:id/table`, (req, res) => {
    const e = entryOf(req.params.id);
    const d = C.tableDetail(e.cat, tableOf(e, req.query.key).key);
    res.json({ ...d, note: notesFor(e)[d.key] || null });
  });
  app.put(`${base}/catalogs/:id/notes`, (req, res) => {
    const e = entryOf(req.params.id);
    const t = tableOf(e, req.body?.key);
    const text = str(req.body?.text, S.NOTE_MAX).trim();
    const notes = state().notes; const k = S.noteKey(e.connectionId, e.database, t.key);
    if (!text) delete notes[k];
    else {
      if (!notes[k] && Object.keys(notes).length >= S.NOTES_MAX) throw httpError(400, `Limite de ${S.NOTES_MAX} anotações atingido.`);
      notes[k] = { text, at: new Date().toISOString(), by: whoAmI() };
    }
    store.save();
    res.json({ note: notes[k] || null });
  });

  // ---------- Mapa, caminhos, montador, busca ----------
  app.post(`${base}/catalogs/:id/graph`, (req, res) => {
    const e = entryOf(req.params.id); const b = req.body || {}; const o = opts(b);
    let g;
    if (b.mode === 'selection') {
      const keys = (Array.isArray(b.tables) ? b.tables : []).slice(0, 250).map((k) => tableOf(e, k).key);
      if (!keys.length) throw httpError(400, 'Escolha ao menos uma tabela.');
      g = C.selection(e.cat, keys, { ...o, intermediates: b.intermediates !== false, maxDepth: Math.max(1, Math.min(6, Number(b.maxDepth) || 4)) });
    } else if (b.mode === 'panorama') g = C.panorama(e.cat, { ...o, schema: str(b.schema, 128) });
    else g = C.neighborhood(e.cat, tableOf(e, b.center).key, { ...o, depth: Math.max(1, Math.min(4, Number(b.depth) || 1)), direction: ['in', 'out'].includes(b.direction) ? b.direction : 'both' });
    res.json(g);
  });
  app.post(`${base}/catalogs/:id/paths`, (req, res) => {
    const e = entryOf(req.params.id); const b = req.body || {};
    const from = tableOf(e, b.from).key; const to = tableOf(e, b.to).key;
    if (from === to) throw httpError(400, 'Escolha duas tabelas diferentes.');
    res.json(C.findPaths(e.cat, from, to, { ...opts(b), maxDepth: Math.max(1, Math.min(6, Number(b.maxDepth) || 4)), limit: Math.max(1, Math.min(30, Number(b.limit) || 12)) }));
  });
  app.post(`${base}/catalogs/:id/join`, (req, res) => {
    const e = entryOf(req.params.id); const b = req.body || {};
    const keys = (Array.isArray(b.tables) ? b.tables : []).slice(0, 30).map((k) => tableOf(e, k).key);
    if (!keys.length) throw httpError(400, 'Escolha ao menos uma tabela.');
    const plan = C.buildJoinPlan(e.cat, keys, { ...opts(b), maxDepth: Math.max(1, Math.min(6, Number(b.maxDepth) || 5)) });
    const columns = {};
    for (const [k, list] of Object.entries(b.columns && typeof b.columns === 'object' ? b.columns : {})) { const t = C.findTable(e.cat, k); if (t && Array.isArray(list)) columns[t.key] = list.slice(0, 300).map((c) => str(c, 128)); }
    const sql = C.joinSql(e.cat, plan, { top: b.top === 0 ? 0 : Number(b.top) || 100, joinType: b.joinType === 'LEFT' ? 'LEFT' : 'INNER', columns, star: !!b.star });
    res.json({ plan, sql });
  });
  app.get(`${base}/catalogs/:id/search`, (req, res) => { const e = entryOf(req.params.id); res.json(C.search(e.cat, str(req.query.q, 200))); });

  // ---------- Leitura de dados (somente leitura, no processo-filho) ----------
  const maskIf = (r, mask) => (mask ? C.maskResult(r) : { ...r, masked: [] });
  const wantMask = (b) => (b.mask === undefined ? state().settings.maskSensitive : !!b.mask);

  app.post(`${base}/catalogs/:id/sample`, async (req, res) => {
    const e = entryOf(req.params.id); const b = req.body || {};
    const t = tableOf(e, b.key); const { saved, conn } = connOf(e);
    const limit = Math.max(1, Math.min(1000, Number(b.limit) || state().settings.sampleRows));
    const r = await run(req, res, saved, conn, 'dbx-sample', { table: { schema: t.schema, name: t.name }, limit });
    audit.log({ action: 'dbx-amostra-lida', by: whoAmI(), detalhe: `${saved.name} · ${e.database}: ${t.key} (${r.rows.length} linha(s))`, server: db.label(saved), env: saved.env, database: e.database });
    res.json(maskIf(r, wantMask(b)));
  });
  app.post(`${base}/catalogs/:id/profile`, async (req, res) => {
    const e = entryOf(req.params.id); const b = req.body || {};
    const t = tableOf(e, b.key); const { saved, conn } = connOf(e);
    const sampleRows = Math.max(100, Math.min(1000000, Number(b.sampleRows) || state().settings.profileRows));
    const r = await run(req, res, saved, conn, 'dbx-profile', { table: { schema: t.schema, name: t.name }, columns: t.columns.slice(0, 400).map((c) => ({ name: c.name, type: c.type, maxLength: c.maxLength })), sampleRows });
    if (wantMask(b)) for (const c of r.columns) if (C.isSensitive(c.name)) { c.min = C.maskValue(c.min); c.max = C.maskValue(c.max); }
    res.json({ ...r, totalRows: t.rows });
  });
  app.post(`${base}/catalogs/:id/check`, async (req, res) => {
    const e = entryOf(req.params.id); const b = req.body || {};
    let rel = b.relId ? [...e.cat.rels, ...e.cat.inferred].find((r) => r.id === str(b.relId, 600)) : null;
    if (!rel) {
      const a = tableOf(e, b.from); const t = tableOf(e, b.to);
      const pairs = (Array.isArray(b.pairs) ? b.pairs : []).slice(0, 8);
      if (!pairs.length) throw httpError(400, 'Informe as colunas do relacionamento.');
      for (const p of pairs) if (!Array.isArray(p) || !a.colByLower.has(String(p[0]).toLowerCase()) || !t.colByLower.has(String(p[1]).toLowerCase())) throw httpError(400, 'Coluna inexistente no relacionamento informado.');
      rel = { from: a.key, to: t.key, pairs: pairs.map(([s, d]) => [a.colByLower.get(String(s).toLowerCase()).name, t.colByLower.get(String(d).toLowerCase()).name]) };
    }
    const from = e.cat.byKey.get(rel.from); const to = e.cat.byKey.get(rel.to);
    const { saved, conn } = connOf(e);
    const r = await run(req, res, saved, conn, 'dbx-check', { from: { schema: from.schema, name: from.name }, to: { schema: to.schema, name: to.name }, pairs: rel.pairs, sampleRows: Number(b.sampleRows) || state().settings.checkRows });
    const masked = wantMask(b) ? C.maskResult(r.topOrphans) : r.topOrphans;
    res.json({ ...r, topOrphans: masked, from: rel.from, to: rel.to, pairs: rel.pairs });
  });
  app.post(`${base}/catalogs/:id/query`, async (req, res) => {
    const e = entryOf(req.params.id); const b = req.body || {};
    const chk = checkReadOnly(b.sql);
    if (!chk.ok) throw httpError(400, chk.errors.join('\n'), { code: 'DBX_READONLY' });
    const { saved, conn } = connOf(e);
    const limit = Math.max(1, Math.min(5000, Number(b.limit) || state().settings.queryLimit));
    const r = await run(req, res, saved, conn, 'dbx-query', { sql: chk.sql, limit });
    audit.log({ action: 'dbx-consulta-executada', by: whoAmI(), detalhe: `${saved.name} · ${e.database}: ${r.rows.length} linha(s)${r.truncated ? ' (limitado)' : ''} em ${r.ms} ms`, server: db.label(saved), env: saved.env, database: e.database });
    res.json(maskIf(r, wantMask(b)));
  });

  // ---------- Exportar dicionário de dados ----------
  app.post(`${base}/catalogs/:id/export`, async (req, res) => {
    const e = entryOf(req.params.id); const b = req.body || {};
    const keys = (Array.isArray(b.tables) ? b.tables : []).slice(0, 20000).map((k) => tableOf(e, k).key);
    const fmt = ['json', 'xlsx'].includes(b.format) ? b.format : 'md';
    const notes = Object.fromEntries(Object.entries(notesFor(e)).map(([k, v]) => [k, v.text]));
    const stem = `Dicionario_${e.database.replace(/[^\w.-]+/g, '_')}${keys.length ? `_recorte${keys.length}` : ''}`;
    let body; let type; let name;
    if (fmt === 'json') { body = JSON.stringify(C.dictionaryJson(e.cat, keys, { notes }), null, 2); type = 'application/json; charset=utf-8'; name = `${stem}.json`; }
    else if (fmt === 'md') { body = C.dictionaryMarkdown(e.cat, keys, { notes }); type = 'text/markdown; charset=utf-8'; name = `${stem}.md`; }
    else { body = await workbook(C.dictionaryJson(e.cat, keys, { notes })); type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'; name = `${stem}.xlsx`; }
    audit.log({ action: 'dbx-dicionario-exportado', by: whoAmI(), detalhe: `${e.saved.name} · ${e.database}: ${keys.length || e.cat.tables.length} tabela(s), ${fmt.toUpperCase()}`, database: e.database });
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Disposition', `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(body);
  });
}

async function workbook(j) {
  const wb = new ExcelJS.Workbook();
  const sheet = (name, columns, rows) => {
    const ws = wb.addWorksheet(name);
    ws.columns = columns.map(([header, key, width]) => ({ header, key, width }));
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    for (const r of rows) ws.addRow(r);
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  };
  sheet('Tabelas', [['Tabela', 'key', 40], ['Linhas (aprox.)', 'rows', 16], ['Colunas', 'cols', 10], ['Chave primária', 'pk', 36], ['Descrição', 'description', 50], ['Anotação', 'note', 50]],
    j.tables.map((t) => ({ key: t.key, rows: t.rows, cols: t.columns.length, pk: t.primaryKey.join(', '), description: t.description || '', note: t.note || '' })));
  sheet('Colunas', [['Tabela', 'table', 40], ['Coluna', 'name', 30], ['Tipo', 'type', 18], ['Nulo', 'nullable', 8], ['PK', 'pk', 6], ['FK', 'fk', 6], ['Sensível', 'sensitive', 10], ['Classificação', 'classification', 22], ['Descrição', 'description', 50]],
    j.tables.flatMap((t) => t.columns.map((c) => ({ table: t.key, name: c.name, type: c.type, nullable: c.nullable ? 'sim' : 'não', pk: c.pk ? 'sim' : '', fk: c.fk ? 'sim' : '', sensitive: c.sensitive ? 'sim' : '', classification: c.classification, description: c.description || '' }))));
  sheet('Relacionamentos', [['Tipo', 'kind', 12], ['Nome', 'name', 34], ['Origem', 'from', 36], ['Destino', 'to', 36], ['Colunas', 'cols', 50], ['Confiança', 'confidence', 12], ['Motivos', 'reasons', 60]],
    j.relationships.map((r) => ({ kind: r.kind, name: r.name, from: r.from, to: r.to, cols: r.columns.join(' AND '), confidence: r.confidence, reasons: (r.reasons || []).join('; ') })));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { mount };
