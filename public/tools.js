// Ferramentas Auxiliares: área com um card por ferramenta (lista vem do servidor: GET /api/tools, src/tools/registry.js).
// Cada ferramenta registra a própria tela em GP_TOOLS['<id>'] = { render(main, tool) } no seu arquivo public/tool-<id>.js.
// Rotas: #/tools (lista) e #/tools/<id> (a ferramenta).
window.GP_TOOLS = window.GP_TOOLS || {};
let TOOLS_CACHE = null;

async function toolsList() {
  if (!TOOLS_CACHE) TOOLS_CACHE = await api('GET', '/api/tools');
  return TOOLS_CACHE;
}

async function renderTools(main, toolId) {
  main.append(h('div', { class: 'page' }, h('div', { class: 'empty' }, 'Carregando…')));
  let list;
  try { list = await toolsList(); } catch (e) { return fail(e); }
  if (route().name !== 'tools') return;
  if (toolId) {
    const tool = list.find((t) => t.id === toolId);
    const view = tool && window.GP_TOOLS[tool.id];
    if (!view) { location.hash = '#/tools'; return; }
    main.replaceChildren();
    return view.render(main, tool);
  }
  main.replaceChildren(h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('div', { class: 'grow' }, h('h1', null, 'Ferramentas Auxiliares'),
      h('div', { class: 'muted' }, 'Utilitários que complementam o trabalho de migração, fora do fluxo dos projetos.'))),
    list.length ? h('div', { class: 'tool-grid' }, list.map((t) => h('div', { class: 'tool-card' },
      h('div', { class: 'inline', style: 'gap:8px' }, icon(t.icon || 'grid', 18), h('strong', null, t.name)),
      h('div', { class: 'muted small' }, t.description),
      t.permissions?.length ? h('div', { class: 'small muted', title: 'O que esta ferramenta exige para executar' }, `Requer: ${t.permissions.join(' · ')}`) : null,
      h('div', { class: 'inline' }, h('span', { class: 'spacer', style: 'flex:1' }), h('button', { class: 'btn primary', onclick: () => (location.hash = `#/tools/${t.id}`) }, 'Abrir')))))
      : h('div', { class: 'card' }, h('div', { class: 'card-body' }, h('div', { class: 'empty' }, 'Nenhuma ferramenta disponível.')))));
}
