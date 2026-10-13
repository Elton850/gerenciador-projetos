// Projeto cancelado: marcador (nada é alterado), andamento congelado, sem alertas/lembretes e descancelar = último estado salvo.
// Dados em pasta temporária (nunca o data\ real).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../src/project-cancel');

test('regras puras: congela só o que mexe no andamento e só com o projeto cancelado', () => {
  const p = { cancelled: { at: 'x' } };
  for (const [m, sub] of [['PUT', '/step'], ['POST', '/checklists/s1/open'], ['PUT', '/checklists/s1/items/i1'], ['POST', '/cycle/apply'], ['POST', '/milestones'], ['DELETE', '/milestones/m1'], ['DELETE', '/evidences/e1']]) {
    assert.equal(C.frozen(p, m, sub), true, `${m} ${sub}`);
  }
  for (const [m, sub] of [['GET', '/step'], ['GET', '/checklists/s1'], ['PUT', '/'], ['POST', '/notes'], ['POST', '/contacts'], ['PUT', '/environments'], ['POST', '/uncancel']]) {
    assert.equal(C.frozen(p, m, sub), false, `${m} ${sub}`);
  }
  assert.equal(C.frozen({ cancelled: null }, 'PUT', '/step'), false, 'ativo: nada congelado');
  assert.equal(C.frozen(undefined, 'PUT', '/step'), false, 'projeto inexistente: segue para o 404 normal');
  const q = {};
  const c = C.cancelProject(q, { reason: '  Cliente desistiu  ', by: 'ana', stageName: 'Carga', percent: 40, now: '2026-10-13T10:00:00.000Z' });
  assert.deepEqual(c, { at: '2026-10-13T10:00:00.000Z', by: 'ana', reason: 'Cliente desistiu', stageName: 'Carga', percent: 40 });
  assert.throws(() => C.cancelProject(q, {}), (e) => e.code === 'PROJECT_CANCELLED');
  assert.equal(C.uncancelProject(q).stageName, 'Carga');
  assert.equal(q.cancelled, null);
  assert.throws(() => C.uncancelProject(q), /não está cancelado/);
});

// ---------- API ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-cancel-'));
const PORT = 4472;
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
const day = (o) => { const d = new Date(); d.setDate(d.getDate() + o); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const getProj = async (id) => (await api('GET', '/api/state')).json.projects.find((p) => p.id === id);
const core = (p) => { const { cancelled, schedule, ...rest } = p; return JSON.stringify(rest); }; // tudo, menos o marcador e o derivado do cronograma
const remItems = async () => (await api('GET', '/api/reminders?filter=all')).json.items;

test('API: cancelar não altera nada, congela o andamento, tira alertas/lembretes e descancelar volta ao último estado salvo', async () => {
  let p = ok(await api('POST', '/api/projects', { name: 'Migração Empresa X' }));
  const [s1, s2] = p.steps;
  ok(await api('PUT', `/api/projects/${p.id}/step`, { stepId: s1.id }));
  ok(await api('POST', `/api/projects/${p.id}/checklists/${s1.id}/open`));
  ok(await api('POST', `/api/projects/${p.id}/milestones`, { title: 'Entrega atrasada', dueDate: day(-3), reminder: { on: true, time: '09:00' } }));
  ok(await api('POST', '/api/reminders', { title: 'Enviar documentação', projectId: p.id, date: day(-1), time: '10:00' }));
  ok(await api('POST', '/api/reminders', { title: 'Lembrete sem projeto', date: day(-1), time: '10:00' }));
  const before = await getProj(p.id);
  assert.equal(before.schedule.state, 'overdue');
  assert.equal((await remItems()).length, 3);

  // cancelar: marcador com motivo, quem, etapa e %
  assert.equal((await api('POST', '/api/projects/nao-existe/cancel', {})).status, 404);
  const c = ok(await api('POST', `/api/projects/${p.id}/cancel`, { reason: 'Cliente desistiu da migração' }));
  assert.equal(c.cancelled.reason, 'Cliente desistiu da migração');
  assert.ok(c.cancelled.at && c.cancelled.by !== undefined);
  const stages = (await api('GET', '/api/state')).json.stages;
  assert.equal(c.cancelled.stageName, stages.find((x) => x.id === s1.stageId).name, 'guarda a etapa em que estava');
  assert.equal(typeof c.cancelled.percent, 'number');
  assert.equal((await api('POST', `/api/projects/${p.id}/cancel`, {})).json.code, 'PROJECT_CANCELLED', 'não cancela duas vezes');
  const during = await getProj(p.id);
  assert.equal(during.schedule.state, 'cancelled', 'cancelado não gera alerta de prazo (mesmo com prazo vencido)');
  assert.equal(core(during), core(before), 'cancelar não altera nenhum dado do projeto');
  assert.deepEqual((await remItems()).map((x) => x.title), ['Lembrete sem projeto'], 'lembretes do projeto cancelado ficam de fora (o sem projeto continua)');

  // andamento congelado
  const mid = before.milestones[0].id;
  for (const [method, url, body] of [
    ['PUT', `/api/projects/${p.id}/step`, { stepId: s2.id }],
    ['POST', `/api/projects/${p.id}/checklists/${s2.id}/open`, {}],
    ['POST', `/api/projects/${p.id}/milestones`, { title: 'Novo', dueDate: day(5) }],
    ['PUT', `/api/projects/${p.id}/milestones/${mid}`, { title: 'Entrega atrasada', dueDate: day(9), done: true }],
    ['DELETE', `/api/projects/${p.id}/milestones/${mid}`],
    ['POST', `/api/projects/${p.id}/cycle/apply`, {}],
    ['PUT', `/api/projects/${p.id}`, { name: 'Migração Empresa X', cycleId: 'outro-ciclo' }],
  ]) {
    const r = await api(method, url, body);
    assert.equal(r.status, 409, `${method} ${url} → ${r.status}`);
    assert.equal(r.json.code, 'PROJECT_CANCELLED', `${method} ${url}`);
  }
  assert.equal(core(await getProj(p.id)), core(before), 'nada mudou durante o cancelamento');
  // o que não é andamento continua editável
  ok(await api('PUT', `/api/projects/${p.id}`, { name: 'Migração Empresa X (cancelado)', description: 'novo texto' }));
  ok(await api('POST', `/api/projects/${p.id}/notes`, { title: 'Motivo', text: 'Cliente cancelou.' }));
  assert.equal((await getProj(p.id)).cancelled.reason, 'Cliente desistiu da migração', 'editar o cadastro não descancela');

  // descancelar: volta exatamente ao último estado salvo
  assert.equal((await api('POST', '/api/projects/nao-existe/uncancel')).status, 404);
  const back = ok(await api('POST', `/api/projects/${p.id}/uncancel`));
  assert.equal(back.cancelled, null);
  assert.equal(back.schedule.state, 'overdue', 'alerta de prazo de volta');
  assert.equal(back.stepId, s1.id, 'mesma etapa de antes');
  assert.deepEqual(back.milestones, before.milestones);
  assert.equal(JSON.stringify(back.checklist), JSON.stringify(before.checklist));
  assert.equal((await remItems()).length, 3, 'lembretes de volta (prazo, avulso do projeto e sem projeto)');
  assert.equal((await api('POST', `/api/projects/${p.id}/uncancel`)).status, 400, 'já ativo');
  ok(await api('PUT', `/api/projects/${p.id}/step`, { stepId: s2.id })); // andamento liberado de novo
  ok(await api('PUT', `/api/projects/${p.id}/step`, { stepId: s1.id }));

  // backup: o marcador (e o projeto) sobrevivem a exportar → importar
  ok(await api('POST', `/api/projects/${p.id}/cancel`, { reason: 'De novo' }));
  const out = path.join(tmp, 'saida');
  fs.mkdirSync(out);
  ok(await api('POST', '/api/backup/export', { path: path.join(out, 'b.gpbackup') }));
  ok(await api('POST', `/api/projects/${p.id}/uncancel`));
  const ins = ok(await api('POST', '/api/backup/inspect', { path: path.join(out, 'b.gpbackup') }));
  ok(await api('POST', '/api/backup/import', { token: ins.token }));
  const restored = await getProj(p.id);
  assert.equal(restored.cancelled.reason, 'De novo', 'cancelado restaurado pelo backup');
  assert.equal(restored.schedule.state, 'cancelled');
  ok(await api('POST', `/api/projects/${p.id}/uncancel`));
  assert.equal((await getProj(p.id)).stepId, s1.id);
});
