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
  assert.equal(C.systemOf('folha').ready, true);
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
  assert.throws(() => C.cleanParams({ coligada: '7; DROP TABLE X' }), /coligada/i);
  assert.throws(() => C.cleanParams({ coligadas: '1, 2) OR (1=1' }), /Coligada inválida/);
  assert.throws(() => C.cleanParams({ coligadas: '' }), /Informe a\(s\) coligada/);
  assert.throws(() => C.cleanParams({ coligadas: '40000' }), /Coligada inválida/);
  assert.throws(() => C.cleanParams({ coligadas: Array.from({ length: 51 }, (_, i) => i + 1) }), /No máximo 50/);
  assert.throws(() => C.cleanParams({ coligada: 7, periods: "2030'); DELETE FROM SALUNO --" }), /Período letivo inválido/);
  assert.deepEqual(C.cleanParams({ coligada: '7', periods: '2030;2031 2030' }), { coligada: 7, coligadas: [7], periods: ['2030', '2031'] });
  assert.deepEqual(C.cleanParams({ coligadas: '9, 2; 3 2' }), { coligada: 2, coligadas: [2, 3, 9], periods: [] }, 'ordenadas e sem repetição');
});

test('várias coligadas: "= n" ou "IN (...)" no RM (SQL comum) e filtro na validação da base só quando a carga tem CODCOLIGADA', () => {
  for (const id of ['educacional', 'folha']) {
    for (const t of C.systemOf(id).tables) {
      const one = C.renderRm(t, { coligadas: '2', periods: '' });
      const many = C.renderRm(t, { coligadas: '1, 2, 5', periods: '' });
      if (t.rmSql.includes('{{CODCOLIGADA}}')) { // PPESSOA (Educacional) é global: sem filtro de coligada
        assert.match(one, /CODCOLIGADA = 2\b/, t.table); assert.doesNotMatch(one, /\bIN \(1, 2, 5\)/);
        assert.match(many, /CODCOLIGADA IN \(1, 2, 5\)/, t.table); assert.doesNotMatch(many, /= 2\b/);
      } else assert.equal(one, many, t.table);
      for (const v of t.validations) {
        const s = C.scopeValidation(v.sql, C.sourceOf(v.sql), [1, 2]);
        assert.ok(checkReadOnly(s).ok, v.label);
        assert.match(s, new RegExp(String.raw`\nWHERE \([\s\S]+\)\n  AND TRY_CAST\(\[${C.sourceOf(v.sql)}\]\.\[CODCOLIGADA\] AS INT\) IN \(1, 2\)(\n|$)`), v.label);
        if (/ORDER BY/i.test(v.sql)) assert.match(s, /ORDER BY[^\n]*$/, `${v.label}: ORDER BY continua no fim`);
      }
    }
  }
  assert.equal(C.allRowsSql('ZMIGRA_PFHSTSAL', [2]), 'SELECT [ZMIGRA_PFHSTSAL].* FROM [ZMIGRA_PFHSTSAL]\nWHERE TRY_CAST([ZMIGRA_PFHSTSAL].[CODCOLIGADA] AS INT) IN (2)');
  assert.throws(() => C.scopeValidation('SELECT 1', 'X;DROP', [1]), /inválida/);
  assert.throws(() => C.coligadaWhere('ZMIGRA_X', ['1) OR (1=1']), /Coligada inválida/);
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
  assert.equal(C.partSql('SELECT ID FROM T', 'ID', { kind: 'range', lo: 1, hi: 9 }), 'SELECT * FROM (\nSELECT ID FROM T\n) Q WHERE Q.ID BETWEEN 1 AND 9');
  assert.equal(C.statsSql('SELECT ID FROM T', 'ID'), 'SELECT COUNT(*) AS N, COUNT(Q.ID) AS NN, MIN(Q.ID) AS LO, MAX(Q.ID) AS HI FROM (\nSELECT ID FROM T\n) Q', 'SQL comum a SQL Server e Oracle');
  assert.throws(() => C.statsSql('SELECT ID FROM T', 'id; DROP'), /inválida/);
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
  // validação simulada: devolve o que recebeu (coligadas, rmEmpty, skip) para os testes conferirem a ligação com a api
  if (op === 'tool:lv-validate') return args.input.items.map((i) => (i.skip ? { label: i.label, source: i.source, error: i.skip, skipped: true }
    : { label: i.label, source: i.source, carga: 3, missing: i.rmEmpty ? 3 : 0, file: null, rmEmpty: !!i.rmEmpty, scoped: !!args.input.coligadas,
      byColigada: args.input.coligadas ? args.input.coligadas.map((c) => ({ coligada: c, carga: c === args.input.coligadas[0] ? 3 : 0, missing: i.rmEmpty && c === args.input.coligadas[0] ? 3 : 0 })) : null }));
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
  const fo = st.systems.find((s) => s.id === 'folha');
  assert.deepEqual([fo.ready, fo.usesPeriods, fo.complementReady, fo.tables.length], [true, false, false, 14]);
  assert.deepEqual([st.systems[0].usesPeriods, st.systems[0].complementReady], [true, true]);
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
  assert.deepEqual(fake.sentences.filter((s) => s.includes('SFREQUENCIA')).map((s) => (s.match(/WHERE Q\.IDTURMADISC (.*)$/) || [])[1]), ['BETWEEN 1 AND 2', 'BETWEEN 3 AND 4', 'BETWEEN 5 AND 5', 'IS NULL']);
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

test('RM: a lista de consultas pede só as ZMV.* (leve para o RM.Host) e OutOfMemory do RM ganha orientação', async () => {
  fake.consultas.clear(); fake.filters.length = 0;
  fake.consultas.set('CLIENTE.01', { code: 'CLIENTE.01', title: 'Consulta do cliente', sentence: 'SELECT 1', user: 'outra.pessoa' });
  fake.consultas.set('ZMV.SOBRA', { code: 'ZMV.SOBRA', title: `${C.MARKER} X`, sentence: 'SELECT 1', user: 'integracao' });
  const snap = [...(await RM.snapshot(RMCONN))];
  assert.equal(fake.filters[0], "GCONSSQL.CODCOLIGADA = 0 AND GCONSSQL.CODSENTENCA LIKE 'ZMV.%'");
  assert.deepEqual(snap.map((k) => k.split('|')[2]), ['ZMV.SOBRA'], 'consultas do cliente nem são lidas');
  fake.consultas.clear();
  // erro real visto em 06/11/2026 (SOAP Fault do RM.Host sem memória)
  const http = require('http');
  const srv = http.createServer((q, s) => { s.writeHead(200); s.end('<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>a:InternalServiceFault</faultcode><faultstring>Ocorreu um erro ao efetuar a leitura da visão: Exception of type \'System.OutOfMemoryException\' was thrown.</faultstring></s:Fault></s:Body></s:Envelope>'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(RM.snapshot({ ...RMCONN, url: `http://127.0.0.1:${srv.address().port}` }), /OutOfMemoryException.*SEM MEMÓRIA\. Nada foi feito pela ferramenta/);
  } finally { srv.close(); }
});

// ---------- Folha (sistema P do RM): modelo gerado do "SQL - VERIFICA DIFERENÇA ENTRE RM E ORIGEM" ----------
// Sintaxe que só existe no SQL Server: nada disso pode ir ao RM pela Folha nem pela contagem/partes (RM pode ser Oracle).
const SQLSERVER_ONLY = /COUNT_BIG|\[|\)\s+AS\s+Q\b|CONVERT\(|\bTOP\s|ISNULL\(|GETDATE\(/i;

test('Folha: 14 tabelas do arquivo de origem, coligada filtrada, SQL do RM neutro (SQL Server/Oracle) e datas tratadas na base', () => {
  const s = C.systemOf('folha');
  assert.equal(s.codSistema, 'P');
  assert.deepEqual(s.tables.map((t) => t.table), ['PFDEPEND', 'PFUFERIAS', 'PFUFERIASPER', 'PFUFERIASRECIBO', 'PFUFERIASVERBAS', 'PFHSTSAL', 'PFHSTFCO', 'PFHSTSEC', 'PFHSTSIT', 'PFHSTCSD', 'PFHSTNDP', 'PFHSTAFT', 'PFPERFF', 'PFFINANC']);
  assert.deepEqual(s.complement, []);
  const codes = s.tables.map((t) => C.consultaCode(t.table));
  assert.equal(new Set(codes).size, codes.length);
  for (const t of s.tables) {
    const sql = C.renderRm(t, { coligada: 7, periods: '' });
    assert.match(sql, /\nWHERE CODCOLIGADA = 7$/, `${t.table}: coligada filtrada`);
    const cols = C.outputColumns(sql);
    assert.equal(new Set(cols).size, cols.length, t.table);
    assert.doesNotMatch(sql, SQLSERVER_ONLY, `${t.table}: consulta do RM com sintaxe só de SQL Server`);
    for (const v of t.validations) {
      assert.ok(checkReadOnly(v.sql).ok, v.label);
      assert.equal(C.sourceOf(v.sql), `ZMIGRA_${t.table}`, v.label);
      assert.ok(!v.sql.includes(`FORMAT(${t.table}.`), `${t.table}: FORMAT direto sobre texto falharia`);
      assert.doesNotMatch(v.sql, new RegExp(String.raw`CAST\(${t.table}\.\w+ AS DATE\)`), `${t.table}: CAST direto falharia com o fuso da API`);
      for (const m of v.sql.matchAll(new RegExp(String.raw`CAST\(LEFT\(${t.table}\.(\w+), 10\) AS DATE\)`, 'g'))) assert.ok(cols.includes(m[1]), `${t.table}.${m[1]} usada como data mas não vem do RM`);
    }
    const col = C.partColumnOf(s, t.table);
    if (col) {
      assert.ok(cols.includes(col), `${t.table}: coluna de divisão ${col}`);
      assert.doesNotMatch(C.statsSql(sql, col), SQLSERVER_ONLY);
      assert.doesNotMatch(C.partSql(sql, col, { kind: 'range', lo: 2020, hi: 2021 }), SQLSERVER_ONLY);
      assert.doesNotMatch(C.partSql(sql, col, { kind: 'null' }), SQLSERVER_ONLY);
    } else assert.doesNotMatch(C.statsSql(sql, null), SQLSERVER_ONLY);
  }
  assert.equal(s.tables.find((t) => t.table === 'PFHSTNDP').validations.length, 0, 'o arquivo de origem não tem validação de PFHSTNDP');
  assert.deepEqual([C.partColumnOf(s, 'PFFINANC'), C.partColumnOf(s, 'PFPERFF'), C.partColumnOf(s, 'PFHSTSAL')], ['ANOCOMP', 'ANOCOMP', null]);
});

test('Folha: o catálogo é exatamente o que o gerador produz a partir do arquivo de origem', () => {
  // --check só compara (sem gravar) e ignora CRLF × LF do checkout do Windows
  const r = require('child_process').spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'gera-catalogo-folha.js'), '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `catalog-folha.js editado à mão ou desatualizado: rode node scripts/gera-catalogo-folha.js\n${r.stdout}${r.stderr}`);
});

test('API Folha: conferir → executar no sistema P, uma consulta por vez, PFFINANC em partes por ANOCOMP, sem complemento', async (t) => {
  fake.consultas.clear(); fake.ops.length = 0; fake.urls.length = 0; sim.calls.length = 0;
  fake.rows['ZMV.PFFINANC'] = [2021, 2022, 2023, 2024, 2025].flatMap((ano) => [1, 2].map((m) => ({ CODCOLIGADA: 7, CHAPA: '0001', ANOCOMP: ano, MESCOMP: m, NROPERIODO: 1, CODEVENTO: '001', DTPAGTO: `${ano}-0${m}-05 00:00:00`, REF: 30, VALOR: 1234.5, VALORORIGINAL: 1234.5 })));
  fake.rows['ZMV.PFHSTNDP'] = [{ CODCOLIGADA: 7, CHAPA: '0001', DTMUDANCA: '2024-01-01 00:00:00', NRODEPENDIRRF: 1, NRODEPENDSALFAM: 0 }];
  const limits = { ...C.LIMITS }; C.LIMITS.rowsPerPart = 4;
  t.after(() => Object.assign(C.LIMITS, limits));
  const conn = store.data.connections[0];
  const rmId = store.data.tools.loadValidator.rm[0].id;
  const out = fs.mkdtempSync(path.join(tmp, 'saida-'));
  const plan = await conferir({ system: 'folha', rmId, connectionId: conn.id, database: 'BASE_TESTE', coligada: 7, periods: '', tables: ['PFHSTNDP', 'PFFINANC'], outDir: out });
  assert.deepEqual(plan.tables.map((x) => [x.table, x.rmRows, x.parts]), [['PFHSTNDP', 1, 1], ['PFFINANC', 10, 3]]);
  assert.ok(plan.warnings.some((w) => /PFHSTNDP: o modelo não tem consulta de validação/.test(w)), plan.warnings.join(' | '));
  assert.ok(fake.urls.every((u) => /\/0\/P\?context=CODCOLIGADA%3D7$/.test(u)), `sistema P e coligada 7: ${fake.urls.join(' ')}`);
  fake.ops.length = 0; fake.sentences.length = 0;
  const go = await api('POST', `${B}/plans/${plan.planId}/execute`, { hash: plan.hash, authorized: true, confirmed: true });
  const job = await waitJob(go.json.jobId);
  assert.equal(job.status, 'done', JSON.stringify(job.log));
  assert.deepEqual(job.result.extraction.map((e) => [e.table, e.rows]), [['PFHSTNDP', 1], ['PFFINANC', 10]]);
  assert.ok(sequentialCycles(fake.ops), `uma consulta por vez (${fake.ops.join(', ')})`);
  assert.deepEqual(fake.sentences.filter((s) => s.includes('FROM PFFINANC')).map((s) => (s.match(/WHERE Q\.ANOCOMP (.*)$/) || [])[1]), ['BETWEEN 2021 AND 2022', 'BETWEEN 2023 AND 2024', 'BETWEEN 2025 AND 2025']);
  assert.equal(fake.consultas.size, 0, 'nada sobrou no RM');
  assert.deepEqual(job.result.validation.map((v) => v.label), ['PFFINANC'], 'só as tabelas com validação no modelo');
  const comp = await api('POST', `${B}/complement`, { system: 'folha', connectionId: conn.id, database: 'BASE_TESTE', coligada: 7, txtDir: out, outDir: out });
  assert.equal(comp.json.code, 'LV_NO_COMPLEMENT');
});

test('RM: teste de conexão no sistema da Folha (P) só procura ZMV.TESTE e chama a API, sem criar nada', async () => {
  fake.consultas.clear(); fake.ops.length = 0; fake.urls.length = 0;
  const r = await RM.test(RMCONN, 'P');
  assert.equal(r.ok, true);
  assert.deepEqual(fake.ops, ['ReadRecord', 'GET ZMV.TESTE']);
  assert.match(fake.urls[0], /\/ZMV\.TESTE\/0\/P$/);
  assert.equal(fake.consultas.size, 0);
  await assert.rejects(RM.test(RMCONN, 'P; X'), /Sistema inválido/);
});

test('RM sobre ORACLE (BOA LOCAÇÃO): Folha confere e extrai; sintaxe só de SQL Server recebe o ORA-00936 real e a orientação', async (t) => {
  fake.consultas.clear(); fake.ops.length = 0; sim.calls.length = 0; fake.oracle = true;
  t.after(() => { fake.oracle = false; });
  // erro real de 09/11/2026: o que a versão anterior mandava (COUNT_BIG / AS Q) é recusado e a consulta é apagada mesmo assim
  await assert.rejects(RM.extract(RMCONN, { table: 'PFHSTSAL', code: 'ZMV.PFHSTSAL', sentence: 'SELECT COUNT_BIG(*) AS N FROM (\nSELECT CHAPA FROM PFHSTSAL\n) AS Q', coligada: 2, codSistema: 'P' }),
    /HTTP 404.*ORA-00936.*ORACLE e recusou a consulta.*nada foi lido nem gravado/);
  assert.equal(fake.consultas.size, 0, 'consulta recusada também é apagada');
  // agora: contagem e extração da Folha passam no "Oracle"
  fake.rows['ZMV.PFHSTSAL'] = [{ CODCOLIGADA: 2, CHAPA: '00001', DTMUDANCA: '2024-03-05T00:00:00-03:00', MOTIVO: '01', SALARIO: 2500.1 }];
  const conn = store.data.connections[0];
  const rmId = store.data.tools.loadValidator.rm[0].id;
  const out = fs.mkdtempSync(path.join(tmp, 'saida-'));
  const plan = await conferir({ system: 'folha', rmId, connectionId: conn.id, database: 'BASE_TESTE', coligada: 2, periods: '', tables: ['PFHSTSAL'], outDir: out });
  assert.deepEqual(plan.tables.map((x) => [x.table, x.rmRows, x.parts, x.countError]), [['PFHSTSAL', 1, 1, null]]);
  assert.equal(plan.canExecute, true);
  const go = await api('POST', `${B}/plans/${plan.planId}/execute`, { hash: plan.hash, authorized: true, confirmed: true });
  const job = await waitJob(go.json.jobId);
  assert.equal(job.status, 'done', JSON.stringify(job.log));
  assert.deepEqual(job.result.extraction.map((e) => [e.table, e.rows]), [['PFHSTSAL', 1]]);
  assert.equal(fake.consultas.size, 0);
});

test('API: várias coligadas no RM e na validação; RM vazio nas coligadas = nada subiu; tabela não atualizada não é validada contra cópia antiga', async (t) => {
  fake.consultas.clear(); fake.ops.length = 0; fake.urls.length = 0; sim.calls.length = 0;
  // PFHSTSAL: RM sem linhas nas coligadas (como a BOA LOCAÇÃO em 09/11/2026) e a base com uma cópia antiga (5 linhas)
  fake.rows['ZMV.PFHSTSAL'] = [];
  fake.rows['ZMV.PFHSTFCO'] = [{ CODCOLIGADA: 1, CHAPA: '1', DTMUDANCA: '2024-01-01T00:00:00-03:00', MOTIVO: '01', CODFUNCAO: '10' }];
  sim.current.PFHSTSAL = 5; sim.current.PFHSTFCO = null;
  t.after(() => { delete sim.current.PFHSTSAL; delete sim.current.PFHSTFCO; });
  const conn = store.data.connections[0];
  const rmId = store.data.tools.loadValidator.rm[0].id;
  const out = fs.mkdtempSync(path.join(tmp, 'saida-'));
  const plan = await conferir({ system: 'folha', rmId, connectionId: conn.id, database: 'BASE_TESTE', coligadas: '2, 1, 9', periods: '', tables: ['PFHSTSAL', 'PFHSTFCO'], outDir: out });
  assert.deepEqual(plan.params.coligadas, [1, 2, 9]);
  fake.sentences.length = 0;
  const go = await api('POST', `${B}/plans/${plan.planId}/execute`, { hash: plan.hash, authorized: true, confirmed: true });
  const job = await waitJob(go.json.jobId);
  assert.equal(job.status, 'done', JSON.stringify(job.log));
  assert.ok(fake.sentences.every((s) => /WHERE CODCOLIGADA IN \(1, 2, 9\)/.test(s)), 'o RM recebe só as coligadas escolhidas');
  assert.match(job.result.extraction[0].status, /NÃO SUBSTITUÍDA.*a validação considera que nada desta carga subiu/);
  const val = sim.calls.find((c) => c.op === 'tool:lv-validate').input;
  assert.deepEqual(val.coligadas, [1, 2, 9]);
  assert.deepEqual(val.items.map((i) => [i.label, !!i.rmEmpty, !!i.skip]), [['PFHSTSAL', true, false], ['PFHSTFCO', false, false]]);
  assert.deepEqual(job.result.validation.map((v) => [v.label, v.carga, v.missing]), [['PFHSTSAL', 3, 3], ['PFHSTFCO', 3, 0]]);
  const resumo = fs.readFileSync(path.join(job.result.dir, 'RESUMO.txt'), 'utf8');
  assert.match(resumo, /coligada\(s\) 1, 2, 9/);
  assert.match(resumo, /RM sem linhas nas coligadas: nada desta carga subiu/);
  assert.match(resumo, /coligada 1\s+3\s+3\s+0\.0/);
  // erro no RM numa tabela: ela NÃO é validada (a cópia na base seria de outra hora)
  fake.consultas.clear(); sim.calls.length = 0; fake.restFail = true;
  t.after(() => { fake.restFail = false; });
  const plan2 = await (async () => { fake.restFail = false; const p = await conferir({ system: 'folha', rmId, connectionId: conn.id, database: 'BASE_TESTE', coligadas: '1', periods: '', tables: ['PFHSTFCO'], outDir: out }); fake.restFail = true; return p; })();
  const job2 = await waitJob((await api('POST', `${B}/plans/${plan2.planId}/execute`, { hash: plan2.hash, authorized: true, confirmed: true })).json.jobId);
  fake.restFail = false;
  assert.equal(job2.result.validation[0].skipped, true);
  assert.match(job2.result.validation[0].error, /NÃO VALIDADA: a tabela PFHSTFCO do RM não foi atualizada nesta execução/);
  // complemento: uma coligada por vez
  const comp = await api('POST', `${B}/complement`, { system: 'educacional', connectionId: conn.id, database: 'BASE_TESTE', coligadas: '1, 2', txtDir: out, outDir: out });
  assert.equal(comp.json.code, 'LV_ONE_COLIGADA');
});
