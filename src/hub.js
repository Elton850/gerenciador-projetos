// Hub de Dados — regras puras (sem banco, HTTP ou disco): como um projeto do banco compartilhado vira/atualiza um projeto DESTE app.
// Os dados da planilha se adaptam ao modelo do app (pessoas, sistema de origem, tipo, pasta do Drive, cronograma), nunca o contrário.
// Campos que vêm do banco: coordenador, analista de migração, sistema de origem, tipo (só se vazio), link da pasta no Drive (só se a
// pasta raiz for do Drive ou estiver vazia) e os marcos da aba MARCOS (prazos com `hub`). O resto do projeto (ciclo, checklists, horas,
// conexões, bases, observações…) é só local e nunca é tocado.
const { norm } = require('./hub-sheet');
const { parseDriveFolderUrl } = require('./drive');

// Marcos da aba MARCOS DOS PROJETOS → prazos do cronograma (chave estável em milestone.hub).
const MILESTONES = [['depara', 'Entrega do DE/PARA'], ['hmg', 'Carga em HMG'], ['hmg2', 'Carga em HMG 2'], ['prd', 'Carga em PRD']];
// Status em que os marcos já passaram (o projeto chegou à produção): entram como entregues ao baixar.
const DONE_STATUS = new Set(['CONCLUÍDO', 'EM PRODUÇÃO']);
const NEUTRAL_COLOR = '#8FB0BF';
const LOWER_WORDS = new Set(['de', 'da', 'do', 'das', 'dos', 'e']);

// “ELTON ALVES” → “Elton Alves” (a planilha usa caixa alta; o app mostra nomes normais).
function titleCase(s) {
  return String(s || '').trim().toLocaleLowerCase('pt-BR').split(/(\s+)/)
    .map((w, i) => (/^\s+$/.test(w) || (i && LOWER_WORDS.has(w)) ? w : w.charAt(0).toLocaleUpperCase('pt-BR') + w.slice(1))).join('');
}

// Pessoa pelo nome: igual (sem acento/caixa) ou, sem isso, a ÚNICA pessoa cujo nome é o primeiro nome do banco (“Beatriz” ↔ “BEATRIZ MACHADO”).
function findPerson(people, name) {
  const n = norm(name);
  if (!n) return null;
  const exact = people.filter((c) => norm(c.name) === n);
  if (exact.length) return exact[0];
  const first = n.split(' ')[0];
  const byFirst = people.filter((c) => norm(c.name) === first);
  return byFirst.length === 1 ? byFirst[0] : null;
}
function ensurePerson(data, name, uid) {
  const found = findPerson(data.coordinators, name);
  if (found) return { id: found.id, created: false };
  const c = { id: uid(), name: titleCase(name).slice(0, 120), role: '', email: '', phone: '', notes: '' };
  data.coordinators.push(c);
  return { id: c.id, created: true };
}
function ensureOrigin(data, name, uid) {
  const n = norm(name);
  const found = data.originSystems.find((s) => norm(s.name) === n);
  if (found) return { id: found.id, created: false };
  const s = { id: uid(), name: titleCase(name).slice(0, 40), color: NEUTRAL_COLOR };
  data.originSystems.push(s);
  return { id: s.id, created: true };
}
// Segmento (FOLHA, EDUCACIONAL…) → tipo de projeto cujo nome contém o segmento (o de nome mais curto; ex.: “TOTVS Educacional”).
// Não cria tipo: o tipo define o ciclo e isso é escolha do usuário.
function typeForSegment(data, segmento) {
  const words = (s) => ` ${norm(s).replace(/[^A-Z0-9]+/g, ' ').trim()} `;
  const n = words(segmento);
  if (!n.trim()) return null;
  const hits = data.projectTypes.filter((t) => words(t.name).includes(n)).sort((a, b) => a.name.length - b.name.length);
  return hits[0]?.id || null;
}
const driveUrlOf = (r) => [r.pastaUrl, r.pasta].map((u) => (u && parseDriveFolderUrl(u) ? parseDriveFolderUrl(u).url : null)).find(Boolean) || null;

// O que do banco fica visível no projeto (só leitura; derivado do último sincronismo).
function snapshot(r) {
  return { nome: r.nome, status: r.status, segmento: r.segmento, estado: r.estado, complexidade: r.complexidade, ambiente: r.ambiente, dataRepasse: r.dataRepasse,
    cronograma: r.cronograma, desenvolveScript: r.desenvolveScript, coordenador: r.coordenador, analista: r.analista, sistemaOrigem: r.sistemaOrigem,
    sistemaDestino: r.sistemaDestino, pasta: r.pasta, aba: r.aba, marcos: r.marcos, tarefas: r.tarefas };
}

// Aplica o projeto do banco `r` no projeto local `p` (mutação). Devolve a lista do que mudou (para a auditoria).
function applyRemote(data, p, r, { uid, now = new Date().toISOString(), creating = false } = {}) {
  const changes = [];
  if (r.coordenador) {
    const { id, created } = ensurePerson(data, r.coordenador, uid);
    if (created) changes.push(`pessoa cadastrada: ${titleCase(r.coordenador)}`);
    if (p.coordinatorId !== id) { p.coordinatorId = id; changes.push('coordenador'); }
  }
  if (r.analista) {
    const v = titleCase(r.analista).slice(0, 120);
    if (p.migrationAnalyst !== v) { p.migrationAnalyst = v; changes.push('analista de migração'); }
  }
  if (r.sistemaOrigem) {
    const { id, created } = ensureOrigin(data, r.sistemaOrigem, uid);
    if (created) changes.push(`sistema de origem cadastrado: ${titleCase(r.sistemaOrigem)}`);
    if (p.originSystemId !== id) { p.originSystemId = id; changes.push('sistema de origem'); }
  }
  if (!p.projectTypeId) {
    const t = typeForSegment(data, r.segmento);
    if (t) { p.projectTypeId = t; changes.push('tipo de projeto'); }
  }
  const url = driveUrlOf(r);
  if (url && (p.rootDirKind === 'drive' || !p.rootDir) && p.rootDriveUrl !== url) {
    Object.assign(p, { rootDirKind: 'drive', rootDir: '', rootDriveUrl: url });
    changes.push('pasta do Drive');
  }
  if (!p.cancelled || creating) { // projeto cancelado: prazos congelados (como na tela)
    if (!Array.isArray(p.milestones)) p.milestones = [];
    for (const [key, title] of MILESTONES) {
      const due = r.marcos?.[key];
      if (!due) continue;
      const m = p.milestones.find((x) => x.hub === key);
      if (!m) {
        p.milestones.push({ id: uid(), title, startDate: null, dueDate: due, alertDays: null, done: DONE_STATUS.has(r.status), note: 'Marco da planilha (Hub de Dados).', reminder: null, hub: key });
        changes.push(`prazo ${title}`);
      } else if (m.dueDate !== due && !m.done) {
        m.dueDate = due;
        if (m.startDate && m.startDate >= due) m.startDate = null;
        if (m.reminder) m.reminder.snoozeUntil = null; // data nova: o lembrete acompanha
        changes.push(`prazo ${title}`);
      }
    }
  }
  p.hub = { id: r.hubId, nome: r.nome, linkedAt: p.hub?.linkedAt || now, syncedAt: now, remoteUpdatedAt: r.updatedAt || null, data: snapshot(r) };
  return changes;
}

// Projeto novo a partir do banco (mesmos campos do POST /api/projects). Ciclo e cancelamento ficam com quem chama.
function newProject(data, r, { uid, now = new Date().toISOString() }) {
  const p = { id: uid(), name: String(r.nome).slice(0, 120), description: '', rootDirKind: 'local', rootDir: '', rootDriveUrl: '', createdAt: now, bases: [], deparas: [], milestones: [],
    coordinatorId: null, analystId: null, projectTypeId: null, originSystemId: null, stepId: null, stageHistory: [], corrections: [], checklists: [], defaultConnectionId: null,
    whatsappGroupUrl: '', migrationAnalyst: '', hub: null };
  const changes = applyRemote(data, p, r, { uid, now, creating: true });
  return { p, changes };
}

// Projeto local com o mesmo nome (sem acento/caixa) e ainda sem vínculo: sugestão de vincular em vez de baixar outro.
function suggestLocal(projects, r) {
  const n = norm(r.nome);
  return projects.find((p) => !p.hub && norm(p.name) === n) || null;
}

module.exports = { MILESTONES, titleCase, findPerson, typeForSegment, driveUrlOf, applyRemote, newProject, suggestLocal, snapshot };
