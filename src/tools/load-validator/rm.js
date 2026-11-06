// Validação de Carga — cliente da API do TOTVS RM (SOAP wsDataServer + REST de Consulta SQL), com as travas validadas em produção:
//
// LEITURA: ReadRecord/ReadView/GetSchema (SOAP) e RealizaConsulta (REST GET).
// ESCRITA: só pela função `write`, e só para consultas SQL temporárias desta ferramenta: Educacional/coligada global
//   (CODCOLIGADA 0), código ZMV.* (máx. 16), TÍTULO começando pelo marcador. Apagar exige ainda que a consulta tenha sido
//   gravada pelo MESMO usuário. Ciclo de uma tabela (extract): conferir que o código não existe → criar → reler e comparar a
//   sentença → executar → APAGAR SEMPRE (finally) → conferir que sumiu. `snapshot` lista todas as consultas do RM (antes/depois).
// O RM devolve erro como SOAP Fault com HTTP 200: `soap` procura o faultstring. Caracteres de controle inválidos em XML 1.0
// (e-mails com lixo, por exemplo) são removidos antes de interpretar a resposta.
'use strict';
const http = require('http');
const https = require('https');
const { MARKER, CODE_RE } = require('./catalog');

const DS = 'GlbConsSqlData';
const READ_OPS = new Set(['ReadRecord', 'ReadView', 'GetSchema']);
const WRITE_OPS = new Set(['SaveRecord', 'DeleteRecordByKey']);
const TIMEOUT_MS = 30 * 60 * 1000;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unesc = (s) => String(s).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const INVALID_REF = /&#(?:x0*(?:[0-8bcef]|1[0-9a-f])|0*(?:[0-8]|1[124-9]|2[0-9]|3[01]));/gi;
const sanitize = (xml) => String(xml).replace(INVALID_REF, '');

// Endereço do RM: http(s)://servidor[:porta], sem caminho.
function cleanUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { throw new Error('Endereço do RM inválido. Use http(s)://servidor:porta.'); }
  if (!/^https?:$/.test(u.protocol) || !u.hostname || u.username || u.password || (u.pathname && u.pathname !== '/') || u.search || u.hash) throw new Error('Endereço do RM inválido. Use http(s)://servidor:porta, sem caminho.');
  return `${u.protocol}//${u.host}`;
}

function request({ url, user, password }, method, path, { body, headers = {}, timeoutMs = TIMEOUT_MS } = {}) {
  const u = new URL(cleanUrl(url) + path);
  const lib = u.protocol === 'https:' ? https : http;
  const auth = Buffer.from(`${user}:${password}`, 'utf8').toString('base64');
  return new Promise((resolve, reject) => {
    const req = lib.request(u, { method, headers: { Authorization: `Basic ${auth}`, ...headers, ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('O RM não respondeu a tempo.')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Uma operação SOAP do wsDataServer. Só as de leitura passam por aqui; as de escrita só via `write`.
async function soap(rm, op, fields, { allowWrite = false } = {}) {
  if (!READ_OPS.has(op) && !(allowWrite && WRITE_OPS.has(op))) throw new Error(`Operação bloqueada no RM: ${op}`);
  const inner = Object.entries(fields).map(([k, v]) => `<tot:${k}>${esc(v)}</tot:${k}>`).join('');
  const body = `<?xml version="1.0" encoding="utf-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tot="http://www.totvs.com/"><soapenv:Body><tot:${op}>${inner}</tot:${op}></soapenv:Body></soapenv:Envelope>`;
  const r = await request(rm, 'POST', '/wsDataServer/IwsDataServer', { body, headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `http://www.totvs.com/IwsDataServer/${op}` } });
  const text = r.body.toString('utf8');
  if (r.status === 401) throw Object.assign(new Error('Usuário ou senha do RM recusados (HTTP 401).'), { code: 'LV_RM_AUTH' });
  const fault = text.match(/<faultstring[^>]*>([\s\S]*?)<\/faultstring>/);
  if (fault) throw new Error(`RM: ${unesc(fault[1]).replace(/\s+/g, ' ').trim().slice(0, 600)}`);
  if (r.status !== 200) throw new Error(`RM respondeu HTTP ${r.status}.`);
  const m = text.match(new RegExp(`<${op}Result>([\\s\\S]*?)</${op}Result>`)) || text.match(new RegExp(`<${op}Result\\s*/>`));
  return m && m[1] !== undefined ? sanitize(unesc(m[1])) : '';
}

const ctx = (rm, codSistema = 'S') => `CODCOLIGADA=0;CODSISTEMA=${codSistema};CODUSUARIO=${rm.user}`;
const tagText = (xml, tag) => { const m = String(xml).match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)); return m ? unesc(m[1]) : null; };
const records = (xml, tag) => [...String(xml).matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1]);

async function readConsulta(rm, code, codSistema = 'S') {
  const x = await soap(rm, 'ReadRecord', { DataServerName: DS, PrimaryKey: `0;${codSistema};${code}`, Contexto: ctx(rm, codSistema) });
  const rec = records(x, 'GConsSql')[0];
  if (!rec) return null;
  return { code: tagText(rec, 'CODSENTENCA'), title: tagText(rec, 'TITULO') || '', sentence: tagText(rec, 'SENTENCA') || '', user: tagText(rec, 'USRULTALTERACAO') || '', changedAt: tagText(rec, 'DTULTALTERACAO') || '' };
}

// Todas as consultas SQL do RM (qualquer sistema): "coligada|sistema|código|alteração".
async function snapshot(rm) {
  const x = await soap(rm, 'ReadView', { DataServerName: DS, Filtro: 'GCONSSQL.CODCOLIGADA >= 0', Contexto: ctx(rm) });
  return new Set(records(x, 'GConsSql').map((r) => [tagText(r, 'CODCOLIGADA'), tagText(r, 'APLICACAO'), tagText(r, 'CODSENTENCA'), tagText(r, 'DTULTALTERACAO') || ''].join('|')));
}

// Única porta de escrita no RM.
async function write(rm, op, { code, codSistema = 'S', table, sentence }) {
  if (!CODE_RE.test(code) || code.length > 16) throw new Error(`Código fora do padrão da ferramenta: ${code}`);
  if (!/^[A-Z]$/.test(codSistema)) throw new Error('Sistema inválido.');
  if (op === 'SaveRecord') {
    const f = { CODCOLIGADA: '0', APLICACAO: codSistema, CODSENTENCA: code, TITULO: `${MARKER} ${table}`, SENTENCA: sentence, TAMANHO: String(sentence.length),
      DISPONIVELFILTRO: '0', DISPONIVELRELATORIO: '0', DISPONIVELVISAO: '0', DISPONIVELMENU: '0', SEMSEGCOLUNAS: '0', SEMSEGESTENDIDA: '0' };
    const xml = `<GlbConsSql><GConsSql>${Object.entries(f).map(([k, v]) => `<${k}>${esc(v)}</${k}>`).join('')}</GConsSql></GlbConsSql>`;
    return soap(rm, 'SaveRecord', { DataServerName: DS, XML: xml, Contexto: ctx(rm, codSistema) }, { allowWrite: true });
  }
  if (op === 'DeleteRecordByKey') {
    const cur = await readConsulta(rm, code, codSistema);
    if (!cur) return 'inexistente';
    if (!cur.title.startsWith(MARKER)) throw new Error(`A consulta ${code} não é desta ferramenta: nada foi apagado.`);
    if (cur.user.toLowerCase() !== String(rm.user).toLowerCase()) throw new Error(`A consulta ${code} foi gravada por outro usuário (${cur.user}): nada foi apagado.`);
    return soap(rm, 'DeleteRecordByKey', { DataServerName: DS, PrimaryKey: `0;${codSistema};${code}`, Contexto: ctx(rm, codSistema) }, { allowWrite: true });
  }
  throw new Error(`Operação bloqueada no RM: ${op}`);
}

// Executa uma consulta cadastrada (REST GET). Falha de rede: até 3 tentativas (é só leitura).
async function execute(rm, code, coligada, codSistema = 'S', { sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const path = `/api/framework/v1/consultaSQLServer/RealizaConsulta/${encodeURIComponent(code)}/0/${codSistema}?context=${encodeURIComponent(`CODCOLIGADA=${coligada}`)}`;
  for (let i = 0; ; i++) {
    let r;
    try { r = await request(rm, 'GET', path, { headers: { Accept: 'application/json' } }); } catch (e) {
      if (i >= 2) throw new Error(`Falha de rede com o RM após 3 tentativas: ${e.message}`);
      await sleep(5000 * (i + 1)); continue;
    }
    const text = r.body.toString('utf8').replace(/^﻿/, '');
    if (r.status === 401) throw Object.assign(new Error('Usuário ou senha do RM recusados (HTTP 401).'), { code: 'LV_RM_AUTH' });
    if (r.status !== 200) throw new Error(`Consulta ${code}: RM respondeu HTTP ${r.status}: ${text.slice(0, 400)}`);
    let data = JSON.parse(text);
    if (!Array.isArray(data)) data = Object.values(data || {}).find(Array.isArray);
    if (!Array.isArray(data)) throw new Error(`Consulta ${code}: resposta inesperada da API de Consulta SQL.`);
    return { rows: data, bytes: r.body.length };
  }
}

// Ciclo completo de uma tabela no RM. log(msg) registra cada passo (auditoria só com metadados).
async function extract(rm, { table, code, sentence, coligada, codSistema = 'S', log = () => {} }) {
  const existing = await readConsulta(rm, code, codSistema);
  if (existing) {
    if (existing.title.startsWith(MARKER) && existing.user.toLowerCase() === String(rm.user).toLowerCase()) {
      log(`sobra de execução anterior (${code}) apagada antes de recriar`);
      await write(rm, 'DeleteRecordByKey', { code, codSistema });
      if (await readConsulta(rm, code, codSistema)) throw new Error(`Não foi possível apagar a sobra ${code} no RM.`);
    } else throw new Error(`O código ${code} já existe no RM e não é desta ferramenta: nada foi feito nesta tabela.`);
  }
  try {
    const res = await write(rm, 'SaveRecord', { code, codSistema, table, sentence });
    const back = await readConsulta(rm, code, codSistema);
    if (!back || back.sentence.replace(/\r\n/g, '\n').trim() !== sentence.trim()) throw new Error(`Criação da consulta ${code} não confirmada na releitura (${String(res).slice(0, 200)}).`);
    log(`consulta ${code} criada`);
    return await execute(rm, code, coligada, codSistema);
  } finally {
    await write(rm, 'DeleteRecordByKey', { code, codSistema });
    if (await readConsulta(rm, code, codSistema)) throw new Error(`ATENÇÃO: a consulta ${code} não foi apagada no RM. Apague-a em Consultas SQL.`);
    log(`consulta ${code} apagada`);
  }
}

// Teste de conexão (só leitura): autenticação + leitura do cadastro de consultas SQL + API REST.
async function test(rm) {
  const t0 = Date.now();
  await readConsulta(rm, 'ZMV.TESTE');
  const r = await request(rm, 'GET', '/api/framework/v1/consultaSQLServer/RealizaConsulta/ZMV.TESTE/0/S', { headers: { Accept: 'application/json' }, timeoutMs: 60000 });
  if (r.status === 401) throw Object.assign(new Error('A API REST recusou o usuário ou a senha (HTTP 401).'), { code: 'LV_RM_AUTH' });
  return { ok: true, ms: Date.now() - t0 };
}

module.exports = { cleanUrl, soap, readConsulta, snapshot, write, execute, extract, test, sanitize, DS };
