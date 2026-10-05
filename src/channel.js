// Canal de publicação: uma PASTA (OneDrive/Google Drive no computador, rede, pendrive…) onde o computador principal publica as versões do
// aplicativo e o pacote de configurações compartilháveis; as outras instalações leem dela. Sem servidor, sem conta, sem Git/Node no cliente.
//
//   <canal>\canal.json                                   índice: versão mais nova (+ assinatura) e revisão das configurações
//   <canal>\versoes\GerenciadorProjetos-<v>.gpupdate      atualização (ZIP da pasta resources do aplicativo = código)
//   <canal>\versoes\GerenciadorProjetos-<v>-instalacao.zip  instalação completa para uma máquina nova (pasta app\ + LEIA-ME)
//   <canal>\configuracoes\configuracoes-r<N>.gpconfig     ciclos, checklists, modelos… (src/config-sync.js)
//
// Assinatura (só das versões do aplicativo, que são código executável): Ed25519. A chave privada fica SÓ no computador que publica,
// protegida pela DPAPI (%LOCALAPPDATA%\GerenciadorProjetos\publicacao); a pública vai dentro do aplicativo (resources\gp-publicacao.pub)
// e é nela que cada instalação confia. Quem consegue gravar na pasta do canal não consegue publicar código sem a chave privada.
'use strict';
// Dentro do Electron o fs comum trata arquivos .asar como pastas; aqui eles são arquivos comuns (copiar, conferir, apagar).
const fs = (() => { try { return require('original-fs'); } catch { return require('fs'); } })();
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { SYS } = require('./powershell');

const CHANNEL_FILE = 'canal.json';
const FORMAT = 'GerenciadorProjetosCanal';
const PUBKEY_FILE = 'gp-publicacao.pub';
const TAR = path.join(SYS, 'System32', 'tar.exe'); // bsdtar do Windows 10/11: cria e extrai ZIP sem dependências

const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });

// ---------- versões (semver x.y.z[-pré]) ----------
function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v || '').trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || '' };
}
function compareVersions(a, b) {
  const x = parseVersion(a); const y = parseVersion(b);
  if (!x || !y) throw fail('BAD_VERSION', `Versão inválida: ${!x ? a : b}`);
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] > y[k] ? 1 : -1;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1; // 1.0.0 > 1.0.0-beta
  if (!y.pre) return -1;
  return x.pre > y.pre ? 1 : -1;
}

// ---------- arquivos ----------
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex')));
  });
}
function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}
function copyAtomic(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  fs.copyFileSync(src, tmp);
  fs.renameSync(tmp, dest);
}
// Caminho de arquivo citado no canal.json: sempre relativo e dentro da pasta do canal.
function channelPath(dir, rel) {
  if (typeof rel !== 'string' || !/^(versoes|configuracoes)\/[A-Za-z0-9._ -]{1,120}$/.test(rel)) throw fail('CHANNEL_INVALID', 'O índice do canal cita um arquivo inválido.');
  return path.join(dir, ...rel.split('/'));
}

// ZIP com o tar do Windows (args fixos; nada passa por shell).
function tar(args, { timeoutMs = 15 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(TAR, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(fail('TAR_FAILED', `Falha ao compactar/extrair (${String(stderr || err.message).trim().slice(0, 300)})`, 500));
      resolve(stdout);
    });
  });
}
// entries: [{ cwd, name }] — cada item entra no ZIP com o nome relativo a cwd.
async function zipEntries(outFile, entries, { exclude = [] } = {}) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const tmp = `${outFile}.${process.pid}.tmp.zip`;
  const args = ['-a', '-c', '-f', tmp];
  for (const e of exclude) args.push('--exclude', e);
  for (const e of entries) args.push('-C', e.cwd, e.name);
  try { await tar(args); fs.renameSync(tmp, outFile); } finally { fs.rmSync(tmp, { force: true }); }
}
async function unzipTo(file, dest) {
  fs.mkdirSync(dest, { recursive: true });
  await tar(['-x', '-f', file, '-C', dest]); // bsdtar recusa caminhos absolutos e "..": nada sai da pasta de destino
}

// ---------- índice do canal ----------
function readChannel(dir) {
  if (!dir) return null;
  const file = path.join(dir, CHANNEL_FILE);
  if (!fs.existsSync(file)) return null;
  let c;
  try { c = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw fail('CHANNEL_INVALID', 'O índice do canal (canal.json) está ilegível.'); }
  if (c.format !== FORMAT) throw fail('CHANNEL_INVALID', 'A pasta escolhida não é um canal do Gerenciador de Projetos.');
  if (c.formatVersion > 1) throw fail('CHANNEL_TOO_NEW', 'O canal foi gravado por uma versão mais nova do aplicativo. Atualize pelo pacote de instalação.');
  return c;
}
function writeChannel(dir, c) {
  writeAtomic(path.join(dir, CHANNEL_FILE), JSON.stringify({ ...c, format: FORMAT, formatVersion: 1 }, null, 2));
}

// ---------- assinatura Ed25519 ----------
const canonical = (v) => (Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
    : JSON.stringify(v));
const keyIdOf = (pem) => crypto.createHash('sha256').update(String(pem).trim()).digest('hex').slice(0, 16);

function keyDir() { return process.env.GP_PUBLISH_KEY_DIR || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'GerenciadorProjetos', 'publicacao'); }

// Par de chaves de publicação deste computador (criado na primeira publicação). Privada: só protegida pela DPAPI.
async function publishingKeys({ protect, unprotect }) {
  const dir = keyDir();
  const privFile = path.join(dir, 'chave-privada.dpapi');
  const pubFile = path.join(dir, PUBKEY_FILE);
  if (!fs.existsSync(privFile) || !fs.existsSync(pubFile)) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
    const enc = await protect(privateKey.export({ type: 'pkcs8', format: 'pem' }));
    fs.mkdirSync(dir, { recursive: true });
    writeAtomic(privFile, enc);
    writeAtomic(pubFile, pubPem);
  }
  const pubPem = fs.readFileSync(pubFile, 'utf8');
  const privateKey = crypto.createPrivateKey(await unprotect(fs.readFileSync(privFile, 'utf8').trim()));
  return { pubPem, keyId: keyIdOf(pubPem), privateKey };
}
const sign = (obj, privateKey) => crypto.sign(null, Buffer.from(canonical(obj)), privateKey).toString('base64');
function verify(obj, signature, pubPem) {
  try { return crypto.verify(null, Buffer.from(canonical(obj)), crypto.createPublicKey(pubPem), Buffer.from(String(signature || ''), 'base64')); } catch { return false; }
}

module.exports = {
  CHANNEL_FILE, FORMAT, PUBKEY_FILE, TAR, fail, parseVersion, compareVersions, sha256File, writeAtomic, copyAtomic, channelPath,
  zipEntries, unzipTo, readChannel, writeChannel, canonical, keyIdOf, keyDir, publishingKeys, sign, verify,
};
