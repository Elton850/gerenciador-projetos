// Atualização do APLICATIVO (código) pelo canal de publicação (src/channel.js). Dados do usuário nunca entram nem são tocados.
//
// Instalação empacotada (Electron):  <raiz>\app\Gerenciador de Projetos.exe   ← runtime (muda só com versão nova do Electron)
//                                    <raiz>\app\resources\app.asar            ← CÓDIGO: é o que a atualização troca
//                                    <raiz>\data\                              ← DADOS do usuário (fora de app\; nunca tocados)
//                                    <raiz>\atualizacoes\                      ← pacotes baixados e resultado da última atualização
// Publicar (qualquer computador com a pasta do canal + a senha da chave): ZIP de app\resources (+ assinatura) e ZIP de instalação
//   completa → pasta do canal.
// Atualizar (outra máquina): confere assinatura e SHA-256 → extrai em app\resources.nova → confere de novo → fecha o app →
//   script fixo do PowerShell troca resources ↔ resources.nova (anterior guardada em resources.anterior) → abre a versão nova e espera
//   o sinal de que ela subiu; se não subir em 90 s, volta a anterior e abre de novo. Resultado em atualizacoes\resultado.json.
'use strict';
// Dentro do Electron o fs comum trata arquivos .asar como pastas; aqui eles são arquivos comuns (copiar, conferir, apagar).
const fs = (() => { try { return require('original-fs'); } catch { return require('fs'); } })();
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const C = require('./channel');
const { SYS } = require('./powershell');

const fail = C.fail;
const PACKAGE_FORMAT = 'GerenciadorProjetosPacote';

// Onde está esta instalação. main.js informa GP_APP_DIR quando roda empacotado; sem isso (node server.js / desenvolvimento) não há o
// que atualizar: a tela mostra a versão, mas o botão "Atualizar" fica indisponível.
function layout(env = process.env) {
  const appDir = env.GP_APP_DIR ? path.resolve(env.GP_APP_DIR) : null;
  if (!appDir) return { packaged: false };
  const installRoot = path.dirname(appDir);
  return {
    packaged: true, appDir, installRoot,
    exe: env.GP_APP_EXE || process.execPath,
    resourcesDir: path.join(appDir, 'resources'),
    updatesDir: env.GP_UPDATES_DIR || path.join(installRoot, 'atualizacoes'),
  };
}

function trustedKey(lay) {
  if (!lay.packaged) return null;
  try { return fs.readFileSync(path.join(lay.resourcesDir, C.PUBKEY_FILE), 'utf8'); } catch { return null; }
}

const readme = (folder, version) => [
  `Gerenciador de Projetos ${version} — pacote de instalação`,
  '',
  '1. Extraia este ZIP numa pasta sua (ex.: C:\\GerenciadorProjetos). Não precisa de Node, Git nem instalação.',
  `2. Abra ${folder}\\Gerenciador de Projetos.exe (crie um atalho na área de trabalho, se quiser).`,
  '   O aplicativo abre VAZIO: os dados ficam na pasta "data", criada ao lado da pasta do aplicativo.',
  '3. Para trazer seus dados de outra máquina: Configurações → Backup e Restauração → Importar backup.',
  '4. Para receber as próximas versões: Configurações → Atualizações → escolha a pasta de publicação (a mesma pasta compartilhada',
  '   onde este pacote foi publicado). Atualizar troca só o código; seus dados não são tocados.',
  '',
  'Windows pode avisar "editor desconhecido" na primeira vez (o executável não tem certificado de assinatura de código).',
].join('\r\n');

// Publica a versão instalada em appDir no canal. version/electron/schemaVersion = da instalação que está sendo publicada.
// Assina com a chave da pasta do canal (senha). Pasta sem chave → 409 KEY_MISSING; com createKey: true, cria a chave com essa senha.
async function publishApp({ appDir, channelDir, version, electron, schemaVersion, notes = '', password, createKey = false, now = new Date() }) {
  if (!channelDir || !fs.existsSync(channelDir)) throw fail('CHANNEL_MISSING', 'Escolha a pasta de publicação (canal) antes de publicar.');
  const resourcesDir = path.join(appDir, 'resources');
  if (!fs.existsSync(path.join(resourcesDir, 'app.asar'))) throw fail('NOT_PACKAGED', 'Não há aplicativo gerado para publicar (falta resources\\app.asar). Gere o aplicativo antes (npm run build:desktop).');
  if (!C.parseVersion(version)) throw fail('BAD_VERSION', `Versão inválida: ${version}`);
  const ch = C.readChannel(channelDir) || {};
  if (ch.app?.version && C.compareVersions(version, ch.app.version) <= 0) {
    throw fail('VERSION_NOT_NEWER', `O canal já tem a versão ${ch.app.version}. Aumente a versão em package.json (ex.: npm version patch), gere o aplicativo e publique de novo.`);
  }
  const hasKey = !!C.readKeyFile(channelDir);
  if (!hasKey && !createKey) throw fail('KEY_MISSING', 'A pasta de publicação ainda não tem chave de publicação: crie uma (com senha) para publicar.', 409);
  const keys = hasKey ? C.unlockChannelKey(channelDir, password) : C.createChannelKey(channelDir, password, now);
  // A chave pública viaja dentro do aplicativo: é nela que as outras instalações confiam.
  C.writeAtomic(path.join(resourcesDir, C.PUBKEY_FILE), keys.pubPem);
  const appAsarSha256 = await C.sha256File(path.join(resourcesDir, 'app.asar'));
  C.writeAtomic(path.join(resourcesDir, 'gp-pacote.json'), JSON.stringify({ format: PACKAGE_FORMAT, version, electron, schemaVersion, appAsarSha256, keyId: keys.keyId }, null, 2));

  const updRel = `versoes/GerenciadorProjetos-${version}.gpupdate`;
  const insRel = `versoes/GerenciadorProjetos-${version}-instalacao.zip`;
  await C.zipEntries(path.join(channelDir, ...updRel.split('/')), [{ cwd: resourcesDir, name: '.' }]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-publicar-'));
  try {
    const folder = path.basename(appDir);
    fs.writeFileSync(path.join(tmp, 'LEIA-ME.txt'), readme(folder, version));
    await C.zipEntries(path.join(channelDir, ...insRel.split('/')), [{ cwd: tmp, name: 'LEIA-ME.txt' }, { cwd: path.dirname(appDir), name: folder }],
      { exclude: [`${folder}/selftest.json`, `${folder}/resources.anterior`, `${folder}/resources.nova`, `${folder}/resources.falhou-*`] });
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  const fileInfo = async (rel) => { const f = path.join(channelDir, ...rel.split('/')); return { file: rel, size: fs.statSync(f).size, sha256: await C.sha256File(f) }; };
  const entry = { version, publishedAt: now.toISOString(), notes: String(notes || '').slice(0, 2000), electron, schemaVersion, keyId: keys.keyId,
    update: await fileInfo(updRel), install: await fileInfo(insRel) };
  const history = [{ version: entry.version, publishedAt: entry.publishedAt, notes: entry.notes }, ...(ch.appHistory || [])].slice(0, 30);
  C.writeChannel(channelDir, { ...ch, app: entry, appSignature: C.sign(entry, keys.privateKey), appHistory: history });
  pruneVersions(channelDir, version);
  return entry;
}

// Mantém no canal só as 3 últimas atualizações e o pacote de instalação mais novo (os de instalação são grandes).
function pruneVersions(channelDir, latest) {
  const dir = path.join(channelDir, 'versoes');
  const files = fs.readdirSync(dir);
  const ver = (f) => (/^GerenciadorProjetos-(.+?)(-instalacao\.zip|\.gpupdate)$/.exec(f) || [])[1];
  const sorted = (suffix) => files.filter((f) => f.endsWith(suffix) && C.parseVersion(ver(f))).sort((a, b) => C.compareVersions(ver(b), ver(a)));
  for (const f of sorted('.gpupdate').slice(3)) fs.rmSync(path.join(dir, f), { force: true });
  for (const f of sorted('-instalacao.zip').filter((f) => ver(f) !== latest)) fs.rmSync(path.join(dir, f), { force: true });
}

// Consulta (não baixa nada).
function checkApp({ channelDir, lay = layout(), appVersion, electron }) {
  const base = { installed: appVersion, packaged: lay.packaged, configured: !!channelDir };
  if (!channelDir) return { ...base, status: 'no-channel', message: 'Escolha a pasta de publicação para verificar atualizações.' };
  if (!fs.existsSync(channelDir)) return { ...base, status: 'unreachable', message: 'A pasta de publicação não foi encontrada nesta máquina (está sincronizada/conectada?).' };
  const ch = C.readChannel(channelDir);
  const e = ch?.app;
  if (!e) return { ...base, status: 'up-to-date', available: false, message: 'Nenhuma versão publicada ainda nesta pasta.' };
  const pem = trustedKey(lay);
  let signature = !pem ? 'no-key' : (e.keyId === C.keyIdOf(pem) && C.verify(e, ch.appSignature, pem) ? 'ok' : 'invalid');
  // Assinada pela chave da pasta, que esta instalação ainda não conhece (chave nova): dá para passar a confiar nela com a senha.
  const k = signature === 'ok' ? null : C.channelKeyInfo(channelDir);
  if (k && k.keyId === e.keyId && C.verify(e, ch.appSignature, k.pubPem)) signature = 'new-key';
  const available = C.compareVersions(e.version, appVersion) > 0;
  const fullInstallRequired = available && !!e.electron && !!electron && e.electron !== electron;
  const out = { ...base, latest: e.version, notes: e.notes, publishedAt: e.publishedAt, available, signature, fullInstallRequired,
    installPackage: e.install ? path.join(channelDir, ...e.install.file.split('/')) : null, history: (ch.appHistory || []).slice(0, 10) };
  if (!available) return { ...out, status: 'up-to-date', message: `O aplicativo está atualizado (versão ${appVersion}).` };
  let blocked = null;
  if (!lay.packaged) blocked = 'Atualização automática só no aplicativo instalado (este é o modo de desenvolvimento).';
  else if (signature === 'new-key') blocked = 'Esta versão foi assinada com a chave de publicação da pasta, que esta instalação ainda não conhece. Informe a senha da chave para passar a confiar nela.';
  else if (signature === 'no-key') blocked = 'Esta instalação não tem a chave de publicação: instale uma vez pelo pacote de instalação do canal.';
  else if (signature === 'invalid') blocked = 'A assinatura da versão publicada NÃO confere com a chave desta instalação. Atualização recusada.';
  else if (fullInstallRequired) blocked = `Esta versão usa outro runtime (Electron ${e.electron}); instale pelo pacote de instalação completo. Seus dados ficam na pasta "data" e não são tocados.`;
  return { ...out, status: 'available', canApply: !blocked, blocked, canTrust: lay.packaged && signature === 'new-key', message: `Existe uma nova versão da aplicação disponível: ${e.version}.` };
}

// Passa a confiar na chave da pasta do canal (a senha prova quem é o dono da chave). Só a parte pública é gravada na instalação.
function trustChannelKey({ channelDir, lay = layout(), password }) {
  if (!lay.packaged) throw fail('NOT_PACKAGED', 'Confiar na chave só no aplicativo instalado.');
  if (!channelDir || !fs.existsSync(channelDir)) throw fail('CHANNEL_MISSING', 'Escolha a pasta de publicação.');
  const keys = C.unlockChannelKey(channelDir, password);
  C.writeAtomic(path.join(lay.resourcesDir, C.PUBKEY_FILE), keys.pubPem);
  return { keyId: keys.keyId };
}

// Baixa, confere e prepara a pasta resources.nova (o aplicativo continua funcionando até a troca).
async function prepareUpdate({ channelDir, lay = layout(), appVersion, electron }) {
  const c = checkApp({ channelDir, lay, appVersion, electron });
  if (!c.available) throw fail('NO_UPDATE', c.message);
  if (!c.canApply) throw fail('UPDATE_BLOCKED', c.blocked);
  const e = C.readChannel(channelDir).app;
  fs.mkdirSync(lay.updatesDir, { recursive: true });
  const local = path.join(lay.updatesDir, path.basename(e.update.file));
  const nova = path.join(lay.appDir, 'resources.nova');
  try {
    C.copyAtomic(C.channelPath(channelDir, e.update.file), local);
    if ((await C.sha256File(local)) !== e.update.sha256) throw fail('PACKAGE_CORRUPTED', 'O pacote baixado não confere (SHA-256). Nada foi alterado; tente de novo.');
    fs.rmSync(nova, { recursive: true, force: true });
    await C.unzipTo(local, nova);
    let pk;
    try { pk = JSON.parse(fs.readFileSync(path.join(nova, 'gp-pacote.json'), 'utf8')); } catch { throw fail('PACKAGE_CORRUPTED', 'O pacote não tem a identificação da versão.'); }
    if (pk.format !== PACKAGE_FORMAT || pk.version !== e.version) throw fail('PACKAGE_CORRUPTED', 'O pacote não é da versão anunciada no canal.');
    if (!fs.existsSync(path.join(nova, 'app.asar')) || (await C.sha256File(path.join(nova, 'app.asar'))) !== pk.appAsarSha256) throw fail('PACKAGE_CORRUPTED', 'O código do pacote não confere (SHA-256).');
    C.writeAtomic(path.join(nova, C.PUBKEY_FILE), trustedKey(lay)); // a confiança continua na chave que já estava instalada
    return { version: e.version, from: appVersion, staged: nova };
  } catch (err) {
    fs.rmSync(nova, { recursive: true, force: true });
    throw err;
  } finally { fs.rmSync(local, { force: true }); }
}

// Script FIXO (dados só por variáveis de ambiente). Espera o app fechar, troca as pastas, abre a versão nova e confere se subiu.
const UPDATER = `
$ErrorActionPreference = 'Stop'
$app = $env:GP_APPDIR; $res = Join-Path $app 'resources'; $nova = Join-Path $app 'resources.nova'; $ant = Join-Path $app 'resources.anterior'
$out = $env:GP_RESULT; $okFile = $env:GP_OKFILE
function Save($status, $msg) {
  $o = [ordered]@{ status = $status; version = $env:GP_VERSION; from = $env:GP_FROM; message = $msg; at = (Get-Date).ToString('o') }
  [IO.File]::WriteAllText($out, ($o | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
}
function Retry([scriptblock]$b) { for ($i = 0; $i -lt 25; $i++) { try { & $b; return } catch { Start-Sleep -Milliseconds 400 } }; & $b }
function Launch([switch]$PassThru) { $a = @{ FilePath = $env:GP_EXE; WorkingDirectory = $app }; if ($env:GP_WINDOW_STYLE) { $a.WindowStyle = $env:GP_WINDOW_STYLE }; if ($PassThru) { $a.PassThru = $true }; Start-Process @a }
function StartApp { Remove-Item env:GP_UPDATE_OK_FILE -ErrorAction SilentlyContinue; Launch | Out-Null }
try { Wait-Process -Id ([int]$env:GP_PID) -Timeout 60 -ErrorAction SilentlyContinue } catch {}
if (Get-Process -Id ([int]$env:GP_PID) -ErrorAction SilentlyContinue) { Save 'failed' 'O aplicativo não fechou a tempo; nada foi alterado.'; exit 1 }
Start-Sleep -Milliseconds 800
try {
  if (Test-Path -LiteralPath $ant) { Retry { Remove-Item -LiteralPath $ant -Recurse -Force } }
  Retry { Rename-Item -LiteralPath $res -NewName 'resources.anterior' }
  try { Retry { Rename-Item -LiteralPath $nova -NewName 'resources' } } catch { Rename-Item -LiteralPath $ant -NewName 'resources'; throw }
} catch {
  Save 'failed' ("Não foi possível trocar os arquivos (" + $_.Exception.Message + "). A versão anterior foi mantida.")
  StartApp; exit 1
}
if (Test-Path -LiteralPath $okFile) { Remove-Item -LiteralPath $okFile -Force }
$env:GP_UPDATE_OK_FILE = $okFile
$p = Launch -PassThru
$deadline = (Get-Date).AddSeconds([int]$env:GP_HEALTH_SECONDS)
while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $okFile)) { Start-Sleep -Milliseconds 500 }
if (Test-Path -LiteralPath $okFile) { Remove-Item -LiteralPath $okFile -Force; Save 'ok' ''; exit 0 }
try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {}
Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $env:GP_EXE } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
Retry { Rename-Item -LiteralPath $res -NewName ('resources.falhou-' + (Get-Date -Format 'yyyyMMddHHmmss')) }
Retry { Rename-Item -LiteralPath $ant -NewName 'resources' }
Save 'rolled_back' 'A nova versão não iniciou; a versão anterior foi restaurada.'
StartApp; exit 2
`;

// Inicia o script de atualização. independent=true (uso real): um PowerShell curto, preso a este processo, abre o script com
// Start-Process — assim ele fica independente e sobrevive ao fechamento do aplicativo (um processo "detached" do Node não roda o
// PowerShell no Windows). Resolve quando o script já foi iniciado. independent=false (testes): roda o script como filho e devolve o processo.
const LAUNCHER = "Start-Process -FilePath $env:GP_PS -WindowStyle Hidden -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',$env:GP_UPDATER_B64)";
function launchUpdater({ lay = layout(), pid = process.pid, from, version, healthSeconds = 90, independent = true }) {
  fs.mkdirSync(lay.updatesDir, { recursive: true });
  const result = path.join(lay.updatesDir, 'resultado.json');
  fs.rmSync(result, { force: true });
  const encoded = Buffer.from(UPDATER, 'utf16le').toString('base64');
  const ps = path.join(SYS, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const env = { ...process.env, GP_APPDIR: lay.appDir, GP_EXE: lay.exe, GP_PID: String(pid), GP_FROM: from, GP_VERSION: version, GP_RESULT: result,
    GP_OKFILE: path.join(lay.updatesDir, `iniciou-${process.pid}-${Date.now()}.ok`), GP_HEALTH_SECONDS: String(healthSeconds), GP_PS: ps, GP_UPDATER_B64: encoded };
  delete env.ELECTRON_RUN_AS_NODE; // a versão reaberta roda como aplicativo
  if (!independent) return spawn(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { stdio: 'ignore', windowsHide: true, env });
  return new Promise((resolve, reject) => {
    const launcher = spawn(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(LAUNCHER, 'utf16le').toString('base64')], { stdio: 'ignore', windowsHide: true, env });
    launcher.on('error', reject);
    launcher.on('exit', (code) => (code === 0 ? resolve() : reject(fail('UPDATER_FAILED', 'Não foi possível iniciar o atualizador. Nada foi alterado.', 500))));
  });
}

// Resultado da última atualização (mostrado uma vez depois de reabrir).
function takeResult(lay = layout()) {
  if (!lay.packaged) return null;
  const f = path.join(lay.updatesDir, 'resultado.json');
  if (!fs.existsSync(f)) return null;
  try {
    const r = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
    fs.renameSync(f, path.join(lay.updatesDir, 'resultado-visto.json'));
    return r;
  } catch { return null; }
}

module.exports = { layout, trustedKey, publishApp, checkApp, trustChannelKey, prepareUpdate, launchUpdater, takeResult, UPDATER, PACKAGE_FORMAT };
