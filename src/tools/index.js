// Ferramentas Auxiliares: monta as rotas de cada ferramenta do registro e a lista usada pela tela (GET /api/tools).
const { TOOLS, publicTools } = require('./registry');

function mount(app, deps) {
  app.get('/api/tools', (req, res) => res.json(publicTools()));
  for (const t of TOOLS) t.api().mount(app, deps, `/api/tools/${t.id}`);
}

// Na carga dos dados (applyDefaults): cada ferramenta completa os próprios campos, de forma idempotente.
function ensureTools(data) {
  if (!data.tools || typeof data.tools !== 'object') data.tools = {};
  for (const t of TOOLS) if (t.ensure) t.ensure(data);
}

module.exports = { mount, ensureTools };
