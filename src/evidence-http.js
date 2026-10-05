// Parte HTTP do sistema de evidências, compartilhada por quem anexa arquivos (checklist e observações do controle de horas):
// receber o upload, validar (src/evidence.js), gravar na pasta de evidências, entregar o arquivo com segurança, abrir no Windows.
// Cada módulo só decide ONDE a evidência mora (qual registro guarda a lista e em qual subpasta) e quais limites vale.
// O registro de uma evidência é sempre o mesmo: { id, name, file(relativo), mime, kind, size, description, at, by }.
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { httpError, uid } = require('./util');
const E = require('./evidence');

const DRAIN_CAP = 256 * 1024 * 1024; // acima disso, um envio absurdo é cortado em vez de lido até o fim

function whoAmI() { try { return os.userInfo().username || null; } catch { return null; } }

// Lê o corpo cru da requisição (o arquivo enviado). O limite vem da configuração; o que passar dele é descartado e vira erro 413.
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      size += c.length;
      if (size <= max) chunks.push(c);
      else { over = true; if (size > DRAIN_CAP) req.destroy(); }
    });
    req.on('end', () => (over ? reject(httpError(413, `Arquivo grande demais (${(size / 1048576).toFixed(1)} MB). O máximo por evidência é ${Math.round(max / 1048576)} MB.`)) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
    req.on('aborted', () => reject(httpError(400, 'Envio interrompido.')));
  });
}

const header = (req, name, max) => { try { return decodeURIComponent(String(req.headers[name] || '')).slice(0, max); } catch { return ''; } };

// Upload: o arquivo vem cru no corpo (Content-Type: application/octet-stream); nome, tipo declarado e descrição vão em cabeçalhos.
// Valida extensão, assinatura, MIME e tamanho, grava SEM sobrescrever (o nome no disco leva um id novo) e devolve o registro.
async function receiveUpload(req, { files, cfg, type, folder }) {
  const buffer = await readBody(req, cfg.maxBytes);
  const info = E.checkUpload({ name: header(req, 'x-file-name', 300), buffer, type, cfg, declaredMime: header(req, 'x-file-type', 100) });
  const id = uid();
  const rel = files.save(folder, id, info.name, buffer);
  return { id, name: info.name, file: rel, mime: info.mime, kind: info.kind, size: info.size, description: header(req, 'x-description', 300), at: new Date().toISOString(), by: whoAmI() };
}

// Caminho no disco de uma evidência já gravada (sempre dentro da pasta de evidências; tipos perigosos e arquivos sumidos são recusados).
function evidenceAbs(files, ev) {
  if (E.BLOCKED.has(path.extname(ev.name).toLowerCase())) throw httpError(400, 'Tipo de arquivo não permitido.');
  if (!files.stat(ev.file)) throw httpError(404, 'O arquivo desta evidência não foi encontrado na pasta de evidências (foi movido ou apagado por fora).');
  return files.resolve(ev.file);
}

// Visualizar (imagem, na própria tela) ou baixar/exportar. Sempre com o tipo definido pelo app, nunca o que o navegador "adivinhar".
function sendEvidence(res, files, ev, { inline = false } = {}) {
  const abs = evidenceAbs(files, ev);
  const ext = path.extname(ev.name).toLowerCase();
  const asInline = inline && E.IMAGE_EXT.has(ext);
  res.setHeader('Content-Type', E.mimeOf(ext));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cache-Control', 'private, no-store');
  const ascii = ev.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  res.setHeader('Content-Disposition', `${asInline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(ev.name)}`);
  res.sendFile(abs);
}

// "Abrir": programa padrão do Windows, só para tipos permitidos e só para arquivos que o app mesmo gravou. Nada é executado.
function openEvidence(explorer, files, ev, { folder = false } = {}) {
  const abs = evidenceAbs(files, ev);
  spawn(explorer, folder ? [`/select,${abs}`] : [abs], { detached: true, stdio: 'ignore' }).unref();
}

// O que a tela recebe de cada evidência (nunca o caminho do disco).
const evidencePublic = (files, v) => ({ id: v.id, name: v.name, size: v.size, kind: v.kind, mime: v.mime, description: v.description, at: v.at, by: v.by, exists: !!files.stat(v.file) });

module.exports = { readBody, header, receiveUpload, evidenceAbs, sendEvidence, openEvidence, evidencePublic, whoAmI };
