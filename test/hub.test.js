// Hub de Dados: leitura da planilha (formato original, três leiautes de aba), regras de mapeamento banco → projeto local
// e a API com um banco SIMULADO (nenhum Postgres real; a connection string de teste é fictícia). Dados todos fictícios.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ExcelJS = require('exceljs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-hub-'));
const PORT = 4477;
process.env.PORT = String(PORT);
process.env.GP_DATA_DIR = path.join(tmp, 'data');
process.env.GP_BACKUP_DIR = path.join(tmp, 'bk');

const { app, store } = require('../server');
const HubApi = require('../src/hub-api');
const sheet = require('../src/hub-sheet');
const rules = require('../src/hub');
const hubDb = require('../src/hub-db');

const URL_FAKE = 'postgresql://postgres.exemplo:senha-ficticia@db.exemplo.test:5432/postgres';
const DRIVE = 'https://drive.google.com/drive/folders/PastaExemplo123';
const calls = [];
let remote = [];
const fakeDb = {
  parseUrl: hubDb.parseUrl,
  testConnection: async (url) => { calls.push(['test', url]); return { ok: true, user: 'postgres', database: 'postgres', version: 'PostgreSQL 17', tables: { projetos: true, tarefas: true, marcos_projeto: true, sincronizacoes: true } }; },
  listProjects: async (url) => { calls.push(['list', url]); return JSON.parse(JSON.stringify(remote)); },
  syncSheet: async (url, dados, opts) => { calls.push(['sync', url, opts.dryRun, dados.projetos.length]); return { ok: true, dryRun: opts.dryRun, resumo: { projetos: { lidos: dados.projetos.length, inseridos: 1, atualizados: 0, inalterados: dados.projetos.length - 1, removidos: 0 }, tarefas: { lidos: dados.tarefas.length, inseridos: 0, atualizados: 0, inalterados: dados.tarefas.length, removidos: 0 }, marcos_projeto: { lidos: dados.marcos.length, inseridos: 0, atualizados: 0, inalterados: dados.marcos.length, removidos: 0 } }, avisos: dados.avisos }; },
  history: async () => [{ id: '1', em: '2026-10-01T12:00:00.000Z', por: 'analista', arquivo: 'hub.xlsx', resumo: {}, avisos: 0 }],
  projectTasks: async (url, hubId) => [{ codigo: '1', titulo: `Tarefa do ${hubId}`, status: 'Concluída' }],
};
HubApi.setDb(fakeDb);

let server;
test.before(() => { server = app.listen(PORT, '127.0.0.1'); });
test.after(() => { HubApi.setDb(require('../src/hub-db')); server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const base = `http://localhost:${PORT}`;
const api = async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Origin: base }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const ok = (r) => { assert.ok(r.status < 300, `HTTP ${r.status}: ${JSON.stringify(r.json)}`); return r.json; };

// ---------- Planilha fictícia no formato da original ----------
const XLSX = path.join(tmp, 'hub.xlsx');
async function buildSheet() {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('MODELO - MIGRAÇÃO FOLHA').addRows([['Tarefa', 'Prioridade'], ['0 - MODELO', 'BAIXA']]);
  const g = wb.addWorksheet('GERENCIAMENTO');
  g.addRow(['NOME DO PROJETO', 'COMPLEXIDADE', 'ESTADO', 'COORDENADOR', 'DATA REPASSE', 'Cloud', 'CRONOGRAMA', 'DESENVOLVIMENTO DE SCRIPT?', 'SISTEMA DE ORIGEM', 'SISTEMA DE DESTINO', 'ANALISTA', 'LINK DA PASTA DO PROJETO', 'PERCENTUAL DO EXECUTADO', 'ABA DO PROJETO', 'SEGMENTO DO PROJETO', 'STATUS DO PROJETO']);
  g.addRow(['CLIENTE ALFA - FOLHA', 3, 'CE', 'ANA COORDENADORA', new Date(Date.UTC(2026, 0, 15)), 'cloud totvs', null, 'SIM', 'FORTES', 'TOTVS RM', 'BRUNO ANALISTA', { text: 'TNE001 - CLIENTE ALFA', hyperlink: DRIVE }, { formula: "COUNTIF('ALFA - F - RM'!D2:D9,\"Concluída\")/COUNTA('ALFA - F - RM'!A2:A9)", result: 0.5 }, 'ALFA - F - RM', 'FOLHA', 'ATIVO']);
  g.addRow(['CLIENTE BETA - EDUCACIONAL', 9, '--', 'CARLA COORDENADORA', 'data errada', 'Lua', null, 'TALVEZ', 'SISTEMA X', 'TOTVS RM', 'BRUNO ANALISTA', null, null, 'BETA - EDU', 'EDUCACIONAL', 'STATUS INVENTADO']);
  g.addRow(['CLIENTE GAMA', 2, 'SP', null, null, null, null, 'NÃO', null, null, null, null, null, 'GAMA DUAS TRILHAS', 'FOLHA', 'CONCLUÍDO']);
  const m = wb.addWorksheet('MARCOS DOS PROJETOS');
  m.addRow(['NOME DO PROJETO', 'RESPONSÁVEL', 'DATA ENTREGA DE/PARA', 'CARGA EM HMG', 'CARGA EM HMG 2', 'CARGA EM PRD']);
  m.addRow(['CLIENTE ALFA - FOLHA', 'BRUNO ANALISTA', new Date(Date.UTC(2026, 1, 10)), '08/03/2026-10/03/2026', null, new Date(Date.UTC(2026, 4, 20))]);
  m.addRow(['PROJETO SEM CADASTRO', 'X', null, null, null, null]);
  const a = wb.addWorksheet('ALFA - F - RM'); // leiaute padrão
  a.addRow(['Tarefa', 'Prioridade', 'Recurso', 'Status', 'Data de início', 'Data de término', 'Marco', 'Link', 'SmartCliente HMG', 'SmartCliente PRD', 'Observações']);
  a.addRow(['0 - SOLICITAR BASE', 'baixa', 'Bruno', 'Concluída', new Date(Date.UTC(2026, 0, 20)), '25/01/2026', 'CARGA 1 HMG', null, null, null, 'ok']);
  a.addRow(['1 - ACESSOS', 'ALTA', null, 'Em execução']);
  a.addRow(['1 - ACESSOS DE NOVO', 'MÉDIA', null, 'Pausada']);
  a.addRow([null, 'BAIXA', null, 'Não iniciada']); // só valores padrão: ignorada
  a.addRow(['TAREFA SEM NÚMERO', null, null, null]);
  const b = wb.addWorksheet('BETA - EDU'); // leiaute com datas primeiro
  b.addRow(['Tarefa', 'Data de início', 'Data de término', 'Status', 'Prioridade', 'Recurso', 'Marco']);
  b.addRow(['2.1 - CARGA ALUNOS', new Date(Date.UTC(2026, 2, 1)), null, 'Concluída', 'ALTA', 'Carla']);
  const d = wb.addWorksheet('GAMA DUAS TRILHAS'); // leiaute de duas trilhas (14 colunas)
  d.addRow(['TAREFAS', 'Impacto', 'Recurso', 'Status A', 'Status B', 'Início A', 'Término A', 'Início B', 'Término B', 'Marco', 'Link', 'HMG', 'PRD', 'Observações']);
  d.addRow(['3 - CONFERIR', 'ALTA', 'Gama', 'Concluída', 'Bloqueada', null, null, new Date(Date.UTC(2026, 5, 1)), null, 'CARGA PRD', null, null, null, 'duas trilhas']);
  const o = wb.addWorksheet('ABA ORFA');
  o.addRow(['Tarefa', 'Prioridade']); o.addRow(['1 - SOLTA', 'BAIXA']);
  await wb.xlsx.writeFile(XLSX);
}

test('planilha: lê no formato original (3 leiautes), normaliza valores e avisa o que foge do padrão', async () => {
  await buildSheet();
  const d = await sheet.lerPlanilha(XLSX);
  assert.deepEqual(d.abasTarefas, ['ALFA - F - RM', 'BETA - EDU', 'GAMA DUAS TRILHAS', 'ABA ORFA'], 'abas MODELO ficam de fora');
  assert.equal(d.projetos.length, 3);
  const alfa = d.projetos[0];
  assert.equal(alfa.complexidade, 3); assert.equal(alfa.data_repasse, '2026-01-15'); assert.equal(alfa.ambiente, 'Cloud TOTVS'); assert.equal(alfa.desenvolve_script, true);
  assert.equal(alfa.pasta_projeto, 'TNE001 - CLIENTE ALFA', 'texto da célula (como o script original)');
  assert.equal(alfa.pasta_projeto_url, DRIVE, 'link da célula guardado à parte');
  assert.equal(alfa.aba_planilha, 'ALFA - F - RM', 'aba resolvida pela fórmula do %');
  const beta = d.projetos[1];
  assert.equal(beta.complexidade, null); assert.equal(beta.estado, null); assert.equal(beta.data_repasse, null); assert.equal(beta.ambiente, null);
  assert.equal(beta.desenvolve_script, null); assert.equal(beta.status_projeto, null); assert.equal(beta.aba_planilha, 'BETA - EDU', 'aba pela coluna ABA DO PROJETO');
  assert.equal(d.projetos[2].aba_planilha, 'GAMA DUAS TRILHAS');
  for (const w of ['complexidade \'9\' inválida', "data inválida 'data errada'", "valor 'Lua' fora da lista", "'TALVEZ' não é SIM/NÃO", "valor 'STATUS INVENTADO'", "status: valor 'Pausada'", "código '1' repetido", "Aba 'ABA ORFA' (1 tarefas) não pertence"]) {
    assert.ok(d.avisos.some((a) => a.includes(w)), `aviso esperado: ${w}\n${d.avisos.join('\n')}`);
  }
  const t = (aba, codigo) => d.tarefas.find((x) => x.aba === aba && x.codigo === codigo);
  assert.deepEqual([t('ALFA - F - RM', '0').prioridade, t('ALFA - F - RM', '0').data_inicio, t('ALFA - F - RM', '0').data_termino, t('ALFA - F - RM', '0').titulo], ['BAIXA', '2026-01-20', '2026-01-25', 'SOLICITAR BASE']);
  assert.equal(t('ALFA - F - RM', '1#2').titulo, 'ACESSOS DE NOVO', 'código repetido ganha #2');
  assert.ok(d.tarefas.some((x) => x.codigo.startsWith('~TAREFA SEM NUMERO')), 'sem número: código derivado do texto');
  assert.equal(d.tarefas.filter((x) => x.aba === 'ALFA - F - RM').length, 4, 'linha só com valores padrão é ignorada');
  assert.deepEqual([t('BETA - EDU', '2.1').data_inicio, t('BETA - EDU', '2.1').status, t('BETA - EDU', '2.1').recurso], ['2026-03-01', 'Concluída', 'Carla']);
  assert.deepEqual([t('GAMA DUAS TRILHAS', '3').status, t('GAMA DUAS TRILHAS', '3').status_2, t('GAMA DUAS TRILHAS', '3').data_inicio_2], ['Concluída', 'Bloqueada', '2026-06-01']);
  const marco = d.marcos[0];
  assert.deepEqual([marco.data_entrega_depara, marco.carga_hmg, marco.carga_prd, marco.observacao], ['2026-02-10', '2026-03-08', '2026-05-20', 'CARGA EM HMG: 08/03/2026-10/03/2026']);
  const av = [];
  sheet.resolverMarcos(d.marcos, { 'CLIENTE ALFA - FOLHA': '10' }, { add: (m) => av.push(m) });
  assert.equal(d.marcos[0].projeto_id, '10'); assert.ok(av[0].includes("'PROJETO SEM CADASTRO' não encontrado"));
});

test('planilha sem as abas do Hub é recusada com mensagem clara', async () => {
  const wb = new ExcelJS.Workbook(); wb.addWorksheet('Plan1').addRow(['x']);
  const f = path.join(tmp, 'outra.xlsx'); await wb.xlsx.writeFile(f);
  await assert.rejects(sheet.lerPlanilha(f), /Aba obrigatória 'GERENCIAMENTO'/);
});

test('similaridade igual à do difflib (casamento de nomes da aba MARCOS)', () => {
  assert.equal(sheet.ratio('ABCD', 'ABXD'), 0.75);
  assert.equal(sheet.ratio('ABCD', 'ABCD'), 1);
  assert.deepEqual(sheet.closeMatches('SESC REGIONAL 5 MINAS GERAIS', ['SESC REGIONAL 5 MINAS GERAIS X', 'OUTRO PROJETO']), ['SESC REGIONAL 5 MINAS GERAIS X']);
});

// ---------- Regras (puras) ----------
const R = (over = {}) => ({ hubId: '7', nome: 'CLIENTE ALFA - FOLHA', coordenador: 'ANA COORDENADORA', analista: 'BRUNO DA SILVA', status: 'ATIVO', segmento: 'FOLHA', sistemaOrigem: 'FORTES', sistemaDestino: 'TOTVS RM',
  pasta: 'TNE001', pastaUrl: DRIVE, marcos: { depara: '2026-02-10', hmg: '2026-03-08', hmg2: null, prd: '2026-05-20' }, tarefas: { total: 4, concluidas: 1, percentual: 25 }, updatedAt: '2026-10-01T10:00:00.000Z', ...over });

test('regras: nome normal, pessoa pelo primeiro nome (só se única), tipo pelo segmento', () => {
  assert.equal(rules.titleCase('BRUNO DA SILVA'), 'Bruno da Silva');
  const people = [{ id: 'a', name: 'Ana' }, { id: 'b', name: 'Carla' }, { id: 'c', name: 'Carla' }];
  assert.equal(rules.findPerson(people, 'ANA COORDENADORA').id, 'a');
  assert.equal(rules.findPerson(people, 'CARLA SOUZA'), null, 'primeiro nome ambíguo não casa');
  const data = { projectTypes: [{ id: 't1', name: 'TOTVS Educacional (Desenvolvimento)' }, { id: 't2', name: 'TOTVS Educacional' }, { id: 't3', name: 'TOTVS Folha de Pagamento' }] };
  assert.equal(rules.typeForSegment(data, 'EDUCACIONAL'), 't2'); assert.equal(rules.typeForSegment(data, 'FOLHA'), 't3'); assert.equal(rules.typeForSegment(data, 'BACK OFFICE'), null);
});

test('regras: baixar cria pessoa/origem que faltam, marcos viram prazos; atualizar só mexe nos campos do banco', () => {
  let n = 0; const uid = () => `id${++n}`;
  const data = { coordinators: [{ id: 'ana', name: 'Ana' }], originSystems: [], projectTypes: [{ id: 'folha', name: 'TOTVS Folha' }] };
  const { p, changes } = rules.newProject(data, R(), { uid, now: '2026-10-01T12:00:00.000Z' });
  assert.equal(p.coordinatorId, 'ana'); assert.equal(p.migrationAnalyst, 'Bruno da Silva'); assert.equal(p.projectTypeId, 'folha');
  assert.equal(data.originSystems[0].name, 'Fortes'); assert.equal(p.originSystemId, data.originSystems[0].id);
  assert.deepEqual([p.rootDirKind, p.rootDriveUrl], ['drive', DRIVE]);
  assert.deepEqual(p.milestones.map((m) => [m.hub, m.dueDate, m.done]), [['depara', '2026-02-10', false], ['hmg', '2026-03-08', false], ['prd', '2026-05-20', false]]);
  assert.ok(changes.includes('sistema de origem cadastrado: Fortes'));
  // local: usuário ajusta o que é só dele; banco muda a data do PRD e o analista
  p.checklists = [{ marker: 'local' }]; p.bases = [{ id: 'b' }]; p.milestones.push({ id: 'meu', title: 'Prazo meu', dueDate: '2026-07-01', done: false });
  p.milestones.find((m) => m.hub === 'hmg').done = true;
  const ch = rules.applyRemote(data, p, R({ analista: 'CARLOS NOVO', marcos: { depara: '2026-02-10', hmg: '2026-04-01', hmg2: '2026-04-15', prd: '2026-06-30' } }), { uid });
  assert.deepEqual(ch.sort(), ['analista de migração', 'prazo Carga em HMG 2', 'prazo Carga em PRD']);
  assert.equal(p.milestones.find((m) => m.hub === 'hmg').dueDate, '2026-03-08', 'prazo já entregue não muda');
  assert.equal(p.milestones.find((m) => m.hub === 'prd').dueDate, '2026-06-30');
  assert.deepEqual([p.checklists, p.bases, p.milestones.find((m) => m.id === 'meu').dueDate], [[{ marker: 'local' }], [{ id: 'b' }], '2026-07-01'], 'dados locais intactos');
  // pasta local preenchida não é trocada pelo link do Drive; projeto cancelado não tem prazos alterados
  Object.assign(p, { rootDirKind: 'local', rootDir: 'C:\\Projetos\\Alfa', cancelled: { at: 'x' } });
  rules.applyRemote(data, p, R({ marcos: { prd: '2027-01-01' } }), { uid });
  assert.equal(p.rootDir, 'C:\\Projetos\\Alfa'); assert.equal(p.milestones.find((m) => m.hub === 'prd').dueDate, '2026-06-30');
  // concluído no banco: marcos entram como entregues
  assert.ok(rules.newProject(data, R({ status: 'CONCLUÍDO' }), { uid }).p.milestones.every((m) => m.done));
});

// ---------- API (banco simulado) ----------
const S = {};
test('sem banco configurado: tudo como antes (lista vazia, nenhuma consulta)', async () => {
  assert.deepEqual(ok(await api('GET', '/api/hub')), { configured: false, host: null, savedAt: null });
  assert.deepEqual(ok(await api('GET', '/api/hub/projects')), { configured: false, projects: [], applied: [] });
  assert.equal((await api('POST', '/api/hub/test')).json.code, 'HUB_NOT_CONFIGURED');
  assert.equal(calls.length, 0);
  // analista de migração por projeto: padrão quando vazio, o do cadastro quando informado
  const p = ok(await api('POST', '/api/projects', { name: 'Cliente Local', rootDirKind: 'local', rootDir: '' }));
  assert.equal(p.migrationAnalystName, require('../src/team').MIGRATION_ANALYST.name);
  const p2 = ok(await api('PUT', `/api/projects/${p.id}`, { name: 'Cliente Local', rootDirKind: 'local', rootDir: '', migrationAnalyst: 'Analista Fictício' }));
  assert.equal(p2.migrationAnalystName, 'Analista Fictício');
  const p3 = ok(await api('PUT', `/api/projects/${p.id}`, { name: 'Cliente Local', rootDirKind: 'local', rootDir: '' }));
  assert.equal(p3.migrationAnalyst, 'Analista Fictício', 'quem não envia o campo não apaga o analista');
  S.local = p;
});

test('configurar: testa antes, guarda protegida (DPAPI) e a tela nunca recebe a connection string', async () => {
  assert.equal((await api('PUT', '/api/hub/config', { url: 'mysql://x' })).status, 400);
  const r = ok(await api('PUT', '/api/hub/config', { url: URL_FAKE }));
  assert.equal(r.host, 'db.exemplo.test');
  const saved = store.data.settings.hub;
  assert.ok(saved.passwordEnc && !saved.passwordEnc.includes('senha-ficticia'), 'gravada criptografada');
  const state = JSON.stringify(ok(await api('GET', '/api/state')));
  assert.ok(!state.includes(saved.passwordEnc) && !state.includes('senha-ficticia') && !state.includes('passwordEnc'), '/api/state não leva o segredo');
  assert.deepEqual(Object.keys(ok(await api('GET', '/api/hub'))).sort(), ['configured', 'host', 'savedAt']);
  const audit = fs.readFileSync(path.join(tmp, 'data', 'audit.log'), 'utf8');
  assert.ok(audit.includes('hub-configurado') && !audit.includes('senha-ficticia'), 'auditoria sem o segredo');
});

test('projetos do banco: não baixados aparecem com sugestão de vínculo; baixar cria o projeto local já ligado', async () => {
  remote = [R(), R({ hubId: '8', nome: 'Cliente Local', coordenador: null, analista: 'DIANA', marcos: null, pastaUrl: null, status: 'CANCELADO', updatedAt: '2026-10-01T10:00:00.000Z' })];
  const l = ok(await api('GET', '/api/hub/projects?refresh=1'));
  assert.deepEqual(l.projects.map((x) => [x.hubId, x.localId, x.suggestedLocalId]), [['7', null, null], ['8', null, S.local.id]]);
  const d = ok(await api('POST', '/api/hub/projects/7/download'));
  assert.equal(d.existed, false);
  const p = d.project;
  assert.deepEqual([p.name, p.hub.id, p.migrationAnalystName, p.rootDriveUrl, p.milestones.length, !!p.cycleId], ['CLIENTE ALFA - FOLHA', '7', 'Bruno da Silva', DRIVE, 3, true]);
  assert.ok(store.data.coordinators.some((c) => c.name === 'Ana Coordenadora'), 'coordenador inexistente vira pessoa cadastrada');
  assert.equal(ok(await api('POST', '/api/hub/projects/7/download')).existed, true, 'baixar de novo não duplica');
  S.alfa = p;
  const again = ok(await api('GET', '/api/hub/projects'));
  assert.equal(again.projects.find((x) => x.hubId === '7').localId, p.id);
});

test('banco mudou → projeto vinculado é atualizado sozinho (só campos do banco), com auditoria', async () => {
  remote[0] = R({ coordenador: 'ANA COORDENADORA', analista: 'ELISA NOVA', marcos: { depara: '2026-02-10', hmg: '2026-03-08', hmg2: null, prd: '2026-08-01' }, updatedAt: '2026-10-02T10:00:00.000Z' });
  const l = ok(await api('GET', '/api/hub/projects?refresh=1'));
  assert.deepEqual(l.applied.map((a) => [a.project, a.changes.sort()]), [['CLIENTE ALFA - FOLHA', ['analista de migração', 'prazo Carga em PRD']]]);
  const p = store.data.projects.find((x) => x.id === S.alfa.id);
  assert.equal(p.migrationAnalyst, 'Elisa Nova'); assert.equal(p.milestones.find((m) => m.hub === 'prd').dueDate, '2026-08-01');
  assert.equal(ok(await api('GET', '/api/hub/projects?refresh=1')).applied.length, 0, 'sem mudança no banco, nada é reaplicado');
  assert.ok(fs.readFileSync(path.join(tmp, 'data', 'audit.log'), 'utf8').includes('hub-atualizado'));
});

test('vincular projeto local existente, conflito de vínculo, atualizar, tarefas e desvincular', async () => {
  const p = ok(await api('POST', `/api/projects/${S.local.id}/hub/link`, { hubId: '8' }));
  assert.deepEqual([p.hub.id, p.migrationAnalystName, p.cancelled || null], ['8', 'Diana', null], 'vincular não cancela o projeto local');
  assert.equal((await api('POST', `/api/projects/${S.alfa.id}/hub/link`, { hubId: '8' })).json.code, 'HUB_LINKED');
  assert.ok(Array.isArray(ok(await api('POST', `/api/projects/${S.local.id}/hub/pull`)).changes));
  assert.equal(ok(await api('GET', `/api/projects/${S.local.id}/hub/tasks`)).tasks[0].titulo, 'Tarefa do 8');
  assert.equal(ok(await api('GET', '/api/hub/projects/7/tasks')).tasks[0].titulo, 'Tarefa do 7');
  const u = ok(await api('POST', `/api/projects/${S.local.id}/hub/unlink`));
  assert.deepEqual([u.hub, u.migrationAnalyst], [null, 'Diana'], 'desvincular mantém os dados trazidos');
  remote[1] = { ...remote[1], hubId: '9', nome: 'CLIENTE CANCELADO' };
  assert.ok(ok(await api('POST', '/api/hub/projects/9/download')).project.cancelled, 'status CANCELADO no banco → baixa como cancelado');
});

test('planilha pela API: validar sem banco, simular desfaz, sincronizar exige autorização', async () => {
  calls.length = 0;
  const v = ok(await api('POST', '/api/hub/sheet', { filePath: XLSX, mode: 'validate' }));
  assert.deepEqual([v.lidos.projetos, v.resumo, calls.length], [3, null, 0]);
  const s = ok(await api('POST', '/api/hub/sheet', { filePath: XLSX, mode: 'simulate' }));
  assert.equal(s.resumo.projetos.lidos, 3); assert.deepEqual(calls.at(-1).slice(2), [true, 3]);
  assert.equal((await api('POST', '/api/hub/sheet', { filePath: XLSX, mode: 'sync' })).status, 403);
  ok(await api('POST', '/api/hub/sheet', { filePath: XLSX, mode: 'sync', authorized: true }));
  assert.deepEqual(calls.at(-1).slice(2), [false, 3]);
  assert.equal(calls.at(-1)[1], URL_FAKE, 'a connection string aberta (DPAPI) só chega ao acesso ao banco');
  assert.equal((await api('POST', '/api/hub/sheet', { filePath: path.join(tmp, 'nao-existe.xlsx'), mode: 'validate' })).status, 400);
  assert.equal(ok(await api('GET', '/api/hub/history')).history.length, 1);
});

test('variável {{project.migration_analyst}} usa o analista do projeto', () => {
  const email = require('../src/email');
  const val = (project) => email.variableValues({ project, data: store.data, contacts: [] })['project.migration_analyst'];
  assert.equal(val({ migrationAnalyst: 'Elisa Nova', contacts: [] }), 'Elisa Nova');
  assert.equal(val({ migrationAnalyst: '', contacts: [] }), require('../src/team').MIGRATION_ANALYST.name);
});

test('remover a conexão: projetos baixados ficam; lista volta a vazia', async () => {
  ok(await api('DELETE', '/api/hub/config'));
  assert.equal(store.data.settings.hub, undefined);
  assert.deepEqual(ok(await api('GET', '/api/hub/projects')).projects, []);
  assert.ok(store.data.projects.some((p) => p.id === S.alfa.id));
});
