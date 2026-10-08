// Workspace → Git → Ações rápidas (src/git-actions.js): prévia não altera nada, execução só com o token da prévia,
// confirmação nas avançadas e cada operação com o efeito mínimo esperado. Repositórios em pasta temporária e remoto
// "file:///" local (nunca GitHub/rede real).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const git = require('../src/git');
const A = require('../src/git-actions');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-gact-'));
const G = (dir, args) => git.run(dir, args).then((r) => { if (r.code !== 0) throw new Error(r.stderr); return r.stdout; });
const write = (repo, f, t) => { fs.mkdirSync(path.dirname(path.join(repo.root, f)), { recursive: true }); fs.writeFileSync(path.join(repo.root, f), t); };
const read = (repo, f) => fs.readFileSync(path.join(repo.root, f), 'utf8').replace(/\r/g, '');
const exists = (repo, f) => fs.existsSync(path.join(repo.root, f));
let n = 0;
async function mkRepo(files = { 'a.sql': 'SELECT 1\n' }, name = `r${++n}`) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  await G(dir, ['init']);
  await G(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  await G(dir, ['config', 'user.name', 'Teste']);
  await G(dir, ['config', 'user.email', 'teste@exemplo.com']);
  await G(dir, ['config', 'core.autocrlf', 'false']);
  const repo = new git.GitRepo(dir);
  for (const [f, t] of Object.entries(files)) write(repo, f, t);
  await G(dir, ['add', '-A']);
  await G(dir, ['commit', '-m', 'inicial']);
  return repo;
}
async function commit(repo, files, msg) { for (const [f, t] of Object.entries(files)) write(repo, f, t); await G(repo.root, ['add', '-A']); await G(repo.root, ['commit', '-m', msg]); return (await G(repo.root, ['rev-parse', 'HEAD'])).trim(); }
const head = async (repo) => (await G(repo.root, ['rev-parse', 'HEAD'])).trim();
const run = async (repo, action, params, extra = {}) => { const p = await A.preview(repo, action, params); return A.execute(repo, action, p.params, { token: p.token, ...extra }); };
async function bare(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  await G(dir, ['init', '--bare']);
  await G(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  return `file:///${dir.replace(/\\/g, '/')}`;
}

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('prévia não altera nada; execução exige o token da prévia e recusa se o repositório mudou', async () => {
  const r = await mkRepo();
  write(r, 'a.sql', 'SELECT 2\n');
  const before = (await r.status()).files;
  const p = await A.preview(r, 'restore-file', { path: 'a.sql' });
  assert.equal(p.risk, 'attention');
  assert.deepEqual(p.commands, ['git restore --source=HEAD --staged --worktree -- a.sql']);
  assert.deepEqual(p.affected, ['a.sql']);
  assert.deepEqual((await r.status()).files, before, 'prévia não mexe em nada');
  assert.equal(read(r, 'a.sql'), 'SELECT 2\n');
  await assert.rejects(A.execute(r, 'restore-file', p.params, { token: 'x' }), (e) => e.code === 'GIT_PLAN_CHANGED');
  write(r, 'b.sql', 'novo\n'); // o repositório mudou depois da prévia
  await assert.rejects(A.execute(r, 'restore-file', p.params, { token: p.token }), (e) => e.code === 'GIT_PLAN_CHANGED');
  assert.equal(read(r, 'a.sql'), 'SELECT 2\n', 'nada executado');
  await assert.rejects(A.preview(r, 'rm -rf', {}), /desconhecida/);
  await assert.rejects(A.preview(r, 'restore-file', { path: '../fora.txt' }), /Caminho inválido/);
  await assert.rejects(A.preview(r, 'revert', { commit: 'HEAD; del *' }), /Commit inválido/);
});

test('voltar este arquivo: só ele; arquivo novo ou adicionado é recusado (não apaga o que não está em versão)', async () => {
  const r = await mkRepo({ 'a.sql': 'A\n', 'b.sql': 'B\n' });
  write(r, 'a.sql', 'A2\n'); write(r, 'b.sql', 'B2\n'); write(r, 'novo.sql', 'N\n');
  await run(r, 'restore-file', { path: 'a.sql' });
  assert.equal(read(r, 'a.sql'), 'A\n');
  assert.equal(read(r, 'b.sql'), 'B2\n', 'os outros não mudam');
  await assert.rejects(A.preview(r, 'restore-file', { path: 'novo.sql' }), /arquivo novo/);
  await G(r.root, ['add', 'novo.sql']);
  await assert.rejects(A.preview(r, 'restore-file', { path: 'novo.sql' }), /não existe na última versão/);
  assert.ok(exists(r, 'novo.sql'));
});

test('ponto de segurança: só branch (avisa que alterações não entram) ou checkpoint completo com os arquivos mostrados', async () => {
  const r = await mkRepo({ 'a.sql': 'A\n', 'b.sql': 'B\n' });
  const h0 = await head(r);
  write(r, 'a.sql', 'A2\n'); write(r, 'b.sql', 'B2\n');
  const p = await A.preview(r, 'checkpoint', { name: 'backup/antes-teste' });
  assert.equal(p.risk, 'safe');
  assert.ok(p.warnings.some((w) => /não commitadas/.test(w)));
  assert.ok(p.warnings.some((w) => /ignorados pelo Git/.test(w)));
  await A.execute(r, 'checkpoint', p.params, { token: p.token });
  assert.equal((await G(r.root, ['rev-parse', 'backup/antes-teste'])).trim(), h0);
  assert.equal(read(r, 'a.sql'), 'A2\n', 'arquivos intactos');
  await assert.rejects(A.preview(r, 'checkpoint', { name: 'backup/antes-teste' }), (e) => e.code === 'GIT_EXISTS');
  const auto = await A.preview(r, 'checkpoint', {});
  assert.match(auto.params.name, /^backup\/\d{4}-\d{2}-\d{2}-\d{4}$/);

  const full = await A.preview(r, 'checkpoint', { name: 'backup/completo', includeChanges: true, paths: ['a.sql'] });
  assert.deepEqual(full.affected, ['a.sql']);
  assert.deepEqual(full.commands, ['git add -A -- a.sql', 'git commit -m "Checkpoint backup/completo" -- a.sql', 'git branch backup/completo']);
  await A.execute(r, 'checkpoint', full.params, { token: full.token });
  assert.deepEqual((await r.status()).files.map((f) => f.path), ['b.sql'], 'só o arquivo mostrado entrou no commit');
  assert.equal((await G(r.root, ['rev-parse', 'backup/completo'])).trim(), await head(r));
});

test('guardar para depois (stash) → lista → recuperar com apply (mantém o item) → remover', async () => {
  const r = await mkRepo();
  write(r, 'a.sql', 'A2\n'); write(r, 'novo.sql', 'N\n');
  await run(r, 'stash-push', { message: 'Antes do teste X' });
  assert.equal((await r.status()).files.length, 0, 'pasta limpa');
  const list = await r.stashes();
  assert.equal(list.length, 1);
  assert.match(list[0].message, /Antes do teste X/);
  const ap = await A.preview(r, 'stash-apply', { ref: list[0].ref });
  assert.deepEqual(ap.affected.sort(), ['a.sql', 'novo.sql']);
  await A.execute(r, 'stash-apply', ap.params, { token: ap.token });
  assert.equal(read(r, 'a.sql'), 'A2\n');
  assert.equal(read(r, 'novo.sql'), 'N\n');
  assert.equal((await r.stashes()).length, 1, 'apply mantém o item guardado');
  await run(r, 'stash-drop', { ref: 'stash@{0}' });
  assert.equal((await r.stashes()).length, 0);
  await assert.rejects(A.preview(r, 'stash-apply', { ref: 'stash@{0}; x' }), /inválido/);
});

test('recuperar arquivo de outra versão: só aquele arquivo; o resto do projeto não volta', async () => {
  const r = await mkRepo({ 'server.js': 'v1\n', 'b.sql': 'B1\n' });
  const c1 = await head(r);
  await commit(r, { 'server.js': 'v2\n', 'b.sql': 'B2\n' }, 'c2');
  await run(r, 'restore-from', { commit: c1, path: 'server.js' });
  assert.equal(read(r, 'server.js'), 'v1\n');
  assert.equal(read(r, 'b.sql'), 'B2\n');
  await assert.rejects(A.preview(r, 'restore-from', { commit: c1, path: 'nao-existe.js' }), /não existe na versão/);
});

test('descartar tudo e limpar não versionados: avançadas exigem confirmação; ignorados e novos ficam', async () => {
  const r = await mkRepo({ 'a.sql': 'A\n', '.gitignore': '*.log\n' });
  write(r, 'a.sql', 'A2\n'); write(r, 'novo.sql', 'N\n'); write(r, 'dir/x.sql', 'X\n'); write(r, 'app.log', 'L\n');
  write(r, 'add.sql', 'ADD\n'); await G(r.root, ['add', 'add.sql']);
  const d = await A.preview(r, 'discard-all', {});
  assert.equal(d.risk, 'advanced');
  assert.equal(d.suggestCheckpoint, true);
  await assert.rejects(A.execute(r, 'discard-all', d.params, { token: d.token }), (e) => e.code === 'GIT_CONFIRM');
  await A.execute(r, 'discard-all', d.params, { token: d.token, confirm: true });
  assert.equal(read(r, 'a.sql'), 'A\n');
  assert.ok(exists(r, 'novo.sql') && exists(r, 'add.sql'), 'arquivos novos e o recém-adicionado não são apagados');

  const c = await A.preview(r, 'clean', {});
  assert.deepEqual(c.affected.sort(), ['add.sql', 'dir/', 'novo.sql']);
  assert.ok(!c.affected.includes('app.log'), 'ignorados nunca entram');
  assert.equal(c.preview, 'git clean -n -d');
  await A.execute(r, 'clean', c.params, { token: c.token, confirm: true });
  assert.ok(!exists(r, 'novo.sql') && !exists(r, 'dir/x.sql'));
  assert.ok(exists(r, 'app.log'), 'ignorado continua');
});

test('desfazer último commit (local) mantém as alterações; publicado é recusado → revert cria novo commit', async () => {
  const url = await bare('remoto-undo.git');
  const r = await mkRepo({ 'a.sql': 'A\n' });
  await r.addRemote('origin', url);
  await r.push();
  const c2 = await commit(r, { 'a.sql': 'A2\n' }, 'c2');
  await run(r, 'undo-commit', {});
  assert.notEqual(await head(r), c2);
  assert.equal(read(r, 'a.sql'), 'A2\n', 'alteração continua no arquivo');
  const c3 = await commit(r, { 'a.sql': 'A3\n' }, 'c3');
  await r.push();
  await assert.rejects(A.preview(r, 'undo-commit', {}), (e) => e.code === 'GIT_PUBLISHED');
  const p = await A.preview(r, 'revert', { commit: c3 });
  assert.deepEqual(p.commands, [`git revert --no-edit ${c3}`]);
  await A.execute(r, 'revert', p.params, { token: p.token });
  assert.equal(read(r, 'a.sql'), 'A\n');
  assert.match((await G(r.root, ['log', '-n2', '--format=%s'])), /^Revert "c3"\nc3/, 'histórico preservado, novo commit no topo');
  write(r, 'a.sql', 'sujo\n');
  await assert.rejects(A.preview(r, 'revert', { commit: c3 }), (e) => e.code === 'GIT_DIRTY');
});

test('abrir versão antiga (consulta ou branch), criar branch, renomear e marcar versão', async () => {
  const r = await mkRepo({ 'a.sql': 'A1\n' });
  const c1 = await head(r);
  await commit(r, { 'a.sql': 'A2\n' }, 'c2');
  await run(r, 'open-old', { commit: c1, mode: 'branch' });
  assert.equal((await r.status()).branch, `consulta/${c1.slice(0, 7)}`);
  assert.equal(read(r, 'a.sql'), 'A1\n');
  await G(r.root, ['switch', 'main']);
  await run(r, 'open-old', { commit: c1, mode: 'detach' });
  assert.equal((await r.status()).detached, true);
  await G(r.root, ['switch', 'main']);
  await run(r, 'branch-from', { commit: c1, name: 'recuperacao/versao-estavel', checkout: false });
  assert.equal((await r.status()).branch, 'main', 'sem checkout: continua na atual');
  await run(r, 'branch-rename', { from: 'recuperacao/versao-estavel', to: 'recuperacao/v1' });
  assert.equal((await G(r.root, ['rev-parse', 'recuperacao/v1'])).trim(), c1);
  await run(r, 'tag', { commit: c1, name: 'versao-estavel-2026-10-08', message: 'Estável' });
  assert.equal((await G(r.root, ['rev-parse', 'versao-estavel-2026-10-08^{commit}'])).trim(), c1);
  await assert.rejects(A.preview(r, 'tag', { name: 'nome com espaço' }), /inválido/);
  write(r, 'a.sql', 'sujo\n');
  await assert.rejects(A.preview(r, 'open-old', { commit: c1 }), (e) => e.code === 'GIT_DIRTY');
});

test('trazer alteração (cherry-pick): só o commit escolhido; conflito → cancelar ou concluir com commit', async () => {
  const r = await mkRepo({ 'a.sql': 'A\n', 'b.sql': 'B\n' });
  await G(r.root, ['switch', '-c', 'feature']);
  await commit(r, { 'x.sql': 'X\n' }, 'outra coisa');
  const fix = await commit(r, { 'b.sql': 'B-corrigido\n' }, 'correção X');
  await G(r.root, ['switch', 'main']);
  await run(r, 'cherry-pick', { commit: fix });
  assert.equal(read(r, 'b.sql'), 'B-corrigido\n');
  assert.ok(!exists(r, 'x.sql'), 'as outras mudanças da branch não vêm');
  await assert.rejects(A.preview(r, 'cherry-pick', { commit: fix.slice(0, 7) }), /já foi trazida/, 'a mesma correção não é trazida duas vezes');

  await G(r.root, ['switch', 'feature']);
  const conflict = await commit(r, { 'a.sql': 'A-feature\n' }, 'muda a');
  await G(r.root, ['switch', 'main']);
  await commit(r, { 'a.sql': 'A-main\n' }, 'muda a no main');
  const out = await run(r, 'cherry-pick', { commit: conflict });
  assert.equal(out.conflict, true);
  assert.deepEqual(out.conflicts, ['a.sql']);
  assert.equal((await r.status()).cherryPicking, true);
  await run(r, 'cherry-pick-abort', {});
  assert.equal((await r.status()).cherryPicking, false);
  assert.equal(read(r, 'a.sql'), 'A-main\n');
  // conflito resolvido → commit completo (o Git recusa commit parcial durante cherry-pick)
  await run(r, 'cherry-pick', { commit: conflict });
  write(r, 'a.sql', 'A-resolvido\n');
  await r.markResolved('a.sql');
  const c = await r.commit('', ['a.sql']);
  assert.equal(c.merge, true);
  assert.equal((await r.status()).cherryPicking, false);
  assert.match(await G(r.root, ['log', '-n1', '--format=%s']), /muda a/);
});

test('reflog recupera commit perdido; voltar projeto (reset --hard) mostra o que sai e exige confirmação', async () => {
  const r = await mkRepo({ 'a.sql': 'A1\n' });
  const c1 = await head(r);
  const c2 = await commit(r, { 'a.sql': 'A2\n' }, 'c2 importante');
  write(r, 'a.sql', 'local\n');
  const p = await A.preview(r, 'reset-hard', { commit: c1 });
  assert.equal(p.risk, 'advanced');
  assert.equal(p.lists[0].items.length, 1);
  assert.match(p.lists[0].items[0], /c2 importante/);
  assert.match(p.affected[0], /a\.sql .*PERDIDA/);
  await assert.rejects(A.execute(r, 'reset-hard', p.params, { token: p.token }), (e) => e.code === 'GIT_CONFIRM');
  await A.execute(r, 'reset-hard', p.params, { token: p.token, confirm: true });
  assert.equal(await head(r), c1);
  const log = await r.reflog();
  assert.ok(log.some((x) => x.hash === c2), 'commit “perdido” aparece no reflog');
  assert.ok(log[0].date && log[0].action);
  await run(r, 'branch-from', { commit: c2, name: 'recuperacao/c2' });
  assert.equal((await G(r.root, ['rev-parse', 'recuperacao/c2'])).trim(), c2);
});

test('comparar versões: arquivos adicionados, removidos e alterados + diff de um arquivo', async () => {
  const r = await mkRepo({ 'a.sql': 'A\n', 'b.sql': 'B\n' });
  const c1 = await head(r);
  await G(r.root, ['rm', '-q', 'b.sql']);
  const c2 = await commit(r, { 'a.sql': 'A2\n', 'c.sql': 'C\n' }, 'c2');
  const cmp = await r.compare(c1, c2);
  assert.deepEqual(cmp.files.map((f) => `${f.status} ${f.path}`).sort(), ['A c.sql', 'D b.sql', 'M a.sql']);
  const d = await r.compareFileDiff(c1, c2, 'a.sql');
  assert.deepEqual([d.original, d.modified], ['A\n', 'A2\n']);
});

test('remoto: baixar mostra o que chega; enviar mostra branch e commits; voltar versão publicada só com --force-with-lease', async () => {
  const url = await bare('remoto-main.git');
  const r = await mkRepo({ 'a.sql': 'A1\n' }, 'pub');
  await r.addRemote('origin', url);
  await r.push();
  const c1 = await head(r);
  await commit(r, { 'a.sql': 'A2\n' }, 'c2 errado');
  const push = await A.preview(r, 'push', {});
  assert.match(push.effect, /Envia 1 commit da branch local “main” → origin\/main/);
  await A.execute(r, 'push', push.params, { token: push.token });

  // outra cópia publica algo; aqui: "Baixar alterações" consulta antes e lista o que chega
  const other = path.join(tmp, 'outra');
  await G(tmp, ['clone', '-q', url, other]);
  await G(other, ['config', 'user.name', 'Outro']); await G(other, ['config', 'user.email', 'o@exemplo.com']);
  fs.writeFileSync(path.join(other, 'b.sql'), 'B\n'); await G(other, ['add', '-A']); await G(other, ['commit', '-m', 'do colega']); await G(other, ['push', '-q']);
  const pull = await A.preview(r, 'pull', {});
  assert.match(pull.effect, /Remoto tem 1 commit novo/);
  assert.match(pull.lists[0].items[0], /do colega/);
  await A.execute(r, 'pull', pull.params, { token: pull.token });
  assert.equal(read(r, 'b.sql'), 'B\n');

  // voltar versão publicada: confirmação forte; backups; colega publica depois da prévia → recusado
  const p = await A.preview(r, 'rewind-remote', { commit: c1 });
  assert.equal(p.high, true);
  assert.equal(p.confirmText, 'main');
  assert.ok(p.commands.some((c) => c.startsWith('git push --force-with-lease=refs/heads/main:')));
  assert.ok(!p.commands.some((c) => / --force( |$)/.test(c)), 'nunca --force');
  assert.equal(p.lists[0].items.length, 2);
  fs.writeFileSync(path.join(other, 'c.sql'), 'C\n'); await G(other, ['add', '-A']); await G(other, ['commit', '-m', 'publicado depois']); await G(other, ['pull', '-q', '--no-rebase']).catch(() => {}); await G(other, ['push', '-q']);
  await assert.rejects(A.execute(r, 'rewind-remote', p.params, { token: p.token, confirm: true, confirmText: 'main' }), (e) => e.code === 'GIT_PLAN_CHANGED');

  const p2 = await A.preview(r, 'rewind-remote', { commit: c1 });
  await assert.rejects(A.execute(r, 'rewind-remote', p2.params, { token: p2.token, confirm: true, confirmText: 'errado' }), (e) => e.code === 'GIT_CONFIRM');
  const remoteBefore = (await G(r.root, ['rev-parse', 'origin/main'])).trim();
  await A.execute(r, 'rewind-remote', p2.params, { token: p2.token, confirm: true, confirmText: 'main' });
  assert.equal((await G(other, ['ls-remote', url, 'refs/heads/main'])).split('\t')[0], c1, 'remoto voltou');
  const backups = (await G(r.root, ['branch', '--list', 'backup/*', '--format=%(refname:short) %(objectname)'])).trim().split('\n');
  assert.ok(backups.some((l) => l.startsWith('backup/remoto-main-') && l.endsWith(remoteBefore)), 'versão publicada anterior guardada');
});

// ---------- API ----------
const PORT = 4458;
process.env.PORT = String(PORT);
process.env.GP_DATA_DIR = path.join(tmp, 'data');
const { app } = require('../server');
const base = `http://localhost:${PORT}`;
const api = async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Origin: base }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
let server;
test.before(() => { server = app.listen(PORT, '127.0.0.1'); });
test.after(() => server.close());

test('API: prévia → execução com token; avançada sem confirmação recusada; auditoria; leituras de apoio', async () => {
  const wsRoot = path.join(tmp, 'Projetos');
  fs.mkdirSync(wsRoot);
  const r = await mkRepo({ 'scripts/PFUNC.sql': 'SELECT 1\n' }, path.join('Projetos', 'Cliente_A'));
  assert.equal((await api('PUT', '/api/wsm', { root: wsRoot })).status, 200);
  write(r, 'scripts/PFUNC.sql', 'SELECT 2\n');
  const pv = await api('POST', '/api/wsm/git/action/preview', { project: 'Cliente_A', action: 'stash-push', params: { message: 'Antes do teste' } });
  assert.equal(pv.status, 200, JSON.stringify(pv.json));
  assert.deepEqual(pv.json.commands, ['git stash push --include-untracked -m "Antes do teste"']);
  const run_ = await api('POST', '/api/wsm/git/action/run', { project: 'Cliente_A', action: 'stash-push', params: pv.json.params, token: pv.json.token });
  assert.equal(run_.json.ok, true, JSON.stringify(run_.json));
  assert.equal((await api('GET', '/api/wsm/git/stashes?project=Cliente_A')).json.length, 1);
  assert.ok((await api('GET', '/api/wsm/git/reflog?project=Cliente_A')).json.length >= 1);
  assert.ok(Array.isArray((await api('GET', '/api/wsm/git?project=Cliente_A')).json.remoteBranches));

  write(r, 'scripts/PFUNC.sql', 'SELECT 3\n');
  const d = await api('POST', '/api/wsm/git/action/preview', { project: 'Cliente_A', action: 'discard-all', params: {} });
  const noConfirm = await api('POST', '/api/wsm/git/action/run', { project: 'Cliente_A', action: 'discard-all', params: d.json.params, token: d.json.token, confirm: 'true' });
  assert.equal(noConfirm.json.code, 'GIT_CONFIRM', 'só confirm === true vale');
  assert.equal(read(r, 'scripts/PFUNC.sql'), 'SELECT 3\n');
  assert.equal((await api('POST', '/api/wsm/git/action/preview', { project: '../..', action: 'clean', params: {} })).status, 400);
  const audit = fs.readFileSync(path.join(process.env.GP_DATA_DIR, 'audit.log'), 'utf8');
  assert.match(audit, /"action":"git-acao".*git stash push/);
});
