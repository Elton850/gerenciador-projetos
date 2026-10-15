// Cronograma simples: marcos (prazo/entrega) opcionais por projeto.
// Projeto sem marcos = "sem cronograma" (nunca é tratado como problema).
const DEFAULT_WARN_DAYS = 7;

const pad = (n) => String(n).padStart(2, '0');

function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function daysBetween(fromStr, toStr) {
  const [fy, fm, fd] = fromStr.split('-').map(Number);
  const [ty, tm, td] = toStr.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000);
}

function milestoneState(m, today, warnDays = DEFAULT_WARN_DAYS) {
  if (m.done) return { state: 'done', days: null };
  const days = daysBetween(today, m.dueDate);
  const limit = Number.isInteger(m.alertDays) && m.alertDays >= 0 ? m.alertDays : warnDays;
  if (days < 0) return { state: 'overdue', days };
  if (days <= limit) return { state: 'soon', days };
  return { state: 'ok', days };
}

const RANK = { overdue: 0, soon: 1, ok: 2 };

function projectSchedule(project, today = todayStr(), warnDays = DEFAULT_WARN_DAYS) {
  const ms = project.milestones || [];
  if (!ms.length) return { state: 'none', next: null, counts: { overdue: 0, soon: 0, pending: 0, done: 0 } };
  const counts = { overdue: 0, soon: 0, pending: 0, done: 0 };
  let next = null;
  let worst = null;
  for (const m of ms) {
    const s = milestoneState(m, today, warnDays);
    if (s.state === 'done') { counts.done++; continue; }
    counts.pending++;
    if (s.state === 'overdue') counts.overdue++;
    if (s.state === 'soon') counts.soon++;
    if (!next || m.dueDate < next.dueDate) next = { id: m.id, title: m.title, dueDate: m.dueDate, ...s };
    if (worst === null || RANK[s.state] < RANK[worst]) worst = s.state;
  }
  if (!counts.pending) return { state: 'done', next: null, counts };
  return { state: worst, next, counts };
}

// ---------- Itens do cronograma (Central de Cronogramas, visões do projeto, Visão Geral) ----------
// Um prazo pode ser um MARCO (só `dueDate`) ou um PERÍODO (`startDate` → `dueDate`). Dados antigos não têm `startDate` = marco.
// Tudo aqui é derivado (nunca gravado). A semântica (status) mora aqui; cores e textos ficam na tela.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const toUTC = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const fromUTC = (dt) => `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
const validDate = (s) => DATE_RE.test(String(s || '')) && fromUTC(toUTC(s)) === s;
const addDays = (s, n) => { const dt = toUTC(s); dt.setUTCDate(dt.getUTCDate() + n); return fromUTC(dt); };
const weekStart = (s) => addDays(s, -((toUTC(s).getUTCDay() + 6) % 7)); // segunda-feira da semana de `s`

// Identidade visual do projeto: chave de uma paleta fixa (a cor de verdade fica no CSS). Sem escolha = automática pelo id.
const SCHEDULE_COLORS = ['ciano', 'roxo', 'verde', 'laranja', 'rosa', 'lima', 'azul', 'coral'];
function autoColor(id) {
  let h = 0;
  for (const ch of String(id || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return SCHEDULE_COLORS[h % SCHEDULE_COLORS.length];
}
const SMALL_WORDS = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'a', 'o', '-', '–']);
function initials(name) {
  const words = String(name || '').trim().split(/\s+/).filter((w) => w && !SMALL_WORDS.has(w.toLowerCase()));
  const s = words.length > 1 ? words[0][0] + words[1][0] : (words[0] || '?').slice(0, 2);
  return s.toUpperCase();
}
function scheduleIdentity(p) {
  const chosen = SCHEDULE_COLORS.includes(p.scheduleColor) ? p.scheduleColor : null;
  return { color: chosen || autoColor(p.id), auto: !chosen, initials: initials(p.name) };
}

// Status de UM item (regra única): concluído → atrasado (fim < hoje) → hoje (fim = hoje) → próximo (dentro do aviso) →
// em andamento (período já começou) → normal. Mesma antecedência de `milestoneState` (alertDays do prazo, senão warnDays).
function itemStatus(m, today, warnDays = DEFAULT_WARN_DAYS) {
  const s = milestoneState(m, today, warnDays);
  if (s.state === 'done' || s.state === 'overdue') return { status: s.state, days: s.days };
  if (s.days === 0) return { status: 'today', days: 0 };
  if (s.state === 'soon') return { status: 'soon', days: s.days };
  if (m.startDate && m.startDate <= today) return { status: 'running', days: s.days };
  return { status: 'ok', days: s.days };
}

function scheduleItems(p, today = todayStr(), warnDays = DEFAULT_WARN_DAYS) {
  const id = scheduleIdentity(p);
  return (p.milestones || []).filter((m) => validDate(m.dueDate)).map((m) => {
    const lead = Number.isInteger(m.alertDays) && m.alertDays >= 0 ? m.alertDays : warnDays;
    const start = validDate(m.startDate) && m.startDate < m.dueDate ? m.startDate : m.dueDate;
    const st = itemStatus({ ...m, startDate: start === m.dueDate ? null : start }, today, warnDays);
    const rem = m.reminder;
    return {
      key: `${p.id}:${m.id}`, projectId: p.id, projectName: p.name, color: id.color, initials: id.initials, milestoneId: m.id,
      title: m.title, note: m.note || '', start, end: m.dueDate, kind: start === m.dueDate ? 'deadline' : 'period',
      alertDays: Number.isInteger(m.alertDays) ? m.alertDays : null, lead, done: !!m.done, ...st,
      reminder: rem ? { time: rem.time, lead, notifyDate: addDays(m.dueDate, -lead), dismissed: rem.dismissedFor === m.dueDate, snoozeUntil: rem.snoozeUntil || null } : null,
    };
  });
}

// Item que encosta no intervalo [from, to] (períodos que atravessam o mês/ano entram nos dois lados).
const overlaps = (x, from, to) => (!to || x.start <= to) && (!from || x.end >= from);

// Atalhos e filtros (regra no servidor; a tela só escolhe). quick: today | week | next30 | overdue.
function quickRange(quick, today) {
  if (quick === 'today') return [today, today];
  if (quick === 'week') { const ws = weekStart(today); return [ws, addDays(ws, 6)]; }
  if (quick === 'next30') return [today, addDays(today, 30)];
  return null;
}
function filterItems(items, { from, to, quick, status, kind, hideDone, today = todayStr() } = {}) {
  const q = quickRange(quick, today);
  return items.filter((x) => overlaps(x, from, to) && (!q || overlaps(x, q[0], q[1])) && (quick !== 'overdue' || x.status === 'overdue')
    && (!status || x.status === status) && (!kind || x.kind === kind) && (!hideDone || !x.done));
}

// Próximos prazos: pendentes atrasados + os que vencem até `horizon` dias (ordem: data do fim).
function upcoming(items, today = todayStr(), horizon = 30) {
  const limit = addDays(today, horizon);
  return items.filter((x) => !x.done && (x.status === 'overdue' || (x.end >= today && x.end <= limit)))
    .sort((a, b) => a.end.localeCompare(b.end) || a.projectName.localeCompare(b.projectName, 'pt-BR'));
}
// Resumo para a Visão Geral: atrasados, vencem hoje, nesta semana (até domingo) e nos próximos 30 dias.
function scheduleSummary(items, today = todayStr()) {
  const pend = items.filter((x) => !x.done);
  const weekEnd = addDays(weekStart(today), 6);
  const between = (a, b) => pend.filter((x) => x.end >= a && x.end <= b).length;
  return { overdue: pend.filter((x) => x.status === 'overdue').length, today: between(today, today), week: between(today, weekEnd), next30: between(today, addDays(today, 30)) };
}

module.exports = {
  todayStr, daysBetween, milestoneState, projectSchedule, DEFAULT_WARN_DAYS,
  validDate, addDays, weekStart, SCHEDULE_COLORS, autoColor, initials, scheduleIdentity, itemStatus, scheduleItems, overlaps, quickRange, filterItems, upcoming, scheduleSummary,
};
