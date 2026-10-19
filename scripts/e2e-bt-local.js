// Teste ponta a ponta do Importador BT → SQL contra o SQL Server LOCAL (nunca produção), pelo fluxo real da API:
// conexão cadastrada (Windows) → listar → validar (pré-checagem real) → importar (processo-filho, transação por arquivo).
// Cria os bancos descartáveis GP_BT_TESTE_* e apaga só eles ao final. Uso: node scripts/e2e-bt-local.js
// Confere no banco: tabelas/colunas/linhas iguais às da referência do app original (test/fixtures/bt/reference.json),
// append no mesmo banco, tabela existente com coluna nova, erro desfazendo só o arquivo, e valores com aspas/colchetes.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');

const PREFIX = 'GP_BT_TESTE_';
const PORT = 4391;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-e2e-bt-'));
process.env.PORT = String(PORT);
process.env.GP_DATA_DIR = path.join(tmp, 'data');

const sql = require('mssql/msnodesqlv8');
const { app } = require('../server');
const FIX = path.join(__dirname, '..', 'test', 'fixtures', 'bt');
const REF = JSON.parse(fs.readFileSync(path.join(FIX, 'reference.json'), 'utf8'));

const pool = (database) => new sql.ConnectionPool({ connectionString: `Driver={ODBC Driver 17 for SQL Server};Server=localhost;Database=${database};Trusted_Connection=Yes;TrustServerCertificate=Yes;` });
async function q(database, query) { const p = pool(database); await p.connect(); try { return (await p.request().query(query)).recordset; } finally { await p.close(); } }
async function dropTestDbs() {
  const dbs = await q('master', `SELECT name FROM sys.databases WHERE name LIKE '${PREFIX}%'`);
  for (const { name } of dbs) if (name.startsWith(PREFIX)) await q('master', `ALTER DATABASE [${name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${name}]`);
}
async function tableDump(database, table) {
  const cols = (await q(database, `SELECT c.name FROM sys.columns c WHERE c.object_id = OBJECT_ID(N'[dbo].[${table}]') ORDER BY c.column_id`)).map((x) => x.name);
  const rows = (await q(database, `SELECT * FROM [dbo].[${table}]`)).map((r) => cols.map((c) => r[c]));
  return { columns: cols, rows };
}

const base = `http://localhost:${PORT}`;
const api = async (method, url, body) => { const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Origin: base }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
const B = '/api/tools/bt-importer';
async function job(id) { for (;;) { const j = (await api('GET', `${B}/jobs/${id}`)).json; if (j.status !== 'running') return j; await new Promise((r) => setTimeout(r, 200)); } }

(async () => {
  const server = app.listen(PORT, '127.0.0.1');
  try {
    await dropTestDbs();
    const conn = (await api('POST', '/api/connections', { name: 'Localhost', env: 'local', server: 'localhost', auth: 'windows' })).json;
    const dir = path.join(tmp, 'bt');
    fs.mkdirSync(dir);
    for (const f of ['CLIENTES_01.bt', 'CLIENTES_02.bt', 'ESPECIAIS.bt', 'VAZIO.bt']) fs.copyFileSync(path.join(FIX, 'files', f), path.join(dir, f));
    // Valores e nomes com aspas e colchetes (injection) — o valor precisa chegar idêntico, a tabela entre colchetes.
    fs.writeFileSync(path.join(dir, 'INJ.bt'), Buffer.from("[EPG]\n[CODIGO:s;NOME:s]\n1|'); DROP TABLE EPG;--\n2|a]b[c\n[T]];X]\n[C]1:s]\nv\n", 'latin1'));

    const listed = (await api('POST', `${B}/list`, { dir })).json.files;
    assert.equal(listed.length, 5);
    const map = { 'CLIENTES_01.bt': `${PREFIX}HIST`, 'CLIENTES_02.bt': `${PREFIX}hist`, 'ESPECIAIS.bt': `${PREFIX}ESPECIAIS`, 'VAZIO.bt': `${PREFIX}VAZIO`, 'INJ.bt': `${PREFIX}INJ` };
    const files = listed.map((f) => ({ path: f.path, database: map[f.name] }));

    // 1) Validar + importar tudo (somente tabelas da lista; INJ tem T]];X fora da lista).
    let v = (await api('POST', `${B}/validate`, { connectionId: conn.id, files, options: { onlyAllowed: true, batchSize: 100 } })).json;
    v = await job(v.jobId);
    assert.equal(v.status, 'done', v.error);
    assert.ok(v.result.canExecute, JSON.stringify(v.result.issues));
    let ex = await api('POST', `${B}/plans/${v.result.planId}/execute`, { hash: v.result.hash, authorized: true });
    assert.equal(ex.status, 200, JSON.stringify(ex.json));
    let r = await job(ex.json.jobId);
    assert.equal(r.status, 'done', r.error);
    assert.deepEqual(r.items.map((i) => i.status), ['done', 'done', 'done', 'done'], JSON.stringify(r.items.map((i) => i.error)));

    // Mesmo resultado do app original (cenário "agrupado-somente-lista": HIST/hist agrupados, ESPECIAIS no padrão).
    const ref = REF.scenarios.find((s) => s.name === 'agrupado-somente-lista').databases;
    for (const [refDb, ourDb] of [['HIST', `${PREFIX}HIST`], ['MIGRA_ESPECIAIS', `${PREFIX}ESPECIAIS`]]) {
      for (const [t, data] of Object.entries(ref[refDb])) {
        const got = await tableDump(ourDb, t);
        assert.deepEqual(got.columns, data.columns, `${ourDb}.${t} colunas`);
        assert.deepEqual(got.rows, data.rows, `${ourDb}.${t} linhas`);
      }
    }
    const types = await q(`${PREFIX}HIST`, "SELECT DISTINCT TYPE_NAME(system_type_id) AS t, max_length, is_nullable FROM sys.columns WHERE object_id = OBJECT_ID('dbo.EPG')");
    assert.deepEqual(types, [{ t: 'nvarchar', max_length: -1, is_nullable: true }], 'todas NVARCHAR(MAX) NULL');
    const inj = await tableDump(`${PREFIX}INJ`, 'EPG');
    assert.deepEqual(inj.rows, [['1', "'); DROP TABLE EPG;--"], ['2', 'a]b[c']]);
    assert.ok(!(await q('master', `SELECT name FROM sys.databases WHERE name = '${PREFIX}VAZIO'`)).length, 'arquivo vazio não cria banco');

    // 2) Tabela existente: acrescenta de novo (append), sem apagar.
    v = await job((await api('POST', `${B}/validate`, { connectionId: conn.id, files: [files[0]] })).json.jobId);
    assert.equal(v.result.groups[0].createDatabase, false);
    ex = await api('POST', `${B}/plans/${v.result.planId}/execute`, { hash: v.result.hash, authorized: true });
    r = await job(ex.json.jobId);
    assert.equal(r.status, 'done');
    assert.equal((await q(`${PREFIX}HIST`, 'SELECT COUNT(*) AS n FROM dbo.EPG'))[0].n, 256);

    // 3) Erro no meio: tabela existente com coluna INT → o arquivo falha e NADA dele fica (transação por arquivo).
    await q('master', `CREATE DATABASE [${PREFIX}RIGIDA]`);
    await q(`${PREFIX}RIGIDA`, 'CREATE TABLE dbo.EMP (CODEMP INT NULL, RAZAO NVARCHAR(100) NULL); INSERT dbo.EMP VALUES (99, N\'antiga\')');
    fs.writeFileSync(path.join(dir, 'RUIM.bt'), Buffer.from('[EPG]\n[A:s]\n1\n[EMP]\n[CODEMP:n;RAZAO:s]\n1|ok\nX|não numérico\n', 'latin1'));
    v = await job((await api('POST', `${B}/validate`, { connectionId: conn.id, files: [{ path: path.join(dir, 'RUIM.bt'), database: `${PREFIX}RIGIDA` }] })).json.jobId);
    assert.ok(v.result.canExecute);
    assert.match(v.result.items[0].warnings.join(' '), /não-texto/);
    ex = await api('POST', `${B}/plans/${v.result.planId}/execute`, { hash: v.result.hash, authorized: true });
    r = await job(ex.json.jobId);
    assert.equal(r.items[0].status, 'error');
    console.log('   erro mostrado:', r.items[0].error);
    assert.deepEqual(await q(`${PREFIX}RIGIDA`, 'SELECT CODEMP, RAZAO FROM dbo.EMP'), [{ CODEMP: 99, RAZAO: 'antiga' }], 'nada do arquivo com erro ficou');
    assert.equal((await q(`${PREFIX}RIGIDA`, "SELECT COUNT(*) AS n FROM sys.tables WHERE name = 'EPG'"))[0].n, 0, 'nem a tabela criada pelo arquivo');
    const audit = fs.readFileSync(path.join(tmp, 'data', 'audit.log'), 'utf8');
    assert.ok(!audit.includes('não numérico'), 'valor do registro não vai para a auditoria');

    // 4) Muitos parâmetros por comando (poucas colunas → até 2000 parâmetros): os nomes não podem colidir com os @P<n>
    //    que o próprio ODBC usa por dentro (bug real: "@p1000 já foi declarado").
    const many = ['[EPG]', '[A:s;B:s]']; for (let i = 0; i < 2500; i++) many.push(`${i}|v${i}`);
    many.push('[EMP]', '[X:s]'); for (let i = 0; i < 1500; i++) many.push(`x${i}`);
    fs.writeFileSync(path.join(dir, 'MUITOS.bt'), Buffer.from(many.join('\n'), 'latin1'));
    v = await job((await api('POST', `${B}/validate`, { connectionId: conn.id, files: [{ path: path.join(dir, 'MUITOS.bt'), database: `${PREFIX}MUITOS` }] })).json.jobId);
    ex = await api('POST', `${B}/plans/${v.result.planId}/execute`, { hash: v.result.hash, authorized: true });
    r = await job(ex.json.jobId);
    assert.equal(r.items[0].status, 'done', r.items[0].error);
    assert.equal((await q(`${PREFIX}MUITOS`, 'SELECT COUNT(*) AS n FROM dbo.EPG'))[0].n, 2500);
    assert.equal((await q(`${PREFIX}MUITOS`, "SELECT B FROM dbo.EPG WHERE A = '1999'"))[0].B, 'v1999');
    assert.equal((await q(`${PREFIX}MUITOS`, 'SELECT COUNT(*) AS n FROM dbo.EMP'))[0].n, 1500);

    console.log('e2e-bt-local: OK');
  } finally {
    await dropTestDbs().catch((e) => console.error('limpeza:', e.message));
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
