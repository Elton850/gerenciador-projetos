// Processo-filho que executa UMA operação no SQL Server e sai. Existe para que uma conexão que "pendura"
// (VPN caída, servidor sem resposta) possa ser encerrada à força pelo processo pai sem travar o aplicativo.
const core = require('./db-core');

process.on('disconnect', () => process.exit(0)); // o pai morreu/fechou: não deixa processo órfão

// Cancelamento em ponto seguro (só operações que consultam isCancelled, ex.: Importador BT): o pai pede, a operação desfaz a
// transação no próximo lote e termina. Se não terminar a tempo, o pai encerra o processo (o SQL Server desfaz do mesmo jeito).
let cancelRequested = false;
process.on('message', (m) => { if (m && m.type === 'cancel') cancelRequested = true; });

process.once('message', async ({ op, args }) => {
  core.setOnConnected(() => process.send({ type: 'connected' }));
  const finish = (msg) => process.send(msg, () => process.exit(0));
  try {
    let value;
    if (op === 'test') value = await core.testConnection(args.conn, args.password);
    else if (op === 'precheck') value = await core.precheck(args.conn, args.password, args.tables);
    else if (op === 'execute') {
      value = await core.executePlan(args.conn, args.password, args.plan, {
        dryRun: args.dryRun, allowDestructive: args.allowDestructive, allowDestructiveScripts: args.allowDestructiveScripts,
        onProgress: (done, total) => process.send({ type: 'progress', done, total }),
      });
    } else if (op === 'runscript') value = await core.runScript(args.conn, args.password, args.script);
    else if (op.startsWith('tool:')) value = await require('./tools/worker-ops').run(op.slice(5), core, args, {
      progress: (info) => process.send({ type: 'progress', done: info.done || 0, total: info.total || 0, info }),
      isCancelled: () => cancelRequested,
    });
    else throw new Error(`Operação desconhecida: ${op}`);
    finish({ type: 'result', value });
  } catch (e) {
    finish({ type: 'error', message: e.message, status: e.status, executed: e.executed, scriptOutput: e.scriptOutput, code: /^BT_/.test(e.code || '') ? e.code : undefined, cancelled: e.cancelled });
  }
});
