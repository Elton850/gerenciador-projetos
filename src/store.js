const fs = require('fs');
const path = require('path');
const { applyDefaults } = require('./defaults');
const { needsChecklistMigration } = require('./cycles');
const M = require('./migrations');

const EMPTY = () => ({ version: 1, settings: { warnDays: 7 }, projects: [] });
const APP_VERSION = require('../package.json').version;

// Persistência em JSON com escrita atômica (arquivo temporário + rename) e cópia .bak.
// Na carga: applyDefaults (completa campos, idempotente) → migrações de esquema pendentes (src/migrations.js), com cópia do
// arquivo antes e gravação na hora. Dados de uma versão MAIS NOVA do aplicativo não são abertos (nada é sobrescrito).
class Store {
  constructor(dir, { migrations = M.MIGRATIONS, appVersion = APP_VERSION } = {}) {
    this.dir = dir;
    this.file = path.join(dir, 'projects.json');
    this.migrationList = migrations;
    this.appVersion = appVersion;
    this.lastMigration = null; // { applied: [ids], backup } da última carga que migrou
    fs.mkdirSync(dir, { recursive: true });
    this.data = this._load();
  }

  get schemaVersion() { return this.migrationList[this.migrationList.length - 1].id; }

  _load() {
    if (!fs.existsSync(this.file)) return { ...applyDefaults(EMPTY()), schemaVersion: this.schemaVersion, migrations: [] };
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (e) {
      const broken = `${this.file}.corrompido-${Date.now()}`;
      fs.copyFileSync(this.file, broken);
      throw new Error(`data/projects.json ilegível (cópia salva em ${broken}): ${e.message}`);
    }
    if (M.tooNew(parsed, this.schemaVersion)) {
      throw Object.assign(new Error(`Os dados foram gravados por uma versão mais nova do aplicativo (esquema ${M.currentSchema(parsed)}; esta versão conhece até o ${this.schemaVersion}). Atualize o aplicativo — nada foi alterado.`), { code: 'DATA_TOO_NEW' });
    }
    this._backupBeforeMigration(parsed);
    const data = applyDefaults({ ...EMPTY(), ...parsed, settings: { ...EMPTY().settings, ...(parsed.settings || {}) } });
    const todo = M.pending(data, this.migrationList);
    if (todo.length) {
      // cópia do arquivo como estava antes das migrações (uma por esquema de origem; nunca sobrescrita)
      const backup = `${this.file}.antes-esquema-${M.currentSchema(parsed) + 1}.bak`;
      if (!fs.existsSync(backup)) fs.copyFileSync(this.file, backup);
      const applied = M.runMigrations(data, { appVersion: this.appVersion, list: this.migrationList });
      this.data = data;
      this.save();
      this.lastMigration = { applied, backup };
    }
    return data;
  }

  // Migração "checklists por passo do ciclo": antes de o arquivo ser reescrito no modelo novo, guarda uma cópia do original (uma vez só;
  // nunca sobrescreve uma cópia que já existe). Com ela dá para voltar ao arquivo anterior à mudança.
  _backupBeforeMigration(parsed) {
    if (!needsChecklistMigration(parsed)) return;
    const bak = `${this.file}.antes-checklists-por-ciclo.bak`;
    if (!fs.existsSync(bak)) fs.copyFileSync(this.file, bak);
  }

  // Relê o arquivo (ex.: depois de importar um backup): mesma carga da inicialização, inclusive migrações.
  reload() { this.data = this._load(); return this.data; }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    if (fs.existsSync(this.file)) fs.copyFileSync(this.file, `${this.file}.bak`);
    fs.renameSync(tmp, this.file);
  }

  project(id) {
    return this.data.projects.find((p) => p.id === id) || null;
  }
}

module.exports = { Store };
