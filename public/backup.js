'use strict';
// Configurações → Backup e Restauração: exportar tudo para um arquivo .gpbackup e importar (substitui os dados atuais).
// A tela só pede e mostra; validação, cifra, backup automático e desfazer ficam no servidor (src/backup.js).

const BACKUP_LABELS = [
  ['projects', 'Projetos'], ['projectChecklists', 'Checklists dos projetos'], ['cycles', 'Ciclos'], ['stages', 'Estágios'],
  ['checklists', 'Checklists (modelos)'], ['checklistItems', 'Itens de checklist (modelos)'], ['coordinators', 'Responsáveis'],
  ['projectContacts', 'Contatos dos projetos'], ['connections', 'Conexões'], ['emailTemplates', 'Modelos de e-mail'],
  ['emailGenerations', 'Comunicações geradas'], ['documents', 'Documentos e modelos'], ['scripts', 'Scripts SQL'],
  ['evidenceFiles', 'Arquivos de evidências e imagens'], ['scriptFiles', 'Arquivos de scripts (com versões)'], ['documentFiles', 'Arquivos de documentos'],
  ['timeEntries', 'Apontamentos de horas'], ['timeNotes', 'Observações das horas'],
  ['reminders', 'Lembretes'], ['milestoneReminders', 'Lembretes de prazos do cronograma'],
];

// Preferências da tela que vão no backup (mesma lista do servidor: src/backup.js PREF_KEYS).
const BACKUP_PREF_KEYS = ['gp-ui', 'gp-theme', 'gp-nav-w', 'gp-wm-prefs', 'gp-run-target'];

function backupSummaryTable(sections, after) {
  return h('table', { class: 'compact' },
    h('thead', null, h('tr', null, h('th', null, 'Conteúdo'), h('th', null, after ? 'No backup' : 'Quantidade'), after ? h('th', null, 'Importado') : null)),
    h('tbody', null, BACKUP_LABELS.filter(([k]) => sections[k] !== undefined).map(([k, label]) => h('tr', null, h('td', null, label), h('td', null, String(sections[k])),
      after ? h('td', null, after[k] === sections[k] ? String(after[k]) : h('span', { class: 'pill overdue' }, String(after[k]))) : null))));
}

function backupExportCard() {
  const info = h('div', { class: 'cfg-path small muted' }, 'Carregando…');
  api('GET', '/api/backup/info').then((r) => {
    info.textContent = r.lastBackupAt ? `Último backup: ${fmtDateTime(r.lastBackupAt)}${r.lastBackupFile ? ` — ${r.lastBackupFile}` : ''}${r.lastBackupAppVersion ? ` (aplicativo ${r.lastBackupAppVersion})` : ''}` : 'Nenhum backup exportado ainda.';
  }).catch(() => { info.textContent = ''; });
  const protectBox = h('input', { type: 'checkbox', checked: true });
  const p1 = h('input', { type: 'password', autocomplete: 'new-password', maxlength: 200 });
  const p2 = h('input', { type: 'password', autocomplete: 'new-password', maxlength: 200 });
  const credBox = h('input', { type: 'checkbox' });
  const pwArea = h('div', { class: 'cfg-fields' },
    h('div', { class: 'cols2' }, field('Senha do backup', p1, 'Mínimo de 10 caracteres. Ela não é guardada: sem ela o backup não abre.'), field('Repita a senha', p2)),
    h('label', { class: 'inline small' }, credBox, h('span', null, 'Incluir as senhas das conexões de banco (vão cifradas dentro do backup e são protegidas de novo na outra máquina)')));
  protectBox.onchange = () => { pwArea.style.display = protectBox.checked ? '' : 'none'; if (!protectBox.checked) credBox.checked = false; };
  const btn = h('button', { class: 'btn primary' }, 'Exportar tudo');
  btn.onclick = () => busy(btn, async () => {
    const password = protectBox.checked ? p1.value : '';
    if (protectBox.checked && password !== p2.value) throw new Error('As duas senhas não conferem.');
    if (protectBox.checked && password.length < 10) throw new Error('A senha do backup precisa ter pelo menos 10 caracteres.');
    toast('Preparando backup…');
    const prefs = {};
    for (const k of BACKUP_PREF_KEYS) { try { const v = localStorage.getItem(k); if (v !== null) prefs[k] = v; } catch { /* */ } }
    const r = await api('POST', '/api/backup/export', { password, includeCredentials: credBox.checked, prefs });
    if (r.canceled) return;
    p1.value = ''; p2.value = '';
    toast('Backup criado com sucesso.');
    info.textContent = `Último backup: ${fmtDateTime(new Date().toISOString())} — ${r.file}`;
    openModal({ title: 'Backup criado com sucesso', body: [
      h('p', null, h('span', { class: 'mono' }, r.file), ` (${fmtSize(r.size)})`),
      h('p', { class: 'small muted' }, r.encrypted ? `Protegido com senha${r.includesCredentials ? ', com as senhas das conexões' : ''}.` : 'Sem senha: guarde o arquivo em local seguro (ele contém todos os seus dados).'),
      r.credentialProblems ? h('p', { class: 'small' }, `⚠ ${plural(r.credentialProblems, 'senha não pôde ser lida', 'senhas não puderam ser lidas')} neste computador e ficou de fora.`) : null,
      backupSummaryTable(r.sections)] });
  }, 'Preparando backup…');
  return cfgCard('Backup',
    h('p', { class: 'cfg-intro' }, 'Gera UM arquivo .gpbackup com tudo: projetos, ciclos, checklists, configurações, contatos, comunicações, documentos, scripts (com versões), evidências, horas e auditoria. Copie o arquivo para a outra máquina (pendrive, OneDrive, rede…) e importe lá.'),
    info,
    h('div', { class: 'cfg-section' }, h('label', { class: 'inline' }, protectBox, h('span', null, 'Proteger backup com senha (recomendado)')), pwArea),
    h('div', { class: 'cfg-actions' }, btn));
}

function backupImportCard() {
  const btn = h('button', { class: 'btn' }, 'Importar backup');
  btn.onclick = () => busy(btn, async () => {
    let r = await api('POST', '/api/backup/inspect', {});
    if (r.canceled) return;
    while (r.needsPassword) {
      const password = await backupAskPassword(r.path);
      if (password === null) return;
      toast('Validando backup…');
      try { r = await api('POST', '/api/backup/inspect', { path: r.path, password }); } catch (e) { if (e.code === 'BAD_PASSWORD') { fail(e); continue; } throw e; }
    }
    backupConfirmImport(r);
  }, 'Validando backup…');
  return cfgCard('Restauração',
    h('div', { class: 'box warn' }, 'Substitui TODOS os dados desta aplicação pelos dados do backup. Antes, um backup automático do estado atual é salvo; se algo falhar, nada muda.'),
    h('div', { class: 'cfg-actions' }, btn));
}

function backupAskPassword(file) {
  return new Promise((resolve) => {
    const pw = h('input', { type: 'password', autocomplete: 'off', maxlength: 200, autofocus: true });
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); m.close(); };
    const m = openModal({ title: 'Backup protegido com senha', size: 'sm',
      body: [h('p', { class: 'small mono' }, file), field('Senha do backup', pw)],
      footer: [h('button', { class: 'btn', onclick: () => finish(null) }, 'Cancelar'), h('button', { class: 'btn primary', onclick: () => finish(pw.value) }, 'Abrir')],
      onClose: () => finish(null) });
    pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(pw.value); });
    setTimeout(() => pw.focus(), 30);
  });
}

function backupConfirmImport(r) {
  const go = h('button', { class: 'btn danger' }, 'Importar');
  const m = openModal({ title: 'Importar backup', wide: true, body: [
    h('div', { class: 'cols2' },
      h('div', null, h('div', { class: 'small muted' }, 'Backup criado'), h('b', null, fmtDateTime(r.createdAt))),
      h('div', null, h('div', { class: 'small muted' }, 'Arquivo'), h('span', { class: 'mono small' }, r.fileName))),
    r.migrationsNeeded?.length ? h('p', { class: 'small' }, `Backup de uma versão anterior do aplicativo: os dados serão atualizados para o esquema atual ao importar (migrações ${r.migrationsNeeded.map((x) => '#' + x).join(', ')}).`) : null,
    h('p', { class: 'small muted' }, `Formato versão ${r.version}${r.appVersion ? ` · aplicativo ${r.appVersion}` : ''}${r.schemaVersion !== undefined ? ` · esquema de dados ${r.schemaVersion}` : ''} · ${r.encrypted ? 'protegido com senha' : 'sem senha'}${r.includesCredentials ? ' · inclui senhas das conexões' : ''}`),
    backupSummaryTable(r.sections),
    r.connectionsWithoutPassword.length ? h('p', { class: 'small' }, `As conexões ${r.connectionsWithoutPassword.join(', ')} vão precisar da senha de novo depois da importação.`) : null,
    h('p', null, h('b', null, 'Os dados atuais desta aplicação serão SUBSTITUÍDOS pelos dados do backup.'), ' Um backup automático do estado atual será criado antes.')],
  footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'), go] });
  go.onclick = () => busy(go, async () => {
    toast('Importando backup…');
    const res = await api('POST', '/api/backup/import', { token: r.token });
    m.close();
    for (const [k, v] of Object.entries(res.prefs || {})) { try { localStorage.setItem(k, v); } catch { /* */ } }
    applyTheme(getThemePref()); renderThemeToggle();
    await refresh();
    toast('Backup restaurado com sucesso.');
    backupImportResult(res);
  }, 'Importando…');
}

function backupImportResult(res) {
  const missing = h('div', { class: 'stack' });
  const drawMissing = (list) => missing.replaceChildren(...(list.length ? [
    h('p', null, h('b', null, 'Caminhos que não existem nesta máquina'), h('span', { class: 'small muted' }, ' — os dados foram restaurados; escolha a pasta equivalente aqui (o que estiver dentro dela é ajustado junto).')),
    ...list.map((p) => {
      const b = h('button', { class: 'btn sm' }, 'Escolher nova pasta…');
      b.onclick = () => busy(b, async () => {
        const r = await api('POST', '/api/backup/remap', { from: p });
        if (r.canceled) return;
        toast(`${plural(r.changed, 'caminho ajustado', 'caminhos ajustados')}.`);
        drawMissing(r.missingPaths);
        await refresh();
      });
      return h('div', { class: 'row' }, h('div', { class: 'grow' }, h('span', { class: 'mono small' }, p), h('div', { class: 'small muted' }, 'Este diretório não existe nesta máquina.')), b);
    })] : [h('p', { class: 'small muted' }, 'Todos os caminhos de pastas cadastrados existem nesta máquina.')]));
  drawMissing(res.missingPaths || []);
  openModal({ title: 'Backup restaurado com sucesso', wide: true, body: [
    h('p', null, res.comparison.diffs.length ? `⚠ ${plural(res.comparison.diffs.length, 'diferença', 'diferenças')}` : 'Conferência: 0 diferenças entre o backup e os dados importados.'),
    backupSummaryTable(res.comparison.before, res.comparison.after),
    res.restoredDocuments ? h('p', { class: 'small' }, `${plural(res.restoredDocuments, 'documento foi copiado', 'documentos foram copiados')} para a pasta de dados (o caminho original não existe nesta máquina).`) : null,
    res.connectionsWithoutPassword.length ? h('p', { class: 'small' }, `⚠ Informe de novo a senha das conexões: ${res.connectionsWithoutPassword.join(', ')} (Configurações → Conexões).`) : null,
    missing,
    h('p', { class: 'small muted' }, 'Backup automático do estado anterior: ', h('span', { class: 'mono' }, res.safetyBackup))] });
}
