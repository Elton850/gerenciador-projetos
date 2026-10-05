const fs = require('fs');
const path = require('path');
const { applyDefaults } = require('./defaults');
const { needsChecklistMigration } = require('./cycles');

const EMPTY = () => ({ version: 1, settings: { warnDays: 7 }, projects: [] });

// Persistência em JSON com escrita atômica (arquivo temporário + rename) e cópia .bak.
class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'projects.json');
    fs.mkdirSync(dir, { recursive: true });
    this.data = this._load();
  }

  _load() {
    if (!fs.existsSync(this.file)) return applyDefaults(EMPTY());
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this._backupBeforeMigration(parsed);
      return applyDefaults({ ...EMPTY(), ...parsed, settings: { ...EMPTY().settings, ...(parsed.settings || {}) } });
    } catch (e) {
      const broken = `${this.file}.corrompido-${Date.now()}`;
      fs.copyFileSync(this.file, broken);
      throw new Error(`data/projects.json ilegível (cópia salva em ${broken}): ${e.message}`);
    }
  }

  // Migração "checklists por passo do ciclo": antes de o arquivo ser reescrito no modelo novo, guarda uma cópia do original (uma vez só;
  // nunca sobrescreve uma cópia que já existe). Com ela dá para voltar ao arquivo anterior à mudança.
  _backupBeforeMigration(parsed) {
    if (!needsChecklistMigration(parsed)) return;
    const bak = `${this.file}.antes-checklists-por-ciclo.bak`;
    if (!fs.existsSync(bak)) fs.copyFileSync(this.file, bak);
  }

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
