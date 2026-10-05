// Migrações de esquema dos dados (projects.json), incrementais e rastreáveis.
//
//   data.schemaVersion        número do esquema já aplicado (dados sem o campo = 0)
//   data.migrations[]         histórico { id, name, at, appVersion } — o que já foi aplicado nesta instalação
//
// Cada versão do aplicativo que MUDA a estrutura persistente acrescenta UMA entrada no fim de MIGRATIONS (id = anterior + 1), com
// `up(data)` que só transforma (nunca apaga dado do usuário). Na carga (Store._load): dados mais novos que o aplicativo → o app NÃO
// abre (evita gravar por cima de campos que esta versão não conhece); pendentes → cópia do arquivo antes, aplica em ordem, grava.
// `applyDefaults` continua como normalizador idempotente (completa campos ausentes) e roda antes das migrações.
'use strict';

const MIGRATIONS = [
  // Linha de base do versionamento: marca os dados existentes como esquema 1 (nenhuma transformação).
  { id: 1, name: 'linha de base do versionamento de esquema', up: () => {} },
];

const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].id;

const currentSchema = (data) => (Number.isInteger(data?.schemaVersion) ? data.schemaVersion : 0);

function pending(data, list = MIGRATIONS) {
  const v = currentSchema(data);
  return list.filter((m) => m.id > v);
}

// Aplica as pendentes, em ordem. Falhou uma → lança (quem chama não grava nada: a memória é descartada).
function runMigrations(data, { appVersion = '', list = MIGRATIONS, now = () => new Date().toISOString() } = {}) {
  const todo = pending(data, list);
  if (!Array.isArray(data.migrations)) data.migrations = [];
  for (const m of todo) {
    m.up(data);
    data.schemaVersion = m.id;
    data.migrations.push({ id: m.id, name: m.name, at: now(), appVersion });
  }
  return todo.map((m) => m.id);
}

function tooNew(data, schema = SCHEMA_VERSION) { return currentSchema(data) > schema; }

module.exports = { MIGRATIONS, SCHEMA_VERSION, currentSchema, pending, runMigrations, tooNew };
