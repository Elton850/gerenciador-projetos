// Validação de Carga — rotas (sob /api/tools/load-validator). Confere se a carga (tabelas ZMIGRA_* da base de migração) foi de fato
// para o RM do cliente: extrai as tabelas do RM por consultas SQL temporárias (criar → executar → apagar), grava cada uma na base
// de migração com o nome da tabela raiz (SALUNO, STURMADISC…), roda as validações embutidas e gera os TXT complementares.
//
// Fluxo com trava: Conferir (pré-checagem só leitura → plano com hash, uso único, 15 min) → Executar (autorização explícita +
// confirmação 409 LV_CONFIRM fora do ambiente local) → trabalho com progresso. "Só validar" e "Gerar complemento" só leem a base.
// Segurança: SQL nunca vem da tela (modelo embutido + coligada/períodos validados); escrita no RM só de consultas ZMV.* da
// ferramenta (rm.js); escrita na base só das tabelas do modelo, uma transação por tabela, com cópia CSV da tabela atual antes;
// senhas: SQL pelas conexões cadastradas, RM pela DPAPI (nunca devolvida à tela nem auditada); auditoria só com metadados.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { httpError, str, uid } = require('../../util');
const C = require('./catalog');
const S = require('./settings');
const RM = require('./rm');

const PLAN_TTL_MS = 15 * 60 * 1000;
const RM_PARALLEL = 4;
const MAX_LOG = 400;
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);

function mount(app, deps, base) {
  const { store, audit, db, resolveConn, connPassword, whoAmI, protect, unprotect } = deps;
  const state = () => S.ensureData(store.data);
  const plans = new Map();
  const jobs = new Map();
  const running = () => [...jobs.values()].some((j) => j.status === 'running');
  const cleanup = () => { const now = Date.now(); for (const [k, p] of plans) if (p.expiresAt < now) plans.delete(k); for (const [k, j] of jobs) if (j.status !== 'running' && now - j.updatedAt > 6 * 3600 * 1000) jobs.delete(k); };

  // ---------- Conexões ----------
  function sqlTarget(connectionId, database) {
    const saved = store.data.connections.find((c) => c.id === str(connectionId, 40));
    if (!saved) throw httpError(400, 'Escolha a conexão da base de migração (Configurações → Conexões).', { code: 'LV_NO_CONNECTION' });
    const dbName = str(database, 128) || saved.database;
    if (!dbName || !/^[\p{L}\p{N}_][\p{L}\p{N}_\-. ]{0,127}$/u.test(dbName)) throw httpError(400, 'Informe o banco da base de migração.');
    const conn = { ...resolveConn({ connectionId: saved.id, database: dbName }), database: dbName };
    return { saved, conn, info: { connectionId: saved.id, connectionName: saved.name, env: saved.env, server: db.label(saved), database: dbName } };
  }
  const fingerprint = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');
  const rmById = (id) => { const c = state().rm.find((x) => x.id === str(id, 40)); if (!c) throw httpError(400, 'Escolha a conexão da API do RM.', { code: 'LV_NO_RM' }); return c; };
  async function rmOpen(c) {
    if (!c.passwordEnc) throw httpError(400, `Informe a senha da conexão do RM “${c.name}”.`);
    let password;
    try { password = await unprotect(c.passwordEnc); } catch (e) {
      if (e.code !== 'PASSWORD_UNREADABLE') throw e;
      throw httpError(409, `Não foi possível ler a senha salva da conexão do RM “${c.name}” neste usuário do Windows (DPAPI). Edite a conexão, informe a senha de novo e salve. Nada foi executado.`, { code: 'PASSWORD_UNREADABLE' });
    }
    return { url: c.url, user: c.user, password };
  }
  async function worker(conn, op, input, opts = {}) {
    db.validateConnection(conn);
    await db.assertReachable(conn);
    return db.runWorker(`tool:${op}`, { conn, password: await connPassword(conn), input }, opts);
  }
  function outDirOf(raw, what = 'pasta de saída') {
    const p = str(raw, 500);
    if (!p || !path.isAbsolute(p)) throw httpError(400, `Escolha a ${what}.`);
    const full = path.resolve(p);
    let st; try { st = fs.statSync(full); } catch { throw httpError(400, `A ${what} não existe: ${full}`); }
    if (!st.isDirectory()) throw httpError(400, `A ${what} não é uma pasta: ${full}`);
    return full;
  }
  const runDir = (outDir, kind) => { const d = path.join(outDir, 'ValidacaoCarga', `${stamp()}_${kind}`); fs.mkdirSync(d, { recursive: true }); return d; };
  const fileSafe = (s) => String(s).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');

  // ---------- Estado / modelos ----------
  app.get(`${base}/state`, (req, res) => {
    const s = state();
    res.json({
      systems: Object.values(C.SYSTEMS).map((sy) => ({ id: sy.id, name: sy.name, ready: sy.ready, tables: sy.tables.map((t) => ({ table: t.table, code: C.consultaCode(t.table), validations: t.validations.map((v) => v.label), complement: sy.complement.some((k) => k.rmTable === t.table) })) })),
      rm: s.rm.map(S.publicRm), last: s.last,
    });
  });
  app.put(`${base}/last`, (req, res) => { state().last = S.cleanLast(req.body || {}); store.save(); res.json({ ok: true }); });

  // ---------- Conexões da API do RM (senha DPAPI) ----------
  async function rmFromBody(b, existing) {
    const name = str(b.name, 80); const user = str(b.user, 120);
    if (!name) throw httpError(400, 'Informe um nome para a conexão do RM.');
    if (!user) throw httpError(400, 'Informe o usuário do RM.');
    let url; try { url = RM.cleanUrl(b.url); } catch (e) { throw httpError(400, e.message); }
    const passwordEnc = b.password ? await protect(String(b.password)) : existing?.passwordEnc || null;
    if (!passwordEnc) throw httpError(400, 'Informe a senha do RM.');
    return { name, url, user, passwordEnc };
  }
  app.post(`${base}/rm`, async (req, res) => {
    const s = state(); const now = new Date().toISOString();
    const c = { id: uid(), ...(await rmFromBody(req.body || {})), createdAt: now, updatedAt: now };
    s.rm.push(c); store.save();
    audit.log({ action: 'lv-rm-cadastrado', by: whoAmI(), detalhe: c.name, server: c.url });
    res.json(S.publicRm(c));
  });
  app.put(`${base}/rm/:id`, async (req, res) => {
    const c = rmById(req.params.id);
    Object.assign(c, await rmFromBody(req.body || {}, c), { updatedAt: new Date().toISOString() }); store.save();
    audit.log({ action: 'lv-rm-alterado', by: whoAmI(), detalhe: c.name, server: c.url });
    res.json(S.publicRm(c));
  });
  app.delete(`${base}/rm/:id`, (req, res) => {
    const s = state(); const c = rmById(req.params.id);
    s.rm = s.rm.filter((x) => x.id !== c.id);
    (s.rmRemovidas = s.rmRemovidas || []).push({ id: c.id, name: c.name, url: c.url, user: c.user, removedAt: new Date().toISOString() }); // sem a senha
    store.save();
    audit.log({ action: 'lv-rm-removido', by: whoAmI(), detalhe: c.name, server: c.url });
    res.json({ ok: true });
  });
  app.post(`${base}/rm/:id/test`, async (req, res) => {
    const c = rmById(req.params.id);
    try { res.json({ ...(await RM.test(await rmOpen(c))), name: c.name, url: c.url }); } catch (e) { if (e.status) throw e; res.json({ ok: false, error: e.message }); }
  });

  // ---------- Base de migração: teste (só leitura) ----------
  app.post(`${base}/base/test`, async (req, res) => {
    const b = req.body || {};
    const { conn, info } = sqlTarget(b.connectionId, b.database);
    try {
      const r = await worker(conn, 'lv-precheck', { rmTables: [], sourceTables: [] });
      res.json({ ok: true, ...info, login: r.identity.login, connectedTo: r.identity.server, canCreate: r.canCreate, canAlter: r.canAlter, canInsert: r.canInsert, canSelect: r.canSelect });
    } catch (e) { res.json({ ok: false, ...info, error: db.friendly(e) }); }
  });

  // ---------- Conferir (só leitura) → plano ----------
  function inputOf(b) {
    let sys; try { sys = C.systemOf(b.system); } catch (e) { throw httpError(400, e.message); }
    let params; try { params = C.cleanParams({ coligada: b.coligada, periods: b.periods }); } catch (e) { throw httpError(400, e.message); }
    let defs; try { defs = C.pickTables(sys, b.tables); } catch (e) { throw httpError(400, e.message); }
    if (!defs.length) throw httpError(400, 'Escolha ao menos uma tabela.');
    return { sys, params, defs };
  }
  app.post(`${base}/precheck`, async (req, res) => {
    cleanup();
    const b = req.body || {};
    const { sys, params, defs } = inputOf(b);
    const { saved, conn, info } = sqlTarget(b.connectionId, b.database);
    const rmc = rmById(b.rmId);
    const outDir = outDirOf(b.outDir);
    const sentences = defs.map((d) => { try { return C.renderRm(d, params); } catch (e) { throw httpError(400, `${d.table}: ${e.message}`); } });
    const sources = [...new Set(defs.flatMap((d) => d.validations.map((v) => C.sourceOf(v.sql)).filter(Boolean)))];
    let pre;
    try { pre = await worker(conn, 'lv-precheck', { rmTables: defs.map((d) => d.table), sourceTables: sources }); } catch (e) { throw httpError(502, `Base de migração (${saved.name}): ${db.friendly(e)}`, { code: e.code }); }
    let rmInfo;
    try { const rm = await rmOpen(rmc); const t0 = Date.now(); const snap = await RM.snapshot(rm); rmInfo = { ok: true, consultas: snap.size, leftovers: [...snap].filter((k) => k.split('|')[2].startsWith(C.PREFIX)).map((k) => k.split('|')[2]), ms: Date.now() - t0 }; } catch (e) { if (e.status) throw e; throw httpError(502, `RM (${rmc.name}): ${e.message}`, { code: e.code }); }
    const warnings = [];
    if (!pre.canCreate || !pre.canAlter || !pre.canInsert) warnings.push(`O login ${pre.identity.login} não tem permissão para criar/alterar tabelas e inserir no schema dbo deste banco.`);
    if (rmInfo.leftovers.length) warnings.push(`Há consulta(s) temporária(s) desta ferramenta sobrando no RM (${rmInfo.leftovers.join(', ')}); serão apagadas antes de recriar, se forem do mesmo usuário.`);
    const tables = defs.map((d, i) => ({
      table: d.table, code: C.consultaCode(d.table), current: pre.rm[d.table], sentenceChars: sentences[i].length,
      validations: d.validations.map((v) => ({ label: v.label, source: C.sourceOf(v.sql), carga: pre.src[C.sourceOf(v.sql)] ?? null })),
    }));
    for (const t of tables) for (const v of t.validations) if (v.carga === null) warnings.push(`Tabela da carga ${v.source} não existe na base: a validação de ${v.label} vai falhar.`);
    const canExecute = pre.canCreate && pre.canAlter && pre.canInsert;
    const body = { system: sys.id, params, tables: tables.map((t) => t.table), target: info, rm: { id: rmc.id, url: rmc.url, user: rmc.user }, sentences, outDir };
    const hash = fingerprint(body);
    const id = crypto.randomBytes(8).toString('hex');
    plans.set(id, { id, hash, expiresAt: Date.now() + PLAN_TTL_MS, body, connFp: fingerprint([saved.id, saved.server, saved.port || null, saved.auth, saved.user || '', saved.passwordEnc || '']), rmFp: fingerprint([rmc.id, rmc.url, rmc.user, rmc.passwordEnc]) });
    audit.log({ action: 'lv-conferencia', by: whoAmI(), detalhe: saved.name, server: db.label(saved), database: info.database, rm: rmc.url, tabelas: tables.length });
    res.json({ planId: id, hash, expiresAt: Date.now() + PLAN_TTL_MS, target: { ...info, login: pre.identity.login, connectedTo: pre.identity.server }, rm: { name: rmc.name, url: rmc.url, user: rmc.user, ...rmInfo }, params, tables, warnings, canExecute, outDir });
  });

  // ---------- Trabalhos ----------
  function newJob(kind, total) {
    const job = { id: crypto.randomBytes(8).toString('hex'), kind, status: 'running', total, done: 0, current: null, log: [], startedAt: Date.now(), updatedAt: Date.now(), result: null };
    job.say = (msg) => { job.log.push(`${new Date().toLocaleTimeString('pt-BR')} ${msg}`); if (job.log.length > MAX_LOG) job.log.shift(); job.updatedAt = Date.now(); };
    jobs.set(job.id, job);
    return job;
  }
  const publicJob = (j) => ({ id: j.id, kind: j.kind, status: j.status, total: j.total, done: j.done, current: j.current, log: j.log, startedAt: j.startedAt, updatedAt: j.updatedAt, result: j.result, error: j.error || null });
  app.get(`${base}/jobs/:id`, (req, res) => { const j = jobs.get(str(req.params.id, 40)); if (!j) throw httpError(404, 'Trabalho não encontrado.'); res.json(publicJob(j)); });
  app.post(`${base}/jobs/:id/cancel`, (req, res) => { const j = jobs.get(str(req.params.id, 40)); if (!j) throw httpError(404, 'Trabalho não encontrado.'); j.cancelRequested = true; if (j.abort) j.abort(); j.say('Cancelamento pedido: a etapa em andamento termina (ou é desfeita) e as próximas não começam.'); res.json({ ok: true }); });

  async function runValidations(conn, defs, dir, job) {
    const items = defs.flatMap((d) => d.validations.map((v) => ({ label: v.label, sql: v.sql, source: C.sourceOf(v.sql), file: path.join(dir, `NAO_SUBIU_${fileSafe(v.label)}.csv`) })));
    job.current = 'Validando contra a carga (só leitura)…';
    const r = await worker(conn, 'lv-validate', { items }, { onProgress: (done, total, inf) => { job.current = `Validando ${inf && inf.table ? inf.table : ''} (${done}/${total})`; job.updatedAt = Date.now(); } });
    for (const v of r) job.say(v.error ? `[${v.label}] validação: ERRO ${v.error}` : `[${v.label}] carga ${v.carga} · não subiu ${v.missing}`);
    return r;
  }
  function writeSummary(dir, { target, rm, params, extraction, validation, snapshot }) {
    const L = [`Validação de Carga — ${new Date().toLocaleString('pt-BR')}`, `Base: ${target.connectionName} · ${target.server} · ${target.database}`];
    if (rm) L.push(`RM: ${rm.url} (usuário ${rm.user}) · coligada ${params.coligada}${params.periods.length ? ` · períodos ${params.periods.join(', ')}` : ''}`);
    if (snapshot) L.push(`Consultas no RM: antes ${snapshot.before} · depois ${snapshot.after} · temporárias restantes ${snapshot.leftovers.length ? snapshot.leftovers.join(', ') : 'nenhuma'}`);
    if (extraction) { L.push('', 'EXTRAÇÃO (RM → base)'); for (const e of extraction) L.push(`  ${e.table.padEnd(22)} ${String(e.rows ?? '').padStart(8)}  ${e.status}`); }
    if (validation) {
      L.push('', 'VALIDAÇÃO (carga × RM)', `  ${'TABELA'.padEnd(32)} ${'ORIGEM'.padEnd(28)} ${'CARGA'.padStart(8)} ${'NÃO SUBIU'.padStart(10)} ${'% NO RM'.padStart(8)}`);
      for (const v of validation) L.push(v.error ? `  ${v.label.padEnd(32)} ${String(v.source).padEnd(28)} ERRO: ${v.error}` : `  ${v.label.padEnd(32)} ${v.source.padEnd(28)} ${String(v.carga).padStart(8)} ${String(v.missing).padStart(10)} ${(v.carga ? (100 * (v.carga - v.missing) / v.carga).toFixed(1) : '-').padStart(8)}`);
    }
    fs.writeFileSync(path.join(dir, 'RESUMO.txt'), `﻿${L.join('\r\n')}\r\n`, 'utf8');
  }

  // ---------- Executar: RM → base → validar ----------
  app.post(`${base}/plans/:id/execute`, async (req, res) => {
    cleanup();
    const b = req.body || {};
    const pl = plans.get(str(req.params.id, 40));
    if (!pl) throw httpError(410, 'A conferência expirou ou já foi usada. Confira de novo.', { code: 'LV_PLAN_EXPIRED' });
    if (b.hash !== pl.hash || b.authorized !== true) throw httpError(400, 'Autorização inválida: marque a autorização e confira de novo antes de executar.', { code: 'LV_NOT_AUTHORIZED' });
    if (running()) throw httpError(409, 'Já existe um trabalho da Validação de Carga em andamento.', { code: 'LV_BUSY' });
    const { system, params, tables, target, sentences, outDir } = pl.body;
    const { saved, conn, info } = sqlTarget(target.connectionId, target.database);
    const rmc = rmById(pl.body.rm.id);
    if (fingerprint([saved.id, saved.server, saved.port || null, saved.auth, saved.user || '', saved.passwordEnc || '']) !== pl.connFp || fingerprint([rmc.id, rmc.url, rmc.user, rmc.passwordEnc]) !== pl.rmFp) throw httpError(409, 'Uma conexão foi alterada depois da conferência. Confira de novo.', { code: 'LV_PLAN_EXPIRED' });
    if (saved.env !== 'local' && b.confirmed !== true) {
      const env = { prod: 'PRODUÇÃO', hml: 'Homologação', dev: 'Desenvolvimento' }[saved.env] || saved.env;
      throw httpError(409, `Executar a Validação de Carga?\n\nRM ${rmc.url}: criar, executar e apagar ${tables.length} consulta(s) temporária(s) ZMV.*\nBase ${env} ${saved.name} · ${info.database}: SUBSTITUIR ${tables.length} tabela(s) (cópia CSV da atual antes): ${tables.join(', ')}`, { code: 'LV_CONFIRM' });
    }
    plans.delete(pl.id); // uso único
    const sys = C.systemOf(system); const defs = C.pickTables(sys, tables);
    const job = newJob('execute', defs.length * 2 + 1);
    res.json({ jobId: job.id });
    const by = whoAmI(); const meta = { by, detalhe: saved.name, server: db.label(saved), database: info.database, rm: rmc.url };
    audit.log({ action: 'lv-execucao-iniciada', ...meta, tabelas: tables.join(', '), hash: pl.hash });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-lv-'));
    const dir = runDir(outDir, 'extracao'); const bkDir = path.join(dir, 'backup'); fs.mkdirSync(bkDir, { recursive: true });
    const extraction = []; let snapshot = null; let validation = null;
    try {
      const rm = await rmOpen(rmc);
      const before = await RM.snapshot(rm);
      job.say(`RM: ${before.size} consultas antes (${[...before].filter((k) => k.split('|')[2].startsWith(C.PREFIX)).length} ZMV.*)`);
      // 1) RM: até RM_PARALLEL tabelas ao mesmo tempo (cada uma: criar → executar → apagar)
      const fetched = new Map(); const queue = defs.map((d, i) => ({ d, sql: sentences[i] }));
      const workerRm = async () => {
        for (let it = queue.shift(); it; it = queue.shift()) {
          if (job.cancelRequested) { fetched.set(it.d.table, { error: 'cancelado antes de começar' }); continue; }
          const code = C.consultaCode(it.d.table); const t0 = Date.now();
          job.current = `RM: ${it.d.table}`;
          try {
            const r = await RM.extract(rm, { table: it.d.table, code, sentence: it.sql, coligada: params.coligada, codSistema: sys.codSistema, log: (m) => job.say(`[${it.d.table}] ${m}`) });
            const columns = r.rows.length ? Object.keys(r.rows[0]) : [];
            const rows = r.rows.map((o) => columns.map((c) => (o[c] === null || o[c] === undefined ? null : typeof o[c] === 'boolean' ? (o[c] ? '1' : '0') : String(o[c]))));
            const file = path.join(tmp, `${it.d.table}.json`);
            fs.writeFileSync(file, JSON.stringify({ columns, rows }));
            fetched.set(it.d.table, { file, rows: rows.length, mb: (r.bytes / 1e6).toFixed(1), s: ((Date.now() - t0) / 1000).toFixed(1) });
            job.say(`[${it.d.table}] RM: ${rows.length} linhas, ${(r.bytes / 1e6).toFixed(1)} MB, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
            audit.log({ action: 'lv-tabela-extraida', ...meta, tabela: it.d.table, consulta: code, linhas: rows.length });
          } catch (e) {
            fetched.set(it.d.table, { error: e.message });
            job.say(`[${it.d.table}] ERRO no RM: ${e.message}`);
          }
          job.done++; job.updatedAt = Date.now();
        }
      };
      await Promise.all(Array.from({ length: Math.min(RM_PARALLEL, defs.length) }, workerRm));
      const after = await RM.snapshot(rm);
      const leftovers = [...after].filter((k) => k.split('|')[2].startsWith(C.PREFIX)).map((k) => k.split('|')[2]);
      const others = [...before].filter((k) => !after.has(k)).concat([...after].filter((k) => !before.has(k))).filter((k) => !k.split('|')[2].startsWith(C.PREFIX));
      snapshot = { before: before.size, after: after.size, leftovers, others: others.length };
      job.say(`RM: ${after.size} consultas depois · temporárias restantes: ${leftovers.length ? leftovers.join(', ') : 'nenhuma'} · mudanças de terceiros durante a execução: ${others.length || 'nenhuma'}`);
      if (leftovers.length) job.say(`ATENÇÃO: sobraram consultas desta ferramenta no RM: ${leftovers.join(', ')}`);
      // 2) Base: uma tabela por vez (cópia da atual → substituição em transação)
      for (const d of defs) {
        const f = fetched.get(d.table);
        if (job.cancelRequested) { extraction.push({ table: d.table, rows: null, status: 'NÃO GRAVADA (cancelado)' }); continue; }
        if (!f || f.error) { extraction.push({ table: d.table, rows: null, status: `NÃO GRAVADA (erro no RM): ${f ? f.error : 'sem dados'}` }); job.done++; continue; }
        job.current = `Base: ${d.table}`;
        try {
          const pre = await worker(conn, 'lv-precheck', { rmTables: [d.table], sourceTables: [] });
          const current = pre.rm[d.table];
          if (!f.rows && current) { extraction.push({ table: d.table, rows: 0, status: `NÃO SUBSTITUÍDA: o RM devolveu 0 linhas e a tabela atual tem ${current}` }); job.done++; continue; }
          if (current !== null) {
            const bk = await worker(conn, 'lv-dump', { table: d.table, file: path.join(bkDir, `${d.table}_${stamp()}.csv`) });
            job.say(`[${d.table}] cópia da tabela atual: ${bk.rows} linhas (backup\\${d.table}_….csv)`);
          }
          const ac = new AbortController(); job.abort = () => ac.abort();
          const r = await worker(conn, 'lv-replace', { table: d.table, rowsFile: f.file, allowed: defs.map((x) => x.table) }, { signal: ac.signal, gracefulCancel: true, onProgress: (done, total) => { job.current = `Base: ${d.table} (${done}/${total})`; job.updatedAt = Date.now(); } });
          job.abort = null;
          extraction.push({ table: d.table, rows: r.rows, status: `gravada: ${r.rows} linhas${current !== null ? ' (substituiu a anterior)' : ' (nova)'}` });
          job.say(`[${d.table}] base: gravada (${r.rows} linhas)`);
          audit.log({ action: 'lv-tabela-substituida', ...meta, tabela: d.table, linhas: r.rows, anterior: current });
        } catch (e) {
          extraction.push({ table: d.table, rows: null, status: `ERRO ao gravar (tabela anterior mantida): ${db.friendly(e)}` });
          job.say(`[${d.table}] ERRO ao gravar (tabela anterior mantida): ${db.friendly(e)}`);
        }
        job.done++;
      }
      // 3) Validação (só leitura)
      if (!job.cancelRequested) validation = await runValidations(conn, defs, dir, job);
      job.done = job.total;
      writeSummary(dir, { target: info, rm: rmc, params, extraction, validation, snapshot });
      job.result = { dir, extraction, validation, snapshot };
      job.status = job.cancelRequested ? 'cancelled' : 'done';
      audit.log({ action: 'lv-execucao-concluida', ...meta, tabelas: defs.length, erros: extraction.filter((e) => !e.status.startsWith('gravada')).length });
    } catch (e) {
      job.status = 'error'; job.error = e.message; job.say(`ERRO: ${e.message}`);
      try { writeSummary(dir, { target: info, rm: rmc, params, extraction, validation, snapshot }); } catch { /* ignora */ }
      audit.log({ action: 'lv-execucao-falhou', ...meta, erro: e.message.slice(0, 200) });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true }); // dados do RM em trânsito (temporários)
      job.current = null; job.updatedAt = Date.now();
    }
  });

  // ---------- Só validar (só leitura) ----------
  app.post(`${base}/validate`, async (req, res) => {
    cleanup();
    const b = req.body || {};
    let sys; try { sys = C.systemOf(b.system); } catch (e) { throw httpError(400, e.message); }
    let defs; try { defs = C.pickTables(sys, b.tables); } catch (e) { throw httpError(400, e.message); }
    const { saved, conn, info } = sqlTarget(b.connectionId, b.database);
    const outDir = outDirOf(b.outDir);
    if (running()) throw httpError(409, 'Já existe um trabalho da Validação de Carga em andamento.', { code: 'LV_BUSY' });
    const job = newJob('validate', 1);
    res.json({ jobId: job.id });
    const dir = runDir(outDir, 'validacao');
    try {
      const validation = await runValidations(conn, defs, dir, job);
      writeSummary(dir, { target: info, validation });
      job.result = { dir, validation }; job.status = 'done'; job.done = 1;
      audit.log({ action: 'lv-validacao', by: whoAmI(), detalhe: saved.name, server: db.label(saved), database: info.database, tabelas: defs.length });
    } catch (e) { job.status = 'error'; job.error = db.friendly(e); job.say(`ERRO: ${job.error}`); }
    job.current = null; job.updatedAt = Date.now();
  });

  // ---------- Gerar complemento (só leitura na base; grava TXT numa pasta nova) ----------
  app.post(`${base}/complement`, async (req, res) => {
    cleanup();
    const b = req.body || {};
    let sys; let params; try { sys = C.systemOf(b.system); params = C.cleanParams({ coligada: b.coligada, periods: '' }); } catch (e) { throw httpError(400, e.message); }
    const { saved, conn, info } = sqlTarget(b.connectionId, b.database);
    const txtDir = outDirOf(b.txtDir, 'pasta dos TXT do Hop');
    const outDir = outDirOf(b.outDir);
    const includeUnreferenced = b.includeUnreferenced === true;
    if (running()) throw httpError(409, 'Já existe um trabalho da Validação de Carga em andamento.', { code: 'LV_BUSY' });
    const job = newJob('complement', sys.complement.length);
    res.json({ jobId: job.id });
    const dir = runDir(outDir, 'complemento');
    const rows = []; const warnings = [];
    try {
      const cache = new Map();
      for (const k of sys.complement) {
        job.current = `Complemento: ${k.txt}`;
        const file = fs.readdirSync(txtDir).find((f) => f.toUpperCase() === `${k.txt}.TXT`);
        if (!file) { rows.push({ table: k.txt, status: 'SEM TXT' }); job.done++; continue; }
        const need = [...new Set([...k.columns, ...Object.keys(k.filter || {})])];
        const ck = `${k.rmTable}|${need.join(',')}`;
        if (!cache.has(ck)) cache.set(ck, await worker(conn, 'lv-keys', { table: k.rmTable, columns: need }));
        const ref = cache.get(ck);
        const buf = fs.readFileSync(path.join(txtDir, file));
        if (ref.missing || ref.lacking) {
          const why = ref.missing ? `tabela ${k.rmTable} não existe na base (extraia do RM antes)` : `tabela ${k.rmTable} sem as colunas ${ref.lacking.join(', ')}`;
          if (includeUnreferenced) { fs.writeFileSync(path.join(dir, `${k.txt}.txt`), buf); rows.push({ table: k.txt, status: `SEM REFERÊNCIA (${why}): TXT copiado inteiro`, txtLines: null }); } else rows.push({ table: k.txt, status: `SEM REFERÊNCIA (${why})` });
          job.done++; continue;
        }
        const r = C.computeComplement(k, buf, ref.rows, params.coligada);
        if (r.content) fs.writeFileSync(path.join(dir, `${k.txt}.txt`), r.content);
        rows.push({ table: k.txt, status: r.toLoad ? 'gerado' : 'nada a subir', inRm: r.inRm, txtLines: r.txtLines, toLoad: r.toLoad, onlyRm: r.onlyRm, dupRm: r.dupRm });
        for (const w of r.warnings) warnings.push(`${k.txt}: ${w}`);
        job.say(`[${k.txt}] no RM ${r.inRm} · TXT ${r.txtLines} · a subir ${r.toLoad}`);
        job.done++;
      }
      const L = [`Complemento — ${new Date().toLocaleString('pt-BR')}`, `Base: ${info.connectionName} · ${info.server} · ${info.database} · coligada ${params.coligada}`, `TXT do Hop: ${txtDir}`, '',
        `${'TABELA'.padEnd(21)} ${'NO RM'.padStart(7)} ${'TXT'.padStart(8)} ${'A SUBIR'.padStart(7)} ${'SÓ NO RM'.padStart(8)} ${'REPET RM'.padStart(8)}  SITUAÇÃO`];
      for (const r of rows) L.push(`${r.table.padEnd(21)} ${String(r.inRm ?? '').padStart(7)} ${String(r.txtLines ?? '').padStart(8)} ${String(r.toLoad ?? '').padStart(7)} ${String(r.onlyRm ?? '').padStart(8)} ${String(r.dupRm ?? '').padStart(8)}  ${r.status}`);
      if (warnings.length) L.push('', 'ATENÇÃO', ...warnings.map((w) => `  - ${w}`));
      L.push('', 'Importar os TXT desta pasta na ordem da lista acima.');
      fs.writeFileSync(path.join(dir, 'RESUMO.txt'), `﻿${L.join('\r\n')}\r\n`, 'utf8');
      job.result = { dir, rows, warnings }; job.status = 'done';
      audit.log({ action: 'lv-complemento', by: whoAmI(), detalhe: saved.name, server: db.label(saved), database: info.database, gerados: rows.filter((r) => r.status === 'gerado').length });
    } catch (e) { job.status = 'error'; job.error = db.friendly(e); job.say(`ERRO: ${job.error}`); }
    job.current = null; job.updatedAt = Date.now();
  });
}

module.exports = { mount };
