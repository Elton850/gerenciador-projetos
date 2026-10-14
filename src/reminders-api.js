// Lembretes: rotas. Regras em src/reminders.js. Dados locais em projects.json (data.reminders + marco.reminder) — entram
// sozinhos no Backup (.gpbackup leva o JSON inteiro, com os mesmos ids de projeto e marco).
// Chave de um item: "r:<id>" (lembrete avulso) ou "m:<projectId>:<milestoneId>" (lembrete de um prazo do cronograma).
const { httpError, uid, str } = require('./util');
const R = require('./reminders');
const { todayStr, DEFAULT_WARN_DAYS } = require('./schedule');

const FILTERS = {
  all: (x) => !x.done, today: (x) => x.status === 'today', upcoming: (x) => ['soon', 'later', 'snoozed'].includes(x.status),
  overdue: (x) => x.status === 'overdue', done: (x) => x.done,
};

function mount(app, { store }) {
  const data = () => store.data;
  const warnDays = () => (Number.isInteger(data().settings?.warnDays) ? data().settings.warnDays : DEFAULT_WARN_DAYS);

  // "r:<id>" → lembrete avulso; "m:<projeto>:<marco>" → o prazo (com lembrete ligado).
  function target(key) {
    const k = String(key || '');
    if (k.startsWith('r:')) {
      const r = data().reminders.find((x) => x.id === k.slice(2));
      if (!r) throw httpError(404, 'Lembrete não encontrado.');
      return { kind: 'reminder', r };
    }
    const m_ = k.match(/^m:([^:]+):([^:]+)$/);
    if (m_) {
      const p = data().projects.find((x) => x.id === m_[1]);
      const m = p?.milestones?.find((x) => x.id === m_[2]);
      if (!m || !m.reminder) throw httpError(404, 'Este prazo não tem (mais) lembrete.');
      return { kind: 'milestone', p, m };
    }
    throw httpError(400, 'Lembrete inválido.');
  }

  app.get('/api/reminders', (req, res) => {
    const now = R.nowKey();
    const all = R.listReminders(data(), { now, warnDays: warnDays() });
    const f = FILTERS[req.query.filter] || FILTERS.all;
    const project = str(req.query.project, 40);
    const items = all.filter((x) => f(x) && (!project || x.projectId === project));
    const pending = all.filter((x) => !x.done);
    res.json({ now, nowMs: Date.now(), today: todayStr(), items, hoursLinks: data().hours?.links || { psaUrl: '', sheetUrl: '' },
      counts: { overdue: pending.filter((x) => x.status === 'overdue').length, today: pending.filter((x) => x.status === 'today').length, pending: pending.length },
      due: R.dueForNotification(all, now).map((x) => ({ key: x.key, notifyAt: x.notifyAt, title: x.title, projectName: x.projectName, at: x.reachedAt || x.at, dueDay: x.dueDay || null })) });
  });

  app.post('/api/reminders', (req, res) => {
    const today = todayStr();
    const clean = R.cleanReminder(req.body, data().projects, today, data().emailTemplates || []);
    const first = R.firstPending(clean, R.nowKey());
    if (!first) throw httpError(400, 'Não há nenhuma ocorrência a partir de agora (confira a data final).');
    const now = new Date().toISOString();
    const r = { id: uid(), ...clean, current: first.date, slot: first.slot, snoozeUntil: null, doneAt: null, completions: [], notified: null, createdAt: now, updatedAt: now };
    data().reminders.push(r);
    store.save();
    res.json({ ok: true, key: `r:${r.id}` });
  });

  // Editar: mudou data, hora ou recorrência → a ocorrência pendente é recalculada (e o adiamento/aviso já dado, zerados).
  app.put('/api/reminders/:id', (req, res) => {
    const { r } = target(`r:${req.params.id}`);
    const today = todayStr();
    const clean = R.cleanReminder(req.body, data().projects, today, data().emailTemplates || []);
    const changed = ['date', 'until'].some((f) => clean[f] !== r[f]) || JSON.stringify(clean.repeat) !== JSON.stringify(r.repeat) || JSON.stringify(clean.times) !== JSON.stringify(R.timesOf(r));
    Object.assign(r, clean, { updatedAt: new Date().toISOString() });
    if (changed) {
      const first = R.firstPending(r, R.nowKey());
      if (!first) throw httpError(400, 'Não há nenhuma ocorrência a partir de agora (confira a data final).');
      Object.assign(r, { current: first.date, slot: first.slot, doneAt: null, snoozeUntil: null, notified: null });
    }
    store.save();
    res.json({ ok: true });
  });

  // Excluir: avulso some; do cronograma, só o lembrete é desligado — o prazo continua no cronograma.
  app.delete('/api/reminders/:key', (req, res) => {
    const t = target(req.params.key);
    if (t.kind === 'reminder') data().reminders = data().reminders.filter((x) => x !== t.r);
    else t.m.reminder = null;
    store.save();
    res.json({ ok: true, kept: t.kind === 'milestone' ? 'prazo mantido no cronograma' : null });
  });

  // Concluir: pontual encerra; recorrente conclui só esta ocorrência; do cronograma dispensa o aviso DESTE prazo (se a data do
  // prazo mudar, volta a avisar) — entregar o prazo continua sendo o checkbox do cronograma.
  app.post('/api/reminders/:key/complete', (req, res) => {
    const t = target(req.params.key);
    let out;
    if (t.kind === 'reminder') out = R.completeReminder(t.r, R.nowKey());
    else {
      if (t.m.done || t.m.reminder.dismissedFor === t.m.dueDate) throw httpError(400, 'Este aviso já foi concluído.');
      Object.assign(t.m.reminder, { dismissedFor: t.m.dueDate, snoozeUntil: null });
      out = { finished: true, next: null };
    }
    store.save();
    res.json({ ok: true, ...out });
  });

  // Adiar até um horário (1 hora, 1 dia ou escolhido): o item sai dos pendentes até lá e volta a avisar uma vez.
  app.post('/api/reminders/:key/snooze', (req, res) => {
    const t = target(req.params.key);
    const until = R.cleanKey(req.body.until);
    if (until <= R.nowKey()) throw httpError(400, 'Escolha um horário no futuro.');
    if (t.kind === 'reminder') {
      if (t.r.doneAt || !t.r.current) throw httpError(400, 'Este lembrete já foi concluído.');
      t.r.snoozeUntil = until;
    } else t.m.reminder.snoozeUntil = until;
    store.save();
    res.json({ ok: true, until });
  });

  // A tela avisou (notificação do Windows/aviso no app): grava a ocorrência avisada para nunca repetir o mesmo aviso.
  app.post('/api/reminders/notified', (req, res) => {
    const list = Array.isArray(req.body.items) ? req.body.items.slice(0, 200) : [];
    let n = 0;
    for (const it of list) {
      let t;
      try { t = target(it.key); } catch { continue; }
      const at = R.cleanKey(it.notifyAt);
      if (t.kind === 'reminder') t.r.notified = at; else t.m.reminder.notified = at;
      n++;
    }
    if (n) store.save();
    res.json({ ok: true, marked: n });
  });
}

module.exports = { mount };
