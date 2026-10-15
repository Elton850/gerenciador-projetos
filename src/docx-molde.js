// Formatação herdada do original ("molde"): lê o CORPO do .docx de papel timbrado e acha, pelo texto, o parágrafo/quadro/tabela que
// corresponde a cada bloco gerado — para o Word gerado sair com o mesmo estilo, fonte, cor, bordas, larguras e altura de linha do modelo
// original. Só leitura de XML (sem disco). Bloco sem correspondente → src/docx.js usa a formatação neutra com a fonte predominante do original.

// Elementos <w:tag> de nível superior (não aninhados num <w:tag> igual) — ex.: linhas da tabela sem as das tabelas internas.
function elements(xml, tag) {
  const re = new RegExp(`<(/?)w:${tag}(?=[\\s>/])[^>]*?(/?)>`, 'g');
  const out = []; let depth = 0; let start = -1; let m;
  while ((m = re.exec(xml))) {
    if (m[1]) { if (--depth === 0) out.push(xml.slice(start, re.lastIndex)); }
    else if (m[2]) { if (depth === 0) out.push(m[0]); }
    else { if (depth++ === 0) start = m.index; }
  }
  return out;
}
const first = (xml, tag) => (xml.match(new RegExp(`<w:${tag}(?:\\s[^>]*)?>[\\s\\S]*?</w:${tag}>|<w:${tag}(?:\\s[^>]*)?/>`)) || [''])[0];
const strip = (xml, tags) => tags.reduce((s, t) => s.replace(new RegExp(`<w:${t}(?:\\s[^>]*)?>[\\s\\S]*?</w:${t}>|<w:${t}(?:\\s[^>]*)?/>`, 'g'), ''), xml);
const textOf = (xml) => [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>/g)].map((m) => (m[1] === undefined ? '\t' : m[1])).join('')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const labelKey = (s) => norm(String(s || '').split(':')[0]);

// Parágrafo → { text, pPr, runs[{text, rPr}], markRPr } (pPr sem quebra de seção nem revisões; rPr sem revisões).
function paraInfo(p) {
  const pPrRaw = (p.match(/^<w:p(?:\s[^>]*)?>\s*(<w:pPr>[\s\S]*?<\/w:pPr>)/) || [])[1] || '';
  const pPr = strip(strip(pPrRaw, ['pPrChange']), ['sectPr']);
  const markRPr = strip(first(pPr, 'rPr'), ['rPrChange', 'ins', 'del']).replace(/<w:rPr\/>/, '');
  const runs = elements(p.replace(pPrRaw, ''), 'r').map((r) => ({ text: textOf(r), rPr: strip(first(r, 'rPr'), ['rPrChange']) }));
  return { text: runs.map((r) => r.text).join(''), pPr, runs, markRPr };
}
const cellInfo = (tc) => {
  const ps = elements(tc, 'p');
  const p = ps.length ? paraInfo(ps[0]) : { text: '', pPr: '', runs: [], markRPr: '' };
  return { ...p, tcPr: strip(first(tc, 'tcPr'), ['tcPrChange', 'vMerge', 'hMerge']), text: ps.map((x) => paraInfo(x).text).join('\n') };
};

// Linhas/parágrafos copiados inteiros do original: sem marcadores/ids que não podem se repetir no documento.
const cleanCopy = (xml) => xml.replace(/<w:(bookmarkStart|bookmarkEnd|commentRangeStart|commentRangeEnd|proofErr|permStart|permEnd)\b[^>]*\/>/g, '').replace(/\s(w14:paraId|w14:textId|w:rsid\w*)="[^"]*"/g, '');
// Parágrafo vazio de espaçamento (sem quebra de página/seção nem imagem): copiado depois do bloco, como no original.
const isSpacer = (p) => !textOf(p).trim() && !/w:type="page"|<w:sectPr|<w:drawing|<w:pict|<w:object/.test(p);
const MAX_SPACERS = 3;

// Lê o corpo do documento base. sectPr = seção final (largura útil da página).
function harvest(bodyInner, sectPr = '') {
  // Ordem de nível superior (tabelas e parágrafos fora delas) para saber os parágrafos vazios logo depois de cada elemento.
  const seq = []; let cursor = 0;
  for (const t of elements(bodyInner, 'tbl')) {
    const i = bodyInner.indexOf(t, cursor);
    for (const p of elements(bodyInner.slice(cursor, i), 'p')) seq.push({ p });
    seq.push({ t }); cursor = i + t.length;
  }
  for (const p of elements(bodyInner.slice(cursor), 'p')) seq.push({ p });
  const after = (i) => { const out = []; for (let k = i + 1; k < seq.length && seq[k].p && isSpacer(seq[k].p) && out.length < MAX_SPACERS; k++) out.push(cleanCopy(seq[k].p)); return out; };
  const tables = seq.map((x, i) => (x.t ? { t: x.t, aft: after(i) } : null)).filter(Boolean).map(({ t, aft }) => {
    const rows = elements(t, 'tr').map((tr) => {
      const cells = elements(tr, 'tc').map(cellInfo);
      return { xml: tr, trPr: first(tr.slice(0, tr.search(/<w:tc[\s>]/) >>> 0), 'trPr'), cells, text: cells.map((c) => c.text).join('').trim() };
    });
    return { tblPr: strip(first(t, 'tblPr'), ['tblPrChange']), grid: [...(first(t, 'tblGrid').matchAll(/<w:gridCol\b[^>]*w:w="(\d+)"/g))].map((m) => Number(m[1])), rows, after: aft };
  });
  const paragraphs = seq.map((x, i) => (x.p ? { ...paraInfo(x.p), after: after(i) } : null)).filter((p) => p && p.text.trim()).map((p) => ({ ...p, norm: norm(p.text) }));
  const fonts = {};
  for (const m of bodyInner.matchAll(/<w:rFonts\b[^>]*\/>/g)) fonts[m[0]] = (fonts[m[0]] || 0) + 1;
  const font = Object.entries(fonts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const pgW = Number((sectPr.match(/<w:pgSz\b[^>]*w:w="(\d+)"/) || [])[1]);
  const mar = (k) => Number((sectPr.match(new RegExp(`<w:pgMar\\b[^>]*w:${k}="(\\d+)"`)) || [])[1]) || 0;
  const textWidth = pgW ? pgW - mar('left') - mar('right') : null;
  return { paragraphs, tables, font, textWidth };
}

// Parágrafo do original para um título/parágrafo: o primeiro trecho FIXO do bloco (≥ 3 letras) abre o texto do original.
function findParagraph(molde, parts) {
  const fixed = parts.find((p) => !p.isVar && norm(p.raw).length >= 3);
  if (!fixed || parts.indexOf(fixed) > 1) return null;
  const key = norm(fixed.raw);
  return molde.paragraphs.find((p) => p.norm.startsWith(key)) || molde.paragraphs.find((p) => key.length >= 12 && p.norm.includes(key)) || null;
}
// Quadro "Rótulo: valor": tabela do original com uma linha cujo 1º rótulo = 1º rótulo do quadro gerado.
function findInfoTable(molde, rows) {
  const key = labelKey(rows[0]?.[0]?.label);
  return key ? molde.tables.find((t) => t.rows.some((r) => r.cells.length && labelKey(r.cells[0].text) === key)) || null : null;
}
// Tabela: a linha de cabeçalho do original (1ª linha com texto) começa com a mesma 1ª coluna.
function findTable(molde, columns) {
  const key = norm(columns[0]);
  for (const t of molde.tables) {
    const h = t.rows.findIndex((r) => r.text);
    if (h >= 0 && key && norm(t.rows[h].cells[0]?.text) === key) return { table: t, header: h };
  }
  return null;
}

module.exports = { cleanCopy, harvest, findParagraph, findInfoTable, findTable, elements, labelKey, norm };
