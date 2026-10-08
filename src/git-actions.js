// Workspace → Git → Ações rápidas. Cada ação é uma operação Git do dia a dia com nome simples; aqui ela vira um PLANO:
// comandos Git conhecidos (lista fixa, argumentos montados aqui com dados validados — nunca texto livre), efeito,
// arquivos/commits afetados, avisos e nível de risco. A tela mostra o plano (prévia) e só então pede a execução.
//
// Segurança:
//  - prévia e execução usam o MESMO plano: a execução monta o plano de novo e confere o "token" (ação + parâmetros +
//    estado do repositório + comandos). Mudou algo desde a prévia (arquivos, HEAD, remoto) → 409 GIT_PLAN_CHANGED;
//  - risco "advanced" exige confirmação explícita (confirm:true); voltar a versão publicada exige digitar o nome da branch;
//  - preferência pela operação que muda MENOS: restaurar arquivo > revert > cherry-pick > branch > stash > reset > force.
//    Push forçado só com --force-with-lease (nunca --force), depois de fetch e de criar branches de segurança.
const crypto = require('crypto');
const { httpError, str } = require('./util');
const git = require('./git');

const { run, checkHash, checkBranchName, NETWORK_TIMEOUT } = git;
const RISK = { safe: 'Seguro', attention: 'Atenção', advanced: 'Avançado' };
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
const quote = (a) => (a === '' || /[\s"'{}]/.test(a) ? `"${String(a).replace(/"/g, '\\"')}"` : a);
const shown = (args) => `git ${args.map(quote).join(' ')}`;
const step = (args, opts = {}) => ({ cmd: shown(args), args, ...opts });
const plural = (n, s, p) => `${n} ${n === 1 ? s : p}`;
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
const lines = (s) => String(s || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);

const IGNORED_NOTE = 'Arquivos ignorados pelo Git (.gitignore) e arquivos fora do repositório não entram — se houver dados locais importantes fora do Git, copie-os à parte.';

// ---------- Validações e leituras auxiliares ----------
async function commitOf(repo, h) {
  const v = checkHash(h);
  const r = await run(repo.root, ['rev-parse', '--verify', '--quiet', `${v}^{commit}`]);
  if (r.code !== 0) throw httpError(400, `Versão (commit) não encontrada: ${v}.`);
  const full = r.stdout.trim();
  const m = await git.ok(repo.root, ['show', '-s', '--format=%h%x1f%P%x1f%aI%x1f%s', full]);
  const [short, parents, date, subject] = m.stdout.trim().split('\x1f');
  return { hash: full, short, parents: parents ? parents.split(' ').filter(Boolean) : [], date, subject };
}
async function refExists(repo, ref) { return (await run(repo.root, ['rev-parse', '--verify', '--quiet', ref])).code === 0; }
async function newBranchName(repo, name) {
  const n = await checkBranchName(repo.root, name);
  if (await refExists(repo, `refs/heads/${n}`)) throw httpError(409, `Já existe uma branch chamada “${n}”. Escolha outro nome.`, { code: 'GIT_EXISTS' });
  return n;
}
async function tagName(repo, name) {
  const n = String(name ?? '').trim();
  if (!n || n.startsWith('-') || n.length > 200 || (await run(repo.root, ['check-ref-format', `refs/tags/${n}`])).code !== 0) throw httpError(400, `Nome de marco (tag) inválido: “${n}” (sem espaços, “..”, “~”, “^”, “:”, “?”, “*”, “[”).`);
  if (await refExists(repo, `refs/tags/${n}`)) throw httpError(409, `Já existe o marco “${n}”.`, { code: 'GIT_EXISTS' });
  return n;
}
const shortText = (v, max, what) => {
  const t = str(v, max + 1).replace(/[\r\n]+/g, ' ').trim();
  if (t.length > max) throw httpError(400, `${what} longa demais.`);
  return t;
};
// Commits de um intervalo (ex.: "A..B" ou ['HEAD', '--not', '--remotes']) em linhas legíveis.
async function commitsIn(repo, range, limit = 200) {
  const r = await run(repo.root, ['log', `-n${limit}`, '--format=%h%x1f%aI%x1f%s', ...(Array.isArray(range) ? range : [range])]);
  return r.code === 0 ? lines(r.stdout).map((l) => { const [h, d, s] = l.split('\x1f'); return `${h} · ${s} (${String(d).slice(0, 10)})`; }) : [];
}
async function commitFiles(repo, c) {
  const base = c.parents.length ? [c.parents[0], c.hash] : ['--root', c.hash];
  const r = await run(repo.root, ['diff-tree', '-r', '--no-commit-id', '--name-only', ...base]);
  return r.code === 0 ? lines(r.stdout) : [];
}
async function onRemote(repo, ref = 'HEAD') {
  const r = await run(repo.root, ['branch', '-r', '--contains', ref]);
  return r.code === 0 ? lines(r.stdout).filter((x) => !x.includes('->')) : [];
}
const tracked = (st) => st.files.filter((f) => !f.untracked);
function requireIdle(st) {
  const busy = st.merging ? 'um merge' : st.cherryPicking ? 'a aplicação de uma alteração (cherry-pick)' : st.reverting ? 'um revert' : st.rebasing ? 'um rebase' : null;
  if (busy) throw httpError(409, `Há ${busy} em andamento. Conclua ou cancele antes (painel Git → Alterações).`, { code: 'GIT_BUSY' });
}
function requireClean(st, what) {
  const n = tracked(st).length;
  if (n) throw httpError(409, `Há ${plural(n, 'arquivo alterado', 'arquivos alterados')} sem commit. Antes de ${what}, salve uma versão (commit) ou use “Guardar alterações para depois”.`, { code: 'GIT_DIRTY' });
}
const needCommits = (st) => { if (!st.oid) throw httpError(400, 'O repositório ainda não tem nenhum commit. Salve a primeira versão antes.'); };
function upstreamParts(st, remotes) {
  if (!st.upstream) return null;
  const remote = remotes.find((r) => st.upstream.startsWith(`${r}/`));
  return remote ? { remote, branch: st.upstream.slice(remote.length + 1) } : null;
}

// ---------- Catálogo ----------
// Cada ação recebe (repo, params, status) e devolve o plano. params já validados ficam em plan.params (a tela devolve
// esses mesmos params na execução — ex.: o nome automático do ponto de segurança não muda entre prévia e execução).
const ACTIONS = {
  // 3 e 4. Ponto de segurança / cópia desta versão: branch no commit atual; opcionalmente commit das alterações antes.
  async checkpoint(repo, p, st) {
    requireIdle(st);
    needCommits(st);
    const name = await newBranchName(repo, p.name || `backup/${stamp()}`);
    const changed = st.files.filter((f) => !f.conflict);
    const out = { label: p.includeChanges ? 'Criar checkpoint completo' : 'Criar ponto de segurança', risk: 'safe', params: { name, includeChanges: !!p.includeChanges }, warnings: [IGNORED_NOTE] };
    if (!p.includeChanges) {
      if (changed.length) out.warnings.unshift(`Há ${plural(changed.length, 'arquivo com alterações não commitadas', 'arquivos com alterações não commitadas')}: a branch guarda só o que já está commitado. Para incluí-las, use “Criar checkpoint completo”.`);
      return { ...out, effect: `Cria a branch “${name}” apontando para a versão atual (${st.oid.slice(0, 7)}). Nada muda nos arquivos nem na branch atual.`, affected: [], steps: [step(['branch', name])] };
    }
    const wanted = Array.isArray(p.paths) ? [...new Set(p.paths.map((x) => repo.checkPath(x)))] : changed.map((f) => f.path);
    const paths = wanted.filter((x) => changed.some((f) => f.path === x));
    if (!paths.length) throw httpError(400, 'Não há alterações para incluir no checkpoint.');
    const message = shortText(p.message, 300, 'Mensagem') || `Checkpoint ${name}`;
    out.params = { ...out.params, paths, message };
    return { ...out, effect: `Salva ${plural(paths.length, 'arquivo', 'arquivos')} num commit na branch atual (${st.branch || 'HEAD'}) com a mensagem “${message}” e cria a branch “${name}” apontando para esse commit.`,
      affected: paths, steps: [step(['add', '-A', '--', ...paths]), step(['commit', '-m', message, '--', ...paths]), step(['branch', name])] };
  },

  // 5. Guardar alterações para depois (stash).
  async 'stash-push'(repo, p, st) {
    requireIdle(st);
    needCommits(st);
    const untracked = p.includeUntracked !== false;
    const files = st.files.filter((f) => !f.conflict && (untracked || !f.untracked));
    if (!files.length) throw httpError(400, 'Não há alterações para guardar.');
    const message = shortText(p.message, 200, 'Descrição') || `Guardado em ${stamp()}`;
    return { label: 'Guardar alterações para depois', risk: 'safe', params: { message, includeUntracked: untracked },
      effect: `Tira ${plural(files.length, 'arquivo', 'arquivos')} da pasta de trabalho e guarda num item “${message}”. A pasta volta à última versão salva; use “Recuperar alterações guardadas” para trazê-los de volta.`,
      affected: files.map((f) => f.path), warnings: untracked ? [] : ['Arquivos novos (não rastreados) ficam na pasta e não são guardados.'],
      steps: [step(['stash', 'push', ...(untracked ? ['--include-untracked'] : []), '-m', message])] };
  },

  // 6. Recuperar alterações guardadas: apply (o item continua guardado até você remover).
  async 'stash-apply'(repo, p, st) {
    requireIdle(st);
    const s = await stashRef(repo, p.ref);
    const files = lines((await run(repo.root, ['stash', 'show', '--name-only', '--include-untracked', s.ref])).stdout);
    return { label: 'Recuperar alterações guardadas', risk: 'safe', params: { ref: s.ref },
      effect: `Aplica de volta as alterações de “${s.message}”. O item continua guardado — remova-o depois de conferir que ficou correto.`,
      affected: files, warnings: tracked(st).length ? ['Você tem alterações atuais: elas continuam; se o mesmo arquivo foi alterado nos dois, o Git pode recusar ou marcar conflito.'] : [],
      steps: [step(['stash', 'apply', s.ref], { conflictOk: true })] };
  },
  async 'stash-drop'(repo, p, st) {
    const s = await stashRef(repo, p.ref);
    return { label: 'Remover alterações guardadas', risk: 'attention', params: { ref: s.ref },
      effect: `Remove o item “${s.message}” da lista de alterações guardadas. Faça isso só depois de recuperar e conferir.`,
      affected: [], warnings: [], steps: [step(['stash', 'drop', s.ref])] };
  },

  // 7. Voltar este arquivo (descarta as alterações locais de UM arquivo que existe no último commit).
  async 'restore-file'(repo, p, st) {
    requireIdle(st);
    const path_ = repo.checkPath(p.path);
    const f = st.files.find((x) => x.path === path_);
    if (!f) throw httpError(400, `“${path_}” não tem alterações.`);
    if (f.untracked) throw httpError(400, `“${path_}” é um arquivo novo (não está em nenhuma versão salva). Para apagá-lo use “Limpar arquivos não versionados”.`);
    if ((await run(repo.root, ['cat-file', '-e', `HEAD:${path_}`])).code !== 0) throw httpError(400, `“${path_}” não existe na última versão salva (arquivo adicionado ou renomeado); voltar descartaria o arquivo. Use “Guardar alterações para depois” se quiser tirá-lo da pasta.`);
    return { label: 'Voltar este arquivo', risk: 'attention', params: { path: path_ },
      effect: `Todas as alterações locais de ${path_} serão descartadas (volta à última versão salva). Os demais arquivos não mudam.`,
      affected: [path_], warnings: [], steps: [step(['restore', '--source=HEAD', '--staged', '--worktree', '--', path_])] };
  },

  // 8. Recuperar arquivo de outra versão (só aquele arquivo; o resto do projeto não muda).
  async 'restore-from'(repo, p, st) {
    requireIdle(st);
    const c = await commitOf(repo, p.commit);
    const path_ = repo.checkPath(p.path);
    if ((await run(repo.root, ['cat-file', '-e', `${c.hash}:${path_}`])).code !== 0) throw httpError(400, `“${path_}” não existe na versão ${c.short}.`);
    const local = st.files.find((x) => x.path === path_);
    return { label: 'Recuperar arquivo de outra versão', risk: 'attention', params: { path: path_, commit: c.hash },
      effect: `${path_} passa a ter o conteúdo da versão ${c.short} (“${c.subject}”). Os demais arquivos não mudam; o arquivo fica como alterado, pronto para salvar numa nova versão.`,
      affected: [path_], warnings: local ? ['Este arquivo tem alterações locais: elas serão substituídas.'] : [],
      steps: [step(['restore', `--source=${c.hash}`, '--worktree', '--', path_])] };
  },

  // 9. Descartar alterações locais (arquivos rastreados). Arquivos novos não são removidos (nem os recém-adicionados).
  async 'discard-all'(repo, p, st) {
    requireIdle(st);
    needCommits(st);
    const files = tracked(st);
    if (!files.length) throw httpError(400, 'Não há alterações em arquivos versionados para descartar.');
    const added = files.filter((f) => f.code === 'A').length;
    return { label: 'Descartar alterações locais', risk: 'advanced', suggestCheckpoint: true, params: {},
      effect: `Descarta as alterações de ${plural(files.length, 'arquivo versionado', 'arquivos versionados')}, que voltam à última versão salva. Arquivos novos (não rastreados) não são removidos.`,
      affected: files.map((f) => `${f.path} (${f.label})`),
      warnings: [added ? `${plural(added, 'arquivo adicionado continua', 'arquivos adicionados continuam')} na pasta como arquivo novo.` : null, 'O que for descartado não fica guardado: crie um ponto de segurança completo ou guarde as alterações antes, se tiver dúvida.'].filter(Boolean),
      steps: [step(['restore', '--staged', '--', '.']), step(['restore', '--', '.'])] };
  },

  // 10. Limpar arquivos não versionados: prévia com git clean -nd; execução apaga SÓ os caminhos listados (sem ignorados).
  async clean(repo, p, st) {
    requireIdle(st);
    const r = await run(repo.root, ['clean', '-n', '-d'], { env: { LC_ALL: 'C', LANGUAGE: 'C' } });
    if (r.code !== 0) throw git.gitError(r);
    const paths = lines(r.stdout).map((l) => l.replace(/^Would remove /, '')).filter((x) => x && !x.startsWith('-'));
    if (!paths.length) throw httpError(400, 'Não há arquivos não versionados para limpar (arquivos ignorados pelo .gitignore nunca entram).');
    paths.forEach((x) => repo.checkPath(x.replace(/\/$/, '')));
    return { label: 'Limpar arquivos não versionados', risk: 'advanced', suggestCheckpoint: true, params: {},
      effect: `Apaga do disco ${plural(paths.length, 'item não versionado', 'itens não versionados')} (pastas inteiras quando terminam em “/”). Arquivos ignorados pelo .gitignore não são tocados.`,
      affected: paths, warnings: ['Arquivos não versionados não existem em nenhuma versão do Git: depois de apagados, não há como recuperá-los pelo Git.'],
      preview: shown(['clean', '-n', '-d']), steps: [step(['clean', '-f', '-d', '--', ...paths])] };
  },

  // 12. Desfazer último commit e continuar editando (só commit local, nunca publicado).
  async 'undo-commit'(repo, p, st) {
    requireIdle(st);
    needCommits(st);
    const c = await commitOf(repo, st.oid);
    if (!c.parents.length) throw httpError(400, 'Este é o primeiro commit do repositório: não há versão anterior para voltar.');
    if (c.parents.length > 1) throw httpError(400, 'O último commit é um merge. Para desfazê-lo use “Desfazer uma versão publicada” (revert).');
    const remote = await onRemote(repo, c.hash);
    if (remote.length) throw httpError(409, `O último commit (${c.short}) já foi enviado (${remote.join(', ')}). Para não reescrever o que está publicado, use “Desfazer uma versão publicada” (revert).`, { code: 'GIT_PUBLISHED' });
    return { label: 'Desfazer último commit e continuar editando', risk: 'attention', params: {},
      effect: `O commit ${c.short} (“${c.subject}”) será removido, mas as alterações dele continuam nos arquivos, prontas para ajustar e salvar de novo.`,
      affected: await commitFiles(repo, c), warnings: [], steps: [step(['reset', '--soft', 'HEAD~1'])] };
  },

  // 13. Desfazer uma versão publicada: revert (novo commit que desfaz; o histórico não é reescrito).
  async revert(repo, p, st) {
    const c = await commitOf(repo, p.commit);
    requireIdle(st);
    requireClean(st, 'desfazer uma versão');
    if ((await run(repo.root, ['merge-base', '--is-ancestor', c.hash, 'HEAD'])).code !== 0) throw httpError(400, `A versão ${c.short} não faz parte da branch atual; não há o que desfazer aqui.`);
    const merge = c.parents.length > 1;
    return { label: 'Desfazer uma versão', risk: 'attention', params: { commit: c.hash },
      effect: `Será criado um novo commit que desfaz as alterações de ${c.short} (“${c.subject}”). O histórico continua como está — seguro também para o que já foi enviado.`,
      affected: await commitFiles(repo, c), warnings: merge ? ['É um merge: será desfeito o que ele trouxe em relação ao 1º pai (git revert -m 1).'] : [],
      steps: [step(['revert', '--no-edit', ...(merge ? ['-m', '1'] : []), c.hash], { conflictOk: true })] };
  },

  // 14. Abrir versão antiga: só consultar (HEAD destacado) ou numa branch temporária para editar.
  async 'open-old'(repo, p, st) {
    const c = await commitOf(repo, p.commit);
    requireIdle(st);
    requireClean(st, 'abrir outra versão');
    if (p.mode === 'branch') {
      const name = await newBranchName(repo, p.name || `consulta/${c.short}`);
      return { label: 'Abrir versão antiga (para editar)', risk: 'safe', params: { commit: c.hash, mode: 'branch', name },
        effect: `Cria a branch “${name}” na versão ${c.short} (“${c.subject}”) e passa a trabalhar nela. A branch ${st.branch || 'atual'} não muda; volte a ela em “Versões de trabalho”.`,
        affected: [], warnings: [], steps: [step(['switch', '-c', name, c.hash])] };
    }
    return { label: 'Abrir versão antiga (só consultar)', risk: 'safe', params: { commit: c.hash, mode: 'detach' },
      effect: `Os arquivos passam a mostrar a versão ${c.short} (“${c.subject}”), sem mudar nenhuma branch. Para voltar, troque para ${st.branch ? `“${st.branch}”` : 'uma branch'} em “Versões de trabalho”.`,
      affected: [], warnings: ['Modo consulta (HEAD destacado): commits feitos aqui não ficam em nenhuma branch. Se for editar, prefira “para editar”.'],
      steps: [step(['switch', '--detach', c.hash])] };
  },

  // 15, 26 e 29. Criar branch a partir de uma versão (cópia de uma versão antiga, recuperação pelo reflog, área para correção).
  async 'branch-from'(repo, p, st) {
    requireIdle(st);
    const c = await commitOf(repo, p.commit || st.oid);
    const name = await newBranchName(repo, p.name);
    const checkout = !!p.checkout;
    if (checkout && c.hash !== st.oid) requireClean(st, 'trocar para outra versão');
    return { label: checkout ? 'Criar branch e trabalhar nela' : 'Criar branch', risk: 'safe', params: { commit: c.hash, name, checkout },
      effect: `Cria a branch “${name}” na versão ${c.short} (“${c.subject}”)${checkout ? ' e passa a trabalhar nela' : '; você continua na branch atual'}. Nada é apagado.`,
      affected: [], warnings: [], steps: [step(checkout ? ['switch', '-c', name, c.hash] : ['branch', name, c.hash])] };
  },
  async 'branch-rename'(repo, p, st) {
    const from = await checkBranchName(repo.root, p.from);
    if (!(await refExists(repo, `refs/heads/${from}`))) throw httpError(400, `A branch “${from}” não existe.`);
    const to = await newBranchName(repo, p.to);
    const b = (await repo.branches()).find((x) => x.name === from);
    return { label: 'Renomear branch', risk: 'safe', params: { from, to }, effect: `A branch local “${from}” passa a se chamar “${to}”. Os commits não mudam.`,
      affected: [], warnings: b?.upstream ? [`A branch no remoto (${b.upstream}) continua com o nome antigo.`] : [], steps: [step(['branch', '-m', from, to])] };
  },

  // 30. Marcar versão estável (tag). Com descrição = tag anotada.
  async tag(repo, p, st) {
    needCommits(st);
    const c = await commitOf(repo, p.commit || st.oid);
    const name = await tagName(repo, p.name);
    const message = shortText(p.message, 300, 'Descrição');
    return { label: 'Marcar versão estável', risk: 'safe', params: { commit: c.hash, name, message },
      effect: `Cria o marco “${name}” na versão ${c.short} (“${c.subject}”). Ele fica só neste computador até um push de tags.`,
      affected: [], warnings: [], steps: [step(message ? ['tag', '-a', name, '-m', message, c.hash] : ['tag', name, c.hash])] };
  },

  // 23. Trazer esta alteração (cherry-pick de um commit de outra branch).
  async 'cherry-pick'(repo, p, st) {
    const c = await commitOf(repo, p.commit);
    requireIdle(st);
    requireClean(st, 'trazer uma alteração');
    if (c.parents.length > 1) throw httpError(400, 'Este commit é um merge; para trazer uma branch inteira use o Merge.');
    if ((await run(repo.root, ['merge-base', '--is-ancestor', c.hash, 'HEAD'])).code === 0) throw httpError(400, `A alteração ${c.short} já faz parte da branch atual.`);
    // Já trazida antes (cópia com outro hash, mesmo conteúdo): git cherry marca com "-" o que já existe na branch atual.
    if (c.parents.length && /^-\s/m.test((await run(repo.root, ['cherry', 'HEAD', c.hash, c.parents[0]])).stdout)) throw httpError(400, `A alteração ${c.short} já foi trazida para a branch atual (existe um commit equivalente).`);
    return { label: 'Trazer esta alteração', risk: 'attention', params: { commit: c.hash },
      effect: `Copia para a branch ${st.branch || 'atual'} só as alterações de ${c.short} (“${c.subject}”), como um novo commit. As outras alterações da branch de origem não vêm.`,
      affected: await commitFiles(repo, c), warnings: ['Se houver conflito o Git para; resolva e conclua, ou use “Cancelar aplicação da alteração”.'],
      steps: [step(['cherry-pick', c.hash], { conflictOk: true })] };
  },
  // 24 e similares: cancelar operação em andamento (volta ao estado de antes).
  async 'cherry-pick-abort'(repo, p, st) {
    if (!st.cherryPicking) throw httpError(400, 'Não há aplicação de alteração (cherry-pick) em andamento.');
    return { label: 'Cancelar aplicação da alteração', risk: 'safe', params: {}, effect: 'Cancela o cherry-pick em andamento: os arquivos voltam ao estado de antes dele.', affected: st.conflicts, warnings: [], steps: [step(['cherry-pick', '--abort'])] };
  },
  async 'revert-abort'(repo, p, st) {
    if (!st.reverting) throw httpError(400, 'Não há revert em andamento.');
    return { label: 'Cancelar o desfazer', risk: 'safe', params: {}, effect: 'Cancela o revert em andamento: os arquivos voltam ao estado de antes dele.', affected: st.conflicts, warnings: [], steps: [step(['revert', '--abort'])] };
  },

  // 16. Voltar projeto para esta versão (reset --hard): último recurso, só local.
  async 'reset-hard'(repo, p, st) {
    requireIdle(st);
    needCommits(st);
    if (!st.branch) throw httpError(400, 'Nenhuma branch ativa (HEAD destacado). Troque para uma branch antes.');
    const c = await commitOf(repo, p.commit);
    if (c.hash === st.oid) throw httpError(400, 'A branch já está nesta versão.');
    const leaving = await commitsIn(repo, `${c.hash}..HEAD`);
    const entering = await commitsIn(repo, `HEAD..${c.hash}`);
    const published = leaving.length ? await onRemote(repo, 'HEAD') : [];
    const files = tracked(st);
    return { label: 'Voltar projeto para esta versão', risk: 'advanced', suggestCheckpoint: true, params: { commit: c.hash },
      effect: `A branch “${st.branch}” passa de ${st.oid.slice(0, 7)} para ${c.short} (“${c.subject}”) e TODOS os arquivos versionados voltam a essa versão. Arquivos novos (não rastreados) não são apagados.`,
      affected: files.map((f) => `${f.path} (${f.label}) — alteração local será PERDIDA`),
      lists: [{ title: `Commits que deixarão de fazer parte da branch (${leaving.length})`, items: leaving }, entering.length ? { title: `Commits que passarão a fazer parte da branch (${entering.length})`, items: entering } : null].filter(Boolean),
      warnings: [published.length ? `Parte desses commits já está no remoto (${published.join(', ')}): a branch local vai divergir, e um Pull os traria de volta. Para desfazer algo publicado, prefira “Desfazer uma versão publicada” (revert).` : null,
        'Os commits que saem da branch continuam recuperáveis por um tempo em “Recuperar versão perdida” (reflog), mas alterações locais não salvas não.'].filter(Boolean),
      steps: [step(['reset', '--hard', c.hash])] };
  },

  // 17. Voltar versão publicada (caso excepcional): fetch → branches de segurança → reset --hard → push --force-with-lease.
  async 'rewind-remote'(repo, p, st) {
    requireIdle(st);
    requireClean(st, 'voltar a versão publicada');
    if (!st.branch) throw httpError(400, 'Nenhuma branch ativa (HEAD destacado).');
    const up = upstreamParts(st, await repo.remoteNames());
    if (!up) throw httpError(400, 'Esta branch não está ligada a uma branch remota (upstream).', { code: 'GIT_NO_UPSTREAM' });
    const f = await run(repo.root, ['fetch', '--prune', up.remote], { timeoutMs: NETWORK_TIMEOUT });
    if (f.code !== 0) throw git.friendlyNetwork(f, 'fetch');
    const remoteSha = (await git.ok(repo.root, ['rev-parse', `refs/remotes/${st.upstream}`])).stdout.trim();
    const c = await commitOf(repo, p.commit);
    if (c.hash === remoteSha) throw httpError(400, 'A versão publicada já é esta.');
    const removed = await commitsIn(repo, `${c.hash}..${remoteSha}`);
    if (!removed.length) throw httpError(400, `A versão ${c.short} não é anterior à publicada; nada seria removido do remoto.`);
    const ts = stamp();
    const safeName = st.branch.replace(/[^A-Za-z0-9._-]+/g, '-');
    const backupRemote = await newBranchName(repo, `backup/remoto-${safeName}-${ts}`);
    const steps = [step(['branch', backupRemote, remoteSha])];
    let backupLocal = null;
    if (st.oid !== remoteSha) { backupLocal = await newBranchName(repo, `backup/local-${safeName}-${ts}`); steps.push(step(['branch', backupLocal, st.oid])); }
    steps.push(step(['reset', '--hard', c.hash]));
    steps.push(step(['push', `--force-with-lease=refs/heads/${up.branch}:${remoteSha}`, up.remote, `HEAD:refs/heads/${up.branch}`], { network: true }));
    return { label: 'Voltar versão publicada', risk: 'advanced', high: true, confirmText: st.branch, params: { commit: c.hash },
      state: remoteSha, preview: shown(['fetch', '--prune', up.remote]),
      effect: `A branch remota ${st.upstream} volta de ${remoteSha.slice(0, 7)} para ${c.short} (“${c.subject}”), e a branch local também. Antes, as versões atuais ficam guardadas nas branches “${backupRemote}”${backupLocal ? ` e “${backupLocal}”` : ''}.`,
      affected: [], lists: [{ title: `Commits que serão REMOVIDOS do histórico da branch remota (${removed.length})`, items: removed }],
      warnings: ['Reescreve o histórico publicado: quem já baixou esses commits terá a branch divergente. Prefira “Desfazer uma versão publicada” (revert), que não reescreve nada.',
        `O remoto foi consultado agora (fetch). O envio usa --force-with-lease: se alguém publicar algo em ${st.upstream} depois desta prévia, o Git recusa (nunca é usado --force).`],
      steps };
  },

  // 19. Baixar alterações (pull) — a prévia já consulta o remoto (fetch) e mostra a situação.
  async pull(repo, p, st) {
    requireIdle(st);
    if (!st.branch) throw httpError(400, 'Nenhuma branch ativa (HEAD destacado). Troque para uma branch antes.');
    const rem = await repo.remotes();
    if (!rem.length) throw httpError(400, 'Nenhum remote configurado.', { code: 'GIT_NO_REMOTE' });
    if (!st.upstream) {
      return { label: 'Baixar alterações', risk: 'attention', params: {}, affected: [], warnings: ['Esta branch ainda não acompanha uma branch remota: se o remoto tiver uma branch com o mesmo nome, ela será trazida e passará a ser acompanhada.'],
        effect: `Traz a branch “${st.branch}” do remoto, se existir lá.`, steps: [{ cmd: 'git pull', special: 'pull' }] };
    }
    const up = upstreamParts(st, rem.map((r) => r.name));
    const f = await run(repo.root, ['fetch', '--prune', up ? up.remote : '--all'], { timeoutMs: NETWORK_TIMEOUT });
    if (f.code !== 0) throw git.friendlyNetwork(f, 'fetch');
    const ab = await repo.aheadBehind(st.branch, st.upstream);
    const incoming = await commitsIn(repo, `HEAD..${st.upstream}`);
    const remoteSha = (await run(repo.root, ['rev-parse', st.upstream])).stdout.trim();
    const situation = !ab.behind && !ab.ahead ? 'Local está atualizado com o remoto.' : `Remoto tem ${plural(ab.behind, 'commit novo', 'commits novos')}; local tem ${plural(ab.ahead, 'commit não enviado', 'commits não enviados')}.${ab.ahead && ab.behind ? ' As branches divergiram: o Git vai juntar as duas (merge) e pode haver conflito.' : ''}`;
    return { label: 'Baixar alterações', risk: 'attention', params: {}, state: remoteSha, preview: shown(['fetch', '--prune', up ? up.remote : '--all']),
      effect: ab.behind ? `${situation} Os arquivos da pasta serão atualizados.` : situation,
      affected: [], lists: incoming.length ? [{ title: `Commits que vão chegar (${incoming.length})`, items: incoming }] : [],
      warnings: [tracked(st).length ? 'Há alterações locais não commitadas: se o pull precisar mexer nesses arquivos, o Git recusa (salve ou guarde antes).' : null].filter(Boolean),
      steps: ab.behind ? [{ cmd: 'git pull', special: 'pull' }] : [] };
  },

  // 20. Enviar para o GitHub (push).
  async push(repo, p, st) {
    requireIdle(st);
    if (!st.branch) throw httpError(400, 'Nenhuma branch ativa (HEAD destacado). Troque para uma branch antes.');
    const rem = await repo.remotes();
    if (!rem.length) throw httpError(400, 'Nenhum remote configurado.', { code: 'GIT_NO_REMOTE' });
    const target = st.upstream || `${(rem.find((r) => r.name === 'origin') || rem[0]).name}/${st.branch} (nova no remoto)`;
    const list = await commitsIn(repo, st.upstream ? `${st.upstream}..HEAD` : ['HEAD', '--not', '--remotes']);
    if (st.upstream && !list.length) return { label: 'Enviar para o GitHub', risk: 'safe', params: {}, effect: `Nada a enviar: ${st.branch} → ${target} já está em dia.`, affected: [], warnings: [], steps: [] };
    return { label: 'Enviar para o GitHub', risk: 'safe', params: {},
      effect: `Envia ${plural(list.length, 'commit', 'commits')} da branch local “${st.branch}” → ${target}.`,
      affected: [], lists: [{ title: `Commits que serão enviados (${list.length})`, items: list }],
      warnings: [st.behind ? `O remoto tem ${plural(st.behind, 'commit', 'commits')} que você ainda não baixou: o envio será recusado. Use “Baixar alterações” antes.` : null, tracked(st).length ? 'Alterações não commitadas não são enviadas — só o que já foi salvo em versões.' : null].filter(Boolean),
      steps: [{ cmd: st.upstream ? 'git push' : `git push -u ${target.split('/')[0]} ${st.branch}`, special: 'push' }] };
  },
};

async function stashRef(repo, ref) {
  const v = String(ref ?? '').trim();
  if (!/^stash@\{\d{1,4}\}$/.test(v)) throw httpError(400, 'Item guardado inválido.');
  const s = (await repo.stashes()).find((x) => x.ref === v);
  if (!s) throw httpError(400, 'Este item guardado não existe mais (a lista mudou). Atualize e tente de novo.');
  return s;
}

// ---------- Prévia e execução ----------
async function buildPlan(repo, action, params) {
  const fn = Object.prototype.hasOwnProperty.call(ACTIONS, action) ? ACTIONS[action] : null;
  if (!fn) throw httpError(400, 'Ação Git desconhecida.');
  const st = await repo.status();
  const plan = await fn(repo, params && typeof params === 'object' ? params : {}, st);
  const state = [st.oid, st.branch, st.upstream, st.files.map((f) => `${f.xy} ${f.path}`).join('|'), (await repo.stashes()).map((s) => s.hash).join(',')];
  const token = sha(JSON.stringify([action, plan.params, state, plan.state || null, plan.steps.map((s) => s.cmd)]));
  return { ...plan, action, token, riskLabel: plan.high ? 'Avançado / alto' : RISK[plan.risk] };
}
const publicPlan = (p) => ({ action: p.action, label: p.label, risk: p.risk, riskLabel: p.riskLabel, high: !!p.high, effect: p.effect, affected: (p.affected || []).slice(0, 2000), affectedCount: (p.affected || []).length,
  lists: p.lists || [], warnings: p.warnings || [], commands: p.steps.map((s) => s.cmd), preview: p.preview || null, suggestCheckpoint: !!p.suggestCheckpoint, confirmText: p.confirmText || null, params: p.params, token: p.token, empty: !p.steps.length });

async function preview(repo, action, params) { return publicPlan(await buildPlan(repo, action, params)); }

async function execute(repo, action, params, { token, confirm, confirmText } = {}) {
  const plan = await buildPlan(repo, action, params);
  if (!token || token !== plan.token) throw httpError(409, 'O repositório mudou desde a prévia (arquivos, versão atual ou remoto). Nada foi executado — revise a prévia de novo.', { code: 'GIT_PLAN_CHANGED' });
  if (!plan.steps.length) throw httpError(400, 'Não há nada a executar.');
  if (plan.risk === 'advanced' && confirm !== true) throw httpError(400, 'Operação avançada: confirme explicitamente antes de executar.', { code: 'GIT_CONFIRM' });
  if (plan.confirmText && String(confirmText ?? '').trim() !== plan.confirmText) throw httpError(400, `Para confirmar, digite exatamente o nome da branch: ${plan.confirmText}`, { code: 'GIT_CONFIRM' });
  const outputs = [];
  for (const s of plan.steps) {
    if (s.special === 'pull') {
      const r = await repo.pull();
      outputs.push(r.output);
      if (r.conflict) return { ok: false, conflict: true, conflicts: r.conflicts, output: outputs.join('\n').trim(), label: plan.label, commands: plan.steps.map((x) => x.cmd) };
      continue;
    }
    if (s.special === 'push') { outputs.push((await repo.push()).output); continue; }
    const r = await run(repo.root, s.args, { timeoutMs: s.network ? NETWORK_TIMEOUT : undefined });
    outputs.push(`$ ${s.cmd}\n${`${r.stdout}\n${r.stderr}`.trim()}`.trim());
    if (r.code !== 0) {
      const after = await repo.status();
      if (s.conflictOk && after.conflicts.length) return { ok: false, conflict: true, conflicts: after.conflicts, output: outputs.join('\n\n'), label: plan.label, commands: plan.steps.map((x) => x.cmd) };
      throw s.network ? git.friendlyNetwork(r, 'push') : git.gitError(r);
    }
  }
  return { ok: true, output: outputs.join('\n\n'), label: plan.label, commands: plan.steps.map((x) => x.cmd), params: plan.params };
}

module.exports = { preview, execute, ACTIONS, RISK };
