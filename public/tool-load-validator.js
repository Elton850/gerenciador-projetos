// Ferramentas Auxiliares › Validação de Carga (tela). Regras, SQL e acesso ao RM/banco ficam no servidor (src/tools/load-validator).
// Abas por sistema: Educacional (pronto) · Folha (em breve). Passos: 1 Conexões (API do RM com senha DPAPI + base de migração
// cadastrada) → 2 Parâmetros (coligada, períodos, pasta de saída, tabelas) → 3 Conferir (trabalho: base só leitura + contagem
// no RM, uma tabela por vez → plano com as partes de cada tabela) → Executar
// (autorização explícita + confirmação do servidor) · Só validar · 4 Complemento (TXT do Hop → só o que falta no RM).
(() => {
  const BASE = '/api/tools/load-validator';
  const LV = { system: 'educacional', state: null, conns: [], plan: null, job: null, poll: null };
  const N = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('pt-BR'));
  const pill = (kind, text, title) => h('span', { class: `pill ${kind}`, title: title || null }, text);
  let MAIN = null; let TOOL = null;
  const rerender = () => MAIN && render(MAIN, TOOL);

  const last = () => (LV.state && LV.state.last) || {};
  async function saveLast(patch) { Object.assign(LV.state.last, patch); try { await api('PUT', `${BASE}/last`, LV.state.last); } catch { /* conveniência */ } }

  async function render(main, tool) {
    MAIN = main; TOOL = tool;
    main.replaceChildren(h('div', { class: 'page' }, h('div', { class: 'empty' }, 'Carregando…')));
    try {
      const [st, conns] = await Promise.all([api('GET', `${BASE}/state`), api('GET', '/api/connections')]);
      LV.state = st; LV.conns = conns;
      if (!LV.inited) { LV.system = st.last.system || 'educacional'; LV.inited = true; } // depois, a aba escolhida vale até sair da tela
    } catch (e) { main.replaceChildren(h('div', { class: 'page' }, h('div', { class: 'empty' }, e.message))); return; }
    const sys = LV.state.systems.find((s) => s.id === LV.system) || LV.state.systems[0];
    main.replaceChildren(h('div', { class: 'page lv-page' },
      h('div', { class: 'page-head' }, h('div', { class: 'grow' },
        h('a', { class: 'link-quiet small', href: '#/tools' }, '← Ferramentas Auxiliares'),
        h('h1', null, tool ? tool.name : 'Validação de Carga'),
        h('div', { class: 'muted' }, 'Confere se a carga foi de fato para o RM do cliente: extrai as tabelas do RM (consultas SQL temporárias pela API, criadas e apagadas a cada execução), grava cada uma na base de migração com o nome da tabela raiz, valida contra as ZMIGRA e gera os TXT complementares.'))),
      h('nav', { class: 'tabs', role: 'tablist' }, LV.state.systems.map((s) => h('button', { class: `tab${s.id === sys.id ? ' active' : ''}`, onclick: () => { if (!s.ready) { LV.system = s.id; rerender(); return; } LV.system = s.id; saveLast({ system: s.id }); rerender(); } }, s.name, s.ready ? null : h('span', { class: 'muted small' }, ' · em breve')))),
      sys.ready ? body(sys) : h('section', { class: 'card lv-section' }, h('h2', null, `${sys.name}: em breve`), h('p', { class: 'muted' }, 'O modelo de consultas e validações da Folha ainda não está disponível nesta versão. Por enquanto, a ferramenta atende o Educacional.'))));
  }

  const sec = (n, title, sub, ...content) => h('section', { class: 'card lv-section' },
    h('div', { class: 'lv-head' }, h('span', { class: 'lv-step' }, String(n)), h('div', null, h('h2', null, title), sub ? h('div', { class: 'muted small' }, sub) : null)), ...content);

  function body(sys) {
    const L = last();
    // ---- 1. Conexões ----
    const rmSel = h('select', { onchange: () => { saveLast({ rmId: rmSel.value }); LV.plan = null; drawPlan(); } },
      h('option', { value: '' }, LV.state.rm.length ? 'Escolha a conexão do RM…' : 'Nenhuma conexão do RM cadastrada'),
      LV.state.rm.map((c) => h('option', { value: c.id, selected: c.id === L.rmId }, `${c.name} — ${c.url} (${c.user})`)));
    const rmStatus = h('span', { class: 'muted small' });
    const rmButtons = h('div', { class: 'inline' },
      h('button', { class: 'btn', onclick: () => rmDialog(null) }, 'Nova'),
      h('button', { class: 'btn', onclick: () => { const c = LV.state.rm.find((x) => x.id === rmSel.value); if (c) rmDialog(c); else toast('Escolha uma conexão do RM.', 'error'); } }, 'Editar'),
      h('button', { class: 'btn', onclick: (e) => busy(e.currentTarget, async () => {
        if (!rmSel.value) throw new Error('Escolha uma conexão do RM.');
        const r = await api('POST', `${BASE}/rm/${rmSel.value}/test`);
        rmStatus.replaceChildren(r.ok ? pill('ok', `Conectado (${r.ms} ms)`) : pill('overdue', 'Falhou', r.error), r.ok ? null : h('span', null, ` ${r.error}`));
      }, 'Testando…') }, 'Testar'),
      h('button', { class: 'btn ghost', onclick: async () => {
        const c = LV.state.rm.find((x) => x.id === rmSel.value); if (!c) return;
        if (!(await confirmDialog({ title: 'Remover conexão do RM', message: `Remover “${c.name}”? A senha salva é descartada.`, okText: 'Remover', danger: true }))) return;
        try { await api('DELETE', `${BASE}/rm/${c.id}`); toast('Conexão removida.', 'ok'); rerender(); } catch (e) { fail(e); }
      } }, 'Remover'));
    const sqlConns = LV.conns.filter((c) => c.server);
    const connSel = h('select', { onchange: () => { const c = LV.conns.find((x) => x.id === connSel.value); if (c && c.database && !dbIn.value) dbIn.value = c.database; saveLast({ connectionId: connSel.value }); LV.plan = null; drawPlan(); } },
      h('option', { value: '' }, sqlConns.length ? 'Escolha a conexão da base de migração…' : 'Nenhuma conexão cadastrada'),
      sqlConns.map((c) => h('option', { value: c.id, selected: c.id === L.connectionId }, `${c.name} — ${c.server}${c.env ? ` [${c.env}]` : ''}`)));
    const dbIn = h('input', { type: 'text', value: L.database || '', placeholder: 'Banco da base de migração', onchange: () => { saveLast({ database: dbIn.value.trim() }); LV.plan = null; drawPlan(); } });
    const baseStatus = h('span', { class: 'muted small' });
    const testBase = h('button', { class: 'btn', onclick: (e) => busy(e.currentTarget, async () => {
      const r = await api('POST', `${BASE}/base/test`, { connectionId: connSel.value, database: dbIn.value.trim() });
      baseStatus.replaceChildren(r.ok ? pill('ok', `Conectado como ${r.login}`) : pill('overdue', 'Falhou', r.error),
        r.ok ? h('span', null, ` · ${r.connectedTo} · ${r.database}${r.canCreate && r.canAlter && r.canInsert ? ' · pode criar/gravar tabelas' : ' · SEM permissão para criar/gravar tabelas'}`) : h('span', null, ` ${r.error}`));
    }, 'Testando…') }, 'Testar');

    // ---- 2. Parâmetros ----
    const colIn = h('input', { type: 'number', min: '0', max: '32767', value: L.coligada ?? '', placeholder: 'Ex.: 1', onchange: () => { saveLast({ coligada: Number(colIn.value) }); LV.plan = null; drawPlan(); } });
    const perIn = h('input', { type: 'text', value: L.periods || '', placeholder: "Ex.: 2026, 2027 (vazio = todos)", onchange: () => { saveLast({ periods: perIn.value }); LV.plan = null; drawPlan(); } });
    const outF = pathField({ value: L.outDir || '', kind: 'folder', title: 'Pasta de saída da Validação de Carga' });
    outF.input.addEventListener('change', () => { saveLast({ outDir: outF.get() }); LV.plan = null; drawPlan(); });
    const chosen = new Set(Array.isArray(L.tables) && L.tables.length ? L.tables : sys.tables.map((t) => t.table));
    const tblBoxes = sys.tables.map((t) => h('label', { class: 'check lv-tbl', title: `Consulta temporária no RM: ${t.code}\nValidações: ${t.validations.join(', ')}` },
      h('input', { type: 'checkbox', checked: chosen.has(t.table), onchange: (e) => { if (e.target.checked) chosen.add(t.table); else chosen.delete(t.table); saveLast({ tables: [...chosen] }); LV.plan = null; drawPlan(); } }), h('span', { class: 'mono' }, t.table)));
    const allBtn = (on) => h('button', { class: 'btn ghost sm', onclick: () => { if (on) sys.tables.forEach((t) => chosen.add(t.table)); else chosen.clear(); saveLast({ tables: [...chosen] }); rerender(); } }, on ? 'Todas' : 'Nenhuma');
    const params = () => ({ system: sys.id, rmId: rmSel.value, connectionId: connSel.value, database: dbIn.value.trim(), coligada: colIn.value, periods: perIn.value, outDir: outF.get(), tables: sys.tables.map((t) => t.table).filter((t) => chosen.has(t)) });

    // ---- 3. Conferir / executar ----
    const planHost = h('div'); const jobHost = h('div');
    const auth = h('input', { type: 'checkbox' });
    function drawPlan() {
      const p = LV.plan;
      if (!p) { planHost.replaceChildren(h('p', { class: 'muted' }, 'Clique em “Conferir” para ver o que será feito. A conferência só lê a base e conta as linhas no RM (uma consulta temporária de contagem por tabela, uma por vez, criada e apagada). Nada é gravado na base nem fica no RM.')); return; }
      auth.checked = false;
      planHost.replaceChildren(
        h('div', { class: 'lv-facts' },
          h('div', null, h('b', null, 'RM: '), `${p.rm.url} · usuário ${p.rm.user} · ${N(p.rm.consultas)} consultas SQL cadastradas`),
          h('div', null, h('b', null, 'Base: '), `${p.target.connectionName} · ${p.target.server} · ${p.target.database} · login ${p.target.login}`, ' ', pill(p.target.env === 'prod' ? 'prod' : p.target.env === 'local' ? 'local' : 'soon', p.target.env || '—')),
          h('div', null, h('b', null, 'Parâmetros: '), `coligada ${p.params.coligada}${p.params.periods.length ? ` · períodos ${p.params.periods.join(', ')}` : ' · todos os períodos'}`),
          h('div', null, h('b', null, 'Saída: '), h('span', { class: 'mono' }, p.outDir))),
        p.warnings.length ? h('ul', { class: 'lv-warn' }, p.warnings.map((w) => h('li', null, w))) : null,
        h('div', { class: 'tablewrap' }, h('table', { class: 'compact' },
          h('thead', null, h('tr', null, h('th', null, 'Tabela'), h('th', null, 'Consulta temporária no RM'), h('th', { class: 'num' }, 'Linhas no RM'), h('th', { class: 'num' }, 'Partes'), h('th', { class: 'num' }, 'Linhas hoje na base'), h('th', null, 'Validação'), h('th', { class: 'num' }, 'Carga'))),
          h('tbody', null, p.tables.flatMap((t) => t.validations.map((v, i) => h('tr', null,
            i === 0 ? h('td', { class: 'mono', rowspan: t.validations.length }, t.table) : null,
            i === 0 ? h('td', { class: 'mono', rowspan: t.validations.length }, t.code) : null,
            i === 0 ? h('td', { class: 'num', rowspan: t.validations.length }, t.countError ? pill('overdue', 'erro', t.countError) : N(t.rmRows)) : null,
            i === 0 ? h('td', { class: 'num', rowspan: t.validations.length, title: t.partColumn ? `Dividida por faixas de ${t.partColumn} (até ${N(p.rowsPerPart)} linhas por parte)` : 'Sem coluna de divisão: uma chamada só' }, t.parts === null ? '—' : t.parts > 1 ? pill('soon', N(t.parts)) : '1') : null,
            i === 0 ? h('td', { class: 'num', rowspan: t.validations.length }, t.current === null ? 'nova' : N(t.current)) : null,
            h('td', null, v.label, ' ', h('span', { class: 'muted small mono' }, v.source)), h('td', { class: 'num' }, N(v.carga)))))))),
        h('label', { class: 'check lv-auth' }, auth, h('span', null, h('b', null, 'Autorizo '), `criar, executar e apagar ${N(p.tables.reduce((n, t) => n + (t.parts || 0), 0))} consulta(s) temporária(s) ZMV.* no RM do cliente, uma por vez, e SUBSTITUIR ${p.tables.length} tabela(s) na base ${p.target.database} (uma cópia CSV da tabela atual é gravada antes, na pasta de saída).`)),
        h('div', { class: 'inline' }, h('button', { class: 'btn primary', disabled: !p.canExecute, onclick: (e) => busy(e.currentTarget, execute, 'Iniciando…') }, 'Extrair do RM e validar')));
    }
    async function execute() {
      const p = LV.plan;
      if (!auth.checked) throw new Error('Marque a autorização antes de executar.');
      let r;
      try { r = await api('POST', `${BASE}/plans/${p.planId}/execute`, { hash: p.hash, authorized: true }); } catch (e) {
        if (e.code !== 'LV_CONFIRM') throw e;
        if (!(await confirmDialog({ title: 'Confirmar Validação de Carga', message: e.message, okText: 'Executar', danger: true }))) return;
        r = await api('POST', `${BASE}/plans/${p.planId}/execute`, { hash: p.hash, authorized: true, confirmed: true });
      }
      LV.plan = null; drawPlan(); follow(r.jobId);
    }
    function follow(jobId) {
      clearTimeout(LV.poll);
      const tick = async () => {
        let j; try { j = await api('GET', `${BASE}/jobs/${jobId}`); } catch (e) { fail(e); return; }
        LV.job = j; drawJob();
        if (j.kind === 'precheck' && j.status === 'done' && j.result && j.result.plan) { LV.plan = j.result.plan; drawPlan(); }
        if (j.status === 'running' && document.body.contains(jobHost)) LV.poll = setTimeout(tick, 1000);
      };
      tick();
    }
    function drawJob() {
      const j = LV.job; if (!j) { jobHost.replaceChildren(); return; }
      const pct = j.total ? (100 * j.done) / j.total : 0;
      const label = { precheck: 'Conferência (contagem no RM, uma tabela por vez)', execute: 'Extração e validação', validate: 'Validação (só leitura)', complement: 'Complemento' }[j.kind];
      const st = { running: pill('soon', 'Em andamento'), done: pill('ok', 'Concluído'), error: pill('overdue', 'Erro'), cancelled: pill('soon', 'Cancelado') }[j.status];
      const res = j.result || {};
      jobHost.replaceChildren(h('div', { class: 'card lv-job' },
        h('div', { class: 'inline' }, h('b', null, label), st, j.status === 'running' ? h('button', { class: 'btn ghost sm', onclick: () => api('POST', `${BASE}/jobs/${j.id}/cancel`).catch(fail) }, 'Cancelar') : null),
        j.status === 'running' ? h('div', null, h('div', { class: 'progress' }, h('div', { style: `width:${pct}%` })), h('div', { class: 'muted small' }, j.current || '…')) : null,
        j.error ? h('p', { class: 'lv-bad' }, j.error) : null,
        res.dir ? h('p', { class: 'small' }, 'Arquivos em ', h('span', { class: 'mono' }, res.dir)) : null,
        res.snapshot ? h('p', { class: 'small' }, `Consultas no RM: ${N(res.snapshot.before)} antes · ${N(res.snapshot.after)} depois · temporárias restantes: `, res.snapshot.leftovers.length ? pill('overdue', res.snapshot.leftovers.join(', ')) : pill('ok', 'nenhuma')) : null,
        res.extraction ? resultTable(['Tabela', 'Linhas do RM', 'Situação'], res.extraction.map((e) => [h('span', { class: 'mono' }, e.table), N(e.rows), e.status.startsWith('gravada') ? pill('ok', e.status) : pill('overdue', e.status)])) : null,
        res.validation ? resultTable(['Validação', 'Origem', 'Carga', 'Não subiu', '% no RM'], res.validation.map((v) => v.error ? [v.label, v.source, '—', pill('overdue', 'erro', v.error), v.error] : [v.label, h('span', { class: 'mono' }, v.source), N(v.carga), v.missing ? pill('overdue', N(v.missing)) : pill('ok', '0'), v.carga ? `${(100 * (v.carga - v.missing) / v.carga).toFixed(1)}%` : '—'])) : null,
        res.rows ? resultTable(['TXT', 'No RM', 'Linhas no TXT', 'A subir', 'Só no RM', 'Situação'], res.rows.map((r) => [h('span', { class: 'mono' }, r.table), N(r.inRm), N(r.txtLines), r.toLoad ? pill('soon', N(r.toLoad)) : N(r.toLoad), N(r.onlyRm), r.status])) : null,
        res.warnings && res.warnings.length ? h('ul', { class: 'lv-warn' }, res.warnings.map((w) => h('li', null, w))) : null,
        j.log && j.log.length ? h('details', { class: 'lv-log' }, h('summary', null, `Registro (${j.log.length})`), h('pre', null, j.log.join('\n'))) : null));
    }
    const resultTable = (head, rows) => h('div', { class: 'tablewrap tall' }, h('table', { class: 'compact' }, h('thead', null, h('tr', null, head.map((x) => h('th', null, x)))), h('tbody', null, rows.map((r) => h('tr', null, r.map((c) => h('td', null, c)))))));

    const conferir = h('button', { class: 'btn', onclick: (e) => busy(e.currentTarget, async () => { LV.plan = null; drawPlan(); const r = await api('POST', `${BASE}/precheck`, params()); follow(r.jobId); }, 'Iniciando…') }, 'Conferir');
    const soValidar = h('button', { class: 'btn', onclick: (e) => busy(e.currentTarget, async () => { const p = params(); const r = await api('POST', `${BASE}/validate`, { system: p.system, connectionId: p.connectionId, database: p.database, tables: p.tables, outDir: p.outDir }); follow(r.jobId); }, 'Iniciando…') }, 'Só validar (somente leitura)');

    // ---- 4. Complemento ----
    const txtF = pathField({ value: L.txtDir || '', kind: 'folder', title: 'Pasta dos TXT gerados pelo Hop' });
    txtF.input.addEventListener('change', () => saveLast({ txtDir: txtF.get() }));
    const incl = h('input', { type: 'checkbox', checked: !!L.includeUnreferenced, onchange: () => saveLast({ includeUnreferenced: incl.checked }) });
    const gerar = h('button', { class: 'btn', onclick: (e) => busy(e.currentTarget, async () => {
      const p = params();
      saveLast({ txtDir: txtF.get() });
      const r = await api('POST', `${BASE}/complement`, { system: p.system, connectionId: p.connectionId, database: p.database, coligada: p.coligada, txtDir: txtF.get(), outDir: p.outDir, includeUnreferenced: incl.checked });
      follow(r.jobId);
    }, 'Iniciando…') }, 'Gerar complemento');

    const wrap = h('div', { class: 'lv-flow' },
      sec(1, 'Conexões', 'API do RM do cliente (senha protegida pelo Windows) e a base de migração (conexão cadastrada).',
        h('div', { class: 'lv-grid' },
          field('API do RM', h('div', null, h('div', { class: 'inline' }, rmSel), rmButtons, rmStatus), 'Usuário com permissão de incluir, executar e excluir Consultas SQL. Endereço: https://servidor:porta.'),
          field('Base de migração', h('div', null, h('div', { class: 'inline' }, connSel), h('div', { class: 'inline' }, dbIn, testBase), baseStatus), sqlConns.length ? 'Onde estão as ZMIGRA. As cópias do RM são gravadas aqui (dbo.<TABELA>).' : h('a', { href: '#/settings' }, 'Cadastrar conexão em Configurações → Conexões')))),
      sec(2, 'Parâmetros', 'Só a coligada e os períodos letivos entram nas consultas; o SQL é o modelo embutido do Educacional.',
        h('div', { class: 'lv-grid' }, field('Coligada', colIn), field('Períodos letivos (frequência)', perIn), field('Pasta de saída', outF.el, 'Cada execução cria uma pasta nova em ValidacaoCarga\\ (resumo, linhas que não subiram, cópias das tabelas substituídas).')),
        h('div', { class: 'field' }, h('label', null, 'Tabelas'), h('div', { class: 'inline' }, allBtn(true), allBtn(false)), h('div', { class: 'lv-tables' }, tblBoxes))),
      sec(3, 'Extrair do RM e validar', 'Conferir lê a base e conta as linhas no RM. Executar cria/executa/apaga, uma por vez, as consultas temporárias no RM (tabelas grandes em partes) e substitui a tabela na base (uma transação por tabela).',
        h('div', { class: 'inline' }, conferir, soValidar), planHost),
      sec(4, 'Gerar complemento', 'Compara os TXT do Hop com as tabelas do RM já gravadas na base e gera, numa pasta nova, só as linhas que ainda não estão no RM.',
        h('div', { class: 'lv-grid' }, field('Pasta dos TXT do Hop', txtF.el), h('label', { class: 'check' }, incl, h('span', null, 'Copiar inteiros os TXT de tabelas ainda sem referência na base'))),
        h('div', { class: 'inline' }, gerar)),
      jobHost);
    drawPlan(); drawJob();
    return wrap;
  }

  // Cadastro/edição da conexão do RM. A senha só é enviada se digitada (em branco = manter a salva).
  function rmDialog(c) {
    const name = h('input', { type: 'text', value: c ? c.name : '', placeholder: 'Ex.: RM Cliente Alfa' });
    const url = h('input', { type: 'text', value: c ? c.url : '', placeholder: 'https://servidor.exemplo.test:8051' });
    const user = h('input', { type: 'text', value: c ? c.user : '' });
    const pass = h('input', { type: 'password', placeholder: c && c.hasPassword ? '(manter a senha salva)' : '' });
    const m = openModal({
      title: c ? 'Editar conexão do RM' : 'Nova conexão do RM', size: 'sm',
      body: [field('Nome', name), field('Endereço da API (com porta)', url, 'http(s)://servidor:porta, sem caminho.'), field('Usuário', user), field('Senha', pass, 'Guardada criptografada pelo Windows (DPAPI) só neste usuário e computador; nunca é mostrada.')],
      footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'), h('button', { class: 'btn primary', onclick: (e) => busy(e.currentTarget, async () => {
        const b = { name: name.value, url: url.value, user: user.value, password: pass.value || undefined };
        const saved = c ? await api('PUT', `${BASE}/rm/${c.id}`, b) : await api('POST', `${BASE}/rm`, b);
        LV.state.last.rmId = saved.id; await api('PUT', `${BASE}/last`, LV.state.last).catch(() => {});
        m.close(); toast('Conexão do RM salva.', 'ok'); rerender();
      }, 'Salvando…') }, 'Salvar')],
    });
  }

  window.GP_TOOLS = window.GP_TOOLS || {};
  window.GP_TOOLS['load-validator'] = { render };
})();
