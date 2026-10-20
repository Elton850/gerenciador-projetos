// Ferramentas Auxiliares › Explorador de Banco (tela). Regras e acesso ao banco ficam no servidor (src/tools/db-explorer).
// Barra: conexão cadastrada → banco → Carregar estrutura (+ busca global). Abas: Visão geral · Tabelas · Mapa relacional ·
// Caminhos · Montador de consulta · Console SQL · Configurações. Painel lateral da tabela: colunas, relacionamentos, amostra,
// perfil e anotação. O mapa é um SVG desenhado aqui (força + camadas), com zoom, arrastar e foco na vizinhança.
// SOMENTE LEITURA: nada é gravado no banco; hipóteses (relacionamentos inferidos) aparecem tracejadas e sempre como hipótese.
(() => {
  const BASE = '/api/tools/db-explorer';
  const DX = {
    tab: 'overview', conns: [], connectionId: null, database: '', dbs: null, catalog: null, overview: null, keys: [], settings: null, defaults: null,
    tables: { q: '', schema: '', filter: 'all', sort: 'relevance', items: [], total: 0 },
    map: { mode: 'center', center: '', depth: 1, direction: 'both', includeInferred: false, avoidHubs: true, selection: [], schema: '', payload: null, selected: null },
    paths: { from: '', to: '', maxDepth: 4, includeInferred: false, avoidHubs: true, result: null },
    builder: { tables: [], joinType: 'INNER', top: 100, includeInferred: false, avoidHubs: false, star: false, columns: {}, result: null },
    console: { sql: '', limit: null, mask: null, result: null, history: [], running: null },
  };
  const N = (n) => Number(n || 0).toLocaleString('pt-BR');
  const cid = () => DX.catalog && DX.catalog.id;
  const C = (path) => `${BASE}/catalogs/${cid()}${path}`;
  const short = (key) => (String(key).startsWith('dbo.') ? String(key).slice(4) : String(key));
  const tag = (kind, text, title) => h('span', { class: `dbx-tag ${kind}`, title: title || null }, text);
  const relTag = (r) => (r.kind === 'fk' ? tag('ok', r.disabled ? 'FK (desabilitada)' : 'FK', r.name) : tag('warn', `hipótese · ${r.confidence}`, (r.reasons || []).join('\n')));
  const pairsText = (pairs) => pairs.map(([s, d]) => `${s} = ${d}`).join(' AND ');
  const copy = async (text, what = 'Copiado.') => { try { await navigator.clipboard.writeText(text); toast(what, 'ok'); } catch { toast('Não foi possível copiar.', 'error'); } };
  // Como o busy() do app, mas preserva os ícones do botão.
  async function busy(btn, fn, working = 'Aguarde…') {
    const kids = [...btn.childNodes];
    btn.disabled = true; btn.textContent = working;
    try { return await fn(); } catch (e) { fail(e); } finally { btn.disabled = false; btn.replaceChildren(...kids); }
  }
  const tableLink = (key, extra) => h('button', { type: 'button', class: 'dbx-link', title: `Abrir ${key}`, onclick: () => openTable(key) }, short(key), extra || null);

  // fetch com cancelamento (Console/amostras longas). Erro igual ao api() do app.
  async function call(method, url, body, signal) {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal });
    const json = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(json.error || `Erro ${r.status}`), { code: json.code, status: r.status });
    return json;
  }
  // Estrutura saiu da memória do servidor (app reiniciado): volta para a barra.
  const lost = (e) => { if (e && e.code === 'DBX_NO_CATALOG') { DX.catalog = null; DX.overview = null; rerender(); } fail(e); };
  async function download(url, body, fallback) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Erro ${r.status}`);
    const cd = r.headers.get('Content-Disposition') || '';
    saveBlob(await r.blob(), decodeURIComponent((cd.match(/filename\*=UTF-8''([^;]+)/) || [])[1] || '') || fallback);
  }
  function saveBlob(blob, name) {
    const href = URL.createObjectURL(blob);
    const a = h('a', { href, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 5000);
  }

  let MAIN = null; let TOOL = null;
  const rerender = () => MAIN && render(MAIN, TOOL);

  async function render(main, tool) {
    MAIN = main; TOOL = tool;
    main.replaceChildren(h('div', { class: 'page' }, h('div', { class: 'empty' }, 'Carregando…')));
    try {
      const [s, conns, loaded] = await Promise.all([api('GET', `${BASE}/settings`), api('GET', '/api/connections'), api('GET', `${BASE}/catalogs`)]);
      DX.settings = s.settings; DX.defaults = s.defaults; DX.conns = conns;
      if (DX.console.limit === null) DX.console.limit = s.settings.queryLimit;
      if (DX.console.mask === null) DX.console.mask = s.settings.maskSensitive;
      if (!DX.connectionId || !conns.some((c) => c.id === DX.connectionId)) DX.connectionId = (conns.find((c) => c.env === 'local') || conns[0] || {}).id || null;
      if (DX.catalog && !loaded.some((c) => c.id === DX.catalog.id)) { DX.catalog = null; DX.overview = null; }
      if (!DX.catalog && loaded.length) await useCatalog(loaded[0]);
    } catch (e) { return fail(e); }
    if (route().name !== 'tools') return;
    const body = h('div', { class: 'dbx-body' });
    const tabs = [['overview', 'Visão geral'], ['tables', 'Tabelas'], ['map', 'Mapa relacional'], ['paths', 'Caminhos'], ['builder', 'Montador de consulta'], ['console', 'Console SQL'], ['settings', 'Configurações']];
    main.replaceChildren(h('div', { class: 'page dbx-page' },
      h('div', { class: 'page-head' }, h('div', { class: 'grow' },
        h('a', { class: 'link-quiet small', href: '#/tools' }, '← Ferramentas Auxiliares'),
        h('h1', null, tool.name),
        h('div', { class: 'muted' }, 'Entenda bancos de qualquer tamanho antes de escrever scripts: estrutura, relacionamentos reais e prováveis, caminhos de JOIN e dados de amostra. Somente leitura.'))),
      connectionBar(),
      h('nav', { class: 'tabs', role: 'tablist' }, tabs.map(([k, l]) => h('button', { class: `tab${DX.tab === k ? ' active' : ''}`, disabled: !DX.catalog && !['settings'].includes(k), onclick: () => { DX.tab = k; rerender(); } }, l))),
      h('datalist', { id: 'dbx-keys' }, DX.keys.map((k) => h('option', { value: k }))),
      body));
    if (DX.tab === 'settings') return renderSettings(body);
    if (!DX.catalog) return body.append(h('div', { class: 'card' }, h('div', { class: 'card-body dbx-start' },
      h('strong', null, 'Escolha a conexão e o banco e clique em “Carregar estrutura”.'),
      h('div', { class: 'muted small' }, 'Só os metadados (tabelas, colunas, chaves, índices e FKs) são lidos nesta etapa — nenhuma linha das tabelas. Bancos grandes (milhares de tabelas) levam alguns segundos.'))));
    const views = { overview: renderOverview, tables: renderTables, map: renderMap, paths: renderPaths, builder: renderBuilder, console: renderConsole };
    (views[DX.tab] || renderOverview)(body);
  }

  async function useCatalog(entry, overview = null) {
    DX.catalog = entry; DX.connectionId = entry.connectionId; DX.database = entry.database;
    DX.overview = overview || (await api('GET', `${BASE}/catalogs/${entry.id}/overview`)).overview;
    DX.keys = await api('GET', `${BASE}/catalogs/${entry.id}/keys`);
    DX.tables.items = []; DX.map.payload = null; DX.paths.result = null; DX.builder.result = null;
    if (!DX.map.center && DX.overview.connected[0]) DX.map.center = DX.overview.connected[0].key;
  }

  // ---------- Barra: conexão, banco, carregar, busca ----------
  function connectionBar() {
    const connSel = h('select', { 'aria-label': 'Conexão', onchange: (e) => { DX.connectionId = e.target.value; DX.dbs = null; DX.database = ''; rerender(); } },
      DX.conns.length ? DX.conns.map((c) => h('option', { value: c.id }, `${c.name} — ${c.envLabel} · ${c.server}${c.port ? ',' + c.port : ''}`)) : h('option', { value: '' }, 'Nenhuma conexão cadastrada'));
    if (DX.connectionId) connSel.value = DX.connectionId;
    const dbInput = h('input', { type: 'text', list: 'dbx-dbs', value: DX.database, placeholder: 'Banco (digite ou escolha)', 'aria-label': 'Banco', spellcheck: 'false', oninput: (e) => { DX.database = e.target.value.trim(); } });
    const dbList = h('datalist', { id: 'dbx-dbs' }, (DX.dbs || []).filter((d) => d.access && d.state === 'ONLINE').map((d) => h('option', { value: d.name }, d.system ? 'sistema' : '')));
    const listDbs = async () => {
      if (!DX.connectionId) return toast('Cadastre uma conexão em Configurações → Conexões.', 'error');
      const r = await api('POST', `${BASE}/databases`, { connectionId: DX.connectionId });
      DX.dbs = r.databases;
      if (!DX.database) DX.database = r.defaultDatabase || (r.databases.find((d) => !d.system && d.access) || {}).name || '';
      rerender();
    };
    const load = async () => {
      if (!DX.connectionId) return toast('Escolha uma conexão.', 'error');
      if (!DX.database) return toast('Informe o banco (ou clique em “Listar bancos”).', 'error');
      const r = await api('POST', `${BASE}/catalogs`, { connectionId: DX.connectionId, database: DX.database });
      await useCatalog(r.catalog, r.overview);
      if (DX.tab === 'settings') DX.tab = 'overview';
      toast(`${r.catalog.database}: ${plural(r.catalog.tables, 'tabela carregada', 'tabelas carregadas')} em ${(r.catalog.ms / 1000).toFixed(1)} s.`, 'ok');
      rerender();
    };
    const conn = DX.conns.find((c) => c.id === DX.connectionId);
    const status = DX.catalog ? h('div', { class: 'dbx-status' },
      h('span', { class: 'dbx-dbname' }, icon('layers', 14), DX.catalog.database),
      tag(DX.catalog.env === 'prod' ? 'bad' : DX.catalog.env === 'local' ? 'none' : 'info', DX.catalog.env === 'prod' ? 'PRODUÇÃO · somente leitura' : `${(DX.conns.find((c) => c.id === DX.catalog.connectionId) || {}).envLabel || DX.catalog.env}`),
      h('span', { class: 'muted small' }, `${DX.catalog.connectionName} · ${DX.catalog.server}${DX.catalog.identity ? ` · login ${DX.catalog.identity.login}` : ''} · carregado ${fmtDateTime(DX.catalog.loadedAt)}`),
      h('button', { class: 'btn ghost sm', title: 'Ler a estrutura de novo (tabelas novas, colunas alteradas…)', onclick: (e) => busy(e.currentTarget, async () => { DX.database = DX.catalog.database; DX.connectionId = DX.catalog.connectionId; await load(); }) }, icon('refresh', 14), ' Recarregar')) : null;
    return h('section', { class: 'card dbx-bar' },
      h('div', { class: 'dbx-bar-row' },
        h('div', { class: 'dbx-bar-conn' }, connSel, !DX.conns.length ? h('a', { class: 'btn', href: '#/settings' }, 'Cadastrar conexão') : null),
        h('div', { class: 'dbx-bar-db' }, dbInput, dbList, h('button', { class: 'btn', title: 'Lista os bancos do servidor a que este login tem acesso', onclick: (e) => busy(e.currentTarget, listDbs, 'Listando…') }, 'Listar bancos')),
        h('button', { class: 'btn primary', onclick: (e) => busy(e.currentTarget, load, 'Lendo estrutura…'), disabled: !conn }, 'Carregar estrutura'),
        DX.catalog ? globalSearch() : null),
      conn && conn.env === 'prod' && !DX.catalog ? h('div', { class: 'small dbx-warn' }, 'Conexão de PRODUÇÃO: o Explorador só lê (catálogo, amostras TOP e consultas SELECT com limite). Mesmo assim, evite perfis e consultas pesadas no horário de uso.') : null,
      status);
  }

  let SEARCH = null; // fecha a lista de resultados ao clicar fora (um só listener)
  document.addEventListener('click', (e) => { if (SEARCH && !SEARCH.wrap.contains(e.target)) SEARCH.close(); });
  function globalSearch() {
    const box = h('div', { class: 'dbx-search-results', hidden: true });
    let timer = null; let seq = 0;
    const close = () => { box.hidden = true; };
    const input = h('input', { type: 'text', class: 'dbx-search', placeholder: 'Buscar tabela, coluna, descrição ou FK…', 'aria-label': 'Busca global', spellcheck: 'false',
      oninput: (e) => { clearTimeout(timer); const v = e.target.value.trim(); if (v.length < 2) return close(); timer = setTimeout(() => run(v), 220); },
      onkeydown: (e) => { if (e.key === 'Escape') { close(); e.target.blur(); } },
      onfocus: () => { if (box.childElementCount) box.hidden = false; } });
    async function run(v) {
      const my = ++seq;
      let r; try { r = await api('GET', `${C('/search')}?q=${encodeURIComponent(v)}`); } catch (e) { return lost(e); }
      if (my !== seq) return;
      const group = (title, total, items) => (items.length ? h('div', { class: 'dbx-sr-group' }, h('div', { class: 'dbx-sr-title' }, `${title} · ${N(total)}`), items) : null);
      const item = (main, sub, onclick) => h('button', { type: 'button', class: 'dbx-sr-item', onclick: () => { close(); onclick(); } }, h('span', { class: 'mono' }, main), sub ? h('span', { class: 'muted small' }, sub) : null);
      box.replaceChildren(...[
        group('Tabelas', r.totals?.tables || 0, r.tables.slice(0, 12).map((t) => item(short(t.key), `${N(t.rows)} linhas${t.description ? ` · ${t.description}` : ''}`, () => openTable(t.key)))),
        group('Colunas', r.totals?.columns || 0, r.columns.slice(0, 20).map((c) => item(`${short(c.table)}.${c.column}`, [c.type, c.pk && 'PK', c.fk && 'FK', c.sensitive && 'sensível'].filter(Boolean).join(' · '), () => openTable(c.table, { column: c.column })))),
        group('Relacionamentos', r.totals?.relationships || 0, r.relationships.slice(0, 8).map((x) => item(`${short(x.from)} → ${short(x.to)}`, `${x.kind === 'fk' ? x.name : 'hipótese'} · ${pairsText(x.pairs)}`, () => openTable(x.from)))),
      ].filter(Boolean));
      if (!box.childElementCount) box.append(h('div', { class: 'empty' }, 'Nada encontrado.'));
      box.hidden = false;
    }
    const wrap = h('div', { class: 'dbx-search-wrap' }, icon('search', 14), input, box);
    SEARCH = { wrap, close };
    return wrap;
  }

  // ---------- Visão geral ----------
  function renderOverview(host) {
    const o = DX.overview; const c = o.counts;
    const kpi = (label, value, sub, tone, onclick, title) => h(onclick ? 'button' : 'div', { class: `kpi${tone ? ` ${tone}` : ''}`, type: onclick ? 'button' : null, title: title || null, onclick: onclick || null },
      h('span', { class: 'kpi-l' }, label), h('span', { class: 'kpi-v' }, value), sub ? h('span', { class: 'kpi-s' }, sub) : null);
    const goTables = (filter) => () => { DX.tables.filter = filter; DX.tables.items = []; DX.tab = 'tables'; rerender(); };
    const max = Math.max(1, ...o.largest.map((t) => t.rows));
    const card = (title, sub, ...content) => h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('div', { class: 'grow' }, h('h2', null, title), sub ? h('div', { class: 'muted small' }, sub) : null)), h('div', { class: 'card-body' }, ...content));
    const chips = (keys, more) => h('div', { class: 'dbx-chips' }, keys.map((k) => tableLink(k)), more ? h('span', { class: 'muted small' }, more) : null);
    const inferScore = h('select', { 'aria-label': 'Pontuação mínima' }, [40, 55, 70, 80].map((v) => h('option', { value: v, selected: v === DX.settings.inferMinScore }, `mínimo ${v}`)));
    host.append(
      h('div', { class: 'dbx-kpis' },
        kpi('Tabelas', N(c.tables), `${plural(c.schemas, 'schema', 'schemas')} · ${N(c.views)} views · ${N(c.procedures)} procedures`, 'info', goTables('all')),
        kpi('Colunas', N(c.columns), `${N(c.sensitiveColumns)} com nome sensível`, '', null),
        kpi('Linhas (aprox.)', N(c.rows), 'pelas estatísticas do SQL Server', '', null),
        kpi('FKs reais', N(c.fks), `${N(c.inferred)} hipóteses`, c.fks ? 'ok' : 'warn', null, 'Relacionamentos declarados no banco (FKs) e prováveis (hipóteses)'),
        kpi('Sem chave primária', N(c.noPk), 'difícil de relacionar/deduplicar', c.noPk ? 'warn' : 'ok', goTables('noPk')),
        kpi('Isoladas', N(c.isolated), 'sem nenhuma FK', c.isolated ? 'warn' : 'ok', goTables('isolated')),
        kpi('Vazias', N(c.empty), '0 linhas', '', goTables('empty'))),
      h('div', { class: 'dbx-grid2' },
        card('Maiores tabelas', 'Linhas aproximadas', h('div', { class: 'dbx-bars' }, o.largest.map((t) => h('div', { class: 'dbx-barrow' }, tableLink(t.key), h('div', { class: 'dbx-barline' }, h('div', { style: `width:${Math.max(2, (t.rows / max) * 100)}%` })), h('span', { class: 'num' }, N(t.rows)))))),
        card('Mais conectadas', `Tabelas centrais do modelo · “hub” a partir de ${o.hubThreshold} ligações`, o.connected.length ? h('div', { class: 'dbx-list' }, o.connected.map((t) => h('div', { class: 'dbx-li' }, tableLink(t.key), t.hub ? tag('info', 'hub', 'Liga muitas tabelas: o mapa e os caminhos podem evitá-la') : null, h('span', { class: 'muted small' }, `${t.degree} ligações · ${N(t.rows)} linhas`),
          h('button', { class: 'btn ghost sm', title: 'Ver no mapa', onclick: () => showOnMap(t.key) }, icon('grid', 13)))))
          : h('div', { class: 'empty' }, 'Nenhuma FK declarada. Veja as hipóteses ao lado ou use a busca.')),
        card('Possíveis tabelas ponte', 'Ligam duas ou mais tabelas (N:N, movimentos, vínculos) — costumam ser o caminho dos JOINs', o.bridges.length ? h('div', { class: 'dbx-list' }, o.bridges.map((t) => h('div', { class: 'dbx-li' }, tableLink(t.key), h('span', { class: 'muted small' }, `${t.fkOut} FKs de saída · pontuação ${t.score}`)))) : h('div', { class: 'empty' }, 'Nenhuma encontrada.')),
        card('Hipóteses de relacionamento', o.inferredAt ? `Geradas pelos metadados (chave primária × colunas de mesmo nome/padrão), sem ler dados` : '',
          h('div', { class: 'small' }, `${N(c.inferred)} hipótese(s) com pontuação ≥ ${DX.settings.inferMinScore}. Elas ligam tabelas sem FK declarada (comum em sistemas legados e no RM) e aparecem tracejadas no mapa. Confira no banco antes de usar (painel da tabela → Relacionamentos → Conferir).`),
          h('div', { class: 'inline' }, inferScore, h('button', { class: 'btn sm', onclick: (e) => busy(e.currentTarget, async () => {
            const r = await api('POST', C('/infer'), { minScore: Number(inferScore.value) });
            DX.overview = r.overview; DX.settings.inferMinScore = r.minScore; toast(`${N(r.count)} hipótese(s)${r.truncated ? ` (limitado de ${N(r.total)})` : ''}.`, 'ok'); rerender();
          }) }, 'Recalcular'))),
        card('Colunas recorrentes', 'Mesmo nome em várias tabelas — pistas de JOIN implícito e de chaves de empresa/filial', h('div', { class: 'dbx-chips' }, o.recurring.map((r) => h('button', { type: 'button', class: 'dbx-chip', title: 'Buscar tabelas com esta coluna', onclick: () => { DX.tables.q = r.column; DX.tables.filter = 'all'; DX.tables.items = []; DX.tab = 'tables'; rerender(); } }, h('span', { class: 'mono' }, r.column), h('span', { class: 'dbx-chip-n' }, N(r.tables)))))),
        card('Mais relevantes para migração', 'Ranking heurístico: chaves, ligações, volume e colunas de negócio (CPF, código, matrícula…)', h('div', { class: 'dbx-list' }, o.relevant.map((t) => h('div', { class: 'dbx-li' }, tableLink(t.key), h('span', { class: 'muted small' }, `pontuação ${t.score}`))))),
        c.noPk ? card('Sem chave primária', `${N(c.noPk)} tabela(s)`, chips(o.noPkSample, c.noPk > o.noPkSample.length ? `+ ${N(c.noPk - o.noPkSample.length)}` : '')) : null,
        c.isolated ? card('Isoladas (sem FK)', `${N(c.isolated)} tabela(s) — veja se há hipóteses para elas`, chips(o.isolatedSample, c.isolated > o.isolatedSample.length ? `+ ${N(c.isolated - o.isolatedSample.length)}` : '')) : null,
        card('Schemas e tipos de dados', '', h('div', { class: 'dbx-chips' }, o.schemas.map((s) => h('span', { class: 'dbx-chip' }, h('span', { class: 'mono' }, s.schema), h('span', { class: 'dbx-chip-n' }, N(s.tables))))),
          h('div', { class: 'dbx-chips' }, o.types.map((t) => h('span', { class: 'dbx-chip muted' }, h('span', { class: 'mono' }, t.type), h('span', { class: 'dbx-chip-n' }, N(t.columns))))))),
      h('div', { class: 'inline dbx-export' }, h('span', { class: 'muted small' }, 'Dicionário de dados do banco inteiro:'),
        ['xlsx', 'md', 'json'].map((f) => h('button', { class: 'btn sm', onclick: (e) => busy(e.currentTarget, () => download(C('/export'), { format: f }, `dicionario.${f}`)) }, icon('download', 13), ` ${f === 'md' ? 'Markdown' : f.toUpperCase()}`))));
  }

  // ---------- Tabelas ----------
  function renderTables(host) {
    const T = DX.tables;
    const list = h('div', { class: 'dbx-tablelist' });
    const count = h('span', { class: 'muted small' });
    const schemas = DX.overview.schemas;
    const load = async (more = false) => {
      try {
        const r = await api('GET', `${C('/tables')}?q=${encodeURIComponent(T.q)}&schema=${encodeURIComponent(T.schema)}&filter=${T.filter}&sort=${T.sort}&limit=200&offset=${more ? T.items.length : 0}`);
        T.items = more ? [...T.items, ...r.items] : r.items; T.total = r.total; draw();
      } catch (e) { lost(e); }
    };
    let timer = null;
    const search = h('input', { type: 'text', value: T.q, placeholder: 'Filtrar por nome, descrição ou coluna exata…', 'aria-label': 'Filtrar tabelas', spellcheck: 'false', oninput: (e) => { T.q = e.target.value; clearTimeout(timer); timer = setTimeout(() => load(), 200); } });
    const sel = (value, opts, on, label) => { const s = h('select', { 'aria-label': label, onchange: (e) => { on(e.target.value); load(); } }, opts.map(([v, l]) => h('option', { value: v }, l))); s.value = value; return s; };
    const flag = (cond, kind, text, title) => (cond ? tag(kind, text, title) : null);
    function draw() {
      count.textContent = `${N(T.items.length)} de ${N(T.total)}`;
      if (!T.items.length) { list.replaceChildren(h('div', { class: 'empty' }, 'Nenhuma tabela com estes filtros.')); return; }
      list.replaceChildren(h('div', { class: 'dbx-scroll' }, h('table', { class: 'compact dbx-table' },
        h('thead', null, h('tr', null, ['Tabela', 'Linhas', 'Colunas', 'Chave primária', 'FK saída', 'FK entrada', 'Hipóteses', 'Relev.', ''].map((x) => h('th', null, x)))),
        h('tbody', null, T.items.map((t) => h('tr', { class: 'dbx-row', onclick: () => openTable(t.key) },
          h('td', null, h('div', { class: 'dbx-tname' }, h('span', { class: 'mono' }, short(t.key)), t.description ? h('span', { class: 'muted small' }, t.description) : null)),
          h('td', { class: 'num' }, N(t.rows)), h('td', { class: 'num' }, N(t.columns)),
          h('td', { class: 'mono small' }, t.pk.length ? t.pk.join(', ') : h('span', { class: 'dbx-bad' }, 'sem PK')),
          h('td', { class: 'num' }, t.fkOut || ''), h('td', { class: 'num' }, t.fkIn || ''), h('td', { class: 'num' }, t.inferred || ''),
          h('td', { class: 'num' }, t.relevance),
          h('td', null, h('div', { class: 'inline' }, flag(t.noted, 'info', 'anotação'), flag(t.sensitive, 'warn', 'sensível', `${t.sensitive} coluna(s) com nome sensível`), flag(!t.degree && !t.inferred, 'none', 'isolada')))))))),
      T.items.length < T.total ? h('div', { class: 'inline' }, h('button', { class: 'btn sm', onclick: () => load(true) }, `Mostrar mais (${N(T.total - T.items.length)})`)) : null);
    }
    host.append(h('section', { class: 'card' },
      h('div', { class: 'card-head dbx-filters' }, search,
        sel(T.schema, [['', 'Todos os schemas'], ...schemas.map((s) => [s.schema, `${s.schema} (${s.tables})`])], (v) => { T.schema = v; }, 'Schema'),
        sel(T.filter, [['all', 'Todas'], ['noPk', 'Sem chave primária'], ['isolated', 'Isoladas (sem FK)'], ['empty', 'Vazias'], ['inferred', 'Com hipóteses'], ['sensitive', 'Com colunas sensíveis'], ['noted', 'Com anotação']], (v) => { T.filter = v; }, 'Filtro'),
        sel(T.sort, [['relevance', 'Mais relevantes'], ['rows', 'Mais linhas'], ['degree', 'Mais conectadas'], ['columns', 'Mais colunas'], ['name', 'Nome']], (v) => { T.sort = v; }, 'Ordem'),
        count,
        h('button', { class: 'btn sm', title: 'Exportar o dicionário só das tabelas filtradas (até 20.000)', onclick: (e) => busy(e.currentTarget, async () => {
          const r = await api('GET', `${C('/tables')}?q=${encodeURIComponent(T.q)}&schema=${encodeURIComponent(T.schema)}&filter=${T.filter}&sort=${T.sort}&limit=1000`);
          let keys = r.items.map((x) => x.key);
          for (let off = 1000; off < Math.min(r.total, 20000); off += 1000) keys = keys.concat((await api('GET', `${C('/tables')}?q=${encodeURIComponent(T.q)}&schema=${encodeURIComponent(T.schema)}&filter=${T.filter}&sort=${T.sort}&limit=1000&offset=${off}`)).items.map((x) => x.key));
          await download(C('/export'), { format: 'xlsx', tables: keys }, 'dicionario.xlsx');
        }) }, icon('download', 13), ' Excel do filtro')),
      h('div', { class: 'card-body' }, list)));
    if (T.items.length) draw(); else load();
  }

  // ---------- Painel lateral da tabela ----------
  let DRAWER = null;
  async function openTable(key, { column = null, tab = 'columns' } = {}) {
    let d;
    try { d = await api('GET', `${C('/table')}?key=${encodeURIComponent(key)}`); } catch (e) { return lost(e); }
    if (DRAWER) DRAWER.close();
    const overlay = h('div', { class: 'dbx-drawer-overlay', onclick: (e) => { if (e.target === overlay) close(); } });
    const close = () => { overlay.remove(); document.removeEventListener('keydown', esc); DRAWER = null; };
    const esc = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', esc);
    const body = h('div', { class: 'dbx-drawer-body' });
    const tabs = [['columns', `Colunas (${d.columns.length})`], ['rels', `Relacionamentos (${d.relationships.length})`], ['sample', 'Amostra'], ['profile', 'Perfil'], ['note', d.note ? 'Anotação •' : 'Anotação']];
    let cur = tab;
    const nav = h('nav', { class: 'tabs sm' });
    const drawTabs = () => nav.replaceChildren(...tabs.map(([k, l]) => h('button', { class: `tab${cur === k ? ' active' : ''}`, onclick: () => { cur = k; drawTabs(); show(); } }, l)));
    const show = () => { body.replaceChildren(); ({ columns: drawerColumns, rels: drawerRels, sample: drawerSample, profile: drawerProfile, note: drawerNote })[cur](body, d, { column, close }); };
    const act = (label, ico, fn, title) => h('button', { class: 'btn sm', title: title || null, onclick: () => { close(); fn(); } }, icon(ico, 13), ` ${label}`);
    const panel = h('aside', { class: 'dbx-drawer', role: 'dialog', 'aria-label': `Tabela ${d.key}` },
      h('div', { class: 'dbx-drawer-head' },
        h('div', { class: 'grow' }, h('div', { class: 'muted small' }, d.schema), h('h2', { class: 'mono' }, d.name),
          h('div', { class: 'muted small' }, `${N(d.rows)} linhas (aprox.) · ${d.columns.length} colunas · PK: ${d.pk.length ? d.pk.join(', ') : 'nenhuma'} · ${d.fkOut} FK saída · ${d.fkIn} FK entrada${d.inferred ? ` · ${d.inferred} hipótese(s)` : ''}`),
          d.description ? h('div', { class: 'small dbx-desc' }, d.description) : null),
        h('button', { class: 'btn ghost', 'aria-label': 'Fechar', onclick: close }, '✕')),
      h('div', { class: 'dbx-drawer-actions' },
        act('Ver no mapa', 'grid', () => showOnMap(d.key)),
        act('Montador', 'plus', () => { if (!DX.builder.tables.includes(d.key)) DX.builder.tables.push(d.key); DX.builder.result = null; DX.tab = 'builder'; rerender(); }, 'Adicionar ao montador de consulta'),
        act('Caminho daqui', 'arrowRight', () => { DX.paths.from = d.key; DX.paths.result = null; DX.tab = 'paths'; rerender(); }),
        act('Console', 'code', () => { DX.console.sql = d.selectSql; DX.tab = 'console'; rerender(); }, 'Abrir um SELECT desta tabela no Console SQL'),
        h('button', { class: 'btn sm', onclick: () => copy(d.selectSql, 'SELECT copiado.') }, icon('copy', 13), ' Copiar SELECT')),
      nav, body);
    overlay.append(panel); document.body.append(overlay);
    DRAWER = { close };
    drawTabs(); show();
  }

  function drawerColumns(host, d, { column }) {
    const flags = (c) => [c.pk && tag('ok', 'PK'), c.fk && tag('info', 'FK'), c.referenced && tag('none', 'referenciada', 'Outras tabelas apontam para esta coluna'), c.identity && tag('none', 'identity'), c.computed && tag('none', 'calculada'), c.sensitive && tag('warn', 'sensível')].filter(Boolean);
    host.append(h('div', { class: 'dbx-scroll' }, h('table', { class: 'compact' },
      h('thead', null, h('tr', null, ['#', 'Coluna', 'Tipo', 'Nulo', '', 'Classificação'].map((x) => h('th', null, x)))),
      h('tbody', null, d.columns.map((c, i) => h('tr', { class: column && column.toLowerCase() === c.name.toLowerCase() ? 'dbx-hit' : null },
        h('td', { class: 'num muted' }, i + 1),
        h('td', null, h('div', { class: 'dbx-tname' }, h('span', { class: 'mono' }, c.name), c.description ? h('span', { class: 'muted small' }, c.description) : null)),
        h('td', { class: 'mono small' }, c.type), h('td', { class: 'small' }, c.nullable ? 'sim' : 'não'),
        h('td', null, h('div', { class: 'inline' }, flags(c))), h('td', { class: 'small muted' }, c.classification)))))),
    d.indexes.length ? h('details', { class: 'dbx-details' }, h('summary', null, `Índices (${d.indexes.length})`),
      h('ul', { class: 'dbx-ul' }, d.indexes.map((ix) => h('li', null, h('span', { class: 'mono' }, ix.name || '(heap)'), ` — ${ix.cols.join(', ')}`, ix.pk ? ' · PK' : ix.unique ? ' · único' : '')))) : null);
    setTimeout(() => host.querySelector('.dbx-hit')?.scrollIntoView({ block: 'center' }), 50);
  }

  function relRow(r, perspective, onCheck) {
    const other = r.direction === 'out' ? r.to : r.from;
    return h('div', { class: `dbx-rel ${r.kind}` },
      h('div', { class: 'dbx-rel-top' }, relTag(r), h('span', { class: 'muted small' }, r.direction === 'out' ? 'aponta para' : r.direction === 'in' ? 'é apontada por' : 'auto-relacionamento'), tableLink(other)),
      h('div', { class: 'mono small' }, r.direction === 'in' ? r.pairs.map(([s, dd]) => `${short(r.from)}.${s} = ${dd}`).join(' AND ') : r.pairs.map(([s, dd]) => `${s} = ${short(r.to)}.${dd}`).join(' AND ')),
      r.kind === 'inferred' && r.reasons ? h('div', { class: 'muted small' }, r.reasons.join(' · ')) : r.untrusted ? h('div', { class: 'muted small' }, 'FK não confiável (WITH NOCHECK): pode haver registros órfãos.') : null,
      h('div', { class: 'inline' }, h('button', { class: 'btn ghost sm', title: 'Conta, numa amostra da origem, quantos registros encontram par no destino', onclick: (e) => busy(e.currentTarget, () => onCheck(r), 'Conferindo…') }, 'Conferir no banco'),
        h('button', { class: 'btn ghost sm', onclick: () => copy(`SELECT TOP (100) a.*, b.*\nFROM ${sqlName(r.from)} AS a\nJOIN ${sqlName(r.to)} AS b\n  ON ${r.pairs.map(([s, dd]) => `a.[${s}] = b.[${dd}]`).join('\n AND ')};`, 'JOIN copiado.') }, 'Copiar JOIN')),
      h('div', { class: 'dbx-check-out' }));
  }
  const sqlName = (key) => { const i = key.indexOf('.'); return `[${key.slice(0, i).replace(/]/g, ']]')}].[${key.slice(i + 1).replace(/]/g, ']]')}]`; };
  async function checkRel(r, outEl) {
    const x = await api('POST', C('/check'), { relId: r.id });
    const tone = x.matchPct === null ? 'none' : x.matchPct >= 98 ? 'ok' : x.matchPct >= 80 ? 'warn' : 'bad';
    outEl.replaceChildren(h('div', { class: `dbx-check ${tone}` },
      h('strong', null, x.sampled ? `${x.matchPct}% com par` : 'Origem sem valores preenchidos'),
      h('span', { class: 'small muted' }, ` — ${N(x.matched)} de ${N(x.sampled)} linha(s) da amostra (até ${N(x.sampleLimit)}) · ${N(x.orphans)} órfã(s) · ${x.ms} ms`),
      x.topOrphans.rows.length ? h('div', { class: 'small' }, 'Valores sem par mais frequentes: ', h('span', { class: 'mono' }, x.topOrphans.rows.map((row) => `${row.slice(0, -1).join(' / ')} (${row[row.length - 1]})`).join(' · '))) : null));
  }
  function drawerRels(host, d) {
    if (!d.relationships.length) { host.append(h('div', { class: 'empty' }, 'Nenhuma FK nem hipótese para esta tabela. Procure colunas com o mesmo nome em outras tabelas pela busca global.')); return; }
    const groups = [['FKs declaradas', d.relationships.filter((r) => r.kind === 'fk')], ['Hipóteses (inferidas — conferir)', d.relationships.filter((r) => r.kind === 'inferred')]];
    for (const [title, list] of groups) if (list.length) host.append(h('div', { class: 'dbx-label' }, `${title} · ${list.length}`), ...list.map((r) => { const row = relRow(r, d.key, (rel) => checkRel(rel, row.querySelector('.dbx-check-out')).catch(lost)); return row; }));
  }

  function resultGrid(r, { maxHeight = null } = {}) {
    if (!r.columns.length) return h('div', { class: 'empty' }, 'A consulta não devolveu colunas.');
    const masked = new Set(r.masked || []);
    return h('div', { class: 'dbx-scroll dbx-grid', style: maxHeight ? `max-height:${maxHeight}` : null }, h('table', { class: 'compact' },
      h('thead', null, h('tr', null, h('th', { class: 'num' }, '#'), r.columns.map((c) => h('th', { title: masked.has(c) ? 'Mascarada (nome sensível)' : null }, c, masked.has(c) ? ' 🔒' : '')))),
      h('tbody', null, r.rows.map((row, i) => h('tr', null, h('td', { class: 'num muted' }, i + 1), row.map((v) => h('td', { class: v === null ? 'dbx-null' : typeof v === 'number' ? 'num' : null, title: typeof v === 'string' && v.length > 60 ? v : null }, v === null ? 'NULL' : String(v))))))));
  }
  function drawerSample(host, d) {
    const out = h('div');
    const limit = h('select', { 'aria-label': 'Linhas' }, [10, 50, 100, 500, 1000].map((v) => h('option', { value: v, selected: v === DX.settings.sampleRows }, `${v} linhas`)));
    const mask = h('input', { type: 'checkbox', checked: DX.settings.maskSensitive });
    const go = async () => {
      const r = await api('POST', C('/sample'), { key: d.key, limit: Number(limit.value), mask: mask.checked });
      out.replaceChildren(h('div', { class: 'muted small' }, `${N(r.rows.length)} linha(s) em ${r.ms} ms${r.masked.length ? ` · mascaradas: ${r.masked.join(', ')}` : ''} · TOP sem ORDER BY (ordem não garantida)`), resultGrid(r, { maxHeight: '58vh' }));
    };
    host.append(h('div', { class: 'inline' }, limit, h('label', { class: 'check' }, mask, ' Mascarar sensíveis'), h('button', { class: 'btn primary sm', onclick: (e) => busy(e.currentTarget, () => go().catch(lost), 'Lendo…') }, 'Ler amostra')), out);
  }
  function drawerProfile(host, d) {
    const out = h('div');
    const rows = h('select', { 'aria-label': 'Amostra' }, [10000, 50000, 200000, 1000000].map((v) => h('option', { value: v, selected: v === DX.settings.profileRows }, `até ${N(v)} linhas`)));
    const go = async () => {
      const r = await api('POST', C('/profile'), { key: d.key, sampleRows: Number(rows.value) });
      out.replaceChildren(h('div', { class: 'muted small' }, `Calculado sobre ${N(r.sampled)} linha(s)${r.totalRows > r.sampled ? ` de ~${N(r.totalRows)}` : ''} em ${r.ms} ms.`),
        h('div', { class: 'dbx-scroll' }, h('table', { class: 'compact' },
          h('thead', null, h('tr', null, ['Coluna', 'Preenchido', 'Nulos', 'Distintos', 'Mín.', 'Máx.', 'Tamanho'].map((x) => h('th', null, x)))),
          h('tbody', null, r.columns.map((c) => h('tr', null, h('td', { class: 'mono' }, c.name),
            h('td', null, c.filledPct === null ? '—' : h('div', { class: 'dbx-fill' }, h('div', { class: 'dbx-barline' }, h('div', { style: `width:${c.filledPct}%` })), h('span', { class: 'num small' }, `${c.filledPct}%`))),
            h('td', { class: 'num' }, N(c.nulls)), h('td', { class: 'num' }, c.distinct === null ? '—' : N(c.distinct)),
            h('td', { class: 'small mono' }, c.min ?? ''), h('td', { class: 'small mono' }, c.max ?? ''),
            h('td', { class: 'small num' }, c.minLen === null ? '' : `${c.minLen}–${c.maxLen}`)))))));
    };
    host.append(h('div', { class: 'small muted' }, 'Preenchimento, distintos e faixas por coluna. Em tabelas grandes o cálculo usa só as primeiras linhas lidas (amostra).'),
      h('div', { class: 'inline' }, rows, h('button', { class: 'btn primary sm', onclick: (e) => busy(e.currentTarget, () => go().catch(lost), 'Calculando…') }, 'Calcular perfil')), out);
  }
  function drawerNote(host, d) {
    const ta = h('textarea', { rows: 8, placeholder: 'O que esta tabela guarda, regras, armadilhas, de-para… (fica só neste computador, por conexão e banco)', value: d.note?.text || '' });
    host.append(ta, h('div', { class: 'inline' },
      h('button', { class: 'btn primary sm', onclick: (e) => busy(e.currentTarget, async () => { const r = await api('PUT', C('/notes'), { key: d.key, text: ta.value }); d.note = r.note; toast(r.note ? 'Anotação salva.' : 'Anotação removida.', 'ok'); }) }, 'Salvar'),
      d.note ? h('span', { class: 'muted small' }, `por ${d.note.by} em ${fmtDateTime(d.note.at)}`) : null));
  }

  // ---------- Mapa relacional ----------
  function showOnMap(key) { DX.map.mode = 'center'; DX.map.center = key; DX.map.payload = null; DX.map.selected = key; DX.tab = 'map'; rerender(); }

  function renderMap(host) {
    const M = DX.map;
    const canvas = h('div', { class: 'dbx-canvas' });
    const side = h('aside', { class: 'dbx-side card' });
    const info = h('span', { class: 'muted small' });
    const picker = (value, on, ph) => h('input', { type: 'text', list: 'dbx-keys', value, placeholder: ph, spellcheck: 'false', onchange: (e) => on(e.target.value.trim()) });
    const mode = h('select', { 'aria-label': 'Recorte', onchange: (e) => { M.mode = e.target.value; drawControls(); } },
      [['center', 'Tabela central'], ['selection', 'Tabelas escolhidas'], ['panorama', 'Panorama (mais conectadas)']].map(([v, l]) => h('option', { value: v }, l)));
    mode.value = M.mode;
    const ctl = h('div', { class: 'dbx-map-ctl' });
    const chk = (label, k, title) => h('label', { class: 'check', title: title || null }, h('input', { type: 'checkbox', checked: M[k], onchange: (e) => { M[k] = e.target.checked; } }), ` ${label}`);
    function drawControls() {
      const parts = [mode];
      if (M.mode === 'center') {
        parts.push(picker(M.center, (v) => { M.center = v; }, 'Tabela central (ex.: dbo.PFUNC)'),
          (() => { const s = h('select', { 'aria-label': 'Profundidade', onchange: (e) => { M.depth = Number(e.target.value); } }, [1, 2, 3].map((v) => h('option', { value: v }, `${v} nível${v > 1 ? 'is' : ''}`))); s.value = M.depth; return s; })(),
          (() => { const s = h('select', { 'aria-label': 'Direção', onchange: (e) => { M.direction = e.target.value; } }, [['both', 'Entrada e saída'], ['out', 'Só o que ela referencia'], ['in', 'Só quem a referencia']].map(([v, l]) => h('option', { value: v }, l))); s.value = M.direction; return s; })());
      } else if (M.mode === 'selection') {
        const add = picker('', (v) => { if (v && !M.selection.includes(v)) M.selection.push(v); drawControls(); }, 'Adicionar tabela…');
        parts.push(add, h('div', { class: 'dbx-chips' }, M.selection.map((k) => h('span', { class: 'dbx-chip' }, h('span', { class: 'mono' }, short(k)), h('button', { class: 'dbx-x', 'aria-label': `Tirar ${k}`, onclick: () => { M.selection = M.selection.filter((x) => x !== k); drawControls(); } }, '×')))));
      } else {
        const s = h('select', { 'aria-label': 'Schema', onchange: (e) => { M.schema = e.target.value; } }, [['', 'Todos os schemas'], ...DX.overview.schemas.map((x) => [x.schema, x.schema])].map(([v, l]) => h('option', { value: v }, l)));
        s.value = M.schema; parts.push(s);
      }
      parts.push(chk('Hipóteses', 'includeInferred', 'Mostrar também relacionamentos inferidos (tracejados)'), chk('Evitar hubs', 'avoidHubs', 'Não expandir tabelas que ligam muitas outras (ex.: empresa/coligada)'),
        h('button', { class: 'btn primary', onclick: (e) => busy(e.currentTarget, () => load(), 'Montando…') }, 'Mostrar'));
      ctl.replaceChildren(...parts);
    }
    async function load() {
      const body = { mode: M.mode, center: M.center, depth: M.depth, direction: M.direction, includeInferred: M.includeInferred, avoidHubs: M.avoidHubs, tables: M.selection, schema: M.schema, maxNodes: DX.settings.maxNodes };
      if (M.mode === 'center' && !M.center) return toast('Escolha a tabela central.', 'error');
      if (M.mode === 'selection' && !M.selection.length) return toast('Adicione ao menos uma tabela.', 'error');
      try { M.payload = await api('POST', C('/graph'), body); } catch (e) { return lost(e); }
      M.layout = null;
      draw();
    }
    let view = null;
    function draw() {
      const p = M.payload;
      if (!p) { canvas.replaceChildren(h('div', { class: 'empty dbx-canvas-empty' }, 'Escolha um recorte e clique em “Mostrar”. Comece por uma tabela central: o mapa nunca desenha o banco inteiro de uma vez.')); return; }
      info.textContent = `${plural(p.nodes.length, 'tabela', 'tabelas')} · ${plural(p.edges.length, 'ligação', 'ligações')}${p.truncated ? ` · limitado a ${DX.settings.maxNodes} (Configurações)` : ''}${p.hidden?.length ? ` · ${p.hidden.length} hub(s) não expandidos` : ''}`;
      view = graphView(p, {
        selected: M.selected, positions: M.layout,
        onSelect: (key) => { M.selected = key; drawSide(); },
        onOpen: (key) => openTable(key),
        onExpand: (key) => { M.mode = 'center'; M.center = key; mode.value = 'center'; drawControls(); load(); },
        onLayout: (pos) => { M.layout = pos; },
      });
      canvas.replaceChildren(view.el);
      requestAnimationFrame(() => view.fit());
      drawSide();
    }
    async function drawSide() {
      const p = M.payload;
      if (!p) { side.replaceChildren(h('div', { class: 'card-body' }, legend())); return; }
      const key = M.selected && p.nodes.some((n) => n.key === M.selected) ? M.selected : null;
      if (!key) { side.replaceChildren(h('div', { class: 'card-body' }, h('div', { class: 'small muted' }, 'Clique numa tabela para ver as ligações. Duplo clique: centralizar nela. Arraste para mover; roda do mouse: zoom.'), legend(), hiddenHubs(p))); return; }
      const n = p.nodes.find((x) => x.key === key);
      const rels = p.edges.filter((e) => e.from === key || e.to === key);
      side.replaceChildren(h('div', { class: 'card-body' },
        h('div', null, h('div', { class: 'muted small' }, n.schema), h('strong', { class: 'mono' }, n.name)),
        h('div', { class: 'muted small' }, `${N(n.rows)} linhas · ${n.columns} colunas · PK: ${n.pk.length ? n.pk.join(', ') : 'nenhuma'} · ${n.degree} ligações no banco`),
        h('div', { class: 'inline' },
          h('button', { class: 'btn sm primary', onclick: () => openTable(key) }, 'Detalhes'),
          h('button', { class: 'btn sm', onclick: () => { M.mode = 'center'; M.center = key; mode.value = 'center'; drawControls(); load(); } }, 'Centralizar'),
          h('button', { class: 'btn sm', onclick: () => { if (!DX.builder.tables.includes(key)) DX.builder.tables.push(key); DX.builder.result = null; toast(`${short(key)} no montador (${DX.builder.tables.length}).`, 'ok'); } }, '+ Montador')),
        h('div', { class: 'dbx-label' }, `Ligações neste recorte · ${rels.length}`),
        h('div', { class: 'dbx-side-rels' }, rels.map((r) => h('div', { class: `dbx-rel ${r.kind}` },
          h('div', { class: 'dbx-rel-top' }, relTag(r), h('span', { class: 'muted small' }, r.from === key ? '→' : '←'), tableLink(r.from === key ? r.to : r.from)),
          h('div', { class: 'mono small' }, pairsText(r.pairs)))))));
    }
    const legend = () => h('div', { class: 'dbx-legend' },
      h('div', null, h('span', { class: 'dbx-lg-line fk' }), ' FK declarada'), h('div', null, h('span', { class: 'dbx-lg-line inf' }), ' Hipótese (inferida)'),
      h('div', null, h('span', { class: 'dbx-lg-node center' }), ' Tabela central / escolhida'), h('div', null, h('span', { class: 'dbx-lg-node' }), ' Tamanho do texto = volume de linhas'));
    const hiddenHubs = (p) => (p.hidden?.length ? h('div', { class: 'small muted' }, 'Hubs vistos mas não expandidos: ', p.hidden.map((k) => short(k)).join(', ')) : null);
    host.append(
      h('section', { class: 'card' }, h('div', { class: 'card-body' }, ctl,
        h('div', { class: 'inline' }, info, h('span', { style: 'flex:1' }),
          h('button', { class: 'btn ghost sm', title: 'Ajustar à tela', onclick: () => view && view.fit() }, 'Ajustar'),
          h('button', { class: 'btn ghost sm', title: 'Recalcular a posição das tabelas', onclick: () => { M.layout = null; view && draw(); } }, 'Reorganizar'),
          h('button', { class: 'btn ghost sm', title: 'Baixar a imagem do mapa (SVG)', onclick: () => view && saveBlob(new Blob([view.svgText()], { type: 'image/svg+xml' }), `mapa_${DX.catalog.database}.svg`) }, icon('download', 13), ' SVG'),
          h('button', { class: 'btn ghost sm', title: 'Dicionário (Excel) só das tabelas do mapa', onclick: (e) => M.payload && busy(e.currentTarget, () => download(C('/export'), { format: 'xlsx', tables: M.payload.nodes.map((n) => n.key) }, 'dicionario.xlsx')) }, icon('download', 13), ' Excel do recorte')))),
      h('div', { class: 'dbx-map' }, canvas, side));
    drawControls();
    if (M.payload) draw(); else if (M.center && M.mode === 'center') load(); else draw();
  }

  // Grafo em SVG: layout por força (Fruchterman-Reingold) com sementes por camada, zoom/pan, arrastar e foco na vizinhança.
  function graphView(payload, { selected, positions, onSelect, onOpen, onExpand, onLayout }) {
    const NS = 'http://www.w3.org/2000/svg';
    const el = (tagName, attrs = {}, ...kids) => { const x = document.createElementNS(NS, tagName); for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) x.setAttribute(k, v); for (const c of kids) if (c) x.append(c); return x; };
    const maxRows = Math.max(1, ...payload.nodes.map((n) => n.rows));
    const nodes = payload.nodes.map((n) => {
      const label = short(n.key);
      const w = Math.max(96, Math.min(280, label.length * 7.4 + 28)); const hgt = 40;
      return { ...n, label, w, h: hgt, weight: 0.85 + 0.35 * (Math.log10(n.rows + 1) / Math.log10(maxRows + 1)) };
    });
    const byKey = new Map(nodes.map((n) => [n.key, n]));
    // Uma linha por par de tabelas (várias FKs entre o mesmo par viram uma linha com todas no título).
    const pairs = new Map();
    for (const e of payload.edges) {
      if (e.from === e.to) { byKey.get(e.from).self = (byKey.get(e.from).self || []).concat(e); continue; }
      const k = [e.from, e.to].sort().join('|');
      if (!pairs.has(k)) pairs.set(k, { a: e.from, b: e.to, list: [] });
      pairs.get(k).list.push(e);
    }
    const links = [...pairs.values()].map((p) => ({ ...p, kind: p.list.some((e) => e.kind === 'fk') ? 'fk' : 'inferred', directed: p.list.every((e) => e.from === p.a) ? 1 : p.list.every((e) => e.from === p.b) ? -1 : 0 }));
    const adj = new Map(nodes.map((n) => [n.key, new Set()]));
    for (const l of links) { adj.get(l.a).add(l.b); adj.get(l.b).add(l.a); }

    // Layout
    if (positions && nodes.every((n) => positions[n.key])) for (const n of nodes) Object.assign(n, positions[n.key]);
    else layout();
    function layout() {
      const n0 = nodes.length; const k = 150;
      const center = nodes.find((n) => n.center);
      const rings = new Map();
      nodes.forEach((n, i) => {
        if (n.depth !== null && n.depth !== undefined) { const list = rings.get(n.depth) || []; list.push(n); rings.set(n.depth, list); } else { const r = 60 * Math.sqrt(i + 1); const a = i * 2.399963; n.x = r * Math.cos(a) * 1.6; n.y = r * Math.sin(a); }
      });
      for (const [d, list] of rings) list.forEach((n, i) => { const a = (i / list.length) * Math.PI * 2 + d * 0.5; const r = d * 260; n.x = r * Math.cos(a) * 1.4; n.y = r * Math.sin(a); });
      let t = 120;
      const ITER = n0 > 150 ? 220 : 320;
      for (let it = 0; it < ITER; it++) {
        for (const n of nodes) { n.dx = 0; n.dy = 0; }
        for (let i = 0; i < n0; i++) for (let j = i + 1; j < n0; j++) {
          const a = nodes[i]; const b = nodes[j];
          let dx = a.x - b.x; let dy = a.y - b.y; let d = Math.hypot(dx, dy) || 0.01;
          const pad = (a.w + b.w) / 2.6;
          const f = (k * k) / Math.max(1, d - pad * 0.5);
          dx /= d; dy /= d; a.dx += dx * f; a.dy += dy * f; b.dx -= dx * f; b.dy -= dy * f;
        }
        for (const l of links) {
          const a = byKey.get(l.a); const b = byKey.get(l.b);
          const dx = a.x - b.x; const dy = a.y - b.y; const d = Math.hypot(dx, dy) || 0.01;
          const f = (d * d) / k / 1.2;
          a.dx -= (dx / d) * f; a.dy -= (dy / d) * f; b.dx += (dx / d) * f; b.dy += (dy / d) * f;
        }
        for (const n of nodes) {
          n.dx -= n.x * 0.02; n.dy -= n.y * 0.03; // gravidade (achata um pouco: telas são largas)
          const d = Math.hypot(n.dx, n.dy) || 1; const m = Math.min(d, t);
          if (n === center) continue;
          n.x += (n.dx / d) * m; n.y += (n.dy / d) * m;
        }
        t = Math.max(2, t * 0.985);
      }
      if (center) { center.x = 0; center.y = 0; }
      // Desfaz sobreposição de caixas
      for (let pass = 0; pass < 40; pass++) {
        let moved = false;
        for (let i = 0; i < n0; i++) for (let j = i + 1; j < n0; j++) {
          const a = nodes[i]; const b = nodes[j];
          const ox = (a.w + b.w) / 2 + 14 - Math.abs(a.x - b.x); const oy = (a.h + b.h) / 2 + 12 - Math.abs(a.y - b.y);
          if (ox > 0 && oy > 0) {
            moved = true;
            if (ox < oy) { const s = (a.x < b.x ? -1 : 1) * ox / 2; if (a !== center) a.x += s; if (b !== center) b.x -= s; } else { const s = (a.y < b.y ? -1 : 1) * oy / 2; if (a !== center) a.y += s; if (b !== center) b.y -= s; }
          }
        }
        if (!moved) break;
      }
      onLayout && onLayout(Object.fromEntries(nodes.map((n) => [n.key, { x: n.x, y: n.y }])));
    }

    // Desenho
    const svg = el('svg', { class: 'dbx-svg', role: 'img', 'aria-label': 'Mapa relacional' });
    const defs = el('defs', {},
      el('marker', { id: 'dbx-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, el('path', { d: 'M0,0 L10,5 L0,10 z', class: 'dbx-arrowhead' })),
      el('marker', { id: 'dbx-arrow-inf', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, el('path', { d: 'M0,0 L10,5 L0,10 z', class: 'dbx-arrowhead inf' })));
    const vp = el('g', { class: 'dbx-vp' });
    const gEdges = el('g'); const gNodes = el('g');
    vp.append(gEdges, gNodes); svg.append(defs, vp);
    const border = (n, ux, uy) => { const tx = ux ? (n.w / 2 + 3) / Math.abs(ux) : Infinity; const ty = uy ? (n.h / 2 + 3) / Math.abs(uy) : Infinity; const s = Math.min(tx, ty); return [n.x + ux * s, n.y + uy * s]; };
    for (const l of links) {
      const title = l.list.map((e) => `${e.kind === 'fk' ? `FK ${e.name}` : `Hipótese (${e.confidence})`}: ${short(e.from)} → ${short(e.to)}\n   ${pairsText(e.pairs)}`).join('\n');
      l.line = el('line', { class: `dbx-edge ${l.kind === 'fk' ? 'fk' : 'inf'}`, 'marker-end': l.directed ? `url(#${l.kind === 'fk' ? 'dbx-arrow' : 'dbx-arrow-inf'})` : null }, el('title', {}, document.createTextNode(title)));
      l.hit = el('line', { class: 'dbx-edge-hit' }, el('title', {}, document.createTextNode(title)));
      gEdges.append(l.line, l.hit);
    }
    const placeEdge = (l) => {
      let a = byKey.get(l.a); let b = byKey.get(l.b);
      if (l.directed === -1) [a, b] = [b, a];
      const dx = b.x - a.x; const dy = b.y - a.y; const d = Math.hypot(dx, dy) || 1;
      const [x1, y1] = border(a, dx / d, dy / d); const [x2, y2] = border(b, -dx / d, -dy / d);
      for (const ln of [l.line, l.hit]) { ln.setAttribute('x1', x1); ln.setAttribute('y1', y1); ln.setAttribute('x2', x2); ln.setAttribute('y2', y2); }
    };
    for (const n of nodes) {
      const sub = `${N(n.rows)} linhas · ${n.columns} col${n.self ? ' · ↺' : ''}`;
      n.g = el('g', { class: `dbx-node${n.center ? ' center' : ''}${n.highlighted ? ' hl' : ''}`, tabindex: 0 },
        el('rect', { x: -n.w / 2, y: -n.h / 2, width: n.w, height: n.h, rx: 8 }),
        el('text', { class: 'dbx-node-name', y: -3, 'text-anchor': 'middle', style: `font-size:${(12 * n.weight).toFixed(1)}px` }, document.createTextNode(n.label)),
        el('text', { class: 'dbx-node-sub', y: 13, 'text-anchor': 'middle' }, document.createTextNode(sub)),
        el('title', {}, document.createTextNode(`${n.key}\n${sub}\nPK: ${n.pk.join(', ') || 'nenhuma'}\nClique: ligações · Duplo clique: centralizar`)));
      gNodes.append(n.g);
    }
    const placeNode = (n) => n.g.setAttribute('transform', `translate(${n.x},${n.y})`);
    nodes.forEach(placeNode); links.forEach(placeEdge);

    // Foco
    function focus(key) {
      const keep = key ? new Set([key, ...adj.get(key)]) : null;
      for (const n of nodes) { n.g.classList.toggle('dim', !!keep && !keep.has(n.key)); n.g.classList.toggle('sel', n.key === key); }
      for (const l of links) l.line.classList.toggle('dim', !!keep && !(l.a === key || l.b === key));
    }
    focus(selected && byKey.has(selected) ? selected : null);

    // Zoom / pan / arrastar
    const T = { x: 0, y: 0, k: 1 };
    const apply = () => vp.setAttribute('transform', `translate(${T.x},${T.y}) scale(${T.k})`);
    function fit() {
      const W = svg.clientWidth || 800; const H = svg.clientHeight || 520;
      const xs = nodes.flatMap((n) => [n.x - n.w / 2, n.x + n.w / 2]); const ys = nodes.flatMap((n) => [n.y - n.h / 2, n.y + n.h / 2]);
      if (!xs.length) return;
      const minX = Math.min(...xs); const maxX = Math.max(...xs); const minY = Math.min(...ys); const maxY = Math.max(...ys);
      T.k = Math.max(0.15, Math.min(1.4, Math.min((W - 40) / (maxX - minX || 1), (H - 40) / (maxY - minY || 1))));
      T.x = W / 2 - ((minX + maxX) / 2) * T.k; T.y = H / 2 - ((minY + maxY) / 2) * T.k;
      apply();
    }
    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect(); const mx = e.clientX - r.left; const my = e.clientY - r.top;
      const k2 = Math.max(0.1, Math.min(3, T.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
      T.x = mx - ((mx - T.x) * k2) / T.k; T.y = my - ((my - T.y) * k2) / T.k; T.k = k2; apply();
    }, { passive: false });
    let drag = null;
    const toWorld = (e) => { const r = svg.getBoundingClientRect(); return [(e.clientX - r.left - T.x) / T.k, (e.clientY - r.top - T.y) / T.k]; };
    svg.addEventListener('pointerdown', (e) => {
      const g = e.target.closest('.dbx-node');
      const n = g ? nodes.find((x) => x.g === g) : null;
      drag = { n, sx: e.clientX, sy: e.clientY, ox: n ? n.x : T.x, oy: n ? n.y : T.y, w0: toWorld(e), moved: false };
      svg.setPointerCapture(e.pointerId);
    });
    svg.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 3) drag.moved = true;
      if (!drag.moved) return;
      if (drag.n) {
        const [wx, wy] = toWorld(e); drag.n.x = drag.ox + (wx - drag.w0[0]); drag.n.y = drag.oy + (wy - drag.w0[1]);
        placeNode(drag.n); for (const l of links) if (l.a === drag.n.key || l.b === drag.n.key) placeEdge(l);
      } else { T.x = drag.ox + (e.clientX - drag.sx); T.y = drag.oy + (e.clientY - drag.sy); apply(); }
    });
    svg.addEventListener('pointerup', () => {
      if (drag && !drag.moved) { const key = drag.n ? drag.n.key : null; focus(key); onSelect && onSelect(key); }
      if (drag && drag.moved && drag.n) onLayout && onLayout(Object.fromEntries(nodes.map((n) => [n.key, { x: n.x, y: n.y }])));
      drag = null;
    });
    svg.addEventListener('dblclick', (e) => { const g = e.target.closest('.dbx-node'); const n = g && nodes.find((x) => x.g === g); if (n) onExpand && onExpand(n.key); });
    svg.addEventListener('keydown', (e) => { const g = e.target.closest('.dbx-node'); const n = g && nodes.find((x) => x.g === g); if (n && e.key === 'Enter') onOpen && onOpen(n.key); });

    // SVG autocontido para download: cores do tema atual copiadas para o próprio elemento.
    function svgText() {
      const clone = svg.cloneNode(true);
      const src = svg.querySelectorAll('*'); const dst = clone.querySelectorAll('*');
      src.forEach((s, i) => { const cs = getComputedStyle(s); dst[i].setAttribute('style', ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'opacity', 'font-size', 'font-weight', 'font-family'].map((p) => `${p}:${cs.getPropertyValue(p)}`).join(';')); });
      const W = svg.clientWidth; const H = svg.clientHeight;
      clone.setAttribute('xmlns', NS); clone.setAttribute('width', W); clone.setAttribute('height', H);
      clone.insertBefore(el('rect', { width: '100%', height: '100%', style: `fill:${getComputedStyle(svg).backgroundColor}` }), clone.firstChild);
      return new XMLSerializer().serializeToString(clone);
    }
    return { el: svg, fit, svgText };
  }

  // ---------- Caminhos ----------
  function renderPaths(host) {
    const P = DX.paths;
    const out = h('div', { class: 'dbx-paths' });
    const picker = (k, ph) => h('input', { type: 'text', list: 'dbx-keys', value: P[k], placeholder: ph, spellcheck: 'false', oninput: (e) => { P[k] = e.target.value.trim(); } });
    const depth = h('select', { 'aria-label': 'Máximo de saltos', onchange: (e) => { P.maxDepth = Number(e.target.value); } }, [2, 3, 4, 5, 6].map((v) => h('option', { value: v }, `até ${v} saltos`)));
    depth.value = P.maxDepth;
    const chk = (label, k, title) => h('label', { class: 'check', title }, h('input', { type: 'checkbox', checked: P[k], onchange: (e) => { P[k] = e.target.checked; } }), ` ${label}`);
    const go = async () => {
      if (!P.from || !P.to) return toast('Informe as duas tabelas.', 'error');
      try { P.result = await api('POST', C('/paths'), { from: P.from, to: P.to, maxDepth: P.maxDepth, includeInferred: P.includeInferred, avoidHubs: P.avoidHubs }); } catch (e) { return lost(e); }
      draw();
    };
    function draw() {
      const r = P.result;
      if (!r) { out.replaceChildren(h('div', { class: 'empty' }, 'Como ligar a tabela A à tabela B? Os caminhos mais curtos aparecem primeiro, com o JOIN pronto. Sem resultado? Ligue “Hipóteses” ou aumente os saltos.')); return; }
      if (!r.paths.length) { out.replaceChildren(h('div', { class: 'card' }, h('div', { class: 'card-body' }, h('strong', null, 'Nenhum caminho encontrado com estes limites.'), h('div', { class: 'muted small' }, [!P.includeInferred && 'Tente incluir hipóteses.', P.avoidHubs && r.avoided?.length && `Tabelas hub evitadas: ${r.avoided.map(short).join(', ')} — desmarque “Evitar hubs”.`, 'Aumente o número de saltos.'].filter(Boolean).join(' '))))); return; }
      out.replaceChildren(...[
        r.avoided?.length ? h('div', { class: 'muted small' }, `Hubs evitados no meio do caminho: ${r.avoided.map(short).join(', ')}.`) : null,
        ...r.paths.map((p, i) => h('section', { class: 'card dbx-path' },
          h('div', { class: 'card-head' }, h('div', { class: 'grow' }, h('strong', null, `Caminho ${i + 1}`), h('span', { class: 'muted small' }, ` · ${plural(p.length, 'salto', 'saltos')} · confiança ${p.confidence}${p.inferredSteps ? ` · ${p.inferredSteps} hipótese(s)` : ' · só FKs'}`),
            p.weakVia.length ? tag('warn', `converge em ${p.weakVia.map(short).join(', ')}`, 'As duas pontas só apontam para a mesma tabela (ex.: empresa/filial/tipo): liga, mas o JOIN não relaciona os registros entre si e multiplica linhas.') : null),
            h('button', { class: 'btn sm', onclick: () => { DX.map.mode = 'selection'; DX.map.selection = [...p.nodes]; DX.map.payload = null; DX.tab = 'map'; rerender(); } }, 'Ver no mapa'),
            h('button', { class: 'btn sm', onclick: () => { DX.builder.tables = [...p.nodes]; DX.builder.result = null; DX.tab = 'builder'; rerender(); } }, 'Montador'),
            h('button', { class: 'btn sm', onclick: () => copy(p.sql, 'SQL copiado.') }, icon('copy', 13), ' SQL'),
            h('button', { class: 'btn sm primary', onclick: () => { DX.console.sql = p.sql; DX.tab = 'console'; rerender(); } }, 'Console')),
          h('div', { class: 'card-body' }, h('div', { class: 'dbx-chain' }, p.nodes.map((k, j) => [
            j ? h('div', { class: `dbx-chain-link ${p.steps[j - 1].rel.kind}`, title: (p.steps[j - 1].rel.reasons || []).join('\n') || p.steps[j - 1].rel.name }, h('span', { class: 'mono small' }, pairsText(p.steps[j - 1].rel.pairs)), relTag(p.steps[j - 1].rel)) : null,
            h('div', { class: 'dbx-chain-node' }, tableLink(k))])),
          h('details', { class: 'dbx-details' }, h('summary', null, 'SQL'), h('pre', { class: 'code' }, p.sql))))),
      ].filter(Boolean));
    }
    host.append(h('section', { class: 'card' }, h('div', { class: 'card-body' }, h('div', { class: 'dbx-map-ctl' },
      picker('from', 'Tabela de origem'), h('span', { class: 'muted' }, '→'), picker('to', 'Tabela de destino'), depth,
      chk('Hipóteses', 'includeInferred', 'Usar também relacionamentos inferidos'), chk('Evitar hubs', 'avoidHubs', 'Não passar por tabelas que ligam muitas outras (ex.: coligada)'),
      h('button', { class: 'btn primary', onclick: (e) => busy(e.currentTarget, go, 'Procurando…') }, 'Buscar caminhos')))), out);
    draw();
  }

  // ---------- Montador de consulta ----------
  function renderBuilder(host) {
    const Bd = DX.builder;
    const listEl = h('div', { class: 'dbx-bd-list' });
    const out = h('div', { class: 'dbx-bd-out' });
    let timer = null;
    const regen = () => { clearTimeout(timer); timer = setTimeout(generate, 150); };
    const add = h('input', { type: 'text', list: 'dbx-keys', placeholder: 'Adicionar tabela (a primeira é a base do FROM)…', spellcheck: 'false',
      onchange: (e) => { const v = e.target.value.trim(); e.target.value = ''; if (v && !Bd.tables.includes(v)) { Bd.tables.push(v); drawList(); regen(); } } });
    const opt = (label, k, title) => h('label', { class: 'check', title: title || null }, h('input', { type: 'checkbox', checked: Bd[k], onchange: (e) => { Bd[k] = e.target.checked; regen(); } }), ` ${label}`);
    const jt = h('select', { 'aria-label': 'Tipo de JOIN', onchange: (e) => { Bd.joinType = e.target.value; regen(); } }, [['INNER', 'INNER JOIN'], ['LEFT', 'LEFT JOIN']].map(([v, l]) => h('option', { value: v }, l)));
    jt.value = Bd.joinType;
    const top = h('select', { 'aria-label': 'Linhas', onchange: (e) => { Bd.top = Number(e.target.value); regen(); } }, [[100, 'TOP 100'], [1000, 'TOP 1000'], [0, 'sem TOP']].map(([v, l]) => h('option', { value: v }, l)));
    top.value = Bd.top;
    const details = new Map();
    function drawList() {
      if (!Bd.tables.length) { listEl.replaceChildren(h('div', { class: 'empty' }, 'Escolha as tabelas que a consulta precisa. As ligações (e tabelas intermediárias) são encontradas sozinhas pelas FKs — e pelas hipóteses, se marcado.')); return; }
      listEl.replaceChildren(...Bd.tables.map((k, i) => {
        const cols = h('div', { class: 'dbx-bd-cols' });
        const det = h('details', { class: 'dbx-details', ontoggle: async (e) => {
          if (!e.target.open || cols.childElementCount) return;
          let d = details.get(k);
          if (!d) { try { d = await api('GET', `${C('/table')}?key=${encodeURIComponent(k)}`); details.set(k, d); } catch (er) { return lost(er); } }
          const sel = new Set((Bd.columns[d.key] || []).map((c) => c.toLowerCase()));
          cols.replaceChildren(...d.columns.map((c) => h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: sel.has(c.name.toLowerCase()), onchange: (ev) => {
            const cur = new Set(Bd.columns[d.key] || []);
            if (ev.target.checked) cur.add(c.name); else cur.delete(c.name);
            if (cur.size) Bd.columns[d.key] = [...cur]; else delete Bd.columns[d.key];
            regen();
          } }), ` ${c.name}`, c.pk ? ' 🔑' : '')));
        } }, h('summary', null, Bd.columns[k]?.length ? `${Bd.columns[k].length} coluna(s)` : 'Colunas'), cols);
        return h('div', { class: 'dbx-bd-item' },
          h('div', { class: 'dbx-bd-head' }, h('span', { class: 'dbx-step' }, i === 0 ? 'FROM' : String(i)), tableLink(k),
            h('span', { style: 'flex:1' }),
            h('button', { class: 'btn ghost sm', disabled: i === 0, 'aria-label': 'Subir', onclick: () => { [Bd.tables[i - 1], Bd.tables[i]] = [Bd.tables[i], Bd.tables[i - 1]]; drawList(); regen(); } }, '↑'),
            h('button', { class: 'btn ghost sm', 'aria-label': `Tirar ${k}`, onclick: () => { Bd.tables.splice(i, 1); delete Bd.columns[k]; drawList(); regen(); } }, '×')),
          det);
      }));
    }
    async function generate() {
      if (!Bd.tables.length) { Bd.result = null; drawOut(); return; }
      try { Bd.result = await api('POST', C('/join'), { tables: Bd.tables, joinType: Bd.joinType, top: Bd.top, includeInferred: Bd.includeInferred, avoidHubs: Bd.avoidHubs, star: Bd.star, columns: Bd.columns }); } catch (e) { return lost(e); }
      drawOut();
    }
    function drawOut() {
      const r = Bd.result;
      if (!r) { out.replaceChildren(); return; }
      const p = r.plan;
      out.replaceChildren(
        h('div', { class: 'dbx-label' }, 'Como as tabelas se ligam'),
        h('div', { class: 'dbx-chain' }, h('div', { class: 'dbx-chain-node' }, tableLink(p.base), h('span', { class: 'muted small' }, ' t0')),
          p.joins.map((j) => [h('div', { class: `dbx-chain-link ${j.rel.kind}` }, h('span', { class: 'mono small' }, `${j.alias} ↔ ${j.withAlias}: ${j.on.map(([a, b]) => `${a} = ${b}`).join(' AND ')}`), j.rel.kind === 'fk' ? tag('ok', 'FK', j.rel.name) : tag('warn', `hipótese · ${j.rel.confidence}`)),
            h('div', { class: 'dbx-chain-node' }, tableLink(j.table), h('span', { class: 'muted small' }, ` ${j.alias}`), j.intermediate ? tag('none', 'intermediária', 'Entrou para ligar as tabelas escolhidas') : null)])),
        p.missing.length ? h('div', { class: 'dbx-warn small' }, `Sem ligação encontrada para: ${p.missing.map(short).join(', ')}. ${Bd.includeInferred ? '' : 'Tente marcar “Usar hipóteses”. '}${Bd.avoidHubs ? 'Ou desmarque “Evitar hubs”.' : ''}`) : null,
        p.weak && p.weak.length ? h('div', { class: 'dbx-warn small' }, `Ligação fraca: ${p.weak.map((w) => `${short(w.table)} só se liga por ${short(w.via)}`).join('; ')} (as duas tabelas apenas apontam para ela). Adicione a tabela que relaciona as duas de fato, se houver.`) : null,
        p.joins.some((j) => j.rel.kind === 'inferred') ? h('div', { class: 'dbx-warn small' }, 'Há ligações por HIPÓTESE (marcadas no SQL). Confira antes de usar em script de migração.') : null,
        h('pre', { class: 'code dbx-sql' }, r.sql),
        h('div', { class: 'inline' },
          h('button', { class: 'btn primary', onclick: () => { DX.console.sql = r.sql; DX.tab = 'console'; rerender(); } }, 'Abrir no Console'),
          h('button', { class: 'btn', onclick: () => copy(r.sql, 'SQL copiado.') }, icon('copy', 13), ' Copiar'),
          h('button', { class: 'btn', onclick: () => { DX.map.mode = 'selection'; DX.map.selection = [p.base, ...p.joins.map((j) => j.table)]; DX.map.payload = null; DX.tab = 'map'; rerender(); } }, 'Ver no mapa')));
    }
    host.append(h('div', { class: 'dbx-builder' },
      h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('div', { class: 'grow' }, h('h2', null, 'Tabelas'), h('div', { class: 'muted small' }, 'Sem colunas marcadas: base com *, demais com a chave primária.')),
        Bd.tables.length ? h('button', { class: 'btn ghost sm', onclick: () => { Bd.tables = []; Bd.columns = {}; Bd.result = null; drawList(); drawOut(); } }, 'Limpar') : null),
      h('div', { class: 'card-body' }, add, listEl,
        h('div', { class: 'dbx-map-ctl' }, jt, top, opt('Usar hipóteses', 'includeInferred', 'Ligar também por relacionamentos inferidos'), opt('Evitar hubs', 'avoidHubs', 'Não usar tabelas hub como intermediárias'), opt('Todas as colunas (alias.*)', 'star')))),
      h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Consulta gerada')), h('div', { class: 'card-body' }, out))));
    drawList();
    if (Bd.result) drawOut(); else generate();
  }

  // ---------- Console SQL (somente leitura) ----------
  const TEMPLATES = [
    ['Estrutura', 'Colunas de uma tabela', (t) => `SELECT c.column_id, c.name AS coluna, ty.name AS tipo, c.max_length, c.is_nullable\nFROM sys.columns c JOIN sys.types ty ON ty.user_type_id = c.user_type_id\nWHERE c.object_id = OBJECT_ID(N'${t || 'dbo.TABELA'}')\nORDER BY c.column_id`],
    ['Estrutura', 'Maiores tabelas', () => "SELECT TOP (50) s.name AS [schema], t.name AS tabela, SUM(p.rows) AS linhas\nFROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id\nJOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0,1)\nGROUP BY s.name, t.name ORDER BY linhas DESC"],
    ['Estrutura', 'Tabelas sem chave primária', () => "SELECT s.name AS [schema], t.name AS tabela\nFROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id\nWHERE NOT EXISTS (SELECT 1 FROM sys.indexes i WHERE i.object_id = t.object_id AND i.is_primary_key = 1)\nORDER BY 1, 2"],
    ['Chaves', 'FKs que entram e saem de uma tabela', (t) => `SELECT fk.name, OBJECT_SCHEMA_NAME(fk.parent_object_id) + '.' + OBJECT_NAME(fk.parent_object_id) AS origem,\n       OBJECT_SCHEMA_NAME(fk.referenced_object_id) + '.' + OBJECT_NAME(fk.referenced_object_id) AS destino\nFROM sys.foreign_keys fk\nWHERE fk.parent_object_id = OBJECT_ID(N'${t || 'dbo.TABELA'}') OR fk.referenced_object_id = OBJECT_ID(N'${t || 'dbo.TABELA'}')`],
    ['Chaves', 'Colunas com índice', (t) => `SELECT i.name AS indice, i.is_unique, i.is_primary_key, c.name AS coluna, ic.key_ordinal\nFROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id\nJOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id\nWHERE i.object_id = OBJECT_ID(N'${t || 'dbo.TABELA'}')\nORDER BY i.name, ic.key_ordinal`],
    ['De-para', 'Procurar coluna pelo nome', (t, c) => `SELECT s.name AS [schema], t.name AS tabela, c.name AS coluna, ty.name AS tipo\nFROM sys.columns c JOIN sys.tables t ON t.object_id = c.object_id JOIN sys.schemas s ON s.schema_id = t.schema_id\nJOIN sys.types ty ON ty.user_type_id = c.user_type_id\nWHERE c.name LIKE N'%${(c || 'CPF').replace(/'/g, "''")}%'\nORDER BY 1, 2, 3`],
    ['De-para', 'Colunas com o mesmo nome em várias tabelas', () => "SELECT c.name AS coluna, COUNT(*) AS tabelas\nFROM sys.columns c JOIN sys.tables t ON t.object_id = c.object_id\nGROUP BY c.name HAVING COUNT(*) > 1 ORDER BY tabelas DESC, coluna"],
    ['Qualidade', 'Valores distintos de uma coluna', (t, c) => `SELECT TOP (200) [${c || 'COLUNA'}] AS valor, COUNT_BIG(*) AS ocorrencias\nFROM ${t ? sqlName(t) : '[dbo].[TABELA]'}\nGROUP BY [${c || 'COLUNA'}] ORDER BY ocorrencias DESC`],
    ['Qualidade', 'Percentual de nulos de uma coluna', (t, c) => `SELECT COUNT_BIG(*) AS total, SUM(CASE WHEN [${c || 'COLUNA'}] IS NULL THEN 1 ELSE 0 END) AS nulos,\n       CAST(100.0 * SUM(CASE WHEN [${c || 'COLUNA'}] IS NULL THEN 1 ELSE 0 END) / NULLIF(COUNT_BIG(*), 0) AS decimal(5,2)) AS pct_nulos\nFROM ${t ? sqlName(t) : '[dbo].[TABELA]'}`],
    ['Qualidade', 'Duplicados pela chave primária / coluna', (t, c) => `SELECT TOP (100) [${c || 'COLUNA'}], COUNT_BIG(*) AS vezes\nFROM ${t ? sqlName(t) : '[dbo].[TABELA]'}\nGROUP BY [${c || 'COLUNA'}] HAVING COUNT_BIG(*) > 1 ORDER BY vezes DESC`],
  ];
  function renderConsole(host) {
    const K = DX.console;
    const ta = h('textarea', { class: 'dbx-editor', rows: 12, spellcheck: 'false', placeholder: 'SELECT … (Ctrl+Enter executa). Só leitura: uma consulta SELECT ou WITH; nada é gravado.', value: K.sql,
      oninput: (e) => { K.sql = e.target.value; }, onkeydown: (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runBtn.click(); } if (e.key === 'Tab') { e.preventDefault(); const s = ta.selectionStart; ta.setRangeText('    ', s, ta.selectionEnd, 'end'); K.sql = ta.value; } } });
    const out = h('div', { class: 'dbx-console-out' });
    const limit = h('select', { 'aria-label': 'Limite de linhas', onchange: (e) => { K.limit = Number(e.target.value); } }, [100, 500, 1000, 5000].map((v) => h('option', { value: v }, `até ${N(v)} linhas`)));
    limit.value = [100, 500, 1000, 5000].includes(K.limit) ? K.limit : 500;
    const mask = h('input', { type: 'checkbox', checked: K.mask, onchange: (e) => { K.mask = e.target.checked; } });
    const tTable = h('input', { type: 'text', list: 'dbx-keys', placeholder: 'Tabela (para o modelo)', spellcheck: 'false' });
    const tCol = h('input', { type: 'text', placeholder: 'Coluna/termo', spellcheck: 'false' });
    const tSel = h('select', { 'aria-label': 'Modelos de consulta', onchange: (e) => { const t = TEMPLATES[Number(e.target.value)]; if (!t) return; K.sql = t[2](tTable.value.trim(), tCol.value.trim()); ta.value = K.sql; e.target.value = ''; ta.focus(); } },
      h('option', { value: '' }, 'Modelos de consulta…'), [...new Set(TEMPLATES.map((t) => t[0]))].map((g) => h('optgroup', { label: g }, TEMPLATES.map((t, i) => (t[0] === g ? h('option', { value: i }, t[1]) : null)))));
    let ac = null;
    const cancelBtn = h('button', { class: 'btn', hidden: true, onclick: () => ac && ac.abort() }, 'Cancelar');
    const runBtn = h('button', { class: 'btn primary', onclick: async () => {
      const sqlText = ta.value.trim();
      if (!sqlText) return toast('Escreva uma consulta.', 'error');
      ac = new AbortController(); runBtn.disabled = true; cancelBtn.hidden = false; out.replaceChildren(h('div', { class: 'empty' }, 'Executando…'));
      const t0 = Date.now();
      try {
        K.result = await call('POST', C('/query'), { sql: sqlText, limit: Number(limit.value), mask: mask.checked }, ac.signal);
        K.history = [{ sql: sqlText, at: new Date().toISOString(), rows: K.result.rows.length, ms: K.result.ms }, ...K.history.filter((x) => x.sql !== sqlText)].slice(0, 20);
        drawOut(); drawHistory();
      } catch (e) {
        if (e.name === 'AbortError') { out.replaceChildren(h('div', { class: 'empty' }, `Cancelado após ${((Date.now() - t0) / 1000).toFixed(1)} s.`)); }
        else { out.replaceChildren(h('div', { class: 'dbx-error' }, h('strong', null, e.code === 'DBX_READONLY' ? 'Bloqueado (somente leitura)' : 'Erro'), h('pre', { class: 'dbx-error-text' }, e.message))); if (e.code === 'DBX_NO_CATALOG') lost(e); }
      } finally { runBtn.disabled = false; cancelBtn.hidden = true; ac = null; }
    } }, 'Executar');
    function drawOut() {
      const r = K.result;
      if (!r) { out.replaceChildren(h('div', { class: 'empty' }, 'O resultado aparece aqui. Dica: o Montador de consulta e os Caminhos geram o JOIN pronto para trazer para cá.')); return; }
      const csv = () => { const esc = (v) => (v === null ? '' : /[";\n\r]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v)); return `﻿${[r.columns.map(esc).join(';'), ...r.rows.map((row) => row.map(esc).join(';'))].join('\r\n')}`; };
      out.replaceChildren(
        h('div', { class: 'inline' }, h('span', { class: 'small' }, `${N(r.rows.length)} linha(s)${r.truncated ? ` — limitado a ${N(r.limit)} (há mais)` : ''} · ${r.ms} ms${r.masked.length ? ` · mascaradas: ${r.masked.join(', ')}` : ''}`),
          h('span', { style: 'flex:1' }),
          h('button', { class: 'btn ghost sm', onclick: () => copy([r.columns.join('\t'), ...r.rows.map((row) => row.map((v) => (v === null ? '' : String(v))).join('\t'))].join('\n'), 'Copiado (cole no Excel).') }, icon('copy', 13), ' Copiar'),
          h('button', { class: 'btn ghost sm', onclick: () => saveBlob(new Blob([csv()], { type: 'text/csv;charset=utf-8' }), `consulta_${DX.catalog.database}.csv`) }, icon('download', 13), ' CSV'),
          h('button', { class: 'btn ghost sm', onclick: () => saveBlob(new Blob([JSON.stringify(r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]]))), null, 2)], { type: 'application/json' }), `consulta_${DX.catalog.database}.json`) }, icon('download', 13), ' JSON')),
        resultGrid(r, { maxHeight: '60vh' }));
    }
    const hist = h('div');
    function drawHistory() {
      hist.replaceChildren(K.history.length ? h('details', { class: 'dbx-details' }, h('summary', null, `Histórico desta sessão (${K.history.length})`),
        h('div', { class: 'dbx-hist' }, K.history.map((x) => h('button', { type: 'button', class: 'dbx-hist-item', title: x.sql, onclick: () => { K.sql = x.sql; ta.value = x.sql; ta.focus(); } },
          h('span', { class: 'mono small' }, x.sql.replace(/\s+/g, ' ').slice(0, 140)), h('span', { class: 'muted small' }, `${fmtDateTime(x.at)} · ${N(x.rows)} linha(s) · ${x.ms} ms`))))) : null);
    }
    host.append(h('section', { class: 'card' }, h('div', { class: 'card-body' },
      h('div', { class: 'dbx-map-ctl' }, tSel, tTable, tCol, h('span', { class: 'muted small' }, 'Modelos usam a tabela/coluna informada.')),
      ta,
      h('div', { class: 'inline' }, runBtn, cancelBtn, limit, h('label', { class: 'check' }, mask, ' Mascarar sensíveis'),
        h('span', { class: 'muted small' }, `Banco: ${DX.catalog.database} · transação sempre desfeita · espera por bloqueio até 15 s`)),
      hist)),
    h('section', { class: 'card' }, h('div', { class: 'card-body' }, out)));
    drawOut(); drawHistory();
  }

  // ---------- Configurações ----------
  function renderSettings(host, initial = DX.settings) {
    const s = { ...initial };
    const num = (k, min, max, label, hint) => field(label, h('input', { type: 'number', min, max, value: s[k], oninput: (e) => { s[k] = Number(e.target.value); } }), hint);
    host.append(h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Configurações do Explorador')), h('div', { class: 'card-body dbx-settings' },
      num('sampleRows', 1, 1000, 'Linhas da amostra', 'Padrão ao ler a amostra de uma tabela (1–1000).'),
      num('queryLimit', 1, 5000, 'Linhas do Console SQL', 'Máximo lido por consulta (1–5000); o resto é descartado.'),
      num('profileRows', 100, 1000000, 'Linhas do perfil', 'Primeiras N linhas usadas no perfil das colunas.'),
      num('checkRows', 100, 200000, 'Linhas ao conferir relacionamento', 'Amostra da origem usada no “Conferir no banco”.'),
      num('inferMinScore', 30, 95, 'Pontuação mínima das hipóteses', 'Vale na próxima carga ou ao “Recalcular” na Visão geral.'),
      num('maxNodes', 10, 250, 'Máximo de tabelas no mapa', 'Recortes maiores ficam ilegíveis; prefira tabela central + níveis.'),
      num('hubThreshold', 0, 5000, 'Ligações para ser “hub”', '0 = automático pelo tamanho do banco. Hubs (ex.: coligada/filial) podem ser evitados no mapa e nos caminhos.'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.maskSensitive, onchange: (e) => { s.maskSensitive = e.target.checked; } }), ' Mascarar colunas sensíveis por padrão (CPF, CNPJ, e-mail, telefone, senha…) em amostras e no Console'),
      h('div', { class: 'inline' }, h('button', { class: 'btn primary', onclick: (e) => busy(e.currentTarget, async () => { const r = await api('PUT', `${BASE}/settings`, s); DX.settings = r.settings; DX.console.limit = r.settings.queryLimit; DX.console.mask = r.settings.maskSensitive; toast('Configurações salvas.', 'ok'); rerender(); }) }, 'Salvar'),
        h('button', { class: 'btn ghost', title: 'Preenche os valores padrão (salve para aplicar)', onclick: () => { host.replaceChildren(); renderSettings(host, DX.defaults); } }, 'Restaurar padrões')),
      h('div', { class: 'muted small' }, 'Anotações das tabelas ficam neste computador (entram no Backup). A estrutura carregada fica só na memória do app.'))));
  }

  window.GP_TOOLS = window.GP_TOOLS || {};
  window.GP_TOOLS['db-explorer'] = { render };
})();
