// Migrações de esquema: aplicadas só quando necessário, em ordem, uma vez, com cópia antes e histórico; dados mais novos não abrem.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/store');
const M = require('../src/migrations');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-mig-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const dirOf = (n, data) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); if (data) fs.writeFileSync(path.join(d, 'projects.json'), JSON.stringify(data)); return d; };
const OLD = { version: 1, settings: { warnDays: 3 }, projects: [{ id: 'p1', name: 'Projeto Ficticio', bases: [], deparas: [], milestones: [] }] };

test('instalação nova: nasce no esquema atual, sem migração a aplicar', () => {
  const s = new Store(dirOf('nova'));
  assert.equal(s.data.schemaVersion, M.SCHEMA_VERSION);
  assert.deepEqual(s.data.migrations, []);
  assert.equal(s.lastMigration, null);
});

test('dados antigos (sem esquema): migração aplicada uma vez, com cópia do arquivo antes e histórico; nenhum dado perdido', () => {
  const d = dirOf('antigo', OLD);
  const before = fs.readFileSync(path.join(d, 'projects.json'), 'utf8');
  const s = new Store(d, { appVersion: '9.9.9' });
  assert.deepEqual(s.lastMigration.applied, [1]);
  assert.equal(fs.readFileSync(s.lastMigration.backup, 'utf8'), before, 'cópia exata do arquivo antes de migrar');
  const saved = JSON.parse(fs.readFileSync(path.join(d, 'projects.json'), 'utf8'));
  assert.equal(saved.schemaVersion, 1);
  assert.deepEqual(saved.migrations.map((m) => [m.id, m.appVersion]), [[1, '9.9.9']]);
  assert.equal(saved.projects[0].name, 'Projeto Ficticio'); assert.equal(saved.settings.warnDays, 3);
  const again = new Store(d);
  assert.equal(again.lastMigration, null, 'segunda carga: nada a aplicar');
  assert.equal(again.data.migrations.length, 1);
});

test('versão nova com migração estrutural: aplica só as pendentes, em ordem, e registra cada uma', () => {
  const d = dirOf('estrutural', OLD);
  new Store(d); // esquema 1
  const list = [...M.MIGRATIONS,
    { id: 2, name: 'prioridade nos projetos', up: (data) => { for (const p of data.projects) if (p.priority === undefined) p.priority = 'normal'; } },
    { id: 3, name: 'renomeia campo', up: (data) => { for (const p of data.projects) { p.descricao = p.description ?? ''; } } }];
  const s = new Store(d, { migrations: list, appVersion: '2.0.0' });
  assert.deepEqual(s.lastMigration.applied, [2, 3]);
  assert.ok(fs.existsSync(path.join(d, 'projects.json.antes-esquema-2.bak')));
  assert.equal(s.data.projects[0].priority, 'normal');
  assert.deepEqual(s.data.migrations.map((m) => m.id), [1, 2, 3]);
  assert.equal(new Store(d, { migrations: list }).lastMigration, null);
});

test('migração que falha: lança e o arquivo fica exatamente como estava', () => {
  const d = dirOf('falha', OLD);
  const before = fs.readFileSync(path.join(d, 'projects.json'), 'utf8');
  const list = [...M.MIGRATIONS, { id: 2, name: 'quebra', up: () => { throw new Error('erro simulado'); } }];
  assert.throws(() => new Store(d, { migrations: list }), /erro simulado/);
  assert.equal(fs.readFileSync(path.join(d, 'projects.json'), 'utf8'), before);
});

test('dados de uma versão MAIS NOVA do aplicativo: não abre e não altera nada', () => {
  const d = dirOf('novo', { ...OLD, schemaVersion: M.SCHEMA_VERSION + 5 });
  const before = fs.readFileSync(path.join(d, 'projects.json'), 'utf8');
  assert.throws(() => new Store(d), (e) => e.code === 'DATA_TOO_NEW' && /versão mais nova/.test(e.message));
  assert.equal(fs.readFileSync(path.join(d, 'projects.json'), 'utf8'), before);
  assert.ok(!fs.readdirSync(d).some((f) => f.includes('corrompido')), 'não é tratado como arquivo corrompido');
});
