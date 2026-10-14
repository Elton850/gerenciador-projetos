// Rotas de Atualizações (aplicativo) e Sincronização (configurações compartilháveis). Regras em src/updates.js e src/config-sync.js.
//   GET  /api/updates/status         versão instalada, esquema de dados/migrações, canal, resultado da última atualização
//   PUT  /api/updates/channel        { path? | clear } escolhe (seletor do Windows) ou limpa a pasta de publicação desta instalação
//   POST /api/updates/check          consulta o canal: versão disponível + configurações novas (nada é baixado)
//   POST /api/updates/apply          backup automático → prepara a versão nova → fecha, troca e reabre (script fixo)
//   POST /api/updates/publish        { notes, password, createKey? } publica no canal a versão INSTALADA (só no aplicativo empacotado),
//                                    assinada com a chave da pasta (senha); pasta sem chave → 409 KEY_MISSING (createKey cria)
//   POST /api/updates/trust-key      { password } passa a confiar na chave da pasta (versão assinada com chave nova)
//   POST /api/config-sync/check      o que mudaria aqui · POST /api/config-sync/apply { revision } · POST /api/config-sync/publish
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const U = require('./updates');
const C = require('./channel');
const CS = require('./config-sync');
const B = require('./backup');
const { pickFolder } = require('./dialogs');
const { httpError, str } = require('./util');

function mount(app, { store, audit, dataDir, unprotect, appVersion, backupsDir, onQuit = () => {}, lay = U.layout() }) {
  const backups = backupsDir || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'GerenciadorProjetos', 'backups');
  const electron = process.versions.electron || null;
  const channel = () => store.data.settings?.updateChannel || '';
  let lastResult = U.takeResult(lay); // resultado da atualização que acabou de acontecer (mostrado uma vez)

  // Cópia de segurança desta máquina antes de mexer (as senhas DPAPI seguem valendo aqui).
  async function snapshot(prefix) {
    fs.mkdirSync(backups, { recursive: true });
    const file = path.join(backups, `${prefix}-${B.stamp()}.gpbackup`);
    const out = await B.createBackup({ dataDir, state: store.data, localSnapshot: true, unprotect, appVersion });
    fs.writeFileSync(file, out.buffer);
    return file;
  }

  app.get('/api/updates/status', (req, res) => {
    const r = lastResult; lastResult = null;
    res.json({ appVersion, electron, packaged: lay.packaged, schemaVersion: store.data.schemaVersion ?? null, migrations: store.data.migrations || [],
      channel: channel(), channelExists: !!channel() && fs.existsSync(channel()), configSync: store.data.settings?.configSync ? { revision: store.data.settings.configSync.revision, appliedAt: store.data.settings.configSync.appliedAt } : null,
      lastResult: r, trustedKey: !!U.trustedKey(lay), channelKey: C.channelKeyInfo(channel()) ? { keyId: C.channelKeyInfo(channel()).keyId } : null });
  });
  // Senha da chave de publicação: só usada em memória (nunca gravada, auditada nem devolvida).
  const password = (req) => String(req.body?.password ?? '').slice(0, 200);

  app.put('/api/updates/channel', async (req, res) => {
    let dir = str(req.body?.path, 600);
    if (req.body?.clear) dir = '';
    else if (!dir) { dir = await pickFolder({ title: 'Pasta de publicação (canal de atualizações e configurações)', start: channel() }); if (!dir) return res.json({ canceled: true }); }
    if (dir && (!path.isAbsolute(dir) || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory())) throw httpError(400, 'Pasta não encontrada.');
    store.data.settings = { ...(store.data.settings || {}), updateChannel: dir };
    store.save();
    audit.log({ action: 'canal-atualizacoes-definido', definido: !!dir });
    res.json({ channel: dir });
  });

  app.post('/api/updates/check', async (req, res) => {
    const appInfo = U.checkApp({ channelDir: channel(), lay, appVersion, electron });
    let configs = null;
    if (channel() && fs.existsSync(channel())) {
      try {
        const pkg = await CS.readPackage(channel(), { schemaVersion: store.schemaVersion });
        configs = pkg ? { ...(await CS.diffConfigs({ dataDir, state: store.data, pkg })), status: 'ok' } : { status: 'none', message: 'Nenhuma configuração publicada ainda nesta pasta.' };
      } catch (e) { configs = { status: 'error', code: e.code, message: e.message }; }
    }
    res.json({ app: appInfo, configs });
  });

  app.post('/api/updates/apply', async (req, res) => {
    const safety = await snapshot(`antes-atualizacao-${appVersion}`);
    const staged = await U.prepareUpdate({ channelDir: channel(), lay, appVersion, electron });
    audit.log({ action: 'atualizacao-iniciada', de: appVersion, para: staged.version, copiaDeSeguranca: path.basename(safety) });
    await U.launchUpdater({ lay, from: appVersion, version: staged.version });
    res.json({ restarting: true, version: staged.version, safetyBackup: safety });
    setTimeout(onQuit, 400); // o script espera este processo terminar para trocar os arquivos
  });

  app.post('/api/updates/publish', async (req, res) => {
    if (!lay.packaged) throw httpError(400, 'Publicar só pelo aplicativo instalado (ou pelo comando npm run publicar no computador de desenvolvimento).', { code: 'NOT_PACKAGED' });
    const entry = await U.publishApp({ appDir: lay.appDir, channelDir: channel(), version: appVersion, electron, schemaVersion: store.schemaVersion, notes: str(req.body?.notes, 2000),
      password: password(req), createKey: req.body?.createKey === true });
    audit.log({ action: 'versao-publicada', versao: entry.version, chave: entry.keyId });
    res.json(entry);
  });

  app.post('/api/updates/trust-key', (req, res) => {
    const r = U.trustChannelKey({ channelDir: channel(), lay, password: password(req) });
    audit.log({ action: 'chave-publicacao-confiada', chave: r.keyId });
    res.json(r);
  });

  app.post('/api/config-sync/publish', async (req, res) => {
    const r = await CS.publishConfigs({ dataDir, state: store.data, channelDir: channel(), appVersion, schemaVersion: store.schemaVersion });
    // quem publica já está igual ao que publicou: é a base para perceber, depois, o que mudar aqui ou na origem
    store.data.settings = { ...(store.data.settings || {}), configSync: { revision: r.revision, appliedAt: new Date().toISOString(), hashes: r.hashes } };
    store.save();
    audit.log({ action: 'configuracoes-publicadas', revisao: r.revision });
    res.json({ revision: r.revision, counts: r.counts });
  });

  app.post('/api/config-sync/check', async (req, res) => {
    if (!channel()) throw httpError(400, 'Escolha a pasta de publicação.', { code: 'CHANNEL_MISSING' });
    const pkg = await CS.readPackage(channel(), { schemaVersion: store.schemaVersion });
    if (!pkg) return res.json({ status: 'none', message: 'Nenhuma configuração publicada ainda nesta pasta.' });
    res.json({ status: 'ok', ...(await CS.diffConfigs({ dataDir, state: store.data, pkg })) });
  });

  app.post('/api/config-sync/apply', async (req, res) => {
    if (!channel()) throw httpError(400, 'Escolha a pasta de publicação.', { code: 'CHANNEL_MISSING' });
    const pkg = await CS.readPackage(channel(), { schemaVersion: store.schemaVersion });
    if (!pkg) throw httpError(404, 'Nenhuma configuração publicada.');
    if (Number(req.body?.revision) !== pkg.meta.revision) throw httpError(409, 'Saiu uma revisão mais nova das configurações; confira as alterações de novo.', { code: 'CONFIG_CHANGED' });
    const safety = await snapshot(`antes-sincronizacao-r${pkg.meta.revision}`);
    const { state, diff } = await CS.applyConfigs({ dataDir, state: store.data, pkg });
    store.data = state;
    store.save();
    audit.log({ action: 'configuracoes-sincronizadas', revisao: pkg.meta.revision, aplicadas: diff.toApply });
    res.json({ revision: pkg.meta.revision, applied: diff.changes.filter((c) => ['new', 'updated', 'conflict'].includes(c.kind)), kept: diff.changes.filter((c) => !['new', 'updated', 'conflict'].includes(c.kind)), safetyBackup: safety });
  });
}

module.exports = { mount };
