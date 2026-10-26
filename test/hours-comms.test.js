// Controle de Horas × Comunicações: links (PSA/planilha), contexto do mês, coordenadores dos projetos com apontamentos (sem duplicar),
// geração com modelo existente (mesmo gerador e histórico), lembrete com ação de horas e backup. Dados em pasta temporária; nada é enviado.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('../src/hours');

test('contexto do mês: projetos com apontamentos, total, coordenador atual (fotografia só se o projeto sumiu), sem duplicar', () => {
  const data = {
    coordinators: [{ id: 'joao', name: 'João', email: 'joao@exemplo.test' }, { id: 'maria', name: 'Maria', email: 'maria@exemplo.test' }],
    projects: [{ id: 'A', name: 'Projeto A', coordinatorId: 'joao' }, { id: 'B', name: 'Projeto B', coordinatorId: 'maria' }, { id: 'C', name: 'Projeto C', coordinatorId: 'joao' }],
    timeEntries: [
      { projectId: 'A', projectName: 'Projeto A', date: '2025-03-03', startMin: 540, endMin: 600, pausedMin: 0, coordinatorId: 'maria' }, // fotografia antiga: vale o cadastro atual (João)
      { projectId: 'B', projectName: 'Projeto B', date: '2025-03-04', startMin: 600, endMin: 720, pausedMin: 0 },
      { projectId: 'C', projectName: 'Projeto C', date: '2025-03-05', startMin: 480, endMin: 510, pausedMin: 0 },
      { projectId: 'internal', projectName: 'Interno / Administrativo', date: '2025-03-05', startMin: 510, endMin: 540, pausedMin: 0 },
      { projectId: 'X', projectName: 'Projeto Removido', date: '2025-03-06', startMin: 480, endMin: 540, pausedMin: 0, coordinatorId: 'maria' },
      { projectId: 'A', projectName: 'Projeto A', date: '2025-04-01', startMin: 480, endMin: 540, pausedMin: 0 }, // outro mês
    ],
  };
  const mc = H.monthContext(data, 2025, 3);
  assert.equal(mc.label, 'Março/2025');
  assert.deepEqual(mc.projects.map((p) => [p.name, p.minutes, p.coordinatorName]), [['Projeto A', 60, 'João'], ['Projeto B', 120, 'Maria'], ['Projeto C', 30, 'João'], ['Projeto Removido', 60, 'Maria']]);
  assert.equal(mc.projects.find((p) => p.id === 'X').exists, false);
  assert.deepEqual(mc.coordinators.map((c) => c.name), ['João', 'Maria'], 'sem duplicar o João');
  assert.equal(mc.totalText, '05:00', 'total inclui o Interno (é tempo apontado no mês)');
  assert.equal(H.monthContext(data, 2025, 2).projects.length, 0);
  assert.deepEqual(H.cleanLinks({ psaUrl: ' https://psa.exemplo.test/x ', sheetUrl: '' }), { psaUrl: 'https://psa.exemplo.test/x', sheetUrl: '' });
  assert.throws(() => H.cleanLinks({ psaUrl: 'javascript:alert(1)' }), /PSA/);
  assert.throws(() => H.cleanLinks({ sheetUrl: 'ftp://x' }), /planilha/);
});

// ---------- API ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-hcomms-'));
const PORT = 4473;
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

test('API: links, geração do mês com coordenadores únicos e projeto sem coordenador, histórico, lembrete com ação e backup', async () => {
  // links (PSA e planilha): validação, salvar e não sumir ao salvar a jornada
  assert.equal((await api('PUT', '/api/hours/links', { psaUrl: 'nao-e-link' })).status, 400);
  ok(await api('PUT', '/api/hours/links', { psaUrl: 'https://psa.exemplo.test/apontar', sheetUrl: 'https://planilha.exemplo.test/horas' }));
  const cfg = ok(await api('GET', '/api/hours/state')).config;
  assert.deepEqual(cfg.links, { psaUrl: 'https://psa.exemplo.test/apontar', sheetUrl: 'https://planilha.exemplo.test/horas' });
  const { links, emailTemplateId, ...jornada } = cfg;
  ok(await api('PUT', '/api/hours/config', jornada));
  assert.equal(ok(await api('GET', '/api/hours/state')).config.links.sheetUrl, 'https://planilha.exemplo.test/horas', 'salvar a jornada não apaga os links');

  // pessoas, projetos e apontamentos de março/2025
  const joao = ok(await api('POST', '/api/coordinators', { name: 'João Coordenador', email: 'joao@exemplo.test' }));
  const maria = ok(await api('POST', '/api/coordinators', { name: 'Maria Coordenadora', email: 'maria@exemplo.test' }));
  const semEmail = ok(await api('POST', '/api/coordinators', { name: 'Pedro Sem Email' }));
  const A = ok(await api('POST', '/api/projects', { name: 'Projeto A', coordinatorId: joao.id }));
  const B = ok(await api('POST', '/api/projects', { name: 'Projeto B', coordinatorId: maria.id }));
  const C = ok(await api('POST', '/api/projects', { name: 'Projeto C', coordinatorId: joao.id }));
  const D = ok(await api('POST', '/api/projects', { name: 'Projeto D' }));
  const E = ok(await api('POST', '/api/projects', { name: 'Projeto E', coordinatorId: semEmail.id }));
  ok(await api('POST', '/api/projects', { name: 'Projeto sem horas', coordinatorId: maria.id }));
  const entry = (p, date, start, end) => api('POST', '/api/hours/entries', { date, projectId: p.id, activity: 'Migração', start, end });
  ok(await entry(A, '2025-03-03', '09:00', '11:00'));
  ok(await entry(B, '2025-03-04', '09:00', '12:30'));
  ok(await entry(C, '2025-03-05', '09:00', '10:00'));
  ok(await entry(D, '2025-03-06', '09:00', '10:00'));
  ok(await entry(E, '2025-03-07', '09:00', '09:30'));

  const ctx = ok(await api('GET', '/api/hours/month-context?year=2025&month=3'));
  assert.equal(ctx.label, 'Março/2025');
  assert.equal(ctx.projects.length, 5);
  assert.deepEqual(ctx.coordinators.map((c) => c.name).sort(), ['João Coordenador', 'Maria Coordenadora', 'Pedro Sem Email']);
  assert.equal(ctx.totalText, '08:00');

  // modelo existente do Gerador de Comunicações, com a fonte dinâmica e variáveis do contexto
  const t = ok(await api('POST', '/api/email-templates', { name: 'Envio de horas', subject: 'Horas de {{hours.period}}', to: ['role:context_coordinators'], cc: ['gestao@exemplo.test'],
    body: '{{greeting}}! Em {{hours.month}}/{{hours.year}}: {{hours.project_count}} projetos ({{hours.projects}}), total {{hours.total_hours}}. Coordenadores: {{hours.coordinators}}.' }));
  const projOnly = ok(await api('POST', '/api/email-templates', { name: 'Só do projeto A', subject: 's', body: 'b', to: ['role:coordinator'], scope: 'project', projectId: A.id }));
  assert.equal((await api('POST', '/api/hours/emails/generate', { templateId: projOnly.id, year: 2025, month: 3 })).json.code, 'EMAIL_TEMPLATE_UNAVAILABLE', 'só modelos globais');

  const g = ok(await api('POST', '/api/hours/emails/generate', { templateId: t.id, year: 2025, month: 3 }));
  assert.deepEqual(g.to, ['joao@exemplo.test', 'maria@exemplo.test'], 'coordenadores dos projetos do mês, sem duplicar o João');
  assert.deepEqual(g.cc, ['gestao@exemplo.test']);
  assert.equal(g.subject, 'Horas de Março/2025');
  assert.match(g.body, /Em Março\/2025: 5 projetos \(Projeto A, Projeto B, Projeto C, Projeto D, Projeto E\), total 08:00\. Coordenadores: João Coordenador, Maria Coordenadora, Pedro Sem Email\./);
  assert.ok(g.warnings.some((w) => /^2 projetos não possuem coordenador com e-mail cadastrado: Projeto D, Projeto E\.$/.test(w)), g.warnings.join(' | '));
  assert.equal(g.context, 'Controle de Horas — Março/2025');
  // mesmo histórico de comunicações (nada novo), com a origem; nada enviado
  const hist = ok(await api('GET', '/api/email-generations'));
  const rec = (Array.isArray(hist) ? hist : hist.generations || hist.items).find((x) => x.id === g.generationId);
  assert.ok(rec, 'registrada no histórico existente');
  assert.equal(rec.projectId, null);
  assert.equal(rec.projectName, 'Controle de Horas — Março/2025');
  assert.equal(ok(await api('GET', '/api/hours/month-context?year=2025&month=3')).emailTemplateId, t.id, 'lembra o último modelo usado');
  // o mesmo papel dinâmico num projeto = o coordenador dele (reaproveitável fora das horas)
  const gp = ok(await api('POST', `/api/projects/${A.id}/emails/generate`, { templateId: t.id }));
  assert.deepEqual(gp.to, ['joao@exemplo.test']);
  assert.ok(gp.warnings.some((w) => /Controle de Horas usada fora/.test(w)), 'variável de horas fora das horas vira aviso');

  // lembrete com vários horários e ação do Controle de Horas
  assert.equal((await api('POST', '/api/reminders', { title: 'x', date: '2025-03-01', time: '09:00', action: { kind: 'hours', templateId: projOnly.id } })).status, 400);
  ok(await api('POST', '/api/reminders', { title: 'Atualizar / enviar controle de horas', date: '2025-03-03', times: ['17:00', '09:00'], repeat: { unit: 'week', every: 1, weekdays: [1, 2, 3, 4, 5] }, action: { kind: 'hours', templateId: t.id } }));
  ok(await api('POST', '/api/reminders', { title: 'Ligar para o cliente', projectId: A.id, date: '2025-03-03', time: '10:00', action: { kind: 'email', templateId: projOnly.id } }));
  const rl = ok(await api('GET', '/api/reminders?filter=all'));
  const hr = rl.items.find((x) => x.title.startsWith('Atualizar'));
  assert.deepEqual(hr.times, ['09:00', '17:00']);
  assert.deepEqual(hr.action, { kind: 'hours', templateId: t.id });
  assert.deepEqual(rl.hoursLinks, { psaUrl: 'https://psa.exemplo.test/apontar', sheetUrl: 'https://planilha.exemplo.test/horas' }, 'o card tem os links do PSA e da planilha');
  // a ação “Gerar e-mail” do card usa a mesma rota com o modelo do lembrete
  const fromReminder = ok(await api('POST', '/api/hours/emails/generate', { templateId: hr.action.templateId }));
  assert.match(fromReminder.subject, /^Horas de /);

  // backup: links, modelo lembrado, lembretes com horários e ação → restauração
  const out = path.join(tmp, 'saida');
  fs.mkdirSync(out);
  ok(await api('POST', '/api/backup/export', { path: path.join(out, 'b.gpbackup') }));
  ok(await api('PUT', '/api/hours/links', { psaUrl: '', sheetUrl: '' }));
  ok(await api('DELETE', `/api/reminders/${encodeURIComponent(hr.key)}`));
  const ins = ok(await api('POST', '/api/backup/inspect', { path: path.join(out, 'b.gpbackup') }));
  ok(await api('POST', '/api/backup/import', { token: ins.token }));
  const st = ok(await api('GET', '/api/hours/state')).config;
  assert.equal(st.links.psaUrl, 'https://psa.exemplo.test/apontar');
  assert.equal(st.emailTemplateId, t.id);
  const back = ok(await api('GET', '/api/reminders?filter=all')).items.find((x) => x.key === hr.key);
  assert.deepEqual([back.times, back.action], [['09:00', '17:00'], { kind: 'hours', templateId: t.id }]);
});

test('período (mês, dia, de/até) e filtro por coordenador: rótulos, validação, total só dos projetos do coordenador', () => {
  assert.deepEqual(H.cleanPeriod({ year: 2025, month: 3 }), { from: '2025-03-01', to: '2025-03-31', kind: 'month', year: 2025, month: 3, label: 'Março/2025' });
  assert.equal(H.cleanPeriod({ from: '2025-03-01', to: '2025-03-31' }).kind, 'month', 'de/até cobrindo o mês inteiro = mês');
  assert.equal(H.cleanPeriod({ from: '2025-03-05', to: '2025-03-05' }).label, '05/03/2025');
  assert.equal(H.cleanPeriod({ from: '2025-03-05' }).kind, 'day', 'só a data inicial = um dia');
  assert.equal(H.cleanPeriod({ from: '2025-02-26', to: '2025-03-25' }).label, '26/02/2025 a 25/03/2025');
  assert.throws(() => H.cleanPeriod({ from: '2025-03-10', to: '2025-03-01' }), /anterior/);
  assert.throws(() => H.cleanPeriod({ from: '2025-02-30', to: '2025-03-01' }), /Período inválido/);
  assert.throws(() => H.cleanPeriod({ from: '2024-01-01', to: '2025-01-01' }), /366 dias/);
  assert.equal(H.cleanPeriod({ from: '2024-01-01', to: '2024-12-31' }).kind, 'range', '366 dias (ano bissexto) é aceito');
  assert.throws(() => H.cleanPeriod({ year: 2025, month: 13 }), /Mês inválido/);

  const data = {
    coordinators: [{ id: 'joao', name: 'João', email: 'joao@exemplo.test' }, { id: 'maria', name: 'Maria', email: 'maria@exemplo.test' }],
    projects: [{ id: 'A', name: 'Projeto A', coordinatorId: 'joao' }, { id: 'B', name: 'Projeto B', coordinatorId: 'maria' }, { id: 'C', name: 'Projeto C', coordinatorId: 'joao' }],
    timeEntries: [
      { projectId: 'A', projectName: 'Projeto A', date: '2025-03-03', startMin: 540, endMin: 600, pausedMin: 0 },
      { projectId: 'B', projectName: 'Projeto B', date: '2025-03-03', startMin: 600, endMin: 720, pausedMin: 0 },
      { projectId: 'internal', projectName: 'Interno / Administrativo', date: '2025-03-03', startMin: 720, endMin: 750, pausedMin: 0 },
      { projectId: 'C', projectName: 'Projeto C', date: '2025-03-04', startMin: 480, endMin: 510, pausedMin: 0 },
    ],
  };
  const day = H.hoursContext(data, H.cleanPeriod({ from: '2025-03-03', to: '2025-03-03' }));
  assert.deepEqual(day.projects.map((p) => [p.name, p.hoursText]), [['Projeto A', '01:00'], ['Projeto B', '02:00']], 'só o dia 03');
  assert.equal(day.totalText, '03:30', 'sem filtro: total do dia com o Interno, como no mês');
  const joao = H.hoursContext(data, H.cleanPeriod({ year: 2025, month: 3 }), { coordinatorIds: ['joao'] });
  assert.deepEqual(joao.projects.map((p) => p.name), ['Projeto A', 'Projeto C']);
  assert.deepEqual(joao.coordinators.map((c) => c.name), ['João']);
  assert.equal(joao.totalText, '01:30', 'por coordenador: só os projetos dele (sem Interno)');
  assert.deepEqual(H.coordinatorProjectIds(data, H.cleanPeriod({ from: '2025-03-03', to: '2025-03-03' }), 'joao'), ['A']);
  assert.equal(H.cleanCoordinatorIds(data, []), null, 'vazio = todos');
  assert.deepEqual(H.cleanCoordinatorIds(data, ['joao', 'joao', 'maria']), ['joao', 'maria']);
  assert.throws(() => H.cleanCoordinatorIds(data, ['ninguem']), /não encontrado/);
});

test('API: e-mail por coordenador e por dia/período, e planilha filtrada por coordenador e por projeto', async () => {
  const ana = ok(await api('POST', '/api/coordinators', { name: 'Ana Coordenadora', email: 'ana@exemplo.test' }));
  const bia = ok(await api('POST', '/api/coordinators', { name: 'Bia Coordenadora', email: 'bia@exemplo.test' }));
  const P1 = ok(await api('POST', '/api/projects', { name: 'Cliente Alfa', coordinatorId: ana.id }));
  const P2 = ok(await api('POST', '/api/projects', { name: 'Cliente Beta', coordinatorId: bia.id }));
  const P3 = ok(await api('POST', '/api/projects', { name: 'Cliente Gama', coordinatorId: ana.id }));
  const entry = (p, date, start, end) => api('POST', '/api/hours/entries', { date, projectId: p.id, activity: 'Migração', start, end });
  ok(await entry(P1, '2025-05-05', '08:00', '10:00'));
  ok(await entry(P2, '2025-05-05', '10:00', '11:30'));
  ok(await entry(P3, '2025-05-06', '08:00', '09:00'));
  ok(await entry(P1, '2025-05-07', '08:00', '08:30'));

  const ctx = ok(await api('GET', '/api/hours/month-context?from=2025-05-05&to=2025-05-05'));
  assert.equal(ctx.label, '05/05/2025');
  assert.deepEqual(ctx.projects.map((p) => [p.name, p.coordinatorName, p.hoursText]), [['Cliente Alfa', 'Ana Coordenadora', '02:00'], ['Cliente Beta', 'Bia Coordenadora', '01:30']]);
  assert.equal((await api('GET', '/api/hours/month-context?from=2025-05-07&to=2025-05-01')).status, 400);

  const t = ok(await api('POST', '/api/email-templates', { name: 'Horas do dia', subject: 'Horas {{hours.period}} — {{hours.coordinators}}', to: ['role:context_coordinators'],
    body: 'De {{hours.start_date}} a {{hours.end_date}}: {{hours.projects_hours}}. Total {{hours.total_hours}}.' }));
  // um e-mail por coordenador, num dia
  const gA = ok(await api('POST', '/api/hours/emails/generate', { templateId: t.id, from: '2025-05-05', to: '2025-05-05', coordinatorIds: [ana.id] }));
  assert.deepEqual(gA.to, ['ana@exemplo.test'], 'só a coordenadora escolhida');
  assert.equal(gA.subject, 'Horas 05/05/2025 — Ana Coordenadora');
  assert.match(gA.body, /De 05\/05\/2025 a 05\/05\/2025: Cliente Alfa \(02:00\)\. Total 02:00\./);
  assert.equal(gA.context, 'Controle de Horas — 05/05/2025 — Ana Coordenadora');
  const gB = ok(await api('POST', '/api/hours/emails/generate', { templateId: t.id, from: '2025-05-05', to: '2025-05-05', coordinatorIds: [bia.id] }));
  assert.deepEqual(gB.to, ['bia@exemplo.test']);
  assert.match(gB.body, /Cliente Beta \(01:30\)\. Total 01:30\./);
  // período de/até para a Ana: os dois projetos dela
  const gP = ok(await api('POST', '/api/hours/emails/generate', { templateId: t.id, from: '2025-05-05', to: '2025-05-07', coordinatorIds: [ana.id] }));
  assert.equal(gP.subject, 'Horas 05/05/2025 a 07/05/2025 — Ana Coordenadora');
  assert.match(gP.body, /Cliente Alfa \(02:30\), Cliente Gama \(01:00\)\. Total 03:30\./);
  // vários coordenadores num único e-mail; coordenador inexistente; o mês continua igual
  const gAll = ok(await api('POST', '/api/hours/emails/generate', { templateId: t.id, from: '2025-05-05', to: '2025-05-07', coordinatorIds: [ana.id, bia.id] }));
  assert.deepEqual(gAll.to, ['ana@exemplo.test', 'bia@exemplo.test']);
  assert.equal((await api('POST', '/api/hours/emails/generate', { templateId: t.id, year: 2025, month: 5, coordinatorIds: ['nao-existe'] })).status, 400);
  assert.equal(ok(await api('POST', '/api/hours/emails/generate', { templateId: t.id, year: 2025, month: 5 })).subject, 'Horas Maio/2025 — Ana Coordenadora, Bia Coordenadora');

  // planilha: período + coordenador e mês + projeto
  const ExcelJS = require('exceljs');
  const sheet = async (qs) => {
    const r = await fetch(`${base}/api/hours/export?${qs}`);
    assert.equal(r.status, 200, qs);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await r.arrayBuffer()));
    const clients = []; wb.worksheets[0].eachRow((row, n) => { if (n > 1 && row.getCell(8).value) clients.push(row.getCell(7).value); });
    return { name: decodeURIComponent(/filename\*=UTF-8''(.+)$/.exec(r.headers.get('content-disposition'))[1]), clients, sheets: wb.worksheets.map((w) => w.name) };
  };
  const sa = await sheet(`from=2025-05-05&to=2025-05-07&coordinatorId=${ana.id}`);
  assert.deepEqual(sa.clients, ['Cliente Alfa', 'Cliente Gama', 'Cliente Alfa']);
  assert.equal(sa.name, 'Apontamentos_2025-05-05_a_2025-05-07_Ana_Coordenadora.xlsx');
  assert.ok(!sa.sheets.includes('Resumo do Período'));
  const sp = await sheet(`year=2025&month=5&projectId=${P2.id}`);
  assert.deepEqual(sp.clients, ['Cliente Beta']);
  assert.equal(sp.name, 'Apontamentos_2025_05_Cliente_Beta.xlsx');
  const sd = await sheet('from=2025-05-05&to=2025-05-05');
  assert.deepEqual(sd.clients, ['Cliente Alfa', 'Cliente Beta']);
  assert.equal((await fetch(`${base}/api/hours/export?from=2025-05-05&to=2025-05-05&coordinatorId=ninguem`)).status, 400);
  assert.equal((await fetch(`${base}/api/hours/export?year=2025&month=5&projectId=ninguem`)).status, 400);
});

test('API: planilha só dos projetos escolhidos (vários), interseção com coordenador, nomes e validação', async () => {
  const caio = ok(await api('POST', '/api/coordinators', { name: 'Caio Coordenador', email: 'caio@exemplo.test' }));
  const duda = ok(await api('POST', '/api/coordinators', { name: 'Duda Coordenadora', email: 'duda@exemplo.test' }));
  const mk = async (name, c) => ok(await api('POST', '/api/projects', { name, coordinatorId: c.id }));
  const [P1, P2, P3, P4] = [await mk('Cliente Um', caio), await mk('Cliente Dois', duda), await mk('Cliente Três', caio), await mk('Cliente Quatro', duda)];
  const entry = (p, date, start, end) => api('POST', '/api/hours/entries', { date, projectId: p.id, activity: 'Migração', start, end });
  ok(await entry(P1, '2025-06-02', '08:00', '09:00'));
  ok(await entry(P2, '2025-06-02', '09:00', '10:00'));
  ok(await entry(P3, '2025-06-03', '08:00', '09:00'));
  ok(await entry(P4, '2025-06-04', '08:00', '09:00'));

  const ExcelJS = require('exceljs');
  const sheet = async (qs) => {
    const r = await fetch(`${base}/api/hours/export?${qs}`);
    assert.equal(r.status, 200, qs);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await r.arrayBuffer()));
    const clients = []; wb.worksheets[0].eachRow((row, n) => { if (n > 1 && row.getCell(8).value) clients.push(row.getCell(7).value); });
    const filterRow = []; wb.getWorksheet('Resumo por Projeto').eachRow((row) => { const v = row.getCell(1).value; if (typeof v === 'string' && v.startsWith('Filtro:')) filterRow.push(v); });
    return { name: decodeURIComponent(/filename\*=UTF-8''(.+)$/.exec(r.headers.get('content-disposition'))[1]), clients, filterRow };
  };
  const two = await sheet(`from=2025-06-01&to=2025-06-15&projectIds=${P1.id},${P2.id}`);
  assert.deepEqual(two.clients, ['Cliente Um', 'Cliente Dois']);
  assert.equal(two.name, 'Apontamentos_2025-06-01_a_2025-06-15_Cliente_Um+Cliente_Dois.xlsx');
  assert.deepEqual(two.filterRow, ['Filtro: Projetos: Cliente Um, Cliente Dois · 01/06/2025 a 15/06/2025']);
  const four = await sheet(`year=2025&month=6&projectIds=${[P1, P2, P3, P4].map((p) => p.id).join(',')}`);
  assert.equal(four.clients.length, 4);
  assert.equal(four.name, 'Apontamentos_2025_06_4_projetos.xlsx', 'mais de 3 projetos: nome curto, lista completa na planilha');
  assert.match(four.filterRow[0], /Projetos: Cliente Um, Cliente Dois, Cliente Três, Cliente Quatro/);
  // coordenador + projetos = interseção; projectId antigo continua valendo e soma com projectIds
  const inter = await sheet(`year=2025&month=6&coordinatorId=${caio.id}&projectIds=${P1.id},${P2.id}`);
  assert.deepEqual(inter.clients, ['Cliente Um']);
  const mixed = await sheet(`year=2025&month=6&projectId=${P3.id}&projectIds=${P4.id}`);
  assert.deepEqual(mixed.clients, ['Cliente Três', 'Cliente Quatro']);
  assert.equal((await fetch(`${base}/api/hours/export?year=2025&month=6&projectIds=${P1.id},ninguem`)).status, 400);
});
