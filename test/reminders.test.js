// Lembretes: recorrências, conclusão, adiamento, ordem dos cards, integração com o cronograma (sem cópia) e backup.
// Regras puras com datas fixas; API com dados em pasta temporária (nunca o data\ real).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('../src/reminders');

const series = (start, repeat, until = null) => ({ start, repeat, until });
const nexts = (s, from, n) => { const out = []; let d = from; for (let i = 0; i < n; i++) { const x = R.nextOnOrAfter(s, d); if (!x) break; out.push(x); d = R.addDays(x, 1); } return out; };
const mk = (o) => ({ id: 'r1', title: 'T', description: '', projectId: null, date: '2026-10-15', time: '14:00', priority: 'normal', repeat: null, until: null, current: '2026-10-15', snoozeUntil: null, doneAt: null, completions: [], notified: null, ...o });

test('recorrência: a cada X dias, a cada X semanas, dias da semana, todo mês, dias do mês e data final', () => {
  assert.deepEqual(nexts(series('2026-10-01', { unit: 'day', every: 5 }), '2026-10-03', 3), ['2026-10-06', '2026-10-11', '2026-10-16']);
  assert.deepEqual(nexts(series('2026-10-01', { unit: 'week', every: 2 }), '2026-10-01', 3), ['2026-10-01', '2026-10-15', '2026-10-29']);
  // 2026-10-05 é segunda: segunda, quarta e sexta
  assert.equal(R.isoDow('2026-10-05'), 1);
  assert.deepEqual(nexts(series('2026-10-05', { unit: 'week', every: 1, weekdays: [1, 3, 5] }), '2026-10-05', 5), ['2026-10-05', '2026-10-07', '2026-10-09', '2026-10-12', '2026-10-14']);
  assert.deepEqual(nexts(series('2026-10-05', { unit: 'week', every: 2, weekdays: [1, 5] }), '2026-10-05', 4), ['2026-10-05', '2026-10-09', '2026-10-19', '2026-10-23'], 'a cada 2 semanas');
  assert.deepEqual(nexts(series('2026-01-31', { unit: 'month', every: 1 }), '2026-01-31', 3), ['2026-01-31', '2026-02-28', '2026-03-31'], 'dia 31 em fevereiro = último dia');
  assert.deepEqual(nexts(series('2026-10-01', { unit: 'month', every: 1, monthDays: [5, 10, 20] }), '2026-10-08', 4), ['2026-10-10', '2026-10-20', '2026-11-05', '2026-11-10']);
  assert.deepEqual(nexts(series('2026-10-01', { unit: 'day', every: 1 }, '2026-10-03'), '2026-10-01', 9), ['2026-10-01', '2026-10-02', '2026-10-03'], 'até a data final');
  assert.equal(R.repeatText({ unit: 'week', every: 1, weekdays: [1, 3, 5] }, '2026-12-31'), 'Toda semana (seg, qua, sex) · até 31/12/2026');
  assert.throws(() => R.cleanRepeat({ unit: 'ano', every: 1 }), /Recorrência inválida/);
  assert.throws(() => R.cleanRepeat({ unit: 'day', every: 0 }), /A cada/);
});

test('lembrete único: concluir encerra; recorrente: concluir só esta ocorrência e a próxima continua (sem empilhar as perdidas)', () => {
  const once = mk();
  assert.deepEqual(R.completeReminder(once, '2026-10-15'), { finished: true, next: null });
  assert.ok(once.doneAt);
  assert.throws(() => R.completeReminder(once, '2026-10-15'), /já foi concluído/);
  assert.equal(R.listReminders({ reminders: [once] }, { now: '2026-10-16T10:00' })[0].status, 'done', 'não aparece como pendente');

  const rec = mk({ repeat: { unit: 'day', every: 5 }, date: '2026-10-01', current: '2026-10-06' });
  assert.deepEqual(R.completeReminder(rec, '2026-10-06'), { finished: false, next: '2026-10-11', nextAt: '2026-10-11T14:00' });
  assert.equal(rec.doneAt, null);
  assert.equal(rec.completions.length, 1);
  // ficou vários dias sem abrir: a próxima é a partir de hoje
  const late = mk({ repeat: { unit: 'day', every: 1 }, date: '2026-10-01', current: '2026-10-02' });
  assert.equal(R.completeReminder(late, '2026-10-09').next, '2026-10-09');
  const last = mk({ repeat: { unit: 'day', every: 1 }, date: '2026-10-01', until: '2026-10-02', current: '2026-10-02' });
  assert.deepEqual(R.completeReminder(last, '2026-10-02'), { finished: true, next: null }, 'última ocorrência encerra a série');
});

test('vários horários no mesmo dia: cada horário é uma ocorrência; concluir uma não conclui as outras', () => {
  assert.deepEqual(R.cleanTimes({ times: ['17:30', '09:00', '14:00', '09:00'] }), ['09:00', '14:00', '17:30'], 'sem repetidos, em ordem');
  assert.deepEqual(R.cleanTimes({ time: '08:15' }), ['08:15'], 'um horário só, como antes');
  assert.throws(() => R.cleanTimes({ times: ['25:00'] }), /Hora inválida/);
  // seg a sex (2026-10-12 é segunda) às 09:00, 14:00 e 17:30
  const r = mk({ date: '2026-10-12', times: ['09:00', '14:00', '17:30'], time: '09:00', repeat: { unit: 'week', every: 1, weekdays: [1, 2, 3, 4, 5] } });
  const first = R.firstPending(r, '2026-10-12T08:00');
  assert.deepEqual(first, { date: '2026-10-12', slot: '09:00' });
  Object.assign(r, { current: first.date, slot: first.slot });
  let list = R.listReminders({ reminders: [r] }, { now: '2026-10-12T09:30' });
  assert.equal(list[0].at, '2026-10-12T09:00');
  assert.equal(list[0].status, 'overdue');
  assert.deepEqual(list[0].todaySlots.map((x) => `${x.time}:${x.state}`), ['09:00:pending', '14:00:next', '17:30:next']);
  assert.deepEqual(R.completeReminder(r, '2026-10-12T09:30'), { finished: false, next: '2026-10-12', nextAt: '2026-10-12T14:00' }, 'concluir 09:00 → 14:00 continua pendente');
  assert.equal(r.doneAt, null, 'o lembrete recorrente nunca é concluído inteiro');
  list = R.listReminders({ reminders: [r] }, { now: '2026-10-12T10:00' });
  assert.deepEqual(list[0].todaySlots.map((x) => `${x.time}:${x.state}`), ['09:00:done', '14:00:pending', '17:30:next']);
  assert.equal(list[0].status, 'today');
  assert.equal(R.dueForNotification(list, '2026-10-12T14:00').length, 1, 'cada horário avisa');
  // perdeu 14:00 (app fechado até 18:00): ao concluir, não acumula — vai para o próximo a partir de agora
  assert.equal(R.completeReminder(r, '2026-10-12T18:00').nextAt, '2026-10-13T09:00');
  // sexta 17:30 → segunda 09:00
  Object.assign(r, { current: '2026-10-16', slot: '17:30' });
  assert.equal(R.completeReminder(r, '2026-10-16T17:31').nextAt, '2026-10-19T09:00');
  // pontual com dois horários no mesmo dia: encerra só depois do último
  const once = mk({ times: ['10:00', '15:00'], time: '10:00', current: '2026-10-15', slot: '10:00' });
  assert.equal(R.completeReminder(once, '2026-10-15T10:05').nextAt, '2026-10-15T15:00');
  assert.equal(R.completeReminder(once, '2026-10-15T15:05').finished, true);
  // criar às 15:00 um diário 09:00/14:00/17:30: primeira ocorrência = hoje 17:30
  assert.deepEqual(R.firstPending({ date: '2026-10-12', times: ['09:00', '14:00', '17:30'], repeat: { unit: 'day', every: 1 } }, '2026-10-12T15:00'), { date: '2026-10-12', slot: '17:30' });
});

test('aviso: cada horário/dia que chega avisa mesmo sem concluir o anterior; reiniciar o app não repete o que já foi avisado', () => {
  // diário 09:00/11:00/15:00/17:00, pendente 09:00 de 2026-10-14 sem concluir
  const r = mk({ date: '2026-10-09', times: ['09:00', '11:00', '15:00', '17:00'], time: '09:00', repeat: { unit: 'day', every: 1 }, current: '2026-10-14', slot: '09:00' });
  const at = (now) => R.listReminders({ reminders: [r] }, { now })[0];
  const due = (now) => R.dueForNotification(R.listReminders({ reminders: [r] }, { now }), now);
  assert.equal(at('2026-10-14T08:59').notifyAt, '2026-10-14T09:00');
  assert.equal(due('2026-10-14T08:59').length, 0, 'antes do horário');
  assert.equal(due('2026-10-14T09:00')[0].notifyAt, '2026-10-14T09:00');
  r.notified = '2026-10-14T09:00';
  assert.equal(due('2026-10-14T10:59').length, 0, 'já avisado: reiniciar o app não repete');
  assert.equal(due('2026-10-14T11:00')[0].notifyAt, '2026-10-14T11:00', '11:00 avisa sem concluir a das 09:00');
  assert.equal(at('2026-10-14T11:00').at, '2026-10-14T09:00', 'a pendente continua a das 09:00 (concluir não muda)');
  assert.equal(at('2026-10-14T11:00').reachedAt, '2026-10-14T11:00');
  // app fechado das 11:00 às 18:00: avisa só a mais recente (17:00), sem acumular as perdidas
  assert.deepEqual(due('2026-10-14T18:00').map((x) => x.notifyAt), ['2026-10-14T17:00']);
  // dia seguinte, ainda sem concluir: 09:00 do outro dia avisa
  r.notified = '2026-10-14T17:00';
  assert.equal(due('2026-10-15T08:00').length, 0);
  assert.equal(due('2026-10-15T09:00')[0].notifyAt, '2026-10-15T09:00');
  // virada do dia (23:59 → 00:00) e pontual com vários horários
  const late = mk({ date: '2026-10-14', times: ['23:59'], time: '23:59', repeat: { unit: 'day', every: 1 }, current: '2026-10-14', slot: '23:59' });
  assert.equal(R.latestReached(late, '2026-10-14T23:59', '2026-10-15T23:59'), '2026-10-15T23:59');
  const once = mk({ times: ['10:00', '15:00'], time: '10:00', current: '2026-10-15', slot: '10:00', notified: '2026-10-15T10:00' });
  assert.equal(R.dueForNotification(R.listReminders({ reminders: [once] }, { now: '2026-10-15T15:00' }), '2026-10-15T15:00')[0].notifyAt, '2026-10-15T15:00');
  assert.equal(R.dueForNotification(R.listReminders({ reminders: [once] }, { now: '2026-10-16T09:00' }), '2026-10-16T09:00').length, 1, 'pontual não passa do último horário');
  // adiado: segura os horários até o fim do adiamento; depois dele, um horário novo avisa de novo
  const s = mk({ date: '2026-10-14', times: ['09:00', '11:00', '15:00', '17:00'], time: '09:00', repeat: { unit: 'day', every: 1 }, current: '2026-10-14', slot: '09:00', notified: '2026-10-14T09:00', snoozeUntil: '2026-10-14T16:00' });
  const sd = (now) => R.dueForNotification(R.listReminders({ reminders: [s] }, { now }), now);
  assert.equal(sd('2026-10-14T15:00').length, 0, '15:00 durante o adiamento não avisa');
  assert.equal(sd('2026-10-14T16:00')[0].notifyAt, '2026-10-14T16:00');
  s.notified = '2026-10-14T16:00';
  assert.equal(sd('2026-10-14T16:30').length, 0);
  assert.equal(sd('2026-10-14T17:00')[0].notifyAt, '2026-10-14T17:00');
  // adiar um lembrete futuro para antes do horário continua avisando no fim do adiamento
  const fut = mk({ date: '2026-10-20', current: '2026-10-20', time: '15:00', snoozeUntil: '2026-10-14T10:00' });
  assert.equal(R.listReminders({ reminders: [fut] }, { now: '2026-10-14T10:00' })[0].notifyAt, '2026-10-14T10:00');
});

test('ação do lembrete: projeto, link, Controle de Horas e comunicação (validação simples)', () => {
  const templates = [{ id: 'g1', scope: 'global', active: true }, { id: 'p1', scope: 'project', projectId: 'A', active: true }, { id: 'off', scope: 'global', active: false }];
  assert.equal(R.cleanAction(null, {}), null);
  assert.equal(R.cleanAction({ kind: 'none' }, {}), null);
  assert.deepEqual(R.cleanAction({ kind: 'project' }, { projectId: 'A' }), { kind: 'project' });
  assert.throws(() => R.cleanAction({ kind: 'project' }, {}), /precisa de um projeto/);
  assert.deepEqual(R.cleanAction({ kind: 'link', url: 'https://psa.exemplo.test/x' }, {}), { kind: 'link', url: 'https://psa.exemplo.test/x', label: '' });
  assert.throws(() => R.cleanAction({ kind: 'link', url: 'javascript:alert(1)' }, {}), /http/);
  assert.deepEqual(R.cleanAction({ kind: 'hours', templateId: 'g1' }, { templates }), { kind: 'hours', templateId: 'g1' });
  assert.deepEqual(R.cleanAction({ kind: 'hours' }, { templates }), { kind: 'hours', templateId: null }, 'modelo opcional');
  assert.throws(() => R.cleanAction({ kind: 'hours', templateId: 'p1' }, { templates }), /modelo global/);
  assert.throws(() => R.cleanAction({ kind: 'hours', templateId: 'off' }, { templates }), /ativo/);
  assert.deepEqual(R.cleanAction({ kind: 'email', templateId: 'p1' }, { projectId: 'A', templates }), { kind: 'email', templateId: 'p1' });
  assert.throws(() => R.cleanAction({ kind: 'email', templateId: 'p1' }, { projectId: 'B', templates }), /outro projeto/);
  assert.throws(() => R.cleanAction({ kind: 'executar', cmd: 'x' }, {}), /inválida/);
});

test('estado e ordem dos cards: atrasados → hoje → próximos → demais; adiado; avisa uma vez por ocorrência', () => {
  const state = { projects: [], reminders: [
    mk({ id: 'a', title: 'futuro', current: '2026-11-30', time: '09:00' }),
    mk({ id: 'b', title: 'atrasado', current: '2026-10-08', time: '09:00' }),
    mk({ id: 'c', title: 'hoje', current: '2026-10-09', time: '18:00' }),
    mk({ id: 'd', title: 'próximo', current: '2026-10-11', time: '09:00' }),
    mk({ id: 'e', title: 'adiado', current: '2026-10-08', time: '09:00', snoozeUntil: '2026-10-09T15:00' }),
  ] };
  const list = R.listReminders(state, { now: '2026-10-09T10:00', warnDays: 7 });
  assert.deepEqual(list.map((x) => `${x.title}:${x.status}`), ['atrasado:overdue', 'hoje:today', 'próximo:soon', 'adiado:snoozed', 'futuro:later']);
  const due = R.dueForNotification(list, '2026-10-09T10:00');
  assert.deepEqual(due.map((x) => x.title), ['atrasado'], 'só o que chegou no horário (o adiado só depois das 15:00)');
  state.reminders[1].notified = due[0].notifyAt;
  assert.equal(R.dueForNotification(R.listReminders(state, { now: '2026-10-09T10:01' }), '2026-10-09T10:01').length, 0, 'não repete');
  const after = R.listReminders(state, { now: '2026-10-09T15:00' });
  assert.equal(after.find((x) => x.title === 'adiado').status, 'overdue', 'depois do adiamento volta a valer (e avisa de novo)');
  assert.deepEqual(R.dueForNotification(after, '2026-10-09T15:00').map((x) => x.title), ['adiado']);
});

test('lembrete do cronograma: data e antecedência vêm do prazo (não é cópia)', () => {
  const state = { reminders: [], projects: [{ id: 'p1', name: 'Migração Empresa X', milestones: [
    { id: 'm1', title: 'Entrega da carga', dueDate: '2026-10-20', alertDays: 2, done: false, note: '', reminder: { time: '09:00' } },
    { id: 'm2', title: 'Sem lembrete', dueDate: '2026-10-21', alertDays: null, done: false, note: '' },
  ] }] };
  let [x] = R.listReminders(state, { now: '2026-10-17T10:00' });
  assert.equal(R.listReminders(state, { now: '2026-10-17T10:00' }).length, 1);
  assert.equal(x.key, 'm:p1:m1');
  assert.equal(x.notifyAt, '2026-10-18T09:00', 'avisar 2 dias antes às 09:00');
  assert.equal(x.status, 'later');
  assert.equal(R.dueForNotification([x], '2026-10-18T08:59').length, 0);
  assert.equal(R.dueForNotification([x], '2026-10-18T09:00').length, 1);
  state.projects[0].milestones[0].dueDate = '2026-10-25'; // a data do cronograma mudou: o lembrete acompanha
  [x] = R.listReminders(state, { now: '2026-10-17T10:00' });
  assert.equal(x.notifyAt, '2026-10-23T09:00');
  state.projects[0].milestones[0].alertDays = 0;
  assert.equal(R.listReminders(state, { now: '2026-10-17T10:00' })[0].notifyAt, '2026-10-25T09:00', 'no mesmo dia');
  assert.equal(R.listReminders(state, { now: '2026-10-26T08:00' })[0].status, 'overdue', 'prazo passou: atrasado');
  state.projects[0].milestones[0].reminder.dismissedFor = '2026-10-25';
  assert.equal(R.listReminders(state, { now: '2026-10-26T08:00' })[0].done, true, 'aviso concluído');
  state.projects[0].milestones[0].dueDate = '2026-10-30';
  assert.equal(R.listReminders(state, { now: '2026-10-26T08:00' })[0].done, false, 'data nova: volta a avisar');
});

// ---------- API ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-rem-'));
const PORT = 4459;
process.env.PORT = String(PORT);
process.env.GP_DATA_DIR = path.join(tmp, 'data');
process.env.GP_BACKUP_DIR = path.join(tmp, 'backups');
const { app } = require('../server');
const base = `http://localhost:${PORT}`;
const api = async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Origin: base }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const ok = (r) => { assert.ok(r.status < 300, JSON.stringify(r.json)); return r.json; };
let server;
test.before(() => { server = app.listen(PORT, '127.0.0.1'); });
test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
const pad = (n) => String(n).padStart(2, '0');
const day = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const list = async (filter = 'all') => ok(await api('GET', `/api/reminders?filter=${filter}`));
const item = async (key, filter = 'all') => (await list(filter)).items.find((x) => x.key === key);

test('API: avulsos (único e recorrente), concluir, adiar, avisar uma vez; prazo do cronograma com lembrete; backup e restauração', async () => {
  const p = ok(await api('POST', '/api/projects', { name: 'Migração Empresa X' }));
  // pontual atrasado e recorrente semanal
  ok(await api('POST', '/api/reminders', { title: 'Enviar documentação', projectId: p.id, date: day(-1), time: '14:00', priority: 'important' }));
  ok(await api('POST', '/api/reminders', { title: 'Reunião de status', date: day(0), time: '23:59', repeat: { unit: 'week', every: 1, weekdays: [1, 2, 3, 4, 5, 6, 7] } }));
  assert.equal((await api('POST', '/api/reminders', { title: '', date: day(0) })).status, 400);
  assert.equal((await api('POST', '/api/reminders', { title: 'x', date: '2026-02-30' })).status, 400);
  assert.equal((await api('POST', '/api/reminders', { title: 'x', date: day(0), projectId: 'nao-existe' })).status, 400);

  let d = await list();
  assert.equal(d.items[0].title, 'Enviar documentação');
  assert.equal(d.items[0].status, 'overdue', 'atrasado continua visível');
  assert.equal(d.items[0].projectName, 'Migração Empresa X');
  assert.equal(d.counts.overdue, 1);
  assert.deepEqual(d.due.map((x) => x.title), ['Enviar documentação']);
  ok(await api('POST', '/api/reminders/notified', { items: d.due }));
  assert.equal((await list()).due.length, 0, 'aviso não se repete');

  // adiar 1 dia → sai dos atrasados; concluir pontual → vai para Concluídos
  const kDoc = d.items[0].key;
  assert.equal((await api('POST', `/api/reminders/${encodeURIComponent(kDoc)}/snooze`, { until: `${day(-1)}T10:00` })).status, 400, 'adiar para o passado');
  ok(await api('POST', `/api/reminders/${encodeURIComponent(kDoc)}/snooze`, { until: `${day(1)}T09:00` }));
  assert.equal((await item(kDoc)).status, 'snoozed');
  assert.equal((await list('overdue')).items.length, 0);
  const done = ok(await api('POST', `/api/reminders/${encodeURIComponent(kDoc)}/complete`, {}));
  assert.equal(done.finished, true);
  assert.equal(await item(kDoc), undefined, 'concluído sai dos pendentes');
  assert.equal((await item(kDoc, 'done')).done, true);

  // recorrente: concluir só esta ocorrência
  const kRec = (await list()).items.find((x) => x.title === 'Reunião de status').key;
  const r2 = ok(await api('POST', `/api/reminders/${encodeURIComponent(kRec)}/complete`, {}));
  assert.equal(r2.finished, false);
  assert.equal(r2.next, day(1));
  assert.equal((await item(kRec)).at.slice(0, 10), day(1), 'a próxima continua pendente');

  // editar: data/hora/recorrência recalculam a ocorrência pendente
  const id = kRec.slice(2);
  ok(await api('PUT', `/api/reminders/${id}`, { title: 'Reunião quinzenal', date: day(3), time: '10:00', repeat: { unit: 'week', every: 2 }, until: day(40) }));
  const ed = await item(kRec);
  assert.equal(ed.title, 'Reunião quinzenal');
  assert.equal(ed.at, `${day(3)}T10:00`);
  assert.match(ed.repeatText, /A cada 2 semanas · até/);

  // cronograma: prazo com lembrete (antecedência 2 dias às 08:00)
  let proj = ok(await api('POST', `/api/projects/${p.id}/milestones`, { title: 'Entrega da carga', dueDate: day(10), alertDays: 2, reminder: { on: true, time: '08:00' } }));
  const mid = proj.milestones[0].id;
  const kMs = `m:${p.id}:${mid}`;
  let ms = await item(kMs);
  assert.equal(ms.kind, 'milestone');
  assert.equal(ms.notifyAt, `${day(8)}T08:00`);
  // marcar o prazo pelo checkbox (corpo com o marco inteiro) não perde o lembrete; corpo sem "reminder" também mantém
  proj = ok(await api('PUT', `/api/projects/${p.id}/milestones/${mid}`, { ...proj.milestones[0], dueDate: day(12) }));
  assert.equal(proj.milestones[0].reminder.time, '08:00');
  ms = await item(kMs);
  assert.equal(ms.notifyAt, `${day(10)}T08:00`, 'a data do cronograma mudou e o lembrete acompanhou');
  proj = ok(await api('PUT', `/api/projects/${p.id}/milestones/${mid}`, { title: 'Entrega da carga', dueDate: day(12), alertDays: 2 }));
  assert.ok(proj.milestones[0].reminder, 'sem o campo: mantém');
  // concluir o lembrete do prazo dispensa o aviso, mas o prazo continua pendente no cronograma
  ok(await api('POST', `/api/reminders/${encodeURIComponent(kMs)}/complete`, {}));
  assert.equal((await item(kMs, 'done')).doneAt, 'aviso dispensado');
  assert.equal((await api('GET', '/api/state')).json.projects[0].milestones[0].done, false);
  ok(await api('PUT', `/api/projects/${p.id}/milestones/${mid}`, { title: 'Entrega da carga', dueDate: day(15), alertDays: 2 }));
  assert.equal((await item(kMs)).done, false, 'data nova: volta a avisar');

  // backup com lembretes e vínculo ao prazo → apaga → restaura
  const out = path.join(tmp, 'saida');
  fs.mkdirSync(out);
  const bk = ok(await api('POST', '/api/backup/export', { path: path.join(out, 'b.gpbackup') }));
  assert.equal(bk.sections.reminders, 2);
  assert.equal(bk.sections.milestoneReminders, 1);
  ok(await api('DELETE', `/api/reminders/${encodeURIComponent(kRec)}`));
  ok(await api('DELETE', `/api/reminders/${encodeURIComponent(kMs)}`));
  assert.equal((await api('GET', '/api/state')).json.projects[0].milestones.length, 1, 'excluir o lembrete do prazo mantém o prazo');
  assert.equal(await item(kMs), undefined);
  const ins = ok(await api('POST', '/api/backup/inspect', { path: path.join(out, 'b.gpbackup') }));
  ok(await api('POST', '/api/backup/import', { token: ins.token }));
  const back = await list('all');
  assert.ok(back.items.some((x) => x.key === kRec), 'lembrete avulso restaurado');
  const msBack = back.items.find((x) => x.key === kMs);
  assert.ok(msBack, 'lembrete do prazo restaurado com o mesmo vínculo (projeto + prazo)');
  assert.equal(msBack.notifyAt, `${day(13)}T08:00`);

  // remover o prazo: o lembrete some junto (nada fica órfão)
  ok(await api('DELETE', `/api/projects/${p.id}/milestones/${mid}`));
  assert.equal(await item(kMs), undefined);
  assert.equal((await api('POST', `/api/reminders/${encodeURIComponent(kMs)}/complete`, {})).status, 404);
});
