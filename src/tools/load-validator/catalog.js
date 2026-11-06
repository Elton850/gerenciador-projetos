// Validação de Carga — regras PURAS (sem HTTP, disco ou banco): modelos por sistema, montagem das consultas, código das consultas
// temporárias no RM, trava de SELECT e a comparação do complemento (porta do gera_complemento.py).
'use strict';
const EDU = require('./catalog-educacional');

// Coluna usada para DIVIDIR a extração de cada tabela em partes (faixas de valor): um ID inteiro da tabela raiz que sai na consulta
// e é chave (ou começo de chave) no RM, para cada parte ser uma leitura por faixa. Sem coluna = a tabela sai numa chamada só
// (cadastros pequenos; históricos têm chave texto — RA — e ficam com o aviso de tabela grande).
const EDU_PARTS = {
  PPESSOA: 'CODIGO', SALUNO: 'CODPESSOA', SPROFESSOR: 'CODPESSOA',
  SHABILITACAOFILIAL: 'IDHABILITACAOFILIAL', SHABILITACAOFILIALPL: 'IDPERLET', SHABILITACAOALUNO: 'IDHABILITACAOFILIAL',
  STURMA: 'IDPERLET', SMATRICPL: 'IDPERLET', SHORARIOPROFESSOR: 'IDHORARIOTURMA',
  STURMADISC: 'IDTURMADISC', SPROFESSORTURMA: 'IDTURMADISC', SHORARIOTURMA: 'IDTURMADISC', SETAPAS: 'IDTURMADISC', SMATRICULA: 'IDTURMADISC',
  SPROVAS: 'IDTURMADISC', SNOTAETAPA: 'IDTURMADISC', SNOTAS: 'IDTURMADISC', SPLANOAULA: 'IDTURMADISC', SFREQUENCIA: 'IDTURMADISC',
};

// Sistemas da ferramenta. Folha ainda não tem modelo (a tela mostra "em breve").
const SYSTEMS = {
  educacional: { id: 'educacional', name: 'Educacional', codSistema: 'S', tables: EDU.TABLES, complement: EDU.COMPLEMENT, ready: true, parts: EDU_PARTS },
  folha: { id: 'folha', name: 'Folha', codSistema: 'P', tables: [], complement: [], ready: false },
};

const PREFIX = 'ZMV.'; // consultas temporárias desta ferramenta no RM (GCONSSQL.CODSENTENCA tem no máximo 16 caracteres)
const MARKER = 'MIGRACAO - EXTRACAO TEMPORARIA'; // início do TITULO: só consultas com ele podem ser apagadas
const TABLE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const CODE_RE = /^ZMV\.[A-Z0-9_]{1,12}$/;

// CRC-32 (IEEE) — o mesmo do zlib.crc32 do Python, para o código ficar igual ao do extrator em linha de comando.
const CRC_TABLE = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(text) { let c = -1; for (const b of Buffer.from(text, 'utf8')) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ -1) >>> 0; }

function consultaCode(table) {
  if (!TABLE_RE.test(table)) throw new Error(`Nome de tabela inválido: ${table}`);
  const name = table.length <= 12 ? table : `${table.slice(0, 7)}_${(crc32(table) & 0xFFFF).toString(16).toUpperCase().padStart(4, '0')}`;
  const code = PREFIX + name;
  if (!CODE_RE.test(code) || code.length > 16) throw new Error(`Código de consulta inválido: ${code}`);
  return code;
}

// Parâmetros vindos da tela: coligada (inteiro) e períodos letivos (texto curto, sem aspas). Nada mais entra no SQL.
function cleanParams(p = {}) {
  const coligada = Number(p.coligada);
  if (!Number.isInteger(coligada) || coligada < 0 || coligada > 32767) throw new Error('Informe a coligada (número inteiro).');
  const raw = Array.isArray(p.periods) ? p.periods : String(p.periods || '').split(/[,;\s]+/);
  const periods = [...new Set(raw.map((x) => String(x).trim()).filter(Boolean))];
  for (const x of periods) if (!/^[A-Za-z0-9._/-]{1,20}$/.test(x)) throw new Error(`Período letivo inválido: "${x}" (use só letras, números, ponto, hífen ou barra).`);
  if (periods.length > 20) throw new Error('No máximo 20 períodos letivos.');
  return { coligada, periods };
}

// Consulta do RM pronta: troca os parâmetros. Sem período informado, a linha do filtro de períodos sai inteira.
function renderRm(def, params) {
  const { coligada, periods } = cleanParams(params);
  let sql = def.rmSql;
  if (!periods.length) sql = sql.split('\n').filter((l) => !l.includes('{{CODPERLETS}}')).join('\n');
  sql = sql.replace(/\{\{CODCOLIGADA\}\}/g, String(coligada)).replace(/\{\{CODPERLETS\}\}/g, periods.map((x) => `'${x}'`).join(', '));
  if (/\{\{\w+\}\}/.test(sql)) throw new Error(`Parâmetro sem valor na consulta de ${def.table}.`);
  checkSelect(sql);
  return sql;
}

// Só leitura: a sentença gravada no RM tem de ser um SELECT/WITH sem comandos de escrita (analisa fora de textos e comentários).
const WRITE_RE = /\b(INSERT|UPDATE|DELETE|MERGE|DROP|TRUNCATE|ALTER|CREATE|EXEC|EXECUTE|INTO|GRANT|REVOKE|DENY|BACKUP|RESTORE|DBCC|OPENROWSET|OPENQUERY|OPENDATASOURCE|WAITFOR|SHUTDOWN|KILL)\b/i;
function checkSelect(sql) {
  const code = String(sql).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').replace(/'(?:[^']|'')*'/g, "''");
  if (!/^\s*(SELECT|WITH)\b/i.test(code)) throw new Error('A consulta precisa começar com SELECT ou WITH.');
  const m = code.match(WRITE_RE);
  if (m) throw new Error(`Consulta bloqueada: contém ${m[1].toUpperCase()}.`);
  if (/;\s*\S/.test(code)) throw new Error('Consulta bloqueada: mais de um comando.');
  return true;
}

// ---------- Contagem e divisão em partes (para o RM Host nunca montar uma resposta gigante) ----------
// Valores lidos na hora (não congelados no require) para os testes poderem usar partes pequenas.
const LIMITS = { rowsPerPart: 200000, bigTable: 2000000, maxParts: 500 };
const COL_RE = /^[A-Z][A-Z0-9_]{0,127}$/;

// Colunas que a consulta devolve (lista entre o SELECT e o FROM de nível 0; usa o alias do AS ou o nome depois do ponto).
function outputColumns(sql) {
  const s = String(sql);
  let depth = 0; let start = -1; let end = -1;
  const re = /\(|\)|\bSELECT\b|\bFROM\b/gi;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const t = m[0].toUpperCase();
    if (t === '(') depth++; else if (t === ')') depth--;
    else if (t === 'SELECT' && depth === 0 && start < 0) start = m.index + 6;
    else if (t === 'FROM' && depth === 0 && start >= 0) { end = m.index; break; }
  }
  if (start < 0 || end < 0) return [];
  const items = []; let cur = ''; depth = 0;
  for (const ch of s.slice(start, end)) {
    if (ch === '(') depth++; if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { items.push(cur); cur = ''; } else cur += ch;
  }
  items.push(cur);
  return items.map((x) => { const t = x.trim(); const a = t.match(/\bAS\s+\[?(\w+)\]?$/i); return (a ? a[1] : t.split('.').pop().replace(/[[\]]/g, '')).toUpperCase(); });
}

function partColumnOf(system, table) {
  const col = (system.parts || {})[table] || null;
  if (col && !COL_RE.test(col)) throw new Error(`Coluna de divisão inválida em ${table}: ${col}`);
  return col;
}
const wrap = (sql) => `FROM (\n${sql}\n) AS Q`;

// Contagem no RM (só SQL no banco do RM; o Host devolve uma linha): total, não nulos, menor e maior valor da coluna de divisão.
function statsSql(sql, col) {
  const out = col
    ? `SELECT COUNT_BIG(*) AS N, COUNT_BIG(Q.[${col}]) AS NN, MIN(Q.[${col}]) AS LO, MAX(Q.[${col}]) AS HI ${wrap(sql)}`
    : `SELECT COUNT_BIG(*) AS N ${wrap(sql)}`;
  checkSelect(out);
  return out;
}

// Partes a partir da contagem: faixas de mesmo tamanho entre LO e HI (+ uma parte para a coluna nula, se houver).
// Tabela pequena, sem coluna ou com valores não inteiros = uma parte só ({ kind: 'all' }).
function planParts(stats, col, limits = LIMITS) {
  const n = Number(stats && stats.N); const nn = Number(stats && stats.NN); const lo = Number(stats && stats.LO); const hi = Number(stats && stats.HI);
  if (!Number.isFinite(n) || n < 0) throw new Error('Contagem do RM inválida.');
  if (!col || n <= limits.rowsPerPart || !(nn > 0) || !Number.isSafeInteger(lo) || !Number.isSafeInteger(hi) || hi < lo) return [{ kind: 'all' }];
  const span = hi - lo + 1;
  const k = Math.min(span, limits.maxParts, Math.ceil(nn / limits.rowsPerPart));
  const width = Math.ceil(span / k);
  const parts = [];
  for (let a = lo; a <= hi; a += width) parts.push({ kind: 'range', lo: a, hi: Math.min(hi, a + width - 1) });
  if (n > nn) parts.push({ kind: 'null' });
  return parts;
}

// Sentença de uma parte. A consulta do modelo vira uma tabela derivada (Q) e o filtro da faixa vai na coluna de divisão.
function partSql(sql, col, part) {
  if (!part || part.kind === 'all') return sql;
  if (!COL_RE.test(String(col))) throw new Error(`Coluna de divisão inválida: ${col}`);
  let where;
  if (part.kind === 'range') {
    if (!Number.isSafeInteger(part.lo) || !Number.isSafeInteger(part.hi)) throw new Error('Faixa de divisão inválida.');
    where = `Q.[${col}] BETWEEN ${part.lo} AND ${part.hi}`;
  } else if (part.kind === 'null') where = `Q.[${col}] IS NULL`;
  else throw new Error('Parte desconhecida.');
  const out = `SELECT * ${wrap(sql)} WHERE ${where}`;
  checkSelect(out);
  return out;
}
const partLabel = (p) => (p.kind === 'range' ? `${p.lo}–${p.hi}` : p.kind === 'null' ? 'sem valor' : 'inteira');

function systemOf(id) {
  const s = SYSTEMS[String(id || 'educacional')];
  if (!s) throw new Error('Sistema desconhecido.');
  if (!s.ready) throw new Error(`O modelo do ${s.name} ainda não está disponível nesta versão.`);
  return s;
}

// Tabelas escolhidas (na ordem do modelo). Vazio = todas.
function pickTables(system, names) {
  const want = new Set((names || []).map((n) => String(n).toUpperCase()));
  const out = system.tables.filter((t) => !want.size || want.has(t.table));
  if (want.size && out.length !== want.size) throw new Error(`Tabela fora do modelo: ${[...want].filter((n) => !system.tables.some((t) => t.table === n)).join(', ')}`);
  return out;
}

// Origem (tabela da carga) de uma consulta de validação: o primeiro FROM.
const sourceOf = (sql) => (String(sql).match(/\bFROM\s+\[?(\w+)\]?/i) || [])[1] || null;

// ---------- Complemento (porta do gera_complemento.py) ----------
// Mesmo valor vindo do TXT ou da base vira o mesmo texto: 8 = 8.0 = '8'; 07:00 = 07:00:00; datas em AAAA-MM-DD.
const DATA_ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[ T]00:00(?::00(?:\.0+)?)?)?$/;
const DATA_BR = /^(\d{2})\/(\d{2})\/(\d{4})(?: 00:00(?::00)?)?$/;
const HORA = /^(\d{1,2}):(\d{2})(?::00(?:\.0+)?)?$/;
function norm(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number' && Number.isInteger(v)) v = String(v);
  else if (typeof v === 'number' && Number.isInteger(Number(v.toFixed(6)))) v = String(Math.round(v));
  let s = String(v).trim().toUpperCase();
  if (/^\d+$/.test(s)) return String(BigInt(s));
  if (/^\d+\.0+$/.test(s)) return String(BigInt(s.split('.')[0]));
  let m = s.match(DATA_ISO); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(DATA_BR); if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = s.match(HORA); if (m) return `${String(Number(m[1])).padStart(2, '0')}:${m[2]}`;
  return s;
}

const decoder = new TextDecoder('windows-1252');
// Linhas de um TXT do Hop (bytes preservados) e a quebra usada.
function splitTxt(buf) {
  const crlf = buf.includes(Buffer.from('\r\n'));
  const sep = Buffer.from(crlf ? '\r\n' : '\n');
  const lines = []; let start = 0;
  for (let i = buf.indexOf(sep); i !== -1; i = buf.indexOf(sep, start)) { lines.push(buf.subarray(start, i)); start = i + sep.length; }
  if (start < buf.length) lines.push(buf.subarray(start));
  return { lines: lines.filter((l) => l.toString('latin1').trim()), eol: sep };
}
function keyOf(line, positions) {
  const fields = decoder.decode(line).split(';');
  return positions.map((p) => norm(p < fields.length ? fields[p] : '')).join('\u0001');
}

// rmRows: linhas da tabela do RM gravada na base (objetos com as colunas da chave, CODCOLIGADA e as do filtro).
// Devolve as linhas do TXT cuja chave não está no RM + contagens e avisos (os mesmos do script).
function computeComplement(def, txtBuf, rmRows, coligada) {
  const { lines, eol } = splitTxt(txtBuf);
  const keys = lines.map((l) => keyOf(l, def.positions));
  const rm = new Map();
  for (const r of rmRows || []) {
    if ('CODCOLIGADA' in r && norm(r.CODCOLIGADA) !== String(coligada)) continue;
    if (Object.entries(def.filter || {}).some(([c, v]) => norm(r[c]) !== norm(v))) continue;
    const k = def.columns.map((c) => norm(r[c])).join('\u0001');
    rm.set(k, (rm.get(k) || 0) + 1);
  }
  const missing = []; const txtCount = new Map();
  lines.forEach((l, i) => { txtCount.set(keys[i], (txtCount.get(keys[i]) || 0) + 1); if (!rm.has(keys[i])) missing.push(l); });
  const txtKeys = new Set(keys);
  const onlyRm = [...rm.keys()].filter((k) => !txtKeys.has(k)).length;
  const dupRm = [...rm.values()].reduce((n, x) => n + (x > 1 ? x - 1 : 0), 0);
  const dupTxt = [...txtCount.values()].reduce((n, x) => n + (x > 1 ? x - 1 : 0), 0);
  const warnings = [];
  if (rm.size && lines.length && missing.length === lines.length) warnings.push('Nenhuma chave do TXT bateu com o RM. Confira a tabela do RM na base (colunas/formato) antes de importar.');
  if (dupRm) warnings.push(`${dupRm} linha(s) repetida(s) no RM (mesma chave). Confira se é duplicidade de importação.`);
  if (onlyRm) warnings.push(`${onlyRm} chave(s) no RM que não estão no TXT (cadastro manual ou linha que saiu da origem).`);
  if (dupTxt) warnings.push(`${dupTxt} linha(s) com chave repetida no próprio TXT.`);
  const content = missing.length ? Buffer.concat([...missing.flatMap((l) => [l, eol])]) : null;
  return { inRm: rm.size, txtLines: lines.length, toLoad: missing.length, onlyRm, dupRm, dupTxt, warnings, content };
}

module.exports = { SYSTEMS, PREFIX, MARKER, CODE_RE, TABLE_RE, consultaCode, cleanParams, renderRm, checkSelect, systemOf, pickTables, sourceOf, norm, splitTxt, keyOf, computeComplement, crc32,
  LIMITS, outputColumns, partColumnOf, statsSql, planParts, partSql, partLabel };
