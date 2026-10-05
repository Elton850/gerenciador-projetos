// Atualização do aplicativo pelo canal (pasta): publicar (assinado), verificar (sem nova / disponível / bloqueada), baixar e conferir,
// trocar o código com o script real do PowerShell, preservar os dados e voltar à versão anterior se a nova não iniciar.
// Tudo em pastas temporárias, com um "aplicativo" falso (app.asar de texto e um .cmd no lugar do .exe).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-upd-'));
process.env.GP_PUBLISH_KEY_DIR = path.join(tmp, 'chave');
process.env.GP_WINDOW_STYLE = 'Hidden'; // o "aplicativo" falso não abre janela durante o teste
const C = require('../src/channel');
const U = require('../src/updates');
const { protect, unprotect } = require('../src/secrets');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const CANAL = path.join(tmp, 'canal');
const ELECTRON = '44.4.5';
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
function fakeApp(root, code, { exe = 'ok' } = {}) {
  const app = path.join(root, 'app');
  fs.mkdirSync(path.join(app, 'resources', 'app.asar.unpacked'), { recursive: true });
  fs.writeFileSync(path.join(app, 'resources', 'app.asar'), code);
  fs.writeFileSync(path.join(app, 'resources', 'app.asar.unpacked', 'nativo.node'), `binario ${code}`);
  // "executável": sinaliza que subiu (ou não) — o script de atualização espera esse sinal
  fs.writeFileSync(path.join(app, 'iniciar.cmd'), exe === 'ok' ? '@echo ok> "%GP_UPDATE_OK_FILE%"\r\n' : '@exit /b 0\r\n');
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'projects.json'), JSON.stringify({ projects: [{ id: 'p1', name: 'Dado do usuário' }] }));
  return { packaged: true, appDir: app, installRoot: root, exe: path.join(app, 'iniciar.cmd'), resourcesDir: path.join(app, 'resources'), updatesDir: path.join(root, 'atualizacoes') };
}
const publisher = fakeApp(path.join(tmp, 'principal'), 'CODIGO-1.1.0');
fs.writeFileSync(path.join(publisher.appDir, 'selftest.json'), '{}'); // não pode ir no pacote de instalação
fs.mkdirSync(CANAL);
const trust = (lay) => fs.copyFileSync(path.join(process.env.GP_PUBLISH_KEY_DIR, C.PUBKEY_FILE), path.join(lay.resourcesDir, C.PUBKEY_FILE));
const shortProcess = () => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], { stdio: 'ignore' });
const runUpdater = (opts) => new Promise((resolve) => U.launchUpdater({ ...opts, independent: false }).on('exit', resolve));

test('versões: comparação semver', () => {
  assert.equal(C.compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(C.compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(C.compareVersions('1.0.0', '1.0.0-beta.1'), 1);
  assert.equal(C.compareVersions('0.9.0', '1.0.0'), -1);
  assert.throws(() => C.compareVersions('x', '1.0.0'), { code: 'BAD_VERSION' });
});

test('publicar: pacote de atualização (só o código) + pacote de instalação, assinados; versão repetida ou menor é recusada', async () => {
  await assert.rejects(U.publishApp({ appDir: publisher.appDir, channelDir: path.join(tmp, 'nao-existe'), version: '1.1.0', electron: ELECTRON, schemaVersion: 1, protect, unprotect }), { code: 'CHANNEL_MISSING' });
  const e = await U.publishApp({ appDir: publisher.appDir, channelDir: CANAL, version: '1.1.0', electron: ELECTRON, schemaVersion: 1, notes: 'Tela nova', protect, unprotect });
  const ch = C.readChannel(CANAL);
  assert.equal(ch.app.version, '1.1.0'); assert.equal(ch.app.notes, 'Tela nova'); assert.ok(ch.appSignature);
  assert.equal(sha(path.join(CANAL, ...e.update.file.split('/'))), e.update.sha256);
  const keyFiles = fs.readdirSync(process.env.GP_PUBLISH_KEY_DIR);
  assert.ok(keyFiles.includes('chave-privada.dpapi'));
  assert.ok(!fs.readFileSync(path.join(process.env.GP_PUBLISH_KEY_DIR, 'chave-privada.dpapi'), 'utf8').includes('PRIVATE KEY'), 'chave privada só protegida pela DPAPI');
  const list = execFileSync(C.TAR, ['-t', '-f', path.join(CANAL, ...e.install.file.split('/'))], { encoding: 'utf8' }).split(/\r?\n/);
  assert.ok(list.includes('LEIA-ME.txt'));
  assert.ok(list.some((l) => l === 'app/resources/app.asar'));
  assert.ok(list.some((l) => l === 'app/resources/gp-publicacao.pub'), 'a chave pública viaja dentro do aplicativo');
  assert.ok(!list.some((l) => /selftest\.json|(^|\/)data\//.test(l)), 'nem dados nem resto de autoteste');
  for (const v of ['1.1.0', '1.0.9']) {
    await assert.rejects(U.publishApp({ appDir: publisher.appDir, channelDir: CANAL, version: v, electron: ELECTRON, schemaVersion: 1, protect, unprotect }), { code: 'VERSION_NOT_NEWER' });
  }
});

test('verificar: atualizado · versão nova disponível · bloqueios (desenvolvimento, sem chave, assinatura adulterada, outro Electron)', () => {
  const client = fakeApp(path.join(tmp, 'notebook-check'), 'CODIGO-1.0.0');
  const noKey = U.checkApp({ channelDir: CANAL, lay: client, appVersion: '1.0.0', electron: ELECTRON });
  assert.equal(noKey.canApply, false); assert.match(noKey.blocked, /chave de publicação/);
  trust(client);
  const same = U.checkApp({ channelDir: CANAL, lay: client, appVersion: '1.1.0', electron: ELECTRON });
  assert.equal(same.status, 'up-to-date'); assert.equal(same.available, false); assert.match(same.message, /atualizado/);
  const avail = U.checkApp({ channelDir: CANAL, lay: client, appVersion: '1.0.0', electron: ELECTRON });
  assert.deepEqual([avail.status, avail.latest, avail.canApply, avail.signature], ['available', '1.1.0', true, 'ok']);
  assert.match(avail.message, /nova versão da aplicação disponível/);
  assert.equal(U.checkApp({ channelDir: CANAL, lay: { packaged: false }, appVersion: '1.0.0', electron: ELECTRON }).canApply, false);
  const other = U.checkApp({ channelDir: CANAL, lay: client, appVersion: '1.0.0', electron: '45.0.0' });
  assert.equal(other.fullInstallRequired, true); assert.equal(other.canApply, false);
  const file = path.join(CANAL, 'canal.json'); const orig = fs.readFileSync(file, 'utf8');
  const bad = JSON.parse(orig); bad.app.notes = 'adulterado'; fs.writeFileSync(file, JSON.stringify(bad));
  const t = U.checkApp({ channelDir: CANAL, lay: client, appVersion: '1.0.0', electron: ELECTRON });
  fs.writeFileSync(file, orig);
  assert.equal(t.signature, 'invalid'); assert.equal(t.canApply, false);
  assert.equal(U.checkApp({ channelDir: '', lay: client, appVersion: '1.0.0' }).status, 'no-channel');
  assert.equal(U.checkApp({ channelDir: path.join(tmp, 'sumiu'), lay: client, appVersion: '1.0.0' }).status, 'unreachable');
});

test('pacote corrompido no canal: recusado pelo SHA-256; a instalação atual fica intacta', async () => {
  const client = fakeApp(path.join(tmp, 'notebook-corrompido'), 'CODIGO-1.0.0'); trust(client);
  const canal2 = path.join(tmp, 'canal-corrompido'); fs.cpSync(CANAL, canal2, { recursive: true });
  const f = path.join(canal2, ...C.readChannel(canal2).app.update.file.split('/'));
  const b = fs.readFileSync(f); b[Math.floor(b.length / 2)] ^= 0xff; fs.writeFileSync(f, b);
  await assert.rejects(U.prepareUpdate({ channelDir: canal2, lay: client, appVersion: '1.0.0', electron: ELECTRON }), { code: 'PACKAGE_CORRUPTED' });
  assert.equal(fs.readFileSync(path.join(client.resourcesDir, 'app.asar'), 'utf8'), 'CODIGO-1.0.0');
  assert.ok(!fs.existsSync(path.join(client.appDir, 'resources.nova')));
});

test('atualizar: troca só o código, reabre, dados intactos, versão anterior guardada; resultado mostrado uma vez', async () => {
  const client = fakeApp(path.join(tmp, 'notebook'), 'CODIGO-1.0.0'); trust(client);
  const dataBefore = sha(path.join(client.installRoot, 'data', 'projects.json'));
  const st = await U.prepareUpdate({ channelDir: CANAL, lay: client, appVersion: '1.0.0', electron: ELECTRON });
  assert.equal(st.version, '1.1.0');
  assert.equal(fs.readFileSync(path.join(client.appDir, 'resources.nova', 'app.asar'), 'utf8'), 'CODIGO-1.1.0');
  assert.equal(fs.readFileSync(path.join(client.resourcesDir, 'app.asar'), 'utf8'), 'CODIGO-1.0.0', 'nada muda antes de o app fechar');
  const running = shortProcess();
  const code = await runUpdater({ lay: client, pid: running.pid, from: '1.0.0', version: '1.1.0', healthSeconds: 20 });
  assert.equal(code, 0);
  assert.equal(fs.readFileSync(path.join(client.resourcesDir, 'app.asar'), 'utf8'), 'CODIGO-1.1.0');
  assert.equal(fs.readFileSync(path.join(client.resourcesDir, 'app.asar.unpacked', 'nativo.node'), 'utf8'), 'binario CODIGO-1.1.0');
  assert.equal(fs.readFileSync(path.join(client.appDir, 'resources.anterior', 'app.asar'), 'utf8'), 'CODIGO-1.0.0');
  assert.equal(sha(path.join(client.installRoot, 'data', 'projects.json')), dataBefore, 'dados do usuário intactos');
  const r = U.takeResult(client);
  assert.deepEqual([r.status, r.from, r.version], ['ok', '1.0.0', '1.1.0']);
  assert.equal(U.takeResult(client), null, 'mostrado uma vez');
});

test('versão nova não inicia: volta sozinha para a anterior e reabre', async () => {
  const client = fakeApp(path.join(tmp, 'notebook-falha'), 'CODIGO-1.0.0', { exe: 'nao-sobe' }); trust(client);
  await U.prepareUpdate({ channelDir: CANAL, lay: client, appVersion: '1.0.0', electron: ELECTRON });
  const running = shortProcess();
  const code = await runUpdater({ lay: client, pid: running.pid, from: '1.0.0', version: '1.1.0', healthSeconds: 3 });
  assert.equal(code, 2);
  assert.equal(fs.readFileSync(path.join(client.resourcesDir, 'app.asar'), 'utf8'), 'CODIGO-1.0.0', 'código anterior de volta');
  const failed = fs.readdirSync(client.appDir).find((f) => f.startsWith('resources.falhou-'));
  assert.ok(failed); assert.equal(fs.readFileSync(path.join(client.appDir, failed, 'app.asar'), 'utf8'), 'CODIGO-1.1.0');
  assert.equal(U.takeResult(client).status, 'rolled_back');
});

test('enquanto o app não fecha, nada é trocado', async () => {
  const client = fakeApp(path.join(tmp, 'notebook-preso'), 'CODIGO-1.0.0'); trust(client);
  await U.prepareUpdate({ channelDir: CANAL, lay: client, appVersion: '1.0.0', electron: ELECTRON });
  // processo que não termina dentro da espera do script → mata depois
  const stuck = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
  const r = U.launchUpdater({ lay: client, pid: stuck.pid, from: '1.0.0', version: '1.1.0', independent: false });
  // encurta a espera: encerra o script depois de garantir que ele está aguardando
  await new Promise((res) => setTimeout(res, 3000));
  r.kill(); stuck.kill();
  assert.equal(fs.readFileSync(path.join(client.resourcesDir, 'app.asar'), 'utf8'), 'CODIGO-1.0.0');
});

test('início independente (como o app real): o processo que pede a atualização fecha e o script continua, troca e reabre', async () => {
  const client = fakeApp(path.join(tmp, 'notebook-independente'), 'CODIGO-1.0.0'); trust(client);
  await U.prepareUpdate({ channelDir: CANAL, lay: client, appVersion: '1.0.0', electron: ELECTRON });
  const code = `const U=require(${JSON.stringify(path.join(__dirname, '..', 'src', 'updates.js'))});` +
    `U.launchUpdater({ lay: ${JSON.stringify(client)}, pid: process.pid, from: '1.0.0', version: '1.1.0', healthSeconds: 20 }).then(() => process.exit(0));`;
  const requester = spawn(process.execPath, ['-e', code], { stdio: 'ignore' });
  await new Promise((res) => requester.on('exit', res));
  const result = path.join(client.updatesDir, 'resultado.json');
  for (let i = 0; i < 120 && !fs.existsSync(result); i++) await new Promise((res) => setTimeout(res, 500));
  assert.equal(JSON.parse(fs.readFileSync(result, 'utf8')).status, 'ok');
  assert.equal(fs.readFileSync(path.join(client.resourcesDir, 'app.asar'), 'utf8'), 'CODIGO-1.1.0');
});
