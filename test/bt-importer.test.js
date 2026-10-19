// Ferramentas Auxiliares › Importador BT → SQL: API, validação, execução em lote, segurança e regras.
// O SQL Server é simulado no ponto em que o app fala com o processo-filho (db.runWorker): a pré-checagem devolve o "estado" do
// servidor e a importação roda o MESMO importFile (src/tools/bt-importer/sql.js) contra um banco em memória. A execução real
// em banco fica em scripts/e2e-bt-local.js (só SQL Server localhost). A paridade com o app original está em
// test/bt-importer-parity.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-bt-'));
const PORT = 4475;
process.env.PORT = String(PORT);
process.env.GP_DATA_DIR = path.join(tmp, 'data');
const { app, store } = require('../server');
const db = require('../src/db');
const P = require('../src/tools/bt-importer/plan');
const S = require('../src/tools/bt-importer/sql');
const { scanFile, parseFile } = require('../src/tools/bt-importer/parse');

let server;
test.before(() => { server = app.listen(PORT, '127.0.0.1'); });
test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const FIX = path.join(__dirname, 'fixtures', 'bt', 'files');
const dir = path.join(tmp, 'bt'); fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
const put = (name, text) => { const p = path.join(dir, name); fs.writeFileSync(p, Buffer.from(text, 'latin1')); return p; };
for (const f of ['CLIENTES_01.bt', 'CLIENTES_02.bt', 'ESPECIAIS.bt']) fs.copyFileSync(path.join(FIX, f), path.join(dir, f));
put('sub/HIST_03.bt', '[EPG]\n[CODIGO:s;NOME:s]\n9|Sub\n');
put('notas.txt', 'não é .bt');

// ---------- servidor SQL simulado ----------
const sim = { dbs: {}, canCreateDatabase: true, perms: { canCreateTable: true, canInsert: true, canAlter: true }, precheckError: null, failFile: null, slowFile: null, calls: [], passwords: [] };
const columnsOf = (dbn, t) => sim.dbs[dbn.toLowerCase()]?.[t]?.columns || null;
db.runWorker = async (op, args, opts = {}) => {
  sim.calls.push(op);
  sim.passwords.push(args.password);
  if (op === 'tool:bt-precheck') {
    if (sim.precheckError) throw new Error(sim.precheckError);
    const out = { identity: { server: 'SRV', database: 'master', login: 'teste', version: 'x' }, canCreateDatabase: sim.canCreateDatabase, databases: {} };
    for (const d of args.input.databases) {
      const e = sim.dbs[d.name.toLowerCase()];
      out.databases[d.name.toLowerCase()] = { name: d.name, exists: !!e, online: true, accessible: true, ...sim.perms, tables: Object.fromEntries((d.tables || []).filter((t) => e?.[t]).map((t) => [t, { columns: e[t].meta || e[t].columns.map((c) => ({ name: c, nullable: true, identity: false, computed: false, hasDefault: false, type: 'nvarchar' })) }])) };
    }
    return out;
  }
  if (op === 'tool:bt-createdb') { const created = []; for (const n of args.input.names) if (!sim.dbs[n.toLowerCase()]) { sim.dbs[n.toLowerCase()] = {}; created.push(n); } return { created }; }
  if (op === 'tool:bt-import') {
    const dbn = args.conn.database.toLowerCase();
    const name = path.basename(args.input.filePath);
    if (sim.failFile === name) throw new Error("Conversion failed when converting the nvarchar value 'SEGREDO-DO-REGISTRO' to data type int.");
    // Transação do arquivo: trabalha numa cópia e só "confirma" no fim (erro/cancelamento = nada fica).
    const work = JSON.parse(JSON.stringify(sim.dbs[dbn] || {}));
    let cancelled = false;
    if (opts.signal) opts.signal.addEventListener('abort', () => { cancelled = true; }, { once: true });
    if (sim.slowFile === name) await new Promise((r) => setTimeout(r, 300));
    const adapter = {
      async getColumns(t) { return work[t] ? [...work[t].columns] : null; },
      async createTable(t, cols) { work[t] = { columns: [...cols], rows: [] }; },
      async addColumns(t, cols) { for (const c of cols) { work[t].columns.push(c); for (const r of work[t].rows) r.push(null); } },
      async insert(t, cols, rows) { const pos = new Map(work[t].columns.map((c, i) => [c, i])); for (const row of rows) { const o = new Array(work[t].columns.length).fill(null); cols.forEach((c, i) => { o[pos.get(c)] = row[i]; }); work[t].rows.push(o); } return rows.length; },
    };
    const r = await S.importFile(adapter, { filePath: args.input.filePath, expectedSha: args.input.expectedSha, settings: args.input.settings, isCancelled: () => cancelled, onProgress: (i) => opts.onProgress && opts.onProgress(0, 0, i) });
    sim.dbs[dbn] = work;
    return r;
  }
  throw new Error(`op inesperada ${op}`);
};

db.assertReachable = async () => {}; // conexões de teste (192.0.2.x) não existem na rede: a rede é coberta em test/db-network.test.js

const base = `http://localhost:${PORT}`;
const api = async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Origin: base }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const B = '/api/tools/bt-importer';
const waitJob = async (id) => { for (let i = 0; i < 400; i++) { const j = (await api('GET', `${B}/jobs/${id}`)).json; if (j.status !== 'running') return j; await new Promise((r) => setTimeout(r, 25)); } throw new Error('job não terminou'); };
const validate = async (connectionId, files, options) => { const r = await api('POST', `${B}/validate`, { connectionId, files, options }); assert.equal(r.status, 200, JSON.stringify(r.json)); return waitJob(r.json.jobId); };
const run = async (plan, extra = {}) => { const r = await api('POST', `${B}/plans/${plan.planId}/execute`, { hash: plan.hash, authorized: true, ...extra }); if (r.status !== 200) return r; return { status: 200, job: await waitJob(r.json.jobId) }; };
const reset = () => Object.assign(sim, { dbs: {}, canCreateDatabase: true, perms: { canCreateTable: true, canInsert: true, canAlter: true }, precheckError: null, failFile: null, slowFile: null, calls: [] });
const f = (name, database) => ({ path: path.join(dir, name), database });

let local; let prod;
test('setup: conexões cadastradas (local Windows e produção com senha DPAPI)', async () => {
  local = (await api('POST', '/api/connections', { name: 'SQL Desenvolvimento', env: 'local', server: 'localhost', auth: 'windows' })).json;
  prod = (await api('POST', '/api/connections', { name: 'Prod Exemplo', env: 'prod', server: '192.0.2.10', auth: 'sql', user: 'usuario', password: 'Senha-Ficticia-987' })).json;
  assert.ok(local.id && prod.id);
});

test('ferramentas: registro lista o Importador BT e ele aparece em /api/tools', async () => {
  const r = await api('GET', '/api/tools');
  assert.equal(r.status, 200);
  const t = r.json.find((x) => x.id === 'bt-importer');
  assert.ok(t && t.name.includes('BT') && t.permissions.length);
  assert.equal(t.api, undefined, 'só metadados públicos');
});

test('origem: um arquivo, vários arquivos, diretório (sem e com subpastas); só .bt; nome padrão MIGRA_<ARQUIVO>', async () => {
  const one = await api('POST', `${B}/list`, { paths: [path.join(dir, 'CLIENTES_01.bt')] });
  assert.deepEqual(one.json.files.map((x) => [x.name, x.database]), [['CLIENTES_01.bt', 'MIGRA_CLIENTES_01']]);
  const many = await api('POST', `${B}/list`, { paths: [path.join(dir, 'CLIENTES_01.bt'), path.join(dir, 'ESPECIAIS.bt'), path.join(dir, 'CLIENTES_01.bt')] });
  assert.equal(many.json.files.length, 2, 'repetido entra uma vez');
  const flat = await api('POST', `${B}/list`, { dir });
  assert.deepEqual(flat.json.files.map((x) => x.name), ['CLIENTES_01.bt', 'CLIENTES_02.bt', 'ESPECIAIS.bt'], 'sem subpastas e sem .txt');
  const rec = await api('POST', `${B}/list`, { dir, recursive: true });
  assert.ok(rec.json.files.some((x) => x.rel === path.join('sub', 'HIST_03.bt')));
  assert.equal((await api('POST', `${B}/list`, { paths: [path.join(dir, 'notas.txt')] })).status, 400);
  assert.equal((await api('POST', `${B}/list`, { paths: ['relativo.bt'] })).status, 400);
  assert.equal((await api('POST', `${B}/list`, { dir: path.join(dir, 'nao-existe') })).json.code, 'BT_DIR_MISSING');
});

test('um arquivo: banco novo + tabelas novas → cria e importa; resumo, histórico e auditoria', async () => {
  reset();
  const v = await validate(local.id, [f('CLIENTES_01.bt', 'MIGRA_CLIENTES_01')], { onlyAllowed: true });
  assert.equal(v.status, 'done', v.error);
  assert.ok(v.result.canExecute);
  const g = v.result.groups[0];
  assert.equal(g.createDatabase, true);
  assert.deepEqual(g.tables.map((t) => [t.name, t.create, t.rows]), [['EPG', true, 3], ['EMP', true, 2]]);
  const r = await run(v.result);
  assert.equal(r.job.status, 'done');
  assert.deepEqual(r.job.result, { ...r.job.result, ok: 1, failed: 0, rows: 5 });
  assert.equal(sim.dbs.migra_clientes_01.EPG.rows.length, 3);
  assert.deepEqual(sim.dbs.migra_clientes_01.EPG.rows[0], ['001', 'Cliente Alfa', 'São Paulo']);
  const hist = (await api('GET', `${B}/history`)).json;
  assert.equal(hist[0].result, 'sucesso'); assert.equal(hist[0].rows, 5); assert.equal(hist[0].connection, 'SQL Desenvolvimento');
  assert.ok(sim.calls.includes('tool:bt-createdb'));
});

test('vários arquivos para o MESMO banco: tabelas somadas (append) e coluna nova acrescentada; agrupamento ignora caixa', async () => {
  reset();
  const v = await validate(local.id, [f('CLIENTES_01.bt', 'historico'), f('CLIENTES_02.bt', 'HISTORICO')]);
  assert.equal(v.result.groups.length, 1, 'um banco só (vale a 1ª grafia)');
  assert.equal(v.result.groups[0].database, 'historico');
  const epg = v.result.groups[0].tables.find((t) => t.name === 'EPG');
  assert.deepEqual([epg.files.length, epg.rows, epg.addColumns], [2, 253, ['STATUS']]);
  const r = await run(v.result);
  assert.equal(r.job.result.ok, 2);
  assert.equal(sim.dbs.historico.EPG.rows.length, 253);
  assert.deepEqual(sim.dbs.historico.EPG.columns, ['CODIGO', 'NOME', 'CIDADE', 'STATUS']);
  assert.deepEqual(r.job.result.databases, [{ database: 'historico', tables: [{ table: 'EMP', files: 2, rows: 3 }, { table: 'EPG', files: 2, rows: 253 }] }]);
});

test('arquivos com bancos diferentes: cada um no seu banco (não junta)', async () => {
  reset();
  const v = await validate(local.id, [f('CLIENTES_01.bt', 'cliente'), f('ESPECIAIS.bt', 'produto')]);
  assert.deepEqual(v.result.groups.map((g) => g.database), ['cliente', 'produto']);
  await run(v.result);
  assert.ok(sim.dbs.cliente.EPG && sim.dbs.produto.EST && !sim.dbs.cliente.EST);
});

test('tabela EXISTENTE: acrescenta sem apagar; estrutura diferente com "adicionar colunas" desligado bloqueia aquele destino', async () => {
  reset();
  sim.dbs.base_existente = { EPG: { columns: ['CODIGO', 'NOME', 'CIDADE'], rows: [['000', 'Antigo', null]] } };
  const ok = await validate(local.id, [f('CLIENTES_01.bt', 'BASE_EXISTENTE')]);
  assert.equal(ok.result.groups[0].createDatabase, false);
  assert.deepEqual(ok.result.groups[0].tables.map((t) => [t.name, t.existed, t.create]), [['EPG', true, false], ['EMP', false, true]]);
  await run(ok.result);
  assert.equal(sim.dbs.base_existente.EPG.rows.length, 4, 'registro antigo preservado + 3 novos');
  assert.deepEqual(sim.dbs.base_existente.EPG.rows[0], ['000', 'Antigo', null]);

  const blocked = await validate(local.id, [f('CLIENTES_02.bt', 'BASE_EXISTENTE')], { addMissingColumns: false });
  assert.equal(blocked.result.canExecute, false);
  assert.match(blocked.result.items[0].reasons.join(' '), /STATUS.*não existem/);
  assert.equal((await run(blocked.result)).json.code, 'BT_BLOCKED', 'servidor recusa mesmo que a tela tente');
});

test('tabela existente incompatível: coluna NOT NULL sem padrão ausente no arquivo ou identity no arquivo → bloqueia', async () => {
  reset();
  const col = (name, extra = {}) => ({ name, nullable: true, identity: false, computed: false, hasDefault: false, type: 'nvarchar', ...extra });
  sim.dbs.rigida = { EPG: { columns: ['CODIGO', 'NOME', 'CIDADE', 'OBRIG'], rows: [], meta: [col('CODIGO', { identity: true, nullable: false }), col('NOME'), col('CIDADE'), col('OBRIG', { nullable: false })] } };
  const v = await validate(local.id, [f('CLIENTES_01.bt', 'rigida')]);
  assert.equal(v.result.canExecute, false);
  const why = v.result.items[0].reasons.join(' ');
  assert.match(why, /OBRIG \(NOT NULL sem padrão\)/);
  assert.match(why, /CODIGO é identity/);
});

test('arquivo inválido (binário / sem blocos) bloqueia; vazio é pulado com aviso; nada começa parcialmente', async () => {
  reset();
  const bin = put('BINARIO.bt', 'MZ\u0000\u0001\u0002[EPG]\n');
  const none = put('SEM_BLOCO.bt', 'texto qualquer\nsem colchetes\n');
  const empty = put('VAZIO.bt', '');
  const v = await validate(local.id, [{ path: bin, database: 'x1' }, { path: none, database: 'x2' }, { path: empty, database: 'x3' }, f('CLIENTES_01.bt', 'x4')]);
  const st = Object.fromEntries(v.result.items.map((i) => [i.name, [i.status, (i.reasons[0] || i.warnings[0] || '').slice(0, 30)]]));
  assert.equal(st['BINARIO.bt'][0], 'blocked'); assert.match(st['BINARIO.bt'][1], /Arquivo inválido/);
  assert.equal(st['SEM_BLOCO.bt'][0], 'blocked'); assert.match(st['SEM_BLOCO.bt'][1], /Formato BT não reconhecido/);
  assert.equal(st['VAZIO.bt'][0], 'empty');
  assert.equal(v.result.canExecute, false, 'arquivos com problema impedem a importação até serem desmarcados');
  const v2 = await validate(local.id, [{ path: empty, database: 'x3' }, f('CLIENTES_01.bt', 'x4')]);
  assert.equal(v2.result.canExecute, true, 'vazio sozinho não bloqueia (é pulado, como no original)');
  const r = await run(v2.result);
  assert.equal(r.job.items.length, 1, 'só o arquivo com dados é executado');
});

test('nomes: troca individual, em lote ([ARQUIVO], prefixo/sufixo, nome único) e nomes inválidos / injection', async () => {
  assert.equal(P.applyPattern('PRE_[ARQUIVO]', 'HIST_01.bt'), 'PRE_HIST_01');
  assert.equal(P.applyPattern('[ARQUIVO]_SUF', 'hist 02.bt'), 'HIST_02_SUF');
  assert.equal(P.applyPattern('historico', 'qualquer.bt'), 'historico');
  for (const bad of ['', 'master', 'TempDB', 'x]; DROP DATABASE y--', "a'b", 'a;b', 'a{b}', '-começa', 'x'.repeat(129), 'a\u0001b']) assert.ok(P.dbNameError(bad), `aceitou "${bad}"`);
  for (const good of ['MIGRA_A', 'historico', 'Banco 2026', 'ação.teste-1']) assert.equal(P.dbNameError(good), null, good);
  reset();
  const v = await validate(local.id, [f('CLIENTES_01.bt', 'x]; DROP DATABASE y--'), f('ESPECIAIS.bt', 'ok_db')]);
  assert.equal(v.result.items[0].status, 'blocked');
  assert.equal(v.result.canExecute, false);
  assert.ok(!sim.calls.includes('tool:bt-createdb'));
});

test('injection em nome de tabela/coluna vindo do arquivo: sempre entre colchetes com ]] e valores só como parâmetros', async () => {
  const sql = []; const inputs = [];
  const fakeReq = () => { const r = { input: (n, t, v) => { inputs.push(v); return r; }, query: async (q) => { sql.push(q); return { recordset: [], rowsAffected: [q.split('),(').length] }; }, batch: async (q) => { sql.push(q); return {}; } }; return r; };
  const h = { sql: { Request: function Req() { return fakeReq(); }, NVarChar: () => 'nv', MAX: -1 } };
  const ad = S.sqlAdapter(h, {});
  await ad.createTable('T]; DROP TABLE x--', ['c]1', "c'2"]);
  await ad.addColumns('T]; DROP TABLE x--', ['novo]']);
  const n = await ad.insert('T]; DROP TABLE x--', ['c]1', "c'2"], [["'); DROP TABLE y;--", null]]);
  assert.equal(n, 1);
  assert.equal(sql[0], "CREATE TABLE [dbo].[T]]; DROP TABLE x--] ([c]]1] NVARCHAR(MAX) NULL, [c'2] NVARCHAR(MAX) NULL)");
  assert.equal(sql[1], 'ALTER TABLE [dbo].[T]]; DROP TABLE x--] ADD [novo]]] NVARCHAR(MAX) NULL');
  assert.equal(sql[2], "INSERT INTO [dbo].[T]]; DROP TABLE x--] ([c]]1], [c'2]) VALUES (@bt0, @bt1)");
  assert.deepEqual(inputs, ["'); DROP TABLE y;--", null], 'valor do arquivo nunca entra no texto do SQL');
  assert.throws(() => S.assertGenerated('insert', 'INSERT INTO [dbo].[t] ([a]) VALUES (@p0); DROP TABLE x'), /trava de segurança/);
  assert.throws(() => S.assertGenerated('create', 'CREATE TABLE [dbo].[t] ([a] INT)'), /trava de segurança/);
  // Muitas colunas: nunca passa de 2000 parâmetros por comando.
  assert.equal(S.rowsPerInsert(3), 666); assert.equal(S.rowsPerInsert(1), 1000); assert.equal(S.rowsPerInsert(5000), 1);
});

test('falha de conexão na validação: mensagem clara, sem plano', async () => {
  reset();
  sim.precheckError = 'Login failed for user.';
  const v = await validate(local.id, [f('CLIENTES_01.bt', 'a')]);
  assert.equal(v.status, 'error');
  assert.match(v.error, /^Falha de conexão com “SQL Desenvolvimento”: Login failed/);
  assert.equal(v.result, undefined);
});

test('falha no meio do lote: só o arquivo com erro é desfeito, os outros seguem; erro sem dados no log; "parar no erro" pula o resto', async () => {
  reset();
  sim.failFile = 'CLIENTES_02.bt';
  const v = await validate(local.id, [f('CLIENTES_01.bt', 'h'), f('CLIENTES_02.bt', 'h'), f('ESPECIAIS.bt', 'h')]);
  const r = await run(v.result);
  assert.deepEqual(r.job.items.map((i) => i.status), ['done', 'error', 'done']);
  assert.match(r.job.items[1].error, /^Arquivo 2 de 3 falhou: .* nada deste arquivo ficou no banco/);
  assert.equal(sim.dbs.h.EPG.rows.length, 3, 'nada do arquivo que falhou');
  const audit = fs.readFileSync(path.join(tmp, 'data', 'audit.log'), 'utf8');
  assert.ok(audit.includes('bt-arquivo-falhou'));
  assert.ok(!audit.includes('SEGREDO-DO-REGISTRO'), 'valor do registro não vai para a auditoria');
  assert.equal((await api('GET', `${B}/history`)).json[0].result, 'com falhas');

  reset();
  sim.failFile = 'CLIENTES_01.bt';
  const v2 = await validate(local.id, [f('CLIENTES_01.bt', 'h'), f('ESPECIAIS.bt', 'h')], { stopOnError: true });
  const r2 = await run(v2.result);
  assert.deepEqual(r2.job.items.map((i) => i.status), ['error', 'skipped']);
});

test('cancelamento: arquivo em andamento desfeito, seguintes não executados, histórico "cancelada"', async () => {
  reset();
  sim.slowFile = 'CLIENTES_01.bt';
  const v = await validate(local.id, [f('CLIENTES_01.bt', 'c'), f('ESPECIAIS.bt', 'c')]);
  const start = await api('POST', `${B}/plans/${v.result.planId}/execute`, { hash: v.result.hash, authorized: true });
  await new Promise((r) => setTimeout(r, 50));
  await api('POST', `${B}/jobs/${start.json.jobId}/cancel`);
  const j = await waitJob(start.json.jobId);
  assert.equal(j.status, 'cancelled');
  assert.deepEqual(j.items.map((i) => i.status), ['cancelled', 'cancelled']);
  assert.deepEqual(Object.keys(sim.dbs.c), [], 'nenhuma tabela ficou');
  assert.equal((await api('GET', `${B}/history`)).json[0].result, 'cancelada');
});

test('segurança do plano: uso único, hash, conexão não cadastrada, arquivo alterado depois da validação', async () => {
  reset();
  assert.equal((await api('POST', `${B}/validate`, { connectionId: 'inexistente', files: [f('CLIENTES_01.bt', 'a')] })).json.code, 'BT_NO_CONNECTION');
  const v = await validate(local.id, [f('CLIENTES_01.bt', 'a')]);
  assert.equal((await api('POST', `${B}/plans/${v.result.planId}/execute`, { hash: 'x', authorized: true })).status, 400);
  assert.equal((await api('POST', `${B}/plans/${v.result.planId}/execute`, { hash: v.result.hash })).status, 400, 'exige authorized');
  assert.equal((await run(v.result)).status, 200);
  assert.equal((await run(v.result)).json.code, 'BT_PLAN_EXPIRED', 'uso único');
  // Arquivo alterado entre validar e importar: o hash do conteúdo não bate e o arquivo é desfeito.
  const p = put('MUDA.bt', '[EPG]\n[A:s]\n1\n');
  const v2 = await validate(local.id, [{ path: p, database: 'muda' }]);
  fs.appendFileSync(p, '2\n');
  const r2 = await run(v2.result);
  assert.equal(r2.job.items[0].status, 'error');
  assert.match(r2.job.items[0].error, /mudou depois da validação/);
  assert.equal(sim.dbs.muda.EPG, undefined);
});

test('permissões: sem CREATE ANY DATABASE / INSERT bloqueia; produção exige confirmação explícita (409 BT_CONFIRM)', async () => {
  reset();
  sim.canCreateDatabase = false;
  const v = await validate(local.id, [f('CLIENTES_01.bt', 'novo')]);
  assert.match(v.result.items[0].reasons.join(' '), /CREATE ANY DATABASE/);
  reset();
  sim.dbs.existe = {};
  sim.perms.canInsert = false;
  const v2 = await validate(local.id, [f('CLIENTES_01.bt', 'existe')]);
  assert.match(v2.result.items[0].reasons.join(' '), /INSERT/);
  reset();
  const v3 = await validate(prod.id, [f('CLIENTES_01.bt', 'prod_db')]);
  const first = await run(v3.result);
  assert.equal(first.status, 409);
  assert.equal(first.json.code, 'BT_CONFIRM');
  assert.match(first.json.error, /PRODUÇÃO/);
  assert.ok(!sim.dbs.prod_db, 'nada executado antes de confirmar');
  const ok = await run(v3.result, { confirmed: true });
  assert.equal(ok.job.status, 'done');
});

test('credenciais nunca em log/histórico/respostas; senha só vai ao processo do banco', async () => {
  const audit = fs.readFileSync(path.join(tmp, 'data', 'audit.log'), 'utf8');
  const hist = JSON.stringify((await api('GET', `${B}/history`)).json);
  for (const text of [audit, hist]) {
    assert.ok(!text.includes('Senha-Ficticia-987'));
    assert.ok(!/passwordEnc|Password=|PWD=/i.test(text));
  }
  assert.ok(sim.passwords.includes('Senha-Ficticia-987'), 'a senha aberta pelo DPAPI chega só ao processo-filho');
  const persisted = JSON.stringify(store.data.tools);
  assert.ok(!persisted.includes('Senha-Ficticia-987') && !persisted.includes('Cliente Alfa'), 'histórico sem senha e sem conteúdo dos arquivos');
});

test('configurações: lista de tabelas administrável, validação dos valores e restaurar o padrão do original', async () => {
  const r = await api('PUT', `${B}/settings`, { allowedTables: 'EPG, EMP\nEST', batchSize: 1000, onlyAllowed: true });
  assert.deepEqual(r.json.settings.allowedTables, ['EPG', 'EMP', 'EST']);
  assert.equal((await api('PUT', `${B}/settings`, { batchSize: 10 })).status, 400);
  assert.equal((await api('PUT', `${B}/settings`, { namePattern: 'master' })).status, 400);
  reset();
  const v = await validate(local.id, [f('ESPECIAIS.bt', 'cfg')]);
  assert.deepEqual(v.result.items[0].tables.filter((t) => t.included).map((t) => t.name), ['EST'], 'TB_MOT_DES ficou fora da lista');
  const back = await api('PUT', `${B}/settings`, P.DEFAULT_SETTINGS);
  assert.deepEqual(back.json.settings.allowedTables, P.DEFAULT_ALLOWED_TABLES);
});

test('dados persistidos: ensureData idempotente e não sobrescreve o que o usuário configurou', () => {
  const d = { tools: { btImporter: { settings: { batchSize: 2000, allowedTables: ['X'] }, history: [{ at: 'x' }] } } };
  P.ensureData(d); P.ensureData(d);
  assert.equal(d.tools.btImporter.settings.batchSize, 2000);
  assert.deepEqual(d.tools.btImporter.settings.allowedTables, ['X']);
  assert.equal(d.tools.btImporter.history.length, 1);
  assert.equal(d.tools.btImporter.settings.addMissingColumns, true);
  const e = {}; P.ensureData(e);
  assert.deepEqual(e.tools.btImporter.settings, P.DEFAULT_SETTINGS);
});

test('arquivo grande: leitura em streaming (lotes, sem carregar tudo) e o mesmo resultado', async () => {
  const big = path.join(tmp, 'GRANDE.bt');
  const fd = fs.openSync(big, 'w');
  fs.writeSync(fd, '[EPG]\r\n[CODIGO:s;NOME:s;CIDADE:s;OBS:s]\r\n');
  const ROWS = 300000;
  let chunk = '';
  for (let i = 1; i <= ROWS; i++) { chunk += `${i}|Nome ${i}|Cidade ${i % 50}|observação $E7 ${'x'.repeat(60)}|\r\n`; if (chunk.length > 1 << 20) { fs.writeSync(fd, Buffer.from(chunk, 'latin1')); chunk = ''; } }
  fs.writeSync(fd, Buffer.from(chunk, 'latin1')); fs.closeSync(fd);
  const size = fs.statSync(big).size;
  assert.ok(size > 25 * 1024 * 1024);
  const sc = await scanFile(big, { isAllowed: () => true });
  assert.equal(sc.tables[0].rows, ROWS);
  let maxBatch = 0; let total = 0; let readBytes = 0; let firstBatchAt = null;
  await parseFile(big, { isAllowed: () => true, batchSize: 5000, onChunk: (n) => { readBytes = n; },
    onBatch: async (t, cols, rows) => { if (firstBatchAt === null) firstBatchAt = readBytes; maxBatch = Math.max(maxBatch, rows.length); total += rows.length; } });
  assert.equal(total, ROWS);
  assert.equal(maxBatch, 5000, 'no máximo batchSize linhas em memória por vez');
  assert.ok(firstBatchAt < size / 10, `o 1º lote é gravado com ${Math.round(firstBatchAt / 1e6)} MB lidos de ${Math.round(size / 1e6)} MB (streaming, não lê tudo antes)`);
});

test('modo local: tudo roda sem rede externa (conexão localhost) e sem enviar arquivo para fora', async () => {
  reset();
  const v = await validate(local.id, [f('CLIENTES_01.bt', 'loc')]);
  assert.equal(v.result.target.env, 'local');
  const r = await run(v.result);
  assert.equal(r.status, 200, 'local não pede confirmação');
  assert.equal(r.job.status, 'done');
  // O conteúdo dos arquivos não fica guardado no app (nem no projects.json nem em pastas de dados).
  const saved = fs.readFileSync(path.join(tmp, 'data', 'projects.json'), 'utf8');
  assert.ok(!saved.includes('Cliente Alfa'));
});
