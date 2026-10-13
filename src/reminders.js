// Lembretes (regras puras, sem disco nem HTTP). Duas origens, uma lista só:
//  - avulsos: data.reminders[] — pontuais ou recorrentes, com ou sem projeto;
//  - do cronograma: marco do projeto com `reminder` (NÃO é cópia: data = marco.dueDate, antecedência = marco.alertDays ou o
//    padrão warnDays, hora do aviso = reminder.time). Mudou a data do marco → o lembrete acompanha; removeu o marco → some junto.
// Datas e horas locais em texto: 'AAAA-MM-DD' e 'AAAA-MM-DDTHH:MM' (comparáveis como texto, sem fuso).
// Vários horários por dia (`times`): cada data × horário é uma OCORRÊNCIA independente; a pendente é `current` (data) + `slot` (hora).
// Ação opcional (`action`): só botões no card (abrir projeto/link/Controle de Horas, gerar comunicação) — nada é executado sozinho.
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
const MAX_TIMES = 12;
// Horários do lembrete: lista (ou um só, como antes), sem repetidos, em ordem.
function cleanTimes(b) {
  const raw = Array.isArray(b.times) && b.times.length ? b.times : [b.time];
  const out = [...new Set(raw.map((t) => cleanTime(t)))].sort();
  if (out.length > MAX_TIMES) throw httpError(400, `No máximo ${MAX_TIMES} horários por lembrete.`);
  return out;
}
const timesOf = (r) => (Array.isArray(r.times) && r.times.length ? r.times : [r.time || '09:00']);
const slotOf = (r) => (r.slot && timesOf(r).includes(r.slot) ? r.slot : timesOf(r)[0]);

// Ação opcional: { kind: 'project' } (projeto do lembrete) · { kind: 'link', url } · { kind: 'hours', templateId? } (Controle de Horas
// do mês atual: abrir tela, PSA, planilha e gerar e-mail) · { kind: 'email', templateId } (comunicação do projeto do lembrete).
const ACTION_KINDS = ['project', 'link', 'hours', 'email'];
function cleanAction(a, { projectId, templates = [] }) {
  if (!a || !a.kind || a.kind === 'none') return null;
  if (!ACTION_KINDS.includes(a.kind)) throw httpError(400, 'Ação do lembrete inválida.');
  const tplOk = (id, { global }) => {
    const t = templates.find((x) => x.id === id);
    if (!t || !t.active) throw httpError(400, 'Escolha um modelo de comunicação ativo.');
    if (global && t.scope !== 'global') throw httpError(400, 'Para o Controle de Horas, escolha um modelo global.');
    if (!global && t.scope === 'project' && t.projectId !== projectId) throw httpError(400, 'O modelo escolhido é de outro projeto.');
    return t.id;
  };
  if (a.kind === 'project') { if (!projectId) throw httpError(400, 'A ação “Abrir projeto” precisa de um projeto no lembrete.'); return { kind: 'project' }; }
  if (a.kind === 'link') {
    const url = String(a.url ?? '').trim().slice(0, 600);
    let u = null; try { u = new URL(url); } catch { /* inválida */ }
    if (!u || !/^https?:$/.test(u.protocol)) throw httpError(400, 'O link da ação precisa começar com http:// ou https://.');
    return { kind: 'link', url, label: String(a.label ?? '').trim().slice(0, 60) };
  }
  if (a.kind === 'hours') return { kind: 'hours', templateId: a.templateId ? tplOk(String(a.templateId), { global: true }) : null };
  if (!projectId) throw httpError(400, 'A ação “Gerar comunicação” precisa de um projeto no lembrete.');
  return { kind: 'email', templateId: tplOk(String(a.templateId || ''), { global: false }) };
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
function cleanReminder(b, projects, today, templates = []) {
  const title = String(b.title ?? '').trim().slice(0, 160);
  if (!title) throw httpError(400, 'Informe o título do lembrete.');
  const projectId = b.projectId ? String(b.projectId) : null;
  if (projectId && !projects.some((p) => p.id === projectId)) throw httpError(400, 'Projeto inexistente.');
  const date = cleanDate(b.date, 'Data inicial');
  const repeat = cleanRepeat(b.repeat);
  const until = repeat && b.until ? cleanDate(b.until, 'Data final') : null;
  if (until && until < date) throw httpError(400, 'A data final é anterior à data inicial.');
  const times = cleanTimes(b);
  const out = { title, description: String(b.description ?? '').trim().slice(0, 1000), projectId, date, time: times[0], times, priority: b.priority === 'important' ? 'important' : 'normal', repeat, until,
    action: cleanAction(b.action, { projectId, templates }) };
  if (repeat && !nextOnOrAfter({ start: date, repeat, until }, date)) throw httpError(400, 'Esta recorrência não tem nenhuma data até a data final.');
  return out;
}
// Próxima ocorrência (data + horário) em `from` ou depois ('AAAA-MM-DDTHH:MM'). null = a série acabou. Pontual = só a data inicial.
function nextOccurrence(r, from) {
  const series = { start: r.date, repeat: r.repeat || null, until: r.until || null };
  const times = timesOf(r);
  const fromDay = from.slice(0, 10); const fromTime = from.slice(11);
  let d = nextOnOrAfter(series, fromDay);
  if (d === fromDay) { const t = times.find((x) => x >= fromTime); if (t) return { date: d, slot: t }; d = nextOnOrAfter(series, addDays(d, 1)); }
  return d ? { date: d, slot: times[0] } : null;
}
// Ocorrência pendente depois de criar/editar: pontual = a 1ª do dia (atrasada se a data já passou); recorrente = a primeira a partir de agora.
// `now` aceita 'AAAA-MM-DD' (meia-noite) ou 'AAAA-MM-DDTHH:MM'.
function firstPending(r, now) {
  const n = now.length === 10 ? `${now}T00:00` : now;
  if (!r.repeat) return { date: r.date, slot: timesOf(r)[0] };
  return nextOccurrence(r, n < `${r.date}T00:00` ? `${r.date}T00:00` : n);
}

// Concluir: conclui SÓ a ocorrência pendente (data + horário) e passa para a próxima (mesmo dia, próximo horário; senão o 1º horário
// do próximo dia da série). Pontual com um horário encerra; com vários, encerra depois do último. Ocorrências que ficaram para
// trás (app fechado) não se acumulam: a próxima é a partir de agora. `now` aceita 'AAAA-MM-DD' ou 'AAAA-MM-DDTHH:MM'.
function completeReminder(r, now, at = new Date().toISOString()) {
  if (r.doneAt || !r.current) throw httpError(400, 'Este lembrete já foi concluído.');
  const n = now.length === 10 ? `${now}T00:00` : now;
  const slot = slotOf(r);
  r.completions = [...(r.completions || []), { date: r.current, time: slot, at }].slice(-50);
  r.snoozeUntil = null;
  r.notified = null;
  const after = `${r.current}T${slot}`;
  const times = timesOf(r);
  const later = times.find((t) => t > slot);
  let next = later ? { date: r.current, slot: later } : (r.repeat ? nextOccurrence(r, `${addDays(r.current, 1)}T00:00`) : null);
  if (next && `${next.date}T${next.slot}` < n && r.repeat) next = nextOccurrence(r, n);
  if (!next || `${next.date}T${next.slot}` <= after) { r.current = null; r.slot = null; r.doneAt = at; return { finished: true, next: null }; }
  r.current = next.date; r.slot = next.slot;
  return { finished: false, next: next.date, nextAt: `${next.date}T${next.slot}` };
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
  const cancelled = new Set(projects.filter((p) => p.cancelled).map((p) => p.id));
  for (const r of state.reminders || []) {
    const done = !!r.doneAt || !r.current;
    if (!done && r.projectId && cancelled.has(r.projectId)) continue; // projeto cancelado: sem lembrete (volta ao descancelar)
    const times = timesOf(r);
    const at = r.current ? `${r.current}T${slotOf(r)}` : `${r.date}T${times[0]}`;
    const notifyAt = r.snoozeUntil || at;
    // Ocorrências de HOJE (quando o lembrete tem vários horários): concluída / pendente / próxima.
    const today = now.slice(0, 10);
    const occursToday = times.length > 1 && (r.current === today || (r.completions || []).some((c) => c.date === today));
    const todaySlots = occursToday ? times.map((t) => ({ time: t, state: (r.completions || []).some((c) => c.date === today && c.time === t) ? 'done' : r.current === today && t === slotOf(r) ? 'pending' : r.current === today && t > slotOf(r) ? 'next' : 'skipped' })) : null;
    items.push({ key: `r:${r.id}`, kind: 'reminder', id: r.id, title: r.title, description: r.description, projectId: r.projectId, projectName: pname(r.projectId),
      date: r.date, time: times[0], times, slot: r.current ? slotOf(r) : null, todaySlots, action: r.action || null, priority: r.priority, repeat: r.repeat, until: r.until,
      repeatText: `${repeatText(r.repeat, r.until)}${times.length > 1 ? ` · ${times.join(', ')}` : ''}`, at, notifyAt, snoozeUntil: r.snoozeUntil || null,
      done, doneAt: r.doneAt || null, completions: (r.completions || []).length, notified: r.notified || null,
      status: statusOf({ done, at, notifyAt, snoozeUntil: r.snoozeUntil }, now, warnDays) });
  }
  for (const p of projects) {
    if (p.cancelled) continue; // projeto cancelado: sem aviso de prazo (volta ao descancelar)
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

module.exports = { nowKey, addDays, isoDow, cleanDate, cleanTime, cleanKey, cleanRepeat, cleanTimes, cleanAction, timesOf, cleanReminder, firstPending, nextOnOrAfter, nextOccurrence, completeReminder, listReminders, dueForNotification, repeatText };
