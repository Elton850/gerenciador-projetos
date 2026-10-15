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
