// Importador BT → SQL — rotas (sob /api/tools/bt-importer). Fluxo: listar arquivos → validar (job: lê cada arquivo em
// streaming + pré-checagem somente leitura no SQL Server → plano com hash) → importar (job: cria os bancos que faltam e
// importa arquivo a arquivo, cada um na sua transação, no processo-filho do banco) → resumo + histórico + auditoria.
//
// Reaproveita o sistema de conexões (só conexões CADASTRADAS: resolveConn/connPassword/DPAPI), o acesso ao banco em
// processo-filho (db.runWorker, assertReachable, friendly) e a auditoria. Nunca guarda conteúdo dos arquivos, senha ou
// connection string: auditoria/histórico só com arquivo, banco, tabelas, quantidades, duração e erro sem valores.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { httpError, str } = require('../../util');
const P = require('./plan');
const { scanFile } = require('./parse');

const PLAN_TTL_MS = 20 * 60 * 1000;
const JOB_KEEP_MS = 2 * 60 * 60 * 1000;

function mount(app, { store, audit, db, resolveConn, connPassword, whoAmI, pickFiles, pickFolder }, base) {
  const state = () => P.ensureData(store.data);
  const plans = new Map();
  const jobs = new Map();
  const cleanup = () => {
    const now = Date.now();
    for (const [id, p] of plans) if (p.expiresAt < now) plans.delete(id);
    for (const [id, j] of jobs) if (j.status !== 'running' && now - j.updatedAt > JOB_KEEP_MS) jobs.delete(id);
  };
  const running = () => [...jobs.values()].find((j) => j.status === 'running');

  // ---------- Conexão (só cadastrada; a senha é aberta só na hora, pelo DPAPI) ----------
  function savedConnection(id) {
    const saved = store.data.connections.find((c) => c.id === str(id, 40));
    if (!saved) throw httpError(400, 'Escolha uma conexão cadastrada (Configurações → Conexões).', { code: 'BT_NO_CONNECTION' });
    const conn = resolveConn({ connectionId: saved.id, database: 'master' });
    return { saved, conn: { ...conn, database: 'master' } };
  }
  const fingerprint = (c) => crypto.createHash('sha256').update(JSON.stringify([c.id, c.server, c.port || null, c.auth, c.user || '', c.encrypt !== false, c.trustServerCertificate !== false])).digest('hex');
  const target = (saved) => ({ connectionId: saved.id, connectionName: saved.name, env: saved.env, server: db.label(saved), auth: saved.auth });

  // ---------- Arquivos ----------
  function checkFile(p) {
    const fp = str(p, 1000);
    if (!fp || !path.isAbsolute(fp)) throw httpError(400, `Caminho inválido: ${fp || '(vazio)'}`);
    if (path.extname(fp).toLowerCase() !== '.bt') throw httpError(400, `Não é um arquivo .bt: ${path.basename(fp)}`);
    let st;
    try { st = fs.statSync(fp); } catch { throw httpError(400, `Arquivo não encontrado: ${fp}`, { code: 'BT_FILE_MISSING' }); }
    if (!st.isFile()) throw httpError(400, `Não é um arquivo: ${fp}`);
    return { path: path.normalize(fp), name: path.basename(fp), size: st.size, mtimeMs: st.mtimeMs };
  }
  // Pasta: só arquivos .bt (sem diferenciar maiúsculas na extensão), em ordem do caminho completo; subpastas só se pedido
  // (mesma regra do "Ler .bt" / "Incluir subpastas" do app original).
  function listDir(dir, recursive) {
    const d = str(dir, 1000);
    if (!d || !path.isAbsolute(d)) throw httpError(400, 'Informe uma pasta válida.');
    try { if (!fs.statSync(d).isDirectory()) throw new Error(); } catch { throw httpError(400, `Pasta não encontrada: ${d}`, { code: 'BT_DIR_MISSING' }); }
    const out = [];
    const walk = (cur) => {
      let entries;
      try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch (e) { if (cur === d) throw httpError(400, `Sem permissão para ler a pasta ${d}.`); return; }
      for (const e of entries) {
        const full = path.join(cur, e.name);
        if (e.isFile() && path.extname(e.name).toLowerCase() === '.bt') out.push(full);
        else if (recursive && e.isDirectory()) walk(full);
      }
    };
    walk(d);
    out.sort();
    if (out.length > P.MAX_FILES) throw httpError(400, `A pasta tem ${out.length} arquivos .bt; o limite por importação é ${P.MAX_FILES}.`);
    return out.map((f) => ({ ...checkFile(f), rel: path.relative(d, f) }));
  }
  const withDefaults = (files) => files.map((f) => ({ ...f, rel: f.rel || f.name, database: P.defaultDbName(f.name) }));

  app.get(`${base}/settings`, (req, res) => res.json({ settings: state().settings, defaults: P.DEFAULT_SETTINGS }));
  app.put(`${base}/settings`, (req, res) => {
    const s = state();
    s.settings = P.cleanSettings(req.body || {}, s.settings);
    store.save();
    audit.log({ action: 'bt-config-alterada', detalhe: `Importador BT: ${s.settings.onlyAllowed ? `${s.settings.allowedTables.length} tabela(s) permitida(s)` : 'todas as tabelas'}, lote ${s.settings.batchSize}, colunas que faltam: ${s.settings.addMissingColumns ? 'adicionar' : 'bloquear'}` });
    res.json({ settings: s.settings });
  });
  app.get(`${base}/history`, (req, res) => res.json(state().history));

  app.post(`${base}/pick`, async (req, res) => {
    const mode = req.body?.mode === 'folder' ? 'folder' : 'files';
    if (mode === 'folder') {
      const dir = await pickFolder({ title: 'Selecione a pasta com os arquivos .bt' });
      return res.json(dir ? { dir } : { canceled: true });
    }
    const paths = await pickFiles({ title: 'Selecione os arquivos .bt', filter: 'bt' });
    return res.json(paths.length ? { paths } : { canceled: true });
  });

  app.post(`${base}/list`, (req, res) => {
    const b = req.body || {};
    if (b.dir) return res.json({ dir: str(b.dir, 1000), files: withDefaults(listDir(b.dir, !!b.recursive)) });
    const paths = Array.isArray(b.paths) ? b.paths : [];
    if (!paths.length) throw httpError(400, 'Nenhum arquivo informado.');
    if (paths.length > P.MAX_FILES) throw httpError(400, `No máximo ${P.MAX_FILES} arquivos por importação.`);
    const seen = new Set();
    const files = [];
    for (const p of paths) { const f = checkFile(p); if (!seen.has(f.path.toLowerCase())) { seen.add(f.path.toLowerCase()); files.push(f); } }
    res.json({ files: withDefaults(files) });
  });

  // ---------- Validar (job) ----------
  app.post(`${base}/validate`, async (req, res) => {
    cleanup();
    const b = req.body || {};
    const { saved, conn } = savedConnection(b.connectionId);
    const settings = P.cleanSettings({ ...(b.options || {}), allowedTables: undefined, namePattern: undefined }, state().settings);
    const input = Array.isArray(b.files) ? b.files : [];
    if (!input.length) throw httpError(400, 'Nenhum arquivo selecionado.');
    if (input.length > P.MAX_FILES) throw httpError(400, `No máximo ${P.MAX_FILES} arquivos por importação.`);
    const files = input.map((f) => ({ ...checkFile(f.path), database: str(f.database, 200) }));
    const job = { id: crypto.randomBytes(8).toString('hex'), kind: 'validate', status: 'running', total: files.length, done: 0, current: null, bytes: 0, size: files.reduce((n, f) => n + f.size, 0), startedAt: Date.now(), updatedAt: Date.now() };
    jobs.set(job.id, job);
    res.json({ jobId: job.id });

    try {
      const allowed = P.isAllowedFn(settings);
      let before = 0;
      for (const f of files) {
        job.current = f.name;
        try {
          f.scan = await scanFile(f.path, { isAllowed: allowed, onChunk: (n) => { job.bytes = before + n; job.updatedAt = Date.now(); } });
          f.sha256 = f.scan.sha256;
        } catch (e) {
          f.scan = { error: `Arquivo inválido: não foi possível ler (${e.code || e.message}).` };
        }
        before += f.size; job.bytes = before; job.done++;
      }
      // Pré-checagem somente leitura: bancos e tabelas que os arquivos realmente vão usar.
      job.current = 'Conferindo o servidor SQL…';
      const need = new Map();
      for (const m of P.canonicalizeDatabases(files.map((f) => ({ database: f.database, scan: f.scan })))) {
        if (P.dbNameError(m.database) || !m.scan || m.scan.error) continue;
        const e = need.get(m.database.toLowerCase()) || { name: m.database, tables: new Set() };
        need.set(m.database.toLowerCase(), e);
        for (const t of m.scan.tables || []) if (t.allowed) e.tables.add(t.name);
      }
      let pre;
      try {
        db.validateConnection(conn);
        await db.assertReachable(conn);
        pre = await db.runWorker('tool:bt-precheck', { conn, password: await connPassword(conn), input: { databases: [...need.values()].map((d) => ({ name: d.name, tables: [...d.tables] })) } });
      } catch (e) {
        throw Object.assign(new Error(`Falha de conexão com “${saved.name}”: ${db.friendly(e)}`), { code: e.code || 'BT_CONNECTION' });
      }
      const plan = P.buildValidation({ files, settings, target: pre, connection: fingerprint(saved) });
      const id = crypto.randomBytes(8).toString('hex');
      const expiresAt = Date.now() + PLAN_TTL_MS;
      plans.set(id, { id, hash: plan.hash, expiresAt, connectionId: saved.id, fingerprint: fingerprint(saved), settings, plan });
      job.result = { planId: id, expiresAt, target: { ...target(saved), login: pre.identity.login, connectedTo: pre.identity.server, version: pre.identity.version }, settings, ...plan };
      job.status = 'done';
    } catch (e) {
      job.status = 'error'; job.error = e.message; job.code = e.code;
    }
    job.current = null; job.updatedAt = Date.now();
  });

  // ---------- Importar (job) ----------
  app.post(`${base}/plans/:id/execute`, async (req, res) => {
    cleanup();
    const b = req.body || {};
    const pl = plans.get(req.params.id);
    if (!pl) throw httpError(410, 'A validação expirou ou já foi usada. Valide de novo.', { code: 'BT_PLAN_EXPIRED' });
    if (b.hash !== pl.hash || b.authorized !== true) throw httpError(400, 'Confirmação inválida: valide de novo antes de importar.');
    if (!pl.plan.canExecute) throw httpError(409, 'A validação encontrou problemas. Corrija-os antes de importar.', { code: 'BT_BLOCKED' });
    if (running()) throw httpError(409, 'Já existe uma importação em andamento. Aguarde terminar ou cancele.', { code: 'BT_BUSY' });
    const { saved, conn } = savedConnection(pl.connectionId);
    if (fingerprint(saved) !== pl.fingerprint) throw httpError(409, 'A conexão foi alterada depois da validação. Valide de novo.', { code: 'BT_PLAN_EXPIRED' });
    const dbs = pl.plan.groups.filter((g) => g.tables.length);
    if (saved.env !== 'local' && b.confirmed !== true) {
      const env = { prod: 'PRODUÇÃO', hml: 'Homologação', dev: 'Desenvolvimento' }[saved.env] || saved.env;
      throw httpError(409, `Importar em ${env} (${saved.name} · ${db.label(saved)})?\n\n${dbs.map((g) => `${g.createDatabase ? 'Criar e importar' : 'Acrescentar em'} ${g.database}: ${g.tables.map((t) => t.name).join(', ')}`).join('\n')}`, { code: 'BT_CONFIRM' });
    }
    plans.delete(pl.id); // uso único
    const password = await connPassword(conn);
    const items = pl.plan.items.filter((i) => i.status === 'ok');
    const ac = new AbortController();
    const by = whoAmI();
    const job = {
      id: crypto.randomBytes(8).toString('hex'), kind: 'import', status: 'running', total: items.length, done: 0, current: null, startedAt: Date.now(), updatedAt: Date.now(),
      target: target(saved),
      items: items.map((i) => ({ name: i.name, database: i.database, size: i.size, expectedRows: i.rows, status: 'pending', rows: 0, bytes: 0, table: null, tables: {}, error: null, ms: null })),
    };
    jobs.set(job.id, job);
    job.cancel = () => { job.cancelRequested = true; ac.abort(); };
    res.json({ jobId: job.id });

    const meta = { by, detalhe: saved.name, server: db.label(saved), env: saved.env };
    audit.log({ action: 'bt-importacao-iniciada', ...meta, arquivos: items.length, bancos: dbs.map((g) => g.database).join(', '), hash: pl.hash });
    try {
      // 1) Bancos que ainda não existem (fora de transação, como o CREATE DATABASE exige).
      const toCreate = dbs.filter((g) => g.createDatabase).map((g) => g.database);
      if (toCreate.length) {
        job.current = `Criando ${toCreate.length} banco(s)…`;
        const r = await db.runWorker('tool:bt-createdb', { conn, password, input: { names: toCreate } });
        for (const name of r.created) audit.log({ action: 'bt-banco-criado', ...meta, database: name });
      }
      // 2) Arquivo a arquivo, cada um na sua transação no banco de destino.
      for (let k = 0; k < items.length; k++) {
        const it = job.items[k];
        if (job.cancelRequested) { it.status = 'cancelled'; continue; }
        if (job.stopped) { it.status = 'skipped'; it.error = 'Não executado: a importação parou no erro anterior.'; continue; }
        it.status = 'running'; job.current = it.name; job.updatedAt = Date.now();
        const t0 = Date.now();
        try {
          const r = await db.runWorker('tool:bt-import', { conn: { ...conn, database: it.database }, password, input: { filePath: items[k].path, expectedSha: items[k].sha256, settings: pl.settings } }, {
            signal: ac.signal, gracefulCancel: true,
            onProgress: (done, total, info) => { if (info) { if (info.bytes != null) it.bytes = info.bytes; if (info.rows != null) it.rows = info.rows; if (info.table) it.table = info.table; } job.updatedAt = Date.now(); },
          });
          Object.assign(it, { status: 'done', rows: r.rows, tables: r.tables, bytes: it.size, table: null, ms: Date.now() - t0, created: r.created, altered: r.altered });
          audit.log({ action: 'bt-arquivo-importado', ...meta, database: it.database, arquivo: it.name, linhas: r.rows, duracaoMs: it.ms, tabelas: Object.entries(r.tables).map(([tabela, linhas]) => ({ tabela, linhas, arquivo: it.name })) });
        } catch (e) {
          it.ms = Date.now() - t0; it.table = null;
          if (e.cancelled || job.cancelRequested) { it.status = 'cancelled'; it.error = 'Cancelado: o que este arquivo já tinha gravado foi desfeito.'; job.cancelRequested = true; continue; }
          it.status = 'error';
          it.error = `Arquivo ${k + 1} de ${items.length} falhou: ${db.friendly(e)} — nada deste arquivo ficou no banco.`;
          audit.log({ action: 'bt-arquivo-falhou', ...meta, database: it.database, arquivo: it.name, erro: P.sanitizeError(db.friendly(e)), resultado: 'ROLLBACK' });
          if (pl.settings.stopOnError) job.stopped = true;
        } finally {
          job.done = k + 1; job.updatedAt = Date.now();
        }
      }
      job.status = job.cancelRequested ? 'cancelled' : 'done';
    } catch (e) {
      job.status = 'error'; job.error = `Falha antes de importar: ${db.friendly(e)}`;
      for (const it of job.items) if (it.status === 'pending') it.status = 'skipped';
      audit.log({ action: 'bt-importacao-falhou', ...meta, erro: P.sanitizeError(db.friendly(e)) });
    }
    const ok = job.items.filter((i) => i.status === 'done');
    const failed = job.items.filter((i) => i.status === 'error');
    const summary = P.summarize(job.items.map((i) => ({ ...i })));
    job.result = { ok: ok.length, failed: failed.length, cancelled: job.items.filter((i) => i.status === 'cancelled').length, skipped: job.items.filter((i) => i.status === 'skipped').length, rows: ok.reduce((n, i) => n + i.rows, 0), databases: summary, durationMs: Date.now() - job.startedAt };
    job.current = null; job.updatedAt = Date.now();
    const result = job.status === 'error' ? 'erro' : job.status === 'cancelled' ? 'cancelada' : failed.length ? 'com falhas' : 'sucesso';
    audit.log({ action: job.status === 'cancelled' ? 'bt-importacao-cancelada' : failed.length || job.status === 'error' ? 'bt-importacao-com-falhas' : 'bt-importacao-concluida', ...meta, resultado: `${ok.length} de ${items.length} arquivo(s) · ${job.result.rows} registro(s)` });
    const h = state().history;
    h.unshift({ at: new Date().toISOString(), by, connection: saved.name, env: saved.env, server: db.label(saved), files: items.length, ok: ok.length, failed: failed.length,
      databases: summary.map((d) => d.database), tables: summary.reduce((n, d) => n + d.tables.length, 0), rows: job.result.rows, result, durationMs: job.result.durationMs });
    h.splice(P.HISTORY_MAX);
    store.save();
  });

  app.get(`${base}/jobs/:id`, (req, res) => {
    const j = jobs.get(req.params.id);
    if (!j) throw httpError(404, 'Execução não encontrada.');
    const { cancel, ...pub } = j;
    res.json(pub);
  });
  app.post(`${base}/jobs/:id/cancel`, (req, res) => {
    const j = jobs.get(req.params.id);
    if (!j) throw httpError(404, 'Execução não encontrada.');
    if (j.status === 'running' && j.cancel) j.cancel();
    res.json({ ok: true });
  });
}

module.exports = { mount };
