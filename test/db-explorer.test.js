// Ferramentas Auxiliares › Explorador de Banco: regras puras do catálogo (hipóteses, mapa, caminhos, montador, busca, dicionário),
// trava do Console SQL (somente leitura) e API com o SQL Server simulado no ponto em que o app fala com o processo-filho
// (db.runWorker). A execução real em banco fica em scripts/e2e-dbx-local.js (só SQL Server localhost).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-dbx-'));
const PORT = 4476;
process.env.PORT = String(PORT);
process.env.GP_DATA_DIR = path.join(tmp, 'data');
const { app, store } = require('../server');
const db = require('../src/db');
const C = require('../src/tools/db-explorer/catalog');
const S = require('../src/tools/db-explorer/settings');
const { checkReadOnly } = require('../src/tools/db-explorer/readonly');

let server;
test.before(() => { server = app.listen(PORT, '127.0.0.1'); });
test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

// ---------- Catálogo de exemplo (o formato que sql.js devolve) ----------
// Estilo RM: GCOLIGADA (dona) ← PFUNC (CODCOLIGADA, CHAPA) ← PFDEPEND (FK composta); PFERIAS sem FK (hipótese composta);
// PPESSOA ← PFUNC.CODPESSOA e SALUNO.CODPESSOA (mesma pessoa); ITEM.PRODUTOID sem FK → PRODUTO.ID (hipótese por nome).
function rawCatalog() {
  let id = 0;
  const tables = []; const columns = []; const indexes = []; const fks = [];
  const T = (name, cols, pk, rows = 10) => {
    const objectId = ++id;
    tables.push({ objectId, schema: 'dbo', name, rows });
    cols.forEach(([n, type, nullable = false], i) => columns.push({ objectId, name: n, type, maxLength: type === 'varchar' ? 20 : 4, precision: 0, scale: 0, nullable, identity: false, computed: false, hasDefault: false, ord: i + 1 }));
    if (pk) indexes.push({ objectId, name: `PK_${name}`, pk: true, unique: true, cols: pk });
    return objectId;
  };
  const col = T('GCOLIGADA', [['CODCOLIGADA', 'smallint'], ['NOME', 'varchar']], ['CODCOLIGADA'], 2);
  const pes = T('PPESSOA', [['CODIGO', 'int'], ['NOME', 'varchar'], ['CPF', 'varchar', true], ['EMAIL', 'varchar', true]], ['CODIGO'], 1000);
  const fun = T('PFUNC', [['CODCOLIGADA', 'smallint'], ['CHAPA', 'varchar'], ['CODPESSOA', 'int'], ['SALARIO', 'numeric', true]], ['CODCOLIGADA', 'CHAPA'], 500);
  const dep = T('PFDEPEND', [['CODCOLIGADA', 'smallint'], ['CHAPA', 'varchar'], ['NRODEPEND', 'int']], ['CODCOLIGADA', 'CHAPA', 'NRODEPEND'], 300);
  T('PFERIAS', [['CODCOLIGADA', 'smallint'], ['CHAPA', 'varchar'], ['INICIO', 'date']], ['CODCOLIGADA', 'CHAPA', 'INICIO'], 800);
  const alu = T('SALUNO', [['CODCOLIGADA', 'smallint'], ['RA', 'varchar'], ['CODPESSOA', 'int']], ['CODCOLIGADA', 'RA'], 400);
  T('SNOTAS', [['CODCOLIGADA', 'smallint'], ['RA', 'varchar'], ['ETAPA', 'int'], ['NOTA', 'numeric', true]], ['CODCOLIGADA', 'RA', 'ETAPA'], 3000);
  T('PRODUTO', [['ID', 'int'], ['DESCRICAO', 'varchar', true]], ['ID'], 50);
  const item = T('ITEM', [['PEDIDOID', 'int'], ['PRODUTOID', 'int'], ['QTD', 'int', true]], ['PEDIDOID', 'PRODUTOID'], 90);
  T('LOG', [['QUANDO', 'datetime2', true], ['TEXTO', 'nvarchar', true]], null, 0);
  indexes.push({ objectId: item, name: 'IX_ITEM_PRODUTO', pk: false, unique: false, cols: ['PRODUTOID'] });
  fks.push({ name: 'FK_PFUNC_COLIGADA', fromId: fun, toId: col, pairs: [['CODCOLIGADA', 'CODCOLIGADA']] });
  fks.push({ name: 'FK_PFUNC_PESSOA', fromId: fun, toId: pes, pairs: [['CODPESSOA', 'CODIGO']] });
  fks.push({ name: 'FK_PFDEPEND_PFUNC', fromId: dep, toId: fun, pairs: [['CODCOLIGADA', 'CODCOLIGADA'], ['CHAPA', 'CHAPA']] });
  fks.push({ name: 'FK_SALUNO_COLIGADA', fromId: alu, toId: col, pairs: [['CODCOLIGADA', 'CODCOLIGADA']] });
  fks.push({ name: 'FK_SALUNO_PESSOA', fromId: alu, toId: pes, pairs: [['CODPESSOA', 'CODIGO']] });
  return { identity: { server: 'SRV', database: 'BASE_TESTE', login: 'teste', version: 'x' }, database: 'BASE_TESTE', counts: { views: 1, procedures: 2 }, tables, columns, indexes, fks,
    descriptions: [{ objectId: fun, column: null, text: 'Funcionários' }, { objectId: pes, column: 'CPF', text: 'CPF da pessoa' }] };
}
const fresh = () => { const cat = C.buildCatalog(rawCatalog()); C.inferRelationships(cat, { minScore: 55 }); return cat; };

test('catálogo: FK composta vira UMA relação; descrições e colunas sensíveis', () => {
  const cat = fresh();
  assert.equal(cat.tables.length, 10);
  assert.equal(cat.rels.length, 5);
  const dep = C.tableDetail(cat, 'PFDEPEND');
  const fk = dep.relationships.find((r) => r.kind === 'fk');
  assert.deepEqual(fk.pairs, [['CODCOLIGADA', 'CODCOLIGADA'], ['CHAPA', 'CHAPA']]);
  assert.equal(C.tableDetail(cat, 'dbo.PFUNC').description, 'Funcionários');
  const cpf = C.tableDetail(cat, 'dbo.PPESSOA').columns.find((c) => c.name === 'CPF');
  assert.equal(cpf.sensitive, true); assert.equal(cpf.description, 'CPF da pessoa'); assert.equal(cpf.classification, 'identificador sensível');
  assert.equal(C.findTable(cat, 'dbo.pfunc').key, 'dbo.PFUNC', 'sem diferenciar maiúsculas');
});

test('hipóteses: chave composta inteira, padrão de nome e sem duplicar FK real', () => {
  const cat = fresh();
  const inf = (from, to) => cat.inferred.find((r) => r.from === from && r.to === to);
  const fer = inf('dbo.PFERIAS', 'dbo.PFUNC');
  assert.ok(fer, 'PFERIAS(CODCOLIGADA,CHAPA) → PFUNC');
  assert.deepEqual(fer.pairs, [['CODCOLIGADA', 'CODCOLIGADA'], ['CHAPA', 'CHAPA']]);
  assert.ok(fer.reasons.includes('chave composta inteira'));
  assert.ok(inf('dbo.ITEM', 'dbo.PRODUTO'), 'PRODUTOID segue o padrão do nome da tabela PRODUTO (PK genérica ID)');
  assert.equal(inf('dbo.PFDEPEND', 'dbo.PFUNC'), undefined, 'já existe FK real com as mesmas colunas');
  assert.equal(inf('dbo.PFUNC', 'dbo.GCOLIGADA'), undefined);
  assert.ok(inf('dbo.SNOTAS', 'dbo.SALUNO'));
  for (const r of cat.inferred) { assert.ok(r.score >= 55 && r.score <= 95); assert.ok(['alta', 'média'].includes(C.confidence(r.score))); }
  const r = C.inferRelationships(cat, { minScore: 90 });
  assert.ok(r.count < 5);
});

test('visão geral: contagens, isoladas, sem PK, colunas recorrentes', () => {
  const o = C.overview(fresh());
  assert.equal(o.counts.tables, 10); assert.equal(o.counts.fks, 5); assert.equal(o.counts.noPk, 1);
  assert.equal(o.counts.isolated, 5, 'PFERIAS, SNOTAS, PRODUTO, ITEM, LOG não têm FK');
  assert.equal(o.recurring[0].column, 'CODCOLIGADA');
  assert.equal(o.connected[0].key, 'dbo.PFUNC');
  assert.ok(o.counts.sensitiveColumns >= 2);
});

test('lista de tabelas: filtros, ordem e busca por coluna exata', () => {
  const cat = fresh();
  assert.deepEqual(C.tableList(cat, { filter: 'noPk' }).items.map((t) => t.key), ['dbo.LOG']);
  assert.equal(C.tableList(cat, { sort: 'rows', limit: 1 }).items[0].key, 'dbo.SNOTAS');
  assert.deepEqual(C.tableList(cat, { q: 'chapa' }).items.map((t) => t.key).sort(), ['dbo.PFDEPEND', 'dbo.PFERIAS', 'dbo.PFUNC']);
  assert.equal(C.tableList(cat, { filter: 'inferred' }).items.some((t) => t.key === 'dbo.PRODUTO'), true);
});

test('mapa: vizinhança por profundidade/direção, hubs não expandidos, seleção com intermediárias', () => {
  const cat = fresh();
  const g1 = C.neighborhood(cat, 'dbo.PFDEPEND', { depth: 1 });
  assert.deepEqual(g1.nodes.map((n) => n.key).sort(), ['dbo.PFDEPEND', 'dbo.PFUNC']);
  assert.equal(g1.nodes.find((n) => n.key === 'dbo.PFDEPEND').center, true);
  const g2 = C.neighborhood(cat, 'dbo.PFDEPEND', { depth: 2, direction: 'out' });
  assert.deepEqual(g2.nodes.map((n) => n.key).sort(), ['dbo.GCOLIGADA', 'dbo.PFDEPEND', 'dbo.PFUNC', 'dbo.PPESSOA']);
  const gIn = C.neighborhood(cat, 'dbo.PPESSOA', { depth: 1, direction: 'in' });
  assert.deepEqual(gIn.nodes.map((n) => n.key).sort(), ['dbo.PFUNC', 'dbo.PPESSOA', 'dbo.SALUNO']);
  // Hub (limiar 2): GCOLIGADA aparece no 1º nível de PFUNC, mas não é expandida no 2º nível (SALUNO não entra por ela).
  const gh = C.neighborhood(cat, 'dbo.PFDEPEND', { depth: 3, avoidHubs: true, hubThreshold: 2 });
  assert.ok(!gh.nodes.some((n) => n.key === 'dbo.GCOLIGADA'));
  assert.ok(gh.hidden.includes('dbo.GCOLIGADA') || gh.hidden.includes('dbo.PFUNC') || gh.nodes.length <= 3);
  const lim = C.neighborhood(cat, 'dbo.PFUNC', { depth: 3, maxNodes: 3, includeInferred: true });
  assert.equal(lim.nodes.length, 3); assert.equal(lim.truncated, true);
  const sel = C.selection(cat, ['dbo.PFDEPEND', 'dbo.SALUNO'], { intermediates: true, avoidHubs: false });
  assert.ok(sel.nodes.some((n) => n.key === 'dbo.PFUNC'), 'intermediária incluída');
  assert.deepEqual(sel.nodes.filter((n) => n.highlighted).map((n) => n.key).sort(), ['dbo.PFDEPEND', 'dbo.SALUNO']);
  assert.ok(sel.edges.every((e) => sel.nodes.some((n) => n.key === e.from) && sel.nodes.some((n) => n.key === e.to)));
  const pano = C.panorama(cat, { maxNodes: 2 });
  assert.equal(pano.nodes.length, 2); assert.equal(pano.truncated, true);
  assert.ok(C.neighborhood(cat, 'dbo.NAO_EXISTE') === null);
});

test('caminhos: FK primeiro, hipóteses só se pedido, ligação "irmã" pelo dono fica por último', () => {
  const cat = fresh();
  const p = C.findPaths(cat, 'dbo.PFDEPEND', 'dbo.PPESSOA', { includeInferred: false });
  assert.deepEqual(p.paths[0].nodes, ['dbo.PFDEPEND', 'dbo.PFUNC', 'dbo.PPESSOA']);
  assert.match(p.paths[0].sql, /JOIN \[dbo\]\.\[PFUNC\] AS t1[^\n]*\n {4}ON t1\.\[CODCOLIGADA\] = t0\.\[CODCOLIGADA\]\n {3}AND t1\.\[CHAPA\] = t0\.\[CHAPA\]/);
  assert.equal(C.findPaths(cat, 'dbo.ITEM', 'dbo.PRODUTO', {}).paths.length, 0);
  const inf = C.findPaths(cat, 'dbo.ITEM', 'dbo.PRODUTO', { includeInferred: true });
  assert.equal(inf.paths[0].inferredSteps, 1); assert.match(inf.paths[0].sql, /HIPÓTESE/);
  // SNOTAS → PFUNC: por SALUNO → PPESSOA (mesma pessoa) antes de "as duas são da coligada 1".
  const s = C.findPaths(cat, 'dbo.SNOTAS', 'dbo.PFUNC', { includeInferred: true, avoidHubs: false, maxDepth: 4 });
  assert.deepEqual(s.paths[0].nodes, ['dbo.SNOTAS', 'dbo.SALUNO', 'dbo.PPESSOA', 'dbo.PFUNC']);
  assert.deepEqual(s.paths[0].weakVia, []);
  const weak = s.paths.find((x) => x.nodes.includes('dbo.GCOLIGADA'));
  assert.ok(weak && weak.weakVia.includes('dbo.GCOLIGADA'));
  assert.ok(s.paths.indexOf(weak) > 0);
  const avoided = C.findPaths(cat, 'dbo.PFDEPEND', 'dbo.SALUNO', { avoidHubs: true, hubThreshold: 3 });
  assert.ok(avoided.paths.every((x) => !x.nodes.slice(1, -1).includes('dbo.PFUNC')));
});

test('montador: liga pelas FKs com intermediárias, colunas escolhidas, LEFT JOIN e tabelas sem ligação', () => {
  const cat = fresh();
  const plan = C.buildJoinPlan(cat, ['dbo.PFDEPEND', 'dbo.PPESSOA']);
  assert.deepEqual(plan.joins.map((j) => [j.table, j.intermediate]), [['dbo.PFUNC', true], ['dbo.PPESSOA', false]]);
  const sql = C.joinSql(cat, plan, { joinType: 'LEFT', top: 50, columns: { 'dbo.PPESSOA': ['NOME', 'CPF', 'NAO_EXISTE'] } });
  assert.match(sql, /^SELECT TOP \(50\)/);
  assert.match(sql, /t2\.\[NOME\],\n {4}t2\.\[CPF\]/);
  assert.ok(!sql.includes('NAO_EXISTE'), 'coluna inexistente é ignorada');
  assert.match(sql, /LEFT JOIN \[dbo\]\.\[PPESSOA\] AS t2[^\n]*\n {4}ON t2\.\[CODIGO\] = t1\.\[CODPESSOA\]/);
  const miss = C.buildJoinPlan(cat, ['dbo.PFUNC', 'dbo.LOG']);
  assert.deepEqual(miss.missing, ['dbo.LOG']);
  assert.match(C.joinSql(cat, C.buildJoinPlan(cat, ['dbo.PFUNC']), { star: true, top: 0 }), /^SELECT\n {4}t0\.\*\nFROM \[dbo\]\.\[PFUNC\] AS t0;$/);
  // Com hipóteses: SNOTAS + PPESSOA usa SNOTAS → SALUNO (hipótese) → PPESSOA (FK), não a coligada.
  const h = C.buildJoinPlan(cat, ['dbo.SNOTAS', 'dbo.PPESSOA'], { includeInferred: true });
  assert.deepEqual(h.joins.map((j) => j.table), ['dbo.SALUNO', 'dbo.PPESSOA']);
  assert.equal(h.weak.length, 0);
});

test('identificadores com colchete sempre escapados no SQL gerado', () => {
  const raw = rawCatalog();
  raw.tables.push({ objectId: 99, schema: 'dbo', name: 'X]Y', rows: 1 });
  raw.columns.push({ objectId: 99, name: 'A]]B', type: 'int', maxLength: 4, precision: 0, scale: 0, nullable: false, identity: false, computed: false, hasDefault: false, ord: 1 });
  const cat = C.buildCatalog(raw);
  assert.equal(C.tableRef(cat.byKey.get('dbo.X]Y')), '[dbo].[X]]Y]');
  assert.match(C.tableDetail(cat, 'dbo.X]Y').selectSql, /\[A\]\]\]\]B\][\s\S]*FROM \[dbo\]\.\[X\]\]Y\]/);
});

test('busca global e dicionário de dados', () => {
  const cat = fresh();
  const r = C.search(cat, 'codpessoa');
  assert.deepEqual(r.columns.map((c) => c.table).sort(), ['dbo.PFUNC', 'dbo.SALUNO']);
  assert.ok(r.relationships.some((x) => x.name === 'FK_PFUNC_PESSOA'));
  assert.equal(C.search(cat, 'x').tables.length, 0, 'mínimo 2 caracteres');
  const j = C.dictionaryJson(cat, ['dbo.PFUNC'], { notes: { 'dbo.PFUNC': 'tabela principal' } });
  assert.equal(j.tables.length, 1); assert.equal(j.tables[0].note, 'tabela principal');
  assert.ok(j.relationships.every((x) => x.from === 'dbo.PFUNC' || x.to === 'dbo.PFUNC'));
  const md = C.dictionaryMarkdown(cat, null);
  assert.match(md, /^# Dicionário de dados — BASE_TESTE/);
  assert.match(md, /## dbo\.LOG[\s\S]*sem PK/);
});

test('máscara de campos sensíveis', () => {
  assert.equal(C.maskValue('123.456.789-00'), '12**********00');
  assert.equal(C.maskValue('abc'), '***');
  assert.equal(C.maskValue(null), null);
  const m = C.maskResult({ columns: ['NOME', 'CPF', 'E_MAIL'], rows: [['Ana', '12345678900', 'ana@exemplo.test']] });
  assert.deepEqual(m.masked, ['CPF', 'E_MAIL']);
  assert.equal(m.rows[0][0], 'Ana'); assert.ok(m.rows[0][1].includes('*'));
});

test('Console SQL: só uma consulta de leitura', () => {
  for (const ok of ['SELECT 1', 'select * from dbo.X;', 'WITH a AS (SELECT 1 AS x) SELECT * FROM a', "SELECT 'DELETE FROM x; DROP TABLE y' AS t", 'SELECT [UPDATE] FROM dbo.[DROP]', '-- DELETE\nSELECT 1 /* EXEC xp_cmdshell */', '(SELECT 1)']) {
    assert.equal(checkReadOnly(ok).ok, true, ok);
  }
  for (const bad of ['', 'DELETE FROM X', 'UPDATE X SET a = 1', 'SELECT * INTO dbo.Y FROM X', 'SELECT 1; SELECT 2', 'SELECT 1\nGO\nSELECT 2', "EXEC('SELECT 1')", 'EXEC sp_who',
    'SELECT * FROM OPENROWSET(BULK \'c:\\x\', SINGLE_CLOB) a', 'WITH a AS (SELECT 1 x) DELETE FROM a', 'DECLARE @x int = 1', 'SELECT 1 WAITFOR DELAY \'00:00:10\'', 'SELECT NEXT VALUE FOR dbo.S',
    ':connect outro', 'USE master', 'SELECT 1; DROP TABLE x --', 'BEGIN TRAN SELECT 1', 'TRUNCATE TABLE x', 'SELECT * FROM x; --']) {
    const r = checkReadOnly(bad);
    if (bad === 'SELECT * FROM x; --') { assert.equal(r.ok, true, 'ponto e vírgula final + comentário é uma consulta só'); continue; }
    assert.equal(r.ok, false, bad);
  }
  assert.equal(checkReadOnly('SELECT 1;').sql, 'SELECT 1');
});

test('configurações: limites e dados idempotentes', () => {
  const d = {};
  S.ensureData(d); S.ensureData(d);
  assert.deepEqual(d.tools.dbExplorer.settings, { ...S.DEFAULT_SETTINGS });
  assert.deepEqual(d.tools.dbExplorer.notes, {});
  d.tools.dbExplorer.notes['x|y|z'] = { text: 'a' };
  S.ensureData(d);
  assert.equal(d.tools.dbExplorer.notes['x|y|z'].text, 'a', 'nunca apaga anotação');
  const s = S.cleanSettings({ sampleRows: 99999, queryLimit: -5, maskSensitive: false, hubThreshold: 'abc' });
  assert.equal(s.sampleRows, 1000); assert.equal(s.queryLimit, 1); assert.equal(s.maskSensitive, false); assert.equal(s.hubThreshold, 0);
});

// ---------- API (SQL Server simulado) ----------
const sim = { calls: [], passwords: [], fail: null };
db.runWorker = async (op, args) => {
  sim.calls.push({ op, args });
  sim.passwords.push(args.password);
  if (sim.fail) throw new Error(sim.fail);
  if (op === 'tool:dbx-databases') return { identity: { server: 'SRV', database: 'master', login: 'teste' }, databases: [{ name: 'master', state: 'ONLINE', access: true, system: true }, { name: 'BASE_TESTE', state: 'ONLINE', access: true, system: false }] };
  if (op === 'tool:dbx-catalog') { assert.equal(args.conn.database, 'BASE_TESTE'); return rawCatalog(); }
  if (op === 'tool:dbx-sample') return { columns: ['CODIGO', 'NOME', 'CPF'], rows: [[1, 'Ana', '123.456.789-00']], truncated: false, ms: 3 };
  if (op === 'tool:dbx-profile') return { sampled: 1, sampleLimit: args.input.sampleRows, ms: 2, columns: args.input.columns.map((c) => ({ name: c.name, nulls: 0, filledPct: 100, distinct: 1, min: c.name === 'CPF' ? '123.456.789-00' : 'a', max: 'z', minLen: null, maxLen: null })) };
  if (op === 'tool:dbx-check') return { sampled: 10, matched: 9, orphans: 1, matchPct: 90, topOrphans: { columns: ['CODCOLIGADA', 'CHAPA', 'ocorrencias'], rows: [[1, '0099', 1]], truncated: false }, sampleLimit: 10000, ms: 4 };
  if (op === 'tool:dbx-query') return { columns: ['EMAIL', 'N'], rows: [['ana@exemplo.test', 1]], truncated: false, ms: 5, limit: args.input.limit };
  throw new Error(`op inesperada ${op}`);
};
db.assertReachable = async () => {}; // conexões de teste (192.0.2.x) não existem na rede

const base = `http://localhost:${PORT}`;
const api = async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Origin: base }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = {}; try { json = JSON.parse(text); } catch { /* download */ }
  return { status: r.status, json, text, headers: r.headers };
};
const B = '/api/tools/db-explorer';

test('API: registro, conexão cadastrada, carregar estrutura e navegar', async () => {
  const tools = (await api('GET', '/api/tools')).json;
  assert.ok(tools.some((t) => t.id === 'db-explorer' && t.permissions.length));
  assert.equal((await api('POST', `${B}/databases`, { connectionId: 'nao-existe' })).json.code, 'DBX_NO_CONNECTION');
  const conn = (await api('POST', '/api/connections', { name: 'Homolog', env: 'hml', server: '192.0.2.10', auth: 'sql', user: 'leitor', password: 'senha-ficticia' })).json;
  const dbs = await api('POST', `${B}/databases`, { connectionId: conn.id });
  assert.equal(dbs.status, 200); assert.equal(dbs.json.databases.length, 2);
  assert.equal(sim.passwords.at(-1), 'senha-ficticia', 'senha aberta só para o processo-filho');
  assert.ok(!JSON.stringify(dbs.json).includes('senha-ficticia'));

  assert.equal((await api('POST', `${B}/catalogs`, { connectionId: conn.id, database: "x'; DROP" })).status, 400);
  const load = await api('POST', `${B}/catalogs`, { connectionId: conn.id, database: 'BASE_TESTE' });
  assert.equal(load.status, 200, JSON.stringify(load.json));
  const id = load.json.catalog.id;
  assert.equal(load.json.overview.counts.tables, 10);
  assert.ok(load.json.overview.counts.inferred > 0, 'hipóteses calculadas na carga');
  assert.equal((await api('GET', `${B}/catalogs`)).json[0].id, id);
  assert.equal((await api('GET', `${B}/catalogs/${id}/keys`)).json.length, 10);
  assert.equal((await api('GET', `${B}/catalogs/${id}/tables?filter=noPk`)).json.items[0].key, 'dbo.LOG');
  assert.equal((await api('GET', `${B}/catalogs/${id}/table?key=PFUNC`)).json.key, 'dbo.PFUNC');
  assert.equal((await api('GET', `${B}/catalogs/${id}/table?key=NAO_EXISTE`)).status, 404);
  assert.equal((await api('GET', `${B}/catalogs/nao-existe/overview`)).json.code, 'DBX_NO_CATALOG');

  const g = await api('POST', `${B}/catalogs/${id}/graph`, { mode: 'center', center: 'dbo.PFUNC', depth: 1 });
  assert.equal(g.status, 200); assert.ok(g.json.nodes.length >= 4);
  assert.equal((await api('POST', `${B}/catalogs/${id}/graph`, { mode: 'selection', tables: [] })).status, 400);
  const p = await api('POST', `${B}/catalogs/${id}/paths`, { from: 'dbo.PFDEPEND', to: 'dbo.PPESSOA' });
  assert.deepEqual(p.json.paths[0].nodes, ['dbo.PFDEPEND', 'dbo.PFUNC', 'dbo.PPESSOA']);
  assert.equal((await api('POST', `${B}/catalogs/${id}/paths`, { from: 'dbo.PFUNC', to: 'dbo.PFUNC' })).status, 400);
  const j = await api('POST', `${B}/catalogs/${id}/join`, { tables: ['dbo.PFDEPEND', 'dbo.PPESSOA'], joinType: 'LEFT' });
  assert.match(j.json.sql, /LEFT JOIN/);
  assert.ok((await api('GET', `${B}/catalogs/${id}/search?q=CODPESSOA`)).json.columns.length === 2);
  const inf = await api('POST', `${B}/catalogs/${id}/infer`, { minScore: 90 });
  assert.equal(inf.status, 200); assert.equal(inf.json.minScore, 90);
  assert.ok(inf.json.count < load.json.overview.counts.inferred);
  await api('POST', `${B}/catalogs/${id}/infer`, { minScore: 55 });

  // Leitura de dados: máscara padrão, trava do Console e auditoria sem SQL nem valores
  const s = await api('POST', `${B}/catalogs/${id}/sample`, { key: 'dbo.PPESSOA' });
  assert.deepEqual(s.json.masked, ['CPF']); assert.ok(s.json.rows[0][2].includes('*'));
  assert.equal((await api('POST', `${B}/catalogs/${id}/sample`, { key: 'dbo.PPESSOA', mask: false })).json.rows[0][2], '123.456.789-00');
  const sp = sim.calls.find((c) => c.op === 'tool:dbx-sample');
  assert.deepEqual(sp.args.input.table, { schema: 'dbo', name: 'PPESSOA' }); assert.equal(sp.args.conn.database, 'BASE_TESTE');
  const pr = await api('POST', `${B}/catalogs/${id}/profile`, { key: 'dbo.PPESSOA' });
  assert.ok(pr.json.columns.find((c) => c.name === 'CPF').min.includes('*'));
  const fer = (await api('GET', `${B}/catalogs/${id}/table?key=dbo.PFERIAS`)).json.relationships.find((r) => r.kind === 'inferred' && r.to === 'dbo.PFUNC');
  const ck = await api('POST', `${B}/catalogs/${id}/check`, { relId: fer.id });
  assert.equal(ck.json.matchPct, 90);
  assert.deepEqual(sim.calls.at(-1).args.input.pairs, [['CODCOLIGADA', 'CODCOLIGADA'], ['CHAPA', 'CHAPA']]);
  assert.equal((await api('POST', `${B}/catalogs/${id}/check`, { from: 'dbo.ITEM', to: 'dbo.PRODUTO', pairs: [['X; DROP', 'ID']] })).status, 400, 'coluna fora do catálogo');
  const before = sim.calls.length;
  const bad = await api('POST', `${B}/catalogs/${id}/query`, { sql: 'DELETE FROM dbo.PFUNC' });
  assert.equal(bad.status, 400); assert.equal(bad.json.code, 'DBX_READONLY');
  assert.equal(sim.calls.length, before, 'consulta bloqueada nem chega ao processo-filho');
  const q = await api('POST', `${B}/catalogs/${id}/query`, { sql: 'SELECT EMAIL, 1 AS N FROM dbo.PPESSOA', limit: 99999 });
  assert.equal(q.status, 200); assert.equal(sim.calls.at(-1).args.input.limit, 5000); assert.ok(q.json.rows[0][0].includes('*'));
  const log = fs.readFileSync(path.join(process.env.GP_DATA_DIR, 'audit.log'), 'utf8');
  assert.match(log, /dbx-catalogo-carregado/); assert.match(log, /dbx-consulta-executada/);
  assert.ok(!log.includes('SELECT EMAIL'), 'auditoria sem o texto da consulta');
  assert.ok(!log.includes('ana@exemplo.test') && !log.includes('123.456.789-00'), 'auditoria sem valores lidos');
  assert.ok(!log.includes('senha-ficticia'));

  // Erro do servidor SQL vira mensagem com o nome da conexão
  sim.fail = 'Login failed for user';
  const e = await api('POST', `${B}/catalogs/${id}/sample`, { key: 'dbo.PFUNC' });
  assert.equal(e.status, 502); assert.match(e.json.error, /^Homolog: Login failed/);
  sim.fail = null;

  // Anotações (persistidas) e exportação
  const n = await api('PUT', `${B}/catalogs/${id}/notes`, { key: 'dbo.PFUNC', text: 'cadastro principal da folha' });
  assert.equal(n.json.note.text, 'cadastro principal da folha');
  assert.equal(store.data.tools.dbExplorer.notes[S.noteKey(conn.id, 'BASE_TESTE', 'dbo.PFUNC')].text, 'cadastro principal da folha');
  assert.equal((await api('GET', `${B}/catalogs/${id}/table?key=dbo.PFUNC`)).json.note.text, 'cadastro principal da folha');
  assert.deepEqual((await api('GET', `${B}/catalogs/${id}/tables?filter=noted`)).json.items.map((t) => t.key), ['dbo.PFUNC']);
  const md = await api('POST', `${B}/catalogs/${id}/export`, { format: 'md', tables: ['dbo.PFUNC'] });
  assert.equal(md.status, 200); assert.match(md.text, /cadastro principal da folha/);
  assert.match(md.headers.get('content-disposition'), /Dicionario_BASE_TESTE_recorte1\.md/);
  const xl = await fetch(`${base}${B}/catalogs/${id}/export`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ format: 'xlsx' }) });
  assert.equal(xl.status, 200); assert.equal(Buffer.from(await xl.arrayBuffer()).subarray(0, 2).toString(), 'PK');
  assert.equal((await api('PUT', `${B}/catalogs/${id}/notes`, { key: 'dbo.PFUNC', text: '' })).json.note, null);

  // Conexão alterada depois de carregar → precisa recarregar
  await api('PUT', `/api/connections/${conn.id}`, { name: 'Homolog', env: 'hml', server: '192.0.2.11', auth: 'sql', user: 'leitor' });
  assert.equal((await api('POST', `${B}/catalogs/${id}/sample`, { key: 'dbo.PFUNC' })).json.code, 'DBX_NO_CATALOG');

  // Configurações
  const st = await api('PUT', `${B}/settings`, { sampleRows: 20, maskSensitive: false });
  assert.equal(st.json.settings.sampleRows, 20); assert.equal(store.data.tools.dbExplorer.settings.maskSensitive, false);
});
