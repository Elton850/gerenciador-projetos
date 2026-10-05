// Backup e Restauração: exportar tudo para um .gpbackup e importar (substituindo tudo) — inclusive numa "máquina" vazia.
// Cobre: manifesto, checksums, arquivos físicos (evidências, imagens, scripts e versões, horas, documentos), horas, projetos,
// configurações, senha do pacote (AES-256-GCM), senhas DPAPI (abertas só em memória e protegidas de novo), backup corrompido,
// versão incompatível, backup automático antes de importar, desfazer (rollback), caminhos inexistentes e nenhuma perda de dados.
// Tudo em pasta temporária; dados fictícios.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const JSZip = require('jszip');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-backup-'));
const PORT = 4470;
const DATA = path.join(tmp, 'data');
const EXT = path.join(tmp, 'externo'); // arquivos fora da pasta de dados (documento cadastrado)
Object.assign(process.env, { PORT: String(PORT), GP_DATA_DIR: DATA, GP_BACKUP_DIR: path.join(tmp, 'backups') });

const CANARY = 'Projeto Canario Backup';
const SQL_PASS = 'Senha-Banco-Ficticia-42';
const PKG_PASS = 'Senha-Do-Backup-2026';
const w = (rel, content) => { const f = path.join(DATA, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); };

fs.mkdirSync(EXT, { recursive: true });
fs.writeFileSync(path.join(EXT, 'Manual.pdf'), 'conteudo-do-manual');
w('evidencias/projeto-canario/01-inicio/ev1_print.png', crypto.randomBytes(3000));
w('evidencias/.removidas/antiga.txt', 'evidencia removida (nada é apagado)');
w('evidencias/comunicacoes/imagens/img1_logo.png', crypto.randomBytes(500));
w('evidencias/horas/2026-10/nota1_anexo.txt', 'anexo das horas');
w('scripts/carga.sql', 'select 1;\r\n');
w('scripts/.versoes/carga__20261001-120000.sql', 'select 0;\r\n');
w('audit.log', '{"at":"2026-10-01T00:00:00Z","action":"teste"}\n');
w('projects.json', JSON.stringify({
  version: 1, settings: { warnDays: 5 },
  projects: [{ id: 'p1', name: CANARY, description: 'desc', rootDir: 'X:\\NaoExiste\\Cliente', bases: [{ id: 'b1', name: 'Base', directory: 'X:\\NaoExiste\\Cliente\\bases' }], deparas: [], milestones: [], contacts: [{ id: 'k1', name: 'Contato Ficticio', email: 'contato@exemplo.test' }] }],
  coordinators: [{ id: 'c1', name: 'Coordenadora Ficticia', role: 'Coord', email: 'coord@exemplo.test', phone: '', notes: '' }],
  documents: [{ id: 'd1', title: 'Manual', kind: 'documento', stageId: null, description: '', source: { type: 'file', path: path.join(EXT, 'Manual.pdf') } },
    { id: 'd2', title: 'Site', kind: 'modelo', stageId: null, description: '', source: { type: 'link', url: 'https://exemplo.test' } }],
  scripts: [{ id: 's1', name: 'Carga', description: '', file: 'carga.sql', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' }],
  emailImages: [{ id: 'img1', name: 'logo.png', file: 'comunicacoes/imagens/img1_logo.png', mime: 'image/png', size: 500, at: '2026-10-01T00:00:00Z' }],
  timeEntries: [{ id: 't1', projectId: 'p1', projectName: CANARY, date: '2026-10-01', startMin: 480, endMin: 600, pausedMin: 0, activity: 'Carga', note: '', source: 'manual', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' }],
  timeNotes: [{ id: 'n1', date: '2026-10-01', text: 'observação das horas', evidences: [{ id: 'e1', name: 'anexo.txt', file: 'horas/2026-10/nota1_anexo.txt' }] }],
  workspace: { root: 'X:\\NaoExiste', aliases: {} },
}));

const { app, store } = require('../server');
const B = require('../src/backup');
const { unprotect } = require('../src/secrets');
const { Store } = require('../src/store');

const base = `http://localhost:${PORT}`;
const api = async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Origin: base }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const ok = (r) => { assert.ok(r.status < 300, `HTTP ${r.status}: ${JSON.stringify(r.json)}`); return r.json; };
const out = (name) => path.join(tmp, name);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const tree = (dir) => { const m = {}; (function go(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) go(p); else if (!/^projects\.json\./.test(e.name)) m[path.relative(dir, p).split(path.sep).join('/')] = sha(fs.readFileSync(p)); } })(dir); return m; };
const withoutSecrets = (s) => JSON.parse(JSON.stringify(s, (k, v) => (k === 'passwordEnc' || k === 'lastBackupAt' || k === 'lastBackupFile' ? undefined : v)));

let server;
test.before(async () => {
  server = app.listen(PORT, '127.0.0.1');
  ok(await api('POST', '/api/connections', { name: 'Banco Ficticio', env: 'dev', server: '192.0.2.10', database: 'DB', auth: 'sql', user: 'usr', password: SQL_PASS }));
});
test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('exportar (sem senha): um arquivo ZIP com manifesto, checksums e todos os arquivos físicos; sem senhas DPAPI', async () => {
  const r = ok(await api('POST', '/api/backup/export', { path: out('plano.gpbackup') }));
  assert.equal(r.encrypted, false);
  const buf = fs.readFileSync(r.file);
  const zip = await JSZip.loadAsync(buf);
  const m = JSON.parse(await zip.file('manifest.json').async('string'));
  assert.equal(m.format, 'GerenciadorProjetosBackup'); assert.equal(m.version, 1); assert.ok(m.createdAt);
  const names = m.files.map((f) => f.path);
  for (const f of ['data/projects.json', 'data/audit.log', 'data/evidencias/projeto-canario/01-inicio/ev1_print.png', 'data/evidencias/.removidas/antiga.txt',
    'data/evidencias/comunicacoes/imagens/img1_logo.png', 'data/evidencias/horas/2026-10/nota1_anexo.txt', 'data/scripts/carga.sql',
    'data/scripts/.versoes/carga__20261001-120000.sql', 'documentos/d1/Manual.pdf']) assert.ok(names.includes(f), f);
  assert.ok(!names.some((n) => /projects\.json\.bak/.test(n)), 'cópias .bak não entram');
  for (const f of m.files) assert.equal(sha(await zip.file(f.path).async('nodebuffer')), f.sha256, f.path);
  const state = JSON.parse(await zip.file('data/projects.json').async('string'));
  assert.equal(state.connections.length, 1); assert.equal(state.connections[0].passwordEnc, undefined, 'blob DPAPI não sai da máquina');
  assert.equal(zip.file('credenciais.json'), null);
  assert.deepEqual([m.sections.projects, m.sections.scripts, m.sections.timeEntries, m.sections.timeNotes, m.sections.documents, m.sections.coordinators, m.sections.projectContacts], [1, 1, 1, 1, 2, 1, 1]);
  assert.equal(ok(await api('GET', '/api/backup/info')).lastBackupFile, 'plano.gpbackup');
});

test('exportar protegido: AES-256-GCM (nada legível no arquivo); senhas das conexões só com senha do pacote', async () => {
  assert.equal((await api('POST', '/api/backup/export', { path: out('x.gpbackup'), includeCredentials: true })).json.code, 'PASSWORD_REQUIRED');
  assert.equal((await api('POST', '/api/backup/export', { path: out('x.gpbackup'), password: 'curta' })).json.code, 'WEAK_PASSWORD');
  const r = ok(await api('POST', '/api/backup/export', { path: out('cifrado.gpbackup'), password: PKG_PASS, includeCredentials: true }));
  assert.equal(r.encrypted, true); assert.equal(r.includesCredentials, true);
  const buf = fs.readFileSync(r.file);
  assert.ok(B.isEncrypted(buf));
  for (const s of [CANARY, SQL_PASS, 'Coordenadora', 'PK\u0003\u0004', PKG_PASS]) assert.ok(!buf.includes(Buffer.from(s)), `não pode aparecer: ${s}`);
});

test('validar: senha errada, arquivo corrompido, manifesto adulterado, versão incompatível e arquivo que não é backup são recusados', async () => {
  assert.equal(ok(await api('POST', '/api/backup/inspect', { path: out('cifrado.gpbackup') })).needsPassword, true);
  assert.equal((await api('POST', '/api/backup/inspect', { path: out('cifrado.gpbackup'), password: 'Senha-Errada-123' })).json.code, 'BAD_PASSWORD');
  const enc = fs.readFileSync(out('cifrado.gpbackup')); enc[enc.length - 40] ^= 0xff; fs.writeFileSync(out('cifrado-ruim.gpbackup'), enc);
  assert.equal((await api('POST', '/api/backup/inspect', { path: out('cifrado-ruim.gpbackup'), password: PKG_PASS })).json.code, 'BAD_PASSWORD');

  const zip = await JSZip.loadAsync(fs.readFileSync(out('plano.gpbackup')));
  zip.file('data/scripts/carga.sql', 'drop table x;'); // conteúdo trocado sem atualizar o manifesto
  fs.writeFileSync(out('adulterado.gpbackup'), await zip.generateAsync({ type: 'nodebuffer' }));
  const a = await api('POST', '/api/backup/inspect', { path: out('adulterado.gpbackup') });
  assert.equal(a.json.code, 'CORRUPTED'); assert.match(a.json.error, /não confere/);

  const z2 = await JSZip.loadAsync(fs.readFileSync(out('plano.gpbackup')));
  z2.file('../fora.txt', 'x');
  fs.writeFileSync(out('fuga.gpbackup'), await z2.generateAsync({ type: 'nodebuffer' }));
  assert.equal((await api('POST', '/api/backup/inspect', { path: out('fuga.gpbackup') })).json.code, 'CORRUPTED');

  const z3 = await JSZip.loadAsync(fs.readFileSync(out('plano.gpbackup')));
  const m = JSON.parse(await z3.file('manifest.json').async('string')); m.version = 2; z3.file('manifest.json', JSON.stringify(m));
  fs.writeFileSync(out('futuro.gpbackup'), await z3.generateAsync({ type: 'nodebuffer' }));
  const f = await api('POST', '/api/backup/inspect', { path: out('futuro.gpbackup') });
  assert.equal(f.json.code, 'INCOMPATIBLE'); assert.match(f.json.error, /versão 2/);

  const plain = fs.readFileSync(out('plano.gpbackup')); const cut = plain.subarray(0, Math.floor(plain.length / 2));
  fs.writeFileSync(out('truncado.gpbackup'), cut);
  assert.equal((await api('POST', '/api/backup/inspect', { path: out('truncado.gpbackup') })).json.code, 'CORRUPTED');
  fs.writeFileSync(out('texto.gpbackup'), 'não sou um backup');
  assert.equal((await api('POST', '/api/backup/inspect', { path: out('texto.gpbackup') })).json.code, 'NOT_BACKUP');
});

test('importar sem validar antes é recusado', async () => {
  assert.equal((await api('POST', '/api/backup/import', { token: 'qualquer' })).json.code, 'BACKUP_NOT_VALIDATED');
});

test('importar (substitui tudo): resumo antes, backup automático do estado atual, 0 diferenças, senhas protegidas de novo pela DPAPI', async () => {
  const expected = withoutSecrets(store.data);
  const expectedFiles = tree(DATA);
  // muda o estado depois do backup: a importação precisa voltar exatamente ao que foi exportado
  ok(await api('POST', '/api/projects', { name: 'Projeto Criado Depois' }));
  fs.writeFileSync(path.join(DATA, 'scripts', 'carga.sql'), 'alterado depois');
  const p = ok(await api('POST', '/api/backup/inspect', { path: out('cifrado.gpbackup'), password: PKG_PASS }));
  assert.equal(p.sections.projects, 1); assert.equal(p.encrypted, true); assert.equal(p.includesCredentials, true);
  assert.deepEqual(p.connectionsWithoutPassword, []);
  const r = ok(await api('POST', '/api/backup/import', { token: p.token }));
  assert.equal(r.comparison.diffs.length, 0);
  assert.ok(fs.existsSync(r.safetyBackup) && /antes-importacao-/.test(r.safetyBackup), 'backup automático do estado anterior');
  assert.deepEqual(withoutSecrets(store.data), expected, 'nenhuma perda de dados');
  const files = tree(DATA); delete files['projects.json']; delete expectedFiles['projects.json'];
  delete files['audit.log']; delete expectedFiles['audit.log']; // a importação registra a própria linha na auditoria
  assert.deepEqual(files, expectedFiles);
  const c = store.data.connections[0];
  assert.match(c.passwordEnc, /^AQAAANCMnd8BFdERjHoAwE/, 'senha protegida de novo com DPAPI');
  assert.equal(await unprotect(c.passwordEnc), SQL_PASS);
  assert.ok(!fs.readdirSync(tmp).some((n) => /^data\.(importando|anterior|falhou)-/.test(n)), 'sem pastas temporárias sobrando');
  // o backup automático restaura o estado de antes (inclusive o projeto criado depois)
  const s = ok(await api('POST', '/api/backup/inspect', { path: r.safetyBackup }));
  assert.equal(s.sections.projects, 2); assert.equal(s.localSnapshot, true);
});

test('caminhos de disco: preservados; os que não existem aparecem para trocar (o que está dentro é ajustado junto)', async () => {
  const miss = ok(await api('GET', '/api/backup/missing')).missingPaths;
  assert.ok(miss.includes('X:\\NaoExiste'), JSON.stringify(miss));
  assert.ok(!miss.includes('X:\\NaoExiste\\Cliente'), 'o de dentro some da lista (trocar o de cima corrige)');
  const novo = path.join(tmp, 'Projetos');
  fs.mkdirSync(path.join(novo, 'Cliente', 'bases'), { recursive: true });
  const r = ok(await api('POST', '/api/backup/remap', { from: 'X:\\NaoExiste', to: novo }));
  assert.equal(r.changed, 3);
  assert.deepEqual(r.missingPaths, []);
  assert.equal(store.project('p1').rootDir, path.join(novo, 'Cliente'));
  assert.equal(store.project('p1').bases[0].directory, path.join(novo, 'Cliente', 'bases'));
  assert.equal(store.data.workspace.root, novo);
  assert.equal(store.project('p1').description, 'desc', 'texto livre não é tocado');
});

test('falha depois de trocar as pastas: volta tudo ao estado anterior (rollback)', async () => {
  const before = JSON.stringify(withoutSecrets(store.data)); const beforeFiles = tree(DATA);
  const p = ok(await api('POST', '/api/backup/inspect', { path: out('plano.gpbackup') }));
  const real = B.compareAfterImport;
  B.compareAfterImport = () => ({ before: {}, after: {}, diffs: [{ section: 'simulada' }] });
  try {
    const r = await api('POST', '/api/backup/import', { token: p.token });
    assert.equal(r.status, 500); assert.equal(r.json.code, 'IMPORT_ROLLED_BACK');
  } finally { B.compareAfterImport = real; }
  assert.equal(JSON.stringify(withoutSecrets(store.data)), before);
  const after = tree(DATA); delete after['audit.log']; delete beforeFiles['audit.log'];
  assert.deepEqual(after, beforeFiles);
  assert.ok(!fs.readdirSync(tmp).some((n) => /^data\.(importando|anterior|falhou)-/.test(n)));
});

test('falha antes de trocar (ex.: DPAPI indisponível): nada muda e a pasta temporária é removida', async () => {
  const before = tree(DATA);
  const pkg = await B.readBackup(fs.readFileSync(out('cifrado.gpbackup')), PKG_PASS);
  await assert.rejects(B.stageAndSwap({ dataDir: DATA, pkg, protect: async () => { throw new Error('DPAPI indisponível'); } }), /nada foi alterado/);
  assert.deepEqual(tree(DATA), before);
  assert.ok(!fs.readdirSync(tmp).some((n) => /^data\.importando-/.test(n)));
});

test('máquina nova (pasta vazia): importa tudo; documento cujo caminho não existe vem para a pasta de dados; sem senha no pacote, a conexão pede a senha de novo', async () => {
  const machineB = path.join(tmp, 'maquinaB', 'data');
  fs.renameSync(path.join(EXT, 'Manual.pdf'), path.join(EXT, 'Manual-movido.pdf')); // na máquina B o caminho original não existe
  const pkg = await B.readBackup(fs.readFileSync(out('plano.gpbackup')));
  assert.deepEqual(B.preview(pkg).connectionsWithoutPassword, ['Banco Ficticio']);
  const { restoredDocs } = await B.stageAndSwap({ dataDir: machineB, pkg, protect: async () => assert.fail('sem senhas no pacote') });
  assert.deepEqual(restoredDocs, ['d1']);
  const s = new Store(machineB);
  assert.equal(s.project('p1').name, CANARY);
  assert.equal(s.data.timeEntries.length, 1); assert.equal(s.data.timeNotes[0].text, 'observação das horas');
  assert.equal(s.data.settings.warnDays, 5);
  const doc = s.data.documents.find((d) => d.id === 'd1');
  assert.equal(doc.source.path, path.join(machineB, 'documentos', 'd1', 'Manual.pdf'));
  assert.equal(fs.readFileSync(doc.source.path, 'utf8'), 'conteudo-do-manual');
  assert.equal(s.data.connections[0].passwordEnc, undefined);
  assert.deepEqual(B.connectionsWithoutPassword(s.data), ['Banco Ficticio']);
  const cmp = B.compareAfterImport(machineB, s.data, pkg);
  assert.deepEqual(cmp.diffs, []);
  assert.equal(fs.readFileSync(path.join(machineB, 'evidencias', 'horas', '2026-10', 'nota1_anexo.txt'), 'utf8'), 'anexo das horas');
  assert.ok(fs.existsSync(path.join(machineB, 'scripts', '.versoes', 'carga__20261001-120000.sql')));
});

test('versão do backup: manifesto traz versão do app e do esquema; preferências da tela vão e voltam; backup de versão mais nova é recusado', async () => {
  const prefs = { 'gp-theme': 'dark', 'gp-ui': '{"menuMin":true}', 'gp-lastdir': '{"x":"C:\\pasta"}' };
  ok(await api('POST', '/api/backup/export', { path: out('prefs.gpbackup'), prefs }));
  const zip = await JSZip.loadAsync(fs.readFileSync(out('prefs.gpbackup')));
  const m = JSON.parse(await zip.file('manifest.json').async('string'));
  assert.equal(m.appVersion, require('../package.json').version);
  assert.equal(m.schemaVersion, require('../src/migrations').SCHEMA_VERSION);
  const p = JSON.parse(await zip.file('preferencias.json').async('string'));
  assert.deepEqual(p, { 'gp-theme': 'dark', 'gp-ui': '{"menuMin":true}' }, 'últimas pastas (caminhos desta máquina) não vão');
  const info = ok(await api('GET', '/api/backup/info'));
  assert.equal(info.lastBackupAppVersion, require('../package.json').version);

  // backup gerado por uma versão mais nova (esquema maior): recusado com mensagem clara
  const state = JSON.parse(await zip.file('data/projects.json').async('string'));
  state.schemaVersion = 99;
  const buf = Buffer.from(JSON.stringify(state, null, 2));
  zip.file('data/projects.json', buf);
  const f = m.files.find((x) => x.path === 'data/projects.json'); f.size = buf.length; f.sha256 = require('crypto').createHash('sha256').update(buf).digest('hex');
  zip.file('manifest.json', JSON.stringify(m));
  fs.writeFileSync(out('futuro-esquema.gpbackup'), await zip.generateAsync({ type: 'nodebuffer' }));
  const r = await api('POST', '/api/backup/inspect', { path: out('futuro-esquema.gpbackup') });
  assert.equal(r.json.code, 'INCOMPATIBLE'); assert.match(r.json.error, /versão mais nova/);
});

test('backup de versão anterior (sem esquema): importa e aplica as migrações; preferências voltam para a tela', async () => {
  const zip = await JSZip.loadAsync(fs.readFileSync(out('prefs.gpbackup')));
  const m = JSON.parse(await zip.file('manifest.json').async('string'));
  const state = JSON.parse(await zip.file('data/projects.json').async('string'));
  delete state.schemaVersion; delete state.migrations;
  const buf = Buffer.from(JSON.stringify(state, null, 2));
  zip.file('data/projects.json', buf);
  const f = m.files.find((x) => x.path === 'data/projects.json'); f.size = buf.length; f.sha256 = require('crypto').createHash('sha256').update(buf).digest('hex');
  zip.file('manifest.json', JSON.stringify(m));
  fs.writeFileSync(out('antigo.gpbackup'), await zip.generateAsync({ type: 'nodebuffer' }));
  const p = ok(await api('POST', '/api/backup/inspect', { path: out('antigo.gpbackup') }));
  assert.equal(p.schemaVersion, 0); assert.deepEqual(p.migrationsNeeded, [1]);
  const r = ok(await api('POST', '/api/backup/import', { token: p.token }));
  assert.deepEqual(r.migrationsApplied, [1]);
  assert.equal(store.data.schemaVersion, 1);
  assert.deepEqual(r.prefs, { 'gp-theme': 'dark', 'gp-ui': '{"menuMin":true}' });
  assert.equal(r.comparison.diffs.length, 0);
});
