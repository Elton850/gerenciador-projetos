// Cronogramas: regra única de status/itens (src/schedule.js) e Central de Cronogramas (src/schedule-api.js).
// Dados antigos (prazos sem `startDate`, projetos sem `scheduleColor`) carregados de uma pasta temporária — nunca o data\ real.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const S = require('../src/schedule');

const T = '2026-10-15'; // quinta-feira
const ms = (dueDate, extra = {}) => ({ id: `m${dueDate}`, title: 'Item', dueDate, alertDays: null, done: false, note: '', ...extra });

test('status: atrasado, hoje, próximo, em andamento, normal e concluído (regra única)', () => {
  assert.equal(S.itemStatus(ms('2026-10-14'), T).status, 'overdue');
  assert.equal(S.itemStatus(ms('2026-10-15'), T).status, 'today');
  assert.equal(S.itemStatus(ms('2026-10-20'), T).status, 'soon'); // dentro do aviso padrão (7)
  assert.equal(S.itemStatus(ms('2026-10-30'), T).status, 'ok');
  assert.equal(S.itemStatus(ms('2026-10-30', { alertDays: 20 }), T).status, 'soon', 'antecedência do próprio prazo');
  assert.equal(S.itemStatus(ms('2026-10-30', { startDate: '2026-10-01' }), T).status, 'running', 'período já começou');
  assert.equal(S.itemStatus(ms('2026-10-30', { startDate: '2026-10-20' }), T).status, 'ok', 'período ainda não começou');
  assert.equal(S.itemStatus(ms('2026-10-01', { done: true }), T).status, 'done', 'concluído nunca é atrasado');
  assert.equal(S.itemStatus(ms('2026-10-01', { done: true }), T).days, null);
  // mesma semântica do estado antigo (milestoneState): atrasado/próximo coincidem
  for (const d of ['2026-10-01', '2026-10-15', '2026-10-22', '2026-10-23', '2026-12-01']) {
    const old = S.milestoneState(ms(d), T).state; const now = S.itemStatus(ms(d), T).status;
    assert.equal(old === 'soon' ? ['soon', 'today'].includes(now) : now === old, true, `${d}: ${old} × ${now}`);
  }
});

test('itens: prazo antigo (sem início) vira marco; com início vira período; dados inválidos não quebram', () => {
  const p = { id: 'p1', name: 'Projeto Alfa', milestones: [
    { id: 'a', title: 'Go-live', dueDate: '2026-10-21', alertDays: null, done: false, note: 'n', reminder: null }, // legado: sem startDate
    { id: 'b', title: 'Migração', startDate: '2026-10-01', dueDate: '2026-10-15', alertDays: 2, done: false, note: '' },
    { id: 'c', title: 'Início depois do fim', startDate: '2026-10-30', dueDate: '2026-10-20' },
    { id: 'd', title: 'Data quebrada', dueDate: '2026-02-30' },
  ] };
  const it = S.scheduleItems(p, T);
  assert.equal(it.length, 3, 'data inválida é ignorada (não derruba a tela)');
  const [a, b, c] = it;
  assert.deepEqual([a.kind, a.start, a.end], ['deadline', '2026-10-21', '2026-10-21']);
  assert.deepEqual([b.kind, b.start, b.end, b.status], ['period', '2026-10-01', '2026-10-15', 'today']);
  assert.equal(c.kind, 'deadline', 'início depois do prazo → tratado como marco');
  assert.equal(a.projectName, 'Projeto Alfa');
  assert.equal(a.initials, 'PA');
  assert.ok(S.SCHEDULE_COLORS.includes(a.color));
  assert.deepEqual(S.scheduleItems({ id: 'x', name: 'Sem' }, T), [], 'projeto sem cronograma = lista vazia, sem erro');
});

test('lembrete do prazo aparece no item (data do aviso = prazo − antecedência)', () => {
  const [x] = S.scheduleItems({ id: 'p', name: 'P', milestones: [ms('2026-10-20', { alertDays: 2, reminder: { time: '08:30' } })] }, T);
  assert.deepEqual(x.reminder, { time: '08:30', lead: 2, notifyDate: '2026-10-18', dismissed: false, snoozeUntil: null });
  const [y] = S.scheduleItems({ id: 'p', name: 'P', milestones: [ms('2026-10-20', { reminder: { time: '09:00', dismissedFor: '2026-10-20' } })] }, T);
  assert.equal(y.reminder.lead, 7, 'sem antecedência no prazo → padrão');
  assert.equal(y.reminder.dismissed, true);
});

test('datas cruzando meses e anos, semanas e fuso (só datas locais AAAA-MM-DD)', () => {
  const [x] = S.scheduleItems({ id: 'p', name: 'P', milestones: [ms('2027-01-10', { startDate: '2026-12-20' })] }, '2026-12-01');
  assert.ok(S.overlaps(x, '2026-12-01', '2026-12-31'), 'aparece em dezembro');
  assert.ok(S.overlaps(x, '2027-01-01', '2027-01-31'), 'e em janeiro do ano seguinte');
  assert.ok(!S.overlaps(x, '2027-02-01', '2027-02-28'));
  assert.equal(S.daysBetween('2026-12-31', '2027-01-01'), 1);
  assert.equal(S.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(S.addDays('2028-02-28', 1), '2028-02-29', 'ano bissexto');
  assert.equal(S.weekStart('2026-10-15'), '2026-10-12', 'semana começa na segunda');
  assert.equal(S.weekStart('2026-10-18'), '2026-10-12', 'domingo pertence à semana que começou na segunda');
  assert.equal(S.weekStart('2027-01-01'), '2026-12-28', 'semana atravessando o ano');
  // "hoje" vem do relógio LOCAL (não de UTC): 23h30 continua sendo o mesmo dia
  assert.equal(S.todayStr(new Date(2026, 9, 15, 23, 30)), '2026-10-15');
  assert.equal(S.todayStr(new Date(2026, 9, 16, 0, 5)), '2026-10-16');
  assert.equal(S.validDate('2026-02-29'), false);
});

test('filtros e atalhos (todos, hoje, esta semana, 30 dias, atrasados, tipo, status, ocultar concluídos)', () => {
  const items = S.scheduleItems({ id: 'p', name: 'P', milestones: [
    ms('2026-10-10', { id: 'late' }), ms('2026-10-15', { id: 'today' }), ms('2026-10-18', { id: 'sun' }),
    ms('2026-11-10', { id: 'nov', startDate: '2026-10-20' }), ms('2026-12-20', { id: 'dec' }), ms('2026-10-13', { id: 'done', done: true }),
  ] }, T);
  const ids = (o) => S.filterItems(items, { today: T, ...o }).map((x) => x.milestoneId).sort();
  assert.equal(ids({}).length, 6);
  assert.deepEqual(ids({ quick: 'today' }), ['today']);
  assert.deepEqual(ids({ quick: 'week' }), ['done', 'sun', 'today'], 'segunda 12 a domingo 18');
  assert.deepEqual(ids({ quick: 'next30' }), ['nov', 'sun', 'today'], 'inclui o período que começa dentro dos 30 dias');
  assert.deepEqual(ids({ quick: 'overdue' }), ['late']);
  assert.deepEqual(ids({ kind: 'period' }), ['nov']);
  assert.deepEqual(ids({ status: 'done' }), ['done']);
  assert.deepEqual(ids({ hideDone: true }).includes('done'), false, 'ocultar concluídos');
  assert.deepEqual(ids({ from: '2026-11-01', to: '2026-11-30' }), ['nov'], 'intervalo visível');
  const up = S.upcoming(items, T, 30).map((x) => x.milestoneId);
  assert.deepEqual(up, ['late', 'today', 'sun', 'nov'], 'próximos prazos: atrasados + até 30 dias, por data; concluídos ficam fora');
  assert.deepEqual(S.scheduleSummary(items, T), { overdue: 1, today: 1, week: 2, next30: 3 });
});

test('identidade do projeto: cor automática estável, escolhida respeitada, inválida volta à automática', () => {
  const auto = S.scheduleIdentity({ id: 'abc123', name: 'Migração da Empresa X' });
  assert.equal(auto.auto, true);
  assert.equal(auto.color, S.scheduleIdentity({ id: 'abc123', name: 'Outro nome' }).color, 'mesma cor para o mesmo projeto');
  assert.equal(auto.initials, 'ME', 'ignora "da"');
  assert.deepEqual(S.scheduleIdentity({ id: 'abc123', name: 'X', scheduleColor: 'roxo' }), { color: 'roxo', auto: false, initials: 'X' });
  assert.equal(S.scheduleIdentity({ id: 'abc123', name: 'X', scheduleColor: '#ff0000' }).auto, true);
});

// ---------- API, com dados no formato antigo ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-schedule-'));
const DATA = path.join(tmp, 'data');
const PORT = 4474;
Object.assign(process.env, { PORT: String(PORT), GP_DATA_DIR: DATA, GP_BACKUP_DIR: path.join(tmp, 'backups') });
const today = S.todayStr();
const day = (n) => S.addDays(today, n);
const legacyMilestones = [
  { id: 'ms-old1', title: 'Entrega da homologação', dueDate: day(3), alertDays: null, done: false, note: 'cliente valida', reminder: { time: '09:00' } },
  { id: 'ms-old2', title: 'Entrega antiga', dueDate: day(-40), alertDays: 5, done: true, note: '' },
  { id: 'ms-old3', title: 'Atrasado', dueDate: day(-2), alertDays: null, done: false, note: '' },
];
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(path.join(DATA, 'projects.json'), JSON.stringify({ version: 1, schemaVersion: 1, migrations: [], settings: { warnDays: 7 }, projects: [
  { id: 'p-old', name: 'Projeto Alfa', description: '', rootDir: '', createdAt: '2026-01-01T00:00:00.000Z', bases: [], deparas: [], milestones: legacyMilestones },
  { id: 'p-none', name: 'Projeto Beta', description: '', rootDir: '', createdAt: '2026-01-01T00:00:00.000Z', bases: [], deparas: [], milestones: [] },
  { id: 'p-cancel', name: 'Projeto Gama', description: '', rootDir: '', createdAt: '2026-01-01T00:00:00.000Z', bases: [], deparas: [],
    milestones: [{ id: 'ms-c1', title: 'Prazo do cancelado', dueDate: day(1), alertDays: null, done: false, note: '' }], cancelled: { at: '2026-10-01T00:00:00.000Z', by: 'teste', reason: 'teste' } },
] }, null, 2));
const { app } = require('../server');
const base = `http://localhost:${PORT}`;
const api = async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Origin: base }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const ok = (r) => { assert.ok(r.status < 300, JSON.stringify(r.json)); return r.json; };
const file = () => JSON.parse(fs.readFileSync(path.join(DATA, 'projects.json'), 'utf8'));
const hash = () => crypto.createHash('sha256').update(fs.readFileSync(path.join(DATA, 'projects.json'))).digest('hex');
let server;
test.before(() => { server = app.listen(PORT, '127.0.0.1'); });
test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('API: cronogramas antigos aparecem na hora, sem conversão e sem perder nada; projeto sem cronograma é normal', async () => {
  const st = ok(await api('GET', '/api/state'));
  const alfa = st.projects.find((p) => p.id === 'p-old');
  for (const m of legacyMilestones) {
    const saved = alfa.milestones.find((x) => x.id === m.id);
    for (const k of Object.keys(m)) assert.deepEqual(saved[k], m[k], `${m.id}.${k} preservado`);
    const it = alfa.scheduleItems.find((x) => x.milestoneId === m.id);
    assert.equal(it.kind, 'deadline', 'prazo antigo = marco');
    assert.equal(it.end, m.dueDate);
  }
  assert.equal(alfa.scheduleItems.find((x) => x.milestoneId === 'ms-old3').status, 'overdue');
  assert.equal(alfa.scheduleItems.find((x) => x.milestoneId === 'ms-old2').status, 'done', 'concluído continua visível');
  assert.equal(alfa.scheduleIdentity.auto, true, 'sem cor gravada = automática');
  const beta = st.projects.find((p) => p.id === 'p-none');
  assert.equal(beta.schedule.state, 'none');
  assert.deepEqual(beta.scheduleItems, []);
  assert.deepEqual(st.scheduleSummary, { overdue: 1, today: 0, week: st.scheduleSummary.week, next30: 1 }, 'resumo sem o projeto cancelado');
  // o que está no disco continua com todos os campos antigos
  const disk = file().projects.find((p) => p.id === 'p-old');
  for (const m of legacyMilestones) for (const k of Object.keys(m)) assert.deepEqual(disk.milestones.find((x) => x.id === m.id)[k], m[k]);
});

test('API: Central consolidada — intervalo, projeto cancelado fora, vários projetos no mesmo período, validação', async () => {
  const pg = ok(await api('POST', '/api/projects', { name: 'Projeto Delta' }));
  ok(await api('POST', `/api/projects/${pg.id}/milestones`, { title: 'Carga', startDate: day(-1), dueDate: day(10) }));
  ok(await api('POST', '/api/projects/p-old/milestones', { title: 'Validação', startDate: day(0), dueDate: day(8) }));
  const d = ok(await api('GET', `/api/schedule?from=${day(-5)}&to=${day(12)}`));
  assert.ok(d.items.some((x) => x.projectId === pg.id && x.kind === 'period'));
  assert.ok(d.items.some((x) => x.projectId === 'p-old' && x.title === 'Validação'));
  const overlapToday = d.items.filter((x) => x.start <= today && x.end >= today && x.kind === 'period');
  assert.equal(overlapToday.length, 2, 'dois projetos no mesmo período');
  assert.ok(!d.items.some((x) => x.projectId === 'p-cancel'), 'projeto cancelado não aparece na visão consolidada');
  assert.ok(!d.projects.some((p) => p.id === 'p-cancel'));
  assert.equal(d.projects.find((p) => p.id === 'p-none').hasSchedule, false, 'projeto sem cronograma listado sem erro');
  assert.ok(!d.items.some((x) => x.milestoneId === 'ms-old2'), 'fora do intervalo (40 dias atrás) não vem');
  const only = ok(await api('GET', `/api/schedule?from=${day(-5)}&to=${day(12)}&project=${pg.id}`));
  assert.ok(only.items.every((x) => x.projectId === pg.id));
  const per = ok(await api('GET', `/api/schedule?from=${day(-5)}&to=${day(12)}&kind=deadline&hideDone=1`));
  assert.ok(per.items.every((x) => x.kind === 'deadline' && !x.done));
  const def = ok(await api('GET', '/api/schedule'));
  assert.equal(def.from, `${today.slice(0, 8)}01`, 'sem intervalo = mês atual');
  assert.equal((await api('GET', `/api/schedule?from=${day(5)}&to=${day(1)}`)).status, 400);
  assert.equal((await api('GET', `/api/schedule?from=${day(0)}&to=${day(500)}`)).status, 400, 'nunca o histórico inteiro');
  assert.equal((await api('GET', '/api/schedule?from=2026-13-01&to=2026-12-01')).status, 400);
  const up = ok(await api('GET', '/api/schedule/upcoming'));
  assert.ok(up.items.every((x) => !x.done && x.projectId !== 'p-cancel'));
  assert.equal(up.items[0].milestoneId, 'ms-old3', 'atrasado primeiro');
});

test('API: período — criar, editar sem o campo mantém, validação, início = prazo vira marco', async () => {
  const p = ok(await api('POST', '/api/projects', { name: 'Projeto Épsilon' }));
  const created = ok(await api('POST', `/api/projects/${p.id}/milestones`, { title: 'Migração', startDate: '2026-12-20', dueDate: '2027-01-10' }));
  const m = created.milestones[0];
  assert.equal(m.startDate, '2026-12-20');
  // tela/versão antiga manda o corpo sem startDate → mantém
  const kept = ok(await api('PUT', `/api/projects/${p.id}/milestones/${m.id}`, { title: 'Migração', dueDate: '2027-01-12', alertDays: '', note: '', done: false }));
  assert.equal(kept.milestones[0].startDate, '2026-12-20');
  assert.equal(kept.scheduleItems[0].end, '2027-01-12');
  assert.equal((await api('PUT', `/api/projects/${p.id}/milestones/${m.id}`, { title: 'X', startDate: '2027-02-01', dueDate: '2027-01-12' })).status, 400);
  assert.equal((await api('POST', `/api/projects/${p.id}/milestones`, { title: 'X', startDate: 'ontem', dueDate: '2027-01-12' })).status, 400);
  const same = ok(await api('PUT', `/api/projects/${p.id}/milestones/${m.id}`, { title: 'Go-live', startDate: '2027-01-12', dueDate: '2027-01-12' }));
  assert.equal(same.milestones[0].startDate, null);
  assert.equal(same.scheduleItems[0].kind, 'deadline');
  const cleared = ok(await api('PUT', `/api/projects/${p.id}/milestones/${m.id}`, { title: 'Go-live', startDate: null, dueDate: '2027-01-12' }));
  assert.equal(cleared.milestones[0].startDate, null);
  // marcar como concluído pela Central = o mesmo PUT de sempre
  const done = ok(await api('PUT', `/api/projects/${p.id}/milestones/${m.id}`, { ...cleared.milestones[0], done: true }));
  assert.equal(done.scheduleItems[0].status, 'done');
});

test('API: somente leitura (projeto cancelado) não edita cronograma; cor é só aparência', async () => {
  for (const [method, url, body] of [
    ['POST', '/api/projects/p-cancel/milestones', { title: 'Novo', dueDate: day(3) }],
    ['PUT', '/api/projects/p-cancel/milestones/ms-c1', { title: 'Mudado', dueDate: day(3), startDate: day(1) }],
    ['DELETE', '/api/projects/p-cancel/milestones/ms-c1'],
  ]) {
    const r = await api(method, url, body);
    assert.equal(r.status, 409, `${method} ${url}`);
    assert.equal(r.json.code, 'PROJECT_CANCELLED');
  }
  assert.equal(file().projects.find((p) => p.id === 'p-cancel').milestones[0].title, 'Prazo do cancelado', 'nada mudou no disco');
  const c = ok(await api('PUT', '/api/projects/p-cancel/schedule-color', { color: 'azul' }));
  assert.deepEqual(c.scheduleIdentity, { color: 'azul', auto: false, initials: 'PG' });
  assert.equal((await api('PUT', '/api/projects/p-old/schedule-color', { color: 'vermelho-vivo' })).status, 400);
  assert.equal(ok(await api('PUT', '/api/projects/p-old/schedule-color', { color: 'roxo' })).scheduleIdentity.color, 'roxo');
  assert.equal(ok(await api('PUT', '/api/projects/p-old/schedule-color', { color: null })).scheduleIdentity.auto, true);
  assert.equal((await api('PUT', '/api/projects/nao-existe/schedule-color', { color: 'roxo' })).status, 404);
});

test('API: trocar de visualização (consultas) não altera os dados', async () => {
  const before = hash();
  for (const q of [`from=${day(-30)}&to=${day(30)}`, `from=${day(0)}&to=${day(89)}&quick=next30`, 'quick=overdue', `from=${day(-6)}&to=${day(0)}&status=done`]) ok(await api('GET', `/api/schedule?${q}`));
  ok(await api('GET', '/api/schedule/upcoming?days=90'));
  ok(await api('GET', '/api/state'));
  assert.equal(hash(), before, 'projects.json idêntico');
});

test('API: lembrete associado ao prazo — criar, aparece no item, remover lembrete mantém o prazo, remover prazo remove o lembrete', async () => {
  const p = ok(await api('POST', '/api/projects', { name: 'Projeto Zeta' }));
  const created = ok(await api('POST', `/api/projects/${p.id}/milestones`, { title: 'Go-live', dueDate: day(20) }));
  const m = created.milestones[0];
  assert.equal(created.scheduleItems[0].reminder, null);
  // “Criar lembrete: 2 dias antes” = antecedência 2 + lembrete ligado (o mesmo PUT do formulário)
  const withRem = ok(await api('PUT', `/api/projects/${p.id}/milestones/${m.id}`, { ...m, alertDays: 2, reminder: { on: true, time: '09:00' } }));
  assert.deepEqual(withRem.scheduleItems[0].reminder, { time: '09:00', lead: 2, notifyDate: day(18), dismissed: false, snoozeUntil: null });
  const key = `m:${p.id}:${m.id}`;
  assert.ok(ok(await api('GET', '/api/reminders')).items.some((x) => x.key === key), 'aparece em Lembretes');
  // remover o lembrete não remove o prazo
  assert.equal(ok(await api('DELETE', `/api/reminders/${encodeURIComponent(key)}`)).kept, 'prazo mantido no cronograma');
  const st = ok(await api('GET', '/api/state'));
  const after = st.projects.find((x) => x.id === p.id);
  assert.equal(after.milestones.length, 1);
  assert.equal(after.scheduleItems[0].reminder, null);
  // remover o prazo remove o lembrete dele (faz parte do prazo)
  ok(await api('PUT', `/api/projects/${p.id}/milestones/${m.id}`, { ...after.milestones[0], reminder: { on: true, time: '10:00' } }));
  ok(await api('DELETE', `/api/projects/${p.id}/milestones/${m.id}`));
  assert.ok(!ok(await api('GET', '/api/reminders')).items.some((x) => x.key === key));
  assert.equal((await api('POST', `/api/reminders/${encodeURIComponent(key)}/complete`)).status, 404);
});

test('carga: applyDefaults completa os campos novos sem alterar nada e é idempotente', () => {
  const { applyDefaults } = require('../src/defaults');
  const data = { projects: [{ id: 'a', name: 'A', milestones: [{ id: 'm', title: 'T', dueDate: '2026-10-20', done: false }] }] };
  applyDefaults(data);
  const once = JSON.stringify(data);
  applyDefaults(data);
  assert.equal(JSON.stringify(data), once, 'idempotente');
  assert.equal(data.projects[0].scheduleColor, null);
  assert.equal(data.projects[0].milestones[0].startDate, null);
  assert.equal(data.projects[0].milestones[0].title, 'T');
  const kept = { projects: [{ id: 'b', name: 'B', scheduleColor: 'roxo', milestones: [{ id: 'm', title: 'T', startDate: '2026-10-01', dueDate: '2026-10-20' }] }] };
  applyDefaults(kept);
  assert.equal(kept.projects[0].scheduleColor, 'roxo');
  assert.equal(kept.projects[0].milestones[0].startDate, '2026-10-01');
});
