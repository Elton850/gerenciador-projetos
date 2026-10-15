'use strict';
// Gerar documentos (Documentos e Modelos → aba "Gerar documentos" e card Documentos do projeto). Mesmo padrão de Comunicações:
// modelo com campos/variáveis → formulário com os dados do projeto → prévia → Word (.docx) baixado. Regras no servidor (src/docgen.js).

const DG = { meta: null };
const dgLoad = async () => (DG.meta = await api('GET', '/api/doc-templates'));
const DG_BLOCK_HINT = {
  info: 'Uma linha por linha do quadro, no formato “Rótulo: valor”. Duas células na mesma linha: separe com “||”.',
  table: 'Colunas e células separadas por “|”. Uma linha por linha da tabela; na geração todas as células podem ser ajustadas.',
};

// Baixa o .docx gerado (fetch + blob, como a exportação de horas).
async function dgDownload(url, body, fallbackName) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Erro ${r.status}`);
  const cd = r.headers.get('Content-Disposition') || '';
  const name = decodeURIComponent((cd.match(/filename\*=UTF-8''([^;]+)/) || [])[1] || '') || fallbackName;
  const href = URL.createObjectURL(await r.blob());
  const a = h('a', { href, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 5000);
  return name;
}

// ---------- Aba "Gerar documentos" da biblioteca ----------
function dgTab() {
  const box = h('div', { class: 'stack' }, h('div', { class: 'card' }, h('div', { class: 'card-body muted' }, 'Carregando modelos…')));
  const draw = () => box.replaceChildren(...dgTemplateList(draw));
  dgLoad().then(draw).catch((e) => box.replaceChildren(h('div', { class: 'card' }, h('div', { class: 'card-body' }, h('div', { class: 'empty' }, e.message)))));
  return box;
}

function dgTemplateList(redraw) {
  const reload = async () => { await dgLoad(); redraw(); };
  const ts = DG.meta.templates;
  const row = (t) => h('div', { class: `row${t.active ? '' : ' em-off'}` },
    h('div', { class: 'grow stack' },
      h('div', { class: 'inline' }, h('strong', null, t.name), h('span', { class: 'kind modelo' }, 'Gera Word'),
        t.stageId && stageById(t.stageId) ? stageTag(stageById(t.stageId)) : noStageTag('Uso geral'), t.active ? null : h('span', { class: 'pill cancelled' }, 'desativado')),
      t.description ? h('span', { class: 'small muted' }, t.description) : null,
      h('span', { class: 'small muted' }, `${t.base ? `Papel timbrado: ${t.base.title}${t.base.missing || t.base.fileExists === false ? ' (não encontrado — usa o layout padrão)' : ''}` : 'Layout padrão (sem papel timbrado)'} · ${plural(t.fields.length, 'campo', 'campos')} · ${t.usage ? `gerado ${plural(t.usage, 'vez', 'vezes')}` : 'nunca gerado'}`)),
    h('div', { class: 'actions' },
      t.active ? h('button', { class: 'btn sm primary', onclick: () => dgPickProject(t) }, 'Gerar…') : null,
      h('button', { class: 'btn sm ghost', onclick: () => dgForm(t, reload) }, 'Editar'),
      h('button', { class: 'btn sm ghost', onclick: (e) => busy(e.target, async () => { await api('POST', `/api/doc-templates/${t.id}/duplicate`); await reload(); toast('Modelo duplicado.'); }) }, 'Duplicar'),
      h('button', { class: 'btn sm ghost', onclick: (e) => busy(e.target, async () => { await api('PUT', `/api/doc-templates/${t.id}`, { active: !t.active }); await reload(); }) }, t.active ? 'Desativar' : 'Reativar'),
      t.usage ? null : h('button', { class: 'btn sm ghost', onclick: async () => {
        if (!(await confirmDialog({ title: 'Excluir modelo', message: `Excluir o modelo “${t.name}”? Ele nunca foi usado.`, okText: 'Excluir', danger: true }))) return;
        try { await api('DELETE', `/api/doc-templates/${t.id}`); await reload(); } catch (e) { fail(e); }
      } }, 'Excluir')));
  return [
    h('div', { class: 'card' }, h('div', { class: 'card-body' }, h('div', { class: 'inline' },
      h('div', { class: 'grow muted' }, 'Modelos que geram o documento do projeto em Word (.docx): os dados do projeto entram sozinhos, o restante é preenchido na hora, com prévia. Escolha um .docx da biblioteca como papel timbrado para manter cabeçalho, rodapé e logo.'),
      h('button', { class: 'btn primary', onclick: () => dgForm(null, reload) }, '+ Modelo de documento')))),
    ts.length ? card('Modelos de documentos', null, ts.map(row)) : h('div', { class: 'card' }, h('div', { class: 'card-body' }, h('div', { class: 'empty' }, 'Nenhum modelo de documento. Crie um com “+ Modelo de documento”.'))),
  ];
}

function dgPickProject(t) {
  const list = state.projects.filter((p) => !p.cancelled);
  if (!list.length) return toast('Cadastre um projeto antes de gerar documentos.', 'error');
  const sel = h('select', null, list.map((p) => h('option', { value: p.id }, p.name)));
  const md = openModal({ title: `Gerar “${t.name}”`, size: 'sm', body: [field('Projeto', sel, 'Os dados do projeto preenchem o documento; você confere e ajusta antes de baixar.')],
    footer: [h('button', { class: 'btn', onclick: () => md.close() }, 'Cancelar'), h('button', { class: 'btn primary', onclick: () => { md.close(); dgGenerate(sel.value, t.id); } }, 'Continuar')] });
}

// ---------- Editor do modelo ----------
const dgSlug = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'c_$1').slice(0, 40);
const dgInfoText = (rows) => rows.map((r) => r.map((c) => `${c.label} ${c.value}`.trim()).join(' || ')).join('\n');
const dgInfoParse = (text) => String(text).split('\n').map((ln) => ln.split('||').map((part) => {
  const i = part.indexOf(':');
  return i < 0 ? { label: '', value: part.trim() } : { label: part.slice(0, i + 1).trim(), value: part.slice(i + 1).trim() };
}).filter((c) => c.label || c.value)).filter((r) => r.length);
const dgCells = (ln) => String(ln).split('|').map((c) => c.trim());

async function dgForm(t, onSaved) {
  if (!DG.meta) await dgLoad().catch(fail);
  const meta = DG.meta;
  let lastFocus = null;
  const track = (el) => { el.addEventListener('focus', () => { lastFocus = el; }); return el; };
  const name = h('input', { type: 'text', value: t?.name || '', maxlength: 120, placeholder: 'Ex.: Termo de Validação MIT010' });
  const desc = h('input', { type: 'text', value: t?.description || '', maxlength: 600, placeholder: 'Opcional: quando usar' });
  const stage = h('select', null, h('option', { value: '' }, '— Uso geral (todas as etapas) —'), state.stages.map((s) => h('option', { value: s.id, selected: t?.stageId === s.id }, s.name)));
  const base = h('select', null, h('option', { value: '' }, 'Layout padrão (sem papel timbrado)'),
    meta.docxDocuments.map((d) => h('option', { value: d.id, selected: t?.baseDocumentId === d.id }, d.title)),
    t?.baseDocumentId && !meta.docxDocuments.some((d) => d.id === t.baseDocumentId) ? h('option', { value: '', selected: true }, '(papel timbrado removido — escolha outro)') : null);
  const fileName = track(h('input', { type: 'text', value: t?.fileName || '', maxlength: 200, placeholder: 'Ex.: Termo - {{project.name}} - {{doc.data}}' }));
  const active = h('input', { type: 'checkbox', checked: t ? t.active : true });

  // Campos
  const fields = (t?.fields || []).map((f) => ({ ...f }));
  const fieldsBox = h('div', { class: 'stack' });
  const drawFields = () => fieldsBox.replaceChildren(...fields.map((f, i) => {
    const lbl = h('input', { type: 'text', value: f.label, maxlength: 120, placeholder: 'Nome do campo', oninput: (e) => { const auto = !f.key || f.key === dgSlug(f.label); f.label = e.target.value; if (auto) { f.key = dgSlug(f.label); key.value = f.key; } } });
    const key = h('input', { type: 'text', value: f.key, maxlength: 40, class: 'mono', placeholder: 'chave', oninput: (e) => { f.key = e.target.value; } });
    const type = h('select', { onchange: (e) => { f.type = e.target.value; } }, Object.entries(meta.fieldTypes).map(([k, l]) => h('option', { value: k, selected: f.type === k }, l)));
    const def = track(h('input', { type: 'text', value: f.default, placeholder: 'Valor inicial (pode usar variáveis do projeto)', oninput: (e) => { f.default = e.target.value; } }));
    const opts = h('input', { type: 'text', value: (f.options || []).join('; '), placeholder: 'Sugestões separadas por “;” (opcional)', oninput: (e) => { f.options = e.target.value.split(';').map((x) => x.trim()).filter(Boolean); } });
    const people = h('label', { class: 'inline small' }, h('input', { type: 'checkbox', checked: !!f.people, onchange: (e) => { f.people = e.target.checked; } }), 'Sugerir pessoas do projeto');
    const move = (d) => { const j = i + d; if (j < 0 || j >= fields.length) return; [fields[i], fields[j]] = [fields[j], fields[i]]; drawFields(); };
    return h('div', { class: 'dg-edit-item' },
      h('div', { class: 'dg-edit-grid' }, lbl, key, type, h('div', { class: 'actions' },
        h('button', { class: 'btn sm ghost', title: 'Subir', onclick: () => move(-1) }, '↑'), h('button', { class: 'btn sm ghost', title: 'Descer', onclick: () => move(1) }, '↓'),
        h('button', { class: 'btn sm ghost', title: 'Remover campo', onclick: () => { fields.splice(i, 1); drawFields(); drawVars(); } }, '✕'))),
      h('div', { class: 'cols2' }, def, opts), people, h('span', { class: 'small muted mono' }, `{{doc.${f.key || '…'}}}`));
  }), h('div', null, h('button', { class: 'btn sm', onclick: () => { fields.push({ key: '', label: '', type: 'text', default: '', options: [], hint: '', people: false }); drawFields(); drawVars(); } }, '+ Campo')));

  // Blocos
  const blocks = (t?.blocks || [{ type: 'title', text: '' }]).map((b) => JSON.parse(JSON.stringify(b)));
  const blocksBox = h('div', { class: 'stack' });
  const drawBlocks = () => blocksBox.replaceChildren(...blocks.map((b, i) => {
    let body = null;
    if (b.type === 'title') body = track(h('input', { type: 'text', value: b.text || '', maxlength: 300, oninput: (e) => { b.text = e.target.value; } }));
    else if (b.type === 'paragraph') body = track(h('textarea', { rows: 3, oninput: (e) => { b.text = e.target.value; } }, b.text || ''));
    else if (b.type === 'info') body = [track(h('textarea', { rows: Math.min(10, Math.max(3, b.rows.length + 1)), class: 'mono small', oninput: (e) => { b.rows = dgInfoParse(e.target.value); } }, dgInfoText(b.rows))), h('div', { class: 'hint' }, DG_BLOCK_HINT.info)];
    else if (b.type === 'table') {
      body = [track(h('input', { type: 'text', value: b.columns.join(' | '), placeholder: 'Coluna 1 | Coluna 2', oninput: (e) => { b.columns = dgCells(e.target.value).filter(Boolean); } })),
        track(h('textarea', { rows: Math.min(10, Math.max(3, b.rows.length + 1)), class: 'mono small', placeholder: 'célula | célula', oninput: (e) => { b.rows = e.target.value.split('\n').filter((x) => x.trim()).map(dgCells); } }, b.rows.map((r) => r.join(' | ')).join('\n'))),
        h('label', { class: 'inline small' }, h('input', { type: 'checkbox', checked: !!b.allowRows, onchange: (e) => { b.allowRows = e.target.checked; } }), 'Permitir incluir/remover linhas na geração'),
        h('div', { class: 'hint' }, DG_BLOCK_HINT.table)];
    }
    const move = (d) => { const j = i + d; if (j < 0 || j >= blocks.length) return; [blocks[i], blocks[j]] = [blocks[j], blocks[i]]; drawBlocks(); };
    return h('div', { class: 'dg-edit-item' },
      h('div', { class: 'inline' }, h('strong', { class: 'grow small' }, `${i + 1}. ${meta.blockTypes[b.type]}`),
        h('button', { class: 'btn sm ghost', title: 'Subir', onclick: () => move(-1) }, '↑'), h('button', { class: 'btn sm ghost', title: 'Descer', onclick: () => move(1) }, '↓'),
        h('button', { class: 'btn sm ghost', title: 'Remover bloco', onclick: () => { blocks.splice(i, 1); drawBlocks(); } }, '✕')),
      body);
  }), h('div', { class: 'inline' }, ...Object.entries(meta.blockTypes).map(([k, l]) => h('button', { class: 'btn sm', onclick: () => {
    blocks.push(k === 'table' ? { type: k, columns: ['Coluna 1', 'Coluna 2'], rows: [['', '']], allowRows: true } : k === 'info' ? { type: k, rows: [[{ label: 'Rótulo:', value: '' }]] } : k === 'pagebreak' ? { type: k } : { type: k, text: '' });
    drawBlocks();
  } }, `+ ${l}`))));

  // Variáveis (clique insere no último campo de texto focado)
  const varsBox = h('div', { class: 'em-vars' });
  const insert = (key) => {
    const el = lastFocus; if (!el) return toast('Clique primeiro no campo onde a variável deve entrar.');
    const s = el.selectionStart ?? el.value.length; const tok = `{{${key}}}`;
    el.value = el.value.slice(0, s) + tok + el.value.slice(el.selectionEnd ?? s);
    el.dispatchEvent(new Event('input')); el.focus(); el.setSelectionRange(s + tok.length, s + tok.length);
  };
  const drawVars = () => {
    const groups = {};
    for (const v of meta.variables) (groups[v.group] ||= []).push(v);
    groups['Campos do documento'] = fields.filter((f) => f.key).map((f) => ({ key: `doc.${f.key}`, label: f.label }));
    varsBox.replaceChildren(h('strong', { class: 'small' }, 'Variáveis'), h('span', { class: 'small muted' }, 'Clique para inserir onde está o cursor.'),
      ...Object.entries(groups).flatMap(([g, vs]) => [h('div', { class: 'em-vgroup' }, g), ...vs.map((v) => h('button', { class: 'em-var', type: 'button', onmousedown: (e) => e.preventDefault(), onclick: () => insert(v.key) }, `{{${v.key}}}`, h('span', null, v.label)))]));
  };
  drawFields(); drawBlocks(); drawVars();

  const md = openModal({
    title: t ? `Editar modelo — ${t.name}` : 'Novo modelo de documento', size: 'xl',
    body: [h('div', { class: 'em-editor' }, h('div', { class: 'stack' },
      field('Nome', name), field('Descrição', desc),
      h('div', { class: 'cols2' }, field('Etapa em que é usado', stage), field('Papel timbrado (.docx da biblioteca)', base, 'Mantém cabeçalho, rodapé, logo e fontes desse arquivo; o corpo é trocado pelo conteúdo gerado.')),
      field('Nome do arquivo gerado', fileName, 'Sem extensão; pode usar variáveis. Datas dd/mm/aaaa viram dd-mm-aaaa.'),
      h('label', { class: 'inline small' }, active, 'Modelo ativo (aparece nos projetos)'),
      h('h3', null, 'Campos do documento'), h('div', { class: 'hint' }, 'Preenchidos na geração. Use {{doc.chave}} no conteúdo. O valor inicial pode trazer dados do projeto (ex.: {{project.coordinator}}).'), fieldsBox,
      h('h3', null, 'Conteúdo'), blocksBox), varsBox)],
    footer: [h('button', { class: 'btn', onclick: () => md.close() }, 'Cancelar'),
      h('button', { class: 'btn primary', onclick: (e) => busy(e.target, async () => {
        const body = { name: name.value, description: desc.value, stageId: stage.value || null, baseDocumentId: base.value || null, fileName: fileName.value, active: active.checked, fields, blocks };
        await (t ? api('PUT', `/api/doc-templates/${t.id}`, body) : api('POST', '/api/doc-templates', body));
        md.close(); toast('Modelo salvo.'); onSaved && (await onSaved());
      }) }, 'Salvar')],
  });
  name.focus();
}

// ---------- Janela Gerar (formulário + prévia) ----------
async function dgGenerate(projectId, tid, onDone) {
  let d;
  try { d = await api('POST', `/api/projects/${projectId}/doc-templates/${tid}/form`); } catch (e) { return fail(e); }
  const values = Object.fromEntries(d.fields.map((f) => [f.key, f.value]));
  const tables = JSON.parse(JSON.stringify(d.tables));
  const page = h('div', { class: 'dg-page' }, h('div', { class: 'muted small' }, 'Montando a prévia…'));
  const warnBox = h('div');
  const fileLine = h('div', { class: 'small muted mono' });
  let timer = null; let seq = 0;
  const preview = () => { clearTimeout(timer); timer = setTimeout(async () => {
    const my = ++seq;
    try {
      const r = await api('POST', `/api/projects/${projectId}/doc-templates/${tid}/preview`, { fields: values, tables });
      if (my !== seq) return;
      page.innerHTML = r.html; // HTML montado no servidor com todo texto escapado (docgen.previewHtml)
      fileLine.textContent = `Arquivo: ${r.fileName}`;
      warnBox.replaceChildren(r.warnings.length ? h('div', { class: 'box warn small stack' }, h('strong', null, 'Confira antes de baixar'), h('ul', null, r.warnings.map((w) => h('li', null, `⚠ ${w}`)))) : '');
    } catch (e) { if (my === seq) warnBox.replaceChildren(h('div', { class: 'box warn small' }, e.message)); }
  }, 300); };

  const people = h('datalist', { id: 'dg-people' }, d.people.map((n) => h('option', { value: n })));
  const fieldEls = d.fields.map((f) => {
    const listId = f.options?.length ? `dg-opt-${f.key}` : f.people ? 'dg-people' : null;
    const input = f.type === 'textarea'
      ? h('textarea', { rows: 3, oninput: (e) => { values[f.key] = e.target.value; preview(); } }, f.value)
      : h('input', { type: 'text', value: f.value, list: listId, oninput: (e) => { values[f.key] = e.target.value; preview(); } });
    return h('div', { class: 'field' }, h('label', null, f.label), input,
      f.options?.length ? h('datalist', { id: listId }, f.options.map((o) => h('option', { value: o }))) : null,
      f.hint ? h('div', { class: 'hint' }, f.hint) : null,
      (f.warnings || []).map((w) => h('div', { class: 'hint dg-warn' }, `⚠ ${w}`)));
  });

  const tableEls = d.template.tables.map((tb) => {
    const box = h('div', { class: 'stack' });
    const draw = () => {
      const rows = tables[tb.index];
      box.replaceChildren(h('div', { class: 'dg-grid-wrap' }, h('table', { class: 'dg-grid' },
        h('thead', null, h('tr', null, tb.columns.map((c) => h('th', null, c)), tb.allowRows ? h('th', null, '') : null)),
        h('tbody', null, rows.map((r, i) => h('tr', null, r.map((c, k) => h('td', null, h('input', { type: 'text', value: c, oninput: (e) => { rows[i][k] = e.target.value; preview(); } }))),
          tb.allowRows ? h('td', null, h('button', { class: 'btn sm ghost', title: 'Remover linha', onclick: () => { rows.splice(i, 1); draw(); preview(); } }, '✕')) : null))))),
      tb.allowRows ? h('div', null, h('button', { class: 'btn sm', onclick: () => { rows.push(tb.columns.map(() => '')); draw(); } }, '+ Linha')) : null);
    };
    draw();
    return h('div', { class: 'stack' }, h('strong', { class: 'small' }, tb.columns.join(' · ')), box);
  });

  const md = openModal({
    title: `${d.template.name}`, size: 'xl',
    body: [h('div', { class: 'dg-gen' },
      h('div', { class: 'stack dg-gen-form' },
        d.last ? h('div', { class: 'hint' }, `Valores da última geração (${new Date(d.last.at).toLocaleString('pt-BR')}${d.last.by ? `, ${d.last.by}` : ''}). Ajuste o que mudou.`) : h('div', { class: 'hint' }, 'Campos com dados do projeto já vêm preenchidos. O restante é preenchido aqui.'),
        d.template.base ? h('div', { class: 'small muted' }, `Papel timbrado: ${d.template.base.title}`) : null,
        people, fieldEls,
        tableEls.length ? h('div', { class: 'hint' }, 'Tabelas: {{doc.chave}} numa célula repete o campo correspondente (ex.: a data).') : null, tableEls),
      h('div', { class: 'stack dg-gen-preview' }, h('strong', { class: 'small' }, 'Prévia'), warnBox, page, fileLine))],
    footer: [h('button', { class: 'btn', onclick: () => md.close() }, 'Fechar'),
      h('button', { class: 'btn primary', onclick: (e) => busy(e.target, async () => {
        const name = await dgDownload(`/api/projects/${projectId}/doc-templates/${tid}/generate`, { fields: values, tables }, `${d.template.name}.docx`);
        toast(`Documento gerado: ${name}`);
        onDone && onDone();
      }, 'Gerando documento…') }, 'Baixar Word (.docx)')],
  });
  preview();
}

// ---------- Card Documentos do projeto ----------
function dgProjectSection(p) {
  const box = h('div', { class: 'stack dg-proj' });
  const st = stageOf(p);
  const load = async () => {
    let r;
    try { r = await api('GET', `/api/projects/${p.id}/doc-templates`); } catch (e) { return box.replaceChildren(h('div', { class: 'hint' }, e.message)); }
    const here = r.templates.filter((t) => st && t.stageId === st.id);
    const others = r.templates.filter((t) => !here.includes(t));
    const btn = (t) => h('button', { class: 'btn sm', title: t.description || '', onclick: () => dgGenerate(p.id, t.id, load) }, t.name);
    box.replaceChildren(...[
      h('div', { class: 'inline' }, h('strong', { class: 'small grow' }, 'Gerar documento'), h('a', { class: 'link-quiet small', href: '#/docs', onclick: () => { docFilter.tab = 'gen'; } }, 'Modelos')),
      !r.templates.length ? h('div', { class: 'hint' }, 'Nenhum modelo de documento ativo.') : null,
      here.length ? h('div', { class: 'inline' }, here.map(btn)) : null,
      others.length ? h('div', { class: 'inline' }, here.length ? h('span', { class: 'small muted' }, 'Outros:') : null, others.map(btn)) : null,
      r.generations.length ? h('details', { class: 'small' }, h('summary', null, `Gerados recentemente (${r.generations.length})`),
        h('div', { class: 'stack' }, r.generations.map((g) => h('div', { class: 'inline' }, h('span', { class: 'grow' }, g.fileName),
          h('span', { class: 'muted' }, `${new Date(g.at).toLocaleString('pt-BR')}${g.by ? ` · ${g.by}` : ''}`))))) : null].filter(Boolean)); // replaceChildren escreveria "null"
  };
  load();
  return box;
}
