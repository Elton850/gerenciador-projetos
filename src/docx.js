// Escrita de .docx (Word) a partir do documento resolvido de src/docgen.js (title | paragraph | info | table | pagebreak).
// Sem disco: recebe/devolve Buffer. Com PAPEL TIMBRADO (um .docx da biblioteca): mantém o pacote dele inteiro (cabeçalho, rodapé, logo,
// estilos, fontes, margens) e troca só o CORPO pelo conteúdo gerado, preservando a seção final (sectPr). Sem papel timbrado: pacote
// mínimo próprio (A4, margens de 2 cm, Arial 10, número de página no rodapé). Usa jszip (já dependência do app).
// Com papel timbrado, cada bloco também copia a formatação do elemento equivalente no corpo do original (src/docx-molde.js).
const JSZip = require('jszip');
const DM = require('./docx-molde');

const MAIN_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const TEXT_WIDTH = 9638; // A4 (11906) − 2 × 1134 (2 cm)

// Texto → XML (sem caracteres de controle inválidos no XML).
const xmlText = (s) => String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
  .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// font = <w:rFonts/> predominante do papel timbrado (blocos sem molde); run(text, rPr) = formatação pronta copiada do original.
const run = (text, rPr = '') => String(text ?? '').split('\n').map((ln, i) => `<w:r>${rPr}${i ? '<w:br/>' : ''}<w:t xml:space="preserve">${xmlText(ln)}</w:t></w:r>`).join('');
function runs(text, { bold = false, size = null, font = null } = {}) {
  const rPr = bold || size || font ? `<w:rPr>${font || ''}${bold ? '<w:b/><w:bCs/>' : ''}${size ? `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>` : ''}</w:rPr>` : '';
  return run(text, rPr);
}
const para = (inner, { jc = null, before = 0, after = 0, keepNext = false } = {}) =>
  `<w:p><w:pPr>${keepNext ? '<w:keepNext/>' : ''}<w:spacing w:before="${before}" w:after="${after}"/>${jc ? `<w:jc w:val="${jc}"/>` : ''}</w:pPr>${inner}</w:p>`;
const EMPTY_P = '<w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr></w:p>';

const BORDERS = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((b) => `<w:${b} w:val="single" w:sz="4" w:space="0" w:color="808080"/>`).join('');
function tableXml(widths, rowsXml) {
  return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${BORDERS}</w:tblBorders><w:tblLayout w:type="autofit"/>`
    + '<w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar>'
    + `<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr><w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${rowsXml}</w:tbl>`;
}
const cell = (width, inner, { span = 1, shade = null } = {}) =>
  `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ''}${shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${shade}"/>` : ''}<w:vAlign w:val="center"/></w:tcPr>${inner}</w:tc>`;

// Larguras proporcionais ao conteúdo (limitadas), somando a largura informada (padrão: largura útil da página).
function columnWidths(columns, rows, total = TEXT_WIDTH) {
  // Cabeçalho pode quebrar entre palavras, nunca dentro delas: conta a maior palavra.
  const weight = columns.map((c, k) => Math.min(40, Math.max(8, Math.max(...String(c).split(/\s+/).map((w) => w.length)) + 2, ...rows.map((r) => String(r[k] ?? '').length))));
  const sum = weight.reduce((a, b) => a + b, 0);
  return weight.map((w) => Math.round((total * w) / sum));
}

// ---------- Formatação neutra (sem papel timbrado, ou bloco sem correspondente no original) ----------
const plainTitle = (b, font) => para(runs(b.text, { bold: true, size: 24, font }), { before: 240, after: 120, keepNext: true });
// Cada linha do parágrafo vira um parágrafo do Word (quebra de linha num texto justificado esticaria a linha).
const plainParagraph = (b, font) => { const ls = String(b.text ?? '').split('\n'); return ls.map((ln, i) => para(runs(ln, { font }), { jc: 'both', after: i === ls.length - 1 ? 120 : 0 })).join(''); };
const HALF = Math.round(TEXT_WIDTH / 2);
const infoRowPlain = (r, font) => `<w:tr>${r.map((c) => cell(r.length === 1 ? TEXT_WIDTH : HALF, para(`${runs(c.label, { bold: true, font })}${runs(c.value ? ` ${c.value}` : '', { font })}`, { jc: 'left' }), { span: r.length === 1 ? 2 : 1 })).join('')}</w:tr>`;
const plainInfo = (b, font) => tableXml([HALF, TEXT_WIDTH - HALF], b.rows.map((r) => infoRowPlain(r, font)).join(''));
function plainTable(b, font) {
  const widths = columnWidths(b.columns, b.rows);
  const head = `<w:tr><w:trPr><w:tblHeader/><w:cantSplit/></w:trPr>${b.columns.map((c, k) => cell(widths[k], para(runs(c, { bold: true, font }), { jc: 'center' }), { shade: 'D9D9D9' })).join('')}</w:tr>`;
  const rows = b.rows.map((r) => `<w:tr><w:trPr><w:cantSplit/></w:trPr>${r.map((c, k) => cell(widths[k], para(runs(c, { font }), { jc: 'left' }))).join('')}</w:tr>`).join('');
  return tableXml(widths, head + rows);
}

// ---------- Formatação copiada do original (molde) ----------
const { cleanCopy } = DM;
// Sem negrito EXPLÍCITO (o estilo da tabela/parágrafo do original pode ligar o negrito); ordem do rPr: rStyle, rFonts, b, bCs…
const unbold = (rPr) => {
  const r = (rPr || '<w:rPr></w:rPr>').replace(/<w:b(?:Cs)?(?:\s+w:val="[^"]*")?\/>/g, '');
  const off = '<w:b w:val="0"/><w:bCs w:val="0"/>';
  const m = r.match(/^<w:rPr>(?:<w:rStyle\b[^>]*\/>)?(?:<w:rFonts\b[^>]*\/>)?/);
  return m ? r.slice(0, m[0].length) + off + r.slice(m[0].length) : r;
};
const textRPr = (c) => c?.runs.find((r) => r.text.trim())?.rPr || null;
// Valor do quadro: o trecho depois do rótulo (que termina em “:”) no original; sem valor no original → o rótulo sem negrito.
function valueRPr(mc, labelRPr) {
  let seen = ''; let afterLabel = false;
  for (const r of mc.runs) {
    if (afterLabel && r.text.trim()) return r.rPr;
    seen += r.text; if (seen.includes(':')) afterLabel = true;
  }
  return unbold(labelRPr);
}

// Título/parágrafo: estilo do parágrafo original; cada trecho fixo leva a formatação do trecho igual no original e cada variável a do
// trecho que ela ocupa no original (ex.: o marco em negrito itálico). Texto que não se alinha → formatação do 1º trecho do original.
function moldeParagraph(b, mp) {
  const rs = mp.runs.filter((r) => r.text);
  const base = rs.map((r) => r.text).join('');
  const offs = []; let o = 0; for (const r of rs) { offs.push(o); o += r.text.length; }
  const at = (pos) => { let k = 0; while (k + 1 < rs.length && offs[k + 1] <= pos) k++; return k; };
  const rPrAt = (pos) => (rs.length ? rs[at(pos)].rPr : mp.markRPr);
  const dflt = rs[0]?.rPr || mp.markRPr;
  const segs = []; const pending = []; let pos = 0; let ok = rs.length > 0;
  const flush = (rPr) => { for (const v of pending.splice(0)) segs.push({ text: v.text, rPr }); };
  for (const part of b.parts || [{ raw: b.text, text: b.text, isVar: false }]) {
    if (part.isVar) { pending.push(part); continue; }
    const idx = ok ? base.indexOf(part.raw, pos) : -1;
    if (idx < 0) { ok = false; flush(dflt); segs.push({ text: part.text, rPr: dflt }); continue; }
    flush(idx > pos ? rPrAt(pos) : rPrAt(Math.max(0, pos - 1)));
    for (let k = idx, end = idx + part.raw.length; k < end;) { const r = at(k); const stop = Math.min(end, offs[r] + rs[r].text.length); segs.push({ text: base.slice(k, stop), rPr: rs[r].rPr }); k = stop; }
    pos = idx + part.raw.length;
  }
  flush(ok && pos < base.length ? rPrAt(pos) : ok && pos > 0 ? rPrAt(pos - 1) : dflt);
  const paras = [[]];
  for (const sg of segs) String(sg.text).split('\n').forEach((t, i) => { if (i) paras.push([]); if (t) paras[paras.length - 1].push(run(t, sg.rPr)); });
  return paras.map((rx) => `<w:p>${mp.pPr}${rx.join('')}</w:p>`).join('');
}

const gridXml = (grid) => `<w:tblGrid>${grid.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>`;
// Quadro "Rótulo: valor": bordas/larguras/faixa decorativa do quadro original; cada linha usa a linha original de mesmo rótulo
// (senão a primeira com o mesmo número de células).
function moldeInfo(b, mt, font) {
  const out = [];
  for (const r of mt.rows) { if (r.text) break; out.push(cleanCopy(r.xml)); } // linhas sem texto no topo (faixa decorativa)
  const textual = mt.rows.filter((r) => r.text);
  for (const row of b.rows) {
    const mr = textual.find((r) => r.cells.length === row.length && DM.labelKey(r.cells[0].text) === DM.labelKey(row[0].label)) || textual.find((r) => r.cells.length === row.length);
    if (!mr) { out.push(infoRowPlain(row, font)); continue; }
    out.push(`<w:tr>${mr.trPr}${row.map((c, k) => {
      const mc = mr.cells[k];
      const labelRPr = textRPr(mc) || mc.markRPr || '';
      return `<w:tc>${mc.tcPr}<w:p>${mc.pPr}${c.label ? run(c.label, labelRPr) : ''}${c.value ? run(` ${c.value}`, valueRPr(mc, labelRPr)) : ''}</w:p></w:tc>`;
    }).join('')}</w:tr>`);
  }
  return `<w:tbl>${mt.tblPr}${gridXml(mt.grid)}${out.join('')}</w:tbl>`;
}
// Tabela: cabeçalho e linhas com a formatação das linhas originais (linha i → linha i do original; além dela, a última).
// Colunas a mais que o original copiam o formato da última coluna; larguras recalculadas na proporção do conteúdo.
function moldeTable(b, found, textWidth) {
  const { table: mt, header: h } = found;
  const hdr = mt.rows[h]; const data = mt.rows.slice(h + 1).filter((r) => r.cells.length);
  const nb = hdr.cells.length; const n = b.columns.length;
  let grid = mt.grid; let tblPr = mt.tblPr; let fix = false;
  if (n !== nb || grid.length !== n) {
    const total = grid.reduce((a, x) => a + x, 0) || TEXT_WIDTH;
    const newTotal = Math.min(textWidth || TEXT_WIDTH, Math.round((total * n) / Math.max(1, nb)));
    grid = columnWidths(b.columns, b.rows, newTotal); fix = true;
    tblPr = tblPr.replace(/<w:tblW\b[^>]*\/>/, (m) => (/w:type="dxa"/.test(m) ? `<w:tblW w:w="${newTotal}" w:type="dxa"/>` : m));
  }
  const tcPrOf = (mc, k) => {
    if (!fix) return mc.tcPr || `<w:tcPr><w:tcW w:w="${grid[k]}" w:type="dxa"/></w:tcPr>`;
    const t = (mc.tcPr || '<w:tcPr></w:tcPr>').replace(/<w:gridSpan\b[^>]*\/>/g, '').replace(/<w:tcW\b[^>]*\/>/, '');
    return t.replace(/^<w:tcPr>/, `<w:tcPr><w:tcW w:w="${grid[k]}" w:type="dxa"/>`);
  };
  // Célula vazia no original: o texto segue a formatação da própria linha (ex.: nome do processo em negrito) ou, sem texto na linha,
  // a do cabeçalho da coluna — a marca de parágrafo de célula vazia costuma ser instrução do modelo (ex.: vermelho itálico).
  const rPrFor = (mc, mr, k) => textRPr(mc) || mr.cells.map(textRPr).find(Boolean) || textRPr(hdr.cells[Math.min(k, nb - 1)]) || mc.markRPr || '';
  const rowX = (r, mr) => `<w:tr>${mr.trPr}${r.map((c, k) => {
    const mc = mr.cells[Math.min(k, mr.cells.length - 1)];
    return `<w:tc>${tcPrOf(mc, k)}<w:p>${mc.pPr}${c ? run(c, rPrFor(mc, mr, k)) : ''}</w:p></w:tc>`;
  }).join('')}</w:tr>`;
  const rows = b.rows.map((r, i) => rowX(r, data.length ? data[Math.min(i, data.length - 1)] : hdr));
  return `<w:tbl>${tblPr}${gridXml(grid)}${rowX(b.columns, hdr)}${rows.join('')}</w:tbl>`;
}

// Corpo do documento. molde = DM.harvest do papel timbrado (opcional): sem ele, só a formatação neutra.
function bodyXml(doc, molde = null) {
  const font = molde?.font || null;
  const out = [];
  for (const b of doc.blocks) {
    if (b.type === 'pagebreak') out.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
    else if (b.type === 'title' || b.type === 'paragraph') {
      const mp = molde && DM.findParagraph(molde, b.parts || []);
      // + os parágrafos vazios que vinham depois dele no original (espaçamento igual ao do modelo)
      out.push(mp ? moldeParagraph(b, mp) + mp.after.join('') : b.type === 'title' ? plainTitle(b, font) : plainParagraph(b, font));
    } else if (b.type === 'info') {
      const mt = molde && DM.findInfoTable(molde, b.rows);
      out.push(mt ? moldeInfo(b, mt, font) + (mt.after.join('') || EMPTY_P) : plainInfo(b, font) + EMPTY_P);
    } else if (b.type === 'table') {
      const found = molde && DM.findTable(molde, b.columns);
      out.push(found ? moldeTable(b, found, molde.textWidth) + (found.table.after.join('') || EMPTY_P) : plainTable(b, font) + EMPTY_P);
    }
  }
  return out.join('');
}

// ---------- Pacote mínimo (sem papel timbrado) ----------
function defaultPackage(body, { title = '' } = {}) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    + '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>'
    + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>');
  zip.file('word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>');
  zip.file('word/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${MAIN_NS}"><w:docDefaults><w:rPrDefault><w:rPr>`
    + '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Arial" w:cs="Arial"/><w:sz w:val="20"/><w:szCs w:val="20"/><w:lang w:val="pt-BR" w:eastAsia="pt-BR" w:bidi="ar-SA"/>'
    + '</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
    + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
    + '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>');
  zip.file('word/footer1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr xmlns:w="${MAIN_NS}"><w:p><w:pPr><w:jc w:val="right"/></w:pPr>`
    + '<w:r><w:rPr><w:sz w:val="16"/></w:rPr><w:t xml:space="preserve">Página </w:t></w:r><w:fldSimple w:instr="PAGE"><w:r><w:rPr><w:sz w:val="16"/></w:rPr><w:t>1</w:t></w:r></w:fldSimple></w:p></w:ftr>');
  zip.file('docProps/core.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
    + 'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
    + `<dc:title>${xmlText(title)}</dc:title><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</dcterms:created></cp:coreProperties>`);
  const sect = '<w:sectPr><w:footerReference w:type="default" r:id="rId2"/><w:pgSz w:w="11906" w:h="16838"/>'
    + '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr>';
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${MAIN_NS}" xmlns:r="${REL_NS}"><w:body>${body}${sect}</w:body></w:document>`);
  return zip;
}

// ---------- Papel timbrado ----------
// Troca só o corpo do documento principal do .docx base; a seção final (cabeçalhos/rodapés/margens) fica. Erro → mensagem amigável.
async function withBase(baseBuffer, doc) {
  let zip;
  try { zip = await JSZip.loadAsync(baseBuffer); } catch { throw new Error('O papel timbrado não é um arquivo Word (.docx) válido.'); }
  const rels = await zip.file('_rels/.rels')?.async('string');
  const target = (rels?.match(/<Relationship\b[^>]*Type="[^"]*\/officeDocument"[^>]*>/)?.[0].match(/Target="([^"]+)"/) || [])[1] || 'word/document.xml';
  const docPath = target.replace(/^\//, '');
  const xml = await zip.file(docPath)?.async('string');
  const m = xml && xml.match(/<w:body>([\s\S]*)<\/w:body>/);
  if (!m) throw new Error('O papel timbrado não tem o corpo de um documento Word.');
  const inner = m[1];
  const at = inner.lastIndexOf('<w:sectPr');
  const tail = at >= 0 ? inner.slice(at).trim() : '';
  const sect = /^<w:sectPr\b[\s\S]*(<\/w:sectPr>|\/>)$/.test(tail) ? tail : '';
  const body = bodyXml(doc, DM.harvest(sect ? inner.slice(0, at) : inner, sect));
  zip.file(docPath, xml.replace(m[0], () => `<w:body>${body}${sect}</w:body>`));
  return zip;
}

// doc = saída de docgen.render. base = Buffer do .docx de papel timbrado (opcional).
async function buildDocx(doc, { base = null, title = '' } = {}) {
  const zip = base ? await withBase(base, doc) : defaultPackage(bodyXml(doc), { title });
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = { buildDocx, bodyXml, xmlText };
