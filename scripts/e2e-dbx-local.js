// Teste ponta a ponta do Explorador de Banco contra o SQL Server LOCAL (nunca produção), pelo fluxo real da API:
// conexão cadastrada (Windows) → bancos → carregar estrutura (processo-filho) → visão geral, hipóteses, mapa, caminhos, montador,
// amostra, perfil, conferir relacionamento e Console SQL (somente leitura). Cria o banco descartável GP_DBX_TESTE e apaga só ele.
// Uso: node scripts/e2e-dbx-local.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');

const DBN = 'GP_DBX_TESTE';
const PORT = 4390;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-e2e-dbx-'));
process.env.PORT = String(PORT);
process.env.GP_DATA_DIR = path.join(tmp, 'data');

const sql = require('mssql/msnodesqlv8');
const { app } = require('../server');

const pool = (database) => new sql.ConnectionPool({ connectionString: `Driver={ODBC Driver 17 for SQL Server};Server=localhost;Database=${database};Trusted_Connection=Yes;TrustServerCertificate=Yes;` });
async function q(database, query) { const p = pool(database); await p.connect(); try { return (await p.request().batch(query)).recordset; } finally { await p.close(); } }
const drop = () => q('master', `IF DB_ID('${DBN}') IS NOT NULL BEGIN ALTER DATABASE [${DBN}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${DBN}] END`);

// Modelo pequeno com o que importa: FK simples, FK composta (estilo RM: CODCOLIGADA + chave), relacionamentos SEM FK
// (hipóteses: composta e por padrão de nome) e uma tabela isolada sem PK. Nomes com colchete testam o escape.
const SCHEMA = `
CREATE TABLE dbo.GCOLIGADA (CODCOLIGADA smallint NOT NULL PRIMARY KEY, NOME varchar(60) NOT NULL);
CREATE TABLE dbo.CLIENTE (ID int NOT NULL PRIMARY KEY, NOME nvarchar(80) NOT NULL, CPF varchar(14) NULL, EMAIL varchar(80) NULL);
CREATE TABLE dbo.PEDIDO (ID int NOT NULL PRIMARY KEY, CLIENTEID int NOT NULL REFERENCES dbo.CLIENTE(ID), DATA date NOT NULL);
CREATE TABLE dbo.PRODUTO (ID int NOT NULL PRIMARY KEY, DESCRICAO varchar(80));
CREATE TABLE dbo.ITEM (PEDIDOID int NOT NULL REFERENCES dbo.PEDIDO(ID), PRODUTOID int NOT NULL, QTD int, PRIMARY KEY (PEDIDOID, PRODUTOID));
CREATE INDEX IX_ITEM_PRODUTO ON dbo.ITEM(PRODUTOID);
CREATE TABLE dbo.PFUNC (CODCOLIGADA smallint NOT NULL REFERENCES dbo.GCOLIGADA(CODCOLIGADA), CHAPA varchar(16) NOT NULL, NOME varchar(80), CLIENTEID int NULL,
  PRIMARY KEY (CODCOLIGADA, CHAPA));
CREATE TABLE dbo.PFERIAS (CODCOLIGADA smallint NOT NULL, CHAPA varchar(16) NOT NULL, INICIO date NOT NULL, DIAS int, PRIMARY KEY (CODCOLIGADA, CHAPA, INICIO));
CREATE TABLE dbo.PDEPEND (CODCOLIGADA smallint NOT NULL, CHAPA varchar(16) NOT NULL, NRODEPEND int NOT NULL, NOME varchar(60),
  CONSTRAINT FK_PDEPEND_PFUNC FOREIGN KEY (CODCOLIGADA, CHAPA) REFERENCES dbo.PFUNC(CODCOLIGADA, CHAPA), PRIMARY KEY (CODCOLIGADA, CHAPA, NRODEPEND));
CREATE TABLE dbo.[LOG]]X] (QUANDO datetime2 NULL, TEXTO nvarchar(max) NULL);
EXEC sys.sp_addextendedproperty 'MS_Description', N'Cadastro de clientes', 'SCHEMA', 'dbo', 'TABLE', 'CLIENTE';
`;
const DATA = `
INSERT dbo.GCOLIGADA VALUES (1,'Matriz'),(2,'Filial');
INSERT dbo.CLIENTE VALUES (1,N'Ana','123.456.789-00','ana@exemplo.test'),(2,N'Beto',NULL,NULL),(3,N'Caio','987.654.321-00','caio@exemplo.test');
INSERT dbo.PEDIDO VALUES (10,1,'2026-01-02'),(11,1,'2026-01-03'),(12,3,'2026-02-01');
INSERT dbo.PRODUTO VALUES (100,'Caneta'),(101,'Lápis');
INSERT dbo.ITEM VALUES (10,100,2),(10,101,1),(11,100,5),(12,999,1);
INSERT dbo.PFUNC VALUES (1,'0001','Dora',1),(1,'0002','Eli',NULL),(2,'0001','Fabi',2);
INSERT dbo.PFERIAS VALUES (1,'0001','2026-03-01',30),(2,'0001','2026-04-01',10),(2,'0099','2026-05-01',5);
INSERT dbo.PDEPEND VALUES (1,'0001',1,'Gil');
INSERT dbo.[LOG]]X] VALUES (SYSDATETIME(), N'x');
`;

const base = `http://localhost:${PORT}`;
const api = async (method, url, body) => { const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Origin: base }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})), headers: r.headers }; };
const B = '/api/tools/db-explorer';
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };

(async () => {
  const server = app.listen(PORT, '127.0.0.1');
  try {
    await drop();
    await q('master', `CREATE DATABASE [${DBN}]`);
    await q(DBN, SCHEMA);
    await q(DBN, DATA);
    const conn = ok(await api('POST', '/api/connections', { name: 'Localhost', env: 'local', server: 'localhost', auth: 'windows' }));

    // Bancos do servidor
    const dbs = ok(await api('POST', `${B}/databases`, { connectionId: conn.id }));
    assert.ok(dbs.databases.some((d) => d.name === DBN && d.access), 'banco de teste listado');

    // Estrutura
    const load = ok(await api('POST', `${B}/catalogs`, { connectionId: conn.id, database: DBN }));
    const id = load.catalog.id; const ov = load.overview;
    assert.equal(ov.counts.tables, 9);
    assert.equal(ov.counts.fks, 4, 'PEDIDO→CLIENTE, ITEM→PEDIDO, PFUNC→GCOLIGADA, PDEPEND→PFUNC (composta = 1)');
    assert.equal(ov.counts.noPk, 1); assert.equal(ov.counts.isolated >= 1, true);
    const pdep = ok(await api('GET', `${B}/catalogs/${id}/table?key=dbo.PDEPEND`));
    const fkComp = pdep.relationships.find((r) => r.kind === 'fk' && r.to === 'dbo.PFUNC');
    assert.deepEqual(fkComp.pairs, [['CODCOLIGADA', 'CODCOLIGADA'], ['CHAPA', 'CHAPA']], 'FK composta numa relação só');
    const cli = ok(await api('GET', `${B}/catalogs/${id}/table?key=CLIENTE`));
    assert.equal(cli.description, 'Cadastro de clientes');
    assert.ok(cli.columns.find((c) => c.name === 'CPF').sensitive);

    // Hipóteses: PFERIAS(CODCOLIGADA,CHAPA)→PFUNC; ITEM.PRODUTOID→PRODUTO.ID (padrão de nome); PFUNC.CLIENTEID→CLIENTE.ID
    const fer = ok(await api('GET', `${B}/catalogs/${id}/table?key=dbo.PFERIAS`));
    const h1 = fer.relationships.find((r) => r.kind === 'inferred' && r.to === 'dbo.PFUNC');
    assert.ok(h1, `hipótese composta: ${JSON.stringify(fer.relationships)}`);
    const item = ok(await api('GET', `${B}/catalogs/${id}/table?key=dbo.ITEM`));
    assert.ok(item.relationships.some((r) => r.kind === 'inferred' && r.to === 'dbo.PRODUTO' && r.pairs[0][0] === 'PRODUTOID'), 'hipótese por padrão de nome');

    // Mapa (vizinhança) e caminho com e sem hipóteses
    const g = ok(await api('POST', `${B}/catalogs/${id}/graph`, { mode: 'center', center: 'dbo.PEDIDO', depth: 2, includeInferred: false }));
    assert.deepEqual(g.nodes.map((n) => n.key).sort(), ['dbo.CLIENTE', 'dbo.ITEM', 'dbo.PEDIDO']);
    const p0 = ok(await api('POST', `${B}/catalogs/${id}/paths`, { from: 'dbo.ITEM', to: 'dbo.PRODUTO', includeInferred: false }));
    assert.equal(p0.paths.length, 0);
    const p1 = ok(await api('POST', `${B}/catalogs/${id}/paths`, { from: 'dbo.PDEPEND', to: 'dbo.GCOLIGADA', includeInferred: false }));
    assert.deepEqual(p1.paths[0].nodes, ['dbo.PDEPEND', 'dbo.PFUNC', 'dbo.GCOLIGADA']);

    // Montador: ITEM + CLIENTE (intermediária PEDIDO) — o SQL gerado tem de rodar no Console
    const j = ok(await api('POST', `${B}/catalogs/${id}/join`, { tables: ['dbo.ITEM', 'dbo.CLIENTE'], star: true }));
    assert.deepEqual(j.plan.joins.map((x) => x.table), ['dbo.PEDIDO', 'dbo.CLIENTE']);
    const run = ok(await api('POST', `${B}/catalogs/${id}/query`, { sql: j.sql, mask: false }));
    assert.equal(run.rows.length, 4);
    const comp = ok(await api('POST', `${B}/catalogs/${id}/join`, { tables: ['dbo.PDEPEND', 'dbo.GCOLIGADA'], columns: { 'dbo.PDEPEND': ['NOME'], 'dbo.GCOLIGADA': ['NOME'] } }));
    assert.match(comp.sql, /AND t0\.\[CHAPA\]|AND t1\.\[CHAPA\]/);
    assert.equal(ok(await api('POST', `${B}/catalogs/${id}/query`, { sql: comp.sql })).rows.length, 1);

    // Amostra (com máscara), nome com colchete, perfil
    const s = ok(await api('POST', `${B}/catalogs/${id}/sample`, { key: 'dbo.CLIENTE', limit: 2 }));
    assert.equal(s.rows.length, 2); assert.deepEqual(s.masked.sort(), ['CPF', 'EMAIL']);
    assert.ok(String(s.rows[0][s.columns.indexOf('CPF')]).includes('*'));
    assert.equal(ok(await api('POST', `${B}/catalogs/${id}/sample`, { key: 'dbo.LOG]X' })).rows.length, 1);
    const pr = ok(await api('POST', `${B}/catalogs/${id}/profile`, { key: 'dbo.CLIENTE' }));
    const cpf = pr.columns.find((c) => c.name === 'CPF');
    assert.equal(pr.sampled, 3); assert.equal(cpf.nulls, 1); assert.equal(cpf.filledPct, 66.7);
    ok(await api('POST', `${B}/catalogs/${id}/profile`, { key: 'dbo.LOG]X' })); // nvarchar(max)/datetime2

    // Conferir relacionamentos: hipótese PFERIAS→PFUNC (1 órfão: 2/0099); ITEM→PRODUTO (1 órfão: 999)
    const c1 = ok(await api('POST', `${B}/catalogs/${id}/check`, { relId: h1.id }));
    assert.equal(c1.sampled, 3); assert.equal(c1.matched, 2);
    const c2 = ok(await api('POST', `${B}/catalogs/${id}/check`, { from: 'dbo.ITEM', to: 'dbo.PRODUTO', pairs: [['PRODUTOID', 'ID']] }));
    assert.equal(c2.orphans, 1); assert.equal(c2.topOrphans.rows[0][0], 999);

    // Console: limite, colunas repetidas, e a trava (no servidor E no processo-filho)
    const lim = ok(await api('POST', `${B}/catalogs/${id}/query`, { sql: 'SELECT * FROM sys.all_columns', limit: 50 }));
    assert.equal(lim.rows.length, 50); assert.equal(lim.truncated, true);
    const cte = ok(await api('POST', `${B}/catalogs/${id}/query`, { sql: 'WITH x AS (SELECT a.ID, b.ID AS ID2 FROM dbo.CLIENTE a CROSS JOIN dbo.CLIENTE b) SELECT * FROM x', limit: 5 }));
    assert.equal(cte.rows.length, 5); assert.equal(cte.truncated, true);
    const dup = ok(await api('POST', `${B}/catalogs/${id}/query`, { sql: 'SELECT TOP 1 a.ID, b.ID FROM dbo.PEDIDO a JOIN dbo.CLIENTE b ON b.ID = a.CLIENTEID' }));
    assert.equal(dup.columns.length, 2);
    for (const bad of ['DELETE FROM dbo.CLIENTE', 'SELECT * INTO dbo.X FROM dbo.CLIENTE', 'SELECT 1; DROP TABLE dbo.CLIENTE', "EXEC('SELECT 1')", 'SELECT 1\nGO\nSELECT 2']) {
      const r = await api('POST', `${B}/catalogs/${id}/query`, { sql: bad });
      assert.equal(r.status, 400, bad); assert.equal(r.json.code, 'DBX_READONLY');
    }
    assert.equal((await q(DBN, 'SELECT COUNT(*) AS n FROM dbo.CLIENTE'))[0].n, 3, 'nada foi alterado');
    assert.equal(ok(await api('POST', `${B}/catalogs/${id}/query`, { sql: "SELECT N'DELETE FROM x; DROP' AS t -- DELETE" })).rows[0][0], 'DELETE FROM x; DROP');

    // Exportação
    for (const format of ['md', 'json', 'xlsx']) { const r = await fetch(`${base}${B}/catalogs/${id}/export`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ format }) }); assert.equal(r.status, 200); assert.ok((await r.arrayBuffer()).byteLength > 200); }

    console.log('e2e Explorador de Banco: OK');
  } finally {
    server.close();
    try { await drop(); } catch (e) { console.error('Não foi possível apagar o banco de teste:', e.message); }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
