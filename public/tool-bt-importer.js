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
    const body = h('div', { class: 'stack', style: 'gap:14px' });
    const tabs = [['import', 'Importar'], ['history', 'Histórico'], ['settings', 'Configurações']];
    main.replaceChildren(h('div', { class: 'page' },
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
  function renderImport(host) {
    const sec = (n, title, ...content) => h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, `${n}. ${title}`)), h('div', { class: 'card-body stack' }, ...content));
    const filesHost = h('div'); const groupsHost = h('div'); const actionsHost = h('div'); const resultHost = h('div');
    const originHint = h('div', { class: 'hint' });
    const drawOrigin = () => { originHint.textContent = BT.dir ? `Pasta: ${BT.dir}${BT.recursive ? ' (com subpastas)' : ''} · ${plural(BT.files.length, 'arquivo .bt', 'arquivos .bt')}` : BT.files.length ? plural(BT.files.length, 'arquivo selecionado', 'arquivos selecionados') : 'Escolha um arquivo, vários arquivos (Ctrl/Shift no seletor) ou uma pasta inteira. Só arquivos .bt são considerados.'; };
    const redraw = () => { drawOrigin(); drawFiles(); drawGroups(); drawActions(); };

    // 1) Origem
    const recursive = h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: BT.recursive, onchange: (e) => { BT.recursive = e.target.checked; if (BT.dir) loadList({ dir: BT.dir }); } }), ' Incluir subpastas');
    // Caminho digitado/colado (como o campo "Pasta" + "Ler .bt" do app original): pasta ou um arquivo .bt.
    const typed = h('input', { type: 'text', placeholder: 'C:\\pasta\\com\\arquivos  ou  C:\\pasta\\arquivo.bt', value: BT.dir || '', style: 'flex:1;min-width:260px', 'aria-label': 'Pasta ou arquivo .bt',
      onkeydown: (e) => { if (e.key === 'Enter') readTyped(); } });
    const readTyped = () => { const v = typed.value.trim().replace(/^"|"$/g, ''); if (!v) return toast('Informe uma pasta ou um arquivo .bt.', 'error'); return loadList(/\.bt$/i.test(v) ? { paths: [v] } : { dir: v }); };
    const origin = sec(1, 'Origem',
      h('div', { class: 'inline' },
        h('button', { class: 'btn', onclick: (e) => busy(e.currentTarget, () => pick('files')) }, 'Selecionar arquivo(s) .bt…'),
        h('button', { class: 'btn', onclick: (e) => busy(e.currentTarget, () => pick('folder')) }, 'Selecionar pasta…'),
        recursive,
        BT.files.length ? h('button', { class: 'btn ghost', onclick: () => { BT.files = []; BT.dir = null; invalidate(); redraw(); } }, 'Limpar lista') : null),
      h('div', { class: 'inline' }, typed, h('button', { class: 'btn', onclick: (e) => busy(e.currentTarget, readTyped) }, 'Ler .bt')),
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
    const connSel = h('select', { onchange: (e) => { BT.connectionId = e.target.value; invalidate(); drawActions(); } },
      BT.conns.length ? BT.conns.map((c) => h('option', { value: c.id }, `${c.name} — ${c.envLabel} · ${c.server}${c.port ? ',' + c.port : ''} · ${c.auth === 'sql' ? `login ${c.user}` : 'Windows'}`))
        : h('option', { value: '' }, 'Nenhuma conexão cadastrada'));
    if (BT.connectionId) connSel.value = BT.connectionId;
    const conn = sec(2, 'Conexão', connSel,
      h('div', { class: 'hint' }, 'Usa as conexões de Configurações → Conexões (a senha fica protegida e nunca aparece aqui). O banco padrão da conexão é ignorado: cada arquivo vai para o banco de destino da lista abaixo, criado se não existir.'),
      !BT.conns.length ? h('div', null, h('a', { href: '#/settings' }, 'Cadastrar uma conexão')) : null);

    // 3) Arquivos e bancos de destino
    function groupsOf(list) {
      const m = new Map();
      for (const f of list) { const k = dbKey(f.database); if (!k) continue; if (!m.has(k)) m.set(k, { database: f.database.trim(), files: [] }); m.get(k).files.push(f); }
      return m;
    }
    function statusOf(f) {
      const it = BT.plan?.items.find((x) => x.path === f.path);
      if (!f.include) return h('span', { class: 'muted small' }, 'Não importar');
      if (!f.database.trim()) return h('span', { class: 'pill overdue' }, 'Sem destino');
      if (!it) return h('span', { class: 'muted small' }, BT.plan ? '—' : 'Pronto para validar');
      if (it.status === 'blocked') return h('span', { class: 'pill overdue', title: it.reasons.join('\n') }, 'Problema');
      if (it.status === 'empty') return h('span', { class: 'pill soon', title: it.warnings.join('\n') }, 'Sem dados');
      return h('span', { class: `pill ${it.warnings.length ? 'soon' : 'ok'}`, title: it.warnings.join('\n') || null }, `Pronto · ${N(it.rows)} linha(s)`);
    }
    function drawFiles() {
      if (!BT.files.length) { filesHost.replaceChildren(h('div', { class: 'empty' }, 'Nenhum arquivo selecionado.')); return; }
      const groups = groupsOf(selected());
      const all = h('input', { type: 'checkbox', checked: BT.files.every((f) => f.include), 'aria-label': 'Marcar todos', onchange: (e) => { for (const f of BT.files) f.include = e.target.checked; invalidate(); redraw(); } });
      const rows = BT.files.map((f) => {
        const g = groups.get(dbKey(f.database));
        const input = h('input', { type: 'text', value: f.database, 'aria-label': `Banco de destino de ${f.name}`, disabled: !f.include, style: 'min-width:180px;width:100%',
          oninput: (e) => { f.database = e.target.value; f.custom = true; invalidate(); drawGroups(); drawActions(); }, onchange: () => drawFiles() });
        const it = BT.plan?.items.find((x) => x.path === f.path);
        return h('tr', { class: f.include ? '' : 'off' },
          h('td', null, h('input', { type: 'checkbox', checked: f.include, 'aria-label': `Importar ${f.name}`, onchange: (e) => { f.include = e.target.checked; invalidate(); redraw(); } })),
          h('td', null, h('strong', null, f.rel || f.name), h('div', { class: 'small muted' }, fmtSize(f.size)),
            it && it.status !== 'ok' && it.reasons.length ? h('div', { class: 'small', style: 'color:var(--bad-text)' }, it.reasons.join(' · ')) : null,
            it && it.warnings.length ? h('div', { class: 'small', style: 'color:var(--warn-text)' }, it.warnings.join(' · ')) : null,
            it && it.tables.length ? h('div', { class: 'small muted' }, 'Tabelas: ', it.tables.map((t) => (t.included ? `${t.name} (${N(t.rows)})` : `${t.name} — ignorada: ${t.skipReason}`)).join(' · ')) : null),
          h('td', null, h('div', { class: 'inline', style: 'gap:6px;flex-wrap:nowrap' }, input,
            f.include && g && g.files.length > 1 ? h('span', { class: 'pill info', title: `${g.files.length} arquivos vão para ${g.database}: as tabelas de mesmo nome são somadas` }, `agrupado ×${g.files.length}`) : null)),
          h('td', null, statusOf(f)));
      });
      filesHost.replaceChildren(h('div', { class: 'tablewrap', style: 'max-height:48vh' }, h('table', { class: 'compact batch-list bt-files' },
        h('thead', null, h('tr', null, h('th', null, all), h('th', null, 'Arquivo'), h('th', null, 'Banco de destino'), h('th', null, 'Status'))),
        h('tbody', null, rows))));
    }
    function drawGroups() {
      const groups = [...groupsOf(selected()).values()];
      if (!groups.length) { groupsHost.replaceChildren(); return; }
      const planGroups = new Map((BT.plan?.groups || []).map((g) => [dbKey(g.database), g]));
      groupsHost.replaceChildren(h('div', { class: 'bt-groups' }, groups.map((g) => {
        const pg = planGroups.get(dbKey(g.database));
        return h('div', { class: `bt-group${pg?.issues.length || pg?.tables.some((t) => t.issues.length) ? ' bad' : ''}` },
          h('div', { class: 'inline', style: 'gap:6px' }, h('strong', { class: 'mono' }, g.database), pg ? h('span', { class: `pill ${pg.createDatabase ? 'info' : 'soon'}` }, pg.createDatabase ? 'banco novo' : 'banco existente') : null),
          h('div', { class: 'small muted' }, plural(g.files.length, 'arquivo', 'arquivos')),
          pg ? pg.tables.map((t) => h('div', { class: 'small' }, h('span', { class: 'mono' }, t.name), ` · ${N(t.rows)} linha(s) · ${plural(t.files.length, 'arquivo', 'arquivos')} · `,
            t.create ? h('span', { class: 'pill ok' }, t.existed ? 'acrescentar' : 'criar') : h('span', { class: 'pill soon' }, 'acrescentar'),
            t.addColumns.length ? h('span', { class: 'small', style: 'color:var(--warn-text)' }, ` + colunas ${t.addColumns.join(', ')}`) : null,
            t.issues.length ? h('div', { class: 'small', style: 'color:var(--bad-text)' }, t.issues.join(' · ')) : null,
            t.warnings.length ? h('div', { class: 'small', style: 'color:var(--warn-text)' }, t.warnings.join(' · ')) : null)) : null,
          pg?.issues.length ? h('div', { class: 'small', style: 'color:var(--bad-text)' }, pg.issues.join(' · ')) : null);
      })));
    }

    function batchRename() {
      const targets = selected();
      if (!targets.length) return toast('Marque os arquivos que serão renomeados.', 'info');
      const input = h('input', { type: 'text', value: BT.settings.namePattern || 'MIGRA_[ARQUIVO]', style: 'width:100%' });
      const preview = h('div');
      const draw = () => {
        const p = input.value.trim();
        preview.replaceChildren(h('div', { class: 'tablewrap', style: 'max-height:40vh' }, h('table', { class: 'compact' },
          h('thead', null, h('tr', null, h('th', null, 'Arquivo'), h('th', null, 'Banco atual'), h('th', null, 'Novo banco'))),
          h('tbody', null, targets.map((f) => h('tr', null, h('td', null, f.name), h('td', { class: 'mono muted' }, f.database), h('td', { class: 'mono' }, p ? applyPattern(p, f.name) : '—')))))));
      };
      input.addEventListener('input', draw); draw();
      const m = openModal({
        title: `Renomear em lote — ${plural(targets.length, 'arquivo', 'arquivos')}`,
        body: [field('Padrão do banco de destino', input, 'Use [ARQUIVO] onde entra o nome do arquivo (sem .bt). Sem [ARQUIVO], todos vão para o MESMO banco. Ex.: MIGRA_[ARQUIVO] · ZMIGRA_TESTE_[ARQUIVO]_PRD2 · historico'),
          h('div', { class: 'inline' }, ['MIGRA_[ARQUIVO]', '[ARQUIVO]', 'historico'].map((p) => h('button', { class: 'btn sm ghost', onclick: () => { input.value = p; draw(); } }, p))), preview],
        footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'), h('button', { class: 'btn primary', onclick: () => {
          const p = input.value.trim();
          if (!p) return toast('Informe um nome ou padrão para o banco de destino.', 'error');
          for (const f of targets) { f.database = applyPattern(p, f.name); f.custom = true; }
          invalidate(); m.close(); redraw();
        } }, 'Aplicar')],
      });
    }
    const files = sec(3, 'Arquivos e bancos de destino',
      h('div', { class: 'inline' },
        h('button', { class: 'btn', onclick: batchRename }, 'Renomear em lote'),
        h('button', { class: 'btn ghost', title: 'Volta ao nome padrão do app original: MIGRA_<ARQUIVO>', onclick: () => { for (const f of selected()) { f.database = `MIGRA_${fileBase(f.name)}`.slice(0, 128); f.custom = false; } invalidate(); redraw(); } }, 'Nome padrão'),
        h('button', { class: 'btn ghost', onclick: () => { for (const f of selected()) f.database = ''; invalidate(); redraw(); } }, 'Limpar destinos')),
      filesHost, groupsHost);

    // 4) Opções desta importação
    const o = BT.options;
    const opt = (k, label, hint) => h('label', { class: 'check', title: hint }, h('input', { type: 'checkbox', checked: !!o[k], onchange: (e) => { o[k] = e.target.checked; invalidate(); redraw(); } }), ` ${label}`);
    const batch = h('input', { type: 'number', min: 100, max: 50000, step: 500, value: o.batchSize, style: 'width:110px', onchange: (e) => { o.batchSize = Number(e.target.value); invalidate(); drawActions(); } });
    const options = sec(4, 'Opções desta importação',
      h('div', { class: 'inline', style: 'gap:16px;flex-wrap:wrap' },
        opt('onlyAllowed', `Somente tabelas da lista (${BT.settings.allowedTables.length})`, 'Como no app original: só os blocos cujo nome está na lista de Configurações são importados.'),
        opt('addMissingColumns', 'Adicionar colunas que faltam em tabela existente', 'Como no app original: ALTER TABLE ADD da coluna (NVARCHAR(MAX) NULL). Desligado: estrutura diferente bloqueia o destino.'),
        opt('stopOnError', 'Parar no primeiro arquivo com erro', 'O app original continua nos próximos arquivos.'),
        h('label', { class: 'inline', style: 'gap:6px' }, 'Linhas por lote', batch)),
      h('div', { class: 'hint' }, 'Tabela nova: todas as colunas NVARCHAR(MAX). Tabela existente: os dados são acrescentados; nada é apagado nem alterado de forma destrutiva. Cada arquivo roda numa transação própria: se falhar, nada dele fica no banco.'));

    // 5) Validar e importar
    function drawActions() {
      const sel = selected();
      const missing = sel.filter((f) => !f.database.trim()).length;
      const canValidate = sel.length && BT.connectionId && !missing && !BT.validating && !(BT.job && BT.job.status === 'running');
      const pl = BT.plan;
      const c = BT.conns.find((x) => x.id === BT.connectionId);
      const nonLocal = c && c.env !== 'local';
      const validateBtn = h('button', { class: 'btn', disabled: !canValidate, onclick: (e) => busy(e.currentTarget, validate, 'Validando…') }, 'Validar');
      const importBtn = h('button', { class: `btn ${nonLocal ? 'danger' : 'primary'}`, disabled: !pl || !pl.canExecute || (BT.job && BT.job.status === 'running'), onclick: (e) => busy(e.currentTarget, () => execute(false)) },
        pl ? `Importar ${plural(pl.totals.files, 'arquivo', 'arquivos')}${nonLocal ? ` em ${c.envLabel}` : ''}` : 'Importar');
      const v = BT.validating;
      actionsHost.replaceChildren(...[
        h('div', { class: 'inline' }, validateBtn, importBtn, h('span', { class: 'small muted' },
          !sel.length ? 'Selecione arquivos.' : missing ? `${plural(missing, 'arquivo', 'arquivos')} sem banco de destino.` : !BT.connectionId ? 'Escolha a conexão.' : pl ? `Validado às ${new Date(pl.validatedAt).toLocaleTimeString('pt-BR')} · ${N(pl.totals.rows)} linha(s) em ${plural(pl.totals.databases, 'banco', 'bancos')} · expira às ${new Date(pl.expiresAt).toLocaleTimeString('pt-BR')}` : 'Valide antes de importar (lê os arquivos e confere o servidor, sem gravar nada).')),
        v ? h('div', { class: 'stack' }, h('div', { class: 'progress' }, h('div', { style: `width:${v.size ? Math.round((v.bytes / v.size) * 100) : 0}%` })), h('div', { class: 'small muted' }, `Validando ${Math.min(v.done + 1, v.total)} de ${v.total}${v.current ? ` — ${v.current}` : ''}`)) : null,
        pl && pl.issues.length ? h('div', { class: 'box bad' }, h('strong', null, 'Corrija antes de importar:'), h('ul', null, pl.issues.map((i) => h('li', null, i)))) : null,
        pl && pl.canExecute ? h('div', { class: `box${nonLocal ? ' warn' : ''}` }, h('dl', { class: 'kv', style: 'margin:0' },
          h('dt', null, 'Servidor'), h('dd', null, `${pl.target.server} (${pl.target.connectedTo})`), h('dt', null, 'Login'), h('dd', null, pl.target.login),
          h('dt', null, 'Ambiente'), h('dd', null, `${c ? c.envLabel : pl.target.env}`))) : null,
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
    }
    function drawProgress(j) {
      const groups = new Map();
      for (const it of j.items) { const g = groups.get(it.database) || { database: it.database, size: 0, bytes: 0, rows: 0, files: 0 }; groups.set(it.database, g); g.size += it.size || 0; g.bytes += it.status === 'done' ? it.size : Math.min(it.bytes || 0, it.size || 0); g.rows += it.rows || 0; g.files++; }
      const mark = { pending: ['○', 'muted', 'aguardando'], running: ['◐', 'ck-wait', 'processando'], done: ['✓', 'ck-done', ''], error: ['✕', 'ck-bad', ''], cancelled: ['–', 'muted', 'cancelado'], skipped: ['–', 'muted', 'não executado'] };
      const running = j.status === 'running';
      const r = j.result;
      resultHost.replaceChildren(...[
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, running ? `Importando ${plural(j.total, 'arquivo', 'arquivos')} — ${j.done} / ${j.total}` : 'Resultado'),
          running ? h('button', { class: 'btn danger sm', onclick: async (e) => { e.currentTarget.disabled = true; try { await api('POST', `${BASE}/jobs/${j.id}/cancel`); toast('Cancelamento pedido: o arquivo em andamento será desfeito.', 'info'); } catch (err) { fail(err); } } }, 'Cancelar') : null),
        h('div', { class: 'card-body stack' },
          j.current && running ? h('div', { class: 'small muted' }, j.current) : null,
          h('div', { class: 'bt-groups' }, [...groups.values()].map((g) => h('div', { class: 'bt-group' },
            h('div', { class: 'inline', style: 'gap:6px' }, h('strong', { class: 'mono' }, g.database), h('span', { class: 'small muted' }, `${N(g.rows)} registro(s)`)),
            h('div', { class: 'progress' }, h('div', { style: `width:${g.size ? Math.round((g.bytes / g.size) * 100) : 100}%` })),
            h('div', { class: 'small muted' }, `${g.size ? Math.round((g.bytes / g.size) * 100) : 100}% · ${plural(g.files, 'arquivo', 'arquivos')}`)))),
          h('div', { class: 'batch-result' }, j.items.map((it) => h('div', { class: `batch-item ${it.status}` }, h('span', { class: mark[it.status][1] }, mark[it.status][0]),
            h('div', { class: 'grow stack', style: 'gap:1px' }, h('span', null, h('strong', null, it.name), h('span', { class: 'small muted' }, ` → ${it.database}`)),
              h('span', { class: 'small muted' }, it.status === 'done' ? `${N(it.rows)} registro(s) · ${Object.keys(it.tables).length} tabela(s) · ${fmtMs(it.ms)}` : it.status === 'running' ? `processando${it.table ? ` ${it.table}` : ''} · ${N(it.rows)} registro(s) · ${it.size ? Math.round((it.bytes / it.size) * 100) : 0}%` : mark[it.status][2]),
              it.error ? h('span', { class: 'small', style: `color:${it.status === 'error' ? 'var(--bad-text)' : 'var(--muted)'}` }, it.error) : null)))),
          !running && j.error ? h('div', { class: 'box bad' }, j.error) : null,
          !running && r ? summary(j, r) : null)),
      ].filter(Boolean));
    }
    function summary(j, r) {
      const failed = j.items.filter((i) => i.status === 'error');
      return h('div', { class: 'stack' },
        h('div', { class: r.failed || j.status !== 'done' ? 'result-bad' : 'result-ok' },
          j.status === 'cancelled' ? 'Importação cancelada.' : j.status === 'error' ? 'Importação não executada.' : r.failed ? `Concluído com ${plural(r.failed, 'falha', 'falhas')}.` : '✓ Concluído'),
        h('dl', { class: 'kv' }, h('dt', null, 'Arquivos processados'), h('dd', null, String(r.ok + r.failed)), h('dt', null, 'Sucesso'), h('dd', null, String(r.ok)), h('dt', null, 'Falha'), h('dd', null, String(r.failed)),
          r.cancelled ? [h('dt', null, 'Cancelados'), h('dd', null, String(r.cancelled))] : null, r.skipped ? [h('dt', null, 'Não executados'), h('dd', null, String(r.skipped))] : null,
          h('dt', null, 'Registros'), h('dd', null, N(r.rows)), h('dt', null, 'Duração'), h('dd', null, fmtMs(r.durationMs))),
        r.databases.map((d) => h('div', { class: 'bt-group' }, h('strong', { class: 'mono' }, d.database),
          d.tables.map((t) => h('div', { class: 'small' }, h('span', { class: 'mono' }, t.table), ` — ${plural(t.files, 'arquivo', 'arquivos')} · ${N(t.rows)} registro(s) adicionado(s)`)))),
        failed.length ? h('div', { class: 'box bad' }, h('strong', null, 'Falhas:'), h('ul', null, failed.map((i) => h('li', null, h('strong', null, i.name), ` — ${i.error}`)))) : null,
        h('div', { class: 'hint' }, 'Cada arquivo também foi registrado na Auditoria de execuções e no Histórico desta ferramenta.'));
    }

    host.append(origin, conn, files, options, sec(5, 'Validação e importação', actionsHost), resultHost);
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
