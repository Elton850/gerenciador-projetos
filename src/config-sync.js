// Sincronização de CONFIGURAÇÕES compartilháveis entre instalações, pelo mesmo canal (pasta) das atualizações.
// Diferente do backup (que leva TUDO e substitui) e da atualização do aplicativo (que troca só o código).
//
// Entra (o que define COMO o trabalho é feito):  estágios · tipos de projeto · sistemas de origem · ciclos · checklists e itens (modelos)
//   · scripts SQL (cadastro + conteúdo) · modelos de e-mail GLOBAIS (+ imagens do corpo) · documentos e modelos (cadastro + arquivo)
//   · ajustes gerais compartilháveis (alerta de prazo, regras de evidência, ciclo padrão).
// Nunca entra: projetos e sua execução, horas, conexões (servidores/senhas), Workspace, e-mails gerados, auditoria, pessoas, caminhos locais.
//
// Publicar = pacote .gpconfig (ZIP: configuracoes.json + arquivos) com revisão crescente no canal.json.
// Sincronizar = compara por id com o que esta instalação recebeu da última vez (hash de cada item):
//   novo → adiciona · atualizado na origem → substitui · alterado SÓ aqui → mantém o daqui · alterado nos dois → vale a origem (avisado)
//   · removido na origem → mantém aqui (só avisa; nada é apagado) · itens que só existem aqui → intocados.
// Ciclo cujos passos mudaram ganha versão nova aqui: os projetos veem “nova versão do ciclo” e só mudam ao Aplicar (invariante 1).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const JSZip = require('jszip');
const C = require('./channel');
const { applyDefaults } = require('./defaults');
const { ScriptFiles } = require('./scriptstore');
const { decodeSqlBuffer } = require('./sqlscan');

const FORMAT = 'GerenciadorProjetosConfiguracoes';
const SECTIONS = ['stages', 'projectTypes', 'originSystems', 'cycles', 'checklists', 'checklistItems', 'scripts', 'emailTemplates', 'emailImages', 'documents', 'docTemplates'];
const LABELS = { stages: 'Estágios', projectTypes: 'Tipos de projeto', originSystems: 'Sistemas de origem', cycles: 'Ciclos', checklists: 'Checklists',
  checklistItems: 'Itens de checklist', scripts: 'Scripts SQL', emailTemplates: 'Modelos de e-mail', emailImages: 'Imagens dos modelos',
  documents: 'Documentos e modelos', docTemplates: 'Modelos de documentos gerados', settings: 'Ajustes gerais' };
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const clone = (x) => JSON.parse(JSON.stringify(x));
const fail = C.fail;

const pick = (state, section) => (state[section] || []).filter((x) => x && ID_RE.test(String(x.id || '')) && (section !== 'emailTemplates' || x.scope !== 'project'));
const sharedSettings = (state) => ({ warnDays: state.settings?.warnDays ?? null, evidence: state.settings?.evidence ?? null, defaultCycleId: state.defaultCycleId ?? null });

// Conteúdo comparável de um item (sem carimbos/versão locais; arquivos pelo hash do conteúdo, nunca pelo caminho desta máquina).
function itemHash(section, x, fileSha) {
  const c = clone(x);
  delete c.updatedAt;
  if (section === 'cycles') delete c.version;
  if (section === 'documents' && c.source?.type === 'file') c.source = { type: 'file', name: path.basename(String(c.source.path || '')), sha: fileSha || null };
  if ((section === 'scripts' || section === 'emailImages') && fileSha !== undefined) c._content = fileSha;
  return sha(C.canonical(c));
}

// ---------- montar o pacote (computador que publica) ----------
async function collect(dataDir, state) {
  const files = new Map(); // nome no pacote → Buffer
  const items = {};
  const hashes = {};
  const scripts = new ScriptFiles(dataDir);
  for (const s of SECTIONS) {
    items[s] = clone(pick(state, s));
    for (const x of items[s]) {
      let fileSha;
      if (s === 'scripts' && scripts.exists(x.file)) {
        const buf = Buffer.from(scripts.read(x.file).replace(/\r\n|\n|\r/g, '\r\n'), 'utf8');
        files.set(`scripts/${x.id}.sql`, buf); fileSha = sha(buf);
      } else if (s === 'emailImages') {
        const f = path.join(dataDir, 'evidencias', ...String(x.file || '').split('/'));
        if (x.file && fs.existsSync(f)) { const buf = fs.readFileSync(f); files.set(`imagens/${x.id}`, buf); fileSha = sha(buf); } else fileSha = null;
      } else if (s === 'documents' && x.source?.type === 'file') {
        try { const buf = fs.readFileSync(x.source.path); if (buf.length <= 200 * 1024 * 1024) { files.set(`documentos/${x.id}`, buf); fileSha = sha(buf); } } catch { fileSha = null; }
      } else if (s === 'scripts') fileSha = null;
      hashes[`${s}:${x.id}`] = itemHash(s, x, fileSha);
    }
  }
  const settings = sharedSettings(state);
  hashes['settings:geral'] = sha(C.canonical(settings));
  return { items, settings, files, hashes };
}

async function publishConfigs({ dataDir, state, channelDir, appVersion, schemaVersion, now = new Date() }) {
  C.requireChannelDir(channelDir);
  const ch = C.readChannel(channelDir) || {};
  const revision = (ch.configs?.revision || 0) + 1;
  const { items, settings, files, hashes } = await collect(dataDir, state);
  const zip = new JSZip();
  const fileList = [];
  for (const [name, buf] of files) { zip.file(name, buf); fileList.push({ path: name, size: buf.length, sha256: sha(buf) }); }
  const counts = Object.fromEntries(SECTIONS.map((s) => [s, items[s].length]));
  const manifest = { format: FORMAT, version: 1, revision, appVersion, schemaVersion, createdAt: now.toISOString(), counts, items, settings, hashes, files: fileList };
  zip.file('configuracoes.json', JSON.stringify(manifest));
  const rel = `configuracoes/configuracoes-r${revision}.gpconfig`;
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  C.writeAtomic(path.join(channelDir, ...rel.split('/')), buf);
  C.writeChannel(channelDir, { ...ch, configs: { revision, publishedAt: manifest.createdAt, appVersion, schemaVersion, counts, file: rel, size: buf.length, sha256: sha(buf) } });
  // remove pacotes antigos (fica o atual e o anterior)
  for (const f of fs.readdirSync(path.join(channelDir, 'configuracoes'))) {
    const r = Number((/^configuracoes-r(\d+)\.gpconfig$/.exec(f) || [])[1]);
    if (r && r < revision - 1) fs.rmSync(path.join(channelDir, 'configuracoes', f), { force: true });
  }
  return { revision, counts, hashes };
}

// ---------- ler o pacote (instalação que sincroniza) ----------
async function readPackage(channelDir, { schemaVersion }) {
  const ch = C.readChannel(channelDir);
  const meta = ch?.configs;
  if (!meta) return null;
  const file = C.channelPath(channelDir, meta.file);
  let buf;
  try { buf = fs.readFileSync(file); } catch { throw fail('CONFIG_MISSING', 'O pacote de configurações citado no canal não foi encontrado (a pasta terminou de sincronizar?).'); }
  if (sha(buf) !== meta.sha256) throw fail('CONFIG_CORRUPTED', 'O pacote de configurações não confere (SHA-256). Nada foi alterado.');
  let zip; let m;
  try { zip = await JSZip.loadAsync(buf, { checkCRC32: true }); m = JSON.parse(await zip.file('configuracoes.json').async('string')); } catch { throw fail('CONFIG_CORRUPTED', 'O pacote de configurações está corrompido.'); }
  if (m.format !== FORMAT || m.revision !== meta.revision) throw fail('CONFIG_CORRUPTED', 'O pacote não é o anunciado no canal.');
  if (m.version > 1) throw fail('CONFIG_TOO_NEW', 'O pacote de configurações é de um formato mais novo. Atualize o aplicativo.');
  if (Number.isInteger(m.schemaVersion) && m.schemaVersion > schemaVersion) throw fail('CONFIG_TOO_NEW', `As configurações foram publicadas por uma versão mais nova do aplicativo (${m.appVersion}). Atualize o aplicativo antes de sincronizar.`);
  const files = new Map();
  for (const f of m.files || []) {
    const e = zip.file(f.path);
    const b = e ? await e.async('nodebuffer') : null;
    if (!b || sha(b) !== f.sha256 || !/^(scripts\/[A-Za-z0-9_-]{1,64}\.sql|imagens\/[A-Za-z0-9_-]{1,64}|documentos\/[A-Za-z0-9_-]{1,64})$/.test(f.path)) throw fail('CONFIG_CORRUPTED', `O pacote de configurações está corrompido (${f.path}).`);
    files.set(f.path, b);
  }
  for (const s of SECTIONS) {
    if (!Array.isArray(m.items?.[s]) || m.items[s].some((x) => !x || typeof x !== 'object' || !ID_RE.test(String(x.id || '')))) throw fail('CONFIG_CORRUPTED', `Seção inválida no pacote: ${s}.`);
  }
  return { meta, m, files };
}

// O que mudaria aqui (sem gravar nada). syncState = settings.configSync desta instalação.
async function diffConfigs({ dataDir, state, pkg }) {
  const local = await collect(dataDir, state);
  const base = state.settings?.configSync?.hashes || {};
  const changes = [];
  const add = (section, id, name, kind) => changes.push({ section, id, name, kind });
  for (const s of SECTIONS) {
    const remote = pkg.m.items[s];
    const mine = new Map(pick(state, s).map((x) => [x.id, x]));
    for (const r of remote) {
      const key = `${s}:${r.id}`;
      const name = r.name || r.title || r.id;
      const rh = pkg.m.hashes[key]; const lh = local.hashes[key];
      if (!mine.has(r.id)) { add(s, r.id, name, 'new'); continue; }
      if (lh === rh) continue;
      if (base[key] && base[key] === rh) { add(s, r.id, name, 'local-only'); continue; } // só aqui mudou: mantém
      add(s, r.id, name, base[key] && base[key] !== lh ? 'conflict' : 'updated');
    }
    const remoteIds = new Set(remote.map((x) => x.id));
    for (const key of Object.keys(base)) {
      const [sec, id] = key.split(':');
      if (sec === s && !remoteIds.has(id) && mine.has(id)) add(s, id, mine.get(id).name || mine.get(id).title || id, 'removed-at-source');
    }
  }
  const rs = pkg.m.hashes['settings:geral']; const ls = local.hashes['settings:geral'];
  if (rs !== ls) add('settings', 'geral', 'Ajustes gerais', base['settings:geral'] && base['settings:geral'] === rs ? 'local-only' : (base['settings:geral'] && base['settings:geral'] !== ls ? 'conflict' : 'updated'));
  const toApply = changes.filter((c) => ['new', 'updated', 'conflict'].includes(c.kind));
  return { revision: pkg.meta.revision, publishedAt: pkg.meta.publishedAt, appVersion: pkg.meta.appVersion, appliedRevision: state.settings?.configSync?.revision || 0,
    changes, toApply: toApply.length, labels: LABELS };
}

// Aplica (só new/updated/conflict). Arquivos primeiro, depois o cadastro; quem chama grava o estado (store.save) e fez backup antes.
async function applyConfigs({ dataDir, state, pkg, now = new Date() }) {
  const diff = await diffConfigs({ dataDir, state, pkg });
  const work = clone(state);
  const scripts = new ScriptFiles(dataDir);
  const takenFiles = () => work.scripts.map((s) => s.file);
  for (const ch of diff.changes.filter((c) => ['new', 'updated', 'conflict'].includes(c.kind))) {
    if (ch.section === 'settings') {
      const st = pkg.m.settings || {};
      work.settings = { ...(work.settings || {}) };
      if (st.warnDays !== null && st.warnDays !== undefined) work.settings.warnDays = st.warnDays;
      if (st.evidence !== null && st.evidence !== undefined) work.settings.evidence = clone(st.evidence);
      if (st.defaultCycleId && (work.cycles || []).some((c) => c.id === st.defaultCycleId)) work.defaultCycleId = st.defaultCycleId;
      continue;
    }
    const remote = clone(pkg.m.items[ch.section].find((x) => x.id === ch.id));
    const list = work[ch.section] = work[ch.section] || [];
    const i = list.findIndex((x) => x.id === ch.id);
    const mine = i >= 0 ? list[i] : null;
    if (ch.section === 'cycles' && mine) {
      const stepsChanged = C.canonical(mine.steps) !== C.canonical(remote.steps);
      remote.version = stepsChanged ? Math.max(Number(remote.version) || 1, (Number(mine.version) || 1) + 1) : (Number(mine.version) || 1);
    }
    if (ch.section === 'scripts') {
      const content = pkg.files.get(`scripts/${remote.id}.sql`);
      if (mine) remote.file = mine.file; // mantém o nome do arquivo daqui; a versão anterior vai para .versoes
      else remote.file = scripts.newFileName(remote.name || remote.id, takenFiles());
      if (content) scripts.write(remote.file, decodeSqlBuffer(content));
    }
    if (ch.section === 'emailImages') {
      const content = pkg.files.get(`imagens/${remote.id}`);
      const target = path.join(dataDir, 'evidencias', ...String(remote.file || '').split('/'));
      const root = path.resolve(dataDir, 'evidencias');
      if (content && path.resolve(target).startsWith(root + path.sep)) { fs.mkdirSync(path.dirname(target), { recursive: true }); C.writeAtomic(target, content); }
    }
    if (ch.section === 'documents' && remote.source?.type === 'file') {
      const content = pkg.files.get(`documentos/${remote.id}`);
      const localPath = mine?.source?.type === 'file' ? mine.source.path : null;
      const sameHere = (p) => { try { return content && sha(fs.readFileSync(p)) === sha(content); } catch { return false; } };
      if (localPath && sameHere(localPath)) remote.source.path = localPath;
      else if (sameHere(remote.source.path)) { /* o caminho da origem existe aqui com o mesmo arquivo */ }
      else if (content) {
        const dest = path.join(dataDir, 'documentos', remote.id, path.basename(String(remote.source.path || 'documento')).replace(/[^\w.\- ()À-ÿ]/g, '_'));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        C.writeAtomic(dest, content);
        remote.source.path = dest;
      }
    }
    if (mine) list[i] = remote; else list.push(remote);
  }
  applyDefaults(work); // garante a estrutura (ex.: ciclo padrão válido)
  work.settings = { ...(work.settings || {}), configSync: { revision: pkg.meta.revision, appliedAt: now.toISOString(), hashes: pkg.m.hashes } };
  return { state: work, diff };
}

module.exports = { FORMAT, SECTIONS, LABELS, collect, publishConfigs, readPackage, diffConfigs, applyConfigs, itemHash };
