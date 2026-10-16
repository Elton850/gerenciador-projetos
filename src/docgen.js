// Documentos gerados (Documentos e Modelos → Gerar documentos) — regras puras (sem HTTP/disco).
// Mesma ideia de Comunicações: MODELO reutilizável (data.docTemplates) + dados do projeto → prévia → arquivo Word (.docx) gerado.
// O app não envia nem assina nada: o usuário baixa o .docx, confere e segue o processo dele.
//
// MODELO = { name, description, stageId, baseDocumentId (papel timbrado: .docx da biblioteca), fileName, fields[], blocks[], active }
//  - fields: CAMPOS DO DOCUMENTO ({{doc.<chave>}}), preenchidos na geração. O valor inicial (default) pode usar variáveis do projeto
//    (o MESMO registro de Comunicações: email.VARIABLES dos grupos Projeto/Pessoas/Geral). Dado que o projeto não tem (cliente, códigos,
//    proposta, quantidades…) é campo, nunca inventado.
//  - Campos AUTOMÁTICOS: {{doc.<chave>}} usado no conteúdo/nome do arquivo SEM campo declarado vira campo de texto na geração (sem valor
//    inicial; rótulo a partir da chave; texto longo quando ocupa sozinho um parágrafo). Não são gravados no modelo: saem do conteúdo
//    (fieldsOf = declarados + automáticos). Declarar o campo é o que dá valor inicial, sugestões, tipo e rótulo próprios.
//    As demais variáveis ({{project.*}}, pessoas, {{today}}…) são fixas: só as do registro.
//  - blocks: title | paragraph | info (quadro "Rótulo: valor", 1 ou 2 por linha) | table (colunas + linhas; editável na geração) | pagebreak.
// Na geração: {{doc.x}} vazio vira texto vazio (escolha do usuário, listado como aviso); variável de PROJETO sem valor mantém o marcador
// {{...}} e vira aviso (regra de Comunicações). Histórico (data.docGenerations): fotografia dos campos/tabelas usados — preenche a próxima.
const { httpError, uid, str, sanitizeFileName } = require('./util');
const M = require('./email');

const MAX_FIELDS = 40;
const MAX_BLOCKS = 80;
const MAX_ROWS = 300;
const MAX_COLS = 8;
const MAX_CELL = 1000;
const MAX_GENERATIONS = 1000;
const BLOCK_TYPES = { title: 'Título', paragraph: 'Parágrafo', info: 'Quadro de dados', table: 'Tabela', pagebreak: 'Quebra de página' };
const FIELD_TYPES = { text: 'Texto curto', textarea: 'Texto longo' };
const VAR_GROUPS = new Set(['Projeto', 'Pessoas', 'Geral']); // checklist/horas não existem no contexto de um documento
const FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
const VAR_RE = /\{\{\s*([a-z0-9_.]+)\s*\}\}/gi;

const publicVariables = () => M.publicVariables().filter((v) => VAR_GROUPS.has(v.group));
const PROJECT_KEYS = new Set(publicVariables().map((v) => v.key));
const varsIn = (text) => [...String(text || '').matchAll(VAR_RE)].map((m) => m[1].toLowerCase());

// ---------- Campos automáticos ----------
const DOC_VAR_WHOLE = /^\s*\{\{\s*doc\.([a-z0-9_]+)\s*\}\}\s*$/i;
const humanize = (key) => { const x = String(key).replace(/_+/g, ' ').trim(); return x.charAt(0).toUpperCase() + x.slice(1); };
// Textos do conteúdo em ordem (blocos e depois o nome do arquivo); whole = parágrafo que é só a variável (vira texto longo).
function contentTexts(t) {
  const out = [];
  for (const b of t.blocks || []) {
    if (b.text !== undefined) out.push({ text: b.text, whole: b.type === 'paragraph' && DOC_VAR_WHOLE.test(b.text || '') });
    for (const c of b.columns || []) out.push({ text: c });
    for (const r of b.rows || []) for (const c of r) { if (typeof c === 'string') out.push({ text: c }); else out.push({ text: c.label }, { text: c.value }); }
  }
  out.push({ text: t.fileName });
  return out;
}
// {{doc.x}} do conteúdo sem campo declarado (chave válida), na ordem em que aparecem.
function autoFields(t) {
  const declared = new Set((t.fields || []).map((f) => f.key));
  const found = new Map();
  for (const { text, whole } of contentTexts(t)) {
    for (const k of varsIn(text)) {
      if (!k.startsWith('doc.')) continue;
      const key = k.slice(4);
      if (declared.has(key) || !FIELD_KEY_RE.test(key)) continue;
      found.set(key, (found.get(key) || false) || !!whole);
    }
  }
  return [...found].map(([key, long]) => ({ key, label: humanize(key), type: long ? 'textarea' : 'text', default: '', options: [], hint: '', people: false, auto: true }));
}
const fieldsOf = (t) => [...(t.fields || []), ...autoFields(t)];

// ---------- Modelo ----------
function cleanField(f, i) {
  const label = str(f?.label, 120);
  if (!label) throw httpError(400, `Campo ${i + 1}: informe o nome.`);
  const key = str(f?.key, 40).toLowerCase();
  if (!FIELD_KEY_RE.test(key)) throw httpError(400, `Campo “${label}”: a chave deve começar com letra e ter só letras minúsculas, números e _ (ex.: data_termino).`);
  const options = (Array.isArray(f?.options) ? f.options : String(f?.options || '').split('\n')).map((o) => str(o, 300)).filter(Boolean).slice(0, 20);
  return { key, label, type: FIELD_TYPES[f?.type] ? f.type : 'text', default: str(f?.default, 2000), options, hint: str(f?.hint, 300), people: !!f?.people };
}

function cleanBlock(b, i) {
  const type = BLOCK_TYPES[b?.type] ? b.type : null;
  if (!type) throw httpError(400, `Bloco ${i + 1}: tipo inválido.`);
  if (type === 'pagebreak') return { type };
  if (type === 'title') return { type, text: str(b.text, 300) };
  if (type === 'paragraph') return { type, text: String(b.text ?? '').replace(/\r\n?/g, '\n').slice(0, 8000) };
  if (type === 'info') {
    const rows = (Array.isArray(b.rows) ? b.rows : []).slice(0, 60)
      .map((r) => (Array.isArray(r) ? r : []).slice(0, 2).map((c) => ({ label: str(c?.label, 160), value: str(c?.value, MAX_CELL) })).filter((c) => c.label || c.value))
      .filter((r) => r.length);
    return { type, rows };
  }
  const columns = (Array.isArray(b.columns) ? b.columns : []).map((c) => str(c, 160)).slice(0, MAX_COLS);
  if (!columns.length) throw httpError(400, `Bloco ${i + 1} (tabela): informe ao menos uma coluna.`);
  const rows = (Array.isArray(b.rows) ? b.rows : []).slice(0, MAX_ROWS).map((r) => columns.map((_, k) => str(Array.isArray(r) ? r[k] : '', MAX_CELL)));
  return { type, columns, rows, allowRows: !!b.allowRows };
}

// Valida e normaliza um modelo. Variável desconhecida → recusado (DOC_UNKNOWN_VARIABLE), como nos modelos de e-mail.
function cleanTemplate(b, data) {
  const name = str(b?.name, 120);
  if (!name) throw httpError(400, 'Informe o nome do modelo.');
  const fields = (Array.isArray(b.fields) ? b.fields : []).slice(0, MAX_FIELDS + 1).map(cleanField);
  if (fields.length > MAX_FIELDS) throw httpError(400, `No máximo ${MAX_FIELDS} campos por modelo.`);
  const dup = fields.find((f, i) => fields.findIndex((x) => x.key === f.key) !== i);
  if (dup) throw httpError(400, `A chave “${dup.key}” está repetida nos campos.`);
  const blocks = (Array.isArray(b.blocks) ? b.blocks : []).slice(0, MAX_BLOCKS + 1).map(cleanBlock);
  if (blocks.length > MAX_BLOCKS) throw httpError(400, `No máximo ${MAX_BLOCKS} blocos por modelo.`);
  if (!blocks.length) throw httpError(400, 'O modelo precisa de ao menos um bloco de conteúdo.');
  const stageId = b.stageId && data.stages.some((s) => s.id === b.stageId) ? b.stageId : null;
  const baseDocumentId = b.baseDocumentId ? str(b.baseDocumentId, 64) : null;
  if (baseDocumentId && !data.documents.some((d) => d.id === baseDocumentId)) throw httpError(400, 'O papel timbrado escolhido não está mais na biblioteca.');
  const t = { name, description: str(b.description, 600), stageId, baseDocumentId, fileName: str(b.fileName, 200) || name, fields, blocks, active: b.active !== false };
  // Variáveis: do projeto (registro fixo) ou {{doc.<chave>}} — declarado ou automático (chave válida). Valor inicial e sugestões de campo
  // só usam variáveis do projeto.
  const bad = new Set(); const badKey = new Set();
  const check = (text, allowDoc = true) => {
    for (const k of varsIn(text)) {
      if (PROJECT_KEYS.has(k)) continue;
      if (allowDoc && k.startsWith('doc.')) { if (!FIELD_KEY_RE.test(k.slice(4))) badKey.add(k); continue; }
      bad.add(k);
    }
  };
  for (const f of fields) { check(f.default, false); f.options.forEach((o) => check(o, false)); }
  for (const { text } of contentTexts(t)) check(text);
  if (badKey.size) throw httpError(400, `Chave de campo inválida: ${[...badKey].map((k) => `{{${k}}}`).join(', ')}. Depois de “doc.” use letra inicial e só letras minúsculas, números e _ (ex.: {{doc.data_termino}}).`, { code: 'DOC_UNKNOWN_VARIABLE' });
  if (bad.size) throw httpError(400, `Variável desconhecida no modelo: ${[...bad].map((k) => `{{${k}}}`).join(', ')}. Use as variáveis da lista ou um campo do documento ({{doc.chave}}).`, { code: 'DOC_UNKNOWN_VARIABLE' });
  const total = fields.length + autoFields(t).length;
  if (total > MAX_FIELDS) throw httpError(400, `No máximo ${MAX_FIELDS} campos por modelo (declarados + {{doc.…}} do conteúdo): este tem ${total}.`);
  return t;
}

const templateUsage = (data, id) => (data.docGenerations || []).filter((g) => g.templateId === id).length;

// ---------- Geração ----------
const projectValues = (ctx) => Object.fromEntries(Object.entries(M.variableValues(ctx)).filter(([k]) => PROJECT_KEYS.has(k)));
const missMsg = (k, ctx) => M.missingMessage(k, ctx);

// Última geração deste modelo no projeto: os valores digitados voltam preenchidos (o usuário só ajusta o que mudou, ex.: HMG → PRD).
function lastGeneration(data, projectId, templateId) {
  const list = (data.docGenerations || []).filter((g) => g.projectId === projectId);
  return { same: list.filter((g) => g.templateId === templateId).at(-1) || null, any: list.at(-1) || null };
}

// REFERÊNCIA de uma geração: o valor inicial de cada campo e as linhas do modelo de cada tabela, já com os dados do projeto daquele
// momento. Na próxima geração, o que o usuário usou só volta se a referência continua igual; se o modelo foi editado (valor inicial,
// linhas, ordem dos blocos) ou o dado do projeto mudou (ex.: analista), vale o atual. Variáveis que mudam sozinhas (data/horário da
// geração) ficam como marcador na referência — uma data digitada não é trocada por "hoje" a cada dia.
const VOLATILE = new Set(['today', 'greeting']);
function references(t, ctx) {
  const sv = Object.fromEntries(Object.entries(projectValues(ctx)).filter(([k]) => !VOLATILE.has(k)));
  const tables = {};
  t.blocks.forEach((b, i) => { if (b.type === 'table') tables[i] = JSON.stringify([b.columns, b.rows.map((r) => r.map((c) => resolveProjectOnly(c, sv)))]); });
  return { defaults: Object.fromEntries(fieldsOf(t).map((f) => [f.key, M.renderText(f.default, sv).text])), tables };
}
// Geração anterior à referência (versão 1.7.0/1.7.1): compara com o modelo padrão de mesmo id; outro modelo → sem referência (mantém).
function refsOf(g, ctx, data) {
  if (g.refs) return g.refs;
  const seed = defaultTemplates(data).find((x) => x.id === g.templateId);
  return seed ? references(seed, ctx) : null;
}

// Formulário da geração: cada campo vem da última geração do projeto (deste modelo ou, pela chave, de outro) enquanto a referência dele
// não mudou; senão, do valor inicial com os dados atuais do projeto. Tabelas: linhas da última geração deste modelo, com a mesma regra
// (variáveis do projeto já resolvidas; {{doc.x}} continua marcador para acompanhar o campo). alt = a outra opção, para a tela oferecer.
function buildForm(t, ctx, data) {
  const values = projectValues(ctx);
  const now = references(t, ctx);
  const { same, any } = lastGeneration(data, ctx.project.id, t.id);
  const fields = fieldsOf(t).map((f) => {
    const r = M.renderText(f.default, values);
    const def = { ...f, value: r.missing.length ? r.text.replace(VAR_RE, '').replace(/\s{2,}/g, ' ').trim() : r.text, from: 'default', warnings: r.missing.map((k) => missMsg(k, ctx)) };
    const src = same && f.key in (same.fields || {}) ? same : any && f.key in (any.fields || {}) ? any : null;
    if (!src) return def;
    const last = src.fields[f.key];
    const then = refsOf(src, ctx, data)?.defaults?.[f.key];
    if (then !== undefined && then !== now.defaults[f.key]) return { ...def, changed: true, alt: last !== def.value ? { label: 'Usar o da última geração', value: last } : null };
    return { ...f, value: last, from: 'last', alt: def.value && def.value !== last ? { label: 'Usar o do modelo', value: def.value } : null };
  });
  const tables = {}; const tableAlts = {};
  t.blocks.forEach((b, i) => {
    if (b.type !== 'table') return;
    const model = b.rows.map((r) => r.map((c) => resolveProjectOnly(c, values)));
    const prev = same?.tables?.[i];
    if (!(Array.isArray(prev) && prev.every((r) => Array.isArray(r) && r.length === b.columns.length))) { tables[i] = model; return; }
    const then = refsOf(same, ctx, data)?.tables?.[i];
    const differs = JSON.stringify(prev) !== JSON.stringify(model);
    if (then !== undefined && then !== now.tables[i]) { tables[i] = model; if (differs) tableAlts[i] = { label: 'Usar as linhas da última geração', rows: prev, changed: true }; }
    else { tables[i] = prev; if (differs) tableAlts[i] = { label: 'Restaurar as linhas do modelo', rows: model }; }
  });
  return { fields, tables, tableAlts, last: same ? { at: same.at, by: same.by, fileName: same.fileName } : null };
}
// Resolve só as variáveis do projeto (as de campo ficam para a prévia/geração).
const resolveProjectOnly = (text, values) => String(text || '').replace(VAR_RE, (m, k) => (values[k.toLowerCase()] !== undefined ? values[k.toLowerCase()] : m));

// Limpa o que veio da tela (valores dos campos e linhas das tabelas editadas).
function cleanInput(t, body) {
  const fields = {};
  for (const f of fieldsOf(t)) fields[f.key] = String(body?.fields?.[f.key] ?? '').replace(/\r\n?/g, '\n').slice(0, f.type === 'textarea' ? 8000 : 2000);
  const tables = {};
  t.blocks.forEach((b, i) => {
    if (b.type !== 'table') return;
    const raw = body?.tables?.[i];
    if (!Array.isArray(raw)) return;
    const rows = raw.slice(0, MAX_ROWS).map((r) => b.columns.map((_, k) => str(Array.isArray(r) ? r[k] : '', MAX_CELL)));
    tables[i] = b.allowRows ? rows : rows.slice(0, b.rows.length).concat(b.rows.slice(rows.length).map((r) => [...r]));
  });
  return { fields, tables };
}

// Monta o documento resolvido (estrutura neutra: a prévia HTML e o .docx saem dela). warnings = lista de mensagens.
function render(t, ctx, input) {
  const values = { ...projectValues(ctx) };
  const all = fieldsOf(t);
  for (const f of all) values[`doc.${f.key}`] = String(input.fields[f.key] ?? '').trim();
  const missing = new Set(); const unknown = new Set();
  const R = (text) => { const r = M.renderText(text, values); r.missing.forEach((k) => missing.add(k)); r.unknown.forEach((k) => unknown.add(k)); return r.text; };
  const blocks = t.blocks.map((b, i) => {
    if (b.type === 'pagebreak') return { type: b.type };
    // parts: trechos fixos e variáveis separados — o .docx com papel timbrado alinha cada trecho à formatação do original (src/docx.js).
    if (b.type === 'title' || b.type === 'paragraph') {
      const parts = String(b.text || '').split(/(\{\{\s*[a-z0-9_.]+\s*\}\})/i).filter((s) => s !== '').map((raw) => ({ raw, isVar: /^\{\{/.test(raw), text: R(raw) }));
      return { type: b.type, text: parts.map((p) => p.text).join(''), parts };
    }
    if (b.type === 'info') return { type: b.type, rows: b.rows.map((r) => r.map((c) => ({ label: R(c.label), value: R(c.value) }))) };
    const rows = input.tables[i] || b.rows;
    return { type: b.type, columns: b.columns.map(R), rows: rows.map((r) => r.map(R)) };
  });
  const blank = all.filter((f) => !values[`doc.${f.key}`]).map((f) => f.label);
  const warnings = [...[...missing].map((k) => missMsg(k, ctx)), ...[...unknown].map((k) => `Variável desconhecida mantida no texto: {{${k}}}.`)];
  if (blank.length) warnings.push(`Campos em branco: ${blank.join(', ')}.`);
  return { blocks, warnings, fileName: fileNameFor(R(t.fileName), t.name) };
}

// Nome do arquivo: datas dd/mm/aaaa viram dd-mm-aaaa; caracteres reservados do Windows saem; sempre .docx.
function fileNameFor(name, fallback) {
  const base = sanitizeFileName(String(name || '').replace(/\{\{[^}]*\}\}/g, '').replace(/(\d{2})\/(\d{2})\/(\d{4})/g, '$1-$2-$3').replace(/\s+-\s+(?=-|$)/g, ''), sanitizeFileName(fallback, 'documento'));
  return `${base.replace(/\.docx$/i, '')}.docx`;
}

// ---------- Prévia (HTML; todo texto escapado aqui) ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const lines = (s) => esc(s).replace(/\n/g, '<br>');
function previewHtml(doc) {
  return doc.blocks.map((b) => {
    if (b.type === 'pagebreak') return '<div class="dg-break" title="Quebra de página"></div>';
    if (b.type === 'title') return `<h3 class="dg-title">${esc(b.text)}</h3>`;
    if (b.type === 'paragraph') return `<p class="dg-par">${lines(b.text)}</p>`;
    if (b.type === 'info') {
      return `<table class="dg-info">${b.rows.map((r) => `<tr>${r.map((c) => `<td${r.length === 1 ? ' colspan="2"' : ''}><b>${esc(c.label)}</b> ${lines(c.value)}</td>`).join('')}</tr>`).join('')}</table>`;
    }
    return `<table class="dg-table"><thead><tr>${b.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${b.rows.map((r) => `<tr>${r.map((c) => `<td>${lines(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }).join('\n');
}

// Fotografia da geração (histórico): o que foi usado, não o arquivo.
// refs = references(template, ctx) do momento da geração (decide, na próxima, se o usado volta ou se vale o modelo/projeto atual).
// checklist = { stepId, itemId, itemTitle, stageName } quando gerado pela ação do item do checklist (só registro; não conclui o item).
function generationRecord({ project, template, input, fileName, by, refs = null, checklist = null, at = new Date().toISOString() }) {
  return { id: uid(), at, by, projectId: project.id, projectName: project.name, templateId: template.id, templateName: template.name, fileName, fields: input.fields, tables: input.tables, refs, ...(checklist ? { checklist } : {}) };
}
function pushGeneration(data, rec) {
  if (!Array.isArray(data.docGenerations)) data.docGenerations = [];
  data.docGenerations.push(rec);
  if (data.docGenerations.length > MAX_GENERATIONS) data.docGenerations.splice(0, data.docGenerations.length - MAX_GENERATIONS);
}

// ---------- Modelos padrão (a partir dos documentos de referência do usuário) ----------
// Ids fixos (como os estágios padrão): dados antigos recebem os mesmos ids a cada carga até serem salvos; config-sync casa pelos ids.
// Só estrutura e textos fixos dos modelos — nenhum dado de cliente. O papel timbrado (cabeçalho/rodapé/logo) é escolhido pelo usuário.
const DATA_ROWS = ['01-FUNCIONÁRIO', '02-DEPENDENTE', '03-PERÍODO AQUISITIVO DE FÉRIAS', '04-PERÍODO DE GOZO DE FÉRIAS', '05-RECIBO DE FÉRIAS', '06-VERBAS DE FÉRIAS',
  '07-HISTÓRICO DE SALÁRIO', '08-HISTÓRICO DE SITUAÇÃO', '09-HISTÓRICO DE CONTRIBUIÇÃO SINDICAL', '10-HISTÓRICO DE DEPENDENTES', '11-HISTÓRICO DE FUNÇÃO',
  '12-HISTÓRICO DE AFASTAMENTO', '13-HISTÓRICO DE SEÇÃO', '15-PERÍODOS DA FICHA FINANCEIRA', '16-FICHA FINANCEIRA'];
const PROCESSES = ['funcionários', 'dependentes', 'do período de férias', 'do gozo de férias', 'do recibo de férias', 'da verbas de férias', 'do histórico de salário',
  'do histórico de situação', 'do histórico de contrib. sind.', 'do histórico de dependentes', 'do histórico de função', 'do histórico de afastamento',
  'do histórico de seção', 'do período da ficha', 'da ficha financeira'].map((x) => `Carga de dados ${/^d[oa] /.test(x) ? x : `de ${x}`}`);
const AMBIENTES = ['HOMOLOGAÇÃO', 'PRODUÇÃO'];
const SEED_AT = '2026-10-15T00:00:00.000Z';
const F = (key, label, def = '', extra = {}) => ({ key, label, type: 'text', default: def, options: [], hint: '', people: false, ...extra });

function defaultTemplates(data) {
  const stageId = (data.stages || []).some((s) => s.id === 'st-documentacao') ? 'st-documentacao' : null;
  return [
    {
      id: 'dt-roteiro-pos-importacao', name: 'Roteiro Pós-Importação', active: true, stageId, baseDocumentId: null, createdAt: SEED_AT, updatedAt: SEED_AT,
      description: 'Relatório pós-importação: identificação do projeto, unidades × coligadas, quantidade de registros importados no RM e erros de carga.',
      fileName: 'Relatório Pós-Importação {{project.name}} - {{doc.ambiente}}',
      fields: [F('cliente', 'Nome do cliente'), F('projeto', 'Nome do projeto', 'Migração de Dados'), F('data_inicial', 'Data inicial', '{{project.start_date}}'),
        F('data_final', 'Data final', '{{today}}'), F('coordenador_totvs', 'Gerente/Coordenador TOTVS', '{{project.coordinator}}'),
        F('coordenador_cliente', 'Gerente/Coordenador cliente', '', { people: true }), F('analistas', 'Analistas', '{{project.analyst}}', { people: true }),
        F('ambiente', 'Ambiente', '', { options: AMBIENTES }), F('sistema_origem', 'Sistema origem', '{{project.origin_system}}'), F('sistema_destino', 'Sistema destino', 'TOTVS RM'),
        F('erros_carga', 'Erros de carga', '', { type: 'textarea', hint: 'Opcional. Prints e detalhes podem ser colados depois no Word.' })],
      blocks: [
        { type: 'info', rows: [[{ label: 'Nome do Cliente:', value: '{{doc.cliente}}' }], [{ label: 'Nome do Projeto:', value: '{{doc.projeto}}' }],
          [{ label: 'Data Inicial:', value: '{{doc.data_inicial}}' }, { label: 'Data Final:', value: '{{doc.data_final}}' }],
          [{ label: 'Gerente/Coordenador TOTVS:', value: '{{doc.coordenador_totvs}}' }], [{ label: 'Gerente/Coordenador Cliente:', value: '{{doc.coordenador_cliente}}' }],
          [{ label: 'Analistas:', value: '{{doc.analistas}}' }], [{ label: 'Ambiente:', value: '{{doc.ambiente}}' }],
          [{ label: 'Sistema Origem:', value: '{{doc.sistema_origem}}' }, { label: 'Sistema Destino:', value: '{{doc.sistema_destino}}' }]] },
        { type: 'title', text: 'DETALHAMENTO DO SERVIÇO EXECUTADO' },
        { type: 'table', columns: ['Unidade Origem', 'Coligada Destino'], rows: [['', '']], allowRows: true },
        { type: 'pagebreak' },
        { type: 'title', text: 'ANÁLISE QUANTITATIVA' },
        { type: 'paragraph', text: 'Quantidade de registros importados no RM:' },
        { type: 'table', columns: ['DADO', 'QUANTIDADE'], rows: DATA_ROWS.map((d) => [d, '']), allowRows: true },
        { type: 'pagebreak' },
        { type: 'title', text: 'ERROS DE CARGA' },
        { type: 'paragraph', text: '{{doc.erros_carga}}' },
      ],
    },
    {
      id: 'dt-termo-validacao-mit010', name: 'Termo de Validação MIT010', active: true, stageId, baseDocumentId: null, createdAt: SEED_AT, updatedAt: SEED_AT,
      description: 'Termo de validação de entrega/marco: ambientação, processos de carga validados (data, usuário-chave, analista) e aceite.',
      fileName: 'Termo de Validação - MIT010 - {{project.name}} - {{doc.data}}',
      fields: [F('cliente', 'Nome do cliente'), F('codigo_cliente', 'Código de cliente'), F('projeto', 'Nome do projeto', 'Migração de Dados (Folha de Pagamento)'),
        F('codigo_projeto', 'Código do projeto'), F('segmento', 'Segmento cliente'), F('unidade', 'Unidade TOTVS', 'TOTVS Nordeste'),
        F('data', 'Data (término da migração)', '{{today}}'), F('proposta', 'Proposta comercial'), F('coordenador_totvs', 'Gerente/Coordenador TOTVS', '{{project.coordinator}}'),
        F('coordenador_cliente', 'Gerente/Coordenador cliente', '', { people: true }),
        F('entrega', 'Tipo de entrega (título)', 'Marco', { options: ['Marco', 'Carga Complementar'] }),
        F('marco', 'Marco', '1ª Migração das tabelas em ambiente de HOMOLOGAÇÃO', { options: ['1ª Migração das tabelas em ambiente de HOMOLOGAÇÃO', 'Migração das tabelas em ambiente de PRODUÇÃO /1ª Carga Complementar'] }),
        F('analista', 'Analista de Serviços TOTVS', '{{project.analyst}}', { people: true }), F('aprovado_por', 'Aprovado por', '', { people: true, hint: 'Em geral, o coordenador do cliente.' })],
      blocks: [
        { type: 'title', text: 'Ambientação' },
        { type: 'info', rows: [[{ label: 'Nome do cliente:', value: '{{doc.cliente}}' }, { label: 'Código de cliente:', value: '{{doc.codigo_cliente}}' }],
          [{ label: 'Nome do projeto:', value: '{{doc.projeto}}' }, { label: 'Código do projeto:', value: '{{doc.codigo_projeto}}' }],
          [{ label: 'Segmento cliente:', value: '{{doc.segmento}}' }, { label: 'Unidade TOTVS:', value: '{{doc.unidade}}' }],
          [{ label: 'Data:', value: '{{doc.data}}' }, { label: 'Proposta comercial:', value: '{{doc.proposta}}' }],
          [{ label: 'Gerente/Coordenador TOTVS:', value: '{{doc.coordenador_totvs}}' }], [{ label: 'Gerente/Coordenador cliente:', value: '{{doc.coordenador_cliente}}' }]] },
        { type: 'title', text: 'Termo de Validação de Entrega / {{doc.entrega}}' },
        { type: 'paragraph', text: 'Informo que foram concluídas as atividades que compõem o marco {{doc.marco}}, estando o usuário de acordo com os processos abaixo relacionados. Sendo assim, declaro validados e aceitos os processos.' },
        { type: 'table', columns: ['Nome do Processo', 'Data de Validação', 'Nome / Assinatura do Usuário Chave', 'Nome / Assinatura do Analista de Serviços Totvs'],
          rows: PROCESSES.map((p) => [p, '{{doc.data}}', '', '{{doc.analista}}']), allowRows: true },
        { type: 'title', text: 'Aceite' },
        { type: 'table', columns: ['Aprovado por', 'Assinatura', 'Data'], rows: [['{{doc.aprovado_por}}', '', '{{doc.data}}']], allowRows: false },
      ],
    },
  ];
}

module.exports = {
  BLOCK_TYPES, FIELD_TYPES, MAX_GENERATIONS, publicVariables, cleanTemplate, autoFields, fieldsOf, templateUsage, buildForm, cleanInput, render, previewHtml, fileNameFor,
  generationRecord, pushGeneration, defaultTemplates, references,
};
