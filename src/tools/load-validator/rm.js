// Validação de Carga — cliente da API do TOTVS RM (SOAP wsDataServer + REST de Consulta SQL), com as travas validadas em produção:
//
// LEITURA: ReadRecord/ReadView/GetSchema (SOAP) e RealizaConsulta (REST GET; nunca repetida depois de timeout).
// ESCRITA: só pela função `write`, e só para consultas SQL temporárias desta ferramenta: Educacional/coligada global
//   (CODCOLIGADA 0), código ZMV.* (máx. 16), TÍTULO começando pelo marcador. Apagar exige ainda que a consulta tenha sido
//   gravada pelo MESMO usuário. Ciclo de uma tabela (extract): conferir que o código não existe → criar → reler e comparar a
//   sentença → executar → APAGAR SEMPRE (finally) → conferir que sumiu. `snapshot` lista só as consultas ZMV.* (antes/depois).
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
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('O RM não respondeu a tempo.'), { code: 'LV_RM_TIMEOUT' })));
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
  if (fault) throw new Error(`RM: ${unesc(fault[1]).replace(/\s+/g, ' ').trim().slice(0, 600)}${hostHint(fault[1])}`);
  if (r.status !== 200) throw new Error(`RM respondeu HTTP ${r.status}.`);
  const m = text.match(new RegExp(`<${op}Result>([\\s\\S]*?)</${op}Result>`)) || text.match(new RegExp(`<${op}Result\\s*/>`));
  return m && m[1] !== undefined ? sanitize(unesc(m[1])) : '';
}

// Erros do RM que pedem orientação: falta de memória do próprio RM.Host (não é a ferramenta; insistir piora) e erro do Oracle
// (ORA-nnnnn: o banco do RM é Oracle e recusou o SQL ao interpretar — nada foi lido nem gravado; a consulta temporária é apagada).
const hostHint = (text) => {
  const t = String(text);
  if (/OutOfMemoryException/i.test(t)) return ' — O servidor do RM (RM.Host) está SEM MEMÓRIA. Nada foi feito pela ferramenta. Não tente de novo agora: aguarde ou peça à TOTVS/ao cliente o reinício do serviço do RM.';
  if (/\bORA-\d{5}\b/.test(t)) return ' — O banco deste RM é ORACLE e recusou a consulta ao interpretar o SQL: nada foi lido nem gravado, e a consulta temporária é apagada em seguida. A consulta do modelo usa algo que só existe no SQL Server: avise o desenvolvimento da ferramenta com esta mensagem.';
  return '';
};

const ctx = (rm, codSistema = 'S') => `CODCOLIGADA=0;CODSISTEMA=${codSistema};CODUSUARIO=${rm.user}`;
const tagText = (xml, tag) => { const m = String(xml).match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)); return m ? unesc(m[1]) : null; };
const records = (xml, tag) => [...String(xml).matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1]);

async function readConsulta(rm, code, codSistema = 'S') {
  const x = await soap(rm, 'ReadRecord', { DataServerName: DS, PrimaryKey: `0;${codSistema};${code}`, Contexto: ctx(rm, codSistema) });
  const rec = records(x, 'GConsSql')[0];
  if (!rec) return null;
  return { code: tagText(rec, 'CODSENTENCA'), title: tagText(rec, 'TITULO') || '', sentence: tagText(rec, 'SENTENCA') || '', user: tagText(rec, 'USRULTALTERACAO') || '', changedAt: tagText(rec, 'DTULTALTERACAO') || '' };
}

// Só as consultas temporárias DESTA ferramenta (ZMV.* na coligada global): "coligada|sistema|código|alteração".
// Antes listava TODAS as consultas do RM com o texto completo de cada uma — resposta grande à toa, que o RM.Host precisa montar
// na memória (num Host já sem memória, deu OutOfMemoryException em 06/11/2026). Para achar sobras basta o prefixo.
const SNAPSHOT_FILTER = "GCONSSQL.CODCOLIGADA = 0 AND GCONSSQL.CODSENTENCA LIKE 'ZMV.%'";
async function snapshot(rm) {
  const x = await soap(rm, 'ReadView', { DataServerName: DS, Filtro: SNAPSHOT_FILTER, Contexto: ctx(rm) });
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

// Executa uma consulta cadastrada (REST GET). Repete (até 3 tentativas) SÓ quando o pedido nem chegou ao RM (conexão recusada,
// nome não resolvido, rede inalcançável). Timeout, conexão derrubada no meio ou qualquer resposta do RM: NÃO repete — o RM pode
// ainda estar processando a consulta, e repetir somaria outra execução pesada à que já está rodando.
const NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);
async function execute(rm, code, coligada, codSistema = 'S', { sleep = (ms) => new Promise((r) => setTimeout(r, ms)), timeoutMs = TIMEOUT_MS } = {}) {
  const path = `/api/framework/v1/consultaSQLServer/RealizaConsulta/${encodeURIComponent(code)}/0/${codSistema}?context=${encodeURIComponent(`CODCOLIGADA=${coligada}`)}`;
  for (let i = 0; ; i++) {
    let r;
    try { r = await request(rm, 'GET', path, { headers: { Accept: 'application/json' }, timeoutMs }); } catch (e) {
      if (e.code === 'LV_RM_TIMEOUT') throw Object.assign(new Error(`Consulta ${code}: o RM não respondeu a tempo (${Math.round(timeoutMs / 1000)} s). A consulta NÃO foi repetida (o RM pode ainda estar processando); espere antes de tentar de novo.`), { code: 'LV_RM_TIMEOUT' });
      if (!NOT_SENT.has(e.code)) throw new Error(`Consulta ${code}: a conexão com o RM caiu durante a execução (${e.message}). A consulta NÃO foi repetida.`);
      if (i >= 2) throw new Error(`Falha de rede com o RM após 3 tentativas (o pedido não chegou ao RM): ${e.message}`);
      await sleep(5000 * (i + 1)); continue;
    }
    const text = r.body.toString('utf8').replace(/^﻿/, '');
    if (r.status === 401) throw Object.assign(new Error('Usuário ou senha do RM recusados (HTTP 401).'), { code: 'LV_RM_AUTH' });
    if (r.status !== 200) throw new Error(`Consulta ${code}: RM respondeu HTTP ${r.status}: ${text.slice(0, 400)}${hostHint(text)}`);
    let data = JSON.parse(text);
    if (!Array.isArray(data)) data = Object.values(data || {}).find(Array.isArray);
    if (!Array.isArray(data)) throw new Error(`Consulta ${code}: resposta inesperada da API de Consulta SQL.`);
    return { rows: data, bytes: r.body.length };
  }
}

// Ciclo completo de UMA consulta no RM (uma contagem, uma tabela ou uma parte dela). log(msg) registra cada passo.
async function extract(rm, { table, code, sentence, coligada, codSistema = 'S', log = () => {}, exec = {} }) {
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
    return await execute(rm, code, coligada, codSistema, exec);
  } finally {
    await write(rm, 'DeleteRecordByKey', { code, codSistema });
    if (await readConsulta(rm, code, codSistema)) throw new Error(`ATENÇÃO: a consulta ${code} não foi apagada no RM. Apague-a em Consultas SQL.`);
    log(`consulta ${code} apagada`);
  }
}

// Teste de conexão (só leitura): autenticação + leitura do cadastro de consultas SQL + API REST.
// codSistema: S (Educacional) ou P (Folha). Nada é criado: ZMV.TESTE não existe e só é procurada.
async function test(rm, codSistema = 'S') {
  if (!/^[A-Z]$/.test(codSistema)) throw new Error('Sistema inválido.');
  const t0 = Date.now();
  await readConsulta(rm, 'ZMV.TESTE', codSistema);
  const r = await request(rm, 'GET', `/api/framework/v1/consultaSQLServer/RealizaConsulta/ZMV.TESTE/0/${codSistema}`, { headers: { Accept: 'application/json' }, timeoutMs: 60000 });
  if (r.status === 401) throw Object.assign(new Error('A API REST recusou o usuário ou a senha (HTTP 401).'), { code: 'LV_RM_AUTH' });
  return { ok: true, ms: Date.now() - t0 };
}

module.exports = { cleanUrl, soap, readConsulta, snapshot, write, execute, extract, test, sanitize, DS, NOT_SENT, SNAPSHOT_FILTER };
