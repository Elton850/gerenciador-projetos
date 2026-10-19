// Ferramentas Auxiliares — registro único. Para adicionar uma ferramenta:
//   1) crie src/tools/<id>/api.js com `mount(app, deps, base)` (rotas sob /api/tools/<id>);
//   2) acrescente uma entrada aqui;
//   3) crie public/tool-<id>.js registrando a tela em `GP_TOOLS['<id>']` e inclua o script no index.html.
// Nada mais do app precisa mudar (menu, rota e lista de cards vêm deste registro). Documentação: Vault 01-Modules/tools/.
//
// `permissions`: o que a ferramenta exige para rodar. O app não tem perfis de usuário (é local e mono-usuário); a trava real
// é aplicada pela própria ferramenta no servidor (ex.: só conexões cadastradas + permissões verificadas no SQL Server).
const TOOLS = [
  {
    id: 'bt-importer',
    name: 'Importador BT → SQL',
    description: 'Importa arquivos .bt (um, vários ou uma pasta) para bancos do SQL Server usando as conexões cadastradas.',
    icon: 'upload',
    permissions: ['Conexão cadastrada', 'SQL: CREATE ANY DATABASE (banco novo)', 'SQL: CREATE TABLE, INSERT e ALTER no schema dbo'],
    api: () => require('./bt-importer/api'),
    ensure: (data) => require('./bt-importer/plan').ensureData(data), // dados persistidos (chamado na carga, applyDefaults)
  },
];

const publicTools = () => TOOLS.map(({ id, name, description, icon, permissions }) => ({ id, name, description, icon, permissions }));

module.exports = { TOOLS, publicTools };
