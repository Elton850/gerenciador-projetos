// Hub de Dados — acesso ao banco compartilhado (Postgres/Supabase) com o driver `pg` (JavaScript puro, no próprio processo:
// não há biblioteca nativa a isolar como no SQL Server). Uma conexão por operação, sempre fechada no fim.
// Escrita: só a sincronização da planilha (upsert numa transação única; “Simular” faz tudo e desfaz). Leitura: projetos, tarefas, histórico.
// A connection string chega aqui já aberta (DPAPI) e nunca é registrada, devolvida à tela nem incluída em mensagens.
const fs = require('fs');
const path = require('path');
const tls = require('tls');
const { Client } = require('pg');
const S = require('./hub-sheet');

const CONNECT_TIMEOUT_MS = 15000;
const STATEMENT_TIMEOUT_MS = 120000;
// Colunas que este app grava além das do script original (aditivas; o outro script não as toca).
const EXTRA_COLS_PROJETOS = ['pasta_projeto_url'];
const SCHEMA_UPGRADE = 'alter table public.projetos add column if not exists pasta_projeto_url text';
// TLS com verificação completa (cadeia + nome do servidor). O Supabase assina o pooler com uma CA própria (“Supabase Root 2021 CA”,
// pública, a mesma do botão “Download certificate” do painel): ela é somada às CAs padrão — nunca se desliga a verificação.
const SUPABASE_CA = fs.readFileSync(path.join(__dirname, 'certs', 'supabase-root-2021-ca.crt'), 'utf8');
const TRUSTED_CAS = [...tls.rootCertificates, SUPABASE_CA];

// Host para exibir (sem usuário/senha). Recusa o que não for uma URL postgres.
function parseUrl(url) {
  let u;
  try { u = new URL(String(url || '').trim()); } catch { return null; }
  if (!/^postgres(ql)?:$/.test(u.protocol) || !u.hostname) return null;
  return { host: u.hostname, port: u.port || '5432', database: decodeURIComponent(u.pathname.replace(/^\//, '')) || 'postgres' };
}

// sslmode/sslrootcert da URL são ignorados: o TLS verificado é sempre imposto aqui.
function connect(url) {
  const u = new URL(String(url).trim());
  for (const k of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'ssl']) u.searchParams.delete(k);
  const c = new Client({ connectionString: u.toString(), ssl: { ca: TRUSTED_CAS, servername: u.hostname }, connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS, query_timeout: STATEMENT_TIMEOUT_MS + 5000, application_name: 'gerenciador-projetos' });
  c.on('error', () => { /* conexão caiu depois de usada: a operação em curso já recebe o erro */ });
  return c;
}
async function withClient(url, fn) {
  const c = connect(url);
  try { await c.connect(); } catch (e) { await c.end().catch(() => {}); throw friendly(e); }
  try { return await fn(c); } catch (e) { throw friendly(e); } finally { await c.end().catch(() => {}); }
}

// Mensagem útil e sem segredo (a URL nunca entra).
function friendly(e) {
  if (e && e.status) return e;
  const code = e?.code;
  let msg;
  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code) || /timeout/i.test(e?.message || '')) {
    msg = `Não foi possível conectar ao banco do Hub (${code || 'tempo esgotado'}). Confira a internet/VPN e a connection string (use a do “Session pooler”).`;
  } else if (/certificate|self[- ]signed|altname|CERT_|UNABLE_TO_VERIFY/i.test(`${code || ''} ${e?.message || ''}`)) {
    msg = `O certificado TLS do servidor do Hub não foi reconhecido (${code || 'certificado'}); a conexão foi recusada por segurança. Confira se o host é o do Supabase.`;
  } else if (code === '28P01' || code === '28000') msg = 'O banco do Hub recusou o usuário/senha da connection string. Cadastre-a novamente.';
  else if (code === '3D000') msg = 'O banco informado na connection string não existe.';
  else if (code === '42P01') msg = 'As tabelas do Hub (projetos, tarefas, marcos_projeto) não existem neste banco. Rode o schema do Hub (docs/HUB-DADOS-schema.sql) no banco.';
  else if (code === '42501') msg = 'O usuário da connection string não tem permissão para esta operação no banco do Hub.';
  else msg = `Erro no banco do Hub: ${(e?.message || String(e)).slice(0, 300)}`;
  return Object.assign(new Error(msg), { status: 502, code: 'HUB_DB' });
}

const q = (n) => `"${String(n).replace(/"/g, '""')}"`;

// Upsert por staging: as linhas vão como UM parâmetro JSON (json_populate_recordset), sem COPY nem SQL montado com valores.
// Só linhas que mudaram são atualizadas (updated_at só anda quando o dado muda) — mesma regra do script original.
async function upsert(c, tabela, colunas, linhas, conflito) {
  const stg = `_stg_${tabela}`;
  const cols = colunas.map(q).join(', ');
  await c.query(`create temp table ${q(stg)} on commit drop as select ${cols} from public.${q(tabela)} with no data`);
  await c.query(`insert into ${q(stg)} (${cols}) select ${cols} from json_populate_recordset(null::${q(stg)}, $1::json)`, [JSON.stringify(linhas.map((l) => Object.fromEntries(colunas.map((k) => [k, l[k] ?? null]))))]);
  const mud = colunas.filter((k) => !conflito.includes(k));
  const r = await c.query(`with up as (
      insert into public.${q(tabela)} (${cols}) select ${cols} from ${q(stg)}
      on conflict (${conflito.map(q).join(', ')}) do update set ${mud.map((k) => `${q(k)} = excluded.${q(k)}`).join(', ')}
      where (${mud.map((k) => `${q(tabela)}.${q(k)}`).join(', ')}) is distinct from (${mud.map((k) => `excluded.${q(k)}`).join(', ')})
      returning (xmax = 0) as inserido)
    select count(*) filter (where inserido)::int as ins, count(*) filter (where not inserido)::int as upd from up`);
  const { ins, upd } = r.rows[0];
  return { lidos: linhas.length, inseridos: ins, atualizados: upd, inalterados: linhas.length - ins - upd, removidos: 0 };
}

// Planilha lida (src/hub-sheet.js) → banco, numa transação. dryRun = executa tudo e desfaz (nada fica gravado, nem o histórico).
// Nunca apaga linhas do banco (o banco é compartilhado: uma planilha antiga não pode remover o que outro analista gravou).
async function syncSheet(url, dados, { dryRun = false, usuario = null, arquivo = null, sha256 = null } = {}) {
  return withClient(url, async (c) => {
    const avisos = [...dados.avisos];
    await c.query('begin');
    try {
      await c.query(SCHEMA_UPGRADE); // aditivo e idempotente: coluna do link da pasta
      const resumo = {};
      resumo.projetos = await upsert(c, 'projetos', [...S.COLS_PROJETOS, ...EXTRA_COLS_PROJETOS], dados.projetos, ['nome']);
      const ids = Object.fromEntries((await c.query('select nome, id::text as id from public.projetos')).rows.map((r) => [r.nome, r.id]));
      const abaParaId = new Map(dados.projetos.filter((p) => p.aba_planilha).map((p) => [p.aba_planilha, ids[p.nome] ?? null]));
      const tarefas = dados.tarefas.map((t) => ({ ...t, projeto_id: abaParaId.get(t.aba) ?? null }));
      const marcos = dados.marcos.map((m) => ({ ...m, projeto_id: null }));
      S.resolverMarcos(marcos, ids, { add: (m) => avisos.push(m) });
      resumo.tarefas = await upsert(c, 'tarefas', S.COLS_TAREFAS, tarefas, ['aba', 'codigo']);
      resumo.marcos_projeto = await upsert(c, 'marcos_projeto', S.COLS_MARCOS, marcos, ['nome_projeto']);
      if (!dryRun) {
        await c.query('insert into public.sincronizacoes (executado_por, arquivo, sha256, resumo, avisos) values ($1, $2, $3, $4::jsonb, $5::jsonb)',
          [usuario, arquivo, sha256, JSON.stringify(resumo), JSON.stringify(avisos)]);
      }
      await c.query(dryRun ? 'rollback' : 'commit');
      return { ok: true, dryRun, resumo, avisos };
    } catch (e) {
      await c.query('rollback').catch(() => {});
      throw e;
    }
  });
}

// Projetos do banco com o marco (aba MARCOS) e a contagem de tarefas. to_jsonb: lê também colunas que um banco antigo ainda não tenha
// (pasta_projeto_url vem null) e devolve datas como texto 'AAAA-MM-DD', sem conversão de fuso.
async function listProjects(url) {
  return withClient(url, async (c) => {
    const r = await c.query(`select to_jsonb(p) as p, to_jsonb(m) as m, coalesce(t.total, 0)::int as total, coalesce(t.concluidas, 0)::int as concluidas
      from public.projetos p
      left join lateral (select * from public.marcos_projeto x where x.projeto_id = p.id order by x.updated_at desc limit 1) m on true
      left join lateral (select count(*) as total, count(*) filter (where status = 'Concluída') as concluidas from public.tarefas where projeto_id = p.id) t on true
      order by p.nome`);
    return r.rows.map(rowToProject);
  });
}

function rowToProject({ p, m, total, concluidas }) {
  const stamps = [p.updated_at, m?.updated_at].filter(Boolean).map((x) => new Date(x).toISOString()).sort();
  return {
    hubId: String(p.id), nome: p.nome, coordenador: p.coordenador ?? null, analista: p.analista ?? null, status: p.status_projeto ?? null, segmento: p.segmento ?? null,
    estado: p.estado ?? null, complexidade: p.complexidade ?? null, ambiente: p.ambiente ?? null, dataRepasse: p.data_repasse ?? null, cronograma: p.cronograma ?? null,
    desenvolveScript: p.desenvolve_script ?? null, sistemaOrigem: p.sistema_origem ?? null, sistemaDestino: p.sistema_destino ?? null,
    pasta: p.pasta_projeto ?? null, pastaUrl: p.pasta_projeto_url ?? null, aba: p.aba_planilha ?? null,
    marcos: m ? { responsavel: m.responsavel ?? null, depara: m.data_entrega_depara ?? null, hmg: m.carga_hmg ?? null, hmg2: m.carga_hmg_2 ?? null, prd: m.carga_prd ?? null, observacao: m.observacao ?? null } : null,
    tarefas: { total, concluidas, percentual: total ? Math.round((concluidas / total) * 100) : null },
    updatedAt: stamps[stamps.length - 1] || null,
  };
}

// Tarefas de um projeto do banco (só leitura no app), na ordem da aba.
async function projectTasks(url, hubId) {
  return withClient(url, async (c) => {
    const r = await c.query('select to_jsonb(t) as t from public.tarefas t where t.projeto_id = $1::bigint order by t.ordem limit 3000', [String(hubId)]);
    return r.rows.map(({ t }) => ({ codigo: t.codigo, titulo: t.titulo, status: t.status ?? null, prioridade: t.prioridade ?? null, recurso: t.recurso ?? null,
      inicio: t.data_inicio ?? null, termino: t.data_termino ?? null, marco: t.marco ?? null, observacoes: t.observacoes ?? null,
      status2: t.status_2 ?? null, inicio2: t.data_inicio_2 ?? null, termino2: t.data_termino_2 ?? null }));
  });
}

async function history(url, limit = 20) {
  return withClient(url, async (c) => {
    const r = await c.query(`select id::text as id, executado_em, executado_por, arquivo, resumo, jsonb_array_length(avisos)::int as avisos
      from public.sincronizacoes order by executado_em desc, id desc limit $1`, [Math.min(100, Math.max(1, Number(limit) || 20))]);
    return r.rows.map((x) => ({ id: x.id, em: new Date(x.executado_em).toISOString(), por: x.executado_por, arquivo: x.arquivo, resumo: x.resumo, avisos: x.avisos }));
  });
}

// Teste de conexão: identificação + se as tabelas do Hub existem (nada é alterado).
async function testConnection(url) {
  return withClient(url, async (c) => {
    const r = await c.query(`select current_user as usuario, current_database() as banco, split_part(version(), ' on ', 1) as versao,
      to_regclass('public.projetos') is not null as projetos, to_regclass('public.tarefas') is not null as tarefas,
      to_regclass('public.marcos_projeto') is not null as marcos, to_regclass('public.sincronizacoes') is not null as sincronizacoes`);
    const x = r.rows[0];
    return { ok: true, user: x.usuario, database: x.banco, version: x.versao, tables: { projetos: x.projetos, tarefas: x.tarefas, marcos_projeto: x.marcos, sincronizacoes: x.sincronizacoes } };
  });
}

module.exports = { parseUrl, syncSheet, listProjects, projectTasks, history, testConnection, friendly, rowToProject };
