// Documentos gerados — rotas. Regras em src/docgen.js; escrita do Word em src/docx.js.
// Fluxo: formulário (campos com valores do projeto/última geração) → prévia (HTML) → gerar (.docx baixado pela tela; registra no histórico).
// Nada é gravado em pastas do usuário: o arquivo vai como download. O papel timbrado é só LIDO da biblioteca de documentos.
const fs = require('fs');
const path = require('path');
const { httpError, uid, str } = require('./util');
const EH = require('./evidence-http');
const M = require('./email');
const G = require('./docgen');
const { buildDocx } = require('./docx');
const PDF = require('./pdf');
const WORDPDF = require('./word-pdf');

const BASE_MAX_BYTES = 30 * 1024 * 1024;
const isDocx = (p) => path.extname(String(p || '')).toLowerCase() === '.docx';

function mount(app, { store, audit, getProject }) {
  const data = () => store.data;
  const list = () => (data().docTemplates ||= []);
  const gens = () => (data().docGenerations ||= []);
  const tpl = (id) => list().find((t) => t.id === id) || (() => { throw httpError(404, 'Modelo de documento não encontrado.'); })();
  const log = (action, p, extra = {}) => audit.log({ action, project: p?.name, by: EH.whoAmI(), ...extra });
  const libDoc = (id) => data().documents.find((d) => d.id === id) || null;
  const docxDocuments = () => data().documents.filter((d) => d.source?.type === 'file' && isDocx(d.source.path)).map((d) => ({ id: d.id, title: d.title, stageId: d.stageId }));
  const baseInfo = (t) => {
    if (!t.baseDocumentId) return null;
    const d = libDoc(t.baseDocumentId);
    return d ? { id: d.id, title: d.title, fileExists: d.source.type === 'file' && fs.existsSync(d.source.path) } : { id: t.baseDocumentId, title: '(removido da biblioteca)', missing: true };
  };
  const publicTemplate = (t) => ({ ...t, autoFields: G.autoFields(t), base: baseInfo(t), usage: G.templateUsage(data(), t.id), checklistItems: data().checklistItems.filter((i) => i.docTemplateId === t.id).length });
  const clean = (body) => {
    const c = G.cleanTemplate(body || {}, data());
    if (c.baseDocumentId) { const d = libDoc(c.baseDocumentId); if (d.source.type !== 'file' || !isDocx(d.source.path)) throw httpError(400, 'O papel timbrado precisa ser um arquivo Word (.docx) cadastrado na biblioteca.'); }
    return c;
  };

  // ---------- Modelos ----------
  app.get('/api/doc-templates', (req, res) => res.json({
    templates: list().map(publicTemplate), variables: G.publicVariables(), blockTypes: G.BLOCK_TYPES, fieldTypes: G.FIELD_TYPES, docxDocuments: docxDocuments(),
  }));

  app.post('/api/doc-templates', (req, res) => {
    const now = new Date().toISOString();
    const t = { id: uid(), ...clean(req.body), createdAt: now, updatedAt: now };
    list().push(t);
    store.save();
    log('documento-modelo-criado', null, { detalhe: t.name });
    res.json(publicTemplate(t));
  });

  app.put('/api/doc-templates/:tid', (req, res) => {
    const t = tpl(req.params.tid);
    const wasActive = t.active;
    Object.assign(t, clean({ ...t, ...req.body }), { updatedAt: new Date().toISOString() });
    store.save();
    log(wasActive && !t.active ? 'documento-modelo-desativado' : !wasActive && t.active ? 'documento-modelo-reativado' : 'documento-modelo-editado', null, { detalhe: t.name });
    res.json(publicTemplate(t));
  });

  app.post('/api/doc-templates/:tid/duplicate', (req, res) => {
    const src = tpl(req.params.tid);
    const now = new Date().toISOString();
    const t = { ...JSON.parse(JSON.stringify(src)), id: uid(), name: `${src.name} (cópia)`.slice(0, 120), createdAt: now, updatedAt: now };
    list().push(t);
    store.save();
    log('documento-modelo-criado', null, { detalhe: `${t.name} (duplicado)` });
    res.json(publicTemplate(t));
  });

  // Excluir só modelo nunca usado (o histórico aponta para ele) e fora dos itens de checklist; usado → desativar.
  const inChecklists = (id) => data().checklistItems.filter((i) => i.docTemplateId === id).length
    + data().projects.reduce((n, p) => n + (p.checklists || []).reduce((m, c) => m + c.items.filter((i) => i.docTemplateId === id).length, 0), 0);
  app.delete('/api/doc-templates/:tid', (req, res) => {
    const t = tpl(req.params.tid);
    const n = G.templateUsage(data(), t.id);
    if (n) throw httpError(409, `O modelo “${t.name}” já gerou ${n} documento(s) e fica no histórico. Desative-o para não aparecer mais nos projetos.`, { code: 'DOC_TEMPLATE_IN_USE' });
    const k = inChecklists(t.id);
    if (k) throw httpError(409, `O modelo “${t.name}” é a ação “Gerar documento” de ${k} item(ns) de checklist. Tire-o desses itens ou desative o modelo.`, { code: 'DOC_TEMPLATE_IN_USE' });
    data().docTemplates = list().filter((x) => x.id !== t.id);
    store.save();
    log('documento-modelo-excluido', null, { detalhe: t.name });
    res.json({ ok: true });
  });

  // ---------- Geração no projeto ----------
  const ctxFor = (p) => M.contextFor(data(), p, {});
  const activeTpl = (id) => { const t = tpl(id); if (!t.active) throw httpError(400, 'Este modelo está desativado. Reative-o em Documentos e Modelos → Gerar documentos.'); return t; };
  const genView = (g) => ({ id: g.id, at: g.at, by: g.by, templateId: g.templateId, templateName: g.templateName, fileName: g.fileName });
  // Papel timbrado: Buffer do .docx ou aviso (gera com o layout padrão).
  const readBase = (t) => {
    if (!t.baseDocumentId) return { base: null };
    const d = libDoc(t.baseDocumentId);
    if (!d || d.source.type !== 'file' || !isDocx(d.source.path)) return { base: null, warning: 'O papel timbrado do modelo não está mais na biblioteca: o documento sai com o layout padrão.' };
    try {
      const st = fs.statSync(d.source.path);
      if (!st.isFile() || st.size > BASE_MAX_BYTES) throw new Error('size');
      return { base: fs.readFileSync(d.source.path), title: d.title };
    } catch { return { base: null, warning: `Papel timbrado “${d.title}” não encontrado no caminho cadastrado: o documento sai com o layout padrão.` }; }
  };

  // Geração pela ação do item do checklist: o item precisa ser deste projeto e ter este modelo (cópia do item). Só registro.
  function checklistOf(p, t, c) {
    if (!c || (!c.stepId && !c.itemId)) return null;
    const inst = (p.checklists || []).find((x) => x.stepId === str(c.stepId, 40)) || (() => { throw httpError(404, 'Checklist deste passo ainda não foi iniciado.'); })();
    const item = inst.items.find((i) => i.id === str(c.itemId, 40)) || (() => { throw httpError(404, 'Item não encontrado.'); })();
    if (item.docTemplateId !== t.id) throw httpError(400, 'Este item do checklist não tem este modelo de documento associado.');
    return { stepId: inst.stepId, itemId: item.id, itemTitle: item.title, stageName: inst.stageName || '' };
  }

  app.get('/api/projects/:id/doc-templates', (req, res) => {
    const p = getProject(req.params.id);
    res.json({
      templates: list().filter((t) => t.active).map((t) => ({ id: t.id, name: t.name, description: t.description, stageId: t.stageId })),
      generations: gens().filter((g) => g.projectId === p.id).slice(-30).reverse().map(genView),
    });
  });

  app.post('/api/projects/:id/doc-templates/:tid/form', (req, res) => {
    const p = getProject(req.params.id);
    const t = activeTpl(req.params.tid);
    const f = G.buildForm(t, ctxFor(p), data());
    const tables = t.blocks.map((b, index) => (b.type === 'table' ? { index, columns: b.columns, allowRows: b.allowRows, modelRows: b.rows.length } : null)).filter(Boolean);
    const people = [...(p.contacts || []).map((c) => c.name), ...['coordinatorId', 'analystId'].map((k) => data().coordinators.find((c) => c.id === p[k])?.name)].filter(Boolean);
    res.json({ template: { id: t.id, name: t.name, description: t.description, tables, base: baseInfo(t) }, fields: f.fields, tables: f.tables, tableAlts: f.tableAlts, last: f.last, people: [...new Set(people)] });
  });

  app.post('/api/projects/:id/doc-templates/:tid/preview', (req, res) => {
    const p = getProject(req.params.id);
    const t = activeTpl(req.params.tid);
    const doc = G.render(t, ctxFor(p), G.cleanInput(t, req.body));
    const b = readBase(t);
    res.json({ html: G.previewHtml(doc), warnings: b.warning ? [b.warning, ...doc.warnings] : doc.warnings, fileName: doc.fileName });
  });

  app.post('/api/projects/:id/doc-templates/:tid/generate', async (req, res) => {
    const p = getProject(req.params.id);
    const t = activeTpl(req.params.tid);
    const origin = checklistOf(p, t, req.body?.checklist); // valida a origem antes de montar o Word
    const input = G.cleanInput(t, req.body);
    const doc = G.render(t, ctxFor(p), input);
    // format: 'pdf' → o MESMO Word (papel timbrado + formatação do original) convertido pelo Word instalado (src/word-pdf.js, ADR-017);
    // sem Word ou falha → PDF do próprio app (layout da prévia, sem papel timbrado; src/pdf.js) e aviso no cabeçalho X-Doc-Warning.
    const pdf = req.body?.format === 'pdf';
    const fileName = pdf ? G.pdfFileName(doc.fileName) : doc.fileName;
    const b = readBase(t);
    let buf;
    try { buf = await buildDocx(doc, { base: b.base, title: t.name }); } catch (e) { throw httpError(400, `Não foi possível montar o Word com o papel timbrado: ${e.message}`); }
    let via = 'word'; let warning = null;
    if (pdf) {
      try { buf = await WORDPDF.docxToPdf(buf); } catch (e) {
        via = 'app';
        warning = `${e.code === WORDPDF.NO_WORD ? 'Word não encontrado neste computador' : 'O Word não conseguiu converter'}: o PDF saiu no layout da prévia, sem o papel timbrado.`;
        buf = await PDF.htmlToPdf(G.pdfHtml(doc, t.name));
      }
    }
    const rec = G.generationRecord({ project: p, template: t, input, fileName, by: EH.whoAmI(), refs: G.references(t, ctxFor(p)), checklist: origin, format: pdf ? 'pdf' : 'docx' });
    G.pushGeneration(data(), rec);
    store.save();
    log('documento-gerado', p, { detalhe: `${t.name}${pdf ? ` (PDF ${via === 'word' ? 'pelo Word' : 'pelo app'})` : ''}${rec.checklist ? ` (item “${rec.checklist.itemTitle}”)` : ''}`, arquivo: fileName });
    if (warning) res.setHeader('X-Doc-Warning', encodeURIComponent(warning));
    res.setHeader('Content-Type', pdf ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    res.setHeader('X-Generation-Id', rec.id);
    res.setHeader('Cache-Control', 'no-store');
    res.send(buf);
  });
}

module.exports = { mount };
