## Rota de contexto (ler antes de tudo)

Vault Obsidian: `C:\Vault\Gerenciador de Projetos\Apps\GerenciadorProjetos`. Papéis: **Obsidian** = arquitetura, regras de negócio e decisões; **graphify** = navegação técnica e dependências do código; **código-fonte** = fonte final da implementação.

1. Ler só `99-Claude/context.md` e `99-Claude/task-routing.md` do Vault.
2. Pela rota, achar o domínio e os documentos pertinentes (não abrir docs "por segurança").
3. Localizar módulos e dependências com `graphify query` / `path` / `explain` (quando `graphify-out/graph.json` existir), em vez de Grep amplo.
4. Ler só as notas do Obsidian indicadas pela rota; o wiki/relatório do graphify não substitui o Vault.
5. Abrir só os arquivos de código necessários.
6. Depois de mudar código: `graphify update .` e o checklist "Ao fechar uma tarefa" de `99-Claude/vault-maintenance.md` (atualizar só os docs afetados).

Nunca carregar o grafo inteiro, `GRAPH_REPORT.md` ou documentos extensos sem necessidade.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
