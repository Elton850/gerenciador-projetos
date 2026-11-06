// Teste ponta a ponta da Validação de Carga contra o SQL Server LOCAL (nunca produção) e um RM SIMULADO (test/fake-rm.js), pelo
// fluxo real da API e do processo-filho: conexão cadastrada (Windows) → conexão do RM → conferir → executar (consulta temporária
// criada/executada/apagada no RM simulado; cópia CSV da tabela atual; substituição em transação) → validar → só validar →
// complemento; e as travas: RM devolvendo 0 linhas não substitui tabela com dados. Cria o banco descartável GP_LV_TESTE e apaga só ele.
// Uso: node scripts/e2e-lv-local.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');

const DBN = 'GP_LV_TESTE';
const PORT = 4392;
const RM_PORT = 4393;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-e2e-lv-'));
process.env.PORT = String(PORT);
process.env.GP_DATA_DIR = path.join(tmp, 'data');

const sql = require('mssql/msnodesqlv8');
const { app } = require('../server');
const { createFakeRm } = require('../test/fake-rm');

const pool = (database) => new sql.ConnectionPool({ connectionString: `Driver={ODBC Driver 17 for SQL Server};Server=localhost;Database=${database};Trusted_Connection=Yes;TrustServerCertificate=Yes;` });
async function q(database, query) { const p = pool(database); await p.connect(); try { return (await p.request().batch(query)).recordset; } finally { await p.close(); } }
const drop = () => q('master', `IF DB_ID('${DBN}') IS NOT NULL BEGIN ALTER DATABASE [${DBN}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${DBN}] END`);

const base = `http://localhost:${PORT}`;
const api = async (method, url, body) => { const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Origin: base }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
const B = '/api/tools/load-validator';
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };
async function waitJob(id) { for (let i = 0; i < 600; i++) { const j = ok(await api('GET', `${B}/jobs/${id}`)); if (j.status !== 'running') return j; await new Promise((r) => setTimeout(r, 200)); } throw new Error('trabalho não terminou'); }

(async () => {
  const server = app.listen(PORT, '127.0.0.1');
  const fake = createFakeRm(); await fake.listen(RM_PORT);
  try {
    await drop();
    await q('master', `CREATE DATABASE [${DBN}]`);
    await q(DBN, `CREATE TABLE dbo.ZMIGRA_STURMA (CODPERLET varchar(10), CODFILIAL int, CODTURMA varchar(20), NOME varchar(60));
      INSERT dbo.ZMIGRA_STURMA VALUES ('2030', 3, 'T1', 'Turma 1'), ('2030', 3, 'T2', 'Turma 2'), ('2030', 7, 'T9', 'Turma 9');
      CREATE TABLE dbo.STURMA (CODTURMA varchar(20), ANTIGA int); INSERT dbo.STURMA VALUES ('VELHA', 1);
      CREATE TABLE dbo.SALUNO (RA varchar(20)); INSERT dbo.SALUNO VALUES ('1');`);
    fake.rows['ZMV.STURMA'] = [ // T9 não subiu; NOME com ; e aspas testa o CSV; IDPERLET numérico vira texto
      { CODCOLIGADA: 7, IDPERLET: 1, CODPERLET: '2030', CODFILIAL: 3, CODTURMA: 'T1', NOME: 'Turma; "1"', DTINICIAL: '2030-02-01T00:00:00', DTFINAL: null },
      { CODCOLIGADA: 7, IDPERLET: 1, CODPERLET: '2030', CODFILIAL: 3, CODTURMA: 'T2', NOME: 'Turma 2', DTINICIAL: '2030-02-01T00:00:00', DTFINAL: null },
    ];
    fake.rows['ZMV.SALUNO'] = []; // RM devolve 0 linhas: não pode substituir a SALUNO (que tem dados)

    const conn = ok(await api('POST', '/api/connections', { name: 'Local (teste)', env: 'local', server: 'localhost', auth: 'windows', database: DBN }));
    const rm = ok(await api('POST', `${B}/rm`, { name: 'RM simulado', url: `http://127.0.0.1:${RM_PORT}`, user: 'integracao', password: 'senha-ficticia' }));
    assert.equal(ok(await api('POST', `${B}/rm/${rm.id}/test`)).ok, true);
    const bt = ok(await api('POST', `${B}/base/test`, { connectionId: conn.id, database: DBN }));
    assert.equal(bt.ok, true, JSON.stringify(bt)); assert.equal(bt.canCreate, true);

    const out = fs.mkdtempSync(path.join(tmp, 'saida-'));
    const req = { system: 'educacional', rmId: rm.id, connectionId: conn.id, database: DBN, coligada: 7, periods: '2030', tables: ['SALUNO', 'STURMA'], outDir: out };
    const plan = ok(await api('POST', `${B}/precheck`, req));
    assert.deepEqual(plan.tables.map((t) => [t.table, t.current]), [['SALUNO', 1], ['STURMA', 1]]);
    assert.equal(plan.tables[1].validations[0].carga, 3);
    const go = ok(await api('POST', `${B}/plans/${plan.planId}/execute`, { hash: plan.hash, authorized: true })); // local: sem confirmação extra
    const job = await waitJob(go.jobId);
    assert.equal(job.status, 'done', job.log.join('\n'));
    assert.equal(fake.consultas.size, 0, 'nenhuma consulta temporária ficou no RM');
    const ex = Object.fromEntries(job.result.extraction.map((e) => [e.table, e]));
    assert.match(ex.SALUNO.status, /NÃO SUBSTITUÍDA: o RM devolveu 0 linhas/);
    assert.match(ex.STURMA.status, /gravada: 2 linhas \(substituiu a anterior\)/);
    assert.deepEqual((await q(DBN, 'SELECT COUNT(*) AS n FROM dbo.SALUNO'))[0].n, 1, 'SALUNO intacta');
    const st = await q(DBN, 'SELECT CODTURMA, NOME, IDPERLET, DTFINAL FROM dbo.STURMA ORDER BY CODTURMA');
    assert.deepEqual(st.map((r) => [r.CODTURMA, r.NOME, r.IDPERLET, r.DTFINAL]), [['T1', 'Turma; "1"', '1', null], ['T2', 'Turma 2', '1', null]]);
    const cols = await q(DBN, "SELECT name, TYPE_NAME(user_type_id) AS t FROM sys.columns WHERE object_id = OBJECT_ID('dbo.STURMA') ORDER BY column_id");
    assert.deepEqual(cols.map((c) => c.name), ['CODCOLIGADA', 'IDPERLET', 'CODPERLET', 'CODFILIAL', 'CODTURMA', 'NOME', 'DTINICIAL', 'DTFINAL']);
    assert.ok(cols.every((c) => c.t === 'nvarchar'));
    const bk = fs.readdirSync(path.join(job.result.dir, 'backup'));
    assert.equal(bk.length, 1); assert.match(fs.readFileSync(path.join(job.result.dir, 'backup', bk[0]), 'utf8'), /CODTURMA;ANTIGA\r\nVELHA;1/);
    const v = job.result.validation.find((x) => x.label === 'STURMA');
    assert.deepEqual([v.carga, v.missing], [3, 1]);
    assert.match(fs.readFileSync(v.file, 'utf8'), /2030;7;T9;Turma 9/);
    assert.match(fs.readFileSync(path.join(job.result.dir, 'RESUMO.txt'), 'utf8'), /STURMA\s+ZMIGRA_STURMA\s+3\s+1\s+66\.7/);

    // Só validar (leitura) e complemento
    const vj = await waitJob(ok(await api('POST', `${B}/validate`, { system: 'educacional', connectionId: conn.id, database: DBN, tables: ['STURMA'], outDir: out })).jobId);
    assert.equal(vj.status, 'done'); assert.equal(vj.result.validation[0].missing, 1);
    const txtDir = fs.mkdtempSync(path.join(tmp, 'txt-'));
    const line = (fil, perlet, turma) => { const a = Array(10).fill(''); a[5] = fil; a[7] = perlet; a[8] = turma; return a.join(';'); };
    fs.writeFileSync(path.join(txtDir, 'STURMA.txt'), Buffer.from(`${line('3', '2030', 'T1')}\r\n${line('7', '2030', 'T9')}\r\n`, 'latin1'));
    const cj = await waitJob(ok(await api('POST', `${B}/complement`, { system: 'educacional', connectionId: conn.id, database: DBN, coligada: 7, txtDir, outDir: out })).jobId);
    assert.equal(cj.status, 'done', JSON.stringify(cj));
    assert.equal(fs.readFileSync(path.join(cj.result.dir, 'STURMA.txt'), 'latin1'), `${line('7', '2030', 'T9')}\r\n`);
    assert.match(cj.result.rows.find((r) => r.table === 'SDISCGRADE').status, /SEM TXT/);
    console.log('e2e Validação de Carga: OK');
  } finally {
    server.close(); fake.close();
    await drop().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
