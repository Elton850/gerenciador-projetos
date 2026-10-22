'use strict';
// Scripts SQL → Gerar arquivos de importação (#/scripts/export).
// Executar o script (transação sempre desfeita no final) → ver o resultado → escolher pastas (níveis), colunas do conteúdo (ordem, separador, NULL) e
// nome do arquivo → prévia (nada é escrito) → gerar. A configuração pode ser salva no próprio script.
// Reaproveita: resultGrid/runPref/fmtMs (checklist.js), choiceDialog (workspace.js), pathField/lastDir (app.js).

let exportScriptId = null; // script pré-selecionado ao vir da lista de scripts
const XP_ROWS = [1000, 5000, 20000, 50000, 200000];

async function renderScriptExport(main) {
  main.append(h('div', { class: 'page' }, h('div', { class: 'empty' }, 'Carregando…')));
  let info;
  try { [info] = await Promise.all([api('GET', '/api/script-export/targets'), loadScripts()]); } catch (e) { return fail(e); }
  if (route().name !== 'scripts' || route().id !== 'export') return;
  const scripts = scriptsCache.filter((s) => s.exists);
  const head = h('div', { class: 'page-head' }, h('div', { class: 'grow' }, h('h1', null, 'Gerar arquivos de importação'),
    h('div', { class: 'muted' }, 'Executa um script cadastrado, mostra o resultado e grava um arquivo por grupo de linhas, organizado em pastas pelas colunas que você escolher.')),
  h('div', { class: 'inline' }, h('button', { class: 'btn', onclick: () => (location.hash = '#/scripts') }, '← Scripts SQL')));
  if (!scripts.length || !info.targets.length) {
    return main.replaceChildren(h('div', { class: 'page' }, head, h('div', { class: 'card' }, h('div', { class: 'card-body' },
      !scripts.length ? h('div', null, 'Nenhum script cadastrado. ', h('a', { href: '#/scripts' }, 'Cadastrar um script')) : null,
      !info.targets.length ? h('div', null, 'Nenhuma conexão cadastrada. ', h('a', { href: '#/settings/conexoes' }, 'Cadastrar em Configurações → Conexões')) : null))));
  }

  let result = null; // resposta de /run
  let setIdx = 0;
  let shown = XP_ROWS[0];
  let previewOk = false;
  let xpDir = null; // campo da pasta de saída (a geração confere se ainda é a pasta da prévia)

  // ---------- Executar ----------
  const scriptSel = h('select', { 'aria-label': 'Script' }, scripts.map((s) => h('option', { value: s.id }, s.name)));
  scriptSel.value = scripts.some((s) => s.id === exportScriptId) ? exportScriptId : scripts[0].id;
  const connSel = h('select', { 'aria-label': 'Conexão' }, info.targets.map((t) => h('option', { value: t.key }, `${t.label} — ${t.envLabel}`)));
  const saved = runPref('script-export');
  connSel.value = info.targets.some((t) => t.key === saved) ? saved : info.defaultKey;
  const dbInput = h('input', { type: 'text', placeholder: 'Banco', style: 'width:200px' });
  const targetInfo = h('span', { class: 'small muted' });
  const syncTarget = () => {
    const t = info.targets.find((x) => x.key === connSel.value);
    if (t && !dbInput.dataset.touched) dbInput.value = t.database || '';
    targetInfo.replaceChildren(t ? h('span', null, pill(t.env === 'local' ? 'local' : t.env === 'prod' ? 'prod' : 'soon', t.envLabel.toUpperCase()), ` ${t.server}`) : '');
  };
  dbInput.addEventListener('input', () => { dbInput.dataset.touched = '1'; });
  connSel.addEventListener('change', () => { dbInput.dataset.touched = ''; syncTarget(); });
  syncTarget();
  const varsBox = h('div', { class: 'inline' });
  let varInputs = {};
  const loadVars = async () => {
    const v = await api('GET', `/api/scripts/${scriptSel.value}/variables`).catch(() => ({ user: [] }));
    varInputs = Object.fromEntries(v.user.map((n) => [n, h('input', { type: 'text', maxlength: 128, placeholder: n, style: 'width:180px' })]));
    varsBox.replaceChildren(...(v.user.length ? [h('span', { class: 'small muted' }, 'Variáveis:'), ...v.user.map((n) => h('label', { class: 'inline small', style: 'gap:4px' }, h('span', { class: 'mono' }, `{{${n}}}`), varInputs[n]))] : []));
  };
  const runBtn = h('button', { class: 'btn primary' }, '▶ Executar');
  const stopBtn = h('button', { class: 'btn', style: 'display:none', title: 'Cancela a execução' }, 'Parar');
  const status = h('div', { class: 'small muted' }, 'O script roda numa transação que é sempre desfeita no final: nada é gravado no banco. Nenhum arquivo é escrito antes de você confirmar.');
  const resultBox = h('div', { class: 'stack' });
  const configBox = h('div', { class: 'stack' });
  const previewBox = h('div', { class: 'stack' });

  const clearAfterRun = () => { result = null; resultBox.replaceChildren(); configBox.replaceChildren(); previewBox.replaceChildren(); };
  scriptSel.addEventListener('change', () => { exportScriptId = scriptSel.value; clearAfterRun(); loadVars(); });

  let ctrl = null; let timer = null;
  const exec = async (confirmToken) => {
    runPref('script-export', connSel.value);
    const body = { scriptId: scriptSel.value, target: connSel.value, database: dbInput.value, vars: Object.fromEntries(Object.entries(varInputs).map(([n, el]) => [n, el.value])), confirmToken };
    ctrl = new AbortController();
    const t0 = Date.now();
    clearAfterRun();
    runBtn.disabled = true; stopBtn.style.display = ''; scriptSel.disabled = true; connSel.disabled = true;
    status.textContent = 'Executando script… 0 s';
    timer = setInterval(() => { status.textContent = `Executando script… ${Math.round((Date.now() - t0) / 1000)} s`; }, 500);
    try {
      const r = await fetch('/api/script-export/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (json.code === 'SCRIPT_CONFIRM') {
          const c = json.confirm;
          const ok = await confirmDialog({ title: 'Confirmar execução', message: `${scriptName()}\nConexão: ${c.target} (${c.env}) — ${c.server} / ${c.database}\n\n${c.reasons.map((x) => `• ${x}`).join('\n')}\n\nNesta tela a transação é sempre desfeita no final: nada fica gravado no banco.`, okText: 'Executar mesmo assim', danger: true });
          status.textContent = ok ? '' : 'Execução cancelada.';
          if (ok) { clearInterval(timer); return exec(c.token); }
          return;
        }
        if (json.code === 'SCRIPT_VARS') { (json.missing || []).forEach((n) => varInputs[n]?.classList.add('invalid')); (varInputs[json.missing?.[0]])?.focus(); }
        status.textContent = '';
        const fix = json.code === 'PASSWORD_UNREADABLE' && json.connectionId ? connectionPasswordFix(json.connectionId) : null;
        resultBox.replaceChildren(h('div', { class: 'box bad small', style: 'white-space:pre-line' }, json.error || `Erro ${r.status}`,
          fix ? h('div', { style: 'margin-top:8px' }, h('button', { class: 'btn sm primary', onclick: fix }, 'Informar a senha da conexão')) : null));
        return;
      }
      status.textContent = '';
      result = json; setIdx = 0; shown = XP_ROWS[0];
      showResult();
    } catch (e) {
      status.textContent = e.name === 'AbortError' ? 'Execução cancelada.' : '';
      if (e.name !== 'AbortError') resultBox.replaceChildren(h('div', { class: 'box bad small' }, e.message));
    } finally {
      clearInterval(timer); ctrl = null; runBtn.disabled = false; stopBtn.style.display = 'none'; scriptSel.disabled = false; connSel.disabled = false;
    }
  };
  runBtn.addEventListener('click', () => exec());
  stopBtn.addEventListener('click', () => ctrl && ctrl.abort());
  const scriptName = () => scripts.find((s) => s.id === scriptSel.value)?.name || '';
  const script = () => scriptsCache.find((s) => s.id === scriptSel.value);

  // ---------- Resultado ----------
  function showResult() {
    const r = result;
    if (!r.ok) {
      resultBox.replaceChildren(h('div', { class: 'box bad small' }, h('strong', null, '✕ Erro ao executar o script — nada foi gravado.'), h('div', { class: 'mono', style: 'margin-top:4px;white-space:pre-wrap' }, r.error),
        r.errorInfo?.number ? h('div', { class: 'muted' }, `Erro ${r.errorInfo.number}${r.errorInfo.severity ? `, nível ${r.errorInfo.severity}` : ''} · ${fmtMs(r.ms)}`) : null));
      return;
    }
    if (!r.sets.length) {
      resultBox.replaceChildren(h('div', { class: 'box warn small' }, h('strong', null, 'O script não retornou nenhum resultado.'), ' Para gerar arquivos ele precisa terminar com um SELECT.',
        r.messages.length ? h('pre', { class: 'run-msgs' }, r.messages.join('\n')) : null));
      return;
    }
    const rs = r.sets[setIdx];
    const setSel = r.sets.length > 1 ? h('select', { onchange: (e) => { setIdx = Number(e.target.value); shown = XP_ROWS[0]; showResult(); } },
      r.sets.map((s, i) => h('option', { value: i, selected: i === setIdx }, `Resultado ${i + 1} (${s.total.toLocaleString('pt-BR')} linhas)`))) : null;
    const rowsSel = h('select', { 'aria-label': 'Linhas exibidas', onchange: async (e) => {
      const n = Number(e.target.value);
      try { const more = await api('GET', `/api/script-export/results/${r.resultId}/rows?set=${setIdx}&limit=${n}`); rs.rows = more.rows; shown = n; showResult(); } catch (err) { fail(err); }
    } }, XP_ROWS.filter((n, i) => i === 0 || XP_ROWS[i - 1] < rs.loaded).map((n) => h('option', { value: n, selected: n === shown }, n >= rs.loaded ? `Todas (${rs.loaded.toLocaleString('pt-BR')})${rs.loaded > 20000 ? ' — pode ficar lento' : ''}` : n.toLocaleString('pt-BR'))));
    const tooBig = rs.total > rs.loaded;
    resultBox.replaceChildren(...[
      h('div', { class: 'box ok-box small' }, h('strong', null, `✓ ${plural(rs.total, 'linha retornada', 'linhas retornadas')}`), ` · ${plural(rs.columns.length, 'coluna', 'colunas')} · ${fmtMs(r.ms)} · ${r.target}${r.identity ? ` (${r.identity.server} / ${r.identity.database})` : ''} · transação desfeita`),
      tooBig ? h('div', { class: 'box bad small' }, `O resultado passou do limite de ${rs.loaded.toLocaleString('pt-BR')} linhas: não é possível gerar os arquivos. Divida o script.`) : null,
      r.cellTruncated ? h('div', { class: 'box bad small' }, 'Algum valor passou do tamanho máximo e seria cortado: não é possível gerar os arquivos.') : null,
      rs.hiddenColumns ? h('div', { class: 'box bad small' }, `O resultado tem ${plural(rs.hiddenColumns, 'coluna', 'colunas')} além do limite de ${rs.columns.length.toLocaleString('pt-BR')}: não é possível gerar os arquivos.`) : null,
      h('div', { class: 'inline' }, setSel, h('span', { class: 'small muted' }, 'Colunas encontradas:'), rs.columns.map((c) => h('span', { class: 'pill' }, c || '(sem nome)'))),
      resultGrid(rs),
      h('div', { class: 'inline small muted' }, `Mostrando ${Math.min(rs.rows.length, rs.total).toLocaleString('pt-BR')} de ${rs.total.toLocaleString('pt-BR')}`, rs.loaded > XP_ROWS[0] ? h('label', { class: 'inline', style: 'gap:6px' }, 'Exibir:', rowsSel) : null)].filter(Boolean));
    showConfig(rs);
  }

  // ---------- Organização ----------
  function showConfig(rs) {
    const cfg = script()?.exportConfig || result.config || {};
    const cols = rs.columns;
    const has = (n) => cols.some((c) => c.toLowerCase() === String(n).toLowerCase());
    const colSelect = (value, empty) => {
      const sel = h('select', null, empty ? h('option', { value: '' }, empty) : null, cols.map((c) => h('option', { value: c }, c || '(sem nome)')),
        value && !has(value) ? h('option', { value }, `${value} (não existe no resultado)`) : null);
      sel.value = value ? (cols.find((c) => c.toLowerCase() === value.toLowerCase()) ?? value) : '';
      sel.classList.toggle('invalid', !!value && !has(value));
      sel.addEventListener('change', () => { sel.classList.toggle('invalid', !!sel.value && !has(sel.value)); dirty(); });
      return sel;
    };
    let levels = [...(cfg.levels || [])];
    const levelsBox = h('div', { class: 'stack' });
    const drawLevels = () => {
      levelsBox.replaceChildren(...[...levels.map((v, i) => {
        const sel = colSelect(v, '— escolha —');
        sel.addEventListener('change', () => { levels[i] = sel.value; });
        return h('div', { class: 'inline' }, h('span', { class: 'lbl', style: 'min-width:60px' }, `Nível ${i + 1}`), sel,
          h('button', { class: 'btn sm ghost', title: 'Remover nível', onclick: () => { levels.splice(i, 1); drawLevels(); dirty(); } }, '✕'));
      }), levels.length < 5 ? h('div', null, h('button', { class: 'btn sm', onclick: () => { levels.push(''); drawLevels(); dirty(); } }, '+ Adicionar nível')) : null,
      !levels.length ? h('div', { class: 'small muted' }, 'Sem níveis: todos os arquivos ficam direto na pasta de saída.') : null].filter(Boolean));
    };
    drawLevels();

    // Conteúdo das linhas: uma ou mais colunas, na ordem escolhida, juntadas pelo separador; NULL em branco ou como "NULL".
    const realName = (n) => cols.find((c) => c.toLowerCase() === String(n).toLowerCase()) ?? n;
    let content = (cfg.contentColumns?.length ? cfg.contentColumns : cfg.contentColumn ? [cfg.contentColumn] : []).map(realName);
    const contentBox = h('div', { class: 'stack' });
    const SEPS = [['', 'Nenhum (valores colados)'], [';', 'Ponto e vírgula ( ; )'], [',', 'Vírgula ( , )'], ['|', 'Barra vertical ( | )'], ['\t', 'Tabulação'], [' ', 'Espaço']];
    const sepSel = h('select', { 'aria-label': 'Separador', style: 'width:auto' }, SEPS.map(([v, l]) => h('option', { value: v }, l)), h('option', { value: '*' }, 'Personalizado…'));
    const sepInput = h('input', { type: 'text', maxlength: 10, placeholder: 'Ex.: ;; ou " - "', 'aria-label': 'Separador personalizado', style: 'width:140px;font-family:var(--mono)' });
    const initSep = typeof cfg.separator === 'string' ? cfg.separator : '';
    if (SEPS.some(([v]) => v === initSep)) sepSel.value = initSep; else { sepSel.value = '*'; sepInput.value = initSep; }
    const separator = () => (sepSel.value === '*' ? sepInput.value.replace(/[\r\n]/g, '') : sepSel.value);
    const sepHint = h('span', { class: 'small muted' }, 'Usado ao escolher duas ou mais colunas.');
    const sepBox = h('div', { class: 'inline' }, h('span', { class: 'lbl', style: 'min-width:90px' }, 'Separador'), sepSel, sepInput, sepHint);
    const nullSel = h('select', { 'aria-label': 'Valores NULL', style: 'width:auto' }, h('option', { value: 'blank' }, 'Deixar em branco'), h('option', { value: 'null' }, 'Manter como NULL'));
    nullSel.value = cfg.nullAs === 'null' ? 'null' : 'blank';
    const nullBox = h('div', { class: 'inline' }, h('span', { class: 'lbl', style: 'min-width:90px' }, 'Valores NULL'), nullSel);
    const sample = h('div', { class: 'small' });
    // separador e exemplo (1ª linha do resultado) são atualizados sem recriar os campos: o foco fica onde está
    const drawSample = () => {
      const multi = content.length > 1;
      sepSel.disabled = !multi; sepInput.disabled = !multi;
      sepInput.style.display = sepSel.value === '*' ? '' : 'none';
      sepHint.style.display = multi ? 'none' : '';
      const row = rs.rows[0];
      const idx = content.filter(has).map((c) => cols.findIndex((x) => x.toLowerCase() === c.toLowerCase()));
      const sep = multi ? separator() : '';
      // igual a fileText (servidor): com várias colunas e separador, valor só com espaços sai vazio
      const val = (v) => { if (v === null || v === undefined) return nullSel.value === 'null' ? 'NULL' : ''; const t = String(v); return multi && sep && !t.trim() ? '' : t; };
      sample.replaceChildren(...(row && idx.length ? [h('span', { class: 'muted' }, 'Exemplo (1ª linha): '),
        h('code', { class: 'mono', style: 'white-space:pre-wrap;word-break:break-all' }, idx.map((c) => val(row[c])).join(sep) || '(linha vazia)')] : []));
    };
    // Lista dupla (funciona com centenas de colunas): Disponíveis ↔ Ordem no arquivo. Seleção múltipla (Ctrl/Shift), busca nos
    // dois lados, duplo clique/Enter inclui, Delete tira, Alt+↑/↓ move; topo, fim, posição exata e “Colar ordem” (lista do layout).
    const lower = (c) => String(c).toLowerCase();
    const on = (c) => content.some((x) => lower(x) === lower(c));
    const named = cols.filter(Boolean);
    const listSel = (label) => h('select', { multiple: true, size: 14, 'aria-label': label, class: 'mono dual-select' });
    const availSel = listSel('Colunas disponíveis');
    const orderSel = listSel('Ordem das colunas em cada linha do arquivo');
    const availFilter = h('input', { type: 'search', placeholder: 'Buscar coluna…', 'aria-label': 'Buscar nas colunas disponíveis' });
    const orderFilter = h('input', { type: 'search', placeholder: 'Buscar na ordem…', 'aria-label': 'Buscar na ordem escolhida' });
    const availCount = h('span', { class: 'small muted' });
    const orderCount = h('span', { class: 'small muted' });
    const posInput = h('input', { type: 'number', min: 1, step: 1, placeholder: 'nº', 'aria-label': 'Posição de destino', style: 'width:70px' });
    const picked = (sel) => [...sel.selectedOptions].map((o) => o.value);
    const fill = (sel, items, keep, label) => {
      const top = sel.scrollTop;
      sel.replaceChildren(...items.map((it) => { const o = h('option', { value: it.value, title: it.value }, label(it)); o.selected = keep.has(lower(it.value)); return o; }));
      sel.scrollTop = top;
    };
    // redesenha só as opções (as listas e campos continuam os mesmos: foco, rolagem e seleção ficam)
    const drawContent = (keepOrder = new Set(picked(orderSel).map(lower)), keepAvail = new Set(picked(availSel).map(lower))) => {
      const fa = lower(availFilter.value.trim()); const fo = lower(orderFilter.value.trim());
      const avail = named.filter((c) => !on(c));
      fill(availSel, avail.filter((c) => !fa || lower(c).includes(fa)).map((c) => ({ value: c })), keepAvail, (it) => it.value);
      fill(orderSel, content.map((c, i) => ({ value: c, i })).filter((it) => !fo || lower(it.value).includes(fo)), keepOrder,
        (it) => `${String(it.i + 1).padStart(String(content.length).length, ' ')}. ${it.value}${has(it.value) ? '' : '  (não existe no resultado)'}`);
      availCount.textContent = `${avail.length} disponíve${avail.length === 1 ? 'l' : 'is'}${fa ? ` · ${availSel.options.length} na busca` : ''}`;
      orderCount.textContent = `${content.length} de ${named.length} no arquivo${fo ? ` · ${orderSel.options.length} na busca` : ''}`;
      posInput.max = String(Math.max(1, content.length));
      drawSample();
    };
    const change = (keepOrder, keepAvail) => { drawContent(keepOrder, keepAvail); dirty(); };
    const add = (list, select = true) => { const n = list.filter((c) => !on(c)); if (!n.length) return; content = [...content, ...n]; change(new Set(select ? n.map(lower) : []), new Set()); };
    const remove = (list) => { if (!list.length) return; const k = new Set(list.map(lower)); content = content.filter((c) => !k.has(lower(c))); change(new Set(), k); };
    // move o bloco selecionado (mantém a ordem relativa entre os selecionados)
    const moveTo = (pos) => {
      const k = new Set(picked(orderSel).map(lower));
      if (!k.size) return toast('Selecione na lista “Ordem” as colunas a mover.', 'error');
      const sel = content.filter((c) => k.has(lower(c)));
      const rest = content.filter((c) => !k.has(lower(c)));
      const at = Math.max(0, Math.min(rest.length, pos));
      content = [...rest.slice(0, at), ...sel, ...rest.slice(at)];
      change(k);
      orderSel.querySelector('option:checked')?.scrollIntoView({ block: 'nearest' });
    };
    const step = (d) => {
      const k = new Set(picked(orderSel).map(lower));
      if (!k.size) return;
      const idx = content.map((c, i) => (k.has(lower(c)) ? i : -1)).filter((i) => i >= 0);
      if (d < 0 ? idx[0] === 0 : idx[idx.length - 1] === content.length - 1) return;
      for (const i of d < 0 ? idx : [...idx].reverse()) [content[i], content[i + d]] = [content[i + d], content[i]];
      change(k);
      orderSel.querySelector('option:checked')?.scrollIntoView({ block: 'nearest' });
    };
    const pasteOrder = () => {
      const ta = h('textarea', { rows: 10, class: 'mono', style: 'width:100%', placeholder: 'CODIGO; NOME; CPF…\nou uma coluna por linha (como no layout)' });
      const msg = h('div', { class: 'small' });
      const apply = () => {
        const names = ta.value.split(/[\r\n\t;,]+/).map((x) => x.trim().replace(/^\[|\]$/g, '')).filter(Boolean);
        const found = []; const missing = [];
        for (const n of names) { const c = named.find((x) => lower(x) === lower(n)); if (!c) missing.push(n); else if (!found.some((x) => lower(x) === lower(c))) found.push(c); }
        if (!found.length) { msg.replaceChildren(h('div', { class: 'box bad small' }, 'Nenhum dos nomes colados existe no resultado.')); return; }
        content = found; orderFilter.value = ''; change(new Set());
        m.close();
        toast(missing.length ? `${plural(found.length, 'coluna aplicada', 'colunas aplicadas')}; não existem no resultado: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? '…' : ''}` : `${plural(found.length, 'coluna aplicada', 'colunas aplicadas')} na ordem colada.`, missing.length ? 'error' : 'ok');
      };
      const m = openModal({ title: 'Colar ordem do layout', size: 'sm',
        body: [h('p', { class: 'small muted', style: 'margin:0 0 8px' }, 'Cole os nomes das colunas na ordem do layout, separados por vírgula, ponto e vírgula, tabulação ou um por linha. A ordem atual é substituída; nomes que não existem no resultado são ignorados e avisados.'), ta, msg],
        footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'), h('button', { class: 'btn primary', onclick: apply }, 'Aplicar ordem')] });
      ta.focus();
    };
    availFilter.addEventListener('input', () => drawContent());
    orderFilter.addEventListener('input', () => drawContent());
    availSel.addEventListener('dblclick', () => add(picked(availSel)));
    orderSel.addEventListener('dblclick', () => remove(picked(orderSel)));
    availSel.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(picked(availSel)); } });
    orderSel.addEventListener('keydown', (e) => {
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); remove(picked(orderSel)); }
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); step(e.key === 'ArrowUp' ? -1 : 1); }
    });
    const btn = (label, title, onclick) => h('button', { class: 'btn sm', title, 'aria-label': title, onclick }, label);
    contentBox.replaceChildren(
      h('div', { class: 'dual-list' },
        h('div', { class: 'stack', style: 'gap:4px;min-width:0' }, h('div', { class: 'stack', style: 'gap:0' }, h('span', { class: 'lbl' }, 'Disponíveis'), availCount), availFilter, availSel),
        h('div', { class: 'dual-actions' },
          btn('Incluir →', 'Incluir as selecionadas no fim da ordem (Enter ou duplo clique)', () => add(picked(availSel))),
          btn('← Tirar', 'Tirar as selecionadas da ordem (Delete ou duplo clique)', () => remove(picked(orderSel))),
          btn('Todas »', 'Incluir todas as colunas (as que faltam vão para o fim, na ordem do resultado)', () => add(named, false)),
          btn('« Limpar', 'Tirar todas as colunas da ordem', () => remove([...content]))),
        h('div', { class: 'stack', style: 'gap:4px;min-width:0' }, h('div', { class: 'stack', style: 'gap:0' }, h('span', { class: 'lbl' }, 'Ordem em cada linha do arquivo'), orderCount), orderFilter, orderSel,
          h('div', { class: 'inline', style: 'gap:4px' },
            btn('⤒', 'Mover as selecionadas para o topo', () => moveTo(0)),
            btn('↑', 'Mover as selecionadas uma posição para cima (Alt+↑)', () => step(-1)),
            btn('↓', 'Mover as selecionadas uma posição para baixo (Alt+↓)', () => step(1)),
            btn('⤓', 'Mover as selecionadas para o fim', () => moveTo(content.length)),
            h('span', { class: 'small muted' }, 'Posição'), posInput,
            btn('Mover', 'Mover as selecionadas para a posição informada', () => { const n = Math.round(Number(posInput.value)); if (!(n >= 1)) return toast('Informe a posição (1, 2, 3…).', 'error'); moveTo(n - 1); })))),
      h('div', { class: 'inline small' }, h('button', { class: 'btn sm ghost', onclick: pasteOrder }, 'Colar ordem do layout…'),
        h('span', { class: 'muted' }, 'Ctrl/Shift + clique seleciona várias · duplo clique inclui/tira · Alt+↑/↓ move')));
    sepSel.addEventListener('change', () => { drawSample(); dirty(); if (sepSel.value === '*') sepInput.focus(); });
    sepInput.addEventListener('input', () => { drawSample(); dirty(); });
    nullSel.addEventListener('change', () => { drawSample(); dirty(); });
    drawContent();
    const nameInput = h('input', { type: 'text', maxlength: 200, value: cfg.fileName || '', placeholder: 'Ex.: {TABELA}-{COLIGADA}.txt', style: 'font-family:var(--mono)' });
    nameInput.addEventListener('input', dirty);
    const insertCol = (c) => {
      const a = nameInput.selectionStart ?? nameInput.value.length; const b = nameInput.selectionEnd ?? a;
      nameInput.value = `${nameInput.value.slice(0, a)}{${c}}${nameInput.value.slice(b)}`; nameInput.focus(); dirty();
    };
    const encSel = h('select', null, h('option', { value: 'utf8' }, 'UTF-8'), h('option', { value: 'ansi' }, 'ANSI (Windows-1252)'));
    encSel.value = cfg.encoding === 'ansi' ? 'ansi' : 'utf8';
    encSel.addEventListener('change', dirty);
    const dir = pathField({ value: lastDir('script-export'), kind: 'folder', title: 'Pasta de saída dos arquivos', placeholder: 'C:\\Migracao\\Importacao' });
    dir.input.addEventListener('input', dirty);
    xpDir = dir;
    const config = () => ({ levels: levels.filter(Boolean), contentColumn: content[0] || '', contentColumns: content, separator: separator(), nullAs: nullSel.value, fileName: nameInput.value.trim(), encoding: encSel.value });

    const saveBtn = h('button', { class: 'btn', onclick: (e) => busy(e.target, async () => {
      const r = await api('PUT', `/api/scripts/${scriptSel.value}/export-config`, { config: config() });
      const s = script(); if (s) s.exportConfig = r.exportConfig;
      toast('Configuração salva no script.');
    }) }, 'Salvar configuração no script');
    const previewBtn = h('button', { class: 'btn primary', onclick: (e) => busy(e.target, preview, 'Montando prévia…') }, 'Pré-visualizar');

    async function preview() {
      previewBox.replaceChildren();
      if (dir.get()) lastDir('script-export', dir.get());
      const p = await api('POST', '/api/script-export/preview', { resultId: result.resultId, set: setIdx, config: config(), outDir: dir.get() });
      previewOk = true;
      showPreview(p, config(), dir.get());
    }
    configBox.replaceChildren(card('Organização dos arquivos', null,
      field('Pastas (níveis de agrupamento)', levelsBox, 'Cada nível vira uma subpasta com o valor da coluna, na ordem.'),
      field('Conteúdo das linhas', h('div', { class: 'stack' }, contentBox, sepBox, nullBox, sample),
        'Cada linha do resultado vira uma linha do arquivo, na ordem do resultado: os valores das colunas escolhidas, na ordem acima, juntados pelo separador, sem outra alteração. NULL: em branco ou o texto “NULL”.'),
      field('Nome do arquivo', h('div', { class: 'stack' }, nameInput,
        h('div', { class: 'inline small' }, h('span', { class: 'muted' }, 'Inserir coluna:'), cols.filter(Boolean).map((c) => h('button', { class: 'btn sm ghost mono', onclick: () => insertCol(c) }, `{${c}}`)))),
      'Texto fixo + {COLUNA}. Linhas com os mesmos valores de pasta e nome vão para o mesmo arquivo. Caracteres inválidos no Windows (\\ / : * ? " < > |) viram “_”; valor vazio vira “_”.'),
      field('Codificação', encSel, 'UTF-8 sem BOM ou ANSI (Windows-1252). Quebra de linha CRLF.'),
      field('Pasta de saída', dir.el),
      h('div', { class: 'inline' }, previewBtn, saveBtn)));
    function dirty() { if (previewOk) { previewOk = false; previewBox.replaceChildren(h('div', { class: 'small muted' }, 'A configuração mudou: clique em “Pré-visualizar” de novo.')); } }
  }

  // ---------- Prévia e geração ----------
  function showPreview(p, cfg, outDir) {
    // árvore: pastas (com “\”) e arquivos com nº de linhas; marca o que já existe
    const lines = [h('div', { class: 'mono', style: 'font-weight:700' }, p.outDir)];
    const seen = new Set();
    for (const f of p.files) {
      f.dirs.forEach((d, i) => {
        const key = f.dirs.slice(0, i + 1).join('\\').toLowerCase();
        if (seen.has(key)) return; seen.add(key);
        lines.push(h('div', { class: 'mono', style: `padding-left:${(i + 1) * 18}px` }, `${d}\\`));
      });
      lines.push(h('div', { class: 'mono', style: `padding-left:${(f.dirs.length + 1) * 18}px` }, f.name, h('span', { class: 'muted' }, ` · ${plural(f.lines, 'linha', 'linhas')}`),
        f.exists ? [' ', h('span', { class: 'pill soon' }, 'já existe')] : null));
    }
    if (p.totalFiles > p.files.length) lines.push(h('div', { class: 'small muted' }, `… e mais ${(p.totalFiles - p.files.length).toLocaleString('pt-BR')} arquivo(s).`));
    const genBtn = h('button', { class: 'btn primary', onclick: (e) => busy(e.target, () => generate({}), 'Gerando…') }, 'Gerar arquivos');
    previewBox.replaceChildren(card('Prévia — nada foi gravado ainda', null,
      h('div', { class: 'hr-stats' }, stat('Arquivos', p.totalFiles), stat('Pastas', p.folders, p.newFolders ? `${p.newFolders} nova(s)` : null), stat('Linhas', p.lines), stat('Codificação', p.encoding)),
      ...p.warnings.map((w) => h('div', { class: 'box warn small' }, w)),
      p.duplicateCount ? h('div', { class: 'box warn small' }, h('strong', null, 'Nomes repetidos: '), p.duplicates.slice(0, 10).map((d) => `${d.rel} (${d.groups} grupos)`).join(', '), p.duplicateCount > 10 ? '…' : '') : null,
      p.existingCount ? h('div', { class: 'box warn small' }, h('strong', null, `${plural(p.existingCount, 'arquivo já existe', 'arquivos já existem')} na pasta de saída. `), 'Ao gerar, você escolhe substituir (o antigo vai para a Lixeira) ou gerar novo nome.') : null,
      p.unmappable ? h('div', { class: 'box warn small' }, `${plural(p.unmappable, 'caractere não existe', 'caracteres não existem')} em ANSI e ${p.unmappable === 1 ? 'será gravado' : 'serão gravados'} como “?”. Use UTF-8 para manter o texto exato.`) : null,
      h('div', { class: 'run-grid', style: 'padding:8px 10px' }, lines),
      h('div', { class: 'inline' }, genBtn)));

    async function generate(opts) {
      if (xpDir && xpDir.get() !== outDir) { previewBox.replaceChildren(h('div', { class: 'small muted' }, 'A pasta de saída mudou: clique em “Pré-visualizar” de novo.')); previewOk = false; return; }
      if (!opts.confirmed) {
        const ok = await confirmDialog({ title: 'Gerar arquivos', message: `Gravar ${plural(p.totalFiles, 'arquivo', 'arquivos')} (${plural(p.lines, 'linha', 'linhas')}) em:\n${outDir}`, okText: 'Gerar' });
        if (!ok) return;
        opts = { ...opts, confirmed: true };
      }
      let r;
      try {
        r = await api('POST', '/api/script-export/generate', { resultId: result.resultId, set: setIdx, config: cfg, outDir, duplicates: opts.duplicates, onExisting: opts.onExisting });
      } catch (e) {
        const list = (e.details?.conflicts || []).slice(0, 8).map((c) => `• ${c.rel || c}`).join('\n');
        if (e.code === 'EXPORT_DUPLICATES') {
          const k = await choiceDialog({ title: 'Nomes repetidos', message: `${e.message}\n\n${list}`, choices: [{ key: 'cancel', label: 'Cancelar' }, { key: 'rename', label: 'Gerar nomes diferentes' }, { key: 'merge', label: 'Juntar no mesmo arquivo', kind: 'primary' }] });
          return k === 'cancel' ? toast('Geração cancelada.') : generate({ ...opts, duplicates: k });
        }
        if (e.code === 'EXPORT_EXISTS') {
          const k = await choiceDialog({ title: 'Arquivos já existem', message: `${e.message}\n\n${list}`, choices: [{ key: 'cancel', label: 'Cancelar' }, { key: 'rename', label: 'Gerar novo nome' }, { key: 'replace', label: 'Substituir', kind: 'danger' }] });
          return k === 'cancel' ? toast('Geração cancelada.') : generate({ ...opts, onExisting: k });
        }
        throw e;
      }
      previewOk = false;
      previewBox.replaceChildren(card('Arquivos gerados', null,
        h('div', { class: 'hr-stats' }, stat('Arquivos criados', r.filesCreated), stat('Pastas criadas', r.foldersCreated), stat('Linhas exportadas', r.lines), stat('Erros', r.errors.length)),
        r.replaced ? h('div', { class: 'small muted' }, `${plural(r.replaced, 'arquivo substituído', 'arquivos substituídos')} (o anterior foi para a Lixeira).`) : null,
        r.renamed ? h('div', { class: 'small muted' }, `${plural(r.renamed, 'arquivo recebeu', 'arquivos receberam')} um nome novo, ex.: “nome (2).txt”.`) : null,
        r.unmappable ? h('div', { class: 'small muted' }, `${plural(r.unmappable, 'caractere gravado', 'caracteres gravados')} como “?” (ANSI).`) : null,
        r.errors.length ? h('div', { class: 'box bad small' }, h('strong', null, 'Não foi possível gravar:'), h('ul', null, r.errors.slice(0, 20).map((x) => h('li', null, h('span', { class: 'mono' }, x.file), ` — ${x.error}`)))) : null,
        h('div', { class: 'inline' }, h('button', { class: 'btn primary', onclick: () => api('POST', '/api/script-export/open-folder', { path: r.outDir }).catch(fail) }, 'Abrir pasta'))));
      toast(r.errors.length ? `Geração concluída com ${plural(r.errors.length, 'erro', 'erros')}.` : `${plural(r.filesCreated, 'arquivo gerado', 'arquivos gerados')}.`, r.errors.length ? 'error' : 'ok');
    }
  }
  const stat = (label, value, sub) => h('div', { class: 'hr-stat' }, h('span', { class: 'lbl' }, label), h('strong', null, typeof value === 'number' ? value.toLocaleString('pt-BR') : value), sub ? h('span', { class: 'small muted' }, sub) : null);

  await loadVars();
  main.replaceChildren(h('div', { class: 'page' }, head,
    card('Executar', null,
      h('div', { class: 'run-bar' }, h('label', { class: 'inline', style: 'gap:6px' }, h('span', { class: 'lbl' }, 'Script'), scriptSel)),
      h('div', { class: 'run-bar' }, h('label', { class: 'inline', style: 'gap:6px' }, h('span', { class: 'lbl' }, 'Conexão'), connSel), dbInput, runBtn, stopBtn), targetInfo, varsBox, status, resultBox),
    configBox, previewBox));
}
