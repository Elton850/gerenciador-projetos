'use strict';
// Workspace → Git → “Ações rápidas” e “Guia Git”. Operações do dia a dia com nomes simples; o comando Git aparece em
// segundo plano (“Ver comando Git”). Toda ação que altera o repositório passa pela PRÉVIA do servidor (src/git-actions.js):
// efeito, arquivos/commits afetados, avisos, comandos e risco — e só executa ao confirmar. Nenhum comando livre.

const GA_RISK = { safe: ['Seguro', 'ok'], attention: ['Atenção', 'soon'], advanced: ['Avançado', 'overdue'] };
const gaRisk = (risk, label) => h('span', { class: `pill ${GA_RISK[risk][1]}`, title: 'Nível de risco' }, label || GA_RISK[risk][0]);
const gaPad = (n) => String(n).padStart(2, '0');
const gaStamp = (d = new Date()) => `${d.getFullYear()}-${gaPad(d.getMonth() + 1)}-${gaPad(d.getDate())}-${gaPad(d.getHours())}${gaPad(d.getMinutes())}`;
const gaList = (items) => h('div', { class: 'ga-list' }, items.map((x) => h('div', { class: 'mono small' }, x)));

// ---------- Prévia → execução ----------
async function gitPlan(action, params = {}, { project = gitProject(), after } = {}) {
  let plan;
  try { plan = await gitApi('POST', '/action/preview', { action, params }, project); } catch (e) { return gitError(e, 'Não foi possível preparar a ação'); }
  gitPlanDialog(plan, project, after);
}

function gitPlanDialog(plan, project, after) {
  const adv = plan.risk === 'advanced';
  const ack = adv ? h('input', { type: 'checkbox' }) : null;
  const typed = plan.confirmText ? h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: plan.confirmText }) : null;
  const err = h('div');
  const runBtn = h('button', { class: `btn ${adv ? 'danger' : 'primary'}` }, adv ? 'Executar mesmo assim' : 'Executar');
  const sync = () => { runBtn.disabled = plan.empty || (adv && !ack.checked) || (typed && typed.value.trim() !== plan.confirmText); };
  ack?.addEventListener('change', sync);
  typed?.addEventListener('input', sync);
  sync();
  const checkpointFirst = adv && plan.suggestCheckpoint && plan.action !== 'checkpoint'
    ? h('button', { class: 'btn sm', onclick: (e) => gitAction(e.currentTarget, async () => {
      const cp = await gitApi('POST', '/action/preview', { action: 'checkpoint', params: {} }, project);
      await gitApi('POST', '/action/run', { action: 'checkpoint', params: cp.params, token: cp.token }, project);
      toast(`Ponto de segurança criado: ${cp.params.name}`);
      md.close(); await afterGitChange(project); gitPlan(plan.action, plan.params, { project, after });
    }) }, 'Criar ponto de segurança primeiro') : null;
  runBtn.addEventListener('click', async () => {
    runBtn.disabled = true; err.replaceChildren();
    try {
      const r = await gitApi('POST', '/action/run', { action: plan.action, params: plan.params, token: plan.token, confirm: adv ? ack.checked : undefined, confirmText: typed ? typed.value : undefined }, project);
      md.close();
      await afterGitChange(project);
      if (r.conflict) gitActionConflict(plan.label, r);
      else toast(`${plan.label}: concluído.`);
      if (after) after(r);
    } catch (e) {
      if (e.code === 'GIT_PLAN_CHANGED') {
        err.replaceChildren(h('div', { class: 'box warn small' }, e.message, ' ', h('button', { class: 'btn sm', onclick: () => { md.close(); gitPlan(plan.action, plan.params, { project, after }); } }, 'Ver a prévia de novo')));
      } else if (e.details?.gitOutput) { md.close(); gitError(e); } else err.replaceChildren(h('div', { class: 'box bad small' }, e.message));
      sync();
    }
  });
  const md = openModal({ title: plan.label, wide: true,
    body: [
      h('div', { class: 'ga-planhead' }, gaRisk(plan.risk, plan.riskLabel), h('span', { class: 'small muted' }, adv ? 'Pode reescrever histórico ou descartar alterações.' : plan.risk === 'attention' ? 'Pode alterar arquivos ou o estado atual.' : 'Normalmente reversível, sem perda de histórico.')),
      h('dl', { class: 'ga-kv' }, h('dt', null, 'Ação'), h('dd', null, plan.label), h('dt', null, 'Efeito'), h('dd', null, plan.effect),
        h('dt', null, 'Afetados'), h('dd', null, plan.affectedCount ? plural(plan.affectedCount, 'arquivo', 'arquivos') : '—')),
      plan.affectedCount ? gaList(plan.affected) : null,
      ...plan.lists.map((l) => h('div', { class: 'stack' }, h('div', { class: 'lbl' }, l.title), l.items.length ? gaList(l.items) : h('div', { class: 'small muted' }, 'nenhum'))),
      ...plan.warnings.map((w) => h('div', { class: 'box warn small' }, w)),
      plan.empty ? h('div', { class: 'box small' }, 'Nada a executar.') : null,
      h('details', { class: 'ga-cmd' }, h('summary', null, 'Ver comando Git'),
        h('pre', { class: 'code' }, `${plan.preview ? `# já executado na prévia (não altera seus arquivos)\n${plan.preview}\n\n` : ''}${plan.commands.join('\n') || '(nenhum)'}`)),
      adv ? h('div', { class: 'box bad stack' }, h('strong', null, plan.high ? 'Operação avançada de ALTO risco.' : 'Operação avançada.'),
        h('div', { class: 'small' }, 'Leia o efeito e a lista acima. Na dúvida, cancele e prefira uma ação mais segura (Guia Git).'),
        checkpointFirst ? h('div', null, checkpointFirst) : null,
        h('label', { class: 'check small' }, ack, ' Entendo o efeito e quero executar')) : null,
      typed ? field(`Para confirmar, digite o nome da branch: ${plan.confirmText}`, typed) : null,
      err],
    footer: [h('button', { class: 'btn', onclick: () => md.close() }, 'Cancelar'), runBtn] });
}

function gitActionConflict(label, r) {
  WM.gitTab = 'changes'; renderGitPanel();
  gitOutputDialog(`${label} — conflito`, r.output, h('div', { class: 'box warn' }, h('strong', null, `${plural(r.conflicts.length, 'arquivo ficou', 'arquivos ficaram')} em conflito:`),
    h('ul', null, r.conflicts.map((c) => h('li', { class: 'mono' }, c))),
    h('div', { class: 'small' }, 'O Git parou. Em Alterações: abra cada arquivo no VS Code, resolva os trechos entre <<<<<<< e >>>>>>>, salve, clique em “Resolvido” e depois em “Concluir (commit)”. Ou cancele a operação no aviso de operação em andamento.')));
}

// ---------- Formulários e seletores ----------
// Versão (commit): lista as últimas do histórico (só da branch atual ou de todas) ou um hash colado.
function commitPicker(project, { all = false, value = '' } = {}) {
  const sel = h('select', null, h('option', { value: '' }, 'Carregando…'));
  const paste = h('input', { type: 'text', placeholder: 'ou cole o hash', spellcheck: 'false', style: 'max-width:180px', value });
  const ready = gitApi('GET', `/graph?limit=200&all=${all ? 1 : 0}`, null, project).then((g) => {
    sel.replaceChildren(...g.commits.map((c) => h('option', { value: c.hash }, `${c.short} · ${c.subject.slice(0, 70)} · ${new Date(c.date).toLocaleDateString('pt-BR')}${c.refs.filter((x) => x.type !== 'head').length ? ` [${c.refs.filter((x) => x.type !== 'head').map((x) => x.name).join(', ')}]` : ''}`)));
    if (!g.commits.length) sel.replaceChildren(h('option', { value: '' }, '(nenhum commit)'));
    return g;
  }).catch((e) => { sel.replaceChildren(h('option', { value: '' }, e.message)); });
  return { el: h('div', { class: 'inline ga-picker' }, sel, paste), get: () => paste.value.trim() || sel.value, select: sel, ready };
}

function gaForm({ title, intro, fields, submit = 'Ver prévia', onSubmit, size }) {
  const err = h('div');
  const go = h('button', { class: 'btn primary' }, submit);
  const md = openModal({ title, size, wide: !size, body: [intro ? h('div', { class: 'small muted' }, intro) : null, ...fields, err].filter(Boolean),
    footer: [h('button', { class: 'btn', onclick: () => md.close() }, 'Cancelar'), go] });
  go.addEventListener('click', async () => {
    err.replaceChildren();
    try { const keep = await onSubmit(); if (keep !== true) md.close(); } catch (e) { err.replaceChildren(h('div', { class: 'box bad small' }, e.message)); }
  });
  return md;
}

function checkpointForm(project, { copy = false } = {}) {
  const g = WM.git.get(project);
  const changed = g.status.files.filter((f) => !f.conflict);
  const name = h('input', { type: 'text', spellcheck: 'false', placeholder: copy ? 'backup/antes-ajuste-importacao' : `backup/${gaStamp()} (automático)` });
  const include = h('input', { type: 'checkbox' });
  const boxes = changed.map((f) => ({ f, el: h('input', { type: 'checkbox', checked: true }) }));
  const msg = h('input', { type: 'text', maxlength: 300, placeholder: 'Mensagem (vazio = “Checkpoint <nome>”)' });
  const filesBox = h('div', { class: 'stack', style: 'display:none' }, field('Mensagem do commit', msg),
    h('div', { class: 'lbl' }, 'Arquivos que entrarão no commit'), h('div', { class: 'ga-list' }, boxes.map((b) => h('label', { class: 'check small mono' }, b.el, ` ${b.f.path} (${b.f.label})`))));
  include.addEventListener('change', () => { filesBox.style.display = include.checked ? '' : 'none'; });
  gaForm({ title: copy ? 'Criar cópia desta versão' : 'Criar ponto de segurança',
    intro: copy ? 'Guarda a versão atual numa branch de backup antes de experimentar algo — melhor que copiar a pasta inteira para preservar código versionado.' : 'Guarda o estado atual numa branch de backup (git branch). Nada muda nos arquivos nem na branch atual.',
    fields: [field('Nome da branch de backup', name, 'Vazio = backup/AAAA-MM-DD-HHMM.'),
      changed.length ? h('div', { class: 'box small stack' }, h('div', null, `Há ${plural(changed.length, 'arquivo com alterações não commitadas', 'arquivos com alterações não commitadas')}: criar só a branch NÃO salva essas alterações.`),
        h('label', { class: 'check' }, include, ' Criar checkpoint completo (salvar essas alterações num commit antes — você vê exatamente o que entra)'), filesBox) : null,
      h('div', { class: 'small muted' }, 'Arquivos ignorados pelo Git não entram na cópia.')].filter(Boolean),
    onSubmit: () => gitPlan('checkpoint', { name: name.value.trim(), includeChanges: include.checked, paths: boxes.filter((b) => b.el.checked).map((b) => b.f.path), message: msg.value.trim() }, { project }) });
  name.focus();
}

function stashForm(project) {
  const msg = h('input', { type: 'text', maxlength: 200, placeholder: 'Ex.: Antes do teste X' });
  const untracked = h('input', { type: 'checkbox', checked: true });
  gaForm({ title: 'Guardar alterações para depois', size: 'md', intro: 'Tira suas alterações da pasta e guarda (git stash), para trocar de branch ou testar algo sem perder o trabalho.',
    fields: [field('Descrição', msg), h('label', { class: 'check small' }, untracked, ' Incluir arquivos novos (não rastreados)')],
    onSubmit: () => gitPlan('stash-push', { message: msg.value.trim(), includeUntracked: untracked.checked }, { project }) });
  msg.focus();
}

async function stashDialog(project) {
  let list;
  try { list = await gitApi('GET', '/stashes', null, project); } catch (e) { return gitError(e); }
  const md = openModal({ title: 'Alterações guardadas', wide: true,
    body: [h('div', { class: 'small muted' }, '“Recuperar” aplica as alterações e mantém o item guardado (git stash apply). Depois de conferir que ficou correto, remova o item.'),
      list.length ? h('div', { class: 'stack' }, list.map((s) => h('div', { class: 'row' },
        h('div', { class: 'grow' }, h('strong', null, s.message.replace(/^(WIP on|On) [^:]+: /, '')), h('div', { class: 'small muted' }, `${s.ref} · ${new Date(s.date).toLocaleString('pt-BR')} · ${s.message.match(/^(?:WIP on|On) ([^:]+):/)?.[1] || ''}`)),
        h('div', { class: 'actions' },
          h('button', { class: 'btn sm primary', onclick: () => { md.close(); gitPlan('stash-apply', { ref: s.ref }, { project }); } }, 'Recuperar'),
          h('button', { class: 'btn sm ghost', onclick: () => { md.close(); gitPlan('stash-drop', { ref: s.ref }, { project }); } }, 'Remover')))))
        : h('div', { class: 'empty' }, 'Nenhuma alteração guardada.')],
    footer: [h('button', { class: 'btn', onclick: () => { md.close(); stashForm(project); } }, 'Guardar alterações agora…'), h('button', { class: 'btn primary', onclick: () => md.close() }, 'Fechar')] });
}

// Arquivo alterado (para comparar ou voltar). restorable = só os que existem na última versão salva.
function fileForm(project, { title, intro, restorable, onPick, submit }) {
  const g = WM.git.get(project);
  const files = g.status.files.filter((f) => !f.conflict && (!restorable || (!f.untracked && f.code !== 'A' && f.code !== 'R')));
  if (!files.length) return toast(restorable ? 'Nenhum arquivo versionado com alterações para voltar.' : 'Nenhum arquivo alterado.');
  const sel = h('select', null, files.map((f) => h('option', { value: f.path }, `${f.path} (${f.label})`)));
  const pick = () => files.find((f) => f.path === sel.value);
  gaForm({ title, intro, submit, fields: [field('Arquivo', sel), restorable ? h('div', null, h('button', { class: 'btn sm', onclick: () => openDiff(pick(), project) }, 'Ver as diferenças antes')) : null].filter(Boolean),
    onSubmit: () => onPick(pick()) });
}

function restoreFromForm(project, { commit = '', path = '' } = {}) {
  const pc = commitPicker(project, { all: true, value: commit });
  const file = h('input', { type: 'text', spellcheck: 'false', value: path, placeholder: 'ex.: scripts/PFUNC.sql', list: 'ga-files' });
  const dl = h('datalist', { id: 'ga-files' });
  const fill = async () => { const c = pc.get(); if (!c) return; try { const d = await gitApi('GET', `/commit?hash=${c}`, null, project); dl.replaceChildren(...d.files.map((f) => h('option', { value: f.path }))); } catch { /* só sugestão */ } };
  pc.ready.then(fill); pc.select.addEventListener('change', fill);
  gaForm({ title: 'Recuperar arquivo de outra versão', intro: 'Traz só UM arquivo de uma versão anterior, sem voltar o restante do projeto (git restore --source).',
    fields: [field('Versão', pc.el), field('Arquivo (caminho dentro do repositório)', h('div', null, file, dl), 'As sugestões são os arquivos alterados naquela versão; qualquer arquivo que exista nela pode ser recuperado.')],
    onSubmit: () => gitPlan('restore-from', { commit: pc.get(), path: file.value.trim() }, { project }) });
}

function commitForm(project, { title, intro, action, all = false, extra = [], params = () => ({}) }) {
  const pc = commitPicker(project, { all });
  gaForm({ title, intro, fields: [field('Versão (commit)', pc.el), ...extra], onSubmit: () => gitPlan(action, { commit: pc.get(), ...params() }, { project }) });
}

function openOldForm(project, commit) {
  const pc = commit ? null : commitPicker(project, { all: true });
  const mode = h('select', null, h('option', { value: 'detach' }, 'Só consultar (sem mudar nenhuma branch)'), h('option', { value: 'branch' }, 'Para editar: numa branch temporária'));
  const name = h('input', { type: 'text', spellcheck: 'false', placeholder: 'consulta/<hash> (automático)' });
  const nameF = field('Nome da branch temporária', name);
  nameF.style.display = 'none';
  mode.addEventListener('change', () => { nameF.style.display = mode.value === 'branch' ? '' : 'none'; });
  gaForm({ title: 'Abrir versão antiga', intro: 'Mostra os arquivos de uma versão anterior sem alterar a branch principal. Se for editar, prefira a branch temporária.',
    fields: [pc ? field('Versão', pc.el) : h('div', { class: 'mono small' }, commit), field('Como abrir', mode), nameF],
    onSubmit: () => gitPlan('open-old', { commit: commit || pc.get(), mode: mode.value, name: name.value.trim() }, { project }) });
}

function branchFromForm(project, { commit, title, name: defName = '', checkout = true, intro } = {}) {
  const pc = commit ? null : commitPicker(project, { all: true });
  const name = h('input', { type: 'text', spellcheck: 'false', value: defName, placeholder: 'ex.: recuperacao/versao-estavel' });
  const sw = h('input', { type: 'checkbox', checked: checkout });
  gaForm({ title, intro, fields: [pc ? field('Versão', pc.el) : h('div', { class: 'mono small' }, commit), field('Nome da nova branch', name), h('label', { class: 'check small' }, sw, ' Trocar para ela agora')],
    onSubmit: () => gitPlan('branch-from', { commit: commit || pc.get(), name: name.value.trim(), checkout: sw.checked }, { project }) });
  name.focus();
}

function tagForm(project, commit) {
  const pc = commit ? null : commitPicker(project, { all: false });
  const name = h('input', { type: 'text', spellcheck: 'false', placeholder: `ex.: v1.2.0, antes-refatoracao, versao-estavel-${gaStamp().slice(0, 10)}` });
  const msg = h('input', { type: 'text', maxlength: 300, placeholder: 'Opcional' });
  gaForm({ title: 'Marcar versão estável', intro: 'Cria um marco (git tag) numa versão importante. Use para marcos de verdade, não a cada pequena alteração.',
    fields: [pc ? field('Versão', pc.el, 'A primeira da lista é a versão atual.') : h('div', { class: 'mono small' }, commit), field('Nome do marco', name), field('Descrição', msg, 'Com descrição = tag anotada.')],
    onSubmit: () => gitPlan('tag', { commit: commit || pc.get(), name: name.value.trim(), message: msg.value.trim() }, { project }) });
  name.focus();
}

// ---------- Comparar versões ----------
function compareForm(project) {
  const a = commitPicker(project, { all: true });
  const b = commitPicker(project, { all: true });
  a.ready.then(() => { if (a.select.options.length > 1) a.select.selectedIndex = 1; });
  gaForm({ title: 'Comparar versões', intro: 'Mostra o que mudou entre duas versões (git diff A B).', submit: 'Comparar',
    fields: [field('De (versão antiga)', a.el), field('Para (versão nova)', b.el)], onSubmit: () => compareDialog(project, a.get(), b.get()) });
}
async function compareDialog(project, a, b) {
  const r = await gitApi('GET', `/compare?${qs({ a, b })}`, null, project);
  const label = (x) => x.slice(0, 7);
  const count = (s) => r.files.filter((f) => f.status === s).length;
  const md = openModal({ title: `Comparar ${label(r.a)} → ${label(r.b)}`, wide: true,
    body: [h('div', { class: 'small muted' }, `${plural(r.total, 'arquivo diferente', 'arquivos diferentes')} · ${count('A')} adicionado(s) · ${count('D')} removido(s) · ${count('M')} alterado(s)${count('R') ? ` · ${count('R')} renomeado(s)` : ''}. Clique num arquivo para ver as diferenças.`),
      r.files.length ? h('div', { class: 'hist-files', style: 'max-height:55vh' }, r.files.map((f) => h('div', { class: `hist-file g-${f.status === 'A' ? 'A' : f.status === 'D' ? 'D' : f.status === 'R' ? 'R' : 'M'}`, title: `${f.origPath ? `${f.origPath} → ` : ''}${f.path}`,
        onclick: async () => {
          try {
            const d = await gitApi('GET', `/compare-diff?${qs({ a: r.a, b: r.b, path: f.path, orig: f.origPath })}`, null, project);
            showDiffModal({ title: f.path.split('/').pop(), subtitle: `${f.origPath ? `${f.origPath} → ` : ''}${f.path}`, original: d.original, modified: d.modified, labels: [label(r.a), label(r.b)] });
          } catch (e) { gitError(e); }
        } }, h('span', { class: 'ws-gcode' }, f.status), h('span', { class: 'grow ws-cname' }, f.path),
        f.binary ? h('span', { class: 'muted small' }, 'binário') : [h('span', { class: 'add small' }, `+${f.additions ?? 0}`), h('span', { class: 'del small' }, `−${f.deletions ?? 0}`)])))
        : h('div', { class: 'empty' }, 'As duas versões têm o mesmo conteúdo.')],
    footer: [h('button', { class: 'btn primary', onclick: () => md.close() }, 'Fechar')] });
}

// ---------- Recuperar versão perdida (reflog) ----------
async function reflogDialog(project) {
  let list;
  try { list = await gitApi('GET', '/reflog?limit=150', null, project); } catch (e) { return gitError(e); }
  const md = openModal({ title: 'Recuperar versão perdida', wide: true,
    body: [h('div', { class: 'small muted' }, 'Por onde a versão atual (HEAD) passou — inclui commits que “sumiram” depois de um reset ou de trocar de branch (git reflog). O recomendado é criar uma branch de recuperação: nada é apagado nem resetado.'),
      list.length ? h('div', { class: 'tablewrap', style: 'max-height:55vh' }, h('table', null,
        h('thead', null, h('tr', null, ['Quando', 'Versão', 'O que aconteceu', 'Mensagem', ''].map((t) => h('th', null, t)))),
        h('tbody', null, list.map((x) => h('tr', null,
          h('td', { class: 'small' }, x.date ? new Date(x.date).toLocaleString('pt-BR') : x.ref), h('td', { class: 'mono', title: x.hash }, x.short), h('td', { class: 'small' }, x.action), h('td', { class: 'small' }, x.subject),
          h('td', null, h('div', { class: 'inline', style: 'flex-wrap:nowrap' },
            h('button', { class: 'btn xs primary', onclick: () => { md.close(); branchFromForm(project, { commit: x.hash, title: 'Criar branch de recuperação daqui', name: `recuperacao/${gaStamp()}`, checkout: false, intro: `Cria uma branch na versão ${x.short} (“${x.subject}”) para recuperá-la, sem mexer na branch atual.` }); } }, 'Criar branch de recuperação'),
            h('button', { class: 'btn xs', onclick: () => { md.close(); openOldForm(project, x.hash); } }, 'Consultar'),
            h('button', { class: 'btn xs', onclick: () => { md.close(); restoreFromForm(project, { commit: x.hash }); } }, 'Recuperar arquivo…'))))))))
        : h('div', { class: 'empty' }, 'O reflog está vazio.')],
    footer: [h('button', { class: 'btn primary', onclick: () => md.close() }, 'Fechar')] });
}

// ---------- Aba “Ações rápidas” ----------
function gitInProgressBox(project, st) {
  const items = [
    st.cherryPicking ? ['Aplicação de alteração (cherry-pick) em andamento.', 'Cancelar aplicação da alteração', 'cherry-pick-abort'] : null,
    st.reverting ? ['Desfazer (revert) em andamento.', 'Cancelar o desfazer', 'revert-abort'] : null,
  ].filter(Boolean);
  if (!items.length) return null;
  return h('div', { class: 'box warn ws-mergebox' }, items.map(([t, b, a]) => h('div', { class: 'inline' }, h('strong', null, t),
    h('span', { class: 'small' }, st.conflicts.length ? `${plural(st.conflicts.length, 'arquivo em conflito', 'arquivos em conflito')}: resolva, marque “Resolvido” e conclua com o commit.` : 'Conflitos resolvidos: conclua com o commit.'),
    h('button', { class: 'btn sm danger', onclick: () => gitPlan(a, {}, { project }) }, b))));
}

function renderGitActions(body, project, g) {
  const st = g.status;
  const has = st.files.length > 0;
  const rem = !!mainRemote(g);
  const go = (tab) => { WM.gitTab = tab; renderGitPanel(); };
  const card = (name, desc, cmd, risk, run, disabled) => h('div', { class: 'ga-card' },
    h('div', { class: 'ga-top' }, h('strong', null, name), gaRisk(risk)),
    h('div', { class: 'small muted grow' }, desc),
    h('div', { class: 'ga-foot' }, h('code', { class: 'ga-cmdtag', title: `Comando Git correspondente: ${cmd}` }, cmd), h('button', { class: 'btn sm', disabled: !!disabled, title: disabled || '', onclick: run }, 'Abrir…')));
  const sec = (title, hint, cards) => h('section', { class: 'ga-sec' }, h('div', { class: 'ga-sechead' }, h('strong', null, title), hint ? h('span', { class: 'small muted' }, hint) : null), h('div', { class: 'ga-grid' }, cards));
  const noChanges = has ? null : 'Não há alterações.';
  setKids(body, h('div', { class: 'ga-wrap' },
    gitInProgressBox(project, st),
    sec('Ver e salvar', null, [
      card('Ver alterações', 'Arquivos alterados, novos e removidos que ainda não foram salvos numa versão.', 'git status · git diff', 'safe', () => go('changes')),
      card('Comparar arquivo', 'Escolha um arquivo e veja exatamente o que mudou nele.', 'git diff -- <arquivo>', 'safe', () => fileForm(project, { title: 'Comparar arquivo', submit: 'Ver diferenças', onPick: (f) => openDiff(f, project) }), noChanges),
      card('Salvar versão', 'Escolha os arquivos e salve uma versão (commit). Nada é incluído sem você ver.', 'git add -- <arquivos> · git commit', 'safe', () => { go('changes'); setTimeout(() => document.querySelector('.ws-commitmsg')?.focus(), 0); }),
      card('Histórico de versões', 'Commits com hash, mensagem, data, autor, branches e tags; selecione um para ver as ações dele.', 'git log', 'safe', () => go('history')),
      card('Comparar versões', 'O que mudou entre duas versões: adicionados, removidos e alterados.', 'git diff <A> <B>', 'safe', () => compareForm(project), st.oid ? null : 'Ainda não há commits.'),
    ]),
    sec('Proteger antes de mexer', 'Faça isto antes de uma alteração arriscada.', [
      card('Criar ponto de segurança', 'Guarda o estado atual numa branch de backup. Com alterações não salvas, ofereça o checkpoint completo.', 'git branch backup/<data>', 'safe', () => checkpointForm(project), st.oid ? null : 'Ainda não há commits.'),
      card('Criar cópia desta versão', 'Preserva a versão atual antes de experimentar algo (arquivos ignorados pelo Git não entram).', 'git branch backup/<nome>', 'safe', () => checkpointForm(project, { copy: true }), st.oid ? null : 'Ainda não há commits.'),
      card('Guardar alterações para depois', 'Tira as alterações da pasta e guarda, para trocar de branch sem perder trabalho.', 'git stash push -m "<descrição>"', 'safe', () => stashForm(project), noChanges),
      card('Recuperar alterações guardadas', 'Lista o que foi guardado e aplica de volta (o item continua guardado até você remover).', 'git stash list · git stash apply', 'safe', () => stashDialog(project)),
    ]),
    sec('Desfazer com segurança', 'Sempre a opção que muda menos.', [
      card('Voltar este arquivo', 'Descarta as alterações locais de UM arquivo (veja as diferenças antes).', 'git restore <arquivo>', 'attention', () => fileForm(project, { title: 'Voltar este arquivo', restorable: true, intro: 'Todas as alterações locais do arquivo escolhido serão descartadas.', onPick: (f) => gitPlan('restore-file', { path: f.path }, { project }) }), noChanges),
      card('Recuperar arquivo de outra versão', 'Traz só um arquivo de uma versão anterior, sem voltar o resto do projeto.', 'git restore --source=<commit> -- <arquivo>', 'attention', () => restoreFromForm(project), st.oid ? null : 'Ainda não há commits.'),
      card('Desfazer último commit e continuar editando', 'Remove o último commit (só se ainda não foi enviado); as alterações continuam nos arquivos.', 'git reset --soft HEAD~1', 'attention', () => gitPlan('undo-commit', {}, { project }), st.oid ? null : 'Ainda não há commits.'),
      card('Desfazer uma versão publicada', 'Cria um novo commit que desfaz outro. Não reescreve o histórico — o certo para o que já foi enviado.', 'git revert <commit>', 'attention', () => commitForm(project, { title: 'Desfazer uma versão publicada', intro: 'Escolha a versão a desfazer. Será criado um novo commit que desfaz as alterações dela.', action: 'revert' }), st.oid ? null : 'Ainda não há commits.'),
      card('Trazer esta alteração', 'Traz só um commit de outra branch (ex.: uma correção), sem trazer as outras mudanças.', 'git cherry-pick <commit>', 'attention', () => commitForm(project, { title: 'Trazer esta alteração', intro: 'Escolha o commit (de qualquer branch) que deve ser copiado para a branch atual.', action: 'cherry-pick', all: true }), st.oid ? null : 'Ainda não há commits.'),
      card('Recuperar versão perdida', 'Fez um reset ou perdeu uma referência? O reflog mostra por onde o projeto passou.', 'git reflog · git branch recuperacao/<data> <hash>', 'safe', () => reflogDialog(project)),
    ]),
    sec('Versões de trabalho (branches) e marcos', null, [
      card('Versões de trabalho', 'Branches locais e remotas: abrir, criar, renomear, excluir (só se já integrada).', 'git branch · git switch', 'safe', () => wsGitBranchesDialog()),
      card('Criar área para correção', 'Nova branch a partir da versão atual para corrigir algo isolado.', 'git switch -c correcao/<nome>', 'safe', () => branchFromForm(project, { commit: st.oid, title: 'Criar área para correção', name: 'correcao/', intro: 'Cria uma branch a partir da versão atual e passa a trabalhar nela.' }), st.oid ? null : 'Ainda não há commits.'),
      card('Abrir versão antiga', 'Consulta uma versão anterior sem alterar a branch principal (ou numa branch temporária para editar).', 'git switch --detach <commit>', 'safe', () => openOldForm(project), st.oid ? null : 'Ainda não há commits.'),
      card('Criar cópia a partir desta versão', 'Nova branch numa versão antiga para trabalhar nela sem destruir o estado atual.', 'git switch -c <nova-branch> <commit>', 'safe', () => branchFromForm(project, { title: 'Criar cópia a partir desta versão', intro: 'Cria uma branch numa versão anterior; o estado atual continua intacto na branch atual.' }), st.oid ? null : 'Ainda não há commits.'),
      card('Marcar versão estável', 'Cria um marco (tag) numa versão importante, ex.: v1.2.0 ou antes-refatoracao.', 'git tag <nome>', 'safe', () => tagForm(project), st.oid ? null : 'Ainda não há commits.'),
    ]),
    sec('GitHub (remoto)', rem ? null : 'Associe um remote em “Mais → Repositório e GitHub”.', [
      card('Ver novidades do remoto', 'Consulta o GitHub sem alterar seus arquivos.', 'git fetch', 'safe', () => doFetch(null, project), rem ? null : 'Sem remote.'),
      card('Baixar alterações', 'Consulta o remoto, mostra quantos commits chegam/divergem e só então baixa.', 'git fetch · git pull', 'attention', () => gitPlan('pull', {}, { project }), rem ? null : 'Sem remote.'),
      card('Enviar para o GitHub', 'Mostra branch local → remota e quantos commits serão enviados.', 'git push', 'safe', () => gitPlan('push', {}, { project }), rem ? null : 'Sem remote.'),
    ]),
    sec('Último recurso', 'Avançado: sempre com prévia, lista do que muda e confirmação explícita.', [
      card('Descartar alterações locais', 'Todos os arquivos versionados voltam à última versão salva. Arquivos novos ficam.', 'git restore .', 'advanced', () => gitPlan('discard-all', {}, { project }), noChanges),
      card('Limpar arquivos não versionados', 'Mostra antes exatamente o que seria apagado (sem os ignorados) e pede confirmação.', 'git clean -nd → git clean -fd', 'advanced', () => gitPlan('clean', {}, { project }), st.files.some((f) => f.untracked) ? null : 'Não há arquivos novos.'),
      card('Voltar projeto para esta versão', 'A branch inteira volta para uma versão anterior. Diferente de só consultar.', 'git reset --hard <commit>', 'advanced', () => commitForm(project, { title: 'Voltar projeto para esta versão', intro: 'Escolha a versão. A prévia mostra as alterações locais que serão perdidas e os commits que saem da branch.', action: 'reset-hard' }), st.oid ? null : 'Ainda não há commits.'),
      card('Voltar versão publicada', 'Reescreve a branch remota (caso excepcional). Prefira “Desfazer uma versão publicada”.', 'git reset --hard <commit> · git push --force-with-lease', 'advanced', () => commitForm(project, { title: 'Voltar versão publicada', intro: 'Caso excepcional: a branch remota volta para a versão escolhida. A prévia consulta o remoto, cria branches de segurança e lista os commits removidos.', action: 'rewind-remote' }), st.upstream ? null : 'Branch sem upstream.'),
    ])));
}

// ---------- Aba “Guia Git” ----------
const GIT_GUIDE = [
  ['Ver alterações', 'Quero saber o que mudei', 'safe'],
  ['Criar ponto de segurança', 'Antes de uma alteração arriscada', 'safe'],
  ['Guardar alterações para depois', 'Preciso trocar de branch sem perder trabalho', 'safe'],
  ['Voltar este arquivo', 'Estraguei somente um arquivo', 'attention'],
  ['Recuperar arquivo de outra versão', 'Quero só a versão antiga de um arquivo', 'attention'],
  ['Desfazer último commit e continuar editando', 'Fiz commit cedo demais e ainda não enviei', 'attention'],
  ['Desfazer uma versão publicada', 'Enviei algo errado — preferir Revert', 'attention'],
  ['Trazer esta alteração', 'Quero só um commit de outra branch (cherry-pick)', 'attention'],
  ['Abrir versão antiga / Criar cópia a partir desta versão', 'Preciso testar ou trabalhar numa versão antiga', 'safe'],
  ['Recuperar versão perdida', 'Fiz reset ou perdi uma referência (reflog)', 'safe'],
  ['Voltar projeto para esta versão', 'Preciso realmente retornar todo o código', 'advanced'],
  ['Voltar versão publicada', 'Preciso reescrever a branch remota — muito avançado', 'advanced'],
];
const GIT_FLOW = [
  ['Problema em 1 arquivo', 'Voltar este arquivo / Recuperar arquivo de outra versão'],
  ['Problema em 1 commit', 'Desfazer uma versão publicada (revert)'],
  ['Preciso de uma correção antiga', 'Trazer esta alteração (cherry-pick)'],
  ['Preciso testar uma versão antiga', 'Criar cópia a partir desta versão (branch)'],
  ['Preciso guardar o que estou fazendo', 'Guardar alterações para depois (stash) ou Criar ponto de segurança'],
  ['Perdi algo', 'Recuperar versão perdida (reflog)'],
  ['Somente como último recurso', 'Voltar projeto para esta versão (reset --hard)'],
  ['Mais excepcional ainda', 'Voltar versão publicada (push --force-with-lease)'],
];
function renderGitGuide(body) {
  setKids(body, h('div', { class: 'ga-wrap' },
    h('section', { class: 'ga-sec' }, h('div', { class: 'ga-sechead' }, h('strong', null, 'Dicionário rápido'), h('span', { class: 'small muted' }, 'Para executar, use a aba Ações rápidas — cada ação mostra a prévia antes.')),
      h('div', { class: 'tablewrap', style: 'max-height:none' }, h('table', { class: 'ga-guide' }, h('thead', null, h('tr', null, h('th', null, 'Ação'), h('th', null, 'Quando usar'), h('th', null, 'Risco'))),
        h('tbody', null, GIT_GUIDE.map(([a, w, r]) => h('tr', null, h('td', null, h('strong', null, a)), h('td', null, w), h('td', null, gaRisk(r)))))))),
    h('section', { class: 'ga-sec' }, h('div', { class: 'ga-sechead' }, h('strong', null, 'Fluxo de segurança'), h('span', { class: 'small muted' }, 'Sempre escolher a operação que causa MENOS alterações.')),
      h('ol', { class: 'ga-flow' }, GIT_FLOW.map(([p, s]) => h('li', null, h('strong', null, p), ' → ', s)))),
    h('section', { class: 'ga-sec' }, h('div', { class: 'ga-sechead' }, h('strong', null, 'Níveis de risco')),
      h('div', { class: 'stack small' }, h('div', null, gaRisk('safe'), ' Normalmente reversível e sem perda de histórico.'), h('div', null, gaRisk('attention'), ' Pode alterar arquivos ou o estado atual.'),
        h('div', null, gaRisk('advanced'), ' Pode reescrever histórico ou descartar alterações — nunca executa sem confirmação explícita.')))));
}

// ---------- Ações a partir de um commit do Histórico ----------
function gitCommitActions(d, project) {
  const g = WM.git.get(project);
  const cur = g?.status?.oid === d.hash;
  return h('div', { class: 'ga-commitacts' },
    h('button', { class: 'btn xs', title: 'Abrir esta versão para consultar (ou numa branch temporária para editar)', onclick: () => openOldForm(project, d.hash) }, 'Abrir versão'),
    h('button', { class: 'btn xs', title: 'git switch -c <nova-branch> <commit>', onclick: () => branchFromForm(project, { commit: d.hash, title: 'Criar cópia a partir desta versão', name: `recuperacao/${d.short}`, intro: `Cria uma branch na versão ${d.short}.` }) }, 'Criar branch daqui'),
    !cur ? h('button', { class: 'btn xs', title: 'git cherry-pick: traz só este commit para a branch atual', onclick: () => gitPlan('cherry-pick', { commit: d.hash }, { project }) }, 'Trazer para a branch atual') : null,
    h('button', { class: 'btn xs', title: 'git revert: novo commit que desfaz este', onclick: () => gitPlan('revert', { commit: d.hash }, { project }) }, 'Desfazer (revert)'),
    h('button', { class: 'btn xs', title: 'git tag', onclick: () => tagForm(project, d.hash) }, 'Marcar versão'),
    !cur && g?.status?.oid ? h('button', { class: 'btn xs', title: 'git diff <este> <atual>', onclick: () => compareDialog(project, d.hash, g.status.oid).catch(gitError) }, 'Comparar com a atual') : null,
    h('button', { class: 'btn xs ghost', title: 'Ações avançadas', onclick: (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      contextMenu(r.left, r.bottom + 4, [
        { label: 'Voltar projeto para esta versão (avançado)…', disabled: cur, run: () => gitPlan('reset-hard', { commit: d.hash }, { project }) },
        { label: 'Voltar versão publicada para esta (avançado)…', disabled: !g?.status?.upstream, run: () => gitPlan('rewind-remote', { commit: d.hash }, { project }) },
      ]);
    } }, 'Avançado ▾'));
}
