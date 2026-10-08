'use strict';
// Configurações → Atualizações: versão instalada, migrações de dados, pasta de publicação (canal), atualizar o aplicativo,
// sincronizar configurações compartilháveis e publicar (computador principal). Regras no servidor: src/updates.js, src/config-sync.js.

const UPD = { status: null, check: null, sync: null };
const UPD_KIND = { new: ['Novo', 'pill'], updated: ['Atualizado na origem', 'pill'], conflict: ['Alterado aqui e na origem — vale a origem', 'pill soon'],
  'local-only': ['Alterado só aqui — mantido', 'pill'], 'removed-at-source': ['Removido na origem — mantido aqui', 'pill'] };

async function updLoad() { UPD.status = await api('GET', '/api/updates/status'); return UPD.status; }
const updRedraw = () => { const slot = document.querySelector('[data-slot="updates"]'); if (slot) slot.replaceChildren(...updatesCards()); };

function updatesTab() {
  const slot = h('div', { 'data-slot': 'updates', class: 'cfg-slot' }, h('div', { class: 'muted' }, 'Carregando…'));
  updLoad().then(() => { updRedraw(); if (UPD.status.lastResult) updShowResult(UPD.status.lastResult); }).catch(fail);
  return [slot];
}

function updShowResult(r) {
  const ok = r.status === 'ok';
  toast(ok ? `Aplicativo atualizado para a versão ${r.version}.` : r.message || 'A atualização não foi concluída.', ok ? 'info' : 'error');
}

function updatesCards() {
  const s = UPD.status;
  if (!s) return [];
  return [updAppCard(s), updChannelCard(s), updSyncCard(s), s.packaged ? updPublishCard(s) : null].filter(Boolean);
}

function updAppCard(s) {
  const c = UPD.check?.app;
  const checkBtn = h('button', { class: 'btn' }, 'Verificar atualizações');
  checkBtn.onclick = () => busy(checkBtn, async () => { UPD.check = await api('POST', '/api/updates/check'); updRedraw(); }, 'Verificando…');
  const actions = [];
  const lines = [
    h('div', { class: 'cfg-stats' },
      h('div', { class: 'cfg-stat' }, h('span', { class: 'small muted' }, 'Versão instalada'), h('b', null, s.appVersion), s.packaged ? null : h('span', { class: 'small muted' }, 'modo de desenvolvimento (node server.js)')),
      h('div', { class: 'cfg-stat' }, h('span', { class: 'small muted' }, 'Esquema dos dados'), h('b', null, s.schemaVersion ?? '—'),
        h('span', { class: 'small muted' }, s.migrations.length ? `Migrações aplicadas: ${s.migrations.map((m) => `#${m.id} (${fmtDateTime(m.at)})`).join(', ')}` : 'Nenhuma migração aplicada nesta instalação.'))),
  ];
  if (c) {
    lines.push(h('p', { class: c.status === 'available' ? '' : 'muted' }, c.message));
    if (c.status === 'available') {
      if (c.notes) lines.push(h('div', { class: 'box small', style: 'white-space:pre-line' }, h('b', null, `Novidades da ${c.latest}: `), c.notes));
      if (c.canApply) {
        const go = h('button', { class: 'btn primary' }, 'Atualizar aplicação');
        go.onclick = async () => {
          if (!(await confirmDialog({ title: 'Atualizar aplicação', message: `Atualizar de ${c.installed} para ${c.latest}?\n\nO aplicativo fecha, troca só o código e abre de novo. Seus dados não são tocados (um backup automático é feito antes). Se a versão nova não abrir, a anterior volta sozinha.`, okText: 'Atualizar' }))) return;
          await busy(go, async () => {
            const r = await api('POST', '/api/updates/apply');
            document.body.replaceChildren(h('div', { class: 'auth-screen', style: 'min-height:100vh;display:grid;place-items:center' }, h('div', { class: 'card', style: 'padding:24px;max-width:460px' },
              h('b', null, `Atualizando para a versão ${r.version}…`), h('p', { class: 'muted' }, 'O aplicativo vai fechar e abrir de novo sozinho em alguns segundos.'))));
          }, 'Preparando…');
        };
        actions.push(go);
      } else lines.push(h('p', { class: 'small' }, `⚠ ${c.blocked}`), c.installPackage && c.fullInstallRequired ? h('p', { class: 'small mono' }, c.installPackage) : null);
    }
  }
  actions.push(checkBtn);
  lines.push(h('div', { class: 'cfg-actions' }, ...actions));
  return cfgCard('Aplicativo', ...lines);
}

function updChannelCard(s) {
  const pick = h('button', { class: 'btn' }, s.channel ? 'Trocar pasta…' : 'Escolher pasta…');
  pick.onclick = () => busy(pick, async () => { const r = await api('PUT', '/api/updates/channel', {}); if (r.canceled) return; UPD.check = null; await updLoad(); updRedraw(); toast('Pasta de publicação definida.'); });
  const clear = s.channel ? h('button', { class: 'btn ghost' }, 'Remover') : null;
  if (clear) clear.onclick = () => busy(clear, async () => { await api('PUT', '/api/updates/channel', { clear: true }); UPD.check = null; await updLoad(); updRedraw(); });
  return cfgCard('Pasta de publicação',
    h('p', { class: 'cfg-intro' }, 'Uma pasta compartilhada entre as suas máquinas (OneDrive/Google Drive no computador, pasta de rede ou pendrive). O computador principal publica nela as versões do aplicativo e as configurações; as outras instalações verificam e atualizam a partir dela. Nada de dados pessoais vai para essa pasta.'),
    s.channel ? h('div', { class: 'cfg-path stack' }, h('span', { class: 'mono small' }, s.channel), s.channelExists ? null : h('span', { class: 'pill overdue', style: 'width:fit-content' }, 'pasta não encontrada nesta máquina')) : h('div', { class: 'cfg-path small muted' }, 'Nenhuma pasta escolhida.'),
    h('div', { class: 'cfg-actions' }, pick, clear));
}

function updSyncCard(s) {
  const d = UPD.sync;
  const checkBtn = h('button', { class: 'btn' }, 'Verificar configurações');
  checkBtn.onclick = () => busy(checkBtn, async () => { UPD.sync = await api('POST', '/api/config-sync/check'); updRedraw(); }, 'Verificando…');
  const actions = [];
  let hint = null;
  const body = [h('p', { class: 'cfg-intro' }, 'Ciclos, estágios, checklists e itens, tipos de projeto, sistemas de origem, scripts SQL, modelos de e-mail globais, documentos e modelos e ajustes gerais (prazo e evidências). Não inclui projetos, horas, conexões nem dados pessoais.'),
    h('div', { class: 'cfg-path small' }, s.configSync ? `Última sincronização: revisão ${s.configSync.revision} em ${fmtDateTime(s.configSync.appliedAt)}.` : 'Esta instalação ainda não sincronizou configurações.')];
  if (d) {
    if (d.status !== 'ok') body.push(h('p', { class: 'muted' }, d.message));
    else {
      const shown = d.changes;
      body.push(h('p', null, d.toApply ? `Existem novas configurações disponíveis (revisão ${d.revision}, publicada em ${fmtDateTime(d.publishedAt)}): ${plural(d.toApply, 'alteração', 'alterações')} para aplicar.` : `Configurações em dia com a revisão ${d.revision}.`));
      if (shown.length) body.push(h('div', { class: 'cfg-table' }, h('table', { class: 'compact' }, h('tbody', null, shown.map((c) => h('tr', null, h('td', null, d.labels[c.section] || c.section), h('td', null, c.name), h('td', null, h('span', { class: UPD_KIND[c.kind][1] }, UPD_KIND[c.kind][0]))))))));
      if (d.toApply) {
        const go = h('button', { class: 'btn primary' }, 'Sincronizar configurações');
        go.onclick = () => busy(go, async () => {
          const r = await api('POST', '/api/config-sync/apply', { revision: d.revision });
          UPD.sync = null; await refresh(); await updLoad(); updRedraw();
          toast(`Configurações sincronizadas: ${plural(r.applied.length, 'alteração aplicada', 'alterações aplicadas')}.`);
        }, 'Sincronizando…');
        actions.push(go);
        hint = h('span', { class: 'small muted' }, 'Um backup automático é feito antes. Projetos só mudam de ciclo quando você clicar em “Aplicar” neles.');
      }
    }
  }
  actions.push(checkBtn);
  if (hint) actions.push(hint);
  body.push(h('div', { class: 'cfg-actions' }, ...actions));
  return cfgCard('Configurações compartilháveis', ...body);
}

function updPublishCard(s) {
  const notes = h('textarea', { maxlength: 2000, placeholder: 'O que mudou nesta versão (aparece para quem for atualizar)' });
  const pubApp = h('button', { class: 'btn' }, `Publicar esta versão (${s.appVersion})`);
  pubApp.onclick = () => busy(pubApp, async () => {
    const r = await api('POST', '/api/updates/publish', { notes: notes.value });
    toast(`Versão ${r.version} publicada (atualização ${fmtSize(r.update.size)}; instalação ${fmtSize(r.install.size)}).`);
    UPD.check = null; updRedraw();
  }, 'Publicando… (pode levar alguns minutos)');
  const pubCfg = h('button', { class: 'btn' }, 'Publicar configurações');
  pubCfg.onclick = () => busy(pubCfg, async () => { const r = await api('POST', '/api/config-sync/publish'); toast(`Configurações publicadas (revisão ${r.revision}).`); await updLoad(); updRedraw(); }, 'Publicando…');
  return cfgCard('Publicar (computador principal)',
    h('p', { class: 'cfg-intro' }, 'Versão nova do aplicativo: aumente a versão (npm version patch), gere o aplicativo (npm run build:desktop) e abra-o; depois publique aqui — ou use npm run publicar. Gera o pacote de atualização e o pacote de instalação para máquinas novas, assinados com a chave deste computador.'),
    field('Notas da versão', notes), h('div', { class: 'cfg-actions' }, pubApp, pubCfg));
}

// Ao abrir: confere o canal uma vez (sem baixar nada) e só avisa.
async function updatesStartupCheck() {
  try {
    const s = await updLoad();
    if (s.lastResult) updShowResult(s.lastResult);
    if (!s.channel || !s.channelExists) return;
    UPD.check = await api('POST', '/api/updates/check');
    if (UPD.check.app?.status === 'available') toast(`Existe uma nova versão da aplicação disponível (${UPD.check.app.latest}). Configurações → Atualizações.`);
    if (UPD.check.configs?.toApply) toast('Existem novas configurações disponíveis. Configurações → Atualizações.');
  } catch { /* sem canal acessível: nada a avisar */ }
}
