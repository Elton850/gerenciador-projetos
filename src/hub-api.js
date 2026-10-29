// Hub de Dados — rotas /api/hub/* e /api/projects/:id/hub/*.
// Arquitetura: canal do Drive = atualizações do app (inalterado) · banco compartilhado = dados de projeto vindos da planilha · local = todo o
// resto (conexões, senhas, horas, checklists, evidências…). Para o banco só vai o que já está na planilha; nada local é enviado.
// A connection string fica protegida pela DPAPI em settings.hub.passwordEnc (só esta máquina/usuário a abre; o backup a trata como as senhas
// das conexões). A tela recebe só o host.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { uid, httpError, str } = require('./util');
const sheet = require('./hub-sheet');
const rules = require('./hub');
const cycles = require('./cycles');
const projectCancel = require('./project-cancel');

let DB = require('./hub-db');
function setDb(x) { DB = x; } // testes: banco simulado (mesma interface de src/hub-db.js)

const LIST_TTL_MS = 3 * 60 * 1000;

function mount(app, { store, audit, getProject, publicProject, protect, unprotect, whoAmI }) {
  const cfg = () => store.data.settings.hub || null;
  let opened = null; // { blob, url } — connection string aberta só em memória (evita um PowerShell por consulta)
  let cache = null; // { at, list }
  let inflight = null;

  async function hubUrl() {
    const c = cfg();
    if (!c?.passwordEnc) throw httpError(409, 'O banco do Hub de Dados ainda não foi configurado nesta máquina (Hub de Dados → Conexão).', { code: 'HUB_NOT_CONFIGURED' });
    if (opened?.blob === c.passwordEnc) return opened.url;
    try {
      opened = { blob: c.passwordEnc, url: await unprotect(c.passwordEnc) };
    } catch (e) {
      if (e.code !== 'PASSWORD_UNREADABLE') throw e;
      throw httpError(409, 'Não foi possível ler a connection string do Hub salva neste usuário do Windows (foi protegida em outro computador/usuário). Cadastre-a novamente em Hub de Dados → Conexão.', { code: 'PASSWORD_UNREADABLE' });
    }
    return opened.url;
  }

  // ---------- Conexão ----------
  app.get('/api/hub', (req, res) => {
    const c = cfg();
    res.json({ configured: !!c?.passwordEnc, host: c?.host || null, savedAt: c?.savedAt || null });
  });

  // Salva só depois de conectar com sucesso (TLS verificado e tabelas do Hub presentes).
  app.put('/api/hub/config', async (req, res) => {
    const url = str(req.body.url, 2000);
    const info = DB.parseUrl(url);
    if (!info) throw httpError(400, 'Informe a connection string do Postgres (postgresql://usuário:senha@host:5432/postgres) — no Supabase: Connect → Session pooler.');
    const test = await DB.testConnection(url);
    if (!test.tables.projetos || !test.tables.tarefas || !test.tables.marcos_projeto || !test.tables.sincronizacoes) {
      throw httpError(400, 'Conectou, mas as tabelas do Hub (projetos, tarefas, marcos_projeto, sincronizacoes) não existem neste banco. Rode docs/HUB-DADOS-schema.sql no banco antes.');
    }
    store.data.settings.hub = { passwordEnc: await protect(url), host: info.host, savedAt: new Date().toISOString() };
    store.save();
    opened = null; cache = null;
    audit.log({ action: 'hub-configurado', server: info.host, by: whoAmI() });
    res.json({ ok: true, host: info.host, test });
  });
  app.delete('/api/hub/config', (req, res) => {
    const host = cfg()?.host || null;
    delete store.data.settings.hub;
    store.save();
    opened = null; cache = null;
    audit.log({ action: 'hub-desconfigurado', server: host, by: whoAmI() });
    res.json({ ok: true });
  });
  app.post('/api/hub/test', async (req, res) => {
    res.json({ ...(await DB.testConnection(await hubUrl())), host: cfg().host });
  });

  // ---------- Planilha → banco ----------
  // mode: validate (só lê a planilha) · simulate (faz tudo no banco e desfaz) · sync (grava; exige authorized: true, vindo da confirmação na tela).
  app.post('/api/hub/sheet', async (req, res) => {
    const mode = ['validate', 'simulate', 'sync'].includes(req.body.mode) ? req.body.mode : 'validate';
    const file = path.resolve(str(req.body.filePath, 600));
    if (!/\.xlsx$/i.test(file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw httpError(400, 'Selecione a planilha do Hub de Dados (.xlsx).');
    if (mode === 'sync' && req.body.authorized !== true) throw httpError(403, 'Autorização explícita ausente.');
    const buf = fs.readFileSync(file);
    if (buf.subarray(0, 2).toString('latin1') !== 'PK') throw httpError(400, 'O arquivo selecionado não é um .xlsx válido.');
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const dados = await sheet.lerPlanilha(file);
    const lidos = { projetos: dados.projetos.length, tarefas: dados.tarefas.length, marcos_projeto: dados.marcos.length };
    const arquivo = path.basename(file);
    if (mode === 'validate') {
      audit.log({ action: 'hub-planilha-validada', arquivo, sha256, ...lidos, avisos: dados.avisos.length, by: whoAmI() });
      return res.json({ mode, arquivo, lidos, resumo: null, avisos: dados.avisos });
    }
    const url = await hubUrl();
    const meta = { arquivo, sha256, server: cfg().host, by: whoAmI() };
    try {
      const r = await DB.syncSheet(url, dados, { dryRun: mode === 'simulate', usuario: whoAmI(), arquivo, sha256 });
      if (mode === 'sync') cache = null; // a lista de projetos do banco mudou
      audit.log({ action: mode === 'sync' ? 'hub-planilha-sincronizada' : 'hub-planilha-simulada', ...meta, ...lidos, resultado: mode === 'sync' ? 'COMMIT' : 'ROLLBACK (simulação)', resumo: r.resumo, avisos: r.avisos.length });
      res.json({ mode, arquivo, lidos, resumo: r.resumo, avisos: r.avisos });
    } catch (e) {
      audit.log({ action: 'hub-planilha-falhou', ...meta, modo: mode, erro: e.message, resultado: 'ROLLBACK' });
      throw e;
    }
  });
  app.get('/api/hub/history', async (req, res) => {
    res.json({ history: await DB.history(await hubUrl(), Number(req.query.limit) || 20) });
  });

  // ---------- Projetos do banco × projetos locais ----------
  // Vinculado e o banco mudou desde a última vez → aplica sozinho (campos do banco; o resto do projeto não é tocado).
  function applyUpdates(list, { force = false, only = null } = {}) {
    const byId = new Map(list.map((r) => [r.hubId, r]));
    const applied = [];
    for (const p of store.data.projects) {
      if (!p.hub || (only && p.id !== only)) continue;
      const r = byId.get(p.hub.id);
      if (!r || (!force && r.updatedAt && r.updatedAt === p.hub.remoteUpdatedAt)) continue;
      const changes = rules.applyRemote(store.data, p, r, { uid });
      applied.push({ projectId: p.id, project: p.name, changes });
      if (changes.length) audit.log({ action: 'hub-atualizado', project: p.name, detalhe: changes.join(', '), automatico: !force });
    }
    if (applied.length) store.save();
    return applied;
  }
  async function remoteList(refresh) {
    if (!refresh && cache && Date.now() - cache.at < LIST_TTL_MS) return cache.list;
    if (!inflight) inflight = (async () => { try { const list = await DB.listProjects(await hubUrl()); cache = { at: Date.now(), list }; return list; } finally { inflight = null; } })();
    return inflight;
  }
  const findRemote = (list, hubId) => list.find((r) => r.hubId === String(hubId)) || (() => { throw httpError(404, 'Projeto não encontrado no banco do Hub.'); })();

  // Lista para a tela (barra lateral “no banco”, página do Hub). Sem banco configurado/alcançável: lista vazia + motivo (nunca quebra a tela).
  app.get('/api/hub/projects', async (req, res) => {
    if (!cfg()?.passwordEnc) return res.json({ configured: false, projects: [], applied: [] });
    let list;
    try { list = await remoteList(req.query.refresh === '1'); } catch (e) {
      return res.json({ configured: true, error: e.message, code: e.code || null, projects: [], applied: [] });
    }
    const applied = applyUpdates(list);
    const linked = new Map(store.data.projects.filter((p) => p.hub).map((p) => [p.hub.id, p]));
    res.json({ configured: true, host: cfg().host, at: new Date(cache?.at || Date.now()).toISOString(), applied: applied.filter((a) => a.changes.length),
      projects: list.map((r) => {
        const local = linked.get(r.hubId);
        const sug = local ? null : rules.suggestLocal(store.data.projects, r);
        return { ...r, localId: local?.id || null, suggestedLocalId: sug?.id || null, suggestedLocalName: sug?.name || null };
      }) });
  });

  // “Baixar” = criar o projeto nesta máquina a partir do banco (o projeto fica vinculado e recebe as atualizações do banco).
  app.post('/api/hub/projects/:hubId/download', async (req, res) => {
    const r = findRemote(await remoteList(true), req.params.hubId);
    const existing = store.data.projects.find((p) => p.hub?.id === r.hubId);
    if (existing) return res.json({ project: publicProject(existing), existed: true });
    const { p, changes } = rules.newProject(store.data, r, { uid });
    cycles.assignCycle(p, cycles.cycleFor(store.data, { projectTypeId: p.projectTypeId })); // ciclo do tipo, senão o padrão (como no cadastro)
    if (r.status === 'CANCELADO') projectCancel.cancelProject(p, { reason: 'Status CANCELADO na planilha do Hub de Dados.', by: whoAmI() });
    store.data.projects.push(p);
    store.save();
    audit.log({ action: 'hub-projeto-baixado', project: p.name, by: whoAmI(), detalhe: changes.join(', ') || null });
    res.json({ project: publicProject(p), existed: false });
  });

  app.post('/api/projects/:id/hub/link', async (req, res) => {
    const p = getProject(req.params.id);
    const r = findRemote(await remoteList(true), str(req.body.hubId, 30));
    const other = store.data.projects.find((x) => x.hub?.id === r.hubId && x.id !== p.id);
    if (other) throw httpError(409, `O projeto do banco “${r.nome}” já está vinculado a “${other.name}”.`, { code: 'HUB_LINKED' });
    const changes = rules.applyRemote(store.data, p, r, { uid });
    store.save();
    audit.log({ action: 'hub-vinculado', project: p.name, detalhe: `${r.nome}${changes.length ? ` · ${changes.join(', ')}` : ''}`, by: whoAmI() });
    res.json(publicProject(p));
  });
  app.post('/api/projects/:id/hub/unlink', (req, res) => {
    const p = getProject(req.params.id);
    if (!p.hub) throw httpError(400, 'Este projeto não está vinculado ao Hub de Dados.');
    const nome = p.hub.nome;
    p.hub = null; // os dados já trazidos ficam no projeto; ele só deixa de receber atualizações
    store.save();
    audit.log({ action: 'hub-desvinculado', project: p.name, detalhe: nome, by: whoAmI() });
    res.json(publicProject(p));
  });
  app.post('/api/projects/:id/hub/pull', async (req, res) => {
    const p = getProject(req.params.id);
    if (!p.hub) throw httpError(400, 'Este projeto não está vinculado ao Hub de Dados.');
    findRemote(await remoteList(true), p.hub.id);
    const a = applyUpdates(cache.list, { force: true, only: p.id })[0];
    res.json({ project: publicProject(p), changes: a ? a.changes : [] });
  });
  app.get('/api/projects/:id/hub/tasks', async (req, res) => {
    const p = getProject(req.params.id);
    if (!p.hub) throw httpError(400, 'Este projeto não está vinculado ao Hub de Dados.');
    res.json({ tasks: await DB.projectTasks(await hubUrl(), p.hub.id) });
  });
  // Tarefas de um projeto ainda não baixado (página “offline”), só leitura.
  app.get('/api/hub/projects/:hubId/tasks', async (req, res) => {
    res.json({ tasks: await DB.projectTasks(await hubUrl(), str(req.params.hubId, 30)) });
  });
}

module.exports = { mount, setDb };
