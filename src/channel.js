// Canal de publicação: uma PASTA (OneDrive/Google Drive no computador, rede, pendrive…) onde o computador principal publica as versões do
// aplicativo e o pacote de configurações compartilháveis; as outras instalações leem dela. Sem servidor, sem conta, sem Git/Node no cliente.
//
//   <canal>\canal.json                                   índice: versão mais nova (+ assinatura) e revisão das configurações
//   <canal>\versoes\GerenciadorProjetos-<v>.gpupdate      atualização (ZIP da pasta resources do aplicativo = código)
//   <canal>\versoes\GerenciadorProjetos-<v>-instalacao.zip  instalação completa para uma máquina nova (pasta app\ + LEIA-ME)
//   <canal>\configuracoes\configuracoes-r<N>.gpconfig     ciclos, checklists, modelos… (src/config-sync.js)
//   <canal>\chave-publicacao.json                        chave de publicação (privada cifrada com a SENHA do usuário)
//
// Assinatura (só das versões do aplicativo, que são código executável): Ed25519. A chave fica NA PASTA DO CANAL, com a privada cifrada
// pela senha (scrypt + AES-256-GCM): qualquer computador com acesso à pasta publica informando a senha (não depende de uma máquina).
// A pública vai dentro do aplicativo (resources\gp-publicacao.pub) e é nela que cada instalação confia; passar a confiar em outra
// chave também exige a senha. Quem consegue gravar na pasta do canal não consegue publicar código sem a senha.
'use strict';
// Dentro do Electron o fs comum trata arquivos .asar como pastas; aqui eles são arquivos comuns (copiar, conferir, apagar).
const fs = (() => { try { return require('original-fs'); } catch { return require('fs'); } })();
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { SYS } = require('./powershell');

const CHANNEL_FILE = 'canal.json';
const FORMAT = 'GerenciadorProjetosCanal';
const PUBKEY_FILE = 'gp-publicacao.pub';
const KEY_FILE = 'chave-publicacao.json';
const KEY_FORMAT = 'GerenciadorProjetosChave';
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }; // mesmo custo da senha do backup
const MIN_PASSWORD = 8;
const TAR = path.join(SYS, 'System32', 'tar.exe'); // bsdtar do Windows 10/11: cria e extrai ZIP sem dependências

const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
// Pasta do canal informada mas inacessível (Google Drive fechado, unidade G: não montada, caminho errado) é diferente de "pasta sem chave":
// sem esta conferência, o aviso de chave ausente levaria a criar outra chave e todas as instalações teriam de confiar nela de novo.
const channelNotFound = (dir) => fail('CHANNEL_NOT_FOUND', `Pasta de publicação não encontrada: ${dir}. Ela está sincronizada/conectada (ex.: Google Drive aberto)?`);
function requireChannelDir(dir, emptyMessage = 'Escolha a pasta de publicação (canal) antes de publicar.') {
  if (!dir) throw fail('CHANNEL_MISSING', emptyMessage);
  let st = null;
  try { st = fs.statSync(dir); } catch { /* não existe ou inacessível */ }
  if (!st || !st.isDirectory()) throw channelNotFound(dir);
}

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

// ---------- chave de publicação na pasta do canal (privada cifrada com a senha) ----------
const KEY_BAD = 'A chave de publicação da pasta está ilegível.';
const keyAad = (k) => Buffer.from(canonical({ format: k.format, keyId: k.keyId, publicKey: k.publicKey }));
function scryptKey(password, salt, { N, r, p }) {
  if (![N, r, p].every(Number.isInteger) || N > 2 ** 20 || r > 16 || p > 4) throw fail('KEY_INVALID', KEY_BAD);
  return crypto.scryptSync(String(password ?? '').normalize('NFC'), salt, 32, { N, r, p, maxmem: SCRYPT.maxmem * 2 });
}
// Arquivo da chave (sem a senha só dá para ler a parte pública). null = a pasta ainda não tem chave.
function readKeyFile(dir) {
  const file = dir && path.join(dir, KEY_FILE);
  if (!file || !fs.existsSync(file)) return null;
  let k;
  try { k = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw fail('KEY_INVALID', KEY_BAD); }
  if (k.format !== KEY_FORMAT || !k.publicKey || keyIdOf(k.publicKey) !== k.keyId || k.cipher !== 'aes-256-gcm' || k.kdf?.name !== 'scrypt') throw fail('KEY_INVALID', KEY_BAD);
  return k;
}
function channelKeyInfo(dir) {
  try { const k = readKeyFile(dir); return k ? { keyId: k.keyId, pubPem: k.publicKey, createdAt: k.createdAt || null } : null; } catch { return null; }
}
// Cria a chave da pasta (só se ainda não existir). A senha nunca é guardada; sem ela ninguém publica nem troca a confiança.
function createChannelKey(dir, password, now = new Date()) {
  requireChannelDir(dir); // nunca cria a pasta (writeAtomic criaria): chave nova só numa pasta de canal que já existe
  if (readKeyFile(dir)) throw fail('KEY_EXISTS', 'A pasta de publicação já tem uma chave de publicação.', 409);
  if (String(password ?? '').length < MIN_PASSWORD) throw fail('KEY_PASSWORD_WEAK', `A senha da chave de publicação precisa ter pelo menos ${MIN_PASSWORD} caracteres.`);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  const salt = crypto.randomBytes(16); const iv = crypto.randomBytes(12);
  const k = { format: KEY_FORMAT, v: 1, keyId: keyIdOf(pubPem), publicKey: pubPem, createdAt: now.toISOString(),
    kdf: { name: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString('base64') }, cipher: 'aes-256-gcm', iv: iv.toString('base64') };
  const key = scryptKey(password, salt, SCRYPT);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(keyAad(k));
  const data = Buffer.concat([c.update(privateKey.export({ type: 'pkcs8', format: 'pem' })), c.final()]);
  key.fill(0);
  writeAtomic(path.join(dir, KEY_FILE), JSON.stringify({ ...k, tag: c.getAuthTag().toString('base64'), data: data.toString('base64') }, null, 2));
  return { pubPem, keyId: k.keyId, privateKey };
}
// Abre a chave da pasta com a senha (senha errada ou arquivo adulterado → recusa).
function unlockChannelKey(dir, password) {
  const k = readKeyFile(dir);
  if (!k) throw fail('KEY_MISSING', 'A pasta de publicação ainda não tem chave de publicação.', 409);
  let privateKey;
  try {
    const key = scryptKey(password, Buffer.from(k.kdf.salt, 'base64'), k.kdf);
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(k.iv, 'base64'));
    d.setAAD(keyAad(k));
    d.setAuthTag(Buffer.from(k.tag, 'base64'));
    privateKey = crypto.createPrivateKey(Buffer.concat([d.update(Buffer.from(k.data, 'base64')), d.final()]).toString('utf8'));
    key.fill(0);
  } catch (e) {
    if (e.code === 'KEY_INVALID') throw e;
    throw fail('KEY_PASSWORD', 'Senha da chave de publicação incorreta.');
  }
  if (crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }) !== k.publicKey) throw fail('KEY_INVALID', KEY_BAD);
  return { pubPem: k.publicKey, keyId: k.keyId, privateKey };
}
const sign = (obj, privateKey) => crypto.sign(null, Buffer.from(canonical(obj)), privateKey).toString('base64');
function verify(obj, signature, pubPem) {
  try { return crypto.verify(null, Buffer.from(canonical(obj)), crypto.createPublicKey(pubPem), Buffer.from(String(signature || ''), 'base64')); } catch { return false; }
}

module.exports = {
  CHANNEL_FILE, FORMAT, PUBKEY_FILE, TAR, fail, requireChannelDir, parseVersion, compareVersions, sha256File, writeAtomic, copyAtomic, channelPath,
  zipEntries, unzipTo, readChannel, writeChannel, canonical, keyIdOf, KEY_FILE, readKeyFile, channelKeyInfo, createChannelKey, unlockChannelKey, sign, verify,
};
