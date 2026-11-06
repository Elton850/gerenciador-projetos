// Validação de Carga (ferramenta auxiliar): regras puras (modelo, parâmetros, trava de SELECT, complemento), cliente do RM contra um
// RM SIMULADO (SOAP + REST em 127.0.0.1, travas de escrita) e a API com o SQL Server simulado (db.runWorker). Nada toca RM/banco real.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-lvtest-')); // prefixo diferente do gp-lv-* que a ferramenta usa (e apaga)
const PORT = 4478;
const RM_PORT = 4479;
process.env.PORT = String(PORT);
process.env.GP_DATA_DIR = path.join(tmp, 'data');
const { app, store } = require('../server');
const db = require('../src/db');
const C = require('../src/tools/load-validator/catalog');
const RM = require('../src/tools/load-validator/rm');
const SQLM = require('../src/tools/load-validator/sql');
const { checkReadOnly } = require('../src/tools/db-explorer/readonly');
const { createFakeRm } = require('./fake-rm');

// ---------- RM simulado: wsDataServer (SOAP) + REST de Consulta SQL (test/fake-rm.js) ----------
const fake = createFakeRm();
fake.rows['ZMV.STURMA'] = [{ CODCOLIGADA: 7, CODTURMA: 'T1', NOME: 'Turma &1' }, { CODCOLIGADA: 7, CODTURMA: 'T2', NOME: null }];
const RMCONN = fake.conn(RM_PORT);

let server;
test.before(async () => { server = app.listen(PORT, '127.0.0.1'); await fake.listen(RM_PORT); });
test.after(() => { server.close(); fake.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

// ---------- Regras puras ----------
test('modelo Educacional: 24 tabelas, parâmetros só coligada/períodos, todas as consultas são SELECT', () => {
  const s = C.systemOf('educacional');
  assert.equal(s.tables.length, 24);
  assert.throws(() => C.systemOf('folha'), /ainda não está disponível/);
  for (const t of s.tables) {
    const sql = C.renderRm(t, { coligada: 7, periods: '2030, 2031' });
    assert.ok(/^SELECT\b/.test(sql) && !/\{\{/.test(sql), t.table);
    if (t.table !== 'PPESSOA') assert.match(sql, /CODCOLIGADA = 7\b/, t.table);
    for (const v of t.validations) { assert.ok(checkReadOnly(v.sql).ok, v.label); assert.match(C.sourceOf(v.sql), /^(ZMIGRA_\w+|ZPESSOA)$/, v.label); }
  }
  const freq = s.tables.find((t) => t.table === 'SFREQUENCIA');
  assert.match(C.renderRm(freq, { coligada: 7, periods: ['2030', '2031'] }), /IN \('2030', '2031'\)/);
  assert.doesNotMatch(C.renderRm(freq, { coligada: 7, periods: '' }), /CODPERLET IN/);
  assert.equal(s.tables.find((t) => t.table === 'SNOTAETAPA').validations.length, 2);
  assert.equal(s.complement.length, 23);
});

test('parâmetros da tela não entram no SQL sem validação', () => {
  assert.throws(() => C.cleanParams({ coligada: '7; DROP TABLE X' }), /coligada/);
  assert.throws(() => C.cleanParams({ coligada: 7, periods: "2030'); DELETE FROM SALUNO --" }), /Período letivo inválido/);
  assert.deepEqual(C.cleanParams({ coligada: '7', periods: '2030;2031 2030' }), { coligada: 7, periods: ['2030', '2031'] });
});

test('código das consultas temporárias: ZMV.*, até 16 caracteres, único e igual ao extrator em Python', () => {
  const codes = C.SYSTEMS.educacional.tables.map((t) => C.consultaCode(t.table));
  assert.equal(new Set(codes).size, codes.length);
  for (const c of codes) assert.ok(C.CODE_RE.test(c) && c.length <= 16, c);
  assert.equal(C.consultaCode('SHABILITACAOFILIAL'), 'ZMV.SHABILI_DF5F');
  assert.equal(C.consultaCode('SFREQUENCIA'), 'ZMV.SFREQUENCIA');
});

test('trava de SELECT: bloqueia escrita e mais de um comando, ignora textos e comentários', () => {
  assert.ok(C.checkSelect("SELECT 'DELETE' AS X -- UPDATE\nFROM T"));
  assert.throws(() => C.checkSelect('SELECT 1; DELETE FROM T'), /DELETE|mais de um/);
  assert.throws(() => C.checkSelect('UPDATE T SET A = 1'), /começar com SELECT/);
  assert.throws(() => C.checkSelect('SELECT * INTO NOVA FROM T'), /INTO/);
});

test('SQL gerado para a base passa pela trava (drop/create/insert só no formato esperado)', () => {
  assert.ok(SQLM.assertGenerated('drop', 'DROP TABLE IF EXISTS [dbo].[SALUNO]'));
  assert.ok(SQLM.assertGenerated('create', 'CREATE TABLE [dbo].[SALUNO] ([RA] NVARCHAR(50) NULL, [NOME] NVARCHAR(MAX) NULL)'));
  assert.ok(SQLM.assertGenerated('insert', 'INSERT INTO [dbo].[SALUNO] ([RA], [NOME]) VALUES (@lv0, @lv1), (@lv2, @lv3)'));
  assert.throws(() => SQLM.assertGenerated('drop', 'DROP TABLE IF EXISTS [dbo].[SALUNO]; DROP DATABASE X'), /trava/);
  assert.throws(() => SQLM.assertGenerated('drop', 'DROP TABLE [dbo].[ZMIGRA_SALUNO]'), /trava/);
  assert.equal(SQLM.csvCell('a;b'), '"a;b"');
});

test('complemento: só as linhas do TXT cuja chave não está no RM (bytes, quebra, coligada e filtro preservados)', () => {
  const def = C.SYSTEMS.educacional.complement.find((k) => k.txt === 'SNOTAETAPAS_FALTAS');
  // posições da chave [7,5,9,8,10,11,12] = RA, CODFILIAL, CODPERLET, CODTURMA, CODDISC, CODETAPA, TIPOETAPA
  const linha = (ra) => { const f = Array(14).fill(''); [f[7], f[5], f[9], f[8], f[10], f[11], f[12]] = [ra, '3', '2030', 'T1', 'MAT', '1', 'F']; return f.join(';'); };
  const l1 = linha('000123'); const l2 = linha('000124');
  const txt = Buffer.from(`${l1}\r\n${l2}\r\nAção;\r\n`, 'latin1');
  const rows = [
    { RA: '123', CODFILIAL: 3, CODPERLET: '2030', CODTURMA: 'T1', CODDISC: 'MAT', CODETAPA: '1', TIPOETAPA: 'F', CODCOLIGADA: 7 },
    { RA: '124', CODFILIAL: 3, CODPERLET: '2030', CODTURMA: 'T1', CODDISC: 'MAT', CODETAPA: '1', TIPOETAPA: 'F', CODCOLIGADA: 9 }, // outra coligada: não conta
  ];
  const r = C.computeComplement(def, txt, rows, 7);
  assert.equal(r.txtLines, 3);
  assert.equal(r.inRm, 1);
  assert.equal(r.toLoad, 2);
  assert.equal(r.content.toString('latin1'), `${l2}\r\nAção;\r\n`);
  const notas = C.SYSTEMS.educacional.complement.find((k) => k.txt === 'SNOTAETAPA'); // filtro TIPOETAPA=N: as faltas (F) ficam fora
  assert.equal(C.computeComplement(notas, txt, rows, 7).inRm, 0);
  assert.equal(C.norm('8.0'), '8'); assert.equal(C.norm('07:00:00'), '07:00'); assert.equal(C.norm('02/03/2030'), '2030-03-02'); assert.equal(C.norm('001307057'), '1307057');
});

// ---------- Cliente do RM (RM simulado) ----------
test('RM: ciclo criar → executar → apagar, com releitura e foto inalterada', async () => {
  fake.consultas.clear(); fake.ops.length = 0;
  const before = await RM.snapshot(RMCONN);
  const r = await RM.extract(RMCONN, { table: 'STURMA', code: 'ZMV.STURMA', sentence: 'SELECT CODCOLIGADA, CODTURMA, NOME\nFROM STURMA\nWHERE STURMA.CODCOLIGADA = 7', coligada: 7 });
  assert.equal(r.rows.length, 2);
  assert.equal(fake.consultas.size, 0, 'a consulta temporária foi apagada');
  assert.deepEqual([...(await RM.snapshot(RMCONN))], [...before]);
  assert.deepEqual(fake.ops.filter((o) => o !== 'ReadRecord'), ['ReadView', 'SaveRecord', 'GET ZMV.STURMA', 'DeleteRecordByKey', 'ReadView']);
});

test('RM: falha ao executar ainda apaga a consulta; erro do RM com HTTP 200 (SOAP Fault) aparece', async () => {
  fake.consultas.clear(); fake.restFail = true;
  await assert.rejects(RM.extract(RMCONN, { table: 'STURMA', code: 'ZMV.STURMA', sentence: 'SELECT 1 AS X', coligada: 7 }), /HTTP 500/);
  fake.restFail = false;
  assert.equal(fake.consultas.size, 0);
  await assert.rejects(RM.soap(RMCONN, 'GetSchema', { DataServerName: 'X' }), /RM: operação GetSchema não simulada/);
});

test('RM: escrita travada (código, marcador, usuário) e operações de escrita fora da porta única', async () => {
  fake.consultas.clear();
  await assert.rejects(RM.write(RMCONN, 'SaveRecord', { code: 'CONSULTA.CLIENTE', table: 'X', sentence: 'SELECT 1' }), /fora do padrão/);
  await assert.rejects(RM.soap(RMCONN, 'DeleteRecordByKey', { PrimaryKey: '0;S;QUALQUER' }), /bloqueada/);
  await assert.rejects(RM.write(RMCONN, 'DeleteRecord', { code: 'ZMV.X' }), /bloqueada/);
  fake.consultas.set('ZMV.ALHEIA', { code: 'ZMV.ALHEIA', title: 'Consulta do cliente', sentence: 'SELECT 1', user: 'integracao' });
  await assert.rejects(RM.write(RMCONN, 'DeleteRecordByKey', { code: 'ZMV.ALHEIA' }), /não é desta ferramenta/);
  fake.consultas.set('ZMV.OUTRO', { code: 'ZMV.OUTRO', title: `${C.MARKER} X`, sentence: 'SELECT 1', user: 'outra.pessoa' });
  await assert.rejects(RM.write(RMCONN, 'DeleteRecordByKey', { code: 'ZMV.OUTRO' }), /outro usuário/);
  await assert.rejects(RM.extract(RMCONN, { table: 'ALHEIA', code: 'ZMV.ALHEIA', sentence: 'SELECT 1', coligada: 7 }), /não é desta ferramenta: nada foi feito/);
  assert.ok(fake.consultas.has('ZMV.ALHEIA') && fake.consultas.has('ZMV.OUTRO'), 'consultas que não são da ferramenta ficam intactas');
  // sobra da própria ferramenta (mesmo usuário): apagada antes de recriar
  fake.consultas.set('ZMV.STURMA', { code: 'ZMV.STURMA', title: `${C.MARKER} STURMA`, sentence: 'SELECT 0', user: 'integracao' });
  const r = await RM.extract(RMCONN, { table: 'STURMA', code: 'ZMV.STURMA', sentence: 'SELECT 1 AS X', coligada: 7 });
  assert.equal(r.rows.length, 2); assert.ok(!fake.consultas.has('ZMV.STURMA'));
  assert.throws(() => RM.cleanUrl('https://rm.exemplo.test:8051/caminho'), /sem caminho/);
  assert.equal(RM.cleanUrl('https://rm.exemplo.test:8051/'), 'https://rm.exemplo.test:8051');
  await assert.rejects(RM.snapshot({ ...RMCONN, password: 'errada' }), /401/);
  fake.consultas.clear();
});

test('RM: timeout NÃO repete a consulta; só repete quando o pedido nem chegou ao RM', async () => {
  fake.ops.length = 0; fake.hang = true;
  await assert.rejects(RM.execute(RMCONN, 'ZMV.STURMA', 7, 'S', { timeoutMs: 300, sleep: async () => { throw new Error('não devia repetir'); } }), /NÃO foi repetida/);
  fake.hang = false;
  assert.equal(fake.ops.filter((o) => o === 'GET ZMV.STURMA').length, 1, 'uma única chamada');
  // porta fechada (conexão recusada): o pedido não chegou ao RM → até 3 tentativas
  const net = require('net'); const srv = net.createServer(); await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port; await new Promise((r) => srv.close(r));
  let sleeps = 0;
  await assert.rejects(RM.execute({ ...RMCONN, url: `http://127.0.0.1:${port}` }, 'ZMV.STURMA', 7, 'S', { sleep: async () => { sleeps++; } }), /após 3 tentativas/);
  assert.equal(sleeps, 2);
  assert.ok(RM.NOT_SENT.has('ECONNREFUSED') && !RM.NOT_SENT.has('ECONNRESET'), 'conexão derrubada no meio não repete');
});

test('partes: contagem, faixas e sentenças sobre a consulta do modelo (todas as tabelas, colunas únicas)', () => {
  const s = C.systemOf('educacional');
  for (const t of s.tables) {
    const sql = C.renderRm(t, { coligada: 7, periods: '2030' });
    const cols = C.outputColumns(sql);
    assert.equal(new Set(cols).size, cols.length, `${t.table}: colunas repetidas impedem a tabela derivada`);
    const col = C.partColumnOf(s, t.table);
    if (col) assert.ok(cols.includes(col), `${t.table}: coluna de divisão ${col} precisa sair na consulta`);
    assert.ok(C.checkSelect(C.statsSql(sql, col)));
  }
  assert.deepEqual(C.outputColumns("SELECT A.X, CONVERT(VARCHAR(10), A.D, 23) AS D, B.[Y]\nFROM A JOIN (SELECT 1 AS Z FROM C) B ON 1 = 1"), ['X', 'D', 'Y']);
  const L = { rowsPerPart: 100, bigTable: 1000, maxParts: 500 };
  assert.deepEqual(C.planParts({ N: 100, NN: 100, LO: 1, HI: 100 }, 'ID', L), [{ kind: 'all' }], 'pequena: uma parte');
  assert.deepEqual(C.planParts({ N: 900 }, null, L), [{ kind: 'all' }], 'sem coluna: uma parte');
  assert.deepEqual(C.planParts({ N: 250, NN: 250, LO: 'A', HI: 'Z' }, 'ID', L), [{ kind: 'all' }], 'valores não inteiros: uma parte');
  assert.deepEqual(C.planParts({ N: 251, NN: 250, LO: 1, HI: 300 }, 'ID', L), [{ kind: 'range', lo: 1, hi: 100 }, { kind: 'range', lo: 101, hi: 200 }, { kind: 'range', lo: 201, hi: 300 }, { kind: 'null' }]);
  assert.equal(C.planParts({ N: 1e9, NN: 1e9, LO: 1, HI: 1e9 }, 'ID', L).length, 500, 'limite de partes');
  assert.equal(C.partSql('SELECT ID FROM T', 'ID', { kind: 'range', lo: 1, hi: 9 }), 'SELECT * FROM (\nSELECT ID FROM T\n) AS Q WHERE Q.[ID] BETWEEN 1 AND 9');
  assert.equal(C.partSql('SELECT ID FROM T', 'ID', { kind: 'all' }), 'SELECT ID FROM T');
  assert.throws(() => C.partSql('SELECT ID FROM T', 'ID]; DROP', { kind: 'null' }), /inválida/);
  assert.throws(() => C.partSql('SELECT ID FROM T', 'ID', { kind: 'range', lo: '1 OR 1=1', hi: 2 }), /inválida/);
});

// ---------- API (SQL Server simulado) ----------
const sim = { calls: [], current: { STURMA: 5, SFREQUENCIA: null } };
db.runWorker = async (op, args, opts = {}) => {
  sim.calls.push({ op, input: args.input, password: args.password });
  const id = { server: 'SRV', database: 'BASE_TESTE', login: 'migracao', version: 'teste' };
  if (op === 'tool:lv-precheck') return { identity: id, canCreate: true, canAlter: true, canInsert: true, canSelect: true, rm: Object.fromEntries(args.input.rmTables.map((t) => [t, sim.current[t] ?? null])), src: Object.fromEntries(args.input.sourceTables.map((t) => [t, 3])) };
  if (op === 'tool:lv-dump') { fs.writeFileSync(args.input.file, 'X\r\n'); return { rows: sim.current[args.input.table] || 0 }; }
  if (op === 'tool:lv-replace') { const d = JSON.parse(fs.readFileSync(args.input.rowsFile, 'utf8')); assert.ok(args.input.allowed.includes(args.input.table)); opts.onProgress && opts.onProgress(d.rows.length, d.rows.length); return { rows: d.rows.length }; }
  if (op === 'tool:lv-validate') return args.input.items.map((i) => ({ label: i.label, source: i.source, carga: 3, missing: 0, file: null }));
  if (op === 'tool:lv-keys') return { rows: [{ CODFILIAL: 3, CODPERLET: '2030', CODTURMA: 'T1', CODCOLIGADA: 7 }] };
  throw new Error(`op inesperada ${op}`);
};
db.assertReachable = async () => {};

const base = `http://localhost:${PORT}`;
const api = async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Origin: base }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const B = '/api/tools/load-validator';
async function waitJob(id) {
  for (let i = 0; i < 1200; i++) { const j = (await api('GET', `${B}/jobs/${id}`)).json; if (j.status !== 'running') return j; await new Promise((r) => setTimeout(r, 100)); } // até 2 min (suíte inteira em paralelo + DPAPI)
  throw new Error('trabalho não terminou');
}

test('API: conexão do RM com senha DPAPI (nunca devolvida), registro na lista de ferramentas', async () => {
  const tools = (await api('GET', '/api/tools')).json;
  assert.ok(tools.some((t) => t.id === 'load-validator'));
  const bad = await api('POST', `${B}/rm`, { name: 'RM', url: 'ftp://x', user: 'u', password: 'p' });
  assert.equal(bad.status, 400);
  const c = (await api('POST', `${B}/rm`, { name: 'RM Cliente Alfa', url: RMCONN.url, user: 'integracao', password: 'senha-ficticia' })).json;
  assert.equal(c.hasPassword, true); assert.equal(c.password, undefined); assert.equal(c.passwordEnc, undefined);
  const saved = store.data.tools.loadValidator.rm.find((x) => x.id === c.id);
  assert.ok(saved.passwordEnc && !saved.passwordEnc.includes('senha-ficticia'));
  const t = (await api('POST', `${B}/rm/${c.id}/test`)).json;
  assert.equal(t.ok, true);
  const st = (await api('GET', `${B}/state`)).json;
  assert.equal(st.rm[0].passwordEnc, undefined);
  assert.equal(st.systems.find((s) => s.id === 'folha').ready, false);
});

const conferir = async (req) => { const r = await api('POST', `${B}/precheck`, req); assert.equal(r.status, 200, JSON.stringify(r.json)); const j = await waitJob(r.json.jobId); assert.equal(j.status, 'done', JSON.stringify(j)); return j.result.plan; };
// Cada consulta no RM é um ciclo completo antes da próxima começar: SaveRecord → GET → DeleteRecordByKey, sem sobreposição.
const sequentialCycles = (ops) => {
  const w = ops.filter((o) => o === 'SaveRecord' || o.startsWith('GET ') || o === 'DeleteRecordByKey');
  for (let i = 0; i < w.length; i += 3) if (w[i] !== 'SaveRecord' || !String(w[i + 1]).startsWith('GET ') || w[i + 2] !== 'DeleteRecordByKey') return false;
  return w.length > 0 && w.length % 3 === 0;
};

test('API: conferir (contagem no RM) → executar em partes, uma consulta por vez → RM limpo, tabela substituída, validação e resumo', async (t) => {
  fake.consultas.clear(); sim.calls.length = 0;
  // 5 linhas com IDTURMADISC 1..5 + 1 sem valor; com 2 linhas por parte: faixas 1–2, 3–4, 5–5 e a parte "sem valor" = 4 partes
  fake.rows['ZMV.SFREQUENCIA'] = [1, 2, 3, 4, 5, null].map((id, i) => ({ IDTURMADISC: id, RA: String(i), DATA: '2030-03-02', PRESENCA: 'A' }));
  const limits = { ...C.LIMITS }; C.LIMITS.rowsPerPart = 2; C.LIMITS.bigTable = 5;
  t.after(() => Object.assign(C.LIMITS, limits));
  fake.ops.length = 0;
  const conn = (await api('POST', '/api/connections', { name: 'Migração', env: 'hml', server: '192.0.2.10', auth: 'sql', user: 'migracao', password: 'senha-ficticia' })).json;
  const rmId = store.data.tools.loadValidator.rm[0].id;
  const out = fs.mkdtempSync(path.join(tmp, 'saida-'));
  const req = { system: 'educacional', rmId, connectionId: conn.id, database: 'BASE_TESTE', coligada: 7, periods: '2030', tables: ['STURMA', 'SFREQUENCIA'], outDir: out };
  assert.equal((await api('POST', `${B}/precheck`, { ...req, periods: "2030'--" })).status, 400);
  assert.equal((await api('POST', `${B}/precheck`, { ...req, tables: ['ZMIGRA_SALUNO'] })).status, 400);
  const plan = await conferir(req);
  assert.equal(plan.canExecute, true);
  assert.deepEqual(plan.tables.map((x) => [x.table, x.code, x.current, x.rmRows, x.parts]), [['STURMA', 'ZMV.STURMA', 5, 2, 1], ['SFREQUENCIA', 'ZMV.SFREQUENCIA', null, 6, 4]]);
  assert.ok(plan.warnings.some((w) => /SFREQUENCIA: tabela grande \(6 linhas\), extraída em 4 partes/.test(w)), plan.warnings.join(' | '));
  assert.equal(fake.consultas.size, 0, 'as consultas de contagem foram apagadas');
  assert.ok(sequentialCycles(fake.ops), `conferência: uma consulta por vez (${fake.ops.join(', ')})`);
  fake.ops.length = 0; fake.sentences.length = 0;
  const noAuth = await api('POST', `${B}/plans/${plan.planId}/execute`, { hash: plan.hash });
  assert.equal(noAuth.json.code, 'LV_NOT_AUTHORIZED');
  const ask = await api('POST', `${B}/plans/${plan.planId}/execute`, { hash: plan.hash, authorized: true });
  assert.equal(ask.status, 409); assert.equal(ask.json.code, 'LV_CONFIRM'); assert.match(ask.json.error, /SUBSTITUIR 2 tabela/); assert.match(ask.json.error, /5 consulta\(s\) temporária\(s\) ZMV\.\*, uma por vez/);
  const go = await api('POST', `${B}/plans/${plan.planId}/execute`, { hash: plan.hash, authorized: true, confirmed: true });
  const job = await waitJob(go.json.jobId);
  assert.equal(job.status, 'done', JSON.stringify(job.log));
  assert.equal(fake.consultas.size, 0, 'nenhuma consulta temporária ficou no RM');
  assert.deepEqual(job.result.snapshot.leftovers, []);
  assert.deepEqual(job.result.extraction.map((e) => [e.table, e.rows]), [['STURMA', 2], ['SFREQUENCIA', 6]]);
  assert.equal(fake.ops.filter((o) => o === 'GET ZMV.SFREQUENCIA').length, 4, 'SFREQUENCIA em 4 partes');
  assert.ok(sequentialCycles(fake.ops), `execução: uma consulta por vez (${fake.ops.join(', ')})`);
  assert.deepEqual(fake.sentences.filter((s) => s.includes('SFREQUENCIA')).map((s) => (s.match(/WHERE Q\.\[IDTURMADISC\] (.*)$/) || [])[1]), ['BETWEEN 1 AND 2', 'BETWEEN 3 AND 4', 'BETWEEN 5 AND 5', 'IS NULL']);
  const ops = sim.calls.map((c) => c.op);
  assert.ok(ops.includes('tool:lv-dump'), 'cópia da tabela atual antes de substituir');
  assert.equal(ops.filter((o) => o === 'tool:lv-dump').length, 1, 'só a tabela que existia é copiada');
  assert.ok(fs.existsSync(path.join(job.result.dir, 'RESUMO.txt')));
  assert.match(fs.readFileSync(path.join(job.result.dir, 'RESUMO.txt'), 'utf8'), /STURMA\s+2\s+gravada/);
  assert.equal((await api('POST', `${B}/plans/${plan.planId}/execute`, { hash: plan.hash, authorized: true, confirmed: true })).json.code, 'LV_PLAN_EXPIRED', 'plano de uso único');
  assert.ok(!fs.readdirSync(os.tmpdir()).some((f) => f.startsWith('gp-lv-') && fs.existsSync(path.join(os.tmpdir(), f, 'STURMA.json'))), 'dados do RM em trânsito apagados');
});

test('API: só validar e gerar complemento (só leitura na base, arquivos numa pasta nova)', async () => {
  const conn = store.data.connections[0];
  const out = fs.mkdtempSync(path.join(tmp, 'saida-'));
  const v = await waitJob((await api('POST', `${B}/validate`, { system: 'educacional', connectionId: conn.id, database: 'BASE_TESTE', tables: ['STURMA'], outDir: out })).json.jobId);
  assert.equal(v.status, 'done'); assert.equal(v.result.validation[0].missing, 0);
  const txtDir = fs.mkdtempSync(path.join(tmp, 'txt-'));
  const f = (fil, perlet, turma) => { const a = Array(10).fill(''); a[5] = fil; a[7] = perlet; a[8] = turma; return a.join(';'); };
  fs.writeFileSync(path.join(txtDir, 'STURMA.txt'), `${f('3', '2030', 'T1')}\r\n${f('3', '2030', 'T2')}\r\n`);
  const c = await waitJob((await api('POST', `${B}/complement`, { system: 'educacional', connectionId: conn.id, database: 'BASE_TESTE', coligada: 7, txtDir, outDir: out })).json.jobId);
  assert.equal(c.status, 'done', JSON.stringify(c));
  const row = c.result.rows.find((r) => r.table === 'STURMA');
  assert.deepEqual([row.inRm, row.txtLines, row.toLoad], [1, 2, 1]);
  assert.equal(fs.readFileSync(path.join(c.result.dir, 'STURMA.txt'), 'utf8'), `${f('3', '2030', 'T2')}\r\n`);
  assert.equal(c.result.rows.find((r) => r.table === 'SALUNO').status, 'SEM TXT');
  assert.ok(sim.calls.filter((x) => x.op === 'tool:lv-replace').length === 2, 'complemento e validação não gravam na base');
});

test('API: dados do RM mudaram depois da conferência → a tabela não é gravada (a contagem tem de bater)', async () => {
  fake.consultas.clear(); sim.calls.length = 0;
  const conn = store.data.connections[0];
  const rmId = store.data.tools.loadValidator.rm[0].id;
  const out = fs.mkdtempSync(path.join(tmp, 'saida-'));
  const plan = await conferir({ system: 'educacional', rmId, connectionId: conn.id, database: 'BASE_TESTE', coligada: 7, periods: '', tables: ['STURMA'], outDir: out });
  assert.equal(plan.tables[0].rmRows, 2);
  fake.rows['ZMV.STURMA'].push({ CODCOLIGADA: 7, CODTURMA: 'T3', NOME: 'nova' });
  try {
    const go = await api('POST', `${B}/plans/${plan.planId}/execute`, { hash: plan.hash, authorized: true, confirmed: true });
    const job = await waitJob(go.json.jobId);
    assert.match(job.result.extraction[0].status, /NÃO GRAVADA.*os dados mudaram desde a conferência/);
    assert.equal(sim.calls.filter((x) => x.op === 'tool:lv-replace').length, 0, 'nada foi gravado na base');
    assert.equal(fake.consultas.size, 0);
  } finally { fake.rows['ZMV.STURMA'].pop(); }
});

// ---------- Gravação na base: em massa (bulk) com plano B (INSERT em lotes), driver simulado ----------
function fakeDriver({ failBulk = false } = {}) {
  const log = []; let rows = 0;
  class Transaction { async begin() { log.push('BEGIN'); } async commit() { log.push('COMMIT'); } async rollback() { log.push('ROLLBACK'); rows = 0; } }
  class Table { constructor(name) { this.name = name; this.columns = { list: [], add: (n, t, o) => this.columns.list.push({ n, t, o }) }; this.rows = []; this.rows.add = (...v) => this.rows.push(v); } }
  class Request {
    input() { return this; }
    async batch(sql) { log.push(sql.split(' (')[0]); if (/^DROP/.test(sql)) rows = 0; }
    async query(sql) { if (/COUNT_BIG/.test(sql)) return { recordset: [{ n: rows }] }; log.push('INSERT'); rows += (sql.match(/\(@lv/g) || []).length; return {}; }
    async bulk(t) { log.push(`BULK ${t.name} ${t.rows.length}`); if (failBulk) throw new Error('bulk não suportado'); rows += t.rows.length; }
  }
  const h = { sql: { Transaction, Table, Request, NVarChar: (n) => ({ n }), MAX: 'MAX' }, pool: {} };
  const core = { withPool: (c, p, fn) => fn(h), identity: async () => ({ database: 'BASE' }), friendly: (e) => e.message };
  return { core, log };
}

test('base: gravação em massa por padrão e plano B (lotes) quando o bulk é recusado, sempre numa transação', async () => {
  const file = path.join(tmp, 'rows.json');
  const data = { columns: ['RA', 'NOME'], rows: Array.from({ length: 45001 }, (_, i) => [String(i), i % 7 ? `N${i}` : null]) };
  fs.writeFileSync(file, JSON.stringify(data));
  const ctx = { progress: () => {}, isCancelled: () => false };
  const conn = { database: 'BASE' };
  const ok = fakeDriver();
  const r1 = await SQLM.replace(ok.core, conn, '', { table: 'SALUNO', rowsFile: file, allowed: ['SALUNO'] }, ctx);
  assert.deepEqual([r1.rows, r1.mode], [45001, 'bulk']);
  assert.deepEqual(ok.log.filter((x) => x.startsWith('BULK')), ['BULK [dbo].[SALUNO] 20000', 'BULK [dbo].[SALUNO] 20000', 'BULK [dbo].[SALUNO] 5001'], 'blocos de 20 mil');
  assert.ok(ok.log.includes('COMMIT') && !ok.log.includes('INSERT'));
  const bad = fakeDriver({ failBulk: true });
  const r2 = await SQLM.replace(bad.core, conn, '', { table: 'SALUNO', rowsFile: file, allowed: ['SALUNO'] }, ctx);
  assert.deepEqual([r2.rows, r2.mode, r2.bulkError], [45001, 'insert', 'bulk não suportado']);
  assert.deepEqual(bad.log.slice(0, 6), ['BEGIN', 'SET XACT_ABORT ON;', 'DROP TABLE IF EXISTS [dbo].[SALUNO]', 'CREATE TABLE [dbo].[SALUNO]', 'BULK [dbo].[SALUNO] 20000', 'ROLLBACK'], 'bulk recusado: transação desfeita antes do plano B');
  assert.equal(bad.log.filter((x) => x === 'COMMIT').length, 1);
  const forced = fakeDriver();
  assert.equal((await SQLM.replace(forced.core, conn, '', { table: 'SALUNO', rowsFile: file, allowed: ['SALUNO'], forceInsert: true }, ctx)).mode, 'insert');
  assert.ok(!forced.log.some((x) => x.startsWith('BULK')));
  await assert.rejects(SQLM.replace(ok.core, conn, '', { table: 'SALUNO', rowsFile: file, allowed: ['SALUNO'] }, { progress: () => {}, isCancelled: () => true }), /Cancelado/);
  await assert.rejects(SQLM.replace(ok.core, conn, '', { table: 'ZMIGRA_X', rowsFile: file, allowed: ['SALUNO'] }, ctx), /fora da lista/);
});
