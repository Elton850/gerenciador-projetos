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
        h('div', { class: 'muted' }, 'Confere se a carga foi de fato para o RM do cliente: extrai as tabelas do RM (consultas SQL temporárias pela API, criadas e apagadas a cada execução), grava cada uma na base de migração com o nome da tabela raiz, valida contra as ZMIGRA e (no Educacional) gera os TXT complementares.'))),
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
    // uma ou várias coligadas ("1, 2, 5"): o RM traz só elas e a validação conta só elas na carga (com a quebra por coligada)
    const colIn = h('input', { type: 'text', value: L.coligadas ?? (L.coligada ?? ''), placeholder: 'Ex.: 1 ou 1, 2, 5', onchange: () => { saveLast({ coligadas: colIn.value.trim() }); LV.plan = null; drawPlan(); } });
    const perIn = h('input', { type: 'text', value: L.periods || '', placeholder: "Ex.: 2026, 2027 (vazio = todos)", onchange: () => { saveLast({ periods: perIn.value }); LV.plan = null; drawPlan(); } });
    const outF = pathField({ value: L.outDir || '', kind: 'folder', title: 'Pasta de saída da Validação de Carga' });
    outF.input.addEventListener('change', () => { saveLast({ outDir: outF.get() }); LV.plan = null; drawPlan(); });
    const chosen = new Set(Array.isArray(L.tables) && L.tables.length ? L.tables : sys.tables.map((t) => t.table));
    const tblBoxes = sys.tables.map((t) => h('label', { class: 'check lv-tbl', title: `Consulta temporária no RM: ${t.code}\nValidações: ${t.validations.join(', ')}` },
      h('input', { type: 'checkbox', checked: chosen.has(t.table), onchange: (e) => { if (e.target.checked) chosen.add(t.table); else chosen.delete(t.table); saveLast({ tables: [...chosen] }); LV.plan = null; drawPlan(); } }), h('span', { class: 'mono' }, t.table)));
    const allBtn = (on) => h('button', { class: 'btn ghost sm', onclick: () => { if (on) sys.tables.forEach((t) => chosen.add(t.table)); else chosen.clear(); saveLast({ tables: [...chosen] }); rerender(); } }, on ? 'Todas' : 'Nenhuma');
    const params = () => ({ system: sys.id, rmId: rmSel.value, connectionId: connSel.value, database: dbIn.value.trim(), coligadas: colIn.value.trim(), periods: sys.usesPeriods ? perIn.value : '', outDir: outF.get(), tables: sys.tables.map((t) => t.table).filter((t) => chosen.has(t)) });

    // ---- 3. Conferir / executar ----
    const planHost = h('div'); const jobHost = h('div');
    const auth = h('input', { type: 'checkbox' });
    function drawPlan() {
      const p = LV.plan;
      if (!p) { planHost.replaceChildren(h('p', { class: 'muted' }, 'Clique em “Conferir” para ver o que será feito. A conferência só lê a base e conta as linhas no RM (uma consulta temporária de contagem por tabela, uma por vez, criada e apagada). Nada é gravado na base nem fica no RM.')); return; }
      auth.checked = false;
      planHost.replaceChildren(
        h('dl', { class: 'lv-kv' },
          h('dt', null, 'RM'), h('dd', null, h('span', { class: 'mono' }, p.rm.url), h('span', { class: 'muted' }, ` · usuário ${p.rm.user} · ${N(p.rm.consultas)} consulta(s) ZMV.* já no RM`)),
          h('dt', null, 'Base'), h('dd', null, `${p.target.connectionName} · ${p.target.server} · `, h('b', null, p.target.database), h('span', { class: 'muted' }, ` · login ${p.target.login} `), pill(p.target.env === 'prod' ? 'prod' : p.target.env === 'local' ? 'local' : 'soon', p.target.env || '—')),
          h('dt', null, 'Coligada(s)'), h('dd', null, h('b', null, (p.params.coligadas || [p.params.coligada]).join(', ')), !sys.usesPeriods ? null : h('span', { class: 'muted' }, p.params.periods.length ? ` · períodos ${p.params.periods.join(', ')}` : ' · todos os períodos')),
          h('dt', null, 'Saída'), h('dd', null, h('span', { class: 'mono' }, p.outDir))),
        p.warnings.length ? h('ul', { class: 'lv-callout warn' }, p.warnings.map((w) => h('li', null, w))) : null,
        h('div', { class: 'lv-tablewrap' }, h('table', { class: 'lv-table' },
          h('thead', null, h('tr', null, h('th', null, 'Tabela'), h('th', null, 'Consulta temporária no RM'), h('th', { class: 'num' }, 'Linhas no RM'), h('th', { class: 'num' }, 'Partes'), h('th', { class: 'num' }, 'Linhas hoje na base'), h('th', null, 'Validação'), h('th', { class: 'num' }, 'Carga'))),
          // tabela sem validação no modelo (ex.: PFHSTNDP da Folha) também aparece: uma linha com "sem validação"
          h('tbody', null, p.tables.flatMap((t) => { const vs = t.validations.length ? t.validations : [null]; return vs.map((v, i) => h('tr', null,
            i === 0 ? h('td', { class: 'mono', rowspan: vs.length }, t.table) : null,
            i === 0 ? h('td', { class: 'mono', rowspan: vs.length }, t.code) : null,
            i === 0 ? h('td', { class: 'num', rowspan: vs.length }, t.countError ? pill('overdue', 'erro', t.countError) : N(t.rmRows)) : null,
            i === 0 ? h('td', { class: 'num', rowspan: vs.length, title: t.partColumn ? `Dividida por faixas de ${t.partColumn} (até ${N(p.rowsPerPart)} linhas por parte)` : 'Sem coluna de divisão: uma chamada só' }, t.parts === null ? '—' : t.parts > 1 ? pill('soon', N(t.parts)) : '1') : null,
            i === 0 ? h('td', { class: 'num', rowspan: vs.length }, t.current === null ? 'nova' : N(t.current)) : null,
            v ? h('td', null, v.label, ' ', h('span', { class: 'muted small mono' }, v.source)) : h('td', { class: 'muted' }, 'sem validação no modelo (só extrai)'), h('td', { class: 'num' }, v ? N(v.carga) : '—'))); })))),
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
      if (LV.jobId !== jobId) { LV.jobId = jobId; LV.vfilter = 'all'; LV.vopen = new Set(); LV.extOpen = undefined; } // trabalho novo: visão padrão
      const tick = async () => {
        let j; try { j = await api('GET', `${BASE}/jobs/${jobId}`); } catch (e) { fail(e); return; }
        LV.job = j; drawJob();
        if (j.kind === 'precheck' && j.status === 'done' && j.result && j.result.plan) { LV.plan = j.result.plan; drawPlan(); }
        if (j.status === 'running' && document.body.contains(jobHost)) LV.poll = setTimeout(tick, 1000);
      };
      tick();
    }
    // ---- Resultado do trabalho: resumo no topo → validação (principal) → extração (recolhível) → arquivos → registro ----
    const pctOf = (carga, missing) => (carga ? (100 * (carga - missing)) / carga : null);
    const tone = (p) => (p === null ? 'none' : p >= 99.95 ? 'ok' : p <= 0.05 ? 'bad' : 'warn');
    const fmtPct = (p) => (p === null ? '—' : `${p.toFixed(1).replace('.', ',')}%`);
    // barra do "% no RM": verde = tudo subiu, laranja = parcial, vermelho = nada subiu
    const meter = (p, title) => h('div', { class: `lv-meter ${tone(p)}`, title: title || null },
      h('span', { class: 'lv-meter-bar' }, h('span', { style: `width:${p === null ? 0 : Math.max(0, Math.min(100, p))}%` })), h('span', { class: 'lv-meter-val' }, fmtPct(p)));
    // situação curta da extração (o texto completo vai como detalhe, quebrando linha)
    const extState = (e) => e.state || (e.status.startsWith('gravada') ? 'ok' : /SEM LINHAS|NÃO SUBSTITUÍDA/.test(e.status) ? 'empty' : /cancelad/i.test(e.status) ? 'cancelled' : 'error');
    const EXT = { ok: ['ok', 'Gravada'], empty: ['soon', 'RM sem linhas'], error: ['overdue', 'Erro'], cancelled: ['none', 'Cancelada'] };
    const detailOf = (s) => String(s).replace(/^[^:]*:\s*/, '');

    function kpis(res) {
      const ext = res.extraction || []; const val = res.validation || [];
      const done = val.filter((v) => !v.error);
      const carga = done.reduce((s, v) => s + (v.carga || 0), 0); const miss = done.reduce((s, v) => s + (v.missing || 0), 0);
      const p = pctOf(carga, miss);
      const count = (st) => ext.filter((e) => extState(e) === st).length;
      const card = (label, value, sub, cls) => h('div', { class: `lv-kpi ${cls || ''}` }, h('span', { class: 'lv-kpi-label' }, label), h('span', { class: 'lv-kpi-value' }, value), sub ? h('span', { class: 'lv-kpi-sub' }, sub) : null);
      const cards = [];
      if (ext.length) cards.push(card('Tabelas', N(ext.length), [count('ok') ? `${count('ok')} gravada(s)` : null, count('empty') ? `${count('empty')} sem linhas no RM` : null, count('error') ? `${count('error')} com erro` : null].filter(Boolean).join(' · '), count('error') ? 'bad' : ''));
      if (val.length) {
        cards.push(card('Carga comparada', N(carga), `${done.length} de ${val.length} validação(ões)`));
        cards.push(card('Não subiu', N(miss), miss ? 'linhas da carga fora do RM' : 'tudo da carga está no RM', miss ? 'bad' : 'ok'));
        cards.push(h('div', { class: `lv-kpi ${tone(p)}` }, h('span', { class: 'lv-kpi-label' }, 'No RM'), h('span', { class: 'lv-kpi-value' }, fmtPct(p)), meter(p)));
      }
      if (res.snapshot) cards.push(card('Consultas ZMV.* no RM', res.snapshot.leftovers.length ? 'Sobrou' : 'Limpo', res.snapshot.leftovers.length ? res.snapshot.leftovers.join(', ') : `${N(res.snapshot.before)} antes · ${N(res.snapshot.after)} depois`, res.snapshot.leftovers.length ? 'bad' : 'ok'));
      return cards.length ? h('div', { class: 'lv-kpis' }, cards) : null;
    }

    // filtro da lista de validações (fica entre redesenhos)
    const VFILTERS = [['all', 'Todas'], ['pend', 'Com pendência'], ['ok', '100% no RM'], ['skip', 'Não validadas']];
    const vMatch = (v, f) => (f === 'all' ? true : f === 'skip' ? !!v.error : f === 'ok' ? !v.error && !v.missing : !v.error && v.missing > 0);
    // origem da carga só quando foge do padrão ZMIGRA_<tabela> (ex.: ZPESSOA, ZMIGRA_SPESSOA_SALUNO, SNOTAETAPA (FALTAS…))
    const srcLine = (v) => (v.source && v.source !== `ZMIGRA_${v.label}` ? h('div', { class: 'lv-sub' }, 'carga: ', h('span', { class: 'mono' }, v.source)) : null);
    function validationBlock(val) {
      LV.vfilter = LV.vfilter || 'all'; LV.vopen = LV.vopen || new Set();
      const f = LV.vfilter;
      const chips = h('div', { class: 'lv-chips', role: 'tablist' }, VFILTERS.map(([id, name]) => {
        const n = val.filter((v) => vMatch(v, id)).length;
        return h('button', { class: `lv-chip${f === id ? ' on' : ''}`, onclick: () => { LV.vfilter = id; drawJob(); } }, name, h('span', { class: 'lv-chip-n' }, String(n)));
      }));
      const rows = [];
      for (const v of val.filter((x) => vMatch(x, f))) {
        if (v.error) {
          rows.push(h('tr', { class: 'lv-row-skip' }, h('td', null, h('span', { class: 'mono lv-strong' }, v.label), srcLine(v)), h('td', { colspan: 4 }, pill(v.skipped ? 'soon' : 'overdue', v.skipped ? 'Não validada' : 'Erro'), h('div', { class: 'lv-sub' }, v.error))));
          continue;
        }
        const p = pctOf(v.carga, v.missing);
        const byC = (v.byColigada || []).filter(Boolean);
        const multi = byC.length > 1; const key = v.label; const open = LV.vopen.has(key);
        const toggle = multi ? h('button', { class: 'lv-toggle', 'aria-expanded': String(open), onclick: () => { if (open) LV.vopen.delete(key); else LV.vopen.add(key); drawJob(); } }, `${open ? '▾' : '▸'} ${byC.length} coligadas`) : null;
        rows.push(h('tr', { class: `lv-row ${tone(p)}` },
          h('td', null, h('span', { class: 'mono lv-strong' }, v.label), srcLine(v),
            v.rmEmpty || v.scoped === false ? h('div', { class: 'lv-tags' },
              v.rmEmpty ? h('span', { class: 'lv-tag bad', title: 'O RM não tem linhas desta tabela nas coligadas escolhidas: toda a carga delas conta como "não subiu"' }, 'RM sem linhas') : null,
              v.scoped === false ? h('span', { class: 'lv-tag', title: 'A carga não tem a coluna CODCOLIGADA: comparada inteira' }, 'carga sem coligada') : null) : null,
            toggle),
          h('td', { class: 'num' }, N(v.carga)), h('td', { class: 'num' }, N((v.carga || 0) - (v.missing || 0))),
          h('td', { class: 'num' }, v.missing ? h('span', { class: 'lv-bad-n' }, N(v.missing)) : '0'),
          h('td', null, meter(p, v.file ? `Linhas que não subiram: ${v.file}` : null))));
        if (multi && open) for (const b of byC) {
          const bp = pctOf(b.carga, b.missing);
          rows.push(h('tr', { class: `lv-row-sub${b.carga ? '' : ' off'}` },
            h('td', null, `coligada ${b.coligada}`, b.carga ? null : h('span', { class: 'lv-sub' }, ' · sem carga')),
            h('td', { class: 'num' }, N(b.carga)), h('td', { class: 'num' }, N(b.carga - b.missing)),
            h('td', { class: 'num' }, b.missing ? h('span', { class: 'lv-bad-n' }, N(b.missing)) : '0'),
            h('td', null, b.carga ? meter(bp) : h('span', { class: 'muted' }, '—'))));
        }
      }
      return h('section', { class: 'lv-block' },
        h('div', { class: 'lv-block-head' }, h('h3', null, 'Validação: carga × RM'), chips),
        rows.length ? h('div', { class: 'lv-tablewrap' }, h('table', { class: 'lv-table' },
          h('thead', null, h('tr', null, h('th', null, 'Tabela'), h('th', { class: 'num' }, 'Carga'), h('th', { class: 'num' }, 'No RM'), h('th', { class: 'num' }, 'Não subiu'), h('th', { class: 'lv-col-meter' }, '% no RM'))),
          h('tbody', null, rows))) : h('p', { class: 'muted' }, 'Nenhuma validação neste filtro.'));
    }
    function extractionBlock(ext) {
      const bad = ext.some((e) => extState(e) === 'error');
      const counts = Object.entries(EXT).map(([k, [, name]]) => [name, ext.filter((e) => extState(e) === k).length]).filter(([, n]) => n).map(([name, n]) => `${n} ${name.toLowerCase()}`).join(' · ');
      // aberta por padrão só quando há erro; a escolha do usuário vale entre redesenhos (filtros, recolher coligadas)
      return h('details', { class: 'lv-block lv-fold', open: (LV.extOpen ?? bad) || null, ontoggle: (ev) => { LV.extOpen = ev.currentTarget.open; } },
        h('summary', null, h('h3', null, 'Extração do RM → base'), h('span', { class: 'muted small' }, `${ext.length} tabela(s) · ${counts}`)),
        h('div', { class: 'lv-tablewrap' }, h('table', { class: 'lv-table' },
          h('thead', null, h('tr', null, h('th', null, 'Tabela'), h('th', { class: 'num' }, 'Linhas do RM'), h('th', null, 'Situação'))),
          h('tbody', null, ext.map((e) => { const [cls, name] = EXT[extState(e)]; return h('tr', null,
            h('td', { class: 'mono lv-strong' }, e.table), h('td', { class: 'num' }, N(e.rows)),
            h('td', null, pill(cls, name), h('div', { class: 'lv-sub' }, detailOf(e.status)))); })))));
    }
    function drawJob() {
      const j = LV.job; if (!j) { jobHost.replaceChildren(); return; }
      const pct = j.total ? (100 * j.done) / j.total : 0;
      const label = { precheck: 'Conferência (contagem no RM, uma tabela por vez)', execute: 'Extração e validação', validate: 'Validação (só leitura)', complement: 'Complemento' }[j.kind];
      const st = { running: pill('soon', 'Em andamento'), done: pill('ok', 'Concluído'), error: pill('overdue', 'Erro'), cancelled: pill('soon', 'Cancelado') }[j.status];
      const res = j.result || {};
      const secs = j.startedAt && j.updatedAt ? Math.max(0, Math.round((j.updatedAt - j.startedAt) / 1000)) : null;
      const dur = secs === null ? null : secs < 60 ? `${secs} s` : `${Math.floor(secs / 60)} min ${String(secs % 60).padStart(2, '0')} s`;
      jobHost.replaceChildren(h('div', { class: 'card lv-job' },
        h('div', { class: 'lv-job-head' }, h('h2', null, label), st, dur && j.status !== 'running' ? h('span', { class: 'muted small' }, dur) : null, h('span', { class: 'grow' }),
          j.status === 'running' ? h('button', { class: 'btn ghost sm', onclick: () => api('POST', `${BASE}/jobs/${j.id}/cancel`).catch(fail) }, 'Cancelar') : null),
        j.status === 'running' ? h('div', null, h('div', { class: 'progress' }, h('div', { style: `width:${pct}%` })), h('div', { class: 'muted small' }, j.current || '…')) : null,
        j.error ? h('p', { class: 'lv-callout bad' }, j.error) : null,
        j.kind !== 'precheck' && j.status !== 'running' ? kpis(res) : null,
        res.validation ? validationBlock(res.validation) : null,
        res.extraction ? extractionBlock(res.extraction) : null,
        res.rows ? h('section', { class: 'lv-block' }, h('div', { class: 'lv-block-head' }, h('h3', null, 'Complemento: TXT × RM')),
          h('div', { class: 'lv-tablewrap' }, h('table', { class: 'lv-table' },
            h('thead', null, h('tr', null, ['TXT', 'No RM', 'Linhas no TXT', 'A subir', 'Só no RM', 'Situação'].map((x, i) => h('th', { class: i && i < 5 ? 'num' : null }, x)))),
            h('tbody', null, res.rows.map((r) => h('tr', null, h('td', { class: 'mono lv-strong' }, r.table), h('td', { class: 'num' }, N(r.inRm)), h('td', { class: 'num' }, N(r.txtLines)), h('td', { class: 'num' }, r.toLoad ? pill('soon', N(r.toLoad)) : N(r.toLoad)), h('td', { class: 'num' }, N(r.onlyRm)), h('td', null, h('span', { class: 'lv-sub' }, r.status)))))))) : null,
        res.warnings && res.warnings.length ? h('ul', { class: 'lv-callout warn' }, res.warnings.map((w) => h('li', null, w))) : null,
        res.dir ? h('div', { class: 'lv-files' }, h('span', { class: 'muted small' }, 'Arquivos (resumo, linhas que não subiram, cópias):'), h('code', { class: 'mono' }, res.dir),
          h('button', { class: 'btn ghost sm', onclick: () => navigator.clipboard.writeText(res.dir).then(() => toast('Caminho copiado.', 'ok'), fail) }, 'Copiar caminho')) : null,
        j.log && j.log.length ? h('details', { class: 'lv-log' }, h('summary', null, `Registro (${j.log.length})`), h('pre', null, j.log.join('\n'))) : null));
    }

    const conferir = h('button', { class: 'btn', onclick: (e) => busy(e.currentTarget, async () => { LV.plan = null; drawPlan(); const r = await api('POST', `${BASE}/precheck`, params()); follow(r.jobId); }, 'Iniciando…') }, 'Conferir');
    const soValidar = h('button', { class: 'btn', onclick: (e) => busy(e.currentTarget, async () => { const p = params(); const r = await api('POST', `${BASE}/validate`, { system: p.system, connectionId: p.connectionId, database: p.database, coligadas: p.coligadas, tables: p.tables, outDir: p.outDir }); follow(r.jobId); }, 'Iniciando…') }, 'Só validar (somente leitura)');

    // ---- 4. Complemento ----
    const txtF = pathField({ value: L.txtDir || '', kind: 'folder', title: 'Pasta dos TXT gerados pelo Hop' });
    txtF.input.addEventListener('change', () => saveLast({ txtDir: txtF.get() }));
    const incl = h('input', { type: 'checkbox', checked: !!L.includeUnreferenced, onchange: () => saveLast({ includeUnreferenced: incl.checked }) });
    const gerar = h('button', { class: 'btn', onclick: (e) => busy(e.currentTarget, async () => {
      const p = params();
      saveLast({ txtDir: txtF.get() });
      const r = await api('POST', `${BASE}/complement`, { system: p.system, connectionId: p.connectionId, database: p.database, coligadas: p.coligadas, txtDir: txtF.get(), outDir: p.outDir, includeUnreferenced: incl.checked });
      follow(r.jobId);
    }, 'Iniciando…') }, 'Gerar complemento');

    const wrap = h('div', { class: 'lv-flow' },
      sec(1, 'Conexões', 'API do RM do cliente (senha protegida pelo Windows) e a base de migração (conexão cadastrada).',
        h('div', { class: 'lv-grid' },
          field('API do RM', h('div', null, h('div', { class: 'inline' }, rmSel), rmButtons, rmStatus), 'Usuário com permissão de incluir, executar e excluir Consultas SQL. Endereço: https://servidor:porta.'),
          field('Base de migração', h('div', null, h('div', { class: 'inline' }, connSel), h('div', { class: 'inline' }, dbIn, testBase), baseStatus), sqlConns.length ? 'Onde estão as ZMIGRA. As cópias do RM são gravadas aqui (dbo.<TABELA>).' : h('a', { href: '#/settings' }, 'Cadastrar conexão em Configurações → Conexões')))),
      sec(2, 'Parâmetros', `Só ${sys.usesPeriods ? 'a coligada e os períodos letivos entram' : 'a coligada entra'} nas consultas; o SQL é o modelo embutido ${sys.id === 'folha' ? 'da Folha' : `do ${sys.name}`}.`,
        h('div', { class: 'lv-grid' }, field('Coligada(s)', colIn, 'Uma ou várias, separadas por vírgula. O RM traz só essas coligadas e a validação conta só elas na carga (ZMIGRA com várias coligadas), com o resultado por coligada.'), sys.usesPeriods ? field('Períodos letivos (frequência)', perIn) : null, field('Pasta de saída', outF.el, 'Cada execução cria uma pasta nova em ValidacaoCarga\\ (resumo, linhas que não subiram, cópias das tabelas substituídas).')),
        h('div', { class: 'field' }, h('label', null, 'Tabelas'), h('div', { class: 'inline' }, allBtn(true), allBtn(false)), h('div', { class: 'lv-tables' }, tblBoxes))),
      sec(3, 'Extrair do RM e validar', 'Conferir lê a base e conta as linhas no RM. Executar cria/executa/apaga, uma por vez, as consultas temporárias no RM (tabelas grandes em partes) e substitui a tabela na base (uma transação por tabela).',
        h('div', { class: 'inline' }, conferir, soValidar), planHost),
      sys.complementReady ? sec(4, 'Gerar complemento', 'Compara os TXT do Hop com as tabelas do RM já gravadas na base e gera, numa pasta nova, só as linhas que ainda não estão no RM.',
        h('div', { class: 'lv-grid' }, field('Pasta dos TXT do Hop', txtF.el), h('label', { class: 'check' }, incl, h('span', null, 'Copiar inteiros os TXT de tabelas ainda sem referência na base'))),
        h('div', { class: 'inline' }, gerar))
        : sec(4, 'Gerar complemento', `Ainda não disponível ${sys.id === 'folha' ? 'para a Folha' : `para ${sys.name}`}: o modelo não tem as chaves dos TXT do Hop. Extrair do RM e validar funcionam normalmente.`),
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
