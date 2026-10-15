// Documentos gerados: modelos (Roteiro Pós-Importação, Termo MIT010…) + dados do projeto → prévia → Word (.docx).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const JSZip = require('jszip');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-dg-'));
const PORT = 4407;
process.env.PORT = String(PORT);
process.env.GP_DATA_DIR = path.join(tmp, 'data');

const { app } = require('../server');
const G = require('../src/docgen');
const { applyDefaults } = require('../src/defaults');
const { SECTIONS } = require('../src/config-sync');
let server;
test.before(() => { server = app.listen(PORT, '127.0.0.1'); });
test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const base = `http://localhost:${PORT}`;
const api = async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Origin: base }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const ok = (r) => { assert.ok(r.status < 300, JSON.stringify(r.json)); return r.json; };
const download = async (url, body) => {
  const r = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body) });
  assert.equal(r.status, 200, await r.clone().text());
  return { res: r, zip: await JSZip.loadAsync(Buffer.from(await r.arrayBuffer())) };
};
const docText = (xml) => [...xml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('');
const MIT = 'dt-termo-validacao-mit010';
const ROT = 'dt-roteiro-pos-importacao';
const S = {};

test('carga: modelos padrão com ids fixos, idempotente; lista vazia (excluídos) não volta', () => {
  const d = applyDefaults({ projects: [] });
  assert.deepEqual(d.docTemplates.map((t) => t.id), [ROT, MIT]);
  assert.deepEqual(d.docGenerations, []);
  const again = applyDefaults(JSON.parse(JSON.stringify(d)));
  assert.deepEqual(again.docTemplates, d.docTemplates);
  assert.deepEqual(applyDefaults({ projects: [], docTemplates: [] }).docTemplates, []);
  // Modelos padrão passam na própria validação; nenhum dado de cliente neles.
  for (const t of d.docTemplates) G.cleanTemplate(t, d);
  assert.ok(SECTIONS.includes('docTemplates'), 'modelos de documentos são configuração compartilhável');
});

test('modelo: variável desconhecida, chave repetida e {{doc.x}} no valor inicial são recusados', () => {
  const d = applyDefaults({ projects: [] });
  const t = (extra) => ({ name: 'X', blocks: [{ type: 'paragraph', text: 'oi' }], ...extra });
  assert.throws(() => G.cleanTemplate(t({ blocks: [{ type: 'paragraph', text: '{{project.inventada}}' }] }), d), (e) => e.code === 'DOC_UNKNOWN_VARIABLE');
  assert.throws(() => G.cleanTemplate(t({ blocks: [{ type: 'paragraph', text: '{{doc.sem_campo}}' }] }), d), (e) => e.code === 'DOC_UNKNOWN_VARIABLE');
  assert.throws(() => G.cleanTemplate(t({ blocks: [{ type: 'paragraph', text: '{{hours.period}}' }] }), d), (e) => e.code === 'DOC_UNKNOWN_VARIABLE');
  assert.throws(() => G.cleanTemplate(t({ fields: [{ key: 'a', label: 'A' }, { key: 'a', label: 'B' }] }), d), /repetida/);
  assert.throws(() => G.cleanTemplate(t({ fields: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B', default: '{{doc.a}}' }] }), d), (e) => e.code === 'DOC_UNKNOWN_VARIABLE');
  assert.throws(() => G.cleanTemplate(t({ blocks: [] }), d), /ao menos um bloco/);
  const okT = G.cleanTemplate(t({ fields: [{ key: 'cliente', label: 'Cliente' }], blocks: [{ type: 'paragraph', text: '{{doc.cliente}} — {{project.name}}' }] }), d);
  assert.equal(okT.fields[0].type, 'text');
  assert.equal(G.fileNameFor('Termo - Cliente Alfa - 30/09/2026', 'x'), 'Termo - Cliente Alfa - 30-09-2026.docx');
  assert.equal(G.fileNameFor('Termo {{project.name}} - ', 'x'), 'Termo.docx');
});

test('preparo: projeto fictício', async () => {
  S.coord = ok(await api('POST', '/api/coordinators', { name: 'Carla Coord', email: 'carla@exemplo.test' }));
  S.anal = ok(await api('POST', '/api/coordinators', { name: 'Ana Analista', email: 'ana@exemplo.test' }));
  S.p = ok(await api('POST', '/api/projects', { name: 'Cliente Alfa', coordinatorId: S.coord.id, analystId: S.anal.id }));
  ok(await api('POST', `/api/projects/${S.p.id}/contacts`, { name: 'Bruno Cliente', email: 'bruno@exemplo.test', kind: 'client' }));
  const list = ok(await api('GET', '/api/doc-templates'));
  assert.deepEqual(list.templates.map((t) => t.id), [ROT, MIT]);
  assert.ok(list.variables.some((v) => v.key === 'project.coordinator'));
  assert.ok(!list.variables.some((v) => v.key.startsWith('hours.')));
});

test('formulário: dados do projeto preenchem os campos; o que o projeto não tem fica em branco', async () => {
  const f = ok(await api('POST', `/api/projects/${S.p.id}/doc-templates/${MIT}/form`));
  const v = Object.fromEntries(f.fields.map((x) => [x.key, x.value]));
  assert.equal(v.coordenador_totvs, 'Carla Coord');
  assert.equal(v.analista, 'Ana Analista');
  assert.equal(v.cliente, '');
  assert.equal(v.unidade, 'TOTVS Nordeste');
  assert.equal(f.last, null);
  assert.ok(f.people.includes('Bruno Cliente') && f.people.includes('Carla Coord'));
  const procs = f.template.tables.find((t) => t.columns[0] === 'Nome do Processo');
  assert.equal(f.tables[procs.index].length, 15);
  assert.equal(f.tables[procs.index][0][1], '{{doc.data}}', 'célula ligada ao campo continua como marcador');
  S.form = f;
});

test('prévia: escapa HTML, resolve campos nas tabelas e avisa campos em branco', async () => {
  const fields = Object.fromEntries(S.form.fields.map((x) => [x.key, x.value]));
  Object.assign(fields, { cliente: 'Cliente <b>Alfa</b>', data: '30/09/2026' });
  const r = ok(await api('POST', `/api/projects/${S.p.id}/doc-templates/${MIT}/preview`, { fields, tables: S.form.tables }));
  assert.ok(r.html.includes('Cliente &lt;b&gt;Alfa&lt;/b&gt;'));
  assert.ok(!r.html.includes('<b>Alfa'));
  assert.equal((r.html.match(/30\/09\/2026/g) || []).length >= 16, true, 'data no quadro e nas 15 linhas de processo');
  assert.ok(!r.html.includes('{{doc.'));
  assert.ok(r.warnings.some((w) => w.startsWith('Campos em branco:') && w.includes('Código de cliente')));
  assert.equal(r.fileName, 'Termo de Validação - MIT010 - Cliente Alfa - 30-09-2026.docx');
});

test('gerar: Word com o conteúdo, histórico registrado e próxima geração pré-preenchida', async () => {
  const fields = Object.fromEntries(S.form.fields.map((x) => [x.key, x.value]));
  Object.assign(fields, { cliente: 'Cliente Alfa SA', data: '30/09/2026', aprovado_por: 'Bruno Cliente' });
  const tables = JSON.parse(JSON.stringify(S.form.tables));
  const { res, zip } = await download(`/api/projects/${S.p.id}/doc-templates/${MIT}/generate`, { fields, tables });
  assert.match(res.headers.get('content-type'), /wordprocessingml/);
  assert.match(res.headers.get('content-disposition'), /filename\*=UTF-8''Termo%20de%20Valida%C3%A7%C3%A3o/);
  const xml = await zip.file('word/document.xml').async('string');
  const text = docText(xml);
  for (const s of ['Ambientação', 'Cliente Alfa SA', 'Carla Coord', 'Carga de dados de funcionários', 'Carga de dados da ficha financeira', 'Bruno Cliente', 'Aceite']) assert.ok(text.includes(s), s);
  assert.ok(!text.includes('{{'));
  assert.ok(zip.file('word/styles.xml') && zip.file('word/footer1.xml'), 'pacote padrão completo');
  const g = ok(await api('GET', `/api/projects/${S.p.id}/doc-templates`));
  assert.equal(g.generations.length, 1);
  assert.equal(g.generations[0].templateName, 'Termo de Validação MIT010');
  // Mesmo modelo: volta tudo; outro modelo: campos de mesma chave (cliente) vêm da última geração do projeto.
  const again = ok(await api('POST', `/api/projects/${S.p.id}/doc-templates/${MIT}/form`));
  assert.equal(again.fields.find((x) => x.key === 'aprovado_por').value, 'Bruno Cliente');
  assert.ok(again.last);
  const rot = ok(await api('POST', `/api/projects/${S.p.id}/doc-templates/${ROT}/form`));
  assert.equal(rot.fields.find((x) => x.key === 'cliente').value, 'Cliente Alfa SA');
});

test('roteiro: linhas incluídas na geração entram no Word; tabela sem inclusão mantém o tamanho do modelo', async () => {
  const f = ok(await api('POST', `/api/projects/${S.p.id}/doc-templates/${ROT}/form`));
  const fields = Object.fromEntries(f.fields.map((x) => [x.key, x.value]));
  fields.ambiente = 'HOMOLOGAÇÃO';
  const det = f.template.tables.find((t) => t.columns[0] === 'Unidade Origem');
  const qty = f.template.tables.find((t) => t.columns[0] === 'DADO');
  const tables = { ...f.tables, [det.index]: [['Unidade 01', 'Coligada 1'], ['Unidade 02', 'Coligada 2']] };
  tables[qty.index] = f.tables[qty.index].map((r, i) => [r[0], String(100 + i)]);
  const { zip } = await download(`/api/projects/${S.p.id}/doc-templates/${ROT}/generate`, { fields, tables });
  const text = docText(await zip.file('word/document.xml').async('string'));
  for (const s of ['DETALHAMENTO DO SERVIÇO EXECUTADO', 'Unidade 02', 'Coligada 2', '01-FUNCIONÁRIO', '114', 'ERROS DE CARGA', 'HOMOLOGAÇÃO']) assert.ok(text.includes(s), s);
  // MIT010: Aceite não permite incluir linhas → só a linha do modelo.
  const m = ok(await api('POST', `/api/projects/${S.p.id}/doc-templates/${MIT}/form`));
  const aceite = m.template.tables.find((t) => t.columns[0] === 'Aprovado por');
  const input = G.cleanInput({ fields: [], blocks: Array.from({ length: aceite.index + 1 }, (_, i) => (i === aceite.index ? { type: 'table', columns: aceite.columns, rows: [['a', '', 'c']], allowRows: false } : { type: 'title', text: '' })) },
    { tables: { [aceite.index]: [['x', '', 'y'], ['extra', '', '']] } });
  assert.deepEqual(input.tables[aceite.index], [['x', '', 'y']]);
});

test('papel timbrado: mantém cabeçalho/rodapé/seção do .docx base e troca só o corpo', async () => {
  const z = new JSZip();
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  z.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>');
  z.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  z.file('word/_rels/document.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdH" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/></Relationships>');
  z.file('word/header1.xml', `<?xml version="1.0"?><w:hdr xmlns:w="${W}"><w:p><w:r><w:t>CABECALHO FICTICIO</w:t></w:r></w:p></w:hdr>`);
  z.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="${W}" xmlns:r="${R}"><w:body><w:p><w:pPr><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:pPr><w:r><w:t>TEXTO ANTIGO DO MODELO</w:t></w:r></w:p><w:sectPr><w:headerReference w:type="default" r:id="rIdH"/><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`);
  const basePath = path.join(tmp, 'Papel timbrado.docx');
  fs.writeFileSync(basePath, await z.generateAsync({ type: 'nodebuffer' }));
  const pdf = path.join(tmp, 'outro.pdf'); fs.writeFileSync(pdf, '%PDF-1.4');
  const doc = ok(await api('POST', '/api/documents', { title: 'Papel timbrado', kind: 'modelo', source: { type: 'file', path: basePath } }));
  const notDocx = ok(await api('POST', '/api/documents', { title: 'PDF', kind: 'documento', source: { type: 'file', path: pdf } }));
  assert.equal((await api('PUT', `/api/doc-templates/${MIT}`, { baseDocumentId: notDocx.id })).status, 400);
  const t = ok(await api('PUT', `/api/doc-templates/${MIT}`, { baseDocumentId: doc.id }));
  assert.equal(t.base.title, 'Papel timbrado');
  const f = ok(await api('POST', `/api/projects/${S.p.id}/doc-templates/${MIT}/form`));
  const fields = Object.fromEntries(f.fields.map((x) => [x.key, x.value]));
  const { zip } = await download(`/api/projects/${S.p.id}/doc-templates/${MIT}/generate`, { fields, tables: f.tables });
  const xml = await zip.file('word/document.xml').async('string');
  assert.ok(docText(await zip.file('word/header1.xml').async('string')).includes('CABECALHO FICTICIO'));
  assert.ok(xml.includes('<w:headerReference w:type="default" r:id="rIdH"/>'), 'seção final preservada');
  assert.ok(!docText(xml).includes('TEXTO ANTIGO'), 'corpo trocado');
  assert.ok(docText(xml).includes('Cliente Alfa SA'));
  // Arquivo do papel timbrado sumiu → gera com o layout padrão e avisa na prévia.
  fs.renameSync(basePath, `${basePath}.bak`);
  const pv = ok(await api('POST', `/api/projects/${S.p.id}/doc-templates/${MIT}/preview`, { fields, tables: f.tables }));
  assert.ok(pv.warnings[0].includes('layout padrão'));
  const { zip: z2 } = await download(`/api/projects/${S.p.id}/doc-templates/${MIT}/generate`, { fields, tables: f.tables });
  assert.ok(z2.file('word/footer1.xml'));
});

test('modelos: criar, duplicar, desativar; excluir só o nunca usado', async () => {
  const t = ok(await api('POST', '/api/doc-templates', { name: 'Ata fictícia', fields: [{ key: 'tema', label: 'Tema' }], blocks: [{ type: 'title', text: 'Ata — {{project.name}}' }, { type: 'paragraph', text: 'Tema: {{doc.tema}}' }] }));
  const dup = ok(await api('POST', `/api/doc-templates/${t.id}/duplicate`));
  assert.equal(dup.name, 'Ata fictícia (cópia)');
  ok(await api('DELETE', `/api/doc-templates/${dup.id}`));
  const used = await api('DELETE', `/api/doc-templates/${MIT}`);
  assert.equal(used.status, 409);
  assert.equal(used.json.code, 'DOC_TEMPLATE_IN_USE');
  ok(await api('PUT', `/api/doc-templates/${t.id}`, { active: false }));
  assert.ok(!ok(await api('GET', `/api/projects/${S.p.id}/doc-templates`)).templates.some((x) => x.id === t.id));
  assert.equal((await api('POST', `/api/projects/${S.p.id}/doc-templates/${t.id}/form`)).status, 400);
});

test('formatação do original: título/parágrafo/quadro/tabela copiam estilo, cores, bordas e espaçamento do papel timbrado', async () => {
  const { buildDocx } = require('../src/docx');
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const F = '<w:rFonts w:ascii="Verdana" w:hAnsi="Verdana"/>';
  const r = (t, extra = '') => `<w:r><w:rPr>${F}${extra}</w:rPr><w:t xml:space="preserve">${t}</w:t></w:r>`;
  const tc = (inner, fill = '') => `<w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/>${fill ? `<w:shd w:val="clear" w:fill="${fill}"/>` : ''}</w:tcPr><w:p><w:pPr><w:rPr>${F}<w:b/><w:i/><w:color w:val="FF0000"/></w:rPr></w:pPr>${inner}</w:p></w:tc>`;
  const tbl = (rows) => `<w:tbl><w:tblPr><w:tblW w:w="8000" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="A44DFF"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid>${rows}</w:tbl>`;
  const body = `<w:p><w:pPr><w:pStyle w:val="Ttulo1"/></w:pPr>${r('Termo de Entrega / Marco', '<w:color w:val="00C9EB"/>')}</w:p><w:p/>`
    + `<w:p><w:pPr><w:jc w:val="both"/></w:pPr>${r('Concluído o marco ')}${r('1ª Migração', '<w:b/><w:i/>')}${r(', de acordo.')}</w:p>`
    + tbl(`<w:tr>${tc('', 'EEEEEE')}${tc('', 'EEEEEE')}</w:tr><w:tr>${tc(r('Nome do cliente: ', '<w:b/>'))}${tc(r('Código:', '<w:b/>'))}</w:tr>`) + '<w:p/>'
    + tbl(`<w:tr><w:trPr><w:tblHeader/></w:trPr>${tc(r('Processo', '<w:b/>'), 'D0D0D0')}${tc(r('Data', '<w:b/>'), 'D0D0D0')}</w:tr><w:tr><w:trPr><w:trHeight w:val="800"/></w:trPr>${tc(r('Carga A', '<w:b/><w:color w:val="666666"/>'))}${tc('')}</w:tr>`)
    + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:left="1000" w:right="1000"/></w:sectPr>';
  const z = new JSZip();
  z.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  z.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="${W}"><w:body>${body}</w:body></w:document>`);
  const baseBuf = await z.generateAsync({ type: 'nodebuffer' });
  const t = G.cleanTemplate({ name: 'T', fields: [{ key: 'marco', label: 'Marco' }, { key: 'entrega', label: 'Entrega' }, { key: 'cliente', label: 'Cliente' }],
    blocks: [{ type: 'title', text: 'Termo de Entrega / {{doc.entrega}}' }, { type: 'paragraph', text: 'Concluído o marco {{doc.marco}}, de acordo.' },
      { type: 'info', rows: [[{ label: 'Nome do cliente:', value: '{{doc.cliente}}' }, { label: 'Código:', value: 'X1' }]] },
      { type: 'table', columns: ['Processo', 'Data'], rows: [['Carga A', '01/10/2026'], ['Carga B', '02/10/2026']] },
      { type: 'table', columns: ['Sem molde', 'Coluna'], rows: [['a', 'b']] }] }, applyDefaults({ projects: [] }));
  t.id = 't1';
  const doc = G.render(t, { data: applyDefaults({ projects: [] }), project: { id: 'p', name: 'P' } }, G.cleanInput(t, { fields: { marco: 'Produção', entrega: 'Carga', cliente: 'Cliente Alfa' } }));
  const out = await JSZip.loadAsync(await buildDocx(doc, { base: baseBuf }));
  const xml = await out.file('word/document.xml').async('string');
  // Título: estilo e cor do original; a variável no fim herda a cor do trecho que ocupa.
  assert.match(xml, /<w:pStyle w:val="Ttulo1"\/><\/w:pPr><w:r><w:rPr>[^]*?00C9EB[^]*?Termo de Entrega \/ <\/w:t><\/w:r><w:r><w:rPr>[^]*?00C9EB[^]*?>Carga</);
  assert.ok(xml.includes('<w:pStyle w:val="Ttulo1"/></w:pPr>') && /Carga<\/w:t><\/w:r><\/w:p><w:p\/>/.test(xml), 'parágrafo vazio de espaçamento copiado');
  // Parágrafo: o valor do marco fica em negrito itálico, como o trecho do original.
  assert.match(xml, /<w:b\/><w:i\/><\/w:rPr><w:t xml:space="preserve">Produção<\/w:t>/);
  // Quadro: bordas do original, faixa decorativa, valor sem negrito explícito.
  assert.ok(xml.includes('w:color="A44DFF"'));
  assert.ok(xml.includes('w:fill="EEEEEE"'), 'faixa decorativa copiada');
  assert.match(xml, /<w:b w:val="0"\/><w:bCs w:val="0"\/><\/w:rPr><w:t xml:space="preserve"> Cliente Alfa<\/w:t>/);
  // Tabela: cabeçalho cinza, altura da linha original; célula vazia do original segue o texto da linha (não o vermelho da marca).
  assert.ok(xml.includes('w:fill="D0D0D0"') && xml.includes('<w:trHeight w:val="800"/>'));
  assert.match(xml, /666666"\/><\/w:rPr><w:t xml:space="preserve">01\/10\/2026</);
  const dateRun = xml.match(/<w:r><w:rPr>((?:(?!<\/w:rPr>).)*)<\/w:rPr><w:t xml:space="preserve">01\/10\/2026/)[1];
  assert.ok(!dateRun.includes('FF0000'), 'marca vermelha da célula vazia não vai para o texto');
  assert.ok(xml.includes('>Carga B<'), 'linha além do original repete a última linha do original');
  // Sem correspondente: formatação neutra com a fonte predominante do original.
  assert.match(xml, /<w:rFonts w:ascii="Verdana" w:hAnsi="Verdana"\/><w:b\/><w:bCs\/><\/w:rPr><w:t xml:space="preserve">Sem molde</);
  assert.ok(xml.includes('<w:sectPr><w:pgSz'), 'seção final preservada');
});

test('formulário: o usado na última geração só volta enquanto o modelo e o projeto não mudaram (campos, outro modelo, tabelas, ordem, hoje)', () => {
  const M = require('../src/email');
  const data = applyDefaults({ projects: [], coordinators: [{ id: 'a1', name: 'Ana Analista' }, { id: 'a2', name: 'Bia Analista' }] });
  const p = { id: 'p1', name: 'Cliente Alfa', analystId: 'a1', contacts: [], stageHistory: [] };
  data.projects.push(p);
  const ctx = () => M.contextFor(data, p, {});
  const rot = data.docTemplates.find((t) => t.id === ROT);
  const mit = data.docTemplates.find((t) => t.id === MIT);
  const field = (form, key) => form.fields.find((f) => f.key === key);
  const gen = (t, fields, tables = {}, refs = G.references(t, ctx())) => data.docGenerations.push({ id: `g${data.docGenerations.length}`, at: new Date().toISOString(), projectId: p.id, templateId: t.id, templateName: t.name, fileName: 'x.docx', fields, tables, ...(refs ? { refs } : {}) });

  // 1) Geração antiga (sem referência) + valor inicial do campo editado no modelo depois: vale o do modelo; o resto digitado volta.
  gen(rot, { analistas: 'Ana Analista', cliente: 'Cliente Alfa SA', data_final: '30/09/2026' }, {}, null);
  rot.fields.find((f) => f.key === 'analistas').default = 'Analista Fictício';
  let f = G.buildForm(rot, ctx(), data);
  assert.equal(field(f, 'analistas').value, 'Analista Fictício');
  assert.equal(field(f, 'analistas').changed, true);
  assert.deepEqual(field(f, 'analistas').alt, { label: 'Usar o da última geração', value: 'Ana Analista' });
  assert.equal(field(f, 'cliente').value, 'Cliente Alfa SA');
  assert.equal(field(f, 'data_final').value, '30/09/2026', 'data digitada não vira "hoje" (variável que muda sozinha)');

  // 2) Com referência e modelo igual: o digitado volta, com a opção de usar o do modelo.
  gen(rot, { analistas: 'Outro Nome', cliente: 'Cliente Alfa SA' });
  f = G.buildForm(rot, ctx(), data);
  assert.equal(field(f, 'analistas').value, 'Outro Nome');
  assert.equal(field(f, 'analistas').from, 'last');
  assert.deepEqual(field(f, 'analistas').alt, { label: 'Usar o do modelo', value: 'Analista Fictício' });

  // 3) Dado do projeto alterado (analista): campo que vem do projeto acompanha.
  gen(mit, { analista: 'Ana Analista', projeto: 'Migração de Dados (Folha de Pagamento)', cliente: 'Cliente Alfa SA' });
  p.analystId = 'a2';
  f = G.buildForm(mit, ctx(), data);
  assert.equal(field(f, 'analista').value, 'Bia Analista');
  assert.equal(field(f, 'cliente').value, 'Cliente Alfa SA');

  // 4) Chave igual vinda de OUTRO modelo: valor inicial diferente neste modelo → vale o deste; igual (vazio) → reaproveita o digitado.
  data.docGenerations = data.docGenerations.filter((g) => g.templateId === MIT);
  f = G.buildForm(rot, ctx(), data);
  assert.equal(field(f, 'projeto').value, 'Migração de Dados');
  assert.equal(field(f, 'cliente').value, 'Cliente Alfa SA');

  // 5) Tabelas: linhas da última geração voltam; modelo editado (processo novo) → linhas do modelo, com a opção de voltar.
  const procIdx = mit.blocks.findIndex((b) => b.type === 'table' && b.columns[0] === 'Nome do Processo');
  const before = G.buildForm(mit, ctx(), data).tables[procIdx];
  const typed = before.map((r) => [r[0], '01/10/2026', 'Usuário Chave', r[3]]);
  gen(mit, { analista: 'Bia Analista' }, { [procIdx]: typed });
  f = G.buildForm(mit, ctx(), data);
  assert.deepEqual(f.tables[procIdx], typed);
  assert.equal(f.tableAlts[procIdx].label, 'Restaurar as linhas do modelo');
  mit.blocks[procIdx].rows.push(['Carga de dados nova', '{{doc.data}}', '', '{{doc.analista}}']);
  f = G.buildForm(mit, ctx(), data);
  assert.equal(f.tables[procIdx].length, 16);
  assert.equal(f.tableAlts[procIdx].changed, true);
  assert.deepEqual(f.tableAlts[procIdx].rows, typed);

  // 6) Blocos reordenados: a tabela que passou a ocupar a posição não recebe as linhas da outra.
  const t2 = G.cleanTemplate({ name: 'Duas', blocks: [{ type: 'table', columns: ['A', 'B'], rows: [['a1', '']] }, { type: 'table', columns: ['C', 'D'], rows: [['c1', '']] }] }, data);
  t2.id = 'duas';
  gen(t2, {}, { 0: [['a1', 'digitado A']], 1: [['c1', 'digitado C']] });
  t2.blocks.reverse();
  f = G.buildForm(t2, ctx(), data);
  assert.deepEqual(f.tables[0], [['c1', '']]);
  assert.deepEqual(f.tables[1], [['a1', '']]);

  // Referência não depende do dia (today/greeting ficam como marcador).
  const r1 = G.references(rot, M.contextFor(data, p, { now: new Date('2026-10-15T10:00:00') }));
  const r2 = G.references(rot, M.contextFor(data, p, { now: new Date('2026-10-16T20:00:00') }));
  assert.deepEqual(r1, r2);
});
