// Gerar arquivos de importação a partir do resultado de um script SQL.
// Regras puras (agrupamento, nome, sanitização, conteúdo, ANSI) + API com SQL Server LOCALHOST (tempdb; pulado se não houver).
// Nada de produção: conexão "local" em localhost, dados em pasta temporária, Lixeira simulada.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const X = require('../src/script-export');

const COLS = ['TABELA', 'COLIGADA', 'LINHA_IMPORTACAO'];
const ROWS = [['PFUNC', '1', 'linha A'], ['PFUNC', '1', 'linha B'], ['PFUNC', '2', 'linha C'], ['PFFINANC', '1', 'linha D'], ['PFFINANC', '2', 'linha E']];
const RS = { columns: COLS, rows: ROWS };
const rels = (plan) => plan.files.map((f) => f.rel.split(path.sep).join('/')).sort();
const text = (plan, rel, rs = RS, col = 2) => X.fileText(plan.files.find((f) => f.rel.split(path.sep).join('/') === rel), rs.rows, col);

test('organização TABELA → COLIGADA, nome fixo, várias linhas no mesmo arquivo', () => {
  const p = X.buildPlan(RS, { levels: ['TABELA', 'COLIGADA'], contentColumn: 'LINHA_IMPORTACAO', fileName: 'arquivo.txt' });
  assert.deepEqual(rels(p), ['PFFINANC/1/arquivo.txt', 'PFFINANC/2/arquivo.txt', 'PFUNC/1/arquivo.txt', 'PFUNC/2/arquivo.txt']);
  assert.equal(p.folders, 6);
  assert.equal(p.lines, 5);
  assert.equal(text(p, 'PFUNC/1/arquivo.txt'), 'linha A\r\nlinha B\r\n', 'linhas na ordem do resultado, CRLF');
  assert.equal(p.duplicates.length, 0);
  assert.ok(p.warnings.some((w) => /nome do arquivo é fixo/.test(w)), 'avisa que o nome é fixo');
});

test('organização só por COLIGADA com nome dinâmico {TABELA}-{COLIGADA}.txt e texto fixo', () => {
  const p = X.buildPlan(RS, { levels: ['COLIGADA'], contentColumn: 'LINHA_IMPORTACAO', fileName: '{TABELA}-{COLIGADA}.txt' });
  assert.deepEqual(rels(p), ['1/PFFINANC-1.txt', '1/PFUNC-1.txt', '2/PFFINANC-2.txt', '2/PFUNC-2.txt']);
  assert.equal(p.folders, 2);
  assert.equal(text(p, '1/PFUNC-1.txt'), 'linha A\r\nlinha B\r\n');
  assert.equal(p.warnings.length, 0);
  const q = X.buildPlan(RS, { levels: [], contentColumn: 'linha_importacao', fileName: 'MIGRACAO-{tabela}-{COLIGADA}.txt' });
  assert.ok(rels(q).includes('MIGRACAO-PFUNC-1.txt'), 'colunas sem diferenciar maiúsculas; sem níveis = direto na pasta');
  assert.equal(q.folders, 0);
});

test('colunas genéricas (EMPRESA/FILIAL/ARQUIVO/CONTEUDO) e conteúdo sem alteração', () => {
  const rs = { columns: ['EMPRESA', 'FILIAL', 'ARQUIVO', 'CONTEUDO'], rows: [['E1', 'F1', 'clientes', ' 001;Ação;  '], ['E1', 'F1', 'clientes', null], ['E1', 'F2', 'clientes', 'a\nb']] };
  const p = X.buildPlan(rs, { levels: ['EMPRESA', 'FILIAL'], contentColumn: 'CONTEUDO', fileName: '{ARQUIVO}.csv' });
  assert.deepEqual(rels(p), ['E1/F1/clientes.csv', 'E1/F2/clientes.csv']);
  assert.equal(text(p, 'E1/F1/clientes.csv', rs, 3), ' 001;Ação;  \r\n\r\n', 'espaços preservados; NULL = linha vazia');
  assert.equal(text(p, 'E1/F2/clientes.csv', rs, 3), 'a\nb\r\n', 'quebra interna do valor não é reinterpretada');
});

test('caracteres inválidos do Windows e valores vazios viram "_"', () => {
  const rs = { columns: ['T', 'C', 'L'], rows: [['A/B:C*?"<>|', null, 'x'], ['..', '', 'y'], ['CON', ' 1. ', 'z']] };
  const p = X.buildPlan(rs, { levels: ['T'], contentColumn: 'L', fileName: '{T}-{C}.txt' });
  const r = rels(p);
  assert.ok(r.includes('A_B_C______/A_B_C______-_.txt'), r.join(' | '));
  assert.ok(r.includes('_/_-_.txt'), 'nem ".." nem vazio viram caminho');
  assert.ok(r.includes('_/_-1.txt'), 'nome reservado do Windows (CON) não é usado; " 1. " vira "1"');
  for (const f of p.files) for (const part of [...f.dirs, f.name]) assert.ok(!/[<>:"/\\|?*]/.test(part) && part !== '..' && part !== '.', part);
});

test('nomes repetidos: grupos diferentes no mesmo arquivo são detectados (e podem ser separados)', () => {
  const rs = { columns: ['T', 'L'], rows: [['A/B', '1'], ['A_B', '2'], ['pfunc', '3'], ['PFUNC', '4']] };
  const p = X.buildPlan(rs, { levels: [], contentColumn: 'L', fileName: '{T}.txt' });
  assert.equal(p.duplicates.length, 2, JSON.stringify(p.duplicates));
  assert.ok(p.warnings.some((w) => /nomes repetidos/.test(w)));
  const s = X.buildPlan(rs, { levels: [], contentColumn: 'L', fileName: '{T}.txt' }, { splitDuplicates: true });
  assert.equal(s.files.length, 4, 'separados: um arquivo por grupo (a gravação dá nome novo)');
});

test('resultado vazio, coluna inexistente e configuração inválida', () => {
  assert.throws(() => X.buildPlan({ columns: COLS, rows: [] }, { contentColumn: 'LINHA_IMPORTACAO', fileName: 'a.txt' }), (e) => e.code === 'EXPORT_EMPTY');
  assert.throws(() => X.buildPlan(RS, { levels: ['XPTO'], contentColumn: 'LINHA_IMPORTACAO', fileName: '{OUTRA}.txt' }), (e) => e.code === 'EXPORT_COLUMNS' && e.missing.join() === 'XPTO,OUTRA');
  assert.throws(() => X.buildPlan(RS, { contentColumn: '', fileName: 'a.txt' }), /conteúdo das linhas/);
  assert.throws(() => X.buildPlan(RS, { contentColumn: 'LINHA_IMPORTACAO', fileName: '' }), /nome do arquivo/);
  assert.throws(() => X.cleanConfig({ levels: ['A', 'a'] }), /mais de um nível/);
});

test('várias colunas no conteúdo: ordem escolhida, separador e NULL em branco ou como "NULL"', () => {
  const rs = { columns: ['T', 'COD', 'NOME', 'VALOR'], rows: [['A', '001', 'Ação', null], ['A', null, 'Beta', '10,5'], ['B', '003', '', '7']] };
  const p = X.buildPlan(rs, { levels: [], contentColumns: ['nome', 'COD', 'VALOR'], separator: ';', fileName: '{T}.txt' });
  assert.deepEqual(p.config.contentColumns, ['nome', 'COD', 'VALOR']);
  assert.equal(p.config.contentColumn, 'nome', 'primeira coluna também na forma antiga');
  assert.equal(X.fileText(p.files[0], rs.rows, p.content, p.config), 'Ação;001;\r\nBeta;;10,5\r\n', 'ordem escolhida; NULL em branco por padrão');
  const sep = (s) => X.fileText(p.files[0], rs.rows, p.content, { separator: s });
  assert.equal(sep('\t'), 'Ação\t001\t\r\nBeta\t\t10,5\r\n', 'tabulação');
  assert.equal(sep(''), 'Ação001\r\nBeta10,5\r\n', 'sem separador = valores colados');
  const n = X.buildPlan(rs, { contentColumns: ['COD', 'VALOR'], separator: ' | ', nullAs: 'null', fileName: 'x.txt' });
  assert.equal(X.fileText(n.files[0], rs.rows, n.content, n.config), '001 | NULL\r\nNULL | 10,5\r\n003 | 7\r\n', 'NULL mantido como texto; vazio continua vazio');
  const one = X.buildPlan(rs, { contentColumns: ['VALOR'], separator: ';', nullAs: 'null', fileName: 'x.txt' });
  assert.equal(X.fileText(one.files[0], rs.rows, one.content, one.config), 'NULL\r\n10,5\r\n7\r\n', 'uma coluna também respeita NULL');
  assert.deepEqual(X.cleanConfig({ contentColumns: ['L'], separator: ';', fileName: 'a.txt' }), { levels: [], contentColumn: 'L', fileName: 'a.txt', encoding: 'utf8' }, 'uma coluna e NULL em branco = forma antiga');
  assert.deepEqual(X.cleanConfig({ contentColumn: 'L', fileName: 'a.txt' }), { levels: [], contentColumn: 'L', fileName: 'a.txt', encoding: 'utf8' }, 'configuração antiga continua válida');
  assert.throws(() => X.cleanConfig({ contentColumns: ['A', 'a'] }), /mais de uma vez/);
  assert.throws(() => X.cleanConfig({ contentColumns: ['A', 'B'], separator: '12345678901' }), /no máximo 10/);
  assert.throws(() => X.cleanConfig({ contentColumns: ['A', 'B'], separator: '\r\n' }), /quebra de linha/);
  assert.throws(() => X.buildPlan(rs, { contentColumns: ['COD', 'XPTO'], fileName: 'a.txt' }), (e) => e.code === 'EXPORT_COLUMNS' && e.missing.join() === 'XPTO');
  assert.throws(() => X.buildPlan(rs, { contentColumns: [], fileName: 'a.txt' }), /conteúdo das linhas/);
});

test('codificação: UTF-8 sem BOM e ANSI (Windows-1252) com "?" para o que não existe', () => {
  assert.deepEqual([...X.encode('ação', 'utf8').buffer], [0x61, 0xc3, 0xa7, 0xc3, 0xa3, 0x6f]);
  const a = X.encode('ação € “x” ✓', 'ansi');
  assert.deepEqual([...a.buffer], [0x61, 0xe7, 0xe3, 0x6f, 0x20, 0x80, 0x20, 0x93, 0x78, 0x94, 0x20, 0x3f]);
  assert.equal(a.unmappable, 1);
});

// ---------- API (execução real só em SQL Server localhost) ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-export-'));
const PORT = 4457;
process.env.PORT = String(PORT);
process.env.GP_DATA_DIR = path.join(tmp, 'data');
const { app } = require('../server');
const db = require('../src/db');
const exportApi = require('../src/script-export-api');
let server;
const lixeira = path.join(tmp, 'lixeira');
const trashed = [];
test.before(() => {
  server = app.listen(PORT, '127.0.0.1');
  fs.mkdirSync(lixeira);
  exportApi.setTrash(async (paths) => { for (const p of paths) { trashed.push(p); fs.renameSync(p, path.join(lixeira, `${trashed.length}-${path.basename(p)}`)); } });
});
test.after(() => { exportApi.setTrash(null); server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const base = `http://localhost:${PORT}`;
const api = async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Origin: base }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const SQL = `SELECT TABELA, COLIGADA, LINHA_IMPORTACAO FROM (VALUES
  ('PFUNC', 1, 'linha A'), ('PFUNC', 1, 'linha B'), ('PFUNC', 2, 'linha C'), ('PFFINANC', 1, 'linha D'), ('PFFINANC', 2, 'linha Ê')) v(TABELA, COLIGADA, LINHA_IMPORTACAO)
ORDER BY CASE TABELA WHEN 'PFUNC' THEN 0 ELSE 1 END, COLIGADA, LINHA_IMPORTACAO`;
const listFiles = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map((x) => x.split(path.sep).join('/')).sort() : []);

let sqlOk = false;
test.before(async () => { try { await db.testConnection({ server: 'localhost', database: 'tempdb', auth: 'windows' }, ''); sqlOk = true; } catch { sqlOk = false; } });

test('API: executar (transação desfeita), prévia sem gravar, gerar, conflitos e configuração salva', async (t) => {
  if (!sqlOk) return t.skip('SQL Server localhost indisponível');
  const conn = await api('POST', '/api/connections', { name: 'Local teste', env: 'local', server: 'localhost', database: 'tempdb', auth: 'windows' });
  assert.equal(conn.status, 200, JSON.stringify(conn.json));
  const target = `conn:${conn.json.id}`;
  const mk = async (name, content) => (await api('POST', '/api/scripts', { name, content })).json.id;
  const sid = await mk('Gerar arquivos RM', SQL);
  const out = path.join(tmp, 'Importacao');
  fs.mkdirSync(out);

  // 1) script com 3 colunas
  const run = await api('POST', '/api/script-export/run', { scriptId: sid, target });
  assert.equal(run.status, 200, JSON.stringify(run.json));
  assert.equal(run.json.ok, true, run.json.error);
  assert.deepEqual(run.json.sets[0].columns, COLS);
  assert.equal(run.json.sets[0].total, 5);
  const rid = run.json.resultId;
  const cfg = { levels: ['COLIGADA'], contentColumn: 'LINHA_IMPORTACAO', fileName: '{TABELA}-{COLIGADA}.txt', encoding: 'utf8' };

  // 7) prévia não grava nada
  const pv = await api('POST', '/api/script-export/preview', { resultId: rid, config: cfg, outDir: out });
  assert.equal(pv.status, 200, JSON.stringify(pv.json));
  assert.equal(pv.json.totalFiles, 4);
  assert.equal(pv.json.newFolders, 2);
  assert.deepEqual(listFiles(out), [], 'prévia não escreve arquivos');

  // gerar
  const g = await api('POST', '/api/script-export/generate', { resultId: rid, config: cfg, outDir: out });
  assert.equal(g.status, 200, JSON.stringify(g.json));
  assert.deepEqual([g.json.filesCreated, g.json.foldersCreated, g.json.lines, g.json.errors.length], [4, 2, 5, 0]);
  assert.deepEqual(listFiles(out), ['1', '1/PFFINANC-1.txt', '1/PFUNC-1.txt', '2', '2/PFFINANC-2.txt', '2/PFUNC-2.txt']);
  assert.equal(fs.readFileSync(path.join(out, '1', 'PFUNC-1.txt'), 'utf8'), 'linha A\r\nlinha B\r\n');
  assert.deepEqual([...fs.readFileSync(path.join(out, '2', 'PFFINANC-2.txt'))], [...Buffer.from('linha Ê\r\n', 'utf8')], 'UTF-8 sem BOM');

  // 8) conflito: arquivo existente nunca é sobrescrito sem decisão
  const again = await api('POST', '/api/script-export/generate', { resultId: rid, config: cfg, outDir: out });
  assert.equal(again.status, 409);
  assert.equal(again.json.code, 'EXPORT_EXISTS');
  assert.equal(again.json.conflicts.length, 4);
  const ren = await api('POST', '/api/script-export/generate', { resultId: rid, config: cfg, outDir: out, onExisting: 'rename' });
  assert.equal(ren.json.renamed, 4);
  assert.ok(fs.existsSync(path.join(out, '1', 'PFUNC-1 (2).txt')));
  assert.equal(fs.readFileSync(path.join(out, '1', 'PFUNC-1.txt'), 'utf8'), 'linha A\r\nlinha B\r\n', 'original intacto');
  fs.writeFileSync(path.join(out, '1', 'PFUNC-1.txt'), 'antigo');
  const rep = await api('POST', '/api/script-export/generate', { resultId: rid, config: { ...cfg, encoding: 'ansi' }, outDir: out, onExisting: 'replace' });
  assert.equal(rep.status, 200, JSON.stringify(rep.json));
  assert.equal(rep.json.replaced, 4);
  assert.equal(trashed.length, 4, 'substituir manda o antigo para a Lixeira');
  assert.equal(fs.readFileSync(path.join(lixeira, fs.readdirSync(lixeira).find((n) => n.endsWith('PFUNC-1.txt'))), 'utf8'), 'antigo');
  assert.deepEqual([...fs.readFileSync(path.join(out, '2', 'PFFINANC-2.txt'))], [...Buffer.from('linha \xca\r\n', 'latin1')], 'ANSI');

  // nome fixo sem níveis: grupos diferentes no mesmo arquivo → confirmação (juntar ou gerar nomes diferentes)
  const out2 = path.join(tmp, 'Fixo'); fs.mkdirSync(out2);
  const fixed = { levels: [], contentColumn: 'LINHA_IMPORTACAO', fileName: '{TABELA}.txt' };
  const lower = await mk('Duplicado', `SELECT T, L FROM (VALUES ('pfunc', 'a'), ('PFUNC', 'b')) v(T, L) ORDER BY L`);
  const r2 = (await api('POST', '/api/script-export/run', { scriptId: lower, target })).json;
  const dup = await api('POST', '/api/script-export/generate', { resultId: r2.resultId, config: { ...fixed, contentColumn: 'L', fileName: '{T}.txt' }, outDir: out2 });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.code, 'EXPORT_DUPLICATES');
  const split = await api('POST', '/api/script-export/generate', { resultId: r2.resultId, config: { ...fixed, contentColumn: 'L', fileName: '{T}.txt' }, outDir: out2, duplicates: 'rename' });
  assert.deepEqual(listFiles(out2), ['PFUNC (2).txt', 'pfunc.txt'], 'o segundo grupo ganha nome livre');
  assert.equal(split.json.filesCreated, 2);

  // várias colunas no conteúdo, na ordem escolhida, com separador e NULL mantido
  const out3 = path.join(tmp, 'Colunas'); fs.mkdirSync(out3);
  const multi = (await api('POST', '/api/script-export/run', { scriptId: await mk('Colunas', `SELECT T, COD, NOME FROM (VALUES ('A', '1', 'Ação'), ('A', NULL, 'Beta')) v(T, COD, NOME) ORDER BY NOME`), target })).json;
  const mcfg = { levels: [], contentColumns: ['NOME', 'T', 'COD'], separator: ';', nullAs: 'null', fileName: '{T}.txt', encoding: 'ansi' };
  const mg = await api('POST', '/api/script-export/generate', { resultId: multi.resultId, config: mcfg, outDir: out3 });
  assert.equal(mg.status, 200, JSON.stringify(mg.json));
  assert.deepEqual([...fs.readFileSync(path.join(out3, 'A.txt'))], [...Buffer.from('A\xe7\xe3o;A;1\r\nBeta;A;NULL\r\n', 'latin1')], 'colunas na ordem, separador, NULL e ANSI');

  // 12) coluna inexistente; diretório inválido
  const bad = await api('POST', '/api/script-export/preview', { resultId: rid, config: { ...cfg, levels: ['EMPRESA'] }, outDir: out });
  assert.equal(bad.json.code, 'EXPORT_COLUMNS');
  assert.deepEqual(bad.json.missing, ['EMPRESA']);
  assert.equal((await api('POST', '/api/script-export/preview', { resultId: rid, config: cfg, outDir: path.join(tmp, 'nao-existe') })).json.code, 'EXPORT_DIR');
  assert.equal((await api('POST', '/api/script-export/preview', { resultId: rid, config: cfg, outDir: 'relativo' })).json.code, 'EXPORT_DIR');
  assert.equal((await api('POST', '/api/script-export/preview', { resultId: rid, config: cfg, outDir: process.env.GP_DATA_DIR })).json.code, 'EXPORT_DIR', 'nunca na pasta de dados');
  assert.equal((await api('POST', '/api/script-export/preview', { resultId: 'x', config: cfg, outDir: out })).status, 410);

  // 10) retorno vazio e script sem SELECT
  const empty = (await api('POST', '/api/script-export/run', { scriptId: await mk('Vazio', `${SQL.replace('SELECT ', 'SELECT TOP 0 ')}`), target })).json;
  assert.equal(empty.sets[0].total, 0);
  assert.equal((await api('POST', '/api/script-export/preview', { resultId: empty.resultId, config: cfg, outDir: out })).json.code, 'EXPORT_EMPTY');
  const none = (await api('POST', '/api/script-export/run', { scriptId: await mk('Sem retorno', 'DECLARE @x INT = 1'), target })).json;
  assert.equal(none.ok, true);
  assert.equal(none.sets.length, 0);

  // 11) erro SQL
  const err = (await api('POST', '/api/script-export/run', { scriptId: await mk('Erro', 'SELECT * FROM dbo.TabelaQueNaoExiste_GP'), target })).json;
  assert.equal(err.ok, false);
  assert.match(err.error, /TabelaQueNaoExiste_GP/);

  // transação sempre desfeita: a tabela criada pelo script não existe depois
  await api('POST', '/api/script-export/run', { scriptId: await mk('Cria', 'CREATE TABLE dbo.gp_export_teste (x INT)\nGO\nSELECT 1 AS X'), target });
  const chk = (await api('POST', '/api/script-export/run', { scriptId: await mk('Confere', "SELECT OBJECT_ID('dbo.gp_export_teste') AS ID"), target })).json;
  assert.equal(chk.sets[0].rows[0][0], null, 'nada fica gravado no banco');

  // conexão indisponível (simulada: nunca um servidor real)
  const real = db.runScript;
  db.runScript = async () => { throw Object.assign(new Error('Não foi possível conectar em 192.0.2.10:1433. Confira o nome do servidor e se a VPN está conectada.'), { status: 502 }); };
  try {
    const off = (await api('POST', '/api/script-export/run', { scriptId: sid, target })).json;
    assert.equal(off.ok, false);
    assert.match(off.error, /VPN/);
  } finally { db.runScript = real; }

  // 13) salvar configuração no script e recarregar
  const sv = await api('PUT', `/api/scripts/${sid}/export-config`, { config: { levels: ['TABELA', 'COLIGADA'], contentColumn: 'LINHA_IMPORTACAO', fileName: '{TABELA}-{COLIGADA}.txt', encoding: 'ansi' } });
  assert.equal(sv.status, 200, JSON.stringify(sv.json));
  const listed = (await api('GET', '/api/scripts')).json.find((s) => s.id === sid);
  assert.deepEqual(listed.exportConfig, { levels: ['TABELA', 'COLIGADA'], contentColumn: 'LINHA_IMPORTACAO', fileName: '{TABELA}-{COLIGADA}.txt', encoding: 'ansi' });
  const raw = JSON.parse(fs.readFileSync(path.join(process.env.GP_DATA_DIR, 'projects.json'), 'utf8'));
  assert.equal(raw.scripts.find((s) => s.id === sid).exportConfig.fileName, '{TABELA}-{COLIGADA}.txt', 'persistido');
  assert.equal((await api('POST', '/api/script-export/run', { scriptId: sid, target })).json.config.encoding, 'ansi', 'volta ao executar');
  assert.equal((await api('PUT', `/api/scripts/${sid}/export-config`, { config: { contentColumn: '' } })).status, 400);
  const sv2 = await api('PUT', `/api/scripts/${sid}/export-config`, { config: { levels: [], contentColumns: ['LINHA_IMPORTACAO', 'TABELA'], separator: '\t', nullAs: 'null', fileName: '{TABELA}.txt' } });
  assert.equal(sv2.status, 200, JSON.stringify(sv2.json));
  const back = (await api('POST', '/api/script-export/run', { scriptId: sid, target })).json.config;
  assert.deepEqual([back.contentColumns, back.separator, back.nullAs], [['LINHA_IMPORTACAO', 'TABELA'], '\t', 'null'], 'várias colunas, separador e NULL voltam ao executar');
  assert.equal((await api('PUT', `/api/scripts/${sid}/export-config`, { config: { contentColumns: [], fileName: 'a.txt' } })).status, 400);
});
