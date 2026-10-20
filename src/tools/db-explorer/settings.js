// Explorador de Banco — dados persistidos em data.tools.dbExplorer = { settings, notes }. ensureData roda na carga (applyDefaults),
// é idempotente e nunca apaga o que já existe. Anotações: texto livre por tabela, chave "<conexão>|<banco>|<schema.tabela>" (minúsculas).
const DEFAULT_SETTINGS = Object.freeze({
  sampleRows: 100, // amostra de linhas por tabela
  queryLimit: 500, // linhas lidas pelo Console SQL
  profileRows: 50000, // linhas usadas no perfil das colunas
  checkRows: 10000, // linhas da origem usadas ao conferir um relacionamento
  maskSensitive: true, // mascara colunas com nome sensível (CPF, e-mail, senha…) em amostras e no Console
  inferMinScore: 55, // pontuação mínima das hipóteses
  maxNodes: 80, // limite de tabelas no mapa
  hubThreshold: 0, // conexões a partir das quais uma tabela é "hub" (0 = automático pelo tamanho do banco)
});
const NOTE_MAX = 4000;
const NOTES_MAX = 5000;

const int = (v, min, max, dflt) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt; };
function cleanSettings(input, current = DEFAULT_SETTINGS) {
  const b = input || {}; const c = { ...DEFAULT_SETTINGS, ...current };
  return {
    sampleRows: int(b.sampleRows ?? c.sampleRows, 1, 1000, c.sampleRows),
    queryLimit: int(b.queryLimit ?? c.queryLimit, 1, 5000, c.queryLimit),
    profileRows: int(b.profileRows ?? c.profileRows, 100, 1000000, c.profileRows),
    checkRows: int(b.checkRows ?? c.checkRows, 100, 200000, c.checkRows),
    maskSensitive: b.maskSensitive === undefined ? !!c.maskSensitive : !!b.maskSensitive,
    inferMinScore: int(b.inferMinScore ?? c.inferMinScore, 30, 95, c.inferMinScore),
    maxNodes: int(b.maxNodes ?? c.maxNodes, 10, 250, c.maxNodes),
    hubThreshold: int(b.hubThreshold ?? c.hubThreshold, 0, 5000, c.hubThreshold),
  };
}

function ensureData(data) {
  if (!data.tools || typeof data.tools !== 'object') data.tools = {};
  const s = data.tools.dbExplorer && typeof data.tools.dbExplorer === 'object' ? data.tools.dbExplorer : (data.tools.dbExplorer = {});
  s.settings = cleanSettings(s.settings || {}, { ...DEFAULT_SETTINGS, ...(s.settings || {}) });
  if (!s.notes || typeof s.notes !== 'object' || Array.isArray(s.notes)) s.notes = {};
  return s;
}

const noteKey = (connectionId, database, table) => `${connectionId}|${String(database).toLowerCase()}|${String(table).toLowerCase()}`;

module.exports = { DEFAULT_SETTINGS, cleanSettings, ensureData, noteKey, NOTE_MAX, NOTES_MAX };
