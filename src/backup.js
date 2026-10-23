// Backup completo da aplicação: exportar tudo para UM arquivo (.gpbackup) e importar em outra máquina (substitui os dados atuais).
//
//   Conteúdo (ZIP): manifest.json + data/** (projects.json e as pastas da aplicação: evidências, imagens, scripts com versões,
//   arquivos das horas, auditoria) + documentos/** (cópia dos arquivos cadastrados em "Documentos e Modelos")
//   + credenciais.json (só no backup protegido por senha, e só se pedido).
//   Protegido por senha: o ZIP inteiro vai cifrado com AES-256-GCM; chave derivada da senha com scrypt. A senha nunca é guardada.
//   Senhas DPAPI: nunca saem desta máquina como blob (só abrem aqui). Com "incluir senhas", são abertas em memória e vão dentro do
//   pacote cifrado; na importação são protegidas de novo com a DPAPI da máquina nova. Sem isso, a conexão pede a senha de novo.
//   Integridade: SHA-256 de cada arquivo no manifesto; qualquer divergência recusa o pacote inteiro (nada é importado pela metade).
//   Importação: valida tudo → monta a pasta nova ao lado da atual → confere → troca as pastas → (falhou? volta a anterior).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const JSZip = require('jszip');
const { applyDefaults } = require('./defaults');
const MIG = require('./migrations');

// Preferências da tela (localStorage) que fazem sentido em outra máquina. Fora: últimas pastas usadas (caminhos desta máquina) e o
// adiamento do aviso de expediente (vale só para o dia).
const PREF_KEYS = ['gp-ui', 'gp-theme', 'gp-nav-w', 'gp-wm-prefs', 'gp-run-target'];
function cleanPrefs(p) {
  const out = {};
  for (const k of PREF_KEYS) if (typeof p?.[k] === 'string' && p[k].length <= 20000) out[k] = p[k];
  return out;
}

const FORMAT = 'GerenciadorProjetosBackup';
const VERSION = 1;
const ENC_MAGIC = Buffer.from('GPBACKUP-ENC1\n');
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const MAX_DOC_BYTES = 200 * 1024 * 1024;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const fail = (code, message) => Object.assign(new Error(message), { code, status: 400 });

// Na raiz da pasta de dados, só projects.json entra (o .bak/.tmp/cópias de segurança não fazem parte do estado).
const skipRoot = (name) => /^projects\.json\./.test(name) || name.endsWith('.tmp');

function walk(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (dir === base && (e.name === 'projects.json' || skipRoot(e.name))) continue;
    if (e.isDirectory()) walk(full, base, out); else if (e.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

// ---------- contagens (resumo da tela e conferência depois da importação) ----------
function sections(state, allFiles = []) {
  const files = allFiles.filter((f) => f.startsWith('data/') || f.startsWith('documentos/')); // credenciais.json não conta
  const n = (x) => (Array.isArray(x) ? x.length : 0);
  const projects = state.projects || [];
  const sum = (fn) => projects.reduce((a, p) => a + fn(p), 0);
  const under = (prefix) => files.filter((f) => f.startsWith(prefix)).length;
  return {
    projects: n(projects),
    projectChecklists: sum((p) => n(p.checklists)),
    projectChecklistItems: sum((p) => (p.checklists || []).reduce((a, c) => a + n(c.items), 0)),
    projectContacts: sum((p) => n(p.contacts)),
    cycles: n(state.cycles), stages: n(state.stages), projectTypes: n(state.projectTypes), originSystems: n(state.originSystems),
    checklists: n(state.checklists), checklistItems: n(state.checklistItems),
    coordinators: n(state.coordinators), documents: n(state.documents), connections: n(state.connections),
    emailTemplates: n(state.emailTemplates), emailGenerations: n(state.emailGenerations), emailImages: n(state.emailImages),
    scripts: n(state.scripts), timeEntries: n(state.timeEntries), timeNotes: n(state.timeNotes),
    reminders: n(state.reminders), milestoneReminders: sum((p) => (p.milestones || []).filter((m) => m.reminder).length),
    files: files.length, evidenceFiles: under('data/evidencias/'), scriptFiles: under('data/scripts/'), documentFiles: under('documentos/'),
  };
}

// ---------- senhas protegidas (DPAPI) em qualquer ponto do estado: campo passwordEnc ----------
function findSecrets(node, ptr = [], out = []) {
  if (Array.isArray(node)) node.forEach((x, i) => findSecrets(x, [...ptr, i], out));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'passwordEnc' && typeof v === 'string' && v) out.push({ ptr: [...ptr], parent: node });
      else findSecrets(v, [...ptr, k], out);
    }
  }
  return out;
}
const at = (root, ptr) => ptr.reduce((o, k) => (o == null ? o : o[k]), root);

// ---------- caminhos de disco (preservados; na outra máquina podem não existir) ----------
const ABS_PATH = /^([A-Za-z]:[\\/]|\\\\[^\\/]+[\\/])/;
function pathValues(node, out = new Set()) {
  if (typeof node === 'string') { if (ABS_PATH.test(node) && node.length < 400 && !/[\r\n]/.test(node)) out.add(node); }
  else if (Array.isArray(node)) node.forEach((x) => pathValues(x, out));
  else if (node && typeof node === 'object') Object.values(node).forEach((x) => pathValues(x, out));
  return out;
}
function missingPaths(state, exists = fs.existsSync) {
  const miss = [...pathValues(state)].filter((p) => !exists(p)).sort((a, b) => a.localeCompare(b));
  const key = (p) => p.toLowerCase().replace(/[\\/]+$/, '');
  // um caminho dentro de outro também ausente some da lista: trocar o de cima corrige os de baixo
  return miss.filter((p) => !miss.some((q) => q !== p && key(p).startsWith(`${key(q)}\\`)));
}
// Troca o início de caminho `from` por `to` em todo o estado (só valores que SÃO caminhos; texto livre não é tocado).
function remapPaths(node, from, to) {
  const f = from.replace(/[\\/]+$/, ''); const fl = f.toLowerCase();
  let changed = 0;
  const fix = (s) => {
    const sl = s.toLowerCase();
    if (!ABS_PATH.test(s) || !(sl === fl || sl.startsWith(`${fl}\\`) || sl.startsWith(`${fl}/`))) return s;
    changed++;
    return to.replace(/[\\/]+$/, '') + s.slice(f.length);
  };
  (function go(n) {
    if (Array.isArray(n)) n.forEach((x, i) => { if (typeof x === 'string') n[i] = fix(x); else go(x); });
    else if (n && typeof n === 'object') for (const [k, v] of Object.entries(n)) { if (typeof v === 'string') n[k] = fix(v); else go(v); }
  })(node);
  return changed;
}

// ---------- cifra do pacote (AES-256-GCM + scrypt) ----------
function encrypt(zipBuf, password) {
  const salt = crypto.randomBytes(16); const iv = crypto.randomBytes(12);
  const header = Buffer.from(JSON.stringify({ format: FORMAT, v: 1, kdf: { name: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString('base64') }, cipher: 'aes-256-gcm', iv: iv.toString('base64') }));
  const key = crypto.scryptSync(String(password).normalize('NFC'), salt, 32, SCRYPT);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(header);
  const body = Buffer.concat([c.update(zipBuf), c.final(), c.getAuthTag()]);
  key.fill(0);
  const len = Buffer.alloc(4); len.writeUInt32BE(header.length);
  return Buffer.concat([ENC_MAGIC, len, header, body]);
}
const isEncrypted = (buf) => buf.length > ENC_MAGIC.length && buf.subarray(0, ENC_MAGIC.length).equals(ENC_MAGIC);
function decrypt(buf, password) {
  try {
    const hl = buf.readUInt32BE(ENC_MAGIC.length);
    const hStart = ENC_MAGIC.length + 4;
    const header = buf.subarray(hStart, hStart + hl);
    const h = JSON.parse(header.toString('utf8'));
    if (h.format !== FORMAT || h.cipher !== 'aes-256-gcm' || h.kdf?.name !== 'scrypt') throw new Error('cabeçalho');
    if (h.v > 1) throw fail('INCOMPATIBLE', 'Este backup foi gerado por uma versão mais nova do aplicativo. Atualize o aplicativo e tente de novo.');
    const { N, r, p } = h.kdf;
    if (![N, r, p].every(Number.isInteger) || N > 2 ** 20 || r > 16 || p > 4) throw new Error('parâmetros');
    const key = crypto.scryptSync(String(password).normalize('NFC'), Buffer.from(h.kdf.salt, 'base64'), 32, { N, r, p, maxmem: SCRYPT.maxmem * 2 });
    const body = buf.subarray(hStart + hl);
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(h.iv, 'base64'));
    d.setAAD(header);
    d.setAuthTag(body.subarray(body.length - 16));
    const out = Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()]);
    key.fill(0);
    return out;
  } catch (e) {
    if (e.code === 'INCOMPATIBLE') throw e;
    throw fail('BAD_PASSWORD', 'Senha incorreta ou arquivo de backup corrompido.');
  }
}

// ---------- exportar ----------
// state: estado atual (store.data). opts.password: protege o pacote. opts.includeCredentials: só com senha.
// opts.localSnapshot: cópia de segurança DESTA máquina (antes de importar) — mantém os blobs DPAPI, que só valem aqui.
async function createBackup({ dataDir, state, password = '', includeCredentials = false, localSnapshot = false, unprotect, appVersion = '', prefs = null, now = new Date() }) {
  if (includeCredentials && !password) throw fail('PASSWORD_REQUIRED', 'Para incluir as senhas das conexões, proteja o backup com senha.');
  const exported = JSON.parse(JSON.stringify(state));
  const credentials = [];
  const credentialProblems = [];
  if (!localSnapshot) {
    for (const s of findSecrets(exported)) {
      if (includeCredentials) {
        try { credentials.push({ ptr: s.ptr, password: await unprotect(s.parent.passwordEnc) }); } catch { credentialProblems.push(s.ptr.join('/')); }
      }
      delete s.parent.passwordEnc; // blob DPAPI nunca vai para outra máquina
    }
  }
  const zip = new JSZip();
  const files = [];
  const add = (name, buf) => { zip.file(name, buf); files.push({ path: name, size: buf.length, sha256: sha256(buf) }); };
  add('data/projects.json', Buffer.from(JSON.stringify(exported, null, 2), 'utf8'));
  for (const rel of walk(dataDir)) add(`data/${rel}`, fs.readFileSync(path.join(dataDir, ...rel.split('/'))));
  // documentos cadastrados como arquivo: a cópia vai junto (na outra máquina o caminho original pode não existir)
  const documents = [];
  for (const d of exported.documents || []) {
    const p = d?.source?.type === 'file' ? d.source.path : null;
    if (!p) continue;
    let st = null;
    try { st = fs.statSync(p); } catch { /* ausente */ }
    if (!st || !st.isFile() || st.size > MAX_DOC_BYTES) { documents.push({ id: d.id, original: p, entry: null }); continue; }
    const entry = `documentos/${String(d.id).replace(/[^A-Za-z0-9_-]/g, '_')}/${path.basename(p).replace(/[^\w.\- ()À-ÿ]/g, '_')}`;
    add(entry, fs.readFileSync(p));
    documents.push({ id: d.id, original: p, entry });
  }
  if (credentials.length) add('credenciais.json', Buffer.from(JSON.stringify(credentials), 'utf8'));
  const uiPrefs = cleanPrefs(prefs);
  if (Object.keys(uiPrefs).length) add('preferencias.json', Buffer.from(JSON.stringify(uiPrefs), 'utf8'));
  const manifest = {
    format: FORMAT, version: VERSION, appVersion, schemaVersion: MIG.currentSchema(exported), createdAt: now.toISOString(),
    encrypted: !!password, includesCredentials: credentials.length > 0, localSnapshot,
    sections: sections(exported, files.map((f) => f.path)), documents, files,
  };
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  const zipBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return { buffer: password ? encrypt(zipBuf, password) : zipBuf, manifest, credentialProblems };
}

// ---------- ler e validar (nada é gravado) ----------
const SAFE_ENTRY = /^(manifest\.json|credenciais\.json|preferencias\.json|data\/[^\0]+|documentos\/[^\0]+)$/;
async function readBackup(buf, password = '') {
  let zipBuf = buf;
  if (isEncrypted(buf)) {
    if (!password) return { needsPassword: true };
    zipBuf = decrypt(buf, password);
  } else if (!(buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b)) {
    throw fail('NOT_BACKUP', 'Este arquivo não é um backup do Gerenciador de Projetos.');
  }
  let zip;
  try { zip = await JSZip.loadAsync(zipBuf, { checkCRC32: true }); } catch { throw fail('CORRUPTED', 'O arquivo de backup está corrompido (não foi possível abrir o pacote).'); }
  const mf = zip.file('manifest.json');
  if (!mf) throw fail('NOT_BACKUP', 'Este arquivo não é um backup do Gerenciador de Projetos (sem manifesto).');
  let manifest;
  try { manifest = JSON.parse(await mf.async('string')); } catch { throw fail('CORRUPTED', 'O manifesto do backup está corrompido.'); }
  if (manifest.format !== FORMAT) throw fail('NOT_BACKUP', 'Este arquivo não é um backup do Gerenciador de Projetos.');
  if (!Number.isInteger(manifest.version) || manifest.version > VERSION) throw fail('INCOMPATIBLE', `Este backup é da versão ${manifest.version} do formato; este aplicativo lê até a versão ${VERSION}. Atualize o aplicativo.`);
  const listed = new Set((manifest.files || []).map((f) => f.path));
  const files = new Map();
  for (const name of Object.keys(zip.files)) {
    const e = zip.files[name];
    if (e.dir) continue;
    if (name === 'manifest.json') continue;
    if (!SAFE_ENTRY.test(name) || name.split('/').some((s) => s === '..' || s === '' || s === '.') || /[:\\]/.test(name)) throw fail('CORRUPTED', 'O backup contém um caminho de arquivo inválido.');
    if (!listed.has(name)) throw fail('CORRUPTED', 'O backup contém arquivos que não constam no manifesto.');
  }
  for (const f of manifest.files || []) {
    const e = zip.file(f.path);
    if (!e) throw fail('CORRUPTED', `O backup está incompleto (falta ${f.path}).`);
    let b;
    try { b = await e.async('nodebuffer'); } catch { throw fail('CORRUPTED', `O backup está corrompido (${f.path}).`); }
    if (b.length !== f.size || sha256(b) !== f.sha256) throw fail('CORRUPTED', `O backup está corrompido: o arquivo ${f.path} não confere com o manifesto.`);
    files.set(f.path, b);
  }
  if (!files.has('data/projects.json')) throw fail('CORRUPTED', 'O backup não contém os dados da aplicação.');
  let state;
  try { state = JSON.parse(files.get('data/projects.json').toString('utf8')); applyDefaults(JSON.parse(JSON.stringify(state))); } catch { throw fail('CORRUPTED', 'Os dados do backup estão ilegíveis.'); }
  const counted = sections(state, [...files.keys()]);
  for (const [k, v] of Object.entries(manifest.sections || {})) if (counted[k] !== v) throw fail('CORRUPTED', 'O conteúdo do backup não confere com o manifesto.');
  // dados de uma versão MAIS NOVA do aplicativo (esquema maior): esta versão não sabe lê-los sem perder campos
  if (MIG.tooNew(state)) throw fail('INCOMPATIBLE', `Este backup foi gerado por uma versão mais nova do aplicativo (${manifest.appVersion || '?'}, esquema de dados ${MIG.currentSchema(state)}). Atualize o aplicativo antes de importar.`);
  let prefs = {};
  if (files.has('preferencias.json')) { try { prefs = cleanPrefs(JSON.parse(files.get('preferencias.json').toString('utf8'))); } catch { throw fail('CORRUPTED', 'As preferências do backup estão ilegíveis.'); } }
  let credentials = [];
  if (files.has('credenciais.json')) {
    if (!manifest.encrypted || !isEncrypted(buf)) throw fail('CORRUPTED', 'Backup sem proteção não pode conter senhas.');
    credentials = JSON.parse(files.get('credenciais.json').toString('utf8'));
  }
  return { manifest, state, files, credentials, prefs };
}

function preview(pkg) {
  const s = pkg.manifest.sections;
  return {
    createdAt: pkg.manifest.createdAt, version: pkg.manifest.version, appVersion: pkg.manifest.appVersion, schemaVersion: MIG.currentSchema(pkg.state),
    migrationsNeeded: MIG.pending(pkg.state).map((m) => m.id),
    encrypted: pkg.manifest.encrypted, includesCredentials: pkg.manifest.includesCredentials, localSnapshot: !!pkg.manifest.localSnapshot,
    sections: s, connectionsWithoutPassword: connectionsWithoutPassword(pkg.state, pkg),
  };
}
// Conexões com usuário/senha SQL que ficarão sem senha depois da importação (será pedida de novo).
function connectionsWithoutPassword(state, pkg) {
  const restored = new Set((pkg?.credentials || []).map((c) => c.ptr.join('/')));
  return (state.connections || []).map((c, i) => ({ c, i }))
    .filter(({ c, i }) => c.auth === 'sql' && !c.passwordEnc && !restored.has(`connections/${i}`))
    .map(({ c }) => c.name || `${c.server || ''}${c.database ? ` / ${c.database}` : ''}`);
}

// ---------- importar (substitui tudo; atômico) ----------
function renameRetry(a, b) {
  for (let i = 0; ; i++) {
    try { fs.renameSync(a, b); return; } catch (e) {
      if (i >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      const until = Date.now() + 150 * (i + 1); while (Date.now() < until) { /* espera curta (antivírus/indexador segurando a pasta) */ }
    }
  }
}

// Monta a pasta nova ao lado da atual, confere e troca. Devolve { previous } (pasta anterior, para desfazer) — quem chama recarrega e
// confirma (commitImport) ou desfaz (rollbackImport).
async function stageAndSwap({ dataDir, pkg, protect, now = new Date() }) {
  const dir = path.resolve(dataDir);
  const tag = stamp(now);
  const staging = `${dir}.importando-${tag}`;
  const previous = `${dir}.anterior-${tag}`;
  const state = JSON.parse(JSON.stringify(pkg.state));
  try {
    fs.mkdirSync(staging, { recursive: true });
    for (const [name, buf] of pkg.files) {
      if (!name.startsWith('data/') || name === 'data/projects.json') continue;
      const target = path.join(staging, ...name.slice(5).split('/'));
      if (!target.startsWith(staging + path.sep)) throw fail('CORRUPTED', 'O backup contém um caminho de arquivo inválido.');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, buf, { flag: 'wx' });
    }
    // documentos: o caminho original existe nesta máquina? mantém. Senão, a cópia do pacote vai para <dados>\documentos.
    const restoredDocs = [];
    for (const d of pkg.manifest.documents || []) {
      const doc = (state.documents || []).find((x) => x.id === d.id);
      if (!doc || !d.entry || fs.existsSync(d.original)) continue;
      const buf = pkg.files.get(d.entry);
      const rel = d.entry.split('/');
      fs.mkdirSync(path.join(staging, ...rel.slice(0, -1)), { recursive: true });
      // o mesmo arquivo pode já ter vindo em data/documentos (documento restaurado numa importação anterior): reaproveita;
      // se for outro conteúdo com o mesmo nome, grava ao lado com sufixo
      const name = rel[rel.length - 1]; const ext = path.extname(name); const stem = name.slice(0, name.length - ext.length);
      for (let i = 2; ; i++) {
        const target = path.join(staging, ...rel);
        if (!fs.existsSync(target)) { fs.writeFileSync(target, buf, { flag: 'wx' }); break; }
        if (sha256(fs.readFileSync(target)) === sha256(buf)) break;
        rel[rel.length - 1] = `${stem} (${i})${ext}`;
      }
      doc.source = { ...doc.source, path: path.join(dir, ...rel) };
      restoredDocs.push(d.id);
    }
    // senhas incluídas no pacote cifrado: protegidas de novo com a DPAPI desta máquina (nunca gravadas em claro)
    for (const c of pkg.credentials || []) {
      const parent = at(state, c.ptr);
      if (parent && typeof parent === 'object') parent.passwordEnc = await protect(c.password);
    }
    fs.writeFileSync(path.join(staging, 'projects.json'), JSON.stringify(state, null, 2), 'utf8');
    // confere a pasta montada antes de trocar
    for (const f of pkg.manifest.files) {
      if (!f.path.startsWith('data/') || f.path === 'data/projects.json') continue;
      const b = fs.readFileSync(path.join(staging, ...f.path.slice(5).split('/')));
      if (sha256(b) !== f.sha256) throw fail('IMPORT_FAILED', `Falha ao gravar ${f.path}.`);
    }
    JSON.parse(fs.readFileSync(path.join(staging, 'projects.json'), 'utf8'));
    if (fs.existsSync(dir)) renameRetry(dir, previous);
    try { renameRetry(staging, dir); } catch (e) { if (fs.existsSync(previous)) renameRetry(previous, dir); throw e; }
    return { previous: fs.existsSync(previous) ? previous : null, restoredDocs };
  } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true });
    if (e.code === 'BAD_PASSWORD' || e.code === 'CORRUPTED') throw e;
    throw Object.assign(new Error(`A importação não foi concluída e nada foi alterado: ${e.message}`), { status: e.status || 500, code: e.code || 'IMPORT_FAILED' });
  }
}

function rollbackImport(dataDir, previous, now = new Date()) {
  const dir = path.resolve(dataDir);
  if (!previous || !fs.existsSync(previous)) return false;
  const failed = `${dir}.falhou-${stamp(now)}`;
  if (fs.existsSync(dir)) renameRetry(dir, failed);
  renameRetry(previous, dir);
  fs.rmSync(failed, { recursive: true, force: true });
  return true;
}

// Depois de recarregado: o que está na pasta de dados confere com o pacote? (diferenças por seção + arquivos)
function compareAfterImport(dataDir, state, pkg) {
  // <dados>\documentos: conta só o que veio como data/ no pacote (o restaurado de documentos/ entra em docFiles)
  const fromData = new Set(pkg.manifest.files.map((f) => f.path));
  const files = ['data/projects.json', ...walk(dataDir).map((f) => `data/${f}`).filter((f) => !f.startsWith('data/documentos/') || fromData.has(f))];
  const docFiles = (pkg.manifest.documents || []).filter((d) => d.entry).map((d) => d.entry);
  const now = sections(state, [...files, ...docFiles]);
  const diffs = Object.keys(pkg.manifest.sections).filter((k) => now[k] !== pkg.manifest.sections[k]).map((k) => ({ section: k, expected: pkg.manifest.sections[k], found: now[k] }));
  for (const f of pkg.manifest.files) {
    if (!f.path.startsWith('data/') || f.path === 'data/projects.json') continue;
    let b = null;
    try { b = fs.readFileSync(path.join(dataDir, ...f.path.slice(5).split('/'))); } catch { /* */ }
    if (!b || sha256(b) !== f.sha256) diffs.push({ file: f.path });
  }
  return { before: pkg.manifest.sections, after: now, diffs };
}

module.exports = {
  FORMAT, VERSION, PREF_KEYS, createBackup, readBackup, preview, stageAndSwap, rollbackImport, compareAfterImport,
  missingPaths, remapPaths, sections, connectionsWithoutPassword, isEncrypted, stamp,
};
