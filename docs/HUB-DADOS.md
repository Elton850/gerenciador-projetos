# Hub de Dados (banco compartilhado dos projetos)

Menu **Hub de Dados (banco)**. Liga o app a um banco Postgres compartilhado (Supabase) que guarda os dados da planilha
**GERENCIAMENTO DE PROJETOS - HUB DE DADOS** — o mesmo banco usado pelos outros analistas.

## Onde fica cada coisa
| Canal | O que leva |
|---|---|
| Pasta de publicação no Drive | versões do aplicativo e configurações compartilháveis (inalterado — ADR-016) |
| Banco do Hub | só o que está na planilha: projetos (aba GERENCIAMENTO), marcos (MARCOS DOS PROJETOS), tarefas (uma aba por projeto) e o histórico de sincronizações |
| Esta máquina (`data\`) | todo o resto: conexões e senhas (DPAPI), controle de horas, ciclos/checklists, evidências, bases, observações, e a própria connection string do Hub (DPAPI) |

Nada local é enviado ao banco. O app só **lê** do banco, exceto na sincronização da planilha.

## Configurar (uma vez por máquina)
1. Supabase → **Connect** → *Session pooler* (porta 5432) → copie a connection string
   (`postgresql://postgres.<projeto>:<senha>@aws-…pooler.supabase.com:5432/postgres`; senha com `@ # / : %` codificada na URL).
2. Hub de Dados → **Configurar** → cole → *Salvar e testar*. O app conecta antes de salvar e confere as tabelas.
   A string fica protegida pela DPAPI em `settings.hub.passwordEnc` (o backup a trata como as senhas das conexões) e nunca volta para a tela.
3. TLS sempre verificado (cadeia + nome do servidor). O Supabase usa a CA própria *Supabase Root 2021 CA*, empacotada em
   `src/certs/supabase-root-2021-ca.crt` (SHA-256 `80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`;
   é o mesmo arquivo do botão *Download certificate* do painel do Supabase). Ela é somada às CAs padrão; a verificação nunca é desligada.

## Planilha → banco
Hub de Dados → *Planilha → banco*: escolha o .xlsx baixado do Google Sheets (do jeito que ele está).
- **Validar**: só lê a planilha (sem banco) e mostra contagens e avisos (valores fora das listas viram vazio).
- **Simular**: faz tudo no banco numa transação e desfaz (nada fica gravado).
- **Sincronizar**: grava (upsert: novo é incluído, mudado é atualizado, igual não é tocado) e registra em `sincronizacoes`. **Nunca apaga**
  linhas do banco (uma planilha antiga não remove o que outro analista gravou).

A leitura (`src/hub-sheet.js`) é a mesma do script `sincronizar_planilha.py` usado pelos outros analistas (mesmas chaves, normalização,
mapeamento projeto ↔ aba e avisos), para que as duas ferramentas gravem os mesmos valores. Única diferença: o app grava também
`projetos.pasta_projeto_url` (o link da célula da pasta), coluna aditiva criada na própria transação (ver `HUB-DADOS-schema.sql`).

## Projetos do banco × projetos desta máquina
- Projeto no banco e não nesta máquina = **offline**: grupo “No banco · não baixados” na barra lateral (apagado, ícone de nuvem).
  Ao abrir, o app mostra os dados e as tarefas do banco e pergunta se quer **baixar**.
- **Baixar** cria o projeto aqui (ciclo do tipo, como no cadastro) e o vincula (`project.hub`). Campos que vêm do banco:
  coordenador (pessoa existente pelo nome; senão é cadastrada), analista de migração, sistema de origem (cadastrado se faltar),
  tipo (pelo segmento, só se vazio; nunca cria tipo), link da pasta no Drive (só se a pasta raiz for do Drive ou estiver vazia) e os
  marcos (Entrega do DE/PARA, Carga em HMG, HMG 2, PRD → prazos do cronograma com `milestone.hub`). Status CANCELADO → baixa cancelado;
  CONCLUÍDO/EM PRODUÇÃO → marcos já entregues.
- **Vincular** um projeto local existente ao do banco (sugerido quando o nome é igual).
- **Atualizações**: a lista é relida ao abrir o app e a cada 5 min (cache de 3 min no servidor). Se o banco mudou desde a última vez,
  os campos acima são reaplicados sozinhos (auditoria `hub-atualizado`); prazo já entregue e projeto cancelado não têm prazos alterados.
  O resto do projeto nunca é tocado. *Atualizar do banco* força; *Desvincular* para de receber (mantém o que já veio).
- **Tarefas da planilha**: card só leitura no projeto (e na página offline), lidas do banco ao abrir.

## Analista de migração por projeto
`project.migrationAnalyst` (texto). Vazio = o padrão do app (`src/team.js`). Vem da coluna ANALISTA da planilha nos projetos do Hub e
pode ser editado no cadastro. Usado na tela do projeto, em `{{project.migration_analyst}}` e nos documentos gerados.
