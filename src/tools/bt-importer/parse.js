// Leitura de arquivos .bt — reprodução FIEL do `BtFileImporter.import_file` do app de referência "bt sql gui"
// (Ferramentas Auxiliares\conversor_bt_sql_gui\app.py). Não inventar regra aqui: qualquer mudança precisa continuar
// passando no teste de paridade (test/bt-importer-parity.test.js, gerado a partir do app original).
//
// Formato: texto ISO-8859-1 com vários blocos
//   [EPG]                    ← nome da tabela
//   [CODIGO:s;NOME:s;...]    ← cabeçalho (só se a linha tiver ':' ou ';'); o que vem depois de ':' é ignorado
//   001|FULANO|...           ← linhas separadas por '|'
// Valores: `$XX` (hex) → caractere latin-1; depois '@' e '' viram NULL. Todas as colunas são texto.
const fs = require('fs');
const crypto = require('crypto');

// Espaços que o str.strip() do Python remove dentro da faixa latin-1 (o JS trim() não remove \x1c-\x1f nem \x85).
const PY_WS = new Set([9, 10, 11, 12, 13, 28, 29, 30, 31, 32, 0x85, 0xa0]);
function pyStrip(s) {
  let a = 0; let b = s.length;
  while (a < b && PY_WS.has(s.charCodeAt(a))) a++;
  while (b > a && PY_WS.has(s.charCodeAt(b - 1))) b--;
  return a === 0 && b === s.length ? s : s.slice(a, b);
}

const DECODE_RE = /\$([A-Fa-f0-9]{2})/g;
const decodeSpecial = (v) => (typeof v === 'string' && v.includes('$') ? v.replace(DECODE_RE, (_, hex) => String.fromCharCode(parseInt(hex, 16))) : v);

// Valor final de uma célula (build_dataframe): decodifica e transforma '@' / '' em NULL.
function cellValue(v) {
  if (v === null || v === undefined) return null;
  const d = decodeSpecial(v);
  return d === '@' || d === '' ? null : d;
}

// make_unique_fields: nomes não vazios e únicos, ignorando maiúsculas/minúsculas.
function makeUniqueFields(fields) {
  const used = new Set();
  return fields.map((field, i) => {
    const base = pyStrip(field || '') || `COLUNA_${i + 1}`;
    let candidate = base;
    for (let suffix = 2; used.has(candidate.toLowerCase()); suffix++) candidate = `${base}_${suffix}`;
    used.add(candidate.toLowerCase());
    return candidate;
  });
}

// normalize_row: tira '|' vazios excedentes do fim, completa com NULL ou corta o excesso. Devolve [partes, malformada].
function normalizeRow(parts, n) {
  while (parts.length > n && parts.length && parts[parts.length - 1] === '') parts.pop();
  if (parts.length < n) { while (parts.length < n) parts.push(null); return [parts, true]; }
  if (parts.length > n) return [parts.slice(0, n), true];
  return [parts, false];
}

// Máquina de estados de uma linha (sem o fim de linha). Mesmas decisões, na mesma ordem, do import_file original.
// handlers: isAllowed(table) · onBlock(table) (novo bloco; o lote anterior já foi descarregado) · onRow(values) (linha pronta).
class BtLineParser {
  constructor({ isAllowed = () => true } = {}) {
    this.isAllowed = isAllowed;
    this.table = null;
    this.fields = null;
    this.encountered = new Set();
    this.malformed = 0;
  }

  // Devolve: null (linha ignorada), { block: true } (novo bloco), { header: true } ou { row: valores }.
  line(raw) {
    const marker = pyStrip(raw);
    if (!marker) return null;
    if (marker.startsWith('[') && marker.endsWith(']')) {
      const content = marker.slice(1, -1);
      if (this.table && this.fields === null && (content.includes(':') || content.includes(';'))) {
        this.fields = makeUniqueFields(content.split(';').map((f) => f.split(':')[0]));
        return { header: true };
      }
      this.table = pyStrip(content);
      this.fields = null;
      if (this.table) this.encountered.add(this.table);
      return { block: true };
    }
    if (!this.table || !this.fields || !this.isAllowed(this.table)) return null;
    const [parts, bad] = normalizeRow(raw.split('|'), this.fields.length);
    if (bad) this.malformed++;
    return { row: parts.map(cellValue) };
  }
}

// Lê o arquivo em streaming (latin-1, fins de linha universais como o modo texto do Python: \r\n, \r e \n) e calcula o
// SHA-256 do conteúdo no caminho. `onLine` pode devolver uma Promise (ex.: gravar um lote) — a leitura espera (contrapressão).
async function streamLines(filePath, onLine, { onChunk, shouldStop, chunkSize = 1 << 20 } = {}) {
  const hash = crypto.createHash('sha256');
  let carry = '';
  let bytes = 0;
  let sawNul = false;
  const stream = fs.createReadStream(filePath, { highWaterMark: chunkSize });
  try {
    for await (const chunk of stream) {
      hash.update(chunk);
      bytes += chunk.length;
      if (!sawNul && chunk.includes(0)) sawNul = true;
      const buf = carry + chunk.toString('latin1');
      let start = 0;
      for (let i = 0; i < buf.length; i++) {
        const c = buf.charCodeAt(i);
        if (c !== 10 && c !== 13) continue;
        if (c === 13 && i + 1 === buf.length) break; // \r no fim do pedaço: espera o próximo para saber se é \r\n
        const line = buf.slice(start, i);
        if (c === 13 && buf.charCodeAt(i + 1) === 10) i++;
        start = i + 1;
        const r = onLine(line);
        if (r && typeof r.then === 'function') await r;
      }
      carry = buf.slice(start);
      if (onChunk) onChunk(bytes);
      if (shouldStop && shouldStop()) { stream.destroy(); return { stopped: true, bytes, sha256: null, sawNul }; }
    }
    if (carry) {
      const r = onLine(carry.endsWith('\r') ? carry.slice(0, -1) : carry);
      if (r && typeof r.then === 'function') await r;
    }
  } finally {
    stream.destroy();
  }
  return { stopped: false, bytes, sha256: hash.digest('hex'), sawNul };
}

// Lê um arquivo inteiro com o parser, entregando lotes como o flush_batch original: na troca de bloco, a cada `batchSize`
// linhas e no fim do arquivo. Um lote pertence sempre a UM bloco (tabela + cabeçalho). onBatch(table, fields, rows) pode
// ser assíncrono (a leitura espera).
async function parseFile(filePath, { isAllowed, batchSize = 5000, onBatch, onChunk, shouldStop } = {}) {
  const p = new BtLineParser({ isAllowed });
  const size = Math.max(100, Number(batchSize) || 5000);
  let batch = []; let bTable = null; let bFields = null;
  const flush = async () => { const rows = batch; batch = []; if (rows.length && onBatch) await onBatch(bTable, bFields, rows); };
  const res = await streamLines(filePath, (line) => {
    const r = p.line(line);
    if (!r) return undefined;
    if (r.block) return batch.length ? flush() : undefined;
    if (!r.row) return undefined;
    if (!batch.length) { bTable = p.table; bFields = p.fields; }
    batch.push(r.row);
    return batch.length >= size ? flush() : undefined;
  }, { onChunk, shouldStop });
  if (!res.stopped) await flush();
  return { ...res, encountered: [...p.encountered], malformed: p.malformed };
}

// Reconhecimento do arquivo para a validação: blocos (tabela, cabeçalhos vistos, linhas), sem guardar nenhum dado.
// Conta todos os blocos; `allowed` diz quais serão importados (lista de tabelas permitidas).
async function scanFile(filePath, { isAllowed, onChunk, shouldStop } = {}) {
  const p = new BtLineParser();
  const tables = new Map(); // nome exato → { name, rows, fieldSets, allowed }
  let blockLines = 0; let ignoredLines = 0; // ignoradas = linhas com conteúdo fora de bloco ou de bloco sem cabeçalho
  const res = await streamLines(filePath, (line) => {
    const r = p.line(line);
    if (!r) { if (pyStrip(line)) ignoredLines++; return; }
    if (r.block) { blockLines++; return; }
    let t = tables.get(p.table);
    if (!t) { t = { name: p.table, rows: 0, fieldSets: [], allowed: isAllowed ? !!isAllowed(p.table) : true }; tables.set(p.table, t); }
    if (r.header) { if (!t.fieldSets.some((f) => f.join('\u0001') === p.fields.join('\u0001'))) t.fieldSets.push(p.fields); return; }
    t.rows++;
  }, { onChunk, shouldStop });
  return { ...res, blockLines, ignoredLines, encountered: [...p.encountered], malformed: p.malformed, tables: [...tables.values()] };
}

module.exports = { pyStrip, decodeSpecial, cellValue, makeUniqueFields, normalizeRow, BtLineParser, streamLines, parseFile, scanFile };
