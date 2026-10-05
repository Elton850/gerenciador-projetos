// Sincronização de configurações compartilháveis pelo canal: publicar, detectar (novo / atualizado / só aqui / nos dois / removido na
// origem), aplicar sem tocar em projetos/horas/conexões, ciclo com versão nova (projetos só mudam ao Aplicar), arquivos (scripts,
// imagens, documentos), pacote corrompido/mais novo, e as rotas (backup automático antes; revisão mudou → 409).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-cfgsync-'));
const PORT = 4471;
Object.assign(process.env, { PORT: String(PORT), GP_DATA_DIR: path.join(tmp, 'B', 'data'), GP_BACKUP_DIR: path.join(tmp, 'backups') });
const CS = require('../src/config-sync');
const C = require('../src/channel');
const cycles = require('../src/cycles');
const { Store } = require('../src/store');
const { ScriptFiles } = require('../src/scriptstore');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const CANAL = path.join(tmp, 'canal'); fs.mkdirSync(CANAL);
const A = path.join(tmp, 'A', 'data');
const EXT = path.join(tmp, 'externo'); fs.mkdirSync(EXT);
fs.writeFileSync(path.join(EXT, 'Roteiro.docx'), 'roteiro v1');

// Máquina A (publica): configurações + dados pessoais que NUNCA podem viajar
const a = new Store(A);
a.data.stages.push({ id: 'st-extra', name: 'Validação', color: '#123456' });
a.data.checklists.push({ id: 'ck-a', stageId: 'st-homologacao', name: 'Checklist A' }, { id: 'ck-b', stageId: 'st-homologacao', name: 'Checklist B' });
a.data.checklistItems.push(
  { id: 'it-1', checklistId: 'ck-a', stageId: 'st-homologacao', title: 'Conferir carga', description: '', required: true, evidence: { mode: 'none' }, links: [], scriptIds: ['sc-1'], condition: null, carryForward: false, dependsOn: [], emailTemplateId: null },
  { id: 'it-2', checklistId: 'ck-a', stageId: 'st-homologacao', title: 'Validar totais', description: '', required: false, evidence: { mode: 'none' }, links: [], scriptIds: [], condition: null, carryForward: false, dependsOn: [], emailTemplateId: null },
  { id: 'it-3', checklistId: 'ck-b', stageId: 'st-homologacao', title: 'Item B', description: '', required: false, evidence: { mode: 'none' }, links: [], scriptIds: [], condition: null, carryForward: false, dependsOn: [], emailTemplateId: null });
a.data.cycles[0].steps[0].checklistIds = ['ck-a', 'ck-b'];
a.data.scripts.push({ id: 'sc-1', name: 'Totais', description: '', file: 'totais.sql', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' });
new ScriptFiles(A).write('totais.sql', 'select count(*) from x;');
a.data.emailTemplates.push({ id: 'tp-g', name: 'Aviso global', scope: 'global', projectId: null, subject: 's', body: 'b', to: [], cc: [], bcc: [], active: true },
  { id: 'tp-p', name: 'Só do projeto', scope: 'project', projectId: 'pa', subject: 's', body: 'b', to: [], cc: [], bcc: [], active: true });
fs.mkdirSync(path.join(A, 'evidencias', 'comunicacoes', 'imagens'), { recursive: true });
fs.writeFileSync(path.join(A, 'evidencias', 'comunicacoes', 'imagens', 'im1_logo.png'), 'PNGDATA');
a.data.emailImages.push({ id: 'im1', name: 'logo.png', file: 'comunicacoes/imagens/im1_logo.png', mime: 'image/png', size: 7, at: '2026-10-01T00:00:00Z' });
a.data.documents.push({ id: 'dc1', title: 'Roteiro', kind: 'modelo', stageId: null, description: '', source: { type: 'file', path: path.join(EXT, 'Roteiro.docx') } });
a.data.settings.warnDays = 9;
a.data.projects.push({ id: 'pa', name: 'Projeto Pessoal A', bases: [], deparas: [], milestones: [] });
a.data.timeEntries.push({ id: 'te-a', projectId: 'pa', date: '2026-10-01', startMin: 1, endMin: 2 });
a.data.connections.push({ id: 'cx-a', name: 'Servidor A', server: '192.0.2.1', auth: 'windows' });
a.save();

// Máquina B (recebe): já tem seus próprios projetos/horas/configuração local
const b0 = new Store(process.env.GP_DATA_DIR);
b0.data.projects.push({ id: 'pb', name: 'Projeto da B', bases: [], deparas: [], milestones: [], cycleId: b0.data.cycles[0].id, steps: JSON.parse(JSON.stringify(b0.data.cycles[0].steps)), cycleVersion: b0.data.cycles[0].version });
b0.data.timeEntries.push({ id: 'te-b', projectId: 'pb', date: '2026-10-02', startMin: 10, endMin: 20 });
b0.data.checklists.push({ id: 'ck-local', stageId: 'st-homologacao', name: 'Só da B' });
b0.save();

const { app, store } = require('../server');
const base = `http://localhost:${PORT}`;
const api = async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Origin: base }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const ok = (r) => { assert.ok(r.status < 300, `HTTP ${r.status}: ${JSON.stringify(r.json)}`); return r.json; };
let server;
test.before(() => { server = app.listen(PORT, '127.0.0.1'); });
test.after(() => server.close());

const kinds = (d) => Object.fromEntries(d.changes.map((c) => [`${c.section}:${c.id}`, c.kind]));

test('publicar: pacote só com configurações (nada de projetos, horas, conexões nem modelos de projeto)', async () => {
  const r = await CS.publishConfigs({ dataDir: A, state: a.data, channelDir: CANAL, appVersion: '1.0.0', schemaVersion: 1 });
  assert.equal(r.revision, 1);
  a.data.settings.configSync = { revision: r.revision, hashes: r.hashes }; a.save(); // como a rota faz: quem publica fica com a base
  const raw = fs.readFileSync(path.join(CANAL, ...C.readChannel(CANAL).configs.file.split('/')));
  for (const s of ['Projeto Pessoal A', 'Servidor A', '192.0.2.1', 'te-a', 'Só do projeto']) assert.ok(!raw.includes(Buffer.from(s)), `não pode viajar: ${s}`);
  assert.equal(r.counts.emailTemplates, 1);
});

test('primeira sincronização (rota): mostra o que é novo; aplica com backup automático; projetos/horas da máquina ficam intactos', async () => {
  ok(await api('PUT', '/api/updates/channel', { path: CANAL }));
  const chk = ok(await api('POST', '/api/updates/check'));
  assert.equal(chk.app.status, 'up-to-date'); // nenhuma versão do app publicada nesta pasta
  assert.ok(chk.configs.toApply > 0);
  const d = ok(await api('POST', '/api/config-sync/check'));
  const k = kinds(d);
  for (const key of ['checklists:ck-a', 'checklistItems:it-1', 'scripts:sc-1', 'emailTemplates:tp-g', 'emailImages:im1', 'documents:dc1', 'stages:st-extra']) assert.equal(k[key], 'new', key);
  assert.equal(k['emailTemplates:tp-p'], undefined);
  const projectsBefore = JSON.stringify(store.data.projects); const hoursBefore = JSON.stringify(store.data.timeEntries);
  assert.equal((await api('POST', '/api/config-sync/apply', { revision: 99 })).status, 409);
  const r = ok(await api('POST', '/api/config-sync/apply', { revision: d.revision }));
  assert.ok(fs.existsSync(r.safetyBackup) && /antes-sincronizacao-r1/.test(r.safetyBackup));
  assert.equal(JSON.stringify(store.data.projects), projectsBefore); assert.equal(JSON.stringify(store.data.timeEntries), hoursBefore);
  assert.ok(store.data.checklists.some((c) => c.id === 'ck-local'), 'o que só existe aqui continua');
  assert.equal(store.data.connections.length, 0, 'conexões nunca vêm');
  assert.equal(new ScriptFiles(process.env.GP_DATA_DIR).read('totais.sql').trim(), 'select count(*) from x;');
  assert.equal(fs.readFileSync(path.join(process.env.GP_DATA_DIR, 'evidencias', 'comunicacoes', 'imagens', 'im1_logo.png'), 'utf8'), 'PNGDATA');
  assert.equal(store.data.settings.warnDays, 9);
  assert.equal(store.data.settings.configSync.revision, 1);
  assert.equal(ok(await api('POST', '/api/config-sync/check')).toApply, 0, 'em dia depois de aplicar');
});

test('mudanças dos dois lados: atualizado na origem → aplica; alterado só aqui → mantém; alterado nos dois → vale a origem; removido na origem → mantém aqui', async () => {
  // aqui (B)
  store.data.checklistItems.find((i) => i.id === 'it-2').title = 'Validar totais (versão da B)'; // só aqui
  store.data.checklistItems.find((i) => i.id === 'it-1').description = 'nota da B';             // nos dois
  store.save();
  // na origem (A)
  a.data.checklistItems.find((i) => i.id === 'it-1').description = 'nota da A';
  a.data.checklistItems.find((i) => i.id === 'it-3').title = 'Item B revisado';                  // só na origem
  a.data.checklists = a.data.checklists.filter((c) => c.id !== 'ck-b');                        // removido na origem
  a.data.cycles[0].steps[0].checklistIds = ['ck-a'];
  new ScriptFiles(A).write('totais.sql', 'select count(*) from y;');
  const r = await CS.publishConfigs({ dataDir: A, state: a.data, channelDir: CANAL, appVersion: '1.0.0', schemaVersion: 1 });
  assert.equal(r.revision, 2);
  const d = ok(await api('POST', '/api/config-sync/check'));
  const k = kinds(d);
  assert.equal(k['checklistItems:it-2'], 'local-only');
  assert.equal(k['checklistItems:it-1'], 'conflict');
  assert.equal(k['checklistItems:it-3'], 'updated');
  assert.equal(k['checklists:ck-b'], 'removed-at-source');
  assert.equal(k['scripts:sc-1'], 'updated', 'conteúdo do script mudou');
  const cyc = store.data.cycles[0]; const vBefore = cyc.version;
  ok(await api('POST', '/api/config-sync/apply', { revision: d.revision }));
  const it = (id) => store.data.checklistItems.find((i) => i.id === id);
  assert.equal(it('it-2').title, 'Validar totais (versão da B)');
  assert.equal(it('it-1').description, 'nota da A');
  assert.equal(it('it-3').title, 'Item B revisado');
  assert.ok(store.data.checklists.some((c) => c.id === 'ck-b'), 'removido na origem continua aqui');
  const sf = new ScriptFiles(process.env.GP_DATA_DIR);
  assert.equal(sf.read('totais.sql').trim(), 'select count(*) from y;');
  assert.ok(fs.readdirSync(sf.versions).some((f) => f.startsWith('totais__')), 'versão anterior do script guardada');
  assert.ok(store.data.cycles[0].version > vBefore, 'ciclo com passos alterados ganha versão nova');
  const pb = store.project('pb');
  assert.ok(cycles.cycleDiff(store.data, pb).available, 'o projeto vê “nova versão do ciclo”');
  assert.deepEqual(pb.steps[0].checklistIds || [], b0.data.cycles[0].steps[0].checklistIds || [], 'mas o projeto só muda ao Aplicar');
});

test('documento cujo arquivo não existe nesta máquina: a cópia do pacote vai para a pasta de dados', async () => {
  fs.rmSync(path.join(EXT, 'Roteiro.docx'));
  fs.writeFileSync(path.join(EXT, 'Roteiro2.docx'), 'roteiro v2');
  a.data.documents[0].source.path = path.join(EXT, 'Roteiro2.docx');
  await CS.publishConfigs({ dataDir: A, state: a.data, channelDir: CANAL, appVersion: '1.0.0', schemaVersion: 1 });
  fs.rmSync(path.join(EXT, 'Roteiro2.docx')); // some daqui também (simula outra máquina)
  const d = ok(await api('POST', '/api/config-sync/check'));
  ok(await api('POST', '/api/config-sync/apply', { revision: d.revision }));
  const doc = store.data.documents.find((x) => x.id === 'dc1');
  assert.equal(doc.source.path, path.join(process.env.GP_DATA_DIR, 'documentos', 'dc1', 'Roteiro2.docx'));
  assert.equal(fs.readFileSync(doc.source.path, 'utf8'), 'roteiro v2');
});

test('pacote corrompido ou de versão mais nova: recusado, nada muda', async () => {
  const before = JSON.stringify(store.data);
  const ch = C.readChannel(CANAL);
  const f = path.join(CANAL, ...ch.configs.file.split('/'));
  const orig = fs.readFileSync(f); const bad = Buffer.from(orig); bad[bad.length - 30] ^= 0xff; fs.writeFileSync(f, bad);
  assert.equal((await api('POST', '/api/config-sync/check')).json.code, 'CONFIG_CORRUPTED');
  fs.writeFileSync(f, orig);
  await assert.rejects(CS.readPackage(CANAL, { schemaVersion: 0 }), { code: 'CONFIG_TOO_NEW' });
  assert.equal(JSON.stringify(store.data), before);
});

test('publicar versão do aplicativo fora do app instalado é recusado (modo desenvolvimento)', async () => {
  const r = await api('POST', '/api/updates/publish', {});
  assert.equal(r.status, 400); assert.equal(r.json.code, 'NOT_PACKAGED');
  const s = ok(await api('GET', '/api/updates/status'));
  assert.equal(s.packaged, false); assert.equal(s.schemaVersion, 1); assert.equal(s.channel, CANAL);
});
