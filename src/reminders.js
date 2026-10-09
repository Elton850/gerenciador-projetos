// Lembretes (regras puras, sem disco nem HTTP). Duas origens, uma lista só:
//  - avulsos: data.reminders[] — pontuais ou recorrentes, com ou sem projeto;
//  - do cronograma: marco do projeto com `reminder` (NÃO é cópia: data = marco.dueDate, antecedência = marco.alertDays ou o
//    padrão warnDays, hora do aviso = reminder.time). Mudou a data do marco → o lembrete acompanha; removeu o marco → some junto.
// Datas e horas locais em texto: 'AAAA-MM-DD' e 'AAAA-MM-DDTHH:MM' (comparáveis como texto, sem fuso).
const { httpError } = require('./util');
const { daysBetween } = require('./schedule');

const pad = (n) => String(n).padStart(2, '0');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const KEY_RE = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/;
const UNITS = { day: 365, week: 52, month: 12 }; // máximo de "a cada N"
const MAX_STEPS = 5000;

const nowKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const toDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const fromDate = (dt) => `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
const addDays = (s, n) => { const dt = toDate(s); dt.setUTCDate(dt.getUTCDate() + n); return fromDate(dt); };
const isoDow = (s) => ((toDate(s).getUTCDay() + 6) % 7) + 1; // 1 = segunda … 7 = domingo
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m = 1..12
const validDate = (s) => DATE_RE.test(String(s || '')) && fromDate(toDate(s)) === s;

// ---------- Validação ----------
function cleanDate(v, what = 'Data') {
  const s = String(v ?? '').trim();
  if (!validDate(s)) throw httpError(400, `${what} inválida.`);
  return s;
}
function cleanTime(v, fallback = '09:00') {
  const s = String(v ?? '').trim() || fallback;
  if (!TIME_RE.test(s)) throw httpError(400, 'Hora inválida (use HH:MM).');
  return s;
}
function cleanKey(v) {
  const s = String(v ?? '').trim();
  if (!KEY_RE.test(s) || !validDate(s.slice(0, 10))) throw httpError(400, 'Data e hora inválidas.');
  return s;
}
// Recorrência: null (pontual) ou { unit: day|week|month, every, weekdays? (só semana, 1..7), monthDays? (só mês, 1..31) }.
function cleanRepeat(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const unit = Object.prototype.hasOwnProperty.call(UNITS, raw.unit) ? raw.unit : null;
  if (!unit) throw httpError(400, 'Recorrência inválida.');
  const every = Number(raw.every ?? 1);
  if (!Number.isInteger(every) || every < 1 || every > UNITS[unit]) throw httpError(400, `“A cada” deve ser de 1 a ${UNITS[unit]}.`);
  const out = { unit, every };
  const ints = (arr, min, max) => [...new Set((Array.isArray(arr) ? arr : []).map(Number))].filter((x) => Number.isInteger(x) && x >= min && x <= max).sort((a, b) => a - b);
  if (unit === 'week') { const w = ints(raw.weekdays, 1, 7); if (w.length) out.weekdays = w; }
  if (unit === 'month') { const d = ints(raw.monthDays, 1, 31); if (d.length) out.monthDays = d; }
  return out;
}

// ---------- Ocorrências ----------
// Primeira ocorrência na data `from` ou depois dela (start = 1ª data da série). null = acabou (passou de `until`).
function nextOnOrAfter({ start, repeat, until }, from) {
  const target = from > start ? from : start;
  let out = null;
  if (!repeat) out = start >= from ? start : null;
  else if (repeat.unit === 'day' || (repeat.unit === 'week' && !repeat.weekdays)) {
    const step = repeat.every * (repeat.unit === 'week' ? 7 : 1);
    const k = Math.ceil(daysBetween(start, target) / step);
    out = addDays(start, k * step);
  } else if (repeat.unit === 'week') {
    const monday = addDays(start, 1 - isoDow(start)); // semanas contadas a partir da semana da 1ª data
    for (let i = 0, d = target; i < MAX_STEPS && !out; i++, d = addDays(d, 1)) {
      const week = Math.floor(daysBetween(monday, d) / 7);
      if (week % repeat.every === 0 && repeat.weekdays.includes(isoDow(d))) out = d;
    }
  } else {
    const [sy, sm, sd] = start.split('-').map(Number);
    const days = repeat.monthDays || [sd];
    for (let k = 0; k < MAX_STEPS && !out; k += repeat.every) {
      const y = sy + Math.floor((sm - 1 + k) / 12);
      const m = ((sm - 1 + k) % 12) + 1;
      const last = daysInMonth(y, m);
      for (const d of [...new Set(days.map((x) => Math.min(x, last)))].sort((a, b) => a - b)) { // dia 31 em mês curto = último dia
        const s = `${y}-${pad(m)}-${pad(d)}`;
        if (s >= target) { out = s; break; }
      }
    }
  }
  return out && until && out > until ? null : out;
}

// Texto da recorrência, para a tela.
const WD = ['', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom'];
function repeatText(r, until) {
  if (!r) return 'Pontual';
  const n = r.every;
  let t;
  if (r.unit === 'day') t = n === 1 ? 'Todo dia' : `A cada ${n} dias`;
  else if (r.unit === 'week') t = `${n === 1 ? 'Toda semana' : `A cada ${n} semanas`}${r.weekdays ? ` (${r.weekdays.map((d) => WD[d]).join(', ')})` : ''}`;
  else t = `${n === 1 ? 'Todo mês' : `A cada ${n} meses`}${r.monthDays ? ` (dias ${r.monthDays.join(', ')})` : ''}`;
  return `${t}${until ? ` · até ${until.split('-').reverse().join('/')}` : ''}`;
}

// ---------- Lembretes avulsos ----------
// Cadastro/edição: devolve os campos editáveis validados. A ocorrência pendente (`current`) é recalculada a partir de hoje.
function cleanReminder(b, projects, today) {
  const title = String(b.title ?? '').trim().slice(0, 160);
  if (!title) throw httpError(400, 'Informe o título do lembrete.');
  const projectId = b.projectId ? String(b.projectId) : null;
  if (projectId && !projects.some((p) => p.id === projectId)) throw httpError(400, 'Projeto inexistente.');
  const date = cleanDate(b.date, 'Data inicial');
  const repeat = cleanRepeat(b.repeat);
  const until = repeat && b.until ? cleanDate(b.until, 'Data final') : null;
  if (until && until < date) throw httpError(400, 'A data final é anterior à data inicial.');
  const out = { title, description: String(b.description ?? '').trim().slice(0, 1000), projectId, date, time: cleanTime(b.time), priority: b.priority === 'important' ? 'important' : 'normal', repeat, until };
  if (repeat && !nextOnOrAfter({ start: date, repeat, until }, date)) throw httpError(400, 'Esta recorrência não tem nenhuma data até a data final.');
  return out;
}
// Ocorrência pendente depois de criar/editar: pontual = a própria data; recorrente = a primeira a partir de hoje (ou do início).
function firstPending(r, today) {
  if (!r.repeat) return r.date;
  return nextOnOrAfter({ start: r.date, repeat: r.repeat, until: r.until }, today < r.date ? r.date : today);
}

// Concluir: pontual encerra; recorrente conclui SÓ esta ocorrência e passa para a próxima. Ocorrências que ficaram para trás
// (app fechado vários dias) não se acumulam: a próxima é a partir de hoje.
function completeReminder(r, today, at = new Date().toISOString()) {
  if (r.doneAt || !r.current) throw httpError(400, 'Este lembrete já foi concluído.');
  r.completions = [...(r.completions || []), { date: r.current, at }].slice(-50);
  r.snoozeUntil = null;
  if (!r.repeat) { r.doneAt = at; return { finished: true, next: null }; }
  const series = { start: r.date, repeat: r.repeat, until: r.until };
  let next = nextOnOrAfter(series, addDays(r.current, 1));
  if (next && next < today) next = nextOnOrAfter(series, today);
  r.notified = null;
  if (!next) { r.current = null; r.doneAt = at; return { finished: true, next: null }; }
  r.current = next;
  return { finished: false, next };
}

// ---------- Lista única (avulsos + cronograma) ----------
const RANK = { overdue: 0, today: 1, soon: 2, later: 3, snoozed: 3, done: 4 };
function statusOf({ done, at, dueDay, notifyAt, snoozeUntil }, now, soonDays) {
  if (done) return 'done';
  const today = now.slice(0, 10);
  if (snoozeUntil && snoozeUntil > now) return 'snoozed';
  if (dueDay ? dueDay < today : at < now) return 'overdue';
  if ((dueDay || at.slice(0, 10)) === today) return 'today';
  if (notifyAt <= now || daysBetween(today, (dueDay || at.slice(0, 10))) <= soonDays) return 'soon';
  return 'later';
}

function listReminders(state, { now = nowKey(), warnDays = 7 } = {}) {
  const projects = state.projects || [];
  const pname = (id) => projects.find((p) => p.id === id)?.name || null;
  const items = [];
  for (const r of state.reminders || []) {
    const done = !!r.doneAt || !r.current;
    const at = r.current ? `${r.current}T${r.time}` : `${r.date}T${r.time}`;
    const notifyAt = r.snoozeUntil || at;
    items.push({ key: `r:${r.id}`, kind: 'reminder', id: r.id, title: r.title, description: r.description, projectId: r.projectId, projectName: pname(r.projectId),
      date: r.date, time: r.time, priority: r.priority, repeat: r.repeat, until: r.until, repeatText: repeatText(r.repeat, r.until), at, notifyAt, snoozeUntil: r.snoozeUntil || null,
      done, doneAt: r.doneAt || null, completions: (r.completions || []).length, notified: r.notified || null,
      status: statusOf({ done, at, notifyAt, snoozeUntil: r.snoozeUntil }, now, warnDays) });
  }
  for (const p of projects) {
    for (const m of p.milestones || []) {
      if (!m.reminder) continue;
      const lead = Number.isInteger(m.alertDays) && m.alertDays >= 0 ? m.alertDays : warnDays;
      const rem = m.reminder;
      const done = !!m.done || rem.dismissedFor === m.dueDate;
      const notifyAt = rem.snoozeUntil || `${addDays(m.dueDate, -lead)}T${rem.time}`;
      items.push({ key: `m:${p.id}:${m.id}`, kind: 'milestone', id: m.id, title: m.title, description: m.note || '', projectId: p.id, projectName: p.name,
        date: m.dueDate, time: rem.time, lead, priority: 'normal', repeat: null, until: null, repeatText: lead ? `Prazo do cronograma · avisar ${lead} dia(s) antes às ${rem.time}` : `Prazo do cronograma · avisar no dia às ${rem.time}`,
        at: `${m.dueDate}T23:59`, dueDay: m.dueDate, notifyAt, snoozeUntil: rem.snoozeUntil || null, done, doneAt: m.done ? 'prazo concluído' : rem.dismissedFor === m.dueDate ? 'aviso dispensado' : null,
        milestoneDone: !!m.done, notified: rem.notified || null,
        status: statusOf({ done, at: `${m.dueDate}T23:59`, dueDay: m.dueDate, notifyAt, snoozeUntil: rem.snoozeUntil }, now, lead) });
    }
  }
  // Ordem: atrasados → hoje → próximos → demais; dentro do grupo, o mais cedo primeiro (importante antes, no empate).
  items.sort((a, b) => RANK[a.status] - RANK[b.status] || (a.status === 'done' ? String(b.doneAt).localeCompare(String(a.doneAt)) : a.at.localeCompare(b.at)) || (a.priority === 'important' ? -1 : 0) - (b.priority === 'important' ? -1 : 0));
  return items;
}

// Lembretes que chegaram no horário e ainda não foram notificados (cada ocorrência/adiamento notifica uma vez só).
function dueForNotification(items, now = nowKey()) {
  return items.filter((x) => !x.done && x.notifyAt <= now && x.notified !== x.notifyAt);
}

module.exports = { nowKey, addDays, isoDow, cleanDate, cleanTime, cleanKey, cleanRepeat, cleanReminder, firstPending, nextOnOrAfter, completeReminder, listReminders, dueForNotification, repeatText };
