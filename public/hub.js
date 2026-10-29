'use strict';
// Hub de Dados (banco compartilhado): página #/hub (conexão, planilha → banco, projetos do banco, histórico), projetos “offline” na
// barra lateral (#/hub/<id>: no banco, mas não nesta máquina — pergunta se quer baixar) e o card do projeto vinculado (dados do banco
// e tarefas da planilha, só leitura). Regras no servidor: src/hub.js (mapeamento) · src/hub-api.js (rotas) · src/hub-db.js (banco).

const HUB = { data: null, at: 0, loading: null, asked: new Set(), tasks: new Map(), info: null };
const HUB_TASK_TONE = { 'Concluída': 'ok', 'Em execução': 'done', 'Bloqueada': 'overdue', 'Problemas': 'overdue' };

Object.assign(ACTION_LABEL, {
  'hub-configurado': 'Hub de Dados: conexão salva', 'hub-desconfigurado': 'Hub de Dados: conexão removida',
  'hub-planilha-validada': 'Hub de Dados: planilha validada (sem banco)', 'hub-planilha-simulada': 'Hub de Dados: sincronização simulada (desfeita)',
  'hub-planilha-sincronizada': 'Hub de Dados: planilha sincronizada no banco', 'hub-planilha-falhou': 'Hub de Dados: sincronização falhou (nada gravado)',
  'hub-projeto-baixado': 'Hub de Dados: projeto baixado', 'hub-vinculado': 'Hub de Dados: projeto vinculado', 'hub-desvinculado': 'Hub de Dados: projeto desvinculado',
  'hub-atualizado': 'Hub de Dados: projeto atualizado pelo banco',
});
// Atualizações do banco chegam sozinhas: a lista é relida a cada 5 min (o servidor guarda 3 min) e ao abrir o app.
setInterval(() => { if (HUB.data?.configured) hubLoad(); }, 5 * 60 * 1000);

async function hubLoad(force = false) {
  if (HUB.loading) return HUB.loading;
  if (!force && HUB.data && Date.now() - HUB.at < 60000) return HUB.data;
  HUB.loading = (async () => {
    try {
      HUB.data = await api('GET', `/api/hub/projects${force ? '?refresh=1' : ''}`, undefined, { timeoutMs: 60000 });
    } catch (e) { HUB.data = { configured: true, error: e.message, projects: [], applied: [] }; }
    HUB.at = Date.now();
    return HUB.data;
  })();
  const d = await HUB.loading;
  HUB.loading = null;
  if (d.applied?.length) {
    toast(`Hub de Dados: ${plural(d.applied.length, 'projeto atualizado', 'projetos atualizados')} com os dados do banco (${d.applied.map((a) => a.project).slice(0, 3).join(', ')}${d.applied.length > 3 ? '…' : ''}).`, 'ok');
    await refresh(); // estado novo dos projetos (redesenha tudo, inclusive a lateral)
    return d;
  }
  renderNav(route()); // lateral com os projetos “no banco”; a página aberta não é redesenhada (não perde o que está sendo digitado)
  const r = route();
  const slot = r.name === 'project' ? document.querySelector('[data-slot="hub"]') : null;
  const p = slot && state.projects.find((x) => x.id === r.id);
  if (p) slot.replaceChildren(hubProjectCard(p) || '');
  return d;
}
const hubOffline = () => (HUB.data?.projects || []).filter((x) => !x.localId);
const hubName = (s) => String(s || '').toLocaleLowerCase('pt-BR').replace(/(^|\s)(\p{L})/gu, (m, a, b) => a + b.toLocaleUpperCase('pt-BR'));

// Lateral: “No banco · não baixados” (recolhível) logo abaixo dos projetos desta máquina, com aspecto apagado.
function hubNavItems(r) {
  if (!HUB.data && !HUB.loading) setTimeout(() => hubLoad(), 0);
  const off = hubOffline();
  if (!off.length) return [];
  const open = uiPref('hubOffline', false);
  return [h('button', { type: 'button', class: 'nav-sep nav-sep-btn', 'aria-expanded': open ? 'true' : 'false', title: 'Projetos que estão no banco do Hub de Dados, mas não nesta máquina',
    onclick: () => { setUiPref('hubOffline', !open); renderNav(route()); } }, h('span', { class: 'grow' }, `No banco · não baixados (${off.length})`), icon(open ? 'chevronUp' : 'chevronDown', 12)),
  ...(open ? off.map((x) => h('button', { class: `nav-item offline${r.name === 'hub' && r.id === x.hubId ? ' active' : ''}`, title: `${x.nome} — no banco, não baixado nesta máquina. Clique para baixar.`, onclick: () => (location.hash = `#/hub/${x.hubId}`) },
    icon('cloud', 14), h('span', { class: 'grow' }, h('div', { class: 'name' }, x.nome), h('div', { class: 'hint' }, [x.analista ? hubName(x.analista) : null, x.status ? hubName(x.status) : null].filter(Boolean).join(' · '))))) : [])];
}

async function hubDownload(btn, x) {
  return busy(btn, async () => {
    const r = await api('POST', `/api/hub/projects/${x.hubId}/download`, {}, { timeoutMs: 60000 });
    HUB.data = null;
    await refresh();
    location.hash = `#/project/${r.project.id}`;
    toast(r.existed ? 'O projeto já estava nesta máquina.' : `Projeto “${r.project.name}” baixado: agora ele recebe as atualizações do banco.`, 'ok');
    hubLoad(true);
  }, 'Baixando…');
}
async function hubLink(btn, projectId, hubId) {
  return busy(btn, async () => {
    replaceProjectQuiet(await api('POST', `/api/projects/${projectId}/hub/link`, { hubId }, { timeoutMs: 60000 }));
    HUB.data = null;
    await refresh();
    toast('Projeto vinculado ao Hub de Dados.', 'ok');
    location.hash = `#/project/${projectId}`;
    hubLoad(true);
  }, 'Vinculando…');
}

// ---------- Página #/hub e #/hub/<id> ----------
async function renderHub(main, hubId) {
  if (hubId) return renderHubOffline(main, hubId);
  const page = h('div', { class: 'page' });
  main.append(page);
  let info;
  try { info = HUB.info = await api('GET', '/api/hub'); } catch (e) { return fail(e); }
  if (route().name !== 'hub' || route().id) return;
  const slotProjects = h('div', null, h('div', { class: 'empty' }, info.configured ? 'Consultando o banco…' : ''));
  page.replaceChildren(
    h('div', { class: 'page-head' }, h('div', { class: 'grow' }, h('h1', null, 'Hub de Dados'),
      h('div', { class: 'muted' }, 'Banco compartilhado dos projetos. A planilha de gerenciamento entra no banco por aqui, e cada projeto do banco pode ser baixado para esta máquina (e passa a receber as atualizações de lá). Conexões, senhas, horas, checklists e evidências continuam só nesta máquina.'))),
    hubConnCard(info), info.configured ? hubSheetCard() : null, info.configured ? slotProjects : null, info.configured ? hubHistoryCard() : null);
  if (!info.configured) return;
  const d = await hubLoad(false);
  if (route().name === 'hub' && !route().id) slotProjects.replaceChildren(hubProjectsCard(d));
}

function hubConnCard(info) {
  const test = (btn) => busy(btn, async () => {
    const r = await api('POST', '/api/hub/test', {}, { timeoutMs: 40000 });
    toast(`Conectado a ${r.host} (${r.version}). Tabelas do Hub: ${Object.values(r.tables).every(Boolean) ? 'ok' : 'faltando'}.`, 'ok');
  }, 'Testando…');
  return card('Conexão com o banco', h('div', { class: 'inline' },
    info.configured ? h('button', { class: 'btn sm', onclick: (e) => test(e.target) }, 'Testar') : null,
    h('button', { class: `btn sm${info.configured ? '' : ' primary'}`, onclick: () => hubConnForm(info) }, info.configured ? 'Trocar' : 'Configurar'),
    info.configured ? h('button', { class: 'btn sm', onclick: async (e) => {
      if (!(await confirmDialog({ title: 'Remover a conexão do Hub', message: 'A connection string sai desta máquina. Os projetos já baixados continuam aqui (só deixam de receber atualizações até você configurar de novo).', okText: 'Remover', danger: true }))) return;
      busy(e.target, async () => { await api('DELETE', '/api/hub/config'); HUB.data = null; render(); toast('Conexão do Hub removida.', 'ok'); });
    } }, 'Remover') : null),
  info.configured ? h('div', { class: 'stack' }, h('div', null, 'Servidor: ', h('strong', { class: 'mono' }, info.host)),
    h('span', { class: 'small muted' }, `Salva em ${fmtDateTime(info.savedAt)} · protegida pela criptografia do Windows (DPAPI) e nunca exibida. Conexão sempre com TLS verificado.`))
    : h('div', { class: 'empty' }, 'Nenhum banco configurado nesta máquina. Sem ele o app funciona como antes (só projetos locais).'));
}

function hubConnForm(info) {
  const url = h('input', { type: 'password', autocomplete: 'off', placeholder: 'postgresql://postgres.<projeto>:<senha>@aws-…pooler.supabase.com:5432/postgres' });
  const m = openModal({ title: info.configured ? 'Trocar a conexão do Hub' : 'Configurar o banco do Hub', size: 'md',
    body: [field('Connection string do Postgres', url, 'No Supabase: Connect → “Session pooler” (porta 5432). Senha com @ # / : % precisa estar codificada na URL. Fica só nesta máquina, protegida pela DPAPI; a tela nunca a mostra de novo.'),
      h('div', { class: 'hint' }, 'Antes de salvar, o app conecta (TLS verificado) e confere se as tabelas do Hub existem.')],
    footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'), h('button', { class: 'btn primary', onclick: (e) => busy(e.target, async () => {
      const r = await api('PUT', '/api/hub/config', { url: url.value }, { timeoutMs: 60000 });
      m.close(); HUB.data = null; toast(`Banco do Hub configurado (${r.host}).`, 'ok'); render();
    }, 'Conectando…') }, 'Salvar e testar')] });
  url.focus();
}

function hubSheetCard() {
  const file = pathField({ kind: 'file', title: 'Planilha do Hub de Dados (.xlsx)', filter: 'xlsx', placeholder: 'C:\\...\\GERENCIAMENTO DE PROJETOS - HUB DE DADOS.xlsx' });
  file.input.value = uiPref('hubSheetFile', '') || '';
  const out = h('div');
  const run = (btn, mode) => busy(btn, async () => {
    const filePath = file.get();
    if (!filePath) throw new Error('Escolha a planilha (.xlsx) baixada do Google Sheets.');
    if (mode === 'sync' && !(await confirmDialog({ title: 'Sincronizar com o banco compartilhado', okText: 'Sincronizar',
      message: 'Os projetos, tarefas e marcos desta planilha serão gravados no banco (o que mudou é atualizado; o que é novo é incluído). Nada é apagado do banco. Quem usa o mesmo banco passa a ver estes dados. Use “Simular” antes se tiver dúvida.' }))) return;
    setUiPref('hubSheetFile', filePath);
    const r = await api('POST', '/api/hub/sheet', { filePath, mode, authorized: mode === 'sync' }, { timeoutMs: 180000 });
    out.replaceChildren(hubSheetResult(r));
    if (mode === 'sync') { HUB.data = null; toast('Planilha sincronizada com o banco.', 'ok'); hubLoad(true); }
  }, mode === 'validate' ? 'Lendo…' : mode === 'simulate' ? 'Simulando…' : 'Sincronizando…');
  return card('Planilha → banco', null,
    h('div', { class: 'muted small' }, 'Envie a planilha “GERENCIAMENTO DE PROJETOS - HUB DE DADOS” do jeito que ela está (Google Sheets → Arquivo → Fazer download → .xlsx). Aba GERENCIAMENTO → projetos · MARCOS DOS PROJETOS → marcos · uma aba por projeto → tarefas.'),
    field('Planilha', file.el),
    h('div', { class: 'inline' },
      h('button', { class: 'btn', title: 'Só lê a planilha (sem banco)', onclick: (e) => run(e.target, 'validate') }, 'Validar'),
      h('button', { class: 'btn', title: 'Faz tudo no banco e desfaz no fim (nada fica gravado)', onclick: (e) => run(e.target, 'simulate') }, 'Simular'),
      h('button', { class: 'btn primary', title: 'Grava no banco compartilhado', onclick: (e) => run(e.target, 'sync') }, 'Sincronizar')),
    out);
}
function hubSheetResult(r) {
  const title = { validate: 'Planilha válida (nada foi enviado ao banco)', simulate: 'Simulação concluída — nada foi gravado', sync: 'Sincronização concluída' }[r.mode];
  const names = { projetos: 'Projetos', tarefas: 'Tarefas', marcos_projeto: 'Marcos' };
  return h('div', { class: `box ${r.mode === 'sync' ? 'ok-box' : ''}`, style: 'margin-top:10px' }, h('strong', null, `${title} · ${r.arquivo}`),
    h('table', { class: 'compact', style: 'margin-top:8px' }, h('thead', null, h('tr', null, h('th', null, 'Tabela'), h('th', { class: 'num' }, 'Lidos'),
      r.resumo ? [h('th', { class: 'num' }, 'Novos'), h('th', { class: 'num' }, 'Atualizados'), h('th', { class: 'num' }, 'Inalterados')] : null)),
    h('tbody', null, Object.keys(names).map((k) => h('tr', null, h('td', null, names[k]), h('td', { class: 'num' }, String(r.lidos[k] ?? 0)),
      r.resumo ? [h('td', { class: 'num' }, String(r.resumo[k].inseridos)), h('td', { class: 'num' }, String(r.resumo[k].atualizados)), h('td', { class: 'num' }, String(r.resumo[k].inalterados))] : null)))),
    r.avisos.length ? h('details', { style: 'margin-top:8px' }, h('summary', null, plural(r.avisos.length, 'aviso', 'avisos') + ' (valores fora do padrão viram vazio)'),
      h('ul', { class: 'small' }, r.avisos.map((a) => h('li', null, a)))) : h('div', { class: 'small muted', style: 'margin-top:6px' }, 'Nenhum aviso.'));
}

function hubProjectsCard(d) {
  if (d.error) return card('Projetos no banco', h('button', { class: 'btn sm', onclick: (e) => busy(e.target, () => hubLoad(true)) }, 'Tentar de novo'), h('div', { class: 'box bad' }, h('strong', null, 'Não foi possível consultar o banco. '), d.error));
  const q = h('input', { type: 'search', placeholder: 'Filtrar por projeto, analista ou coordenador…', style: 'flex:1;min-width:220px;max-width:380px' });
  const only = h('select', null, h('option', { value: '' }, 'Todos'), h('option', { value: 'off' }, 'Não baixados'), h('option', { value: 'on' }, 'Nesta máquina'));
  const body = h('tbody');
  const draw = () => {
    const t = q.value.trim().toLowerCase();
    const rows = d.projects.filter((x) => (!t || [x.nome, x.analista, x.coordenador].some((v) => String(v || '').toLowerCase().includes(t)))
      && (!only.value || (only.value === 'on') === !!x.localId));
    body.replaceChildren(...rows.map((x) => h('tr', { class: x.localId ? '' : 'hub-off-row' },
      h('td', null, h('strong', null, x.nome), x.segmento ? h('div', { class: 'small muted' }, [hubName(x.segmento), [x.sistemaOrigem, x.sistemaDestino].filter(Boolean).join(' → ')].filter(Boolean).join(' · ')) : null),
      h('td', null, x.analista ? hubName(x.analista) : '—'), h('td', null, x.coordenador ? hubName(x.coordenador) : '—'),
      h('td', null, x.status ? h('span', { class: 'pill' }, hubName(x.status)) : '—'),
      h('td', { class: 'num' }, x.tarefas.total ? `${x.tarefas.percentual}% de ${x.tarefas.total}` : '—'),
      h('td', null, x.localId ? h('button', { class: 'btn xs', onclick: () => (location.hash = `#/project/${x.localId}`) }, 'Abrir')
        : h('div', { class: 'inline' }, h('button', { class: 'btn xs primary', onclick: (e) => hubDownload(e.target, x) }, 'Baixar'),
          x.suggestedLocalId ? h('button', { class: 'btn xs', title: `Usar o projeto “${x.suggestedLocalName}” que já existe nesta máquina`, onclick: (e) => hubLink(e.target, x.suggestedLocalId, x.hubId) }, 'Vincular ao local') : null)))));
    if (!rows.length) body.append(h('tr', null, h('td', { colspan: 6, class: 'muted' }, 'Nada encontrado.')));
  };
  q.addEventListener('input', draw); only.addEventListener('change', draw);
  draw();
  const local = d.projects.filter((x) => x.localId).length;
  return card(['Projetos no banco', h('span', { class: 'muted small', style: 'font-weight:400' }, `  ${d.projects.length} · ${local} nesta máquina`)],
    h('button', { class: 'btn sm', title: 'Consultar o banco de novo', onclick: (e) => busy(e.target, () => hubLoad(true)) }, 'Atualizar'),
    h('div', { class: 'inline' }, q, only), h('div', { class: 'tablewrap', style: 'max-height:60vh' }, h('table', { class: 'compact' },
      h('thead', null, h('tr', null, h('th', null, 'Projeto'), h('th', null, 'Analista'), h('th', null, 'Coordenador'), h('th', null, 'Status'), h('th', { class: 'num' }, 'Tarefas concluídas'), h('th', null, ''))), body)),
    h('div', { class: 'hint' }, `Consultado em ${fmtDateTime(d.at)}. Baixar cria o projeto aqui (coordenador, analista, sistema de origem, tipo, pasta do Drive e marcos). Projetos vinculados recebem sozinhos o que mudar no banco.`));
}

function hubHistoryCard() {
  const slot = h('div', null, h('div', { class: 'empty' }, 'Carregando…'));
  api('GET', '/api/hub/history', undefined, { timeoutMs: 40000 }).then(({ history }) => slot.replaceChildren(history.length
    ? h('table', { class: 'compact' }, h('thead', null, h('tr', null, h('th', null, 'Quando'), h('th', null, 'Quem'), h('th', null, 'Arquivo'), h('th', null, 'Projetos · tarefas · marcos (novos/atualizados)'), h('th', { class: 'num' }, 'Avisos'))),
      h('tbody', null, history.map((x) => h('tr', null, h('td', null, fmtDateTime(x.em)), h('td', null, x.por || '—'), h('td', { class: 'small' }, x.arquivo || '—'),
        h('td', { class: 'small' }, ['projetos', 'tarefas', 'marcos_projeto'].map((k) => (x.resumo?.[k] ? `${x.resumo[k].inseridos}/${x.resumo[k].atualizados}` : '—')).join(' · ')),
        h('td', { class: 'num' }, String(x.avisos ?? 0))))))
    : h('div', { class: 'empty' }, 'Nenhuma sincronização registrada no banco.'))).catch((e) => slot.replaceChildren(h('div', { class: 'empty' }, `Histórico indisponível: ${e.message}`)));
  return card('Histórico de sincronizações (de todos que usam o banco)', null, slot);
}

// Projeto do banco que não está nesta máquina: aspecto “offline”, dados do banco só leitura e a pergunta “baixar?”.
async function renderHubOffline(main, hubId) {
  main.append(h('div', { class: 'page' }, h('div', { class: 'empty' }, 'Consultando o banco…')));
  const d = HUB.data || (await hubLoad(false));
  const r = route();
  if (r.name !== 'hub' || r.id !== hubId) return;
  const x = (d.projects || []).find((p) => p.hubId === hubId);
  if (!x) { main.replaceChildren(h('div', { class: 'page' }, card('Projeto do Hub', null, h('div', { class: 'empty' }, d.error ? `Banco indisponível: ${d.error}` : 'Projeto não encontrado no banco.')))); return; }
  if (x.localId) { location.hash = `#/project/${x.localId}`; return; }
  const download = (btn) => hubDownload(btn, x);
  main.replaceChildren(h('div', { class: 'page hub-offline' },
    h('div', { class: 'box warn' }, h('div', { class: 'inline' }, icon('cloud', 18), h('div', { class: 'grow stack' },
      h('strong', null, 'Projeto offline: está no banco do Hub de Dados, mas não nesta máquina.'),
      h('span', { class: 'small' }, 'Baixe para trabalhar nele aqui (ciclo, checklists, horas, bases…). Ele passa a receber as atualizações do banco.')),
    h('button', { class: 'btn primary', onclick: (e) => download(e.target) }, 'Baixar projeto'),
    x.suggestedLocalId ? h('button', { class: 'btn', title: 'Já existe um projeto com este nome nesta máquina', onclick: (e) => hubLink(e.target, x.suggestedLocalId, x.hubId) }, `Vincular a “${x.suggestedLocalName}”`) : null)),
    h('div', { class: 'page-head' }, h('div', { class: 'grow' }, h('h1', null, x.nome), h('div', { class: 'inline', style: 'margin-top:8px' },
      x.status ? h('span', { class: 'pill' }, hubName(x.status)) : null, x.segmento ? h('span', { class: 'pill' }, hubName(x.segmento)) : null, h('span', { class: 'pill cancelled' }, 'não baixado')))),
    card('Dados no banco', null, hubFacts(x)),
    hubTasksCard(`/api/hub/projects/${x.hubId}/tasks`, `hub:${x.hubId}`)));
  if (!HUB.asked.has(hubId)) {
    HUB.asked.add(hubId);
    const ok = await confirmDialog({ title: 'Baixar o projeto?', okText: 'Baixar projeto',
      message: `“${x.nome}” não está nesta máquina. Baixar agora? Ele é criado aqui com os dados do banco (coordenador, analista, sistema de origem, pasta do Drive e marcos) e passa a receber as atualizações de lá.${x.suggestedLocalName ? ` (Já existe aqui um projeto chamado “${x.suggestedLocalName}”: se for o mesmo, prefira “Vincular”.)` : ''}` });
    if (ok && route().id === hubId) download(main.querySelector('.hub-offline .btn.primary'));
  }
}

// Fatos do projeto no banco (da última leitura): os mesmos no projeto offline e no card do projeto vinculado.
function hubFacts(x) {
  const yn = (v) => (v === true ? 'Sim' : v === false ? 'Não' : null);
  const m = x.marcos || {};
  const items = [['Analista de migração', x.analista && hubName(x.analista)], ['Coordenador', x.coordenador && hubName(x.coordenador)], ['Status', x.status && hubName(x.status)],
    ['Segmento', x.segmento && hubName(x.segmento)], ['Origem → destino', [x.sistemaOrigem, x.sistemaDestino].filter(Boolean).join(' → ')], ['Estado', x.estado],
    ['Complexidade', x.complexidade != null ? `${x.complexidade} de 5` : null], ['Ambiente', x.ambiente], ['Data do repasse', fmtDate(x.dataRepasse)],
    ['Desenvolve script', yn(x.desenvolveScript)], ['Tarefas concluídas', x.tarefas?.total ? `${x.tarefas.concluidas} de ${x.tarefas.total} (${x.tarefas.percentual}%)` : null],
    ['Entrega do DE/PARA', fmtDate(m.depara)], ['Carga em HMG', fmtDate(m.hmg)], ['Carga em HMG 2', fmtDate(m.hmg2)], ['Carga em PRD', fmtDate(m.prd)],
    ['Pasta do projeto', x.pasta], ['Cronograma (planilha)', x.cronograma], ['Observação dos marcos', m.observacao]].filter(([, v]) => v);
  return h('div', { class: 'hub-facts' }, items.map(([k, v]) => h('div', null, h('div', { class: 'small muted' }, k), h('div', null, v))));
}

// Tarefas da aba do projeto na planilha (só leitura; lidas do banco ao abrir).
function hubTasksCard(url, key) {
  const slot = h('div', null, h('div', { class: 'empty' }, 'Carregando as tarefas…'));
  const st = h('select', null, h('option', { value: '' }, 'Todos os status'), ['Não iniciada', 'Em execução', 'Bloqueada', 'Concluída', 'Problemas'].map((s) => h('option', { value: s }, s)));
  const draw = (tasks) => {
    const rows = tasks.filter((t) => !st.value || t.status === st.value || t.status2 === st.value);
    slot.replaceChildren(tasks.length ? h('div', { class: 'tablewrap', style: 'max-height:56vh' }, h('table', { class: 'compact hub-tasks' },
      h('thead', null, h('tr', null, h('th', null, 'Nº'), h('th', null, 'Tarefa'), h('th', null, 'Status'), h('th', null, 'Recurso'), h('th', null, 'Início'), h('th', null, 'Término'), h('th', null, 'Marco'))),
      h('tbody', null, rows.map((t) => h('tr', null, h('td', { class: 'mono small' }, t.codigo), h('td', null, t.titulo, t.observacoes ? h('div', { class: 'small muted' }, t.observacoes) : null),
        h('td', null, t.status ? h('span', { class: `pill ${HUB_TASK_TONE[t.status] || ''}` }, t.status) : '—', t.status2 ? h('span', { class: `pill ${HUB_TASK_TONE[t.status2] || ''}`, style: 'margin-left:4px', title: '2ª trilha' }, t.status2) : null),
        h('td', null, t.recurso || '—'), h('td', null, fmtDate(t.inicio) || '—'), h('td', null, fmtDate(t.termino) || '—'), h('td', { class: 'small' }, t.marco || '—'))))))
      : h('div', { class: 'empty' }, 'Nenhuma tarefa deste projeto no banco (a aba de tarefas pode não estar ligada ao projeto na planilha).'));
  };
  const cached = HUB.tasks.get(key);
  const load = () => api('GET', url, undefined, { timeoutMs: 40000 }).then(({ tasks }) => { HUB.tasks.set(key, { at: Date.now(), tasks }); draw(tasks); })
    .catch((e) => slot.replaceChildren(h('div', { class: 'empty' }, `Tarefas indisponíveis: ${e.message}`)));
  if (cached && Date.now() - cached.at < 120000) draw(cached.tasks); else load();
  st.addEventListener('change', () => { const c = HUB.tasks.get(key); if (c) draw(c.tasks); });
  return card('Tarefas da planilha (só leitura)', h('div', { class: 'inline' }, st, h('button', { class: 'btn sm', title: 'Ler do banco de novo', onclick: () => { HUB.tasks.delete(key); load(); } }, '⟳')), slot);
}

// ---------- Card “Hub de Dados” na página do projeto ----------
function hubProjectCard(p) {
  if (!p.hub) {
    if (!HUB.data?.configured || HUB.data.error) return null; // sem banco: o projeto é só local, como sempre foi
    const free = HUB.data.projects.filter((x) => !x.localId);
    if (!free.length) return null;
    const sug = free.find((x) => x.suggestedLocalId === p.id);
    const sel = h('select', null, h('option', { value: '' }, '— Escolha o projeto do banco —'), free.map((x) => h('option', { value: x.hubId, selected: sug?.hubId === x.hubId }, x.nome)));
    return card('Hub de Dados', null, h('div', { class: 'muted small' }, 'Projeto só desta máquina. Vincule ao projeto correspondente do banco para receber coordenador, analista, sistema de origem, pasta do Drive e marcos de lá (o resto do projeto não muda).'),
      h('div', { class: 'inline' }, sel, h('button', { class: 'btn sm', onclick: async (e) => {
        if (!sel.value) return toast('Escolha o projeto do banco.', 'error');
        if (!(await confirmDialog({ title: 'Vincular ao Hub de Dados', okText: 'Vincular', message: 'Os dados do banco (coordenador, analista de migração, sistema de origem, pasta do Drive e marcos) passam a valer para este projeto e são atualizados quando mudarem no banco. Ciclo, checklists, horas, bases e o restante continuam como estão.' }))) return;
        hubLink(e.target, p.id, sel.value);
      } }, 'Vincular')));
  }
  const x = p.hub.data || {};
  const pull = (btn) => busy(btn, async () => {
    const r = await api('POST', `/api/projects/${p.id}/hub/pull`, {}, { timeoutMs: 60000 });
    replaceProject(r.project);
    HUB.tasks.delete(`p:${p.id}`);
    toast(r.changes.length ? `Atualizado pelo banco: ${r.changes.join(', ')}.` : 'Já estava igual ao banco.', 'ok');
  }, 'Atualizando…');
  const unlink = async (btn) => {
    if (!(await confirmDialog({ title: 'Desvincular do Hub de Dados', okText: 'Desvincular', message: 'O projeto continua aqui com os dados que já tem, mas deixa de receber as atualizações do banco (e volta a aparecer como “não baixado” na lista do banco).' }))) return;
    busy(btn, async () => { replaceProject(await api('POST', `/api/projects/${p.id}/hub/unlink`)); HUB.data = null; hubLoad(true); });
  };
  const missing = HUB.data?.configured && !HUB.data.error && !HUB.data.projects.some((r) => r.hubId === p.hub.id);
  return h('div', { class: 'stack', style: 'gap:14px' },
    card(['Hub de Dados', h('span', { class: 'muted small', style: 'font-weight:400' }, `  ${p.hub.nome}`)], h('div', { class: 'inline' },
      h('button', { class: 'btn sm', title: 'Trazer agora o que estiver no banco', onclick: (e) => pull(e.target) }, 'Atualizar do banco'),
      h('button', { class: 'btn sm ghost', onclick: (e) => unlink(e.target) }, 'Desvincular')),
    missing ? h('div', { class: 'box warn' }, h('strong', null, 'Este projeto não está mais no banco '), '(foi renomeado ou removido na planilha). Os dados já trazidos continuam aqui.') : null,
    hubFacts(x),
    h('div', { class: 'hint' }, `Atualizado pelo banco em ${fmtDateTime(p.hub.syncedAt)}. Vêm do banco: coordenador, analista de migração, sistema de origem, pasta do Drive e os marcos do cronograma. Quando mudam lá, mudam aqui; o resto do projeto é só desta máquina.`)),
    hubTasksCard(`/api/projects/${p.id}/hub/tasks`, `p:${p.id}`));
}
