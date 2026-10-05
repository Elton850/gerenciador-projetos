// Rotas de Backup e Restauração (Configurações → Backup e Restauração). Regras em src/backup.js.
//   GET  /api/backup/info      último backup exportado e pastas usadas
//   POST /api/backup/export    { password?, includeCredentials?, path? }  → grava o .gpbackup (sem path: "Salvar como" do Windows)
//   POST /api/backup/inspect   { path?, password? } → valida o arquivo e devolve o resumo (sem path: seletor do Windows). Nada é gravado.
//   POST /api/backup/import    { token }  → backup automático do estado atual → substitui tudo → confere → (falhou? volta)
//   GET  /api/backup/missing   caminhos de disco cadastrados que não existem nesta máquina
//   POST /api/backup/remap     { from, to? } → troca o caminho (e o que estiver dentro dele) em todo o cadastro
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const B = require('./backup');
const { pickFile, pickSaveFile, pickFolder } = require('./dialogs');
const { httpError, str } = require('./util');

const MAX_BACKUP_BYTES = 1.5 * 1024 * 1024 * 1024;
const PENDING_TTL_MS = 30 * 60 * 1000;

function mount(app, { store, audit, dataDir, protect, unprotect, backupsDir, appVersion = '' }) {
  const backups = backupsDir || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'GerenciadorProjetos', 'backups');
  let pending = null; // pacote validado aguardando confirmação (app de um usuário só: um por vez)

  const checkPassword = (p) => {
    if (!p) return '';
    if (typeof p !== 'string' || p.length < 10 || p.length > 200) throw httpError(400, 'A senha do backup precisa ter de 10 a 200 caracteres.', { code: 'WEAK_PASSWORD' });
    return p;
  };
  const writeAtomic = (file, buf) => {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, file);
  };

  app.get('/api/backup/info', (req, res) => {
    const s = store.data.settings || {};
    res.json({ lastBackupAt: s.lastBackupAt || null, lastBackupFile: s.lastBackupFile || null, lastBackupAppVersion: s.lastBackupAppVersion || null,
      appVersion, schemaVersion: store.data.schemaVersion ?? null, dataDir, backupsDir: backups });
  });

  app.post('/api/backup/export', async (req, res) => {
    const password = checkPassword(req.body?.password);
    const includeCredentials = !!req.body?.includeCredentials;
    if (includeCredentials && !password) throw httpError(400, 'Para incluir as senhas das conexões, proteja o backup com senha.', { code: 'PASSWORD_REQUIRED' });
    const now = new Date();
    const name = `GerenciadorProjetos-Backup-${now.toISOString().slice(0, 10)}.gpbackup`;
    let file = str(req.body?.path, 600);
    if (!file) file = await pickSaveFile({ title: 'Salvar backup completo', fileName: name, filter: 'gpbackup' });
    if (!file) return res.json({ canceled: true });
    if (!path.isAbsolute(file)) throw httpError(400, 'Caminho inválido.');
    if (!/\.gpbackup$/i.test(file)) file += '.gpbackup';
    const out = await B.createBackup({ dataDir, state: store.data, password, includeCredentials, unprotect, appVersion, prefs: req.body?.prefs, now });
    writeAtomic(file, out.buffer);
    store.data.settings = { ...(store.data.settings || {}), lastBackupAt: now.toISOString(), lastBackupFile: path.basename(file), lastBackupAppVersion: appVersion };
    store.save();
    audit.log({ action: 'backup-exportado', protegido: !!password, senhasIncluidas: out.manifest.includesCredentials, arquivos: out.manifest.files.length });
    res.json({ file, size: out.buffer.length, encrypted: !!password, includesCredentials: out.manifest.includesCredentials, sections: out.manifest.sections, credentialProblems: out.credentialProblems.length });
  });

  app.post('/api/backup/inspect', async (req, res) => {
    let file = str(req.body?.path, 600);
    if (!file) file = await pickFile({ title: 'Selecione o arquivo de backup', filter: 'gpbackup' });
    if (!file) return res.json({ canceled: true });
    let st;
    try { st = fs.statSync(file); } catch { throw httpError(404, 'Arquivo não encontrado.'); }
    if (!st.isFile() || st.size > MAX_BACKUP_BYTES) throw httpError(400, 'Arquivo inválido ou grande demais para um backup.');
    const buf = fs.readFileSync(file);
    const pkg = await B.readBackup(buf, typeof req.body?.password === 'string' ? req.body.password : '');
    if (pkg.needsPassword) return res.json({ path: file, needsPassword: true });
    const token = crypto.randomBytes(16).toString('hex');
    pending = { token, pkg, file, at: Date.now() };
    res.json({ path: file, token, fileName: path.basename(file), ...B.preview(pkg) });
  });

  app.post('/api/backup/import', async (req, res) => {
    if (!pending || pending.token !== req.body?.token || Date.now() - pending.at > PENDING_TTL_MS) throw httpError(409, 'Selecione e valide o arquivo de backup de novo.', { code: 'BACKUP_NOT_VALIDATED' });
    const { pkg, file } = pending;
    pending = null;
    // 1. backup automático do estado atual (desta máquina: as senhas DPAPI continuam valendo aqui)
    fs.mkdirSync(backups, { recursive: true });
    const now = new Date();
    const safety = path.join(backups, `antes-importacao-${B.stamp(now)}.gpbackup`);
    const snap = await B.createBackup({ dataDir, state: store.data, localSnapshot: true, unprotect, appVersion, now });
    writeAtomic(safety, snap.buffer);
    // 2. monta, confere e troca as pastas
    const { previous, restoredDocs } = await B.stageAndSwap({ dataDir, pkg, protect, now });
    // 3. confere o que ficou no disco (antes de migrar) e recarrega (aplica migrações de esquema, se o backup for de versão anterior);
    //    qualquer falha volta ao estado anterior
    let check;
    try {
      check = B.compareAfterImport(dataDir, JSON.parse(fs.readFileSync(path.join(dataDir, 'projects.json'), 'utf8')), pkg);
      if (check.diffs.length) throw new Error(`${check.diffs.length} diferença(s) depois da importação`);
      store.reload();
    } catch (e) {
      B.rollbackImport(dataDir, previous);
      store.reload();
      throw httpError(500, `A importação foi desfeita e os dados anteriores foram mantidos (${e.message}).`, { code: 'IMPORT_ROLLED_BACK' });
    }
    if (previous) fs.rmSync(previous, { recursive: true, force: true });
    audit.log({ action: 'backup-importado', arquivo: path.basename(file), projetos: store.data.projects.length, copiaDeSeguranca: path.basename(safety) });
    res.json({ ok: true, safetyBackup: safety, comparison: check, restoredDocuments: restoredDocs.length, prefs: pkg.prefs || {},
      migrationsApplied: store.lastMigration?.applied || [],
      missingPaths: B.missingPaths(store.data), connectionsWithoutPassword: B.connectionsWithoutPassword(store.data) });
  });

  app.get('/api/backup/missing', (req, res) => res.json({ missingPaths: B.missingPaths(store.data) }));

  app.post('/api/backup/remap', async (req, res) => {
    const from = str(req.body?.from, 400);
    if (!from || !path.isAbsolute(from)) throw httpError(400, 'Informe o caminho a trocar.');
    let to = str(req.body?.to, 400);
    if (!to) to = await pickFolder({ title: `Nova pasta para: ${from}` });
    if (!to) return res.json({ canceled: true });
    if (!path.isAbsolute(to)) throw httpError(400, 'Caminho inválido.');
    const changed = B.remapPaths(store.data, from, to);
    store.save();
    audit.log({ action: 'caminhos-trocados', alteracoes: changed });
    res.json({ changed, missingPaths: B.missingPaths(store.data) });
  });
}

module.exports = { mount };
