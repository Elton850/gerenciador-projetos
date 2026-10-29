-- =====================================================================
-- HUB DE DADOS · Gerenciamento de Projetos  —  schema para Supabase
-- Rode no SQL Editor do Supabase (pode rodar de novo: é idempotente).
--
-- Origem: planilha "GERENCIAMENTO DE PROJETOS - HUB DE DADOS.xlsx"
--   aba GERENCIAMENTO          -> public.projetos
--   aba MARCOS DOS PROJETOS    -> public.marcos_projeto
--   ~65 abas, uma por projeto  -> public.tarefas  (coluna "aba" = nome da aba)
--
-- CHAVES DE UPSERT (usadas pelo script Python em ON CONFLICT):
--   projetos       -> nome                 (NOME DO PROJETO)
--   tarefas        -> (aba, codigo)        (aba + número da tarefa, ex.: "2.1")
--   marcos_projeto -> nome_projeto         (NOME DO PROJETO na aba de marcos)
-- Todas têm também um "id" bigint (PK técnica) para o app usar nas telas/FKs.
-- =====================================================================

-- ---------- helper: updated_at automático ----------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------- PROJETOS --------------------------------------------------
create table if not exists public.projetos (
  id                bigint generated always as identity primary key,
  nome              text        not null,                 -- NOME DO PROJETO
  complexidade      smallint    check (complexidade between 1 and 5),
  estado            text,                                  -- UF/região como na planilha (CE, SP, "CE/SP"...)
  coordenador       text,
  data_repasse      date,                                  -- DATA REPASSE
  ambiente          text        check (ambiente in ('Sem Ambiente','Cloud TOTVS','On Premises')),  -- coluna "Cloud"
  cronograma        text,                                  -- texto livre (na planilha é usado como observação)
  desenvolve_script boolean,                               -- DESENVOLVIMENTO DE SCRIPT? (SIM/NÃO)
  sistema_origem    text,
  sistema_destino   text,
  analista          text,
  pasta_projeto     text,                                  -- LINK DA PASTA DO PROJETO (link ou código da pasta)
  aba_projeto       text,                                  -- ABA DO PROJETO, como digitado na planilha
  aba_planilha      text,                                  -- nome REAL da aba de tarefas (resolvido pelo script)
  segmento          text        check (segmento in ('FOLHA','EDUCACIONAL','BACK OFFICE','REVITALIZAÇÃO','ATUALIZAÇÃO')),
  status_projeto    text        check (status_projeto in ('SUSPENSO','ATIVO','EM PRODUÇÃO','CANCELADO','POR INICIAR','CONCLUÍDO')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint projetos_nome_key unique (nome)
);
comment on table  public.projetos is 'Aba GERENCIAMENTO. Uma linha por projeto. Upsert por nome.';
comment on column public.projetos.aba_planilha is 'Nome real da aba de tarefas (<=31 chars). Liga com tarefas.aba.';

create index if not exists projetos_status_idx  on public.projetos (status_projeto);
create index if not exists projetos_analista_idx on public.projetos (analista);

drop trigger if exists trg_projetos_updated_at on public.projetos;
create trigger trg_projetos_updated_at before update on public.projetos
  for each row execute function public.set_updated_at();

-- ---------- TAREFAS ---------------------------------------------------
create table if not exists public.tarefas (
  id               bigint generated always as identity primary key,
  aba              text        not null,                   -- nome da aba na planilha (identifica o projeto na planilha)
  codigo           text        not null,                   -- "0", "2.1", "15.10"... (repetido na mesma aba vira "16#2")
  projeto_id       bigint      references public.projetos (id) on delete set null,
  ordem            integer     not null,                   -- posição da linha na aba (para ordenar)
  titulo           text        not null,                   -- texto após o número: "CREATE DATA BASE - SERVIDOR TOTVS NE"
  prioridade       text        check (prioridade in ('BAIXA','MÉDIA','ALTA')),  -- "Prioridade" / "Impacto"
  recurso          text,
  status           text        check (status in ('Não iniciada','Em execução','Bloqueada','Concluída','Problemas')),
  data_inicio      date,
  data_termino     date,
  marco            text,                                   -- CARGA 1 HMG, CARGA 2 PRD...
  link_tarefa      text,
  smartcliente_hmg text,
  smartcliente_prd text,
  observacoes      text,
  -- 2ª trilha: só existe nas abas FMSA (PRIME x RH3) e GRUPO NETO (Questor x IOB).
  -- A 1ª trilha fica em status/data_inicio/data_termino.
  status_2         text        check (status_2 in ('Não iniciada','Em execução','Bloqueada','Concluída','Problemas')),
  data_inicio_2    date,
  data_termino_2   date,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint tarefas_aba_codigo_key unique (aba, codigo)
);
comment on table public.tarefas is 'Linhas das abas de cada projeto. Upsert por (aba, codigo).';

create index if not exists tarefas_projeto_idx on public.tarefas (projeto_id, ordem);
create index if not exists tarefas_status_idx  on public.tarefas (status);
create index if not exists tarefas_recurso_idx on public.tarefas (recurso);

drop trigger if exists trg_tarefas_updated_at on public.tarefas;
create trigger trg_tarefas_updated_at before update on public.tarefas
  for each row execute function public.set_updated_at();

-- ---------- MARCOS ----------------------------------------------------
create table if not exists public.marcos_projeto (
  id                bigint generated always as identity primary key,
  nome_projeto      text        not null,                  -- NOME DO PROJETO como está na aba de marcos
  projeto_id        bigint      references public.projetos (id) on delete set null,
  responsavel       text,
  data_entrega_depara date,                                -- DATA ENTREGA DE/PARA
  carga_hmg         date,                                  -- CARGA EM HMG
  carga_hmg_2       date,                                  -- CARGA EM HMG 2
  carga_prd         date,                                  -- CARGA EM PRD
  observacao        text,                                  -- valor original quando a célula não é uma data (ex.: "08/12/2025-10/12/2025")
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint marcos_projeto_nome_key unique (nome_projeto)
);
comment on table public.marcos_projeto is 'Aba MARCOS DOS PROJETOS. Upsert por nome_projeto; projeto_id é resolvido por nome (pode ficar nulo).';

create index if not exists marcos_projeto_projeto_idx on public.marcos_projeto (projeto_id);

drop trigger if exists trg_marcos_updated_at on public.marcos_projeto;
create trigger trg_marcos_updated_at before update on public.marcos_projeto
  for each row execute function public.set_updated_at();

-- ---------- LOG DE SINCRONIZAÇÕES ------------------------------------
create table if not exists public.sincronizacoes (
  id           bigint generated always as identity primary key,
  executado_em timestamptz not null default now(),
  executado_por text,
  arquivo      text,
  sha256       text,                                       -- hash do arquivo (detecta reenvio do mesmo arquivo)
  resumo       jsonb not null default '{}'::jsonb,         -- inseridos/atualizados/inalterados/removidos por tabela
  avisos       jsonb not null default '[]'::jsonb
);
comment on table public.sincronizacoes is 'Histórico de cada upload/sincronização da planilha.';
create index if not exists sincronizacoes_em_idx on public.sincronizacoes (executado_em desc);

-- ---------- VIEWS (o "PERCENTUAL DO EXECUTADO" da planilha vira cálculo) ----
create or replace view public.vw_projetos_resumo
with (security_invoker = true) as
select
  p.*,
  coalesce(t.total, 0)      as total_tarefas,
  coalesce(t.concluidas, 0) as tarefas_concluidas,
  coalesce(t.em_execucao, 0) as tarefas_em_execucao,
  case when coalesce(t.total, 0) = 0 then null
       else round(t.concluidas::numeric / t.total, 4) end as percentual_executado,
  m.data_entrega_depara, m.carga_hmg, m.carga_hmg_2, m.carga_prd
from public.projetos p
left join lateral (
  select count(*)                                  as total,
         count(*) filter (where status = 'Concluída')    as concluidas,
         count(*) filter (where status = 'Em execução')  as em_execucao
  from public.tarefas where projeto_id = p.id
) t on true
left join public.marcos_projeto m on m.projeto_id = p.id;

-- ---------- RLS --------------------------------------------------------
-- Tabelas no schema public ficam abertas para a anon key se o RLS estiver desligado.
-- Aqui: RLS ligado, usuários LOGADOS (authenticated) só LEEM.
-- A escrita é feita pelo script de sincronização (service_role / conexão postgres), que ignora o RLS.
-- Se o app precisar editar (ex.: mudar status de tarefa), adicione policies de insert/update.
alter table public.projetos       enable row level security;
alter table public.tarefas        enable row level security;
alter table public.marcos_projeto enable row level security;
alter table public.sincronizacoes enable row level security;

do $$
declare t text;
begin
  foreach t in array array['projetos','tarefas','marcos_projeto','sincronizacoes'] loop
    execute format('drop policy if exists "leitura autenticados" on public.%I', t);
    execute format('create policy "leitura autenticados" on public.%I for select to authenticated using (true)', t);
  end loop;
end $$;

-- Permissões de leitura para o app (a escrita continua só pelo script de sincronização).
grant usage on schema public to authenticated;
grant select on public.projetos, public.tarefas, public.marcos_projeto,
                public.sincronizacoes, public.vw_projetos_resumo to authenticated;

-- ---------- Gerenciador de Projetos (aditivo) ------------------------------
-- Link da célula "LINK DA PASTA DO PROJETO" (o script Python grava só o texto da célula em pasta_projeto).
-- O app cria esta coluna sozinho na primeira sincronização (mesma transação); rodar aqui também é seguro.
alter table public.projetos add column if not exists pasta_projeto_url text;
