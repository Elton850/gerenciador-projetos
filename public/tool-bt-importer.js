// Ferramentas Auxiliares › Importador BT → SQL (tela). Regras e execução ficam no servidor (src/tools/bt-importer).
// Fluxo numa tela só: Origem → Conexão → Arquivos e bancos de destino (renomear em lote) → Validar → Importar (progresso,
// cancelar) → Resumo. Abas: Importar · Histórico · Configurações.
// Regra do app de referência: o destino de cada ARQUIVO é um BANCO; os blocos [TABELA] do arquivo viram tabelas dbo.<bloco>;
// arquivos com o mesmo banco alimentam as mesmas tabelas (append).
(() => {
  const BASE = '/api/tools/bt-importer';
  const BT = { tab: 'import', files: [], dir: null, recursive: false, connectionId: null, options: null, settings: null, plan: null, job: null, timer: null, validating: null };
  const N = (n) => Number(n || 0).toLocaleString('pt-BR');
  const dbKey = (s) => String(s || '').trim().toLowerCase();
  const fileBase = (name) => { const dot = name.lastIndexOf('.'); return (dot > 0 ? name.slice(0, dot) : name).toUpperCase().replace(/[^A-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'BT'; };
  const applyPattern = (p, name) => (p.includes('[ARQUIVO]') ? p.split('[ARQUIVO]').join(fileBase(name)) : p);
  const fmtMs = (ms) => (ms < 1000 ? `${ms} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`);
  const invalidate = () => { BT.plan = null; };
  const selected = () => BT.files.filter((f) => f.include);

  async function render(main, tool) {
    clearInterval(BT.timer);
    main.replaceChildren(h('div', { class: 'page' }, h('div', { class: 'empty' }, 'Carregando…')));
    try {
      const [s, conns] = await Promise.all([api('GET', `${BASE}/settings`), api('GET', '/api/connections')]);
      BT.settings = s.settings; BT.defaults = s.defaults; BT.conns = conns;
      if (!BT.options) BT.options = { onlyAllowed: s.settings.onlyAllowed, addMissingColumns: s.settings.addMissingColumns, batchSize: s.settings.batchSize, stopOnError: s.settings.stopOnError };
      if (!BT.connectionId || !conns.some((c) => c.id === BT.connectionId)) BT.connectionId = (conns.find((c) => c.env === 'local') || conns[0] || {}).id || null;
      if (BT.dir === null) BT.recursive = s.settings.recursive;
    } catch (e) { return fail(e); }
    if (route().name !== 'tools') return;
    const body = h('div', { class: 'bt-flow' });
    const tabs = [['import', 'Importar'], ['history', 'Histórico'], ['settings', 'Configurações']];
    main.replaceChildren(h('div', { class: 'page bt-page' },
      h('div', { class: 'page-head' }, h('div', { class: 'grow' },
        h('a', { class: 'link-quiet small', href: '#/tools' }, '← Ferramentas Auxiliares'),
        h('h1', null, tool.name),
        h('div', { class: 'muted' }, 'Importa arquivos .bt para o SQL Server pelas conexões cadastradas. Cada arquivo vai para um banco; os blocos [TABELA] do arquivo viram tabelas; arquivos com o mesmo banco são somados nas mesmas tabelas.'))),
      h('nav', { class: 'tabs', role: 'tablist' }, tabs.map(([k, l]) => h('button', { class: `tab${BT.tab === k ? ' active' : ''}`, onclick: () => { BT.tab = k; render(main, tool); } }, l))),
      body));
    if (BT.tab === 'history') return renderHistory(body);
    if (BT.tab === 'settings') return renderSettings(body, () => render(main, tool));
    renderImport(body);
  }

  // ---------- Importar ----------
  // Peças visuais pequenas (classes em styles.css, bloco "Importador BT").
  const tag = (kind, text, title) => h('span', { class: `bt-tag ${kind}`, title: title || null }, text);
  const msgs = (kind, list) => (list && list.length ? h('ul', { class: `bt-msgs ${kind}` }, list.map((m) => h('li', null, m))) : null);
  const stat = (label, value, kind = '') => h('div', { class: `bt-stat ${kind}` }, h('span', { class: 'bt-stat-value' }, value), h('span', { class: 'bt-stat-label' }, label));
  const bar = (pct) => h('div', { class: 'progress' }, h('div', { style: `width:${Math.max(0, Math.min(100, pct))}%` }));

  function renderImport(host) {
    // Seção numerada: cabeçalho (número, título, ações à direita) + corpo.
    const sec = (n, title, { actions = null, sub = null } = {}, ...content) => h('section', { class: 'card bt-section' },
      h('div', { class: 'bt-section-head' }, h('span', { class: 'bt-step' }, String(n)),
        h('div', { class: 'bt-section-title' }, h('h2', null, title), sub ? h('span', { class: 'bt-sub' }, sub) : null), actions ? h('div', { class: 'bt-section-actions' }, actions) : null),
      h('div', { class: 'bt-section-body' }, ...content));
    const filesHost = h('div', { class: 'bt-files-host' }); const groupsHost = h('div', { class: 'bt-groups-host' }); const actionsHost = h('div', { class: 'bt-section-body' }); const resultHost = h('div');
    const originHint = h('p', { class: 'bt-note' });
    const drawOrigin = () => { originHint.textContent = BT.dir ? `Pasta: ${BT.dir}${BT.recursive ? ' (com subpastas)' : ''} · ${plural(BT.files.length, 'arquivo .bt', 'arquivos .bt')}` : BT.files.length ? plural(BT.files.length, 'arquivo selecionado', 'arquivos selecionados') : 'Escolha um arquivo, vários arquivos (Ctrl/Shift no seletor) ou uma pasta inteira. Só arquivos .bt são considerados.'; };
    const redraw = () => { drawOrigin(); drawFiles(); drawGroups(); drawActions(); };

    // 1) Origem
    const recursive = h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: BT.recursive, onchange: (e) => { BT.recursive = e.target.checked; if (BT.dir) loadList({ dir: BT.dir }); } }), ' Incluir subpastas');
    // Caminho digitado/colado (como o campo "Pasta" + "Ler .bt" do app original): pasta ou um arquivo .bt.
    const typed = h('input', { type: 'text', placeholder: 'C:\\pasta\\com\\arquivos  ou  C:\\pasta\\arquivo.bt', value: BT.dir || '', 'aria-label': 'Pasta ou arquivo .bt', spellcheck: 'false',
      onkeydown: (e) => { if (e.key === 'Enter') readTyped(); } });
    const readTyped = () => { const v = typed.value.trim().replace(/^"|"$/g, ''); if (!v) return toast('Informe uma pasta ou um arquivo .bt.', 'error'); return loadList(/\.bt$/i.test(v) ? { paths: [v] } : { dir: v }); };
    const clearBtn = h('button', { class: 'btn ghost sm', onclick: () => { BT.files = []; BT.dir = null; typed.value = ''; invalidate(); redraw(); } }, 'Limpar lista');
    const origin = sec(1, 'Origem', { actions: clearBtn },
      h('div', { class: 'bt-origin' },
        h('div', { class: 'bt-origin-pick' },
          h('button', { class: 'btn', onclick: (e) => busy(e.currentTarget, () => pick('files')) }, 'Arquivo(s) .bt…'),
          h('button', { class: 'btn', onclick: (e) => busy(e.currentTarget, () => pick('folder')) }, 'Pasta…'),
          recursive),
        h('div', { class: 'bt-origin-path' }, typed, h('button', { class: 'btn', onclick: (e) => busy(e.currentTarget, readTyped) }, 'Ler .bt'))),
      originHint);

    async function pick(mode) {
      const r = await api('POST', `${BASE}/pick`, { mode });
      if (r.canceled) return;
      await loadList(mode === 'folder' ? { dir: r.dir } : { paths: r.paths });
    }
    async function loadList({ dir, paths }) {
      try {
        const r = await api('POST', `${BASE}/list`, dir ? { dir, recursive: BT.recursive } : { paths });
        BT.dir = dir || null;
        BT.files = r.files.map((f) => ({ ...f, include: true, custom: false }));
        invalidate(); redraw();
        if (!BT.files.length) toast('Nenhum arquivo .bt encontrado na pasta informada.', 'info');
      } catch (e) { fail(e); }
    }

    // 2) Conexão
    const connSel = h('select', { 'aria-label': 'Conexão', onchange: (e) => { BT.connectionId = e.target.value; invalidate(); drawActions(); } },
      BT.conns.length ? BT.conns.map((c) => h('option', { value: c.id }, `${c.name} — ${c.envLabel} · ${c.server}${c.port ? ',' + c.port : ''} · ${c.auth === 'sql' ? `login ${c.user}` : 'Windows'}`))
        : h('option', { value: '' }, 'Nenhuma conexão cadastrada'));
    if (BT.connectionId) connSel.value = BT.connectionId;
    const conn = sec(2, 'Conexão', { sub: 'Configurações → Conexões · a senha nunca aparece aqui' },
      h('div', { class: 'bt-conn' }, connSel, !BT.conns.length ? h('a', { class: 'btn', href: '#/settings' }, 'Cadastrar conexão') : null),
      h('p', { class: 'bt-note' }, 'O banco padrão da conexão é ignorado: cada arquivo vai para o banco de destino da lista abaixo (criado se não existir).'));

    // 3) Arquivos e bancos de destino
    function groupsOf(list) {
      const m = new Map();
      for (const f of list) { const k = dbKey(f.database); if (!k) continue; if (!m.has(k)) m.set(k, { database: f.database.trim(), files: [] }); m.get(k).files.push(f); }
      return m;
    }
    function statusOf(f, it) {
      if (!f.include) return tag('none', 'Não importar');
      if (!f.database.trim()) return tag('bad', 'Sem destino');
      if (!it) return tag('none', BT.plan ? '—' : 'A validar');
      if (it.status === 'blocked') return tag('bad', 'Problema', it.reasons.join('\n'));
      if (it.status === 'empty') return tag('warn', 'Sem dados', it.warnings.join('\n'));
      return tag(it.warnings.length ? 'warn' : 'ok', 'Pronto', it.warnings.join('\n'));
    }
    // Tabelas do arquivo: resumo numa linha + lista completa recolhível (importadas em destaque, ignoradas à parte).
    function fileTables(it) {
      if (!it || !it.tables.length) return null;
      const inc = it.tables.filter((t) => t.included); const skip = it.tables.filter((t) => !t.included);
      const reasons = [...new Set(skip.map((t) => t.skipReason))];
      return h('details', { class: 'bt-details' },
        h('summary', null, `${plural(inc.length, 'tabela importada', 'tabelas importadas')}${skip.length ? ` · ${plural(skip.length, 'ignorada', 'ignoradas')}` : ''}`),
        inc.length ? h('div', { class: 'bt-chips' }, inc.map((t) => h('span', { class: 'bt-chip' }, h('span', { class: 'mono' }, t.name), h('span', { class: 'bt-chip-n' }, N(t.rows))))) : null,
        skip.length ? h('div', { class: 'bt-skipped' }, h('span', { class: 'bt-label' }, `Ignoradas — ${reasons.join(', ')}`), h('div', { class: 'bt-chips muted' }, skip.map((t) => h('span', { class: 'bt-chip', title: t.skipReason }, h('span', { class: 'mono' }, t.name))))) : null);
    }
    function drawFiles() {
      clearBtn.hidden = !BT.files.length;
      if (!BT.files.length) { filesHost.replaceChildren(h('div', { class: 'bt-empty' }, 'Nenhum arquivo selecionado. Escolha a origem no passo 1.')); return; }
      const groups = groupsOf(selected());
      const all = h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: BT.files.every((f) => f.include), onchange: (e) => { for (const f of BT.files) f.include = e.target.checked; invalidate(); redraw(); } }), ` Todos (${selected().length} de ${BT.files.length})`);
      const rows = BT.files.map((f) => {
        const g = groups.get(dbKey(f.database));
        const it = BT.plan?.items.find((x) => x.path === f.path);
        const input = h('input', { type: 'text', value: f.database, 'aria-label': `Banco de destino de ${f.name}`, disabled: !f.include, spellcheck: 'false',
          oninput: (e) => { f.database = e.target.value; f.custom = true; invalidate(); drawGroups(); drawActions(); }, onchange: () => drawFiles() });
        const meta = [fmtSize(f.size), it && it.status !== 'blocked' ? `${N(it.rows)} linha(s)` : null, f.rel && f.rel !== f.name ? f.rel : null].filter(Boolean).join(' · ');
        return h('div', { class: `bt-file${f.include ? '' : ' off'}${it?.status === 'blocked' ? ' bad' : ''}` },
          h('input', { type: 'checkbox', class: 'bt-file-check', checked: f.include, 'aria-label': `Importar ${f.name}`, onchange: (e) => { f.include = e.target.checked; invalidate(); redraw(); } }),
          h('div', { class: 'bt-file-main' },
            h('div', { class: 'bt-file-top' }, h('span', { class: 'bt-file-name', title: f.path }, f.name), statusOf(f, it)),
            h('div', { class: 'bt-meta' }, meta),
            it && it.status !== 'ok' ? msgs('bad', it.reasons) : null,
            it ? msgs('warn', it.warnings) : null,
            fileTables(it)),
          h('div', { class: 'bt-file-dest' },
            h('span', { class: 'bt-label' }, 'Banco de destino'), input,
            f.include && g && g.files.length > 1 ? tag('info', `agrupado com ${g.files.length - 1} arquivo(s)`, `${g.files.length} arquivos vão para ${g.database}: as tabelas de mesmo nome são somadas`) : null));
      });
      filesHost.replaceChildren(h('div', { class: 'bt-list-head' }, all), h('div', { class: `bt-filelist${BT.files.length > 12 ? ' scroll' : ''}` }, rows));
    }
    // Resumo por banco de destino: o que cada banco recebe (tabelas, linhas, criar × acrescentar), já com o resultado da validação.
    function drawGroups() {
      const groups = [...groupsOf(selected()).values()];
      if (!groups.length) { groupsHost.replaceChildren(); return; }
      const planGroups = new Map((BT.plan?.groups || []).map((g) => [dbKey(g.database), g]));
      groupsHost.replaceChildren(h('div', { class: 'bt-subhead' }, h('h3', null, 'Bancos de destino'), h('span', { class: 'bt-sub' }, BT.plan ? 'conforme a validação' : 'valide para ver as tabelas de cada banco')),
        h('div', { class: 'bt-dbs' }, groups.map((g) => {
          const pg = planGroups.get(dbKey(g.database));
          const tables = pg ? pg.tables : [];
          const rows = tables.reduce((n, t) => n + t.rows, 0);
          const bad = pg && (pg.issues.length || tables.some((t) => t.issues.length));
          const created = tables.filter((t) => t.create && !t.existed).length;
          return h('div', { class: `bt-db${bad ? ' bad' : ''}` },
            h('div', { class: 'bt-db-head' },
              h('span', { class: 'bt-db-name mono' }, g.database),
              pg ? tag(pg.createDatabase ? 'info' : 'warn', pg.createDatabase ? 'banco novo' : 'banco existente') : null,
              h('span', { class: 'bt-meta' }, [plural(g.files.length, 'arquivo', 'arquivos'), pg ? plural(tables.length, 'tabela', 'tabelas') : null, pg ? `${N(rows)} linha(s)` : null, pg && tables.length ? `${created} a criar · ${tables.length - created} a acrescentar` : null].filter(Boolean).join(' · '))),
            pg?.issues.length ? msgs('bad', pg.issues) : null,
            tables.length ? h('div', { class: 'bt-tables' }, tables.map((t) => h('div', { class: `bt-tbl${t.issues.length ? ' bad' : ''}`, title: [t.issues.join('\n'), t.warnings.join('\n'), t.addColumns.length ? `Colunas novas: ${t.addColumns.join(', ')}` : ''].filter(Boolean).join('\n') || null },
              h('span', { class: 'bt-tbl-name mono' }, t.name),
              h('span', { class: 'bt-tbl-n' }, N(t.rows)),
              t.create && !t.existed ? tag('ok sm', 'criar') : tag('warn sm', 'acrescentar'),
              t.addColumns.length ? tag('warn sm', `+${t.addColumns.length} col.`) : null,
              t.files.length > 1 ? tag('info sm', `${t.files.length} arq.`) : null))) : null,
            ...tables.filter((t) => t.issues.length || t.warnings.length).map((t) => msgs(t.issues.length ? 'bad' : 'warn', [...t.issues, ...t.warnings].map((m) => `${t.name}: ${m}`))));
        })));
    }

    function batchRename() {
      const targets = selected();
      if (!targets.length) return toast('Marque os arquivos que serão renomeados.', 'info');
      const input = h('input', { type: 'text', value: BT.settings.namePattern || 'MIGRA_[ARQUIVO]', spellcheck: 'false' });
      const preview = h('div');
      const draw = () => {
        const p = input.value.trim();
        preview.replaceChildren(h('div', { class: 'tablewrap', style: 'max-height:40vh' }, h('table', { class: 'compact' },
          h('thead', null, h('tr', null, h('th', null, 'Arquivo'), h('th', null, 'Banco atual'), h('th', null, 'Novo banco'))),
          h('tbody', null, targets.map((f) => h('tr', null, h('td', null, f.name), h('td', { class: 'mono muted' }, f.database || '—'), h('td', { class: 'mono' }, p ? applyPattern(p, f.name) : '—')))))));
      };
      input.addEventListener('input', draw); draw();
      const m = openModal({
        title: `Renomear em lote — ${plural(targets.length, 'arquivo', 'arquivos')}`,
        body: [field('Padrão do banco de destino', input, 'Use [ARQUIVO] onde entra o nome do arquivo (sem .bt). Sem [ARQUIVO], todos vão para o MESMO banco. Ex.: MIGRA_[ARQUIVO] · ZMIGRA_TESTE_[ARQUIVO]_PRD2 · historico'),
          h('div', { class: 'inline' }, h('span', { class: 'bt-label' }, 'Atalhos'), ['MIGRA_[ARQUIVO]', '[ARQUIVO]', 'historico'].map((p) => h('button', { class: 'btn sm ghost mono', onclick: () => { input.value = p; draw(); } }, p))), preview],
        footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'), h('button', { class: 'btn primary', onclick: () => {
          const p = input.value.trim();
          if (!p) return toast('Informe um nome ou padrão para o banco de destino.', 'error');
          for (const f of targets) { f.database = applyPattern(p, f.name); f.custom = true; }
          invalidate(); m.close(); redraw();
        } }, 'Aplicar')],
      });
    }
    const files = sec(3, 'Arquivos e bancos de destino', {
      actions: [h('button', { class: 'btn sm', onclick: batchRename }, 'Renomear em lote'),
        h('button', { class: 'btn sm ghost', title: 'Volta ao nome padrão do app original: MIGRA_<ARQUIVO>', onclick: () => { for (const f of selected()) { f.database = `MIGRA_${fileBase(f.name)}`.slice(0, 128); f.custom = false; } invalidate(); redraw(); } }, 'Nome padrão'),
        h('button', { class: 'btn sm ghost', onclick: () => { for (const f of selected()) f.database = ''; invalidate(); redraw(); } }, 'Limpar destinos')],
    }, filesHost, groupsHost);

    // 4) Opções desta importação
    const o = BT.options;
    const opt = (k, label, desc) => h('label', { class: 'bt-option' }, h('input', { type: 'checkbox', checked: !!o[k], onchange: (e) => { o[k] = e.target.checked; invalidate(); redraw(); } }),
      h('span', { class: 'bt-option-text' }, h('strong', null, label), h('span', null, desc)));
    const batch = h('input', { type: 'number', min: 100, max: 50000, step: 500, value: o.batchSize, 'aria-label': 'Linhas por lote', onchange: (e) => { o.batchSize = Number(e.target.value); invalidate(); drawActions(); } });
    const options = sec(4, 'Opções desta importação', { sub: 'os padrões ficam em Configurações' },
      h('div', { class: 'bt-options' },
        opt('onlyAllowed', `Somente tabelas da lista (${BT.settings.allowedTables.length})`, 'Só os blocos cujo nome está na lista de Configurações, como no app original.'),
        opt('addMissingColumns', 'Adicionar colunas que faltam', 'Tabela existente ganha a coluna como NVARCHAR(MAX) NULL. Desligado: estrutura diferente bloqueia o destino.'),
        opt('stopOnError', 'Parar no primeiro arquivo com erro', 'O app original continua nos próximos arquivos.'),
        h('div', { class: 'bt-option bt-option-field' }, h('span', { class: 'bt-option-text' }, h('strong', null, 'Linhas por lote'), h('span', null, 'Entre 100 e 50.000 (original: 5.000).')), batch)),
      h('p', { class: 'bt-note' }, 'Tabela nova: todas as colunas NVARCHAR(MAX). Tabela existente: os dados são acrescentados; nada é apagado nem alterado de forma destrutiva. Cada arquivo roda numa transação própria: se falhar, nada dele fica no banco.'));

    // 5) Validar e importar
    function drawActions() {
      const sel = selected();
      const missing = sel.filter((f) => !f.database.trim()).length;
      const running = !!(BT.job && BT.job.status === 'running');
      const canValidate = sel.length && BT.connectionId && !missing && !BT.validating && !running;
      const pl = BT.plan;
      const c = BT.conns.find((x) => x.id === BT.connectionId);
      const nonLocal = c && c.env !== 'local';
      const validateBtn = h('button', { class: `btn${pl ? '' : ' primary'}`, disabled: !canValidate, onclick: (e) => busy(e.currentTarget, validate, 'Validando…') }, pl ? 'Validar de novo' : 'Validar');
      const importBtn = h('button', { class: 'btn primary', disabled: !pl || !pl.canExecute || running, onclick: (e) => busy(e.currentTarget, () => execute(false)) },
        pl ? `Importar ${plural(pl.totals.files, 'arquivo', 'arquivos')}` : 'Importar');
      const status = !sel.length ? 'Selecione arquivos.' : missing ? `${plural(missing, 'arquivo', 'arquivos')} sem banco de destino.` : !BT.connectionId ? 'Escolha a conexão.'
        : pl ? `Validado às ${new Date(pl.validatedAt).toLocaleTimeString('pt-BR')} · expira às ${new Date(pl.expiresAt).toLocaleTimeString('pt-BR')}` : 'A validação lê os arquivos e confere o servidor, sem gravar nada.';
      const v = BT.validating;
      actionsHost.replaceChildren(...[
        pl && pl.canExecute ? h('div', { class: 'bt-stats' },
          stat('Arquivos', N(pl.totals.files)), stat('Bancos', N(pl.totals.databases)), stat('Tabelas', N(pl.groups.reduce((n, g) => n + g.tables.length, 0))), stat('Linhas', N(pl.totals.rows))) : null,
        pl && pl.canExecute ? h('div', { class: `bt-target${nonLocal ? ' warn' : ''}` },
          h('div', null, h('span', { class: 'bt-label' }, 'Servidor'), h('span', null, h('strong', null, pl.target.server), h('span', { class: 'bt-meta' }, ` · ${pl.target.connectedTo}`))),
          h('div', null, h('span', { class: 'bt-label' }, 'Login'), h('strong', null, pl.target.login)),
          h('div', null, h('span', { class: 'bt-label' }, 'Ambiente'), h('strong', null, c ? c.envLabel : pl.target.env)),
          nonLocal ? h('div', { class: 'bt-target-note' }, 'Fora do localhost: será pedida confirmação antes de importar.') : null) : null,
        pl && pl.issues.length ? h('div', { class: 'box bad' }, h('strong', null, 'Corrija antes de importar'), msgs('bad', pl.issues)) : null,
        v ? h('div', { class: 'bt-progress-line' }, bar(v.size ? (v.bytes / v.size) * 100 : 0), h('span', { class: 'bt-meta' }, `Validando ${Math.min(v.done + 1, v.total)} de ${v.total}${v.current ? ` — ${v.current}` : ''}`)) : null,
        h('div', { class: 'bt-actionbar' }, h('span', { class: 'bt-meta' }, status), h('div', { class: 'bt-actionbar-buttons' }, validateBtn, importBtn)),
      ].filter(Boolean));
    }
    async function validate() {
      const sel = selected();
      const r = await api('POST', `${BASE}/validate`, { connectionId: BT.connectionId, files: sel.map((f) => ({ path: f.path, database: f.database.trim() })), options: BT.options });
      BT.validating = { done: 0, total: sel.length, bytes: 0, size: 1 };
      drawActions();
      await new Promise((resolve) => {
        const t = setInterval(async () => {
          try {
            const j = await api('GET', `${BASE}/jobs/${r.jobId}`);
            BT.validating = j;
            if (j.status === 'running') { drawActions(); return; }
            clearInterval(t); BT.validating = null;
            if (j.status === 'error') { fail(new Error(j.error)); BT.plan = null; } else { BT.plan = { ...j.result, validatedAt: Date.now() }; }
            redraw(); resolve();
          } catch (e) { clearInterval(t); BT.validating = null; fail(e); drawActions(); resolve(); }
        }, 400);
      });
    }
    async function execute(confirmed) {
      const pl = BT.plan;
      try {
        const r = await api('POST', `${BASE}/plans/${pl.planId}/execute`, { hash: pl.hash, authorized: true, confirmed });
        BT.plan = null;
        watch(r.jobId);
      } catch (e) {
        if (e.code === 'BT_CONFIRM') {
          const ok = await confirmDialog({ title: 'Confirmar importação', message: e.message, okText: 'Importar', danger: true });
          if (ok) return execute(true);
          return;
        }
        if (e.code === 'BT_PLAN_EXPIRED') { BT.plan = null; redraw(); }
        throw e;
      }
    }

    // 6) Execução e resultado
    function watch(jobId) {
      clearInterval(BT.timer);
      BT.job = { status: 'running', items: [], total: 0, done: 0 };
      drawActions();
      const tick = async () => {
        try {
          const j = await api('GET', `${BASE}/jobs/${jobId}`);
          BT.job = j; drawProgress(j);
          if (j.status !== 'running') { clearInterval(BT.timer); drawActions(); }
        } catch (e) { clearInterval(BT.timer); fail(e); }
      };
      BT.timer = setInterval(tick, 500); tick();
      setTimeout(() => resultHost.scrollIntoView({ behavior: 'smooth', block: 'start' }), 300);
    }
    function drawProgress(j) {
      const groups = new Map();
      for (const it of j.items) { const g = groups.get(it.database) || { database: it.database, size: 0, bytes: 0, rows: 0, files: 0 }; groups.set(it.database, g); g.size += it.size || 0; g.bytes += it.status === 'done' ? it.size : Math.min(it.bytes || 0, it.size || 0); g.rows += it.rows || 0; g.files++; }
      const mark = { pending: ['○', 'none', 'aguardando'], running: ['◐', 'info', 'processando'], done: ['✓', 'ok', ''], error: ['✕', 'bad', ''], cancelled: ['–', 'none', 'cancelado'], skipped: ['–', 'none', 'não executado'] };
      const running = j.status === 'running';
      const r = j.result;
      const pctOf = (g) => (g.size ? Math.round((g.bytes / g.size) * 100) : 100);
      const total = j.items.reduce((n, i) => n + (i.size || 0), 0);
      const doneBytes = j.items.reduce((n, i) => n + (i.status === 'done' ? i.size || 0 : Math.min(i.bytes || 0, i.size || 0)), 0);
      const ok = r && !r.failed && j.status === 'done';
      resultHost.replaceChildren(h('section', { class: 'card bt-section' },
        h('div', { class: 'bt-section-head' }, h('span', { class: `bt-step ${running ? 'live' : ok ? 'ok' : 'bad'}` }, running ? '◐' : ok ? '✓' : '!'),
          h('div', { class: 'bt-section-title' }, h('h2', null, running ? 'Importando…' : 'Resultado'), h('span', { class: 'bt-sub' }, `${j.done} de ${plural(j.total, 'arquivo', 'arquivos')}${running && j.current ? ` · ${j.current}` : ''}`)),
          running ? h('div', { class: 'bt-section-actions' }, h('button', { class: 'btn danger sm', onclick: async (e) => { e.currentTarget.disabled = true; try { await api('POST', `${BASE}/jobs/${j.id}/cancel`); toast('Cancelamento pedido: o arquivo em andamento será desfeito.', 'info'); } catch (err) { fail(err); } } }, 'Cancelar')) : null),
        h('div', { class: 'bt-section-body' }, ...[
          running ? h('div', { class: 'bt-progress-line' }, bar(total ? (doneBytes / total) * 100 : 0), h('span', { class: 'bt-meta' }, `${total ? Math.round((doneBytes / total) * 100) : 0}% · ${N(j.items.reduce((n, i) => n + (i.rows || 0), 0))} registro(s)`)) : null,
          !running && r ? summary(j, r) : null,
          running && groups.size > 1 ? h('div', { class: 'bt-dbs grid' }, [...groups.values()].map((g) => h('div', { class: 'bt-db' },
            h('div', { class: 'bt-db-head' }, h('span', { class: 'bt-db-name mono' }, g.database), h('span', { class: 'bt-meta' }, `${N(g.rows)} registro(s) · ${plural(g.files, 'arquivo', 'arquivos')}`)),
            h('div', { class: 'bt-progress-line' }, bar(pctOf(g)), h('span', { class: 'bt-meta' }, `${pctOf(g)}%`))))) : null,
          h('div', { class: 'bt-subhead' }, h('h3', null, 'Arquivos')),
          h('div', { class: 'bt-runlist' }, j.items.map((it) => h('div', { class: `bt-run ${it.status}` },
            tag(`${mark[it.status][1]} icon`, mark[it.status][0]),
            h('div', { class: 'bt-run-main' }, h('div', { class: 'bt-run-name' }, h('strong', null, it.name), h('span', { class: 'bt-meta' }, ` → ${it.database}`)),
              it.error ? h('div', { class: `bt-run-error${it.status === 'error' ? '' : ' muted'}` }, it.error) : null),
            h('span', { class: 'bt-meta bt-run-info' }, it.status === 'done' ? `${N(it.rows)} registro(s) · ${Object.keys(it.tables).length} tabela(s) · ${fmtMs(it.ms)}`
              : it.status === 'running' ? `${it.table ? `${it.table} · ` : ''}${N(it.rows)} registro(s) · ${it.size ? Math.round((it.bytes / it.size) * 100) : 0}%` : mark[it.status][2])))),
          !running && j.error ? h('div', { class: 'box bad' }, j.error) : null,
        ].filter(Boolean))));
    }
    function summary(j, r) {
      const failed = j.items.filter((i) => i.status === 'error');
      const head = j.status === 'cancelled' ? ['warn', 'Importação cancelada'] : j.status === 'error' ? ['bad', 'Importação não executada'] : r.failed ? ['warn', `Concluído com ${plural(r.failed, 'falha', 'falhas')}`] : ['ok', 'Concluído'];
      return h('div', { class: 'bt-summary' },
        h('div', { class: `bt-banner ${head[0]}` }, `${head[0] === 'ok' ? '✓' : '!'} ${head[1]}`),
        h('div', { class: 'bt-stats' }, ...[
          stat('Processados', N(r.ok + r.failed)), stat('Sucesso', N(r.ok), 'ok'), stat('Falha', N(r.failed), r.failed ? 'bad' : ''),
          r.cancelled ? stat('Cancelados', N(r.cancelled), 'warn') : null, r.skipped ? stat('Não executados', N(r.skipped), 'warn') : null,
          stat('Registros', N(r.rows)), stat('Duração', fmtMs(r.durationMs))].filter(Boolean)),
        r.databases.map((d) => h('div', { class: 'bt-db' },
          h('div', { class: 'bt-db-head' }, h('span', { class: 'bt-db-name mono' }, d.database),
            h('span', { class: 'bt-meta' }, `${plural(d.tables.length, 'tabela', 'tabelas')} · ${N(d.tables.reduce((n, t) => n + t.rows, 0))} registro(s) adicionado(s)`)),
          h('div', { class: 'bt-tables' }, d.tables.map((t) => h('div', { class: 'bt-tbl', title: plural(t.files, 'arquivo', 'arquivos') },
            h('span', { class: 'bt-tbl-name mono' }, t.table), h('span', { class: 'bt-tbl-n' }, N(t.rows)), t.files > 1 ? tag('info sm', `${t.files} arq.`) : null))))),
        failed.length ? h('div', { class: 'box bad' }, h('strong', null, 'Falhas'), msgs('bad', failed.map((i) => `${i.name} — ${i.error}`))) : null,
        h('p', { class: 'bt-note' }, 'Cada arquivo também foi registrado na Auditoria de execuções e no Histórico desta ferramenta.'));
    }

    host.append(origin, conn, files, options, h('section', { class: 'card bt-section' },
      h('div', { class: 'bt-section-head' }, h('span', { class: 'bt-step' }, '5'), h('div', { class: 'bt-section-title' }, h('h2', null, 'Validação e importação'))), actionsHost), resultHost);
    redraw();
    if (BT.job) drawProgress(BT.job);
    if (BT.job && BT.job.status === 'running' && BT.job.id) watch(BT.job.id);
  }

  // ---------- Histórico ----------
  async function renderHistory(host) {
    let list;
    try { list = await api('GET', `${BASE}/history`); } catch (e) { return fail(e); }
    const RES = { sucesso: 'ok', 'com falhas': 'soon', cancelada: 'none', erro: 'overdue' };
    host.append(h('div', { class: 'card' }, h('div', { class: 'card-body' }, list.length
      ? h('div', { class: 'tablewrap' }, h('table', { class: 'compact' },
        h('thead', null, h('tr', null, ['Data', 'Usuário', 'Conexão', 'Arquivos', 'Bancos', 'Tabelas', 'Registros', 'Resultado', 'Duração'].map((t) => h('th', null, t)))),
        h('tbody', null, list.map((x) => h('tr', null, h('td', null, fmtDateTime(x.at)), h('td', null, x.by || '—'), h('td', null, x.connection, h('div', { class: 'small muted' }, x.server)),
          h('td', { class: 'num' }, `${x.ok}/${x.files}`), h('td', { class: 'mono small' }, x.databases.join(', ') || '—'), h('td', { class: 'num' }, String(x.tables)), h('td', { class: 'num' }, N(x.rows)),
          h('td', null, h('span', { class: `pill ${RES[x.result] || 'none'}` }, x.result)), h('td', null, fmtMs(x.durationMs)))))))
      : h('div', { class: 'empty' }, 'Nenhuma importação ainda.')),
    h('div', { class: 'card-body hint' }, 'Só um resumo de cada execução (últimas 50): nenhum conteúdo dos arquivos e nenhuma senha é guardado.')));
  }

  // ---------- Configurações ----------
  function renderSettings(host, reload) {
    const s = { ...BT.settings };
    const tables = h('textarea', { rows: 6, style: 'width:100%;font-family:var(--mono, monospace)' }, s.allowedTables.join(', '));
    const chk = (k, label) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!s[k], onchange: (e) => { s[k] = e.target.checked; } }), ` ${label}`);
    const pattern = h('input', { type: 'text', value: s.namePattern, style: 'width:100%' });
    const batch = h('input', { type: 'number', min: 100, max: 50000, step: 500, value: s.batchSize, style: 'width:120px' });
    const save = async (values) => {
      const r = await api('PUT', `${BASE}/settings`, values);
      BT.settings = r.settings;
      BT.options = { onlyAllowed: r.settings.onlyAllowed, addMissingColumns: r.settings.addMissingColumns, batchSize: r.settings.batchSize, stopOnError: r.settings.stopOnError };
      invalidate(); toast('Configurações salvas.', 'ok'); reload();
    };
    host.append(h('div', { class: 'card' }, h('div', { class: 'card-body stack' },
      field(`Tabelas permitidas (${s.allowedTables.length})`, tables, 'Nomes dos blocos [TABELA] que podem ser importados quando “Somente tabelas da lista” estiver marcado. Separe por vírgula, espaço ou linha. A comparação diferencia maiúsculas/minúsculas, como no app original.'),
      chk('onlyAllowed', 'Somente tabelas da lista (padrão das novas importações)'),
      chk('addMissingColumns', 'Adicionar colunas que faltam em tabela existente (padrão)'),
      chk('stopOnError', 'Parar no primeiro arquivo com erro (padrão)'),
      chk('recursive', 'Incluir subpastas ao ler uma pasta (padrão)'),
      field('Linhas por lote', batch, 'Entre 100 e 50.000 (o app original usa 5.000).'),
      field('Padrão sugerido no “Renomear em lote”', pattern, 'Use [ARQUIVO] para o nome do arquivo. Padrão: MIGRA_[ARQUIVO].'),
      h('div', { class: 'inline' },
        h('button', { class: 'btn primary', onclick: (e) => busy(e.currentTarget, () => save({ ...s, allowedTables: tables.value, namePattern: pattern.value, batchSize: Number(batch.value) })) }, 'Salvar'),
        h('button', { class: 'btn ghost', onclick: async (e) => { if (await confirmDialog({ title: 'Restaurar padrão', message: 'Voltar a lista de tabelas e as opções para o padrão do app original (bt sql gui)?', okText: 'Restaurar' })) await busy(e.currentTarget, () => save(BT.defaults)); } }, 'Restaurar padrão do app original')))));
  }

  window.GP_TOOLS['bt-importer'] = { render };
})();
