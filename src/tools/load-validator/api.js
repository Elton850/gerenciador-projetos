// Validação de Carga — rotas (sob /api/tools/load-validator). Confere se a carga (tabelas ZMIGRA_* da base de migração) foi de fato
// para o RM do cliente: extrai as tabelas do RM por consultas SQL temporárias (criar → executar → apagar), grava cada uma na base
// de migração com o nome da tabela raiz (SALUNO, STURMADISC…), roda as validações embutidas e gera os TXT complementares.
//
// Fluxo com trava: Conferir (trabalho: base só leitura + CONTAGEM no RM por consulta temporária de COUNT → plano com hash, uso
// único, 15 min, com as partes de cada tabela) → Executar (autorização explícita + confirmação 409 LV_CONFIRM fora do ambiente
// local) → trabalho com progresso. "Só validar" e "Gerar complemento" só leem a base.
// Carga no RM: UMA consulta por vez (nunca em paralelo); tabela com mais de C.LIMITS.rowsPerPart linhas sai em partes (faixas
// da coluna de divisão), e o total das partes tem de bater com a contagem da conferência; nenhuma consulta é repetida após timeout.
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
  // A pasta ValidacaoCarga guarda dados do cliente (CSV das linhas da carga, cópias das tabelas): se a pasta de saída for um
  // repositório Git, um .gitignore "*" dentro dela impede que esses arquivos entrem num commit por engano.
  const runDir = (outDir, kind) => {
    const root = path.join(outDir, 'ValidacaoCarga');
    const d = path.join(root, `${stamp()}_${kind}`); fs.mkdirSync(d, { recursive: true });
    const gi = path.join(root, '.gitignore');
    try { if (!fs.existsSync(gi)) fs.writeFileSync(gi, '# Gerado pela Validação de Carga: dados do cliente, nunca versionar.\n*\n'); } catch { /* sem permissão: segue sem */ }
    return d;
  };
  const fileSafe = (s) => String(s).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');

  // ---------- Estado / modelos ----------
  app.get(`${base}/state`, (req, res) => {
    const s = state();
    res.json({
      systems: Object.values(C.SYSTEMS).map((sy) => ({ id: sy.id, name: sy.name, ready: sy.ready,
        usesPeriods: sy.tables.some((t) => t.rmSql.includes('{{CODPERLETS}}')), complementReady: sy.complement.length > 0, tables: sy.tables.map((t) => ({ table: t.table, code: C.consultaCode(t.table), validations: t.validations.map((v) => v.label), complement: sy.complement.some((k) => k.rmTable === t.table) })) })),
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
    let params; try { params = C.cleanParams({ coligada: b.coligada, coligadas: b.coligadas, periods: b.periods }); } catch (e) { throw httpError(400, e.message); }
    let defs; try { defs = C.pickTables(sys, b.tables); } catch (e) { throw httpError(400, e.message); }
    if (!defs.length) throw httpError(400, 'Escolha ao menos uma tabela.');
    return { sys, params, defs };
  }
  // Trabalho (não é mais resposta direta): a contagem no RM roda uma tabela por vez e pode levar minutos. Resultado: job.result.plan.
  app.post(`${base}/precheck`, async (req, res) => {
    cleanup();
    const b = req.body || {};
    const { sys, params, defs } = inputOf(b);
    const { saved, conn, info } = sqlTarget(b.connectionId, b.database);
    const rmc = rmById(b.rmId);
    const outDir = outDirOf(b.outDir);
    const sentences = defs.map((d) => { try { return C.renderRm(d, params); } catch (e) { throw httpError(400, `${d.table}: ${e.message}`); } });
    const sources = [...new Set(defs.flatMap((d) => d.validations.map((v) => C.sourceOf(v.sql)).filter(Boolean)))];
    if (running()) throw httpError(409, 'Já existe um trabalho da Validação de Carga em andamento.', { code: 'LV_BUSY' });
    const rm = await rmOpen(rmc);
    const job = newJob('precheck', defs.length + 2);
    res.json({ jobId: job.id });
    try {
      job.current = 'Base de migração (só leitura)…';
      let pre;
      try { pre = await worker(conn, 'lv-precheck', { rmTables: defs.map((d) => d.table), sourceTables: sources }); } catch (e) { throw new Error(`Base de migração (${saved.name}): ${db.friendly(e)}`); }
      job.done++;
      job.current = 'RM: lista de consultas…';
      let rmInfo;
      try { const t0 = Date.now(); const snap = await RM.snapshot(rm); rmInfo = { ok: true, consultas: snap.size, leftovers: [...snap].filter((k) => k.split('|')[2].startsWith(C.PREFIX)).map((k) => k.split('|')[2]), ms: Date.now() - t0 }; } catch (e) { throw new Error(`RM (${rmc.name}): ${e.message}`); }
      job.done++;
      // Contagem no RM, uma tabela por vez (COUNT numa consulta temporária: o banco do RM conta, o Host devolve uma linha).
      const counts = [];
      for (const [i, d] of defs.entries()) {
        if (job.cancelRequested) break;
        const code = C.consultaCode(d.table); const col = C.partColumnOf(sys, d.table);
        job.current = `RM: contando ${d.table} (${i + 1}/${defs.length})`;
        try {
          const r = await RM.extract(rm, { table: d.table, code, sentence: C.statsSql(sentences[i], col), coligada: params.coligada, codSistema: sys.codSistema, log: (m) => job.say(`[${d.table}] contagem: ${m}`) });
          const row = r.rows[0] || {};
          const parts = C.planParts(row, col, C.LIMITS);
          counts.push({ rows: Number(row.N), parts });
          job.say(`[${d.table}] RM: ${Number(row.N).toLocaleString('pt-BR')} linhas · ${parts.length} parte(s)`);
        } catch (e) {
          counts.push({ rows: null, parts: null, error: e.message });
          job.say(`[${d.table}] ERRO na contagem: ${e.message}`);
        }
        job.done++; job.updatedAt = Date.now();
      }
      if (job.cancelRequested) { job.status = 'cancelled'; job.say('Conferência cancelada: nenhum plano foi gerado.'); return; }
      const warnings = [];
      if (!pre.canCreate || !pre.canAlter || !pre.canInsert) warnings.push(`O login ${pre.identity.login} não tem permissão para criar/alterar tabelas e inserir no schema dbo deste banco.`);
      if (rmInfo.leftovers.length) warnings.push(`Há consulta(s) temporária(s) desta ferramenta sobrando no RM (${rmInfo.leftovers.join(', ')}); serão apagadas antes de recriar, se forem do mesmo usuário.`);
      const tables = defs.map((d, i) => ({
        table: d.table, code: C.consultaCode(d.table), current: pre.rm[d.table], sentenceChars: sentences[i].length,
        rmRows: counts[i].rows, parts: counts[i].parts ? counts[i].parts.length : null, partColumn: C.partColumnOf(sys, d.table), countError: counts[i].error || null,
        validations: d.validations.map((v) => ({ label: v.label, source: C.sourceOf(v.sql), carga: pre.src[C.sourceOf(v.sql)] ?? null })),
      }));
      for (const t of tables) {
        if (t.countError) warnings.push(`${t.table}: a contagem no RM falhou (${t.countError}). Tire a tabela da lista ou corrija antes de executar.`);
        else if (t.parts === 1 && t.rmRows > C.LIMITS.rowsPerPart) warnings.push(`${t.table}: ${t.rmRows.toLocaleString('pt-BR')} linhas numa chamada só (${t.partColumn ? `os valores de ${t.partColumn} não permitem dividir` : 'a tabela não tem coluna de divisão'}). É a mais pesada para o RM Host; avalie extrair em outro momento.`);
        else if (t.parts > 1 && t.rmRows / t.parts > C.LIMITS.rowsPerPart) warnings.push(`${t.table}: ${t.rmRows.toLocaleString('pt-BR')} linhas em ${t.parts} partes, média de ${Math.round(t.rmRows / t.parts).toLocaleString('pt-BR')} por parte (acima do limite de ${C.LIMITS.rowsPerPart.toLocaleString('pt-BR')}: cada ${t.partColumn} já é uma parte). Pesada para o RM Host; avalie extrair em outro momento.`);
        else if (t.rmRows > C.LIMITS.bigTable) warnings.push(`${t.table}: tabela grande (${t.rmRows.toLocaleString('pt-BR')} linhas), extraída em ${t.parts} partes, uma por vez.`);
        if (!t.validations.length) warnings.push(`${t.table}: o modelo não tem consulta de validação para esta tabela; ela só é extraída do RM para a base.`);
        for (const v of t.validations) if (v.carga === null) warnings.push(`Tabela da carga ${v.source} não existe na base: a validação de ${v.label} vai falhar.`);
      }
      const canExecute = pre.canCreate && pre.canAlter && pre.canInsert && tables.every((t) => !t.countError);
      const body = { system: sys.id, params, tables: tables.map((t) => t.table), target: info, rm: { id: rmc.id, url: rmc.url, user: rmc.user }, sentences, outDir,
        rmRows: counts.map((c) => c.rows), parts: counts.map((c) => c.parts) };
      const hash = fingerprint(body);
      const id = crypto.randomBytes(8).toString('hex');
      plans.set(id, { id, hash, expiresAt: Date.now() + PLAN_TTL_MS, body, connFp: fingerprint([saved.id, saved.server, saved.port || null, saved.auth, saved.user || '', saved.passwordEnc || '']), rmFp: fingerprint([rmc.id, rmc.url, rmc.user, rmc.passwordEnc]) });
      audit.log({ action: 'lv-conferencia', by: whoAmI(), detalhe: saved.name, server: db.label(saved), database: info.database, rm: rmc.url, tabelas: tables.length });
      job.result = { plan: { planId: id, hash, expiresAt: Date.now() + PLAN_TTL_MS, target: { ...info, login: pre.identity.login, connectedTo: pre.identity.server }, rm: { name: rmc.name, url: rmc.url, user: rmc.user, ...rmInfo }, params, tables, warnings, canExecute, outDir, rowsPerPart: C.LIMITS.rowsPerPart } };
      job.status = 'done'; job.done = job.total;
    } catch (e) {
      job.status = 'error'; job.error = e.message; job.say(`ERRO: ${e.message}`);
    } finally { job.current = null; job.updatedAt = Date.now(); }
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

  // status (só na execução): tabela → 'ok' (cópia do RM gravada agora) | 'empty' (RM sem linhas nas coligadas). Tabela fora do
  // status não é validada: a cópia na base é de outra hora e daria um resultado falso.
  // SQL de cada validação pronto para o SSMS: cabeçalho com o contexto + USE do banco + a consulta EXATA que rodou (com o filtro
  // de coligadas). RM sem linhas: a consulta lista a carga inteira das coligadas, e a comparação do modelo vai comentada.
  function sqlForSsms(v, { target, coligadas, modelSql, fresh }) {
    const rmTable = (String(v.sql).match(/\bLEFT\s+JOIN\s+\[?(\w+)\]?/i) || [])[1] || v.label;
    const H = [
      `-- Validação de Carga · ${v.label} · gerado em ${new Date().toLocaleString('pt-BR')}`,
      `-- Base de migração: ${target.database} (servidor ${target.server})${coligadas ? ` · coligada(s) ${coligadas.join(', ')}` : ' · todas as coligadas da carga'}`,
      `-- Carga: dbo.${v.source} · RM: dbo.${rmTable} = cópia do RM ${fresh ? 'gravada nesta base por esta execução' : 'que já estava nesta base (Só validar)'}.`,
      v.rmEmpty ? `-- O RM não tinha linhas de ${rmTable} nessas coligadas: a consulta abaixo lista TODA a carga delas (= o que não subiu).`
        : '-- Linhas devolvidas = as que estão na carga e NÃO estão no RM (mesma regra da ferramenta).',
      v.scoped === false && coligadas ? `-- A carga ${v.source} não tem CODCOLIGADA: comparada inteira.` : null,
    ].filter(Boolean);
    const body = [`USE ${'[' + String(target.database).replace(/]/g, ']]') + ']'};`, 'GO', '', String(v.sql).trim(), 'GO'];
    if (v.rmEmpty && modelSql) body.push('', '-- Comparação do modelo, para quando o RM tiver dados desta tabela:', ...String(modelSql).trim().split('\n').map((l) => `-- ${l}`));
    return `${[...H, '', ...body].join('\r\n')}\r\n`;
  }
  async function runValidations(conn, defs, dir, job, { coligadas = null, status = null, target = null } = {}) {
    const items = defs.flatMap((d) => d.validations.map((v) => {
      const it = { label: v.label, sql: v.sql, source: C.sourceOf(v.sql), file: path.join(dir, `NAO_SUBIU_${fileSafe(v.label)}.csv`) };
      if (status) {
        const s = status.get(d.table);
        if (s === 'empty') it.rmEmpty = true;
        else if (s !== 'ok') it.skip = `NÃO VALIDADA: a tabela ${d.table} do RM não foi atualizada nesta execução (${s || 'sem dados'}); comparar com a cópia antiga daria um resultado falso.`;
      }
      return it;
    }));
    job.current = 'Validando contra a carga (só leitura)…';
    const r = await worker(conn, 'lv-validate', { items, coligadas }, { onProgress: (done, total, inf) => { job.current = `Validando ${inf && inf.table ? inf.table : ''} (${done}/${total})`; job.updatedAt = Date.now(); } });
    for (const v of r) job.say(v.error ? `[${v.label}] validação: ${v.skipped ? '' : 'ERRO '}${v.error}` : `[${v.label}] carga ${v.carga} · não subiu ${v.missing}${v.byColigada ? ` · ${v.byColigada.map((b) => `col. ${b.coligada}: ${b.missing}/${b.carga}`).join(' · ')}` : ''}`);
    // SQL para o SSMS (tela: "Copiar SQL"; pasta: CONSULTAS_VALIDACAO.sql). Só das validações que rodaram.
    if (target) {
      const modelOf = new Map(items.map((i) => [i.label, i]));
      const texts = [];
      for (const v of r) {
        if (v.error || !v.sql) continue;
        const it = modelOf.get(v.label);
        let modelSql = null;
        if (v.rmEmpty && it) { try { modelSql = v.scoped && coligadas ? C.scopeValidation(it.sql, it.source, coligadas) : it.sql; } catch { modelSql = it.sql; } }
        v.sqlText = sqlForSsms(v, { target, coligadas: v.scoped === false ? null : coligadas, modelSql, fresh: !!status });
        texts.push(v.sqlText);
      }
      if (texts.length) { try { fs.writeFileSync(path.join(dir, 'CONSULTAS_VALIDACAO.sql'), `﻿${texts.join('\r\n')}`, 'utf8'); } catch { /* o resumo segue sem o arquivo */ } }
    }
    return r;
  }
  const pct = (carga, missing) => (carga ? (100 * (carga - missing) / carga).toFixed(1) : '-');
  function writeSummary(dir, { target, rm, params, extraction, validation, snapshot, partial }) {
    const L = [`Validação de Carga — ${new Date().toLocaleString('pt-BR')}`, `Base: ${target.connectionName} · ${target.server} · ${target.database}`];
    if (partial) L.unshift(`EM ANDAMENTO (ou interrompida): ${partial.done} de ${partial.total} tabela(s) processada(s) na base. Se este aviso ficou, a execução não terminou.`, '');
    if (rm) L.push(`RM: ${rm.url} (usuário ${rm.user}) · coligada(s) ${params.coligadas.join(', ')}${params.periods.length ? ` · períodos ${params.periods.join(', ')}` : ''}`);
    else if (params && params.coligadas) L.push(`Coligada(s): ${params.coligadas.join(', ')}`);
    if (snapshot) L.push(`Consultas temporárias ZMV.* no RM: antes ${snapshot.before} · depois ${snapshot.after} · restantes ${snapshot.leftovers.length ? snapshot.leftovers.join(', ') : 'nenhuma'}`);
    if (extraction) { L.push('', 'EXTRAÇÃO (RM → base)'); for (const e of extraction) L.push(`  ${e.table.padEnd(22)} ${String(e.rows ?? '').padStart(8)}  ${e.status}`); }
    if (validation) {
      L.push('', 'VALIDAÇÃO (carga × RM)', `  ${'TABELA'.padEnd(32)} ${'ORIGEM'.padEnd(28)} ${'CARGA'.padStart(8)} ${'NÃO SUBIU'.padStart(10)} ${'% NO RM'.padStart(8)}`);
      for (const v of validation) {
        if (v.error) { L.push(`  ${v.label.padEnd(32)} ${String(v.source).padEnd(28)} ${v.skipped ? '' : 'ERRO: '}${v.error}`); continue; }
        L.push(`  ${v.label.padEnd(32)} ${v.source.padEnd(28)} ${String(v.carga).padStart(8)} ${String(v.missing).padStart(10)} ${pct(v.carga, v.missing).padStart(8)}${v.rmEmpty ? '  (RM sem linhas nas coligadas: nada desta carga subiu)' : ''}`);
        if (v.byColigada && v.byColigada.length > 1) for (const b of v.byColigada) L.push(`  ${''.padEnd(32)} ${`  coligada ${b.coligada}`.padEnd(28)} ${String(b.carga).padStart(8)} ${String(b.missing).padStart(10)} ${pct(b.carga, b.missing).padStart(8)}`);
        if (params && params.coligadas && v.scoped === false) L.push(`  ${''.padEnd(32)} ${v.source} não tem CODCOLIGADA: comparada a carga inteira`);
      }
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
      const nParts = pl.body.parts.reduce((n, p) => n + p.length, 0);
      throw httpError(409, `Executar a Validação de Carga?\n\nRM ${rmc.url}: criar, executar e apagar ${nParts} consulta(s) temporária(s) ZMV.*, uma por vez (${tables.length} tabela(s))\nBase ${env} ${saved.name} · ${info.database}: SUBSTITUIR ${tables.length} tabela(s) (cópia CSV da atual antes): ${tables.join(', ')}`, { code: 'LV_CONFIRM' });
    }
    plans.delete(pl.id); // uso único
    const sys = C.systemOf(system); const defs = C.pickTables(sys, tables);
    const planParts = pl.body.parts; const planRows = pl.body.rmRows;
    const job = newJob('execute', planParts.reduce((n, p) => n + p.length, 0) + defs.length + 1);
    res.json({ jobId: job.id });
    const by = whoAmI(); const meta = { by, detalhe: saved.name, server: db.label(saved), database: info.database, rm: rmc.url };
    audit.log({ action: 'lv-execucao-iniciada', ...meta, tabelas: tables.join(', '), hash: pl.hash });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-lv-'));
    const dir = runDir(outDir, 'extracao'); const bkDir = path.join(dir, 'backup'); fs.mkdirSync(bkDir, { recursive: true });
    const extraction = []; let snapshot = null; let validation = null;
    try {
      const rm = await rmOpen(rmc);
      const before = await RM.snapshot(rm);
      job.say(`RM: ${before.size} consulta(s) temporária(s) ZMV.* antes`);
      // 1) RM: UMA consulta por vez. Cada tabela sai nas partes da conferência (cada parte: criar → executar → apagar); o total
      //    tem de bater com a contagem da conferência (senão os dados mudaram e a tabela não é gravada).
      const fetched = new Map();
      const cell = (v) => (v === null || v === undefined ? null : typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
      for (const [i, d] of defs.entries()) {
        const parts = planParts[i];
        if (job.cancelRequested) { fetched.set(d.table, { error: 'cancelado antes de começar' }); continue; }
        const code = C.consultaCode(d.table); const col = C.partColumnOf(sys, d.table); const t0 = Date.now();
        try {
          let columns = null; const rows = []; let bytes = 0;
          for (const [k, p] of parts.entries()) {
            if (job.cancelRequested) throw new Error(`cancelado na parte ${k + 1} de ${parts.length} (as partes já lidas foram descartadas)`);
            const tag = parts.length > 1 ? `${d.table} ${k + 1}/${parts.length}` : d.table;
            job.current = `RM: ${tag}`;
            const r = await RM.extract(rm, { table: d.table, code, sentence: C.partSql(sentences[i], col, p), coligada: params.coligada, codSistema: sys.codSistema, log: (m) => job.say(`[${tag}] ${m}`) });
            if (r.rows.length) {
              const cols = Object.keys(r.rows[0]);
              if (!columns) columns = cols;
              else if (cols.join('|') !== columns.join('|')) throw new Error(`a parte ${k + 1} veio com colunas diferentes das anteriores.`);
            }
            for (const o of r.rows) rows.push(columns.map((c) => cell(o[c])));
            bytes += r.bytes;
            if (parts.length > 1) job.say(`[${tag}] faixa ${C.partLabel(p)}: ${r.rows.length} linhas`);
            job.done++; job.updatedAt = Date.now();
          }
          if (planRows[i] !== null && rows.length !== planRows[i]) throw new Error(`o RM devolveu ${rows.length} linhas e a conferência contou ${planRows[i]}: os dados mudaram desde a conferência. Confira de novo.`);
          const file = path.join(tmp, `${d.table}.json`);
          fs.writeFileSync(file, JSON.stringify({ columns: columns || [], rows }));
          fetched.set(d.table, { file, rows: rows.length });
          job.say(`[${d.table}] RM: ${rows.length} linhas em ${parts.length} parte(s), ${(bytes / 1e6).toFixed(1)} MB, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
          audit.log({ action: 'lv-tabela-extraida', ...meta, tabela: d.table, consulta: code, linhas: rows.length, partes: parts.length });
        } catch (e) {
          fetched.set(d.table, { error: e.message });
          job.say(`[${d.table}] ERRO no RM: ${e.message}`);
        }
        job.updatedAt = Date.now();
      }
      const after = await RM.snapshot(rm);
      const leftovers = [...after].filter((k) => k.split('|')[2].startsWith(C.PREFIX)).map((k) => k.split('|')[2]);
      snapshot = { before: before.size, after: after.size, leftovers };
      job.say(`RM: ${after.size} consulta(s) temporária(s) ZMV.* depois · restantes: ${leftovers.length ? leftovers.join(', ') : 'nenhuma'}`);
      if (leftovers.length) job.say(`ATENÇÃO: sobraram consultas desta ferramenta no RM: ${leftovers.join(', ')}`);
      // 2) Base: uma tabela por vez (cópia da atual → substituição em transação, gravação em massa com plano B)
      let bulkOk = true;
      const status = new Map(); // tabela → 'ok' | 'empty' | motivo (o que a validação pode usar)
      try { writeSummary(dir, { target: info, rm: rmc, params, extraction, snapshot, partial: { done: 0, total: defs.length } }); } catch { /* idem */ }
      for (const d of defs) {
        const f = fetched.get(d.table);
        if (job.cancelRequested) { extraction.push({ table: d.table, rows: null, state: 'cancelled', status: 'NÃO GRAVADA (cancelado)' }); continue; }
        if (!f || f.error) { extraction.push({ table: d.table, rows: null, state: 'error', status: `NÃO GRAVADA (erro no RM): ${f ? f.error : 'sem dados'}` }); status.set(d.table, 'erro no RM'); job.done++; continue; }
        job.current = `Base: ${d.table}`;
        try {
          const pre = await worker(conn, 'lv-precheck', { rmTables: [d.table], sourceTables: [] });
          const current = pre.rm[d.table];
          // RM sem linhas nas coligadas: nada é gravado (a cópia anterior, se houver, fica — proteção); a validação NÃO a usa e
          // considera que nada desta carga subiu. Sem cópia anterior não há colunas para criar a tabela: também não é erro.
          if (!f.rows) {
            const why = current ? `a cópia anterior (${current} linhas) foi mantida` : current === 0 ? 'a cópia anterior (vazia) foi mantida' : 'nenhuma cópia foi criada (sem linhas, o RM não informa as colunas)';
            extraction.push({ table: d.table, rows: 0, state: 'empty', status: `RM SEM LINHAS nas coligadas escolhidas: ${why}; a validação considera que nada desta carga subiu` });
            status.set(d.table, 'empty'); job.done++; continue;
          }
          if (current !== null) {
            const bk = await worker(conn, 'lv-dump', { table: d.table, file: path.join(bkDir, `${d.table}_${stamp()}.csv`) });
            job.say(`[${d.table}] cópia da tabela atual: ${bk.rows} linhas (backup\\${d.table}_….csv)`);
          }
          const ac = new AbortController(); job.abort = () => ac.abort();
          const t0 = Date.now();
          const r = await worker(conn, 'lv-replace', { table: d.table, rowsFile: f.file, allowed: defs.map((x) => x.table), forceInsert: !bulkOk }, { signal: ac.signal, gracefulCancel: true, onProgress: (done, total) => { job.current = `Base: ${d.table} (${done}/${total})`; job.updatedAt = Date.now(); } });
          job.abort = null;
          if (r.bulkError) { bulkOk = false; job.say(`[${d.table}] gravação em massa recusada pelo servidor (${r.bulkError}); gravada pelo método de lotes, que será usado nas próximas tabelas.`); }
          extraction.push({ table: d.table, rows: r.rows, state: 'ok', status: `gravada: ${r.rows} linhas${current !== null ? ' (substituiu a anterior)' : ' (nova)'}` });
          status.set(d.table, 'ok');
          job.say(`[${d.table}] base: gravada (${r.rows} linhas, ${r.mode === 'bulk' ? 'em massa' : 'em lotes'}, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
          audit.log({ action: 'lv-tabela-substituida', ...meta, tabela: d.table, linhas: r.rows, anterior: current, modo: r.mode });
        } catch (e) {
          extraction.push({ table: d.table, rows: null, state: 'error', status: `ERRO ao gravar (tabela anterior mantida): ${db.friendly(e)}` });
          status.set(d.table, 'erro ao gravar na base');
          job.say(`[${d.table}] ERRO ao gravar (tabela anterior mantida): ${db.friendly(e)}`);
        }
        job.done++;
        // resumo parcial a cada tabela: se o app fechar no meio, a pasta da execução mostra até onde foi
        try { writeSummary(dir, { target: info, rm: rmc, params, extraction, snapshot, partial: { done: extraction.length, total: defs.length } }); } catch { /* o resumo final tenta de novo */ }
      }
      // 3) Validação (só leitura)
      if (!job.cancelRequested) validation = await runValidations(conn, defs, dir, job, { coligadas: params.coligadas, status, target: info });
      job.done = job.total;
      writeSummary(dir, { target: info, rm: rmc, params, extraction, validation, snapshot });
      job.result = { dir, extraction, validation, snapshot };
      job.status = job.cancelRequested ? 'cancelled' : 'done';
      audit.log({ action: 'lv-execucao-concluida', ...meta, tabelas: defs.length, erros: extraction.filter((e) => e.state === 'error').length, rmVazio: extraction.filter((e) => e.state === 'empty').length });
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
    // coligadas: opcional aqui (sem elas, compara a carga inteira, como antes)
    const hasCol = [b.coligadas, b.coligada].some((x) => x !== undefined && x !== null && String(x).trim() !== '');
    let coligadas = null; try { if (hasCol) coligadas = C.cleanColigadas({ coligadas: b.coligadas, coligada: b.coligada }); } catch (e) { throw httpError(400, e.message); }
    const { saved, conn, info } = sqlTarget(b.connectionId, b.database);
    const outDir = outDirOf(b.outDir);
    if (running()) throw httpError(409, 'Já existe um trabalho da Validação de Carga em andamento.', { code: 'LV_BUSY' });
    const job = newJob('validate', 1);
    res.json({ jobId: job.id });
    const dir = runDir(outDir, 'validacao');
    try {
      const validation = await runValidations(conn, defs, dir, job, { coligadas, target: info });
      writeSummary(dir, { target: info, validation, params: coligadas ? { coligadas, periods: [] } : null });
      job.result = { dir, validation }; job.status = 'done'; job.done = 1;
      audit.log({ action: 'lv-validacao', by: whoAmI(), detalhe: saved.name, server: db.label(saved), database: info.database, tabelas: defs.length });
    } catch (e) { job.status = 'error'; job.error = db.friendly(e); job.say(`ERRO: ${job.error}`); }
    job.current = null; job.updatedAt = Date.now();
  });

  // ---------- Gerar complemento (só leitura na base; grava TXT numa pasta nova) ----------
  app.post(`${base}/complement`, async (req, res) => {
    cleanup();
    const b = req.body || {};
    let sys; let params; try { sys = C.systemOf(b.system); params = C.cleanParams({ coligada: b.coligada, coligadas: b.coligadas, periods: '' }); } catch (e) { throw httpError(400, e.message); }
    if (params.coligadas.length !== 1) throw httpError(400, 'O complemento é gerado para UMA coligada por vez (os TXT do Hop não trazem a coligada na chave). Informe só uma.', { code: 'LV_ONE_COLIGADA' });
    if (!sys.complement.length) throw httpError(400, `O complemento ainda não está disponível para ${sys.name} (o modelo não tem as chaves dos TXT).`, { code: 'LV_NO_COMPLEMENT' });
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
