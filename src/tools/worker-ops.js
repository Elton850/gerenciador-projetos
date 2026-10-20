// Operações de banco das ferramentas auxiliares, executadas DENTRO do processo-filho (src/dbworker.js → op "tool:<nome>").
// Cada ferramenta registra aqui só o que precisa falar com o SQL Server; o resto (rotas, regras) fica no módulo dela.
const OPS = {
  'bt-precheck': (core, a) => require('./bt-importer/sql').precheck(core, a.conn, a.password, a.input),
  'bt-createdb': (core, a) => require('./bt-importer/sql').createDatabases(core, a.conn, a.password, a.input),
  'bt-import': (core, a, ctx) => require('./bt-importer/sql').importOne(core, a.conn, a.password, a.input, ctx),
  // Explorador de Banco: somente leitura (transação sempre desfeita no final)
  'dbx-databases': (core, a) => require('./db-explorer/sql').databases(core, a.conn, a.password),
  'dbx-catalog': (core, a) => require('./db-explorer/sql').catalog(core, a.conn, a.password),
  'dbx-sample': (core, a) => require('./db-explorer/sql').sample(core, a.conn, a.password, a.input),
  'dbx-profile': (core, a) => require('./db-explorer/sql').profile(core, a.conn, a.password, a.input),
  'dbx-check': (core, a) => require('./db-explorer/sql').checkRelationship(core, a.conn, a.password, a.input),
  'dbx-query': (core, a) => require('./db-explorer/sql').query(core, a.conn, a.password, a.input),
};

async function run(name, core, args, ctx) {
  const op = OPS[name];
  if (!op) throw new Error(`Operação desconhecida: ${name}`);
  return op(core, args, ctx);
}

module.exports = { run, OPS };
