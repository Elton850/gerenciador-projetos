'use strict';
// ---------- Cronogramas: Central (#/schedule) e visões do cronograma dentro do projeto ----------
// Fonte única: os prazos de cada projeto (project.milestones). Os itens (status, dias, cor, lembrete) vêm calculados pelo servidor
// (src/schedule.js: GET /api/schedule, /api/schedule/upcoming e publicProject.scheduleItems) — aqui só desenho e navegação.
// Prazo com início = PERÍODO (barra); sem início = MARCO (◆). Editar, concluir e lembrete usam as rotas de sempre dos prazos.
// Lembretes avulsos (pontuais/recorrentes) entram como ocorrências por dia (kind 'reminder', 🔔 + horário), calculadas no servidor
// (src/reminders.js `reminderItems`); concluir/editar usam as rotas de sempre dos lembretes (/api/reminders*).

const SCH_STATUS = {
  ok: { label: 'Normal', glyph: '' }, running: { label: 'Em andamento', glyph: '▸' }, soon: { label: 'Próximo do prazo', glyph: '◔' },
  today: { label: 'Vence hoje', glyph: '●' }, overdue: { label: 'Atrasado', glyph: '⚠' }, done: { label: 'Concluído', glyph: '✓' },
  past: { label: 'Passou', glyph: '·' }, // ocorrência de lembrete que ficou para trás sem concluir (perdidas não acumulam)
};
const schIsRem = (x) => x.kind === 'reminder';
const SCH_COLORS = ['ciano', 'roxo', 'verde', 'laranja', 'rosa', 'lima', 'azul', 'coral']; // chaves (a cor de cada uma fica no CSS)
const SCH_MONTHS = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const SCH_WD = ['SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SÁB', 'DOM'];

// Datas 'AAAA-MM-DD' só para montar a grade (em UTC: sem fuso nem horário de verão no meio da conta).
const sdUTC = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const sdStr = (dt) => `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
const sdAdd = (s, n) => { const dt = sdUTC(s); dt.setUTCDate(dt.getUTCDate() + n); return sdStr(dt); };
const sdDow = (s) => (sdUTC(s).getUTCDay() + 6) % 7; // 0 = segunda … 6 = domingo
const sdWeek = (s) => sdAdd(s, -sdDow(s));
const sdMonth = (s) => `${s.slice(0, 8)}01`;
const sdMonthEnd = (s) => sdAdd(sdMonth(sdAdd(sdMonth(s), 32)), -1);
const sdDiff = (a, b) => Math.round((sdUTC(b) - sdUTC(a)) / 86400000);
const sdShort = (s) => `${s.slice(8, 10)} ${SCH_MONTHS[Number(s.slice(5, 7)) - 1].slice(0, 3).toUpperCase()}`;
const sdMonthLabel = (s) => `${SCH_MONTHS[Number(s.slice(5, 7)) - 1]} ${s.slice(0, 4)}`;
const schWeekend = (s) => sdDow(s) >= 5;

// Identificação do projeto: cor + iniciais (nunca só a cor).
const schBadge = (x, cls = '') => h('span', { class: `sch-badge pc-${x.color}${cls ? ` ${cls}` : ''}`, 'aria-hidden': 'true' }, x.initials);
function schRange(x) { return x.kind === 'period' ? `${fmtDate(x.start)} → ${fmtDate(x.end)}` : schIsRem(x) ? `${fmtDate(x.end)} às ${x.times.join(', ')}` : fmtDate(x.end); }
function schReminderText(x) {
  if (!x.reminder) return '';
  return x.reminder.lead ? `${plural(x.reminder.lead, 'dia', 'dias')} antes` : 'no dia';
}
// Dica ao passar o mouse (complementa; o clique abre os detalhes completos).
function schTip(x) {
  if (schIsRem(x)) return [x.projectName, `🔔 ${x.title}`, schRange(x), x.repeatText, `Status: ${SCH_STATUS[x.status].label}`].filter(Boolean).join('\n');
  return [x.projectName, x.title, schRange(x), `Status: ${SCH_STATUS[x.status].label}${x.done ? '' : x.days != null ? ` (${daysText(x.days)})` : ''}`,
    x.reminder ? `🔔 Lembrete ${schReminderText(x)} · em ${fmtDate(x.reminder.notifyDate)} às ${x.reminder.time}${x.reminder.dismissed ? ' (aviso dispensado)' : ''}` : null,
    schProject(x)?.cancelled ? 'Projeto cancelado: somente leitura' : null].filter(Boolean).join('\n');
}
function schItemEl(x, { onItem, segment } = {}) {
  const st = SCH_STATUS[x.status];
  const deadline = x.kind === 'deadline';
  const rem = schIsRem(x);
  const cls = ['sch-item', rem ? 'is-reminder' : deadline ? 'is-deadline' : 'is-period', `pc-${x.color}`, `st-${x.status}`, segment?.contL ? 'cont-l' : '', segment?.contR ? 'cont-r' : ''].filter(Boolean).join(' ');
  return h('button', { type: 'button', class: cls, title: schTip(x), 'aria-label': `${x.projectName}: ${x.title}, ${schRange(x)}, ${st.label}${x.reminder ? ', com lembrete' : ''}`,
    style: segment ? `grid-column:${segment.c0 + 1} / ${segment.c1 + 2};grid-row:${segment.lane + 1}` : null, onclick: (e) => { e.stopPropagation(); onItem && onItem(x); } },
  deadline ? h('span', { class: 'sch-diamond', 'aria-hidden': 'true' }, '◆') : null,
  rem ? h('span', { class: 'sch-rem-time', 'aria-hidden': 'true' }, h('span', { class: 'sch-rem-bell' }, '🔔'), h('span', { class: 'sch-rem-hhmm' }, x.times[0])) : null,
  x.initials ? h('span', { class: 'sch-ini', 'aria-hidden': 'true' }, x.initials) : null,
  st.glyph ? h('span', { class: 'sch-glyph', 'aria-hidden': 'true' }, st.glyph) : null,
  h('span', { class: 'sch-title' }, x.title),
  x.reminder && !x.reminder.dismissed ? h('span', { class: 'sch-bell', 'aria-hidden': 'true' }, '🔔') : null);
}

// Distribui os itens de um trecho de dias em faixas (sem sobrepor). Retorna segmentos { x, c0, c1, lane, contL, contR }.
// `labelDays`: colunas reservadas para o título de um marco (◆) quando cada dia é estreito (linha do tempo).
function schLanes(items, days, { labelDays = 1 } = {}) {
  const first = days[0]; const last = days[days.length - 1];
  const segs = items.filter((x) => x.start <= last && x.end >= first).map((x) => {
    const c0 = Math.max(0, sdDiff(first, x.start));
    const c1 = Math.min(days.length - 1, x.kind === 'deadline' ? c0 + labelDays - 1 : sdDiff(first, x.end)); // lembrete: 1 dia
    return { x, c0, c1, contL: x.start < first, contR: x.end > last };
  })
    // pela data real de início (não a recortada): uma barra que vem da semana anterior fica na mesma faixa de cima
    // (no mesmo dia: prazos antes dos lembretes; lembretes pelo horário)
    .sort((a, b) => a.x.start.localeCompare(b.x.start) || b.x.end.localeCompare(a.x.end) || Number(schIsRem(a.x)) - Number(schIsRem(b.x))
      || (schIsRem(a.x) && schIsRem(b.x) ? a.x.times[0].localeCompare(b.x.times[0]) : 0) || a.x.projectName.localeCompare(b.x.projectName, 'pt-BR'));
  const lanes = [];
  for (const s of segs) {
    let i = lanes.findIndex((occ) => occ.every(([a, b]) => s.c1 < a || s.c0 > b));
    if (i < 0) { lanes.push([]); i = lanes.length - 1; }
    lanes[i].push([s.c0, s.c1]);
    s.lane = i;
  }
  return segs;
}

// Uma semana (linha do calendário): dias ao fundo + faixas com as barras; o que passar de `maxLanes` vira “+N” no dia.
function schWeekRow(days, items, today, { month, maxLanes, onItem, onDay }) {
  const segs = schLanes(items, days);
  const shown = segs.filter((s) => s.lane < maxLanes);
  const hidden = days.map((d, i) => segs.filter((s) => s.lane >= maxLanes && s.c0 <= i && s.c1 >= i).length);
  const lanes = Math.min(maxLanes, segs.reduce((n, s) => Math.max(n, s.lane + 1), 0));
  return h('div', { class: 'sch-week' },
    h('div', { class: 'sch-week-bg' }, days.map((d) => h('button', { type: 'button', class: ['sch-day', schWeekend(d) ? 'weekend' : '', d === today ? 'today' : '', month && d.slice(0, 7) !== month ? 'other' : ''].filter(Boolean).join(' '),
      title: `Itens de ${fmtDate(d)}`, 'aria-label': `${fmtDate(d)}${d === today ? ' (hoje)' : ''}`, onclick: () => onDay && onDay(d) },
    h('span', { class: 'sch-dnum' }, d === today ? h('span', { class: 'sch-today-tag' }, 'Hoje') : null, String(Number(d.slice(8, 10))))))),
    h('div', { class: 'sch-week-fg', style: `grid-template-rows:repeat(${lanes}, var(--sch-lane)) auto` },
      shown.map((s) => schItemEl(s.x, { onItem, segment: s })),
      hidden.map((n, i) => (n ? h('button', { type: 'button', class: 'sch-more', style: `grid-column:${i + 1};grid-row:${lanes + 1}`, onclick: (e) => { e.stopPropagation(); onDay && onDay(days[i]); } }, `+${n} ${n === 1 ? 'item' : 'itens'}`) : null))));
}

function schMonthGrid(items, anchor, today, opts) {
  const month = anchor.slice(0, 7);
  const first = sdWeek(sdMonth(anchor)); const last = sdAdd(sdWeek(sdMonthEnd(anchor)), 6);
  const weeks = [];
  for (let d = first; d <= last; d = sdAdd(d, 7)) weeks.push(Array.from({ length: 7 }, (_, i) => sdAdd(d, i)));
  return h('div', { class: 'sch-cal' }, h('div', { class: 'sch-head' }, SCH_WD.map((w, i) => h('span', { class: i >= 5 ? 'weekend' : '' }, w))),
    weeks.map((days) => schWeekRow(days, items, today, { ...opts, month, maxLanes: opts.maxLanes || 3 })));
}
function schWeekGrid(items, anchor, today, opts) {
  const days = Array.from({ length: 7 }, (_, i) => sdAdd(sdWeek(anchor), i));
  return h('div', { class: 'sch-cal sch-cal-week' }, h('div', { class: 'sch-head' }, days.map((d, i) => h('span', { class: i >= 5 ? 'weekend' : '' }, `${SCH_WD[i]} ${d.slice(8, 10)}`))),
    schWeekRow(days, items, today, { ...opts, maxLanes: 12 }));
}
// Agenda: lista por data de início (períodos mostram início → fim).
function schAgenda(items, today, { onItem }) {
  if (!items.length) return h('div', { class: 'empty' }, 'Nenhum item neste intervalo.');
  const byDay = new Map();
  for (const x of [...items].sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end))) {
    const k = x.start; if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(x);
  }
  return h('div', { class: 'sch-agenda' }, [...byDay].map(([d, list]) => h('div', { class: `sch-ag-day${d === today ? ' today' : ''}` },
    h('div', { class: 'sch-ag-date' }, h('strong', null, d.slice(8, 10)), h('span', null, `${SCH_WD[sdDow(d)]} · ${SCH_MONTHS[Number(d.slice(5, 7)) - 1].slice(0, 3)}`)),
    h('div', { class: 'sch-ag-list' }, list.map((x) => schRowEl(x, { onItem }))))));
}
// Linha compacta (agenda, “+N” do dia, próximos prazos).
function schRowEl(x, { onItem, compact } = {}) {
  const st = SCH_STATUS[x.status];
  return h('button', { type: 'button', class: `sch-row st-${x.status}`, title: schTip(x), onclick: () => onItem && onItem(x) },
    h('span', { class: 'sch-kind', 'aria-hidden': 'true' }, x.kind === 'period' ? '━' : schIsRem(x) ? '🔔' : '◆'), x.initials ? schBadge(x) : null,
    h('span', { class: 'sch-row-main' }, h('span', { class: 'sch-row-title' }, x.title), h('span', { class: 'sch-row-sub' }, compact ? x.projectName : `${x.projectName} · ${schRange(x)}`)),
    x.reminder && !x.reminder.dismissed ? h('span', { class: 'sch-bell', title: `Lembrete ${schReminderText(x)}` }, '🔔') : null,
    h('span', { class: `sch-st st-${x.status}` }, st.glyph ? `${st.glyph} ` : '', schIsRem(x) ? (['done', 'past', 'overdue'].includes(x.status) ? st.label : x.times.join(', '))
      : x.done ? st.label : x.status === 'running' ? `${st.label} · ${daysText(x.days)}` : daysText(x.days)));
}

// Linha do tempo: projetos em linhas, dias em colunas; períodos = barras, marcos = ◆; linha de hoje e fins de semana discretos.
function schTimeline(items, from, to, today, { onItem, projects }) {
  const days = []; for (let d = from; d <= to; d = sdAdd(d, 1)) days.push(d);
  const n = days.length;
  const groups = new Map();
  for (const p of projects || []) groups.set(p.id, { p, items: [] });
  for (const x of items) { if (!groups.has(x.projectId)) groups.set(x.projectId, { p: { id: x.projectId, name: x.projectName, color: x.color, initials: x.initials }, items: [] }); groups.get(x.projectId).items.push(x); }
  const rows = [...groups.values()].filter((g) => g.items.length).sort((a, b) => a.p.name.localeCompare(b.p.name, 'pt-BR'));
  const cols = `grid-template-columns:repeat(${n}, minmax(0, 1fr))`;
  const months = []; for (const d of days) { const k = d.slice(0, 7); const last = months[months.length - 1]; if (last && last.k === k) last.n++; else months.push({ k, n: 1, d }); }
  const dayLabel = (d, i) => (n <= 35 || sdDow(d) === 0 || i === 0 ? String(Number(d.slice(8, 10))) : '');
  const todayIdx = days.indexOf(today);
  const bg = () => h('div', { class: 'sch-tl-bg', style: cols }, days.map((d) => h('span', { class: `${schWeekend(d) ? 'weekend' : ''}${d === today ? ' today' : ''}` })));
  const lab = Math.max(3, Math.round(n / 6)); // colunas para o título de cada marco
  return h('div', { class: 'sch-tl', style: `--tl-days:${n};--tl-lab:${lab}` },
    h('div', { class: 'sch-tl-row sch-tl-head' }, h('div', { class: 'sch-tl-label' }),
      h('div', { class: 'sch-tl-scale' },
        h('div', { class: 'sch-tl-months', style: cols }, months.map((m) => h('span', { style: `grid-column:span ${m.n}` }, m.n >= 4 ? sdMonthLabel(m.d) : ''))),
        h('div', { class: 'sch-tl-days', style: cols }, days.map((d, i) => h('span', { class: `${schWeekend(d) ? 'weekend' : ''}${d === today ? ' today' : ''}`, title: fmtDate(d) }, dayLabel(d, i)))))),
    rows.length ? rows.map((g) => {
      const segs = schLanes(g.items, days, { labelDays: lab });
      const lanes = segs.reduce((m, s) => Math.max(m, s.lane + 1), 1);
      return h('div', { class: 'sch-tl-row' },
        h('div', { class: 'sch-tl-label', title: g.p.name }, schBadge(g.p), h('span', { class: 'sch-tl-name' }, g.p.name)),
        h('div', { class: 'sch-tl-track' }, bg(), todayIdx >= 0 ? h('span', { class: 'sch-tl-now', style: `left:calc(${(todayIdx + 0.5) / n * 100}% - 1px)`, title: 'Hoje' }) : null,
          h('div', { class: 'sch-tl-items', style: `${cols};grid-template-rows:repeat(${lanes}, var(--sch-lane))` }, segs.map((s) => schItemEl(s.x, { onItem, segment: s })))));
    }) : h('div', { class: 'empty', style: 'margin:12px 0' }, 'Nenhum item neste intervalo.'));
}

// ---------- Detalhes de um item (janela compacta) ----------
const schProject = (x) => state.projects.find((p) => p.id === x.projectId);
const schMilestone = (x) => schProject(x)?.milestones.find((m) => m.id === x.milestoneId);
async function schSaveMilestone(x, patch) {
  const m = schMilestone(x);
  if (!m) throw new Error('Este prazo não existe mais (atualize a tela).');
  const p = await api('PUT', `/api/projects/${x.projectId}/milestones/${x.milestoneId}`, { ...m, ...patch });
  replaceProjectQuiet(p);
  remRefresh();
  return p;
}
// Antecedências rápidas do lembrete do prazo (vale também como “avisar com N dias” do prazo — uma antecedência só, como sempre foi).
const SCH_LEADS = [[0, 'No dia'], [1, '1 dia antes'], [2, '2 dias antes'], [3, '3 dias antes'], [7, '1 semana antes']];
async function schSetReminder(x, lead) {
  const m = schMilestone(x);
  await schSaveMilestone(x, { alertDays: lead, reminder: { on: true, time: m?.reminder?.time || '09:00' } });
  remAskPermission();
  toast(lead ? `Lembrete criado: ${plural(lead, 'dia', 'dias')} antes do prazo.` : 'Lembrete criado: no dia do prazo.', 'ok');
}

// Detalhe de uma ocorrência de lembrete avulso: concluir só a pendente (rota de sempre), editar (formulário do lembrete), abrir Lembretes.
function schReminderDetail(x, { onChanged } = {}) {
  const st = SCH_STATUS[x.status];
  const p = x.projectId ? schProject(x) : null;
  const done = async (msg) => { md.close(); if (msg) toast(msg, 'ok'); await remRefresh(); if (onChanged) onChanged(); else render(); };
  const md = openModal({
    title: `🔔 ${x.title}`, size: 'md',
    body: [h('div', { class: 'sch-detail' },
      h('div', { class: 'sch-det-proj' }, x.initials ? schBadge(x) : null, h('strong', null, x.projectName), x.priority === 'important' ? h('span', { class: 'pill overdue' }, '! Importante') : null,
        h('span', { class: `sch-st st-${x.status}` }, st.glyph ? `${st.glyph} ` : '', x.status === 'today' ? 'Hoje' : st.label)),
      x.note ? h('div', { class: 'sch-det-note' }, x.note) : null,
      h('dl', { class: 'sch-det-grid' },
        h('dt', null, 'Tipo'), h('dd', null, '🔔 Lembrete'),
        h('dt', null, 'Data'), h('dd', null, fmtDate(x.start)),
        h('dt', null, x.times.length > 1 ? 'Horários' : 'Horário'), h('dd', null, x.times.join(', ')),
        h('dt', null, 'Repetição'), h('dd', null, x.repeatText)),
      x.pending ? null : h('div', { class: 'hint' }, x.status === 'done' ? 'Ocorrência já concluída.' : x.status === 'past' ? 'Esta data ficou para trás (ocorrências perdidas não se acumulam).' : 'Ocorrência futura: só a pendente pode ser concluída (em Lembretes ou aqui, quando chegar).'))],
    footer: [
      h('button', { class: 'btn', onclick: () => { md.close(); location.hash = '#/reminders'; } }, 'Abrir Lembretes'),
      p ? h('button', { class: 'btn', onclick: () => { md.close(); location.hash = `#/project/${p.id}`; } }, 'Abrir projeto') : null,
      h('button', { class: 'btn', onclick: () => { md.close(); reminderForm(x.edit, done); } }, 'Editar'),
      x.pending && x.status !== 'done' ? h('button', { class: 'btn primary', onclick: (e) => busy(e.target, async () => {
        const r = await api('POST', `/api/reminders/${encodeURIComponent(x.remKey)}/complete`, {});
        await done(r.finished ? 'Lembrete concluído.' : `Ocorrência concluída. Próxima: ${fmtDate(r.next)}${r.nextAt ? ` às ${r.nextAt.slice(11)}` : ''}.`);
      }) }, x.edit.repeat || x.times.length > 1 ? 'Concluir esta' : 'Concluir') : null,
    ].filter(Boolean),
  });
}

function schDetail(x0, { onChanged } = {}) {
  if (schIsRem(x0)) return schReminderDetail(x0, { onChanged });
  const x = x0;
  const changed = () => { md.close(); if (onChanged) onChanged(); else render(); };
  const run = (btn, fn) => busy(btn, async () => { await fn(); await changed(); });
  const st = SCH_STATUS[x.status];
  const p = schProject(x);
  const readOnly = !!p?.cancelled; // o servidor também recusa (409 PROJECT_CANCELLED): aqui só não oferece os botões
  const editable = !readOnly && !!p;
  const remBox = x.reminder
    ? h('div', { class: 'sch-rem on' }, h('span', null, `🔔 Lembrete: ${schReminderText(x)} · ${fmtDate(x.reminder.notifyDate)} às ${x.reminder.time}`, x.reminder.dismissed ? h('span', { class: 'muted' }, ' (aviso dispensado)') : null),
      editable ? h('span', { class: 'actions inline' },
        h('button', { class: 'btn sm ghost', onclick: () => { md.close(); milestoneForm(p, schMilestone(x)); } }, 'Editar'),
        h('button', { class: 'btn sm ghost', onclick: (e) => run(e.target, async () => { await api('DELETE', `/api/reminders/${encodeURIComponent(`m:${x.projectId}:${x.milestoneId}`)}`); remRefresh(); await refreshQuiet(); toast('Lembrete removido. O prazo continua no cronograma.', 'ok'); }) }, 'Remover')) : null)
    : editable ? h('div', { class: 'sch-rem' }, h('span', { class: 'muted small' }, 'Criar lembrete:'),
      h('span', { class: 'chips' }, SCH_LEADS.map(([n, l]) => h('button', { class: 'btn sm', onclick: (e) => run(e.target, () => schSetReminder(x, n)) }, l)),
        h('button', { class: 'btn sm ghost', onclick: () => { md.close(); milestoneForm(p, schMilestone(x)); } }, 'Personalizado…')),
      h('span', { class: 'hint' }, 'A antecedência do lembrete é a mesma do aviso do prazo.')) : null;
  const md = openModal({
    title: x.title, size: 'md',
    body: [
      h('div', { class: 'sch-detail' },
        h('div', { class: 'sch-det-proj' }, schBadge(x), h('strong', null, x.projectName), h('span', { class: `sch-st st-${x.status}` }, st.glyph ? `${st.glyph} ` : '', st.label)),
        x.note ? h('div', { class: 'sch-det-note' }, x.note) : null,
        h('dl', { class: 'sch-det-grid' },
          h('dt', null, x.kind === 'period' ? 'Início' : 'Tipo'), h('dd', null, x.kind === 'period' ? fmtDate(x.start) : '◆ Prazo / marco (um dia)'),
          h('dt', null, x.kind === 'period' ? 'Fim (prazo)' : 'Data'), h('dd', null, fmtDate(x.end)),
          x.kind === 'period' ? [h('dt', null, 'Duração'), h('dd', null, plural(sdDiff(x.start, x.end) + 1, 'dia', 'dias'))] : null,
          h('dt', null, 'Situação'), h('dd', null, x.done ? 'Concluído' : daysText(x.days))),
        remBox,
        readOnly ? h('div', { class: 'hint' }, 'Projeto cancelado: o cronograma fica somente leitura até descancelar.') : null),
    ],
    footer: [
      h('button', { class: 'btn', onclick: () => { md.close(); location.hash = `#/project/${x.projectId}`; setTimeout(() => document.querySelector('[data-sec="cronograma"]')?.scrollIntoView({ block: 'start' }), 60); } }, 'Abrir projeto'),
      editable ? h('button', { class: 'btn', onclick: () => { md.close(); milestoneForm(p, schMilestone(x)); } }, 'Editar') : null,
      editable ? h('button', { class: `btn ${x.done ? '' : 'primary'}`, onclick: (e) => run(e.target, async () => { await schSaveMilestone(x, { done: !x.done }); toast(x.done ? 'Prazo reaberto.' : 'Prazo concluído.', 'ok'); }) }, x.done ? 'Reabrir' : 'Marcar como concluído') : null,
    ].filter(Boolean),
  });
}
async function refreshQuiet() { try { const s = await api('GET', '/api/state'); Object.assign(state, s); } catch { /* a próxima recarga corrige */ } }

// Itens de um dia (o “+N” e o clique no dia).
function schDayList(day, items, { onItem, projectId = null, onChanged } = {}) {
  const list = items.filter((x) => x.start <= day && x.end >= day);
  const after = async (msg) => { if (msg) toast(msg, 'ok'); await remRefresh(); if (onChanged) onChanged(); else render(); };
  const md = openModal({ title: `${fmtDate(day)}${day === state.today ? ' · hoje' : ''}`, size: 'md',
    body: list.length ? h('div', { class: 'sch-list' }, list.map((x) => schRowEl(x, { onItem: (y) => { md.close(); onItem(y); } }))) : h('div', { class: 'empty' }, 'Nada neste dia.'),
    footer: [h('button', { class: 'btn', onclick: () => { md.close(); reminderForm(null, after, { date: day, projectId }); } }, '+ Lembrete neste dia')] });
}

// Sugestão opcional de lembrete ao criar um prazo (nunca cria sozinho; dá para desligar).
function schSuggestReminder(p, m) {
  if (!uiPref('schSuggestRem', true) || !m || m.reminder) return;
  const x = p.scheduleItems?.find((y) => y.milestoneId === m.id);
  if (!x || x.done) return;
  const never = h('input', { type: 'checkbox' });
  const finish = () => { if (never.checked) setUiPref('schSuggestRem', false); md.close(); };
  const md = openModal({ title: 'Criar um lembrete para este prazo?', size: 'sm',
    body: [h('p', { style: 'margin:0' }, `${m.title} · ${fmtDate(m.dueDate)}`),
      h('div', { class: 'chips' }, [[1, '1 dia antes'], [3, '3 dias antes'], [7, '1 semana antes']].map(([n, l]) => h('button', { class: 'btn sm primary', onclick: (e) => busy(e.target, async () => { await schSetReminder(x, n); finish(); render(); }) }, l))),
      h('label', { class: 'check small' }, never, ' Não sugerir de novo (dá para criar pelo próprio prazo quando quiser)')],
    footer: [h('button', { class: 'btn', onclick: finish }, 'Não')] });
}

// Cor do projeto nas visões (paleta fixa; automática = escolhida pelo app).
function schColorPicker(p, after) {
  const id = p.scheduleIdentity || { color: 'ciano', auto: true, initials: '?' };
  const pick = (c) => async () => { try { replaceProjectQuiet(await api('PUT', `/api/projects/${p.id}/schedule-color`, { color: c })); md.close(); after && after(); } catch (e) { fail(e); } };
  const md = openModal({ title: `Cor de “${p.name}” nos cronogramas`, size: 'sm',
    body: [h('div', { class: 'sch-swatches' }, SCH_COLORS.map((c) => h('button', { type: 'button', class: `sch-swatch pc-${c}${!id.auto && id.color === c ? ' active' : ''}`, title: c, 'aria-label': `Cor ${c}`, onclick: pick(c) }, id.initials))),
      h('button', { class: `btn sm${id.auto ? ' primary' : ''}`, onclick: pick(null) }, 'Automática'),
      h('div', { class: 'hint' }, 'A cor só identifica o projeto nos calendários e na linha do tempo; as iniciais aparecem junto para não depender só da cor.')] });
}

// Barra de navegação (‹ Hoje › + rótulo do período).
function schNav(label, { prev, next, today }) {
  return h('div', { class: 'sch-nav' }, h('button', { class: 'btn sm ghost', title: 'Anterior', 'aria-label': 'Anterior', onclick: prev }, icon('chevronLeft', 15)),
    h('button', { class: 'btn sm', onclick: today }, 'Hoje'), h('button', { class: 'btn sm ghost', title: 'Próximo', 'aria-label': 'Próximo', onclick: next }, icon('chevronRight', 15)),
    h('strong', { class: 'sch-period' }, label));
}
const schSeg = (opts, cur, set, aria) => h('div', { class: 'sch-seg', role: 'group', 'aria-label': aria }, opts.map(([v, l]) => h('button', { type: 'button', class: cur === v ? 'active' : '', 'aria-pressed': cur === v ? 'true' : 'false', onclick: () => set(v) }, l)));

// Intervalo visível de cada visão (o servidor só devolve o que encosta nele).
function schVisible(v) {
  if (v.view === 'timeline') {
    if (v.span === 'month') return { from: sdMonth(v.anchor), to: sdMonthEnd(v.anchor), label: sdMonthLabel(v.anchor) };
    const from = sdWeek(v.anchor); const to = sdAdd(from, v.span - 1);
    return { from, to, label: `${fmtDate(from)} → ${fmtDate(to)}` };
  }
  if (v.mode === 'week') { const from = sdWeek(v.anchor); return { from, to: sdAdd(from, 6), label: `Semana de ${fmtDate(from)}` }; }
  return { from: sdWeek(sdMonth(v.anchor)), to: sdAdd(sdWeek(sdMonthEnd(v.anchor)), 6), label: sdMonthLabel(v.anchor) };
}
function schShift(v, dir) {
  if (v.view === 'timeline') return v.span === 'month' ? sdMonth(sdAdd(sdMonth(v.anchor), dir > 0 ? 32 : -1)) : sdAdd(v.anchor, dir * v.span);
  if (v.mode === 'week') return sdAdd(v.anchor, dir * 7);
  return sdMonth(sdAdd(sdMonth(v.anchor), dir > 0 ? 32 : -1));
}
// Corpo da visão (calendário mês/semana/agenda ou linha do tempo) — o mesmo desenho na Central e no projeto.
function schBody(v, items, today, opts) {
  const vis = schVisible(v);
  if (v.view === 'timeline') return schTimeline(items, vis.from, vis.to, today, opts);
  if (v.mode === 'week') return schWeekGrid(items, v.anchor, today, opts);
  if (v.mode === 'agenda') return schAgenda(items.filter((x) => x.end >= vis.from && x.start <= vis.to), today, opts);
  return schMonthGrid(items, v.anchor, today, opts);
}

// ---------- Central de Cronogramas (#/schedule) ----------
const SCH = { view: uiPref('schView', 'calendar'), mode: uiPref('schMode', 'month'), span: uiPref('schSpan', 'month'), anchor: null,
  f: { project: '', person: '', status: '', kind: '', quick: '', hideDone: uiPref('schHideDone', false) }, showRem: uiPref('schShowRem', true), seq: 0 };

async function renderSchedule(main) {
  if (!SCH.anchor) SCH.anchor = state.today;
  const seq = ++SCH.seq;
  const vis = schVisible(SCH);
  const q = new URLSearchParams({ from: vis.from, to: vis.to });
  for (const [k, val] of Object.entries(SCH.f)) if (val) q.set(k, val === true ? '1' : val);
  if (!SCH.showRem) q.set('reminders', '0');
  const pq = new URLSearchParams(); if (SCH.f.project) pq.set('project', SCH.f.project); if (SCH.f.person) pq.set('person', SCH.f.person);
  const page = h('div', { class: 'page sch-page' });
  main.append(page);
  let d; let up;
  try { [d, up] = await Promise.all([api('GET', `/api/schedule?${q}`), api('GET', `/api/schedule/upcoming?${pq}`)]); } catch (e) { fail(e); page.append(h('div', { class: 'empty' }, 'Não foi possível carregar os cronogramas.')); return; }
  if (seq !== SCH.seq || route().name !== 'schedule') return; // outra navegação já começou
  const redraw = () => { if (route().name === 'schedule') render(); };
  const set = (patch) => { Object.assign(SCH, patch); redraw(); };
  const setF = (patch) => { Object.assign(SCH.f, patch); if ('hideDone' in patch) setUiPref('schHideDone', patch.hideDone); redraw(); };
  const onItem = (x) => schDetail(x, { onChanged: redraw });
  const sel = (label, val, opts, onchange) => h('label', { class: 'sch-filter' }, h('span', null, label),
    h('select', { onchange: (e) => onchange(e.target.value) }, opts.map(([v, l]) => h('option', { value: v, selected: v === val }, l))));
  const hide = h('input', { type: 'checkbox', checked: SCH.f.hideDone, onchange: (e) => setF({ hideDone: e.target.checked }) });
  const showRem = h('input', { type: 'checkbox', checked: SCH.showRem, onchange: (e) => { setUiPref('schShowRem', e.target.checked); set({ showRem: e.target.checked }); } });
  const without = d.projects.filter((p) => !p.hasSchedule);
  const quick = [['', 'Todos'], ['today', 'Hoje'], ['week', 'Esta semana'], ['next30', 'Próximos 30 dias'], ['overdue', 'Atrasados']];

  page.append(
    h('div', { class: 'page-head' }, h('div', { class: 'grow' }, h('h1', null, 'Cronogramas'), h('div', { class: 'muted' }, 'Prazos, períodos e lembretes de todos os projetos, no mesmo lugar. Os dados são os do cronograma de cada projeto e os da página Lembretes.')),
      schSeg([['calendar', 'Calendário'], ['timeline', 'Linha do tempo']], SCH.view, (v) => { setUiPref('schView', v); set({ view: v }); }, 'Visualização')),
    h('div', { class: 'sch-toolbar' },
      schNav(vis.label, { prev: () => set({ anchor: schShift(SCH, -1) }), next: () => set({ anchor: schShift(SCH, 1) }), today: () => set({ anchor: state.today }) }),
      h('span', { class: 'grow' }),
      SCH.view === 'timeline'
        ? schSeg([['month', 'Mês'], [30, '30 dias'], [60, '60 dias'], [90, '90 dias']], SCH.span, (v) => { setUiPref('schSpan', v); set({ span: v }); }, 'Intervalo')
        : schSeg([['month', 'Mês'], ['week', 'Semana'], ['agenda', 'Agenda']], SCH.mode, (v) => { setUiPref('schMode', v); set({ mode: v }); }, 'Modo do calendário')),
    h('div', { class: 'sch-filters' },
      sel('Projeto', SCH.f.project, [['', 'Todos'], ...d.projects.map((p) => [p.id, p.name])], (v) => setF({ project: v })),
      d.people.length ? sel('Responsável', SCH.f.person, [['', 'Todos'], ...d.people.map((p) => [p.id, p.name])], (v) => setF({ person: v })) : null,
      sel('Status', SCH.f.status, [['', 'Todos'], ...Object.entries(SCH_STATUS).map(([k, s]) => [k, s.label])], (v) => setF({ status: v })),
      sel('Tipo', SCH.f.kind, [['', 'Todos'], ['period', 'Períodos'], ['deadline', 'Prazos (◆)'], ['reminder', 'Lembretes (🔔)']], (v) => setF({ kind: v })),
      h('div', { class: 'sch-quick', role: 'group', 'aria-label': 'Atalhos' }, quick.map(([v, l]) => h('button', { type: 'button', class: `chip-btn${SCH.f.quick === v ? ' active' : ''}`, 'aria-pressed': SCH.f.quick === v ? 'true' : 'false', onclick: () => setF({ quick: v }) }, l))),
      h('label', { class: 'check small' }, hide, ' Ocultar concluídos'),
      h('label', { class: 'check small', title: 'Lembretes avulsos (pontuais e recorrentes) da página Lembretes' }, showRem, ' Lembretes')),
    h('div', { class: 'sch-layout' },
      h('div', { class: 'sch-main' }, schBody(SCH, d.items, d.today, { onItem, onDay: (day) => schDayList(day, d.items, { onItem, projectId: SCH.f.project || null, onChanged: redraw }), projects: d.projects }),
        h('div', { class: 'sch-legend' },
          h('span', { class: 'sch-leg' }, h('span', { class: 'sch-leg-bar' }), 'Período'), h('span', { class: 'sch-leg' }, '◆ Prazo'), h('span', { class: 'sch-leg' }, '🔔 Prazo com lembrete'), h('span', { class: 'sch-leg' }, h('span', { class: 'sch-rem-time' }, '🔔09:00'), 'Lembrete'),
          Object.entries(SCH_STATUS).filter(([k]) => SCH_STATUS[k].glyph).map(([, s]) => h('span', { class: 'sch-leg' }, `${s.glyph} ${s.label}`)),
          without.length ? h('span', { class: 'sch-leg muted', title: without.map((p) => p.name).join('\n') }, `${plural(without.length, 'projeto sem cronograma', 'projetos sem cronograma')}`) : null)),
      schUpcoming(up, { onItem })));
}

// Painel “Próximos prazos” (atrasados + próximos 30 dias), agrupado por dia.
function schUpcoming(up, { onItem }) {
  const groups = new Map();
  for (const x of up.items) {
    const k = x.status === 'overdue' ? 'Atrasados' : x.end === up.today ? 'Hoje' : x.end === sdAdd(up.today, 1) ? 'Amanhã' : sdShort(x.end);
    if (!groups.has(k)) groups.set(k, []); groups.get(k).push(x);
  }
  const s = up.summary;
  return h('aside', { class: 'sch-side', 'aria-label': 'Próximos prazos' },
    h('h2', null, 'Próximos prazos'),
    h('div', { class: 'sch-sum' }, h('span', null, h('strong', null, s.week), ' esta semana'), h('span', { class: s.overdue ? 'bad' : '' }, h('strong', null, s.overdue), s.overdue === 1 ? ' atrasado' : ' atrasados'), h('span', null, h('strong', null, s.next30), ' em 30 dias')),
    groups.size ? [...groups].map(([k, list]) => h('div', { class: `sch-up-group${k === 'Atrasados' ? ' bad' : ''}` }, h('div', { class: 'sch-up-label' }, k), list.map((x) => schRowEl(x, { onItem, compact: true }))))
      : h('div', { class: 'empty small' }, 'Nenhum prazo pendente nos próximos 30 dias.'));
}

// ---------- Cronograma dentro do projeto: [Lista] [Calendário] [Linha do tempo] (mesmos dados) ----------
const SCH_PROJ = {}; // por projeto: visão e período visível (só nesta sessão)
function scheduleViews(p, listEl) {
  const v = SCH_PROJ[p.id] || (SCH_PROJ[p.id] = { view: uiPref('schProjView', 'list'), mode: 'month', span: 'month', anchor: state.today });
  const box = h('div', { class: 'sch-proj' });
  let rem = { key: '', items: [] }; // ocorrências dos lembretes deste projeto no intervalo visível
  const draw = () => {
    const vis = schVisible({ ...v, view: v.view === 'timeline' ? 'timeline' : 'calendar' });
    const want = `${vis.from}|${vis.to}`;
    if (v.view !== 'list' && rem.key !== want) {
      rem = { key: want, items: [] };
      api('GET', `/api/schedule?${new URLSearchParams({ from: vis.from, to: vis.to, project: p.id, kind: 'reminder' })}`)
        .then((d) => { if (rem.key === want && d.items.length) { rem.items = d.items; draw(); } }).catch(() => { /* sem lembretes na visão; o resto continua */ });
    }
    const items = [...(p.scheduleItems || []), ...(v.view === 'list' ? [] : rem.items)];
    const onItem = (x) => schDetail(x, { onChanged: () => render() });
    box.replaceChildren(
      h('div', { class: 'sch-toolbar' },
        schSeg([['list', 'Lista'], ['calendar', 'Calendário'], ['timeline', 'Linha do tempo']], v.view, (x) => { v.view = x; setUiPref('schProjView', x); draw(); }, 'Visualização do cronograma'),
        v.view === 'list' ? null : schNav(vis.label, { prev: () => { v.anchor = schShift({ ...v, view: v.view === 'timeline' ? 'timeline' : 'calendar' }, -1); draw(); }, next: () => { v.anchor = schShift({ ...v, view: v.view === 'timeline' ? 'timeline' : 'calendar' }, 1); draw(); }, today: () => { v.anchor = state.today; draw(); } })),
      v.view === 'list' ? listEl
        : items.length ? schBody({ ...v, view: v.view === 'timeline' ? 'timeline' : 'calendar' }, items, state.today, { onItem, onDay: (day) => schDayList(day, items, { onItem, projectId: p.id }), projects: [] })
          : h('div', { class: 'empty' }, 'Este projeto não tem cronograma — e tudo bem.'));
  };
  draw();
  return box;
}
