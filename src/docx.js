// Escrita de .docx (Word) a partir do documento resolvido de src/docgen.js (title | paragraph | info | table | pagebreak).
// Sem disco: recebe/devolve Buffer. Com PAPEL TIMBRADO (um .docx da biblioteca): mantém o pacote dele inteiro (cabeçalho, rodapé, logo,
// estilos, fontes, margens) e troca só o CORPO pelo conteúdo gerado, preservando a seção final (sectPr). Sem papel timbrado: pacote
// mínimo próprio (A4, margens de 2 cm, Arial 10, número de página no rodapé). Usa jszip (já dependência do app).
const JSZip = require('jszip');

const MAIN_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const TEXT_WIDTH = 9638; // A4 (11906) − 2 × 1134 (2 cm)

// Texto → XML (sem caracteres de controle inválidos no XML).
const xmlText = (s) => String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
  .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function runs(text, { bold = false, size = null } = {}) {
  const rPr = bold || size ? `<w:rPr>${bold ? '<w:b/><w:bCs/>' : ''}${size ? `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>` : ''}</w:rPr>` : '';
  return String(text ?? '').split('\n').map((ln, i) => `<w:r>${rPr}${i ? '<w:br/>' : ''}<w:t xml:space="preserve">${xmlText(ln)}</w:t></w:r>`).join('');
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

// Larguras proporcionais ao conteúdo (limitadas), somando a largura útil da página.
function columnWidths(columns, rows) {
  const weight = columns.map((c, k) => Math.min(40, Math.max(8, Math.ceil(String(c).length * 0.6), ...rows.map((r) => String(r[k] ?? '').length))));
  const total = weight.reduce((a, b) => a + b, 0);
  return weight.map((w) => Math.round((TEXT_WIDTH * w) / total));
}

function bodyXml(doc) {
  const out = [];
  for (const b of doc.blocks) {
    if (b.type === 'pagebreak') out.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
    else if (b.type === 'title') out.push(para(runs(b.text, { bold: true, size: 24 }), { before: 240, after: 120, keepNext: true }));
    // Cada linha do parágrafo vira um parágrafo do Word (quebra de linha num texto justificado esticaria a linha).
    else if (b.type === 'paragraph') { const ls = String(b.text ?? '').split('\n'); ls.forEach((ln, i) => out.push(para(runs(ln), { jc: 'both', after: i === ls.length - 1 ? 120 : 0 }))); }
    else if (b.type === 'info') {
      const half = Math.round(TEXT_WIDTH / 2);
      const rows = b.rows.map((r) => `<w:tr>${r.map((c) => cell(r.length === 1 ? TEXT_WIDTH : half, para(`${runs(c.label, { bold: true })}${runs(c.value ? ` ${c.value}` : '')}`, { jc: 'left' }), { span: r.length === 1 ? 2 : 1 })).join('')}</w:tr>`).join('');
      out.push(tableXml([half, TEXT_WIDTH - half], rows), EMPTY_P);
    } else if (b.type === 'table') {
      const widths = columnWidths(b.columns, b.rows);
      const head = `<w:tr><w:trPr><w:tblHeader/><w:cantSplit/></w:trPr>${b.columns.map((c, k) => cell(widths[k], para(runs(c, { bold: true }), { jc: 'center' }), { shade: 'D9D9D9' })).join('')}</w:tr>`;
      const rows = b.rows.map((r) => `<w:tr><w:trPr><w:cantSplit/></w:trPr>${r.map((c, k) => cell(widths[k], para(runs(c), { jc: 'left' }))).join('')}</w:tr>`).join('');
      out.push(tableXml(widths, head + rows), EMPTY_P);
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
async function withBase(baseBuffer, body) {
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
  zip.file(docPath, xml.replace(m[0], () => `<w:body>${body}${sect}</w:body>`));
  return zip;
}

// doc = saída de docgen.render. base = Buffer do .docx de papel timbrado (opcional).
async function buildDocx(doc, { base = null, title = '' } = {}) {
  const body = bodyXml(doc);
  const zip = base ? await withBase(base, body) : defaultPackage(body, { title });
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = { buildDocx, bodyXml, xmlText };
