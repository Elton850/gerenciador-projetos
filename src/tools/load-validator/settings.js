// Validação de Carga — dados persistidos em data.tools.loadValidator (completados na carga por ensureData, idempotente):
//   rm:   conexões da API do RM { id, name, url, user, passwordEnc (DPAPI), createdAt, updatedAt } — a senha nunca vai à tela;
//   last: últimas escolhas da tela (sistema, conexões, banco, coligada, períodos, pastas, tabelas) — conveniência.
'use strict';

function ensureData(data) {
  if (!data.tools || typeof data.tools !== 'object') data.tools = {};
  const s = data.tools.loadValidator && typeof data.tools.loadValidator === 'object' ? data.tools.loadValidator : {};
  if (!Array.isArray(s.rm)) s.rm = [];
  if (!s.last || typeof s.last !== 'object') s.last = {};
  data.tools.loadValidator = s;
  return s;
}

const publicRm = (c) => ({ id: c.id, name: c.name, url: c.url, user: c.user, hasPassword: !!c.passwordEnc, createdAt: c.createdAt, updatedAt: c.updatedAt });

const LAST_KEYS = ['system', 'rmId', 'connectionId', 'database', 'coligada', 'coligadas', 'periods', 'outDir', 'txtDir', 'tables', 'includeUnreferenced'];
function cleanLast(input = {}) {
  const out = {};
  for (const k of LAST_KEYS) if (input[k] !== undefined) out[k] = input[k];
  if (out.tables && !Array.isArray(out.tables)) delete out.tables;
  for (const k of ['system', 'rmId', 'connectionId', 'database', 'periods', 'outDir', 'txtDir']) if (out[k] !== undefined) out[k] = String(out[k]).slice(0, 500);
  if (out.coligadas !== undefined) out.coligadas = String(out.coligadas).slice(0, 300); // texto da tela ("1, 2, 5"); validado ao usar
  if (out.coligada !== undefined) out.coligada = Number(out.coligada) || 0;
  if (out.tables) out.tables = out.tables.map((t) => String(t).slice(0, 64)).slice(0, 100);
  if (out.includeUnreferenced !== undefined) out.includeUnreferenced = !!out.includeUnreferenced;
  return out;
}

module.exports = { ensureData, publicRm, cleanLast };
