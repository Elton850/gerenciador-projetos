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

test('API: conferir → executar (autorização + confirmação) → RM limpo, tabela substituída, validação e resumo', async () => {
  fake.consultas.clear(); sim.calls.length = 0;
  fake.rows['ZMV.SFREQUENCIA'] = [{ RA: '1', DATA: '2030-03-02', PRESENCA: 'A' }];
  const conn = (await api('POST', '/api/connections', { name: 'Migração', env: 'hml', server: '192.0.2.10', auth: 'sql', user: 'migracao', password: 'senha-ficticia' })).json;
  const rmId = store.data.tools.loadValidator.rm[0].id;
  const out = fs.mkdtempSync(path.join(tmp, 'saida-'));
  const req = { system: 'educacional', rmId, connectionId: conn.id, database: 'BASE_TESTE', coligada: 7, periods: '2030', tables: ['STURMA', 'SFREQUENCIA'], outDir: out };
  assert.equal((await api('POST', `${B}/precheck`, { ...req, periods: "2030'--" })).status, 400);
  assert.equal((await api('POST', `${B}/precheck`, { ...req, tables: ['ZMIGRA_SALUNO'] })).status, 400);
  const plan = (await api('POST', `${B}/precheck`, req)).json;
  assert.equal(plan.canExecute, true);
  assert.deepEqual(plan.tables.map((t) => [t.table, t.code, t.current]), [['STURMA', 'ZMV.STURMA', 5], ['SFREQUENCIA', 'ZMV.SFREQUENCIA', null]]);
  const noAuth = await api('POST', `${B}/plans/${plan.planId}/execute`, { hash: plan.hash });
  assert.equal(noAuth.json.code, 'LV_NOT_AUTHORIZED');
  const ask = await api('POST', `${B}/plans/${plan.planId}/execute`, { hash: plan.hash, authorized: true });
  assert.equal(ask.status, 409); assert.equal(ask.json.code, 'LV_CONFIRM'); assert.match(ask.json.error, /SUBSTITUIR 2 tabela/);
  const go = await api('POST', `${B}/plans/${plan.planId}/execute`, { hash: plan.hash, authorized: true, confirmed: true });
  const job = await waitJob(go.json.jobId);
  assert.equal(job.status, 'done', JSON.stringify(job.log));
  assert.equal(fake.consultas.size, 0, 'nenhuma consulta temporária ficou no RM');
  assert.deepEqual(job.result.snapshot.leftovers, []);
  assert.deepEqual(job.result.extraction.map((e) => [e.table, e.rows]), [['STURMA', 2], ['SFREQUENCIA', 1]]);
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
