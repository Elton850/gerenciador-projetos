// Central de Cronogramas: rotas. Regras em src/schedule.js (itens, status, filtros, próximos prazos) — a tela só desenha.
// Fonte única: os prazos de cada projeto (project.milestones) e as ocorrências dos lembretes avulsos (data.reminders, calculadas por
// src/reminders.js no intervalo pedido). Nada é copiado nem gravado aqui, exceto a cor do projeto.
// Projeto cancelado fica fora da visão consolidada (como nos alertas e lembretes); no próprio projeto continua visível.
const { httpError, str } = require('./util');
const S = require('./schedule');
const R = require('./reminders');

const MAX_RANGE_DAYS = 400; // calendário/linha do tempo pedem só o intervalo visível (+ folga), nunca o histórico inteiro
const QUICK = ['today', 'week', 'next30', 'overdue'];
const STATUS = ['done', 'overdue', 'today', 'soon', 'running', 'ok', 'past']; // past = ocorrência de lembrete que ficou para trás
const KINDS = ['period', 'deadline', 'reminder'];

function mount(app, { store, getProject, publicProject }) {
  const data = () => store.data;
  const warnDays = () => (Number.isInteger(data().settings?.warnDays) ? data().settings.warnDays : S.DEFAULT_WARN_DAYS);
  const optDate = (v, what) => {
    if (v === undefined || v === '') return null;
    if (!S.validDate(v)) throw httpError(400, `${what} inválida.`);
    return v;
  };
  // Projetos visíveis na visão consolidada (+ filtro de projeto e de responsável = coordenador ou analista).
  function liveProjects(q) {
    const project = str(q.project, 40);
    const person = str(q.person, 40);
    return data().projects.filter((p) => !p.cancelled && (!project || p.id === project) && (!person || p.coordinatorId === person || p.analystId === person));
  }
  const itemsOf = (projects, today) => projects.flatMap((p) => S.scheduleItems(p, today, warnDays()));

  app.get('/api/schedule', (req, res) => {
    const today = S.todayStr();
    let from = optDate(req.query.from, 'Data inicial');
    let to = optDate(req.query.to, 'Data final');
    if (!from && !to) { from = `${today.slice(0, 8)}01`; to = S.addDays(S.addDays(from, 32).slice(0, 8) + '01', -1); } // mês atual
    if (!from || !to) throw httpError(400, 'Informe o início e o fim do intervalo.');
    if (to < from) throw httpError(400, 'O fim do intervalo precisa ser depois do início.');
    if (S.daysBetween(from, to) > MAX_RANGE_DAYS) throw httpError(400, `Intervalo grande demais (máximo ${MAX_RANGE_DAYS} dias).`);
    const quick = QUICK.includes(req.query.quick) ? req.query.quick : null;
    const status = STATUS.includes(req.query.status) ? req.query.status : null;
    const kind = KINDS.includes(req.query.kind) ? req.query.kind : null;
    const all = data().projects.filter((p) => !p.cancelled);
    const projects = liveProjects(req.query);
    // Lembretes: os do(s) projeto(s) filtrado(s); sem filtro de projeto/responsável entram também os sem projeto. reminders=0 = só prazos.
    const filtered = !!(str(req.query.project, 40) || str(req.query.person, 40));
    const rem = req.query.reminders === '0' ? [] : R.reminderItems(data(), { from, to, projectIds: filtered ? new Set(projects.map((p) => p.id)) : null });
    const items = S.filterItems([...itemsOf(projects, today), ...rem], { from, to, quick, status, kind, hideDone: req.query.hideDone === '1', today });
    const used = new Set(all.flatMap((p) => [p.coordinatorId, p.analystId]).filter(Boolean));
    res.json({
      today, from, to, warnDays: warnDays(), items,
      projects: all.map((p) => ({ id: p.id, name: p.name, ...S.scheduleIdentity(p), hasSchedule: (p.milestones || []).length > 0 }))
        .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')),
      people: data().coordinators.filter((c) => used.has(c.id)).map((c) => ({ id: c.id, name: c.name })),
    });
  });

  // Próximos prazos (atrasados + os que vencem em até N dias) e o resumo da Visão Geral — do mesmo cálculo.
  app.get('/api/schedule/upcoming', (req, res) => {
    const today = S.todayStr();
    const days = Math.min(Math.max(Number.parseInt(req.query.days, 10) || 30, 1), 366);
    const items = itemsOf(liveProjects(req.query), today);
    res.json({ today, days, items: S.upcoming(items, today, days), summary: S.scheduleSummary(items, today) });
  });

  // Cor do projeto nas visões de cronograma (chave da paleta; null = automática). Só aparência: vale também para projeto cancelado.
  app.put('/api/projects/:id/schedule-color', (req, res) => {
    const p = getProject(req.params.id);
    const c = req.body?.color || null;
    if (c && !S.SCHEDULE_COLORS.includes(c)) throw httpError(400, 'Cor inválida.');
    p.scheduleColor = c;
    store.save();
    res.json(publicProject(p));
  });
}

module.exports = { mount, MAX_RANGE_DAYS };
