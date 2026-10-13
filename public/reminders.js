'use strict';
// Lembretes: cards na Visão Geral, página #/reminders e aviso no horário (dentro do app e, se o Windows permitir, notificação
// do sistema — a mesma API Notification já usada pelo Controle de Horas). Uma checagem por minuto, também com a janela
// minimizada; com o app fechado nada roda: ao abrir, os vencidos aparecem e são avisados uma vez. Regras: src/reminders.js.

const REM = { data: null, offset: 0, filter: 'all', project: '', started: false };
const REM_STATUS = { overdue: ['Atrasado', 'overdue'], today: ['Hoje', 'soon'], soon: ['Próximo', 'done'], later: ['Agendado', ''], snoozed: ['Adiado', ''], done: ['Concluído', 'ok'] };
const remPad = (n) => String(n).padStart(2, '0');
const remKeyOf = (d) => `${d.getFullYear()}-${remPad(d.getMonth() + 1)}-${remPad(d.getDate())}T${remPad(d.getHours())}:${remPad(d.getMinutes())}`;
const remDateOf = (key) => { const [d, t = '00:00'] = key.split('T'); const [y, m, dd] = d.split('-').map(Number); const [hh, mm] = t.split(':').map(Number); return new Date(y, m - 1, dd, hh, mm); };
const remNow = () => new Date(Date.now() + REM.offset);
const remWhen = (x) => (x.kind === 'milestone' ? `Prazo ${fmtDate(x.dueDay)}` : `${fmtDate(x.at.slice(0, 10))} ${x.at.slice(11)}`);

// “Faltam 5 dias”, “Faltam 3 horas”, “Faltam 45 minutos”, “Hoje às 14:00”, “Atrasado há 2 dias”.
function remCountdown(x) {
  const now = remNow();
  if (x.done) return x.doneAt && /^\d/.test(x.doneAt) ? `Concluído em ${new Date(x.doneAt).toLocaleString('pt-BR')}` : (x.doneAt || 'Concluído');
  if (x.status === 'snoozed') return `Adiado até ${fmtDate(x.snoozeUntil.slice(0, 10))} ${x.snoozeUntil.slice(11)}`;
  if (x.kind === 'milestone') {
    const days = Math.round((remDateOf(`${x.dueDay}T00:00`) - remDateOf(`${remKeyOf(now).slice(0, 10)}T00:00`)) / 86400000);
    return days < 0 ? `Atrasado há ${plural(-days, 'dia', 'dias')}` : days === 0 ? 'Vence hoje' : `Faltam ${plural(days, 'dia', 'dias')}`;
  }
  const diff = remDateOf(x.at) - now;
  const min = Math.round(Math.abs(diff) / 60000);
  const unit = (m) => (m < 60 ? plural(m, 'minuto', 'minutos') : m < 1440 ? plural(Math.round(m / 60), 'hora', 'horas') : plural(Math.round(m / 1440), 'dia', 'dias'));
  if (diff < 0) return `Atrasado há ${unit(min)}`;
  const sameDay = x.at.slice(0, 10) === remKeyOf(now).slice(0, 10);
  if (min < 60) return `Faltam ${unit(min)}`;
  if (sameDay && min < 360) return `Faltam ${unit(min)}`;
  if (sameDay) return `Hoje às ${x.at.slice(11)}`;
  return `Faltam ${unit(min)}`;
}

async function remLoad() {
  const q = new URLSearchParams({ filter: 'all' });
  const d = await api('GET', `/api/reminders?${q}`);
  REM.offset = d.nowMs - Date.now();
  REM.data = d;
  return d;
}

// ---------- Card ----------
function remCard(x, { onChange } = {}) {
  const [label, cls] = REM_STATUS[x.status];
  const changed = async (msg) => { if (msg) toast(msg, 'ok'); await remRefresh(); if (onChange) onChange(); };
  const act = (fn) => async (e) => { const b = e.currentTarget; b.disabled = true; try { await fn(); } catch (er) { fail(er); } finally { b.disabled = false; } };
  const snoozeMenu = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const snooze = (until) => api('POST', `/api/reminders/${encodeURIComponent(x.key)}/snooze`, { until }).then(() => changed(`Adiado até ${fmtDate(until.slice(0, 10))} ${until.slice(11)}.`)).catch(fail);
    contextMenu(r.left, r.bottom + 4, [
      { label: '1 hora', run: () => snooze(remKeyOf(new Date(remNow().getTime() + 3600000))) },
      { label: '1 dia', run: () => snooze(remKeyOf(new Date(remNow().getTime() + 86400000))) },
      { label: 'Escolher data…', run: () => remSnoozeDialog(x, snooze) },
    ]);
  };
  const p = x.projectId ? projectById(x.projectId) : null;
  return h('div', { class: `rem-card st-${x.status}${x.priority === 'important' ? ' important' : ''}`, 'data-key': x.key },
    h('div', { class: 'rem-top' }, h('span', { class: `pill ${cls}` }, x.status === 'overdue' ? 'ATRASADO' : label),
      x.priority === 'important' ? h('span', { class: 'pill overdue', title: 'Prioridade importante' }, '! Importante') : null,
      x.kind === 'milestone' ? h('span', { class: 'pill', title: 'Vinculado ao cronograma do projeto: data e antecedência vêm do prazo' }, 'Cronograma') : null),
    h('strong', { class: 'rem-title' }, x.status === 'overdue' ? `⚠ ${x.title}` : x.title),
    x.projectName ? h('span', { class: 'small muted' }, `Projeto ${x.projectName}`) : null,
    h('div', { class: 'rem-count', 'data-count': x.key }, remCountdown(x)),
    h('div', { class: 'small muted' }, remWhen(x), ' · ', x.repeatText),
    x.todaySlots ? h('div', { class: 'rem-slots', title: 'Ocorrências de hoje (cada horário é independente)' }, h('span', { class: 'small muted' }, 'Hoje:'),
      x.todaySlots.map((s) => h('span', { class: `rem-slot ${s.state}` }, s.state === 'done' ? `${s.time} ✓` : s.state === 'pending' ? `${s.time} pendente` : s.state === 'skipped' ? `${s.time} (passou)` : s.time))) : null,
    x.description ? h('div', { class: 'small rem-desc' }, x.description) : null,
    remActionButtons(x, p),
    h('div', { class: 'rem-actions' },
      !x.done ? h('button', { class: 'btn sm primary', title: x.kind === 'milestone' ? 'Dispensa o aviso deste prazo (marcar o prazo como entregue continua no cronograma)' : x.repeat ? 'Conclui só esta ocorrência; a próxima continua' : 'Encerra o lembrete',
        onclick: act(async () => { const r = await api('POST', `/api/reminders/${encodeURIComponent(x.key)}/complete`, {}); await changed(r.finished ? 'Lembrete concluído.' : `Ocorrência concluída. Próxima: ${fmtDate(r.next)}${r.nextAt ? ` às ${r.nextAt.slice(11)}` : ''}.`); }) }, x.repeat || (x.times || []).length > 1 ? 'Concluir esta' : 'Concluir') : null,
      !x.done ? h('button', { class: 'btn sm', onclick: snoozeMenu }, 'Adiar ▾') : null,
      p && x.action?.kind !== 'project' ? h('button', { class: 'btn sm ghost', onclick: () => (location.hash = `#/project/${p.id}`) }, 'Abrir projeto') : null,
      h('button', { class: 'btn sm ghost', onclick: () => remEdit(x, changed) }, 'Editar')));
}

// Ação opcional do lembrete: só botões (nada roda sozinho). Links abrem no navegador padrão (link comum; o app não tem navegador interno).
function remActionButtons(x, p) {
  const a = x.action;
  if (!a) return null;
  const ext = (url, label, title) => (url ? h('a', { class: 'btn sm', href: url, target: '_blank', rel: 'noopener noreferrer', title: title || url }, label) : null);
  const links = REM.data?.hoursLinks || {};
  let btns = [];
  if (a.kind === 'project' && p) btns = [h('button', { class: 'btn sm', onclick: () => (location.hash = `#/project/${p.id}`) }, 'Abrir projeto')];
  if (a.kind === 'link') btns = [ext(a.url, a.label || 'Abrir link')];
  if (a.kind === 'hours') {
    btns = [h('button', { class: 'btn sm', onclick: () => (location.hash = '#/hours') }, 'Abrir controle de horas'),
      ext(links.psaUrl, 'Abrir PSA'), ext(links.sheetUrl, 'Abrir planilha'),
      !links.psaUrl && !links.sheetUrl ? h('span', { class: 'small muted', title: 'Cadastre em Controle de Horas → mês → Links' }, 'sem links do PSA/planilha') : null,
      h('button', { class: 'btn sm', onclick: () => hoursEmailDialog({ templateId: a.templateId }) }, 'Gerar e-mail')];
  }
  if (a.kind === 'email' && p) btns = [h('button', { class: 'btn sm', onclick: () => emGenerate(p, { templateId: a.templateId }) }, 'Gerar e-mail')];
  btns = btns.filter(Boolean);
  return btns.length ? h('div', { class: 'rem-actions rem-do' }, btns) : null;
}

function remSnoozeDialog(x, snooze) {
  const t = new Date(remNow().getTime() + 86400000);
  const d = h('input', { type: 'date', value: remKeyOf(t).slice(0, 10) });
  const tm = h('input', { type: 'time', value: x.time || '09:00' });
  const md = openModal({ title: `Adiar “${x.title}”`, size: 'sm', body: [h('div', { class: 'cols2' }, field('Data', d), field('Hora', tm))],
    footer: [h('button', { class: 'btn', onclick: () => md.close() }, 'Cancelar'), h('button', { class: 'btn primary', onclick: () => { md.close(); snooze(`${d.value}T${tm.value}`); } }, 'Adiar')] });
}

// Editar: avulso → formulário do lembrete; do cronograma → formulário do próprio prazo (fonte única).
function remEdit(x, changed) {
  if (x.kind === 'milestone') {
    const p = projectById(x.projectId);
    const m = p?.milestones.find((y) => y.id === x.id);
    if (!m) return toast('O prazo não existe mais.', 'error');
    return milestoneForm(p, m);
  }
  const r = (REM.data?.items || []).find((y) => y.key === x.key) || x;
  reminderForm(r, changed);
}

// ---------- Formulário (avulso) ----------
const REM_WD = [[1, 'Seg'], [2, 'Ter'], [3, 'Qua'], [4, 'Qui'], [5, 'Sex'], [6, 'Sáb'], [7, 'Dom']];
function reminderForm(r, after) {
  const today = remKeyOf(remNow());
  const title = h('input', { type: 'text', maxlength: 160, value: r?.title || '', placeholder: 'Ex.: Enviar documentação' });
  const desc = h('textarea', { maxlength: 1000, rows: 2, placeholder: 'Opcional' }, r?.description || '');
  const proj = h('select', null, h('option', { value: '' }, 'Nenhum'), sortedProjects().map((p) => h('option', { value: p.id }, p.name)));
  proj.value = r?.projectId || '';
  const date = h('input', { type: 'date', value: r?.date || today.slice(0, 10) });
  const timesBox = h('div', { class: 'inline rem-times' });
  let times = [...(r?.times?.length ? r.times : [r?.time || '09:00'])];
  const drawTimes = () => timesBox.replaceChildren(...times.map((t, i) => h('span', { class: 'inline', style: 'gap:2px' },
    h('input', { type: 'time', value: t, onchange: (e) => { times[i] = e.target.value; } }),
    times.length > 1 ? h('button', { class: 'btn xs ghost', title: 'Remover este horário', onclick: () => { times.splice(i, 1); drawTimes(); } }, '✕') : null)),
    times.length < 12 ? h('button', { class: 'btn xs', title: 'Mais um horário no mesmo dia (cada horário é uma ocorrência independente)', onclick: () => { times.push(''); drawTimes(); timesBox.querySelectorAll('input')[times.length - 1]?.focus(); } }, '+ horário') : null);
  drawTimes();
  const actKind = h('select', null, [['none', 'Nenhuma'], ['project', 'Abrir projeto'], ['link', 'Abrir link'], ['hours', 'Controle de horas (PSA, planilha, gerar e-mail)'], ['email', 'Gerar comunicação do projeto']].map(([v, l]) => h('option', { value: v }, l)));
  actKind.value = r?.action?.kind || 'none';
  const actUrl = h('input', { type: 'text', maxlength: 600, placeholder: 'https://…', value: r?.action?.url || '' });
  const actLabel = h('input', { type: 'text', maxlength: 60, placeholder: 'Texto do botão (opcional)', value: r?.action?.label || '' });
  const actTpl = h('select', null, h('option', { value: '' }, 'Carregando modelos…'));
  const urlBox = h('div', { class: 'cols2' }, field('Link', actUrl), field('Texto do botão', actLabel));
  const tplBox = field('Modelo de comunicação', actTpl, 'Modelos do Gerador de Comunicações. Controle de horas: só modelos globais (vazio = escolher na hora).');
  const fillTpl = async () => {
    let cat; try { cat = await emCatalog(); } catch { return; }
    const hours = actKind.value === 'hours';
    const list = cat.templates.filter((t) => t.active && (hours ? t.scope === 'global' : t.scope === 'global' || t.projectId === proj.value));
    actTpl.replaceChildren(h('option', { value: '' }, hours ? 'Escolher na hora' : '— escolha —'), ...list.map((t) => h('option', { value: t.id }, t.name)));
    actTpl.value = list.some((t) => t.id === r?.action?.templateId) ? r.action.templateId : '';
  };
  const syncAct = () => { urlBox.style.display = actKind.value === 'link' ? '' : 'none'; tplBox.style.display = ['hours', 'email'].includes(actKind.value) ? '' : 'none'; if (['hours', 'email'].includes(actKind.value)) fillTpl(); };
  actKind.addEventListener('change', syncAct);
  proj.addEventListener('change', () => { if (actKind.value === 'email') fillTpl(); });
  syncAct();
  const actionBody = () => (actKind.value === 'none' ? null : { kind: actKind.value, url: actUrl.value, label: actLabel.value, templateId: actTpl.value || null });
  const prio = h('select', null, h('option', { value: 'normal' }, 'Normal'), h('option', { value: 'important' }, 'Importante'));
  prio.value = r?.priority || 'normal';
  const type = h('select', null, h('option', { value: 'once' }, 'Pontual'), h('option', { value: 'repeat' }, 'Recorrente'));
  type.value = r?.repeat ? 'repeat' : 'once';
  const unit = h('select', null, h('option', { value: 'day' }, 'dias'), h('option', { value: 'week' }, 'semanas'), h('option', { value: 'month' }, 'meses'));
  unit.value = r?.repeat?.unit || 'day';
  const every = h('input', { type: 'number', min: 1, max: 365, value: r?.repeat?.every || 1, style: 'width:80px' });
  const wd = REM_WD.map(([n, l]) => ({ n, el: h('input', { type: 'checkbox', checked: !!r?.repeat?.weekdays?.includes(n) }), l }));
  const mdays = h('input', { type: 'text', placeholder: 'ex.: 5, 10, 20 (vazio = mesmo dia da data inicial)', value: (r?.repeat?.monthDays || []).join(', ') });
  const hasUntil = h('input', { type: 'checkbox', checked: !!r?.until });
  const until = h('input', { type: 'date', value: r?.until || '' });
  const wdBox = h('div', { class: 'inline small' }, h('span', { class: 'muted' }, 'Dias:'), wd.map((x) => h('label', { class: 'check' }, x.el, ` ${x.l}`)), h('span', { class: 'muted' }, '(nenhum = mesmo dia da semana da data inicial)'));
  const mdBox = field('Dias do mês', mdays);
  const repBox = h('div', { class: 'box stack' },
    h('div', { class: 'inline' }, h('span', null, 'A cada'), every, unit), wdBox, mdBox,
    h('div', { class: 'inline' }, h('label', { class: 'check' }, hasUntil, ' Até'), until, h('span', { class: 'small muted' }, 'sem marcar = sem data final')));
  const sync = () => { repBox.style.display = type.value === 'repeat' ? '' : 'none'; wdBox.style.display = unit.value === 'week' ? '' : 'none'; mdBox.style.display = unit.value === 'month' ? '' : 'none'; until.disabled = !hasUntil.checked; };
  [type, unit, hasUntil].forEach((el) => el.addEventListener('change', sync));
  sync();
  const body = () => ({ title: title.value, description: desc.value, projectId: proj.value || null, date: date.value, times: times.filter(Boolean), priority: prio.value, action: actionBody(),
    repeat: type.value === 'repeat' ? { unit: unit.value, every: Number(every.value), weekdays: wd.filter((x) => x.el.checked).map((x) => x.n), monthDays: mdays.value.split(/[\s,;]+/).filter(Boolean).map(Number) } : null,
    until: type.value === 'repeat' && hasUntil.checked ? until.value : null });
  const save = h('button', { class: 'btn primary' }, 'Salvar');
  save.addEventListener('click', () => busy(save, async () => {
    if (r) await api('PUT', `/api/reminders/${r.id}`, body()); else await api('POST', '/api/reminders', body());
    remAskPermission();
    md.close();
    if (after) await after(r ? 'Lembrete salvo.' : 'Lembrete criado.'); else { toast(r ? 'Lembrete salvo.' : 'Lembrete criado.', 'ok'); await remRefresh(); }
  }));
  const del = r ? h('button', { class: 'btn danger', style: 'margin-right:auto', onclick: async () => {
    if (!(await confirmDialog({ title: 'Excluir lembrete', message: `Excluir “${r.title}”?`, okText: 'Excluir', danger: true }))) return;
    try { await api('DELETE', `/api/reminders/${encodeURIComponent(`r:${r.id}`)}`); md.close(); toast('Lembrete excluído.', 'ok'); await remRefresh(); } catch (e) { fail(e); }
  } }, 'Excluir') : null;
  const md = openModal({ title: r ? 'Editar lembrete' : 'Novo lembrete', wide: true,
    body: [field('Título', title), field('Descrição', desc), h('div', { class: 'cols2' }, field('Projeto', proj), field('Prioridade', prio)),
      h('div', { class: 'cols2' }, field(type.value === 'repeat' ? 'Data inicial' : 'Data', date), field('Tipo', type)),
      field('Horários', timesBox, 'Um ou mais horários no mesmo dia. Cada horário é uma ocorrência: concluir a das 09:00 não conclui a das 14:00.'), repBox,
      h('div', { class: 'box stack' }, field('Ação (opcional)', actKind, 'Botões no card do lembrete; nada é executado sozinho.'), urlBox, tplBox),
      h('div', { class: 'hint' }, 'Para avisar antes de um prazo do cronograma, marque “Criar lembrete” no próprio prazo (Projeto → Cronograma): a data e a antecedência ficam sempre iguais às do prazo.')],
    footer: [del, h('button', { class: 'btn', onclick: () => md.close() }, 'Cancelar'), save].filter(Boolean) });
  title.focus();
}

// ---------- Visão Geral ----------
function homeRemindersCard() {
  const slot = h('div', { 'data-slot': 'home-reminders' }, card('Lembretes', null, h('div', { class: 'muted small' }, 'Carregando…')));
  remLoad().then(remPaintHome).catch(() => setKids(slot, card('Lembretes', null, h('div', { class: 'muted small' }, 'Não foi possível carregar os lembretes.'))));
  return slot;
}
function remPaintHome() {
  const slot = document.querySelector('[data-slot="home-reminders"]');
  if (!slot || !REM.data) return;
  const pending = REM.data.items.filter((x) => !x.done);
  const shown = pending.slice(0, 6);
  const c = REM.data.counts;
  setKids(slot, card(['Lembretes', pending.length ? h('span', { class: 'muted small', style: 'font-weight:400' }, `  ${pending.length}${c.overdue ? ` · ${c.overdue} atrasado(s)` : ''}${c.today ? ` · ${c.today} hoje` : ''}`) : null],
    h('div', { class: 'inline' }, h('button', { class: 'btn sm', onclick: () => reminderForm(null) }, '+ Lembrete'), h('button', { class: 'btn sm ghost', onclick: () => (location.hash = '#/reminders') }, 'Ver todos')),
    shown.length ? h('div', { class: 'rem-grid' }, shown.map((x) => remCard(x))) : h('div', { class: 'empty' }, 'Nenhum lembrete pendente. Crie lembretes avulsos aqui, ou marque “Criar lembrete” num prazo do cronograma.'),
    pending.length > shown.length ? h('div', { class: 'small muted' }, `… e mais ${pending.length - shown.length} em `, h('a', { href: '#/reminders' }, 'Lembretes'), '.') : null));
}

// ---------- Página ----------
async function renderReminders(main) {
  main.append(h('div', { class: 'page' }, h('div', { class: 'empty' }, 'Carregando…')));
  let d;
  try { d = await api('GET', `/api/reminders?${new URLSearchParams({ filter: REM.filter, project: REM.project })}`); } catch (e) { return fail(e); }
  if (route().name !== 'reminders') return;
  const tabs = [['all', 'Todos'], ['today', 'Hoje'], ['upcoming', 'Próximos'], ['overdue', 'Atrasados'], ['done', 'Concluídos']];
  const proj = h('select', { onchange: (e) => { REM.project = e.target.value; render(); } }, h('option', { value: '' }, 'Todos os projetos'), sortedProjects().map((p) => h('option', { value: p.id }, p.name)));
  proj.value = REM.project;
  main.replaceChildren(h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('div', { class: 'grow' }, h('h1', null, 'Lembretes'),
      h('div', { class: 'muted' }, 'Lembretes avulsos (pontuais ou recorrentes) e avisos dos prazos do cronograma, numa lista só. Avisam no horário enquanto o aplicativo estiver aberto; ao abrir, os vencidos aparecem aqui.')),
    h('div', { class: 'inline' }, h('button', { class: 'btn primary', onclick: () => reminderForm(null) }, '+ Novo lembrete'))),
    h('div', { class: 'inline' }, h('nav', { class: 'tabs', role: 'tablist' }, tabs.map(([k, l]) => h('button', { class: `tab${REM.filter === k ? ' active' : ''}`, onclick: () => { REM.filter = k; render(); } },
      l, k === 'overdue' && d.counts.overdue ? ` (${d.counts.overdue})` : k === 'today' && d.counts.today ? ` (${d.counts.today})` : ''))), h('span', { class: 'spacer', style: 'flex:1' }), proj),
    d.items.length ? h('div', { class: 'rem-grid' }, d.items.map((x) => remCard(x)))
      : h('div', { class: 'card' }, h('div', { class: 'card-body' }, h('div', { class: 'empty' }, REM.filter === 'done' ? 'Nenhum lembrete concluído.' : 'Nenhum lembrete aqui.')))));
}

// ---------- Atualização e aviso no horário ----------
async function remRefresh() {
  try { await remLoad(); } catch { return; }
  remPaintHome();
  if (route().name === 'reminders') render();
}
// Atualiza só os textos “Faltam…” sem redesenhar (entre as recargas).
function remRepaintCounts() {
  for (const el of document.querySelectorAll('[data-count]')) {
    const x = REM.data?.items.find((y) => y.key === el.dataset.count);
    if (x) el.textContent = remCountdown(x);
  }
}
function remAskPermission() {
  try { if (typeof Notification !== 'undefined' && Notification.permission === 'default') Notification.requestPermission(); } catch { /* sem suporte */ }
}
const remBody = (x) => `${x.projectName ? `Projeto ${x.projectName}\n` : ''}${x.dueDay ? `Prazo ${fmtDate(x.dueDay)}` : `${fmtDate(x.at.slice(0, 10))} às ${x.at.slice(11)}`} — ${remCountdown({ ...x, kind: x.dueDay ? 'milestone' : 'reminder', status: '' })}`;
async function remNotify(due, first) {
  if (!due.length) return;
  const can = typeof Notification !== 'undefined' && Notification.permission === 'granted';
  const show = (title, body) => { if (can) { try { const n = new Notification(title, { body }); n.onclick = () => { try { window.focus(); } catch { /* */ } location.hash = '#/reminders'; }; } catch { /* sem suporte: fica o aviso no app */ } } };
  if (first && due.length > 3) {
    show('Gerenciador de Projetos', `${plural(due.length, 'lembrete vencido ou chegando', 'lembretes vencidos ou chegando')}: ${due.slice(0, 3).map((x) => x.title).join(', ')}…`);
    toast(`⏰ ${plural(due.length, 'lembrete pendente', 'lembretes pendentes')}. Veja em Lembretes.`);
  } else {
    for (const x of due) { show(`Gerenciador de Projetos — ${x.title}`, remBody(x)); toast(`⏰ ${x.title}${x.projectName ? ` (${x.projectName})` : ''}`); }
  }
  try { await api('POST', '/api/reminders/notified', { items: due.map((x) => ({ key: x.key, notifyAt: x.notifyAt })) }); } catch { /* tenta de novo no próximo minuto */ }
}
async function remTick() {
  const first = !REM.started;
  REM.started = true;
  try { await remLoad(); } catch { return; }
  remPaintHome();
  remRepaintCounts();
  await remNotify(REM.data.due, first);
}
// Uma checagem por minuto (também minimizado: o aviso precisa sair no horário). Primeira logo depois de abrir o app.
setTimeout(remTick, 2500);
setInterval(remTick, 60000);
