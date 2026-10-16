// Analista de Migração: sempre o dono do app (fixo, não é escolhido no projeto). Só informativo nas telas e disponível como variável
// ({{project.migration_analyst}}) para e-mails e documentos. O analista escolhido no projeto (analystId) é o Analista de Implantação.
const MIGRATION_ANALYST = Object.freeze({ name: 'Elton Alves', role: 'Analista de Migração' }); // scan-secrets: allow

module.exports = { MIGRATION_ANALYST };
