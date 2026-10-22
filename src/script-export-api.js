// Gerar arquivos de importação a partir do resultado de um script SQL cadastrado (tela Scripts SQL → Gerar arquivos).
// Fluxo: executar (mesma preparação/travas/confirmação do checklist — script-run.prepareRun — e o mesmo db.runScript, aqui sempre
// DESFEITO no final: nada fica gravado no banco) → resultado guardado em memória (20 min) → prévia (nada é escrito) → gerar.
// A geração usa exatamente o resultado mostrado (o SQL não roda de novo). Nunca sobrescreve sem decisão do usuário:
// arquivo existente → 409 EXPORT_EXISTS (substituir = o antigo vai para a Lixeira; ou gerar novo nome);
// grupos diferentes no mesmo arquivo → 409 EXPORT_DUPLICATES (juntar ou gerar novo nome).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { httpError, str } = require('./util');
const { EXPORT_MAX } = require('./db-core');
const { buildPlan, cleanConfig, fileText, encode, ENCODINGS } = require('./script-export');
const { isInside, sendToRecycleBin, freeName } = require('./workspace-files');

const RESULT_TTL_MS = 20 * 60 * 1000;
const MAX_RESULTS = 3; // resultados em memória (cada um pode ter até 200 mil linhas)
const PREVIEW_ROWS = 1000; // linhas na grade logo após executar; a tela pede mais se o usuário quiser
const PREVIEW_FILES = 2000; // arquivos listados na prévia
const who = () => { try { return os.userInfo().username || null; } catch { return null; } };

let trash = sendToRecycleBin; // testes trocam por uma função simulada (nunca a Lixeira real)
const setTrash = (fn) => { trash = fn || sendToRecycleBin; };

const WRITE_ERR = {
  EACCES: 'sem permissão de escrita', EPERM: 'sem permissão de escrita (ou arquivo somente leitura/em uso)', EBUSY: 'arquivo em uso por outro programa',
  ENOSPC: 'disco cheio', EEXIST: 'o arquivo apareceu durante a geração e não foi sobrescrito', ENAMETOOLONG: 'caminho longo demais', ENOENT: 'pasta inexistente',
};
const writeError = (e) => WRITE_ERR[e.code] || e.message;

function mount(app, { store, audit, db, connPassword, scriptRun, dataDir, SYS }) {
  const results = new Map(); // id → { at, scriptId, scriptName, target, sets: [{columns, rows, total}], cellTruncated }
  const outDirs = new Set(); // pastas onde o app gerou arquivos (só estas podem ser abertas pelo “Abrir pasta”)

  const gc = () => {
    const now = Date.now();
    for (const [id, r] of results) if (now - r.at > RESULT_TTL_MS) results.delete(id);
    while (results.size > MAX_RESULTS) results.delete(results.keys().next().value);
  };
  const getResult = (id) => {
    gc();
    const r = results.get(str(id, 64));
    if (!r) throw httpError(410, 'O resultado expirou ou o aplicativo foi reiniciado. Execute o script de novo.', { code: 'EXPORT_EXPIRED' });
    return r;
  };
  // Conjunto de resultado escolhido, completo (sem corte de linhas nem de valores) — senão o arquivo sairia incompleto.
  const getSet = (r, n) => {
    const rs = r.sets[Number(n) || 0] || (() => { throw httpError(400, 'Conjunto de resultado inexistente.'); })();
    if (rs.total > rs.rows.length) throw httpError(400, `O resultado tem ${rs.total.toLocaleString('pt-BR')} linhas e o limite é ${EXPORT_MAX.rows.toLocaleString('pt-BR')}. Divida o script (ex.: por tabela ou coligada).`, { code: 'EXPORT_TOO_BIG' });
    if (r.cellTruncated) throw httpError(400, `Algum valor do resultado passou de ${EXPORT_MAX.cell.toLocaleString('pt-BR')} caracteres e seria cortado. Nada foi gerado.`, { code: 'EXPORT_TOO_BIG' });
    return rs;
  };

  // Pasta de saída: caminho completo, existente, fora da pasta de dados do app e das pastas de ambientes RM dos clientes.
  function outDirOf(raw) {
    const v = str(raw, 500);
    if (!v || !path.isAbsolute(v)) throw httpError(400, 'Escolha a pasta de saída (caminho completo, ex.: C:\\Migracao\\Importacao).', { code: 'EXPORT_DIR' });
    const dir = path.normalize(v);
    let st; try { st = fs.statSync(dir); } catch { st = null; }
    if (!st || !st.isDirectory()) throw httpError(400, `A pasta de saída “${dir}” não existe.`, { code: 'EXPORT_DIR' });
    if (isInside(dataDir, dir) || isInside(dir, dataDir)) throw httpError(400, 'A pasta de saída não pode ser a pasta de dados do aplicativo.', { code: 'EXPORT_DIR' });
    for (const p of store.data.projects) for (const e of Object.values(p.environments || {})) {
      if (e?.dir && isInside(path.normalize(e.dir), dir)) throw httpError(400, `A pasta de saída fica dentro do ambiente RM “${e.dir}”, que o app nunca altera.`, { code: 'EXPORT_DIR' });
    }
    return dir;
  }

  const targets = () => scriptRun.connTargets();
  app.get('/api/script-export/targets', (req, res) => res.json(targets()));

  // ---------- Executar ----------
  app.post('/api/script-export/run', async (req, res) => {
    const scriptId = str(req.body.scriptId, 40);
    if (!String(req.body.target || '').startsWith('conn:')) throw httpError(400, 'Escolha uma conexão cadastrada.');
    const t = scriptRun.resolveTarget(null, req.body.target, req.body.database);
    const { s, batches, destructive, textSha } = scriptRun.prepareRun({ scriptId, t, body: req.body, kind: 'export-v1' });

    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    const password = await connPassword(t.conn);
    const started = Date.now();
    let out; let error = null;
    try {
      out = await db.runScript(t.conn, password, { name: s.name, batches, allowDestructiveScripts: destructive.length > 0, limits: EXPORT_MAX, rollback: true }, { signal: ac.signal });
    } catch (e) {
      error = e.cancelled ? e.message : db.friendly(e);
      out = e.scriptOutput || null;
    }
    const ms = Date.now() - started;
    audit.log({ action: error ? 'exportacao-script-falhou' : 'exportacao-script-executado', by: who(), detalhe: `${s.name} em ${t.label} (gerar arquivos; transação desfeita no final)`,
      env: t.local ? 'local' : 'prod', server: db.label(t.conn), database: t.conn.database, ms, resultado: error ? error.slice(0, 200) : `${out.returned} linha(s) retornada(s)`, sha256: textSha });
    if (ac.signal.aborted) return;
    const base = { ok: !error, error, ms, target: t.label, identity: out?.identity || null, messages: out?.messages || [], errorInfo: out?.error || null, config: s.exportConfig || null };
    if (error) return res.json({ ...base, sets: [] });
    gc();
    const id = crypto.randomUUID();
    results.set(id, { at: Date.now(), scriptId: s.id, scriptName: s.name, target: t.label, sets: out.results, cellTruncated: !!out.cellTruncated });
    gc();
    res.json({ ...base, resultId: id, returned: out.returned, truncated: !!out.truncated, cellTruncated: !!out.cellTruncated,
      sets: out.results.map((rs) => ({ columns: rs.columns, total: rs.total, loaded: rs.rows.length, hiddenColumns: rs.hiddenColumns, rows: rs.rows.slice(0, PREVIEW_ROWS) })) });
  });

  // Mais linhas para a grade (o usuário aumenta a visualização; no máximo o que foi carregado).
  app.get('/api/script-export/results/:rid/rows', (req, res) => {
    const r = getResult(req.params.rid);
    const rs = r.sets[Number(req.query.set) || 0] || (() => { throw httpError(400, 'Conjunto de resultado inexistente.'); })();
    const limit = Math.max(1, Math.min(Number(req.query.limit) || PREVIEW_ROWS, EXPORT_MAX.rows));
    res.json({ rows: rs.rows.slice(0, limit), total: rs.total, loaded: rs.rows.length });
  });

  // ---------- Prévia (nada é escrito) ----------
  function planFor(b, opts) {
    const r = getResult(b.resultId);
    const rs = getSet(r, b.set);
    return { r, rs, plan: buildPlan(rs, b.config, opts) };
  }
  app.post('/api/script-export/preview', (req, res) => {
    const { rs, plan } = planFor(req.body);
    const outDir = outDirOf(req.body.outDir);
    let unmappable = 0;
    if (plan.config.encoding === 'ansi') for (const f of plan.files) unmappable += encode(fileText(f, rs.rows, plan.content, plan.config), 'ansi').unmappable;
    const cmp = (x, y) => x.localeCompare(y, 'pt-BR', { numeric: true, sensitivity: 'base' });
    const byPath = (a, b) => { for (let i = 0; i < Math.min(a.dirs.length, b.dirs.length); i++) { const c = cmp(a.dirs[i], b.dirs[i]); if (c) return c; } return a.dirs.length - b.dirs.length || cmp(a.name, b.name); };
    const files = plan.files.map((f) => ({ rel: f.rel, dirs: f.dirs, name: f.name, lines: f.rows.length, exists: fs.existsSync(path.join(outDir, f.rel)) })).sort(byPath); // árvore da prévia em ordem
    const newFolders = new Set();
    for (const f of plan.files) for (let d = 1; d <= f.dirs.length; d++) { const rel = path.join(...f.dirs.slice(0, d)); if (!fs.existsSync(path.join(outDir, rel))) newFolders.add(rel.toLowerCase()); }
    res.json({ outDir, totalFiles: files.length, files: files.slice(0, PREVIEW_FILES), existing: files.filter((f) => f.exists).map((f) => f.rel).slice(0, 200), existingCount: files.filter((f) => f.exists).length,
      folders: plan.folders, newFolders: newFolders.size, lines: plan.lines, warnings: plan.warnings, duplicates: plan.duplicates.slice(0, 200), duplicateCount: plan.duplicates.length,
      unmappable, encoding: ENCODINGS[plan.config.encoding] });
  });

  // ---------- Gerar ----------
  // onExisting: 'replace' | 'rename' (sem isso e com arquivo existente → 409). duplicates: 'merge' | 'rename' (idem).
  app.post('/api/script-export/generate', async (req, res) => {
    const b = req.body;
    const dupMode = ['merge', 'rename'].includes(b.duplicates) ? b.duplicates : null;
    const onExisting = ['replace', 'rename'].includes(b.onExisting) ? b.onExisting : null;
    const { r, rs, plan } = planFor(b, { splitDuplicates: dupMode === 'rename' });
    const outDir = outDirOf(b.outDir);
    if (plan.duplicates.length && !dupMode) {
      throw httpError(409, `O nome configurado pode gerar arquivos com nomes repetidos: ${plan.duplicates.length} arquivo(s) receberiam linhas de grupos diferentes. Escolha juntar no mesmo arquivo ou gerar nomes diferentes.`,
        { code: 'EXPORT_DUPLICATES', conflicts: plan.duplicates.slice(0, 50) });
    }
    const existing = [...new Set(plan.files.map((f) => f.rel.toLowerCase()))].map((k) => plan.files.find((f) => f.rel.toLowerCase() === k).rel).filter((rel) => fs.existsSync(path.join(outDir, rel)));
    if (existing.length && !onExisting) {
      throw httpError(409, `${existing.length === 1 ? 'Já existe 1 arquivo' : `Já existem ${existing.length} arquivos`} com o mesmo nome na pasta de saída. Escolha substituir (o antigo vai para a Lixeira), gerar novo nome ou cancelar.`,
        { code: 'EXPORT_EXISTS', conflicts: existing.slice(0, 50) });
    }
    if (existing.some((rel) => { try { return fs.statSync(path.join(outDir, rel)).isDirectory(); } catch { return false; } })) {
      throw httpError(400, 'Um dos arquivos a gerar tem o mesmo nome de uma pasta existente. Ajuste o nome do arquivo.');
    }
    // Permissão de escrita: testa antes de mexer em qualquer coisa.
    const probe = path.join(outDir, `.gp-teste-escrita-${crypto.randomBytes(4).toString('hex')}.tmp`);
    try { fs.writeFileSync(probe, ''); fs.unlinkSync(probe); } catch (e) { throw httpError(400, `Não foi possível gravar na pasta “${outDir}”: ${writeError(e)}.`, { code: 'EXPORT_DIR' }); }

    let replaced = 0;
    if (existing.length && onExisting === 'replace') {
      await trash(existing.map((rel) => path.join(outDir, rel)));
      replaced = existing.length;
    }
    // Pastas criadas: as que não existiam antes.
    let foldersCreated = 0;
    const errors = [];
    const dirsDone = new Set();
    const taken = new Set(); // caminhos já usados nesta geração (minúsculas)
    let filesCreated = 0; let lines = 0; let renamed = 0; let unmappable = 0;
    for (const f of plan.files) {
      const dir = path.join(outDir, ...f.dirs);
      try {
        for (let d = 1; d <= f.dirs.length; d++) {
          const sub = path.join(outDir, ...f.dirs.slice(0, d));
          if (dirsDone.has(sub.toLowerCase())) continue;
          if (!fs.existsSync(sub)) { fs.mkdirSync(sub); foldersCreated++; }
          dirsDone.add(sub.toLowerCase());
        }
        let name = f.name;
        if (fs.existsSync(path.join(dir, name)) || taken.has(path.join(dir, name).toLowerCase())) { name = freeName(dir, name, false, taken); renamed++; }
        const target = path.join(dir, name);
        const enc = encode(fileText(f, rs.rows, plan.content, plan.config), plan.config.encoding);
        fs.writeFileSync(target, enc.buffer, { flag: 'wx' }); // 'wx': nunca sobrescreve
        taken.add(target.toLowerCase());
        filesCreated++; lines += f.rows.length; unmappable += enc.unmappable;
      } catch (e) {
        errors.push({ file: f.rel, error: e.status ? e.message : writeError(e) });
      }
    }
    outDirs.add(outDir.toLowerCase());
    audit.log({ action: 'exportacao-arquivos-gerados', by: who(), detalhe: `${r.scriptName} (${r.target})`, pasta: outDir,
      resultado: `${filesCreated} arquivo(s), ${foldersCreated} pasta(s), ${lines} linha(s), ${errors.length} erro(s)${replaced ? `, ${replaced} substituído(s) (antigos na Lixeira)` : ''}` });
    res.json({ outDir, filesCreated, foldersCreated, lines, errors, replaced, renamed, unmappable, encoding: ENCODINGS[plan.config.encoding] });
  });

  // Abre no Explorer uma pasta onde o app acabou de gerar arquivos (só essas).
  app.post('/api/script-export/open-folder', (req, res) => {
    const dir = path.normalize(str(req.body.path, 500) || '.');
    if (!outDirs.has(dir.toLowerCase()) || !fs.existsSync(dir)) throw httpError(400, 'Pasta não encontrada.');
    spawn(path.join(SYS, 'explorer.exe'), [dir], { detached: true, stdio: 'ignore' }).unref();
    res.json({ ok: true });
  });

  // ---------- Configuração salva junto ao script ----------
  app.put('/api/scripts/:id/export-config', (req, res) => {
    const s = store.data.scripts.find((x) => x.id === req.params.id) || (() => { throw httpError(404, 'Script não encontrado.'); })();
    const config = cleanConfig(req.body.config);
    if (!config.contentColumn) throw httpError(400, 'Escolha a coluna com o conteúdo das linhas antes de salvar.');
    if (!config.fileName) throw httpError(400, 'Informe o nome do arquivo antes de salvar.');
    s.exportConfig = config;
    store.save();
    res.json({ exportConfig: config });
  });
}

module.exports = { mount, setTrash };
