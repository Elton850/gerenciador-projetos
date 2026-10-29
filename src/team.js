// Analista de Migração: o dono do app é o padrão (projetos sem analista próprio). Cada projeto pode ter o seu (project.migrationAnalyst,
// texto; vem do Hub de Dados — coluna ANALISTA da planilha — ou do cadastro do projeto). Disponível como {{project.migration_analyst}}
// para e-mails e documentos. O analista escolhido no projeto (analystId) é o Analista de Implantação.
const MIGRATION_ANALYST = Object.freeze({ name: 'Elton Alves', role: 'Analista de Migração' }); // scan-secrets: allow

// Nome do analista de migração do projeto (o padrão quando o projeto não tem um).
const migrationAnalystOf = (p) => (p && typeof p.migrationAnalyst === 'string' && p.migrationAnalyst.trim()) || MIGRATION_ANALYST.name;

module.exports = { MIGRATION_ANALYST, migrationAnalystOf };
