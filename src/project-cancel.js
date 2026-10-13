// Projeto cancelado: um MARCADOR no projeto (project.cancelled), nunca uma alteração dos dados dele.
//  - Cancelar não apaga nem muda etapa, checklists, prazos, evidências ou ciclo; só guarda quando/quem/motivo e um resumo
//    (etapa e % no momento) para mostrar na tela.
//  - Enquanto cancelado, o ANDAMENTO fica congelado no servidor (etapa, checklists, ciclo, prazos, evidências): é isso que
//    garante que, ao descancelar, o projeto volte exatamente ao último estado salvo. Cadastro, observações, contatos, bases,
//    horas etc. continuam editáveis.
//  - Cancelado sai dos alertas e das contagens de ativos (cronograma vira 'cancelled', lembretes ficam de fora); descancelar
//    traz tudo de volta.
const { httpError } = require('./util');

// Rotas (relativas a /api/projects/:id) que mudam o andamento: bloqueadas com o projeto cancelado (só métodos que alteram).
const FROZEN_RE = /^\/(step|checklists|cycle|milestones|evidences)(\/|$)/;

function frozen(project, method, subPath) {
  return !!project?.cancelled && method !== 'GET' && method !== 'HEAD' && FROZEN_RE.test(subPath);
}

const cancelledError = () => httpError(409, 'Este projeto está cancelado: o andamento (etapa, checklists, ciclo e prazos) fica congelado. Descancele o projeto para alterar.', { code: 'PROJECT_CANCELLED' });

function cancelProject(p, { reason, by, now = new Date().toISOString(), stageName = null, percent = null } = {}) {
  if (p.cancelled) throw httpError(409, 'O projeto já está cancelado.', { code: 'PROJECT_CANCELLED' });
  p.cancelled = { at: now, by: by || null, reason: String(reason ?? '').trim().slice(0, 500), stageName, percent };
  return p.cancelled;
}

function uncancelProject(p) {
  if (!p.cancelled) throw httpError(400, 'O projeto não está cancelado.');
  const was = p.cancelled;
  p.cancelled = null;
  return was;
}

module.exports = { FROZEN_RE, frozen, cancelledError, cancelProject, uncancelProject };
