// Hub de Dados — leitura da planilha "GERENCIAMENTO DE PROJETOS - HUB DE DADOS.xlsx" no formato em que ela está.
//   aba GERENCIAMENTO        → projetos        (chave: nome)
//   aba MARCOS DOS PROJETOS  → marcos_projeto  (chave: nome_projeto)
//   demais abas (por projeto) → tarefas        (chave: aba + codigo)
// Porta fiel de scripts/sync-planilha/sincronizar_planilha.py (usado por outro analista no MESMO banco): as colunas
// compartilhadas precisam sair com os mesmos valores, senão cada sincronização “desfaria” a do outro. Única coluna a mais:
// pasta_projeto_url (o link da célula “LINK DA PASTA DO PROJETO”, que o script Python não lê). Sem banco e sem HTTP aqui.
const ExcelJS = require('exceljs');

const ABA_PROJETOS = 'GERENCIAMENTO';
const ABA_MARCOS = 'MARCOS DOS PROJETOS';
const PREFIXO_ABA_MODELO = 'MODELO'; // abas "MODELO - ..." são modelos e ficam de fora

// Projeto (como em GERENCIAMENTO) → aba de tarefas, quando nem a fórmula de % nem “ABA DO PROJETO” apontam a aba certa.
const MAPEAMENTO_MANUAL_ABAS = {
  'ITAUEIRA - FOLHA': 'ITAUEIRA - F - FORTES - RM - RE',
  'SP SERVICOS - FOLHA': 'SP SERVICOS - F - RM - RENO',
  'SESC REGIONAL - ESPIRITO SANTO': 'SESC ES - EDUCACIONAL - RM - EL',
  'FUNDAÇÃO MANUEL DA SILVA ALMEIDA - DP SMART': 'FMSA - F - PRIMERH3 - RM - RENO',
};
// Nome na aba MARCOS → nome em GERENCIAMENTO, quando divergem.
const ALIASES_MARCOS = { 'SESC REGIONAL 5 - MG': 'SESC REGIONAL 5 - MINAS GERAIS' };

const STATUS_TAREFA = ['Não iniciada', 'Em execução', 'Bloqueada', 'Concluída', 'Problemas'];
const PRIORIDADES = ['BAIXA', 'MÉDIA', 'ALTA'];
const AMBIENTES = ['Sem Ambiente', 'Cloud TOTVS', 'On Premises'];
const SEGMENTOS = ['FOLHA', 'EDUCACIONAL', 'BACK OFFICE', 'REVITALIZAÇÃO', 'ATUALIZAÇÃO'];
const STATUS_PROJETO = ['SUSPENSO', 'ATIVO', 'EM PRODUÇÃO', 'CANCELADO', 'POR INICIAR', 'CONCLUÍDO'];

const COLS_PROJETOS = ['nome', 'complexidade', 'estado', 'coordenador', 'data_repasse', 'ambiente', 'cronograma', 'desenvolve_script', 'sistema_origem',
  'sistema_destino', 'analista', 'pasta_projeto', 'aba_projeto', 'aba_planilha', 'segmento', 'status_projeto'];
const COLS_TAREFAS = ['aba', 'codigo', 'projeto_id', 'ordem', 'titulo', 'prioridade', 'recurso', 'status', 'data_inicio', 'data_termino', 'marco', 'link_tarefa',
  'smartcliente_hmg', 'smartcliente_prd', 'observacoes', 'status_2', 'data_inicio_2', 'data_termino_2'];
const COLS_MARCOS = ['nome_projeto', 'projeto_id', 'responsavel', 'data_entrega_depara', 'carga_hmg', 'carga_hmg_2', 'carga_prd', 'observacao'];

// ---------- Limpeza (mesmas regras do script Python) ----------
const semAcento = (s) => s.normalize('NFD').replace(/\p{Mn}/gu, '');
// Comparação: sem acento, maiúsculo, sem '/', espaços colapsados.
function norm(s) {
  if (s === null || s === undefined) return '';
  return semAcento(pyStr(s)).toUpperCase().replace(/\//g, '').replace(/\s+/g, ' ').trim();
}
const pad = (n, w = 2) => String(n).padStart(w, '0');
const isoDay = (d) => `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
// Texto como o Python escreveria (str(v)): True/False, data “AAAA-MM-DD HH:MM:SS”, número inteiro sem “.0”.
function pyStr(v) {
  if (v instanceof Date) return `${isoDay(v)} ${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}:${pad(v.getUTCSeconds())}`;
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  return String(v);
}
// Texto limpo (NFC, sem espaços nas pontas, sem espaço inquebrável); vazio vira null.
function txt(v) {
  if (v === null || v === undefined) return null;
  const s = pyStr(v).normalize('NFC').replace(/ /g, ' ').trim();
  return s || null;
}

class Avisos { constructor() { this.itens = []; } add(m) { this.itens.push(m); } }

// Casa o valor com a lista oficial (ignora caixa/acento). Desconhecido → null + aviso.
function canonico(valor, lista, onde, avisos) {
  const s = txt(valor);
  if (s === null) return null;
  const r = lista.find((x) => norm(x) === norm(s)) ?? null;
  if (r === null) avisos.add(`${onde}: valor '${s}' fora da lista permitida (${lista.join(', ')}) — gravado como vazio`);
  return r;
}

const RX_DATA_BR = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/;
function validYmd(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, d));
  return y >= 1 && t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
// Data 'AAAA-MM-DD' (dia civil da célula) ou null + aviso.
function data(v, onde, avisos) {
  if (v === null || v === undefined) return null;
  let d = null;
  if (v instanceof Date) d = Number.isNaN(v.getTime()) ? null : isoDay(v);
  else if (typeof v === 'string') {
    if (!v.trim()) return null;
    const m = v.match(RX_DATA_BR);
    if (m && validYmd(+m[3], +m[2], +m[1])) d = `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  }
  const y = d ? Number(d.slice(0, 4)) : 0;
  if (d === null || y < 1990 || y > 2100) { avisos.add(`${onde}: data inválida '${pyStr(v)}' — gravada como vazio`); return null; }
  return d;
}

function booleano(v, onde, avisos) {
  const s = txt(v);
  if (s === null) return null;
  const n = norm(s);
  if (n === 'SIM') return true;
  if (n === 'NAO') return false;
  avisos.add(`${onde}: '${s}' não é SIM/NÃO — gravado como vazio`);
  return null;
}

// Complexidade 1..5: int(float(v)) do Python (texto numérico aceito; o resto é inválido).
function complexidade(raw) {
  if (raw === null || raw === undefined) return { ok: true, v: null };
  let n;
  if (typeof raw === 'number' || typeof raw === 'boolean') n = Number(raw);
  else if (typeof raw === 'string' && raw.trim() && /^[\s+-]*[\d.eE+-]+\s*$/.test(raw)) n = Number(raw.trim());
  else n = NaN;
  if (!Number.isFinite(n)) return { ok: false };
  const i = Math.trunc(n);
  return i >= 1 && i <= 5 ? { ok: true, v: i } : { ok: false };
}

// ---------- Valor da célula como o openpyxl entrega (load_workbook sem data_only) ----------
// Fórmula → o texto "=FÓRMULA" · hyperlink → o texto exibido · rich text → texto corrido · erro → "#N/A" etc.
function cellRaw(cell) {
  if (!cell) return null;
  if (cell.type === ExcelJS.ValueType.Merge && cell.master && cell.master !== cell) return null; // openpyxl: só a célula mestre tem valor
  const v = cell.value;
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v !== 'object') return v === '' ? null : v;
  if ('formula' in v || 'sharedFormula' in v) { const f = cell.formula; return f ? `=${f}` : null; }
  if ('error' in v) return v.error;
  if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('') || null;
  if ('text' in v) return typeof v.text === 'object' && v.text && Array.isArray(v.text.richText) ? v.text.richText.map((t) => t.text).join('') : v.text;
  return null;
}
// Link da célula (hyperlink), ou o próprio texto quando ele já é uma URL.
function cellUrl(cell) {
  const v = cell?.value;
  const u = v && typeof v === 'object' && typeof v.hyperlink === 'string' ? v.hyperlink : typeof v === 'string' ? v : null;
  return u && /^https?:\/\/\S+$/i.test(u.trim()) ? u.trim() : null;
}

// Linhas da aba a partir da 2ª, como o openpyxl (iter_rows): cada linha tem largura = maior coluna da aba.
function sheetRows(ws) {
  let width = 0;
  ws.eachRow({ includeEmpty: true }, (row) => { width = Math.max(width, row.cellCount); });
  const out = [];
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    if (n < 2) return;
    const cells = [];
    for (let i = 1; i <= width; i++) cells.push(row.getCell(i));
    out.push({ n, cells, raw: cells.map(cellRaw) });
  });
  return { width, rows: out };
}
const headerOf = (ws) => { const r = ws.getRow(1); const out = []; for (let i = 1; i <= Math.max(r.cellCount, 1); i++) out.push(cellRaw(r.getCell(i))); return out; };

// Campo → índice da coluna pelo texto do cabeçalho (resiste a colunas reordenadas).
function indiceCabecalho(ws, obrigatorios) {
  const cab = new Map();
  headerOf(ws).forEach((v, i) => { if (v !== null && v !== undefined) cab.set(norm(v), i); });
  const idx = {};
  for (const [campo, titulo] of Object.entries(obrigatorios)) {
    const i = cab.get(norm(titulo));
    if (i === undefined) throw Object.assign(new Error(`Aba '${ws.name}': coluna '${titulo}' não encontrada no cabeçalho.`), { status: 400 });
    idx[campo] = i;
  }
  return idx;
}

const RX_FORMULA_ABA = /'((?:[^']|'')+)'!/;
function abaDaFormula(f) {
  if (typeof f === 'string' && f.startsWith('=')) { const m = f.match(RX_FORMULA_ABA); if (m) return m[1].replace(/''/g, "'"); }
  return null;
}

function lerProjetos(ws, avisos) {
  const idx = indiceCabecalho(ws, {
    nome: 'NOME DO PROJETO', complexidade: 'COMPLEXIDADE', estado: 'ESTADO', coordenador: 'COORDENADOR', data_repasse: 'DATA REPASSE', ambiente: 'Cloud',
    cronograma: 'CRONOGRAMA', desenvolve_script: 'DESENVOLVIMENTO DE SCRIPT?', sistema_origem: 'SISTEMA DE ORIGEM', sistema_destino: 'SISTEMA DE DESTINO',
    analista: 'ANALISTA', pasta_projeto: 'LINK DA PASTA DO PROJETO', percentual: 'PERCENTUAL DO EXECUTADO', aba_projeto: 'ABA DO PROJETO',
    segmento: 'SEGMENTO DO PROJETO', status_projeto: 'STATUS DO PROJETO',
  });
  let projetos = [];
  const vistos = new Map();
  for (const row of sheetRows(ws).rows) {
    const v = (campo) => row.raw[idx[campo]] ?? null;
    const nome = txt(v('nome'));
    if (!nome) continue;
    const onde = `GERENCIAMENTO linha ${row.n} (${nome})`;
    const c = complexidade(v('complexidade'));
    if (!c.ok) avisos.add(`${onde}: complexidade '${pyStr(v('complexidade'))}' inválida — gravada como vazio`);
    let estado = txt(v('estado'));
    if (estado === '--') estado = null;
    const p = {
      nome, complexidade: c.ok ? c.v : null, estado, coordenador: txt(v('coordenador')),
      data_repasse: data(v('data_repasse'), `${onde} DATA REPASSE`, avisos),
      ambiente: canonico(v('ambiente'), AMBIENTES, `${onde} Cloud`, avisos),
      cronograma: txt(v('cronograma')),
      desenvolve_script: booleano(v('desenvolve_script'), `${onde} DESENVOLVIMENTO DE SCRIPT?`, avisos),
      sistema_origem: txt(v('sistema_origem')), sistema_destino: txt(v('sistema_destino')), analista: txt(v('analista')),
      pasta_projeto: txt(v('pasta_projeto')), pasta_projeto_url: cellUrl(row.cells[idx.pasta_projeto]),
      aba_projeto: txt(v('aba_projeto')), aba_planilha: null, // resolvido depois
      segmento: canonico(v('segmento'), SEGMENTOS, `${onde} SEGMENTO`, avisos),
      status_projeto: canonico(v('status_projeto'), STATUS_PROJETO, `${onde} STATUS`, avisos),
      _aba_formula: abaDaFormula(v('percentual')),
    };
    if (vistos.has(nome)) {
      avisos.add(`${onde}: nome repetido (já existe na linha ${vistos.get(nome)}) — a última ocorrência vale`);
      projetos = projetos.filter((x) => x.nome !== nome);
    }
    vistos.set(nome, row.n);
    projetos.push(p);
  }
  return projetos;
}

function lerMarcos(ws, avisos) {
  const idx = indiceCabecalho(ws, { nome: 'NOME DO PROJETO', responsavel: 'RESPONSÁVEL', depara: 'DATA ENTREGA DE/PARA', hmg: 'CARGA EM HMG', hmg2: 'CARGA EM HMG 2', prd: 'CARGA EM PRD' });
  let out = [];
  const vistos = new Set();
  for (const row of sheetRows(ws).rows) {
    const v = (campo) => row.raw[idx[campo]] ?? null;
    const nome = txt(v('nome'));
    if (!nome) continue;
    if (vistos.has(nome)) {
      avisos.add(`MARCOS linha ${row.n}: projeto '${nome}' repetido — a última ocorrência vale`);
      out = out.filter((x) => x.nome_projeto !== nome);
    }
    vistos.add(nome);
    const obs = [];
    const dt = (campo, rotulo) => {
      const val = v(campo);
      if (typeof val === 'string' && val.trim()) { // intervalo/texto (ex.: "08/12/2025-10/12/2025"): guarda o texto e usa a 1ª data
        obs.push(`${rotulo}: ${val.trim()}`);
        const m = val.match(/^\s*(\d{1,2}\/\d{1,2}\/\d{4})/);
        return m ? data(m[1], '', new Avisos()) : null;
      }
      return data(val, `MARCOS linha ${row.n} ${rotulo}`, avisos);
    };
    out.push({
      nome_projeto: nome, projeto_id: null, responsavel: txt(v('responsavel')),
      data_entrega_depara: dt('depara', 'DATA ENTREGA DE/PARA'), carga_hmg: dt('hmg', 'CARGA EM HMG'), carga_hmg_2: dt('hmg2', 'CARGA EM HMG 2'), carga_prd: dt('prd', 'CARGA EM PRD'),
      observacao: obs.join('; ') || null,
    });
  }
  return out;
}

const RX_CODIGO = /^\s*(\d+(?:\.\d+)*)\s*[-–.]\s*([\s\S]+?)\s*$/;
// Três leiautes de aba de tarefas; detecta pela largura e pelo cabeçalho.
function layoutAba(ws, width) {
  if (width >= 14) { // FMSA e GRUPO NETO: duas trilhas (status/datas em dobro)
    return { titulo: 0, prioridade: 1, recurso: 2, status: 3, status_2: 4, data_inicio: 5, data_termino: 6, data_inicio_2: 7, data_termino_2: 8, marco: 9, link_tarefa: 10, smartcliente_hmg: 11, smartcliente_prd: 12, observacoes: 13 };
  }
  const cab = headerOf(ws).map(norm);
  if (cab.length > 1 && cab[1].startsWith('DATA DE INICIO')) {
    return { titulo: 0, data_inicio: 1, data_termino: 2, status: 3, prioridade: 4, recurso: 5, marco: 6, link_tarefa: 7, smartcliente_hmg: 8, smartcliente_prd: 9, observacoes: 10 };
  }
  return { titulo: 0, prioridade: 1, recurso: 2, status: 3, data_inicio: 4, data_termino: 5, marco: 6, link_tarefa: 7, smartcliente_hmg: 8, smartcliente_prd: 9, observacoes: 10 };
}

function lerTarefas(ws, avisos) {
  const { width, rows } = sheetRows(ws);
  const idx = layoutAba(ws, width);
  const tarefas = [];
  const codigos = new Map();
  for (const row of rows) {
    const cel = (campo) => (campo in idx ? row.raw[idx[campo]] ?? null : null);
    if (row.raw.every((x) => x === null || x === undefined)) continue;
    const bruto = txt(cel('titulo'));
    if (!bruto) continue; // linha só com status/prioridade padrão
    const m = bruto.match(RX_CODIGO);
    let codigo = m ? m[1] : `~${[...norm(bruto)].slice(0, 80).join('')}`;
    const titulo = m ? m[2] : bruto;
    codigos.set(codigo, (codigos.get(codigo) || 0) + 1);
    const vezes = codigos.get(codigo);
    if (vezes > 1) {
      avisos.add(`Aba '${ws.name}' linha ${row.n}: código '${codigo}' repetido — gravado como '${codigo}#${vezes}'`);
      codigo = `${codigo}#${vezes}`;
    }
    const onde = `Aba '${ws.name}' linha ${row.n}`;
    tarefas.push({
      aba: ws.name, codigo, projeto_id: null, ordem: row.n, titulo,
      prioridade: canonico(cel('prioridade'), PRIORIDADES, `${onde} prioridade`, avisos),
      recurso: txt(cel('recurso')),
      status: canonico(cel('status'), STATUS_TAREFA, `${onde} status`, avisos),
      data_inicio: data(cel('data_inicio'), `${onde} data de início`, avisos),
      data_termino: data(cel('data_termino'), `${onde} data de término`, avisos),
      marco: txt(cel('marco')), link_tarefa: txt(cel('link_tarefa')), smartcliente_hmg: txt(cel('smartcliente_hmg')), smartcliente_prd: txt(cel('smartcliente_prd')),
      observacoes: txt(cel('observacoes')),
      status_2: canonico(cel('status_2'), STATUS_TAREFA, `${onde} status 2`, avisos),
      data_inicio_2: data(cel('data_inicio_2'), `${onde} data de início 2`, avisos),
      data_termino_2: data(cel('data_termino_2'), `${onde} data de término 2`, avisos),
    });
  }
  return tarefas;
}

// ---------- Ligação projeto ↔ aba de tarefas ----------
const primeiraPalavra = (s) => { const n = norm(s); return n ? n.split(/[\s\-.]+/)[0] : ''; };

// Preenche p.aba_planilha. Prioridade: manual > fórmula do % (se confiável) > coluna ABA DO PROJETO.
function resolverAbas(projetos, abas, avisos) {
  const porNorm = new Map();
  for (const a of abas) porNorm.set(norm(a), a);
  const usadas = new Map(); // aba → nome do projeto
  const atribuir = (p, aba, motivo) => {
    if (usadas.has(aba) && usadas.get(aba) !== p.nome) { avisos.add(`Projeto '${p.nome}': aba '${aba}' já é de '${usadas.get(aba)}' (${motivo}) — ignorado`); return false; }
    p.aba_planilha = aba; usadas.set(aba, p.nome); return true;
  };
  for (const p of projetos) { // 1) manual
    const alvo = MAPEAMENTO_MANUAL_ABAS[p.nome] || Object.entries(MAPEAMENTO_MANUAL_ABAS).find(([k]) => norm(k) === norm(p.nome))?.[1];
    if (!alvo) continue;
    const aba = porNorm.get(norm(alvo));
    if (aba) atribuir(p, aba, 'mapeamento manual');
    else avisos.add(`Mapeamento manual de '${p.nome}' aponta para aba inexistente '${alvo}'`);
  }
  const reivindicacoes = new Map(); // 2) fórmula do “% executado”: vale se só 1 projeto cita a aba, ou se o nome combinar
  for (const p of projetos) if (!p.aba_planilha && abas.includes(p._aba_formula)) { if (!reivindicacoes.has(p._aba_formula)) reivindicacoes.set(p._aba_formula, []); reivindicacoes.get(p._aba_formula).push(p); }
  for (const [aba, ps] of reivindicacoes) {
    if (ps.length === 1) { atribuir(ps[0], aba, 'fórmula'); continue; }
    const donos = ps.filter((p) => primeiraPalavra(p.nome) === primeiraPalavra(aba));
    const dono = donos.length === 1 ? donos[0] : null;
    if (dono) atribuir(dono, aba, 'fórmula');
    for (const p of ps) if (p !== dono) avisos.add(`Projeto '${p.nome}': a fórmula de % aponta para a aba '${aba}', que pertence a outro projeto (erro de cópia na planilha) — sem aba`);
  }
  for (const p of projetos) { // 3) coluna ABA DO PROJETO (texto digitado; pode estar truncado)
    if (p.aba_planilha || !p.aba_projeto) continue;
    const a = norm(p.aba_projeto);
    let achada = porNorm.get([...a].slice(0, 31).join('').trimEnd());
    if (!achada) for (const [n, orig] of porNorm) if (n && a.startsWith(n)) { achada = orig; break; }
    if (achada && !usadas.has(achada)) atribuir(p, achada, 'ABA DO PROJETO');
  }
}

// difflib.SequenceMatcher(None, a, b).ratio() — para nomes curtos (sem a heurística de “junk”, que só vale com 200+ caracteres).
function ratio(a, b) {
  const A = [...a], B = [...b];
  const longest = (alo, ahi, blo, bhi) => {
    let bi = alo, bj = blo, bk = 0, prev = new Map();
    for (let i = alo; i < ahi; i++) {
      const cur = new Map();
      for (let j = blo; j < bhi; j++) {
        if (A[i] !== B[j]) continue;
        const k = (prev.get(j - 1) || 0) + 1;
        cur.set(j, k);
        if (k > bk) { bi = i - k + 1; bj = j - k + 1; bk = k; }
      }
      prev = cur;
    }
    return [bi, bj, bk];
  };
  let matches = 0;
  const queue = [[0, A.length, 0, B.length]];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop();
    const [i, j, k] = longest(alo, ahi, blo, bhi);
    if (!k) continue;
    matches += k;
    if (alo < i && blo < j) queue.push([alo, i, blo, j]);
    if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
  }
  const t = A.length + B.length;
  return t ? (2 * matches) / t : 1;
}
// difflib.get_close_matches(word, poss, n=2, cutoff=0.9)
function closeMatches(word, poss, n = 2, cutoff = 0.9) {
  return poss.map((x) => [ratio(word, x), x]).filter(([s]) => s >= cutoff).sort((a, b) => b[0] - a[0] || (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0)).slice(0, n).map(([, x]) => x);
}

// projetosIds: nome → id. Casa por nome (normalizado), alias, ou similaridade alta.
function resolverMarcos(marcos, projetosIds, avisos) {
  const porNorm = new Map();
  for (const n of Object.keys(projetosIds)) porNorm.set(norm(n), n);
  for (const m of marcos) {
    const nome = m.nome_projeto;
    let alvo = porNorm.get(norm(ALIASES_MARCOS[nome] || nome));
    if (alvo === undefined) {
      const parecidos = closeMatches(norm(nome), [...porNorm.keys()]);
      if (parecidos.length === 1) alvo = porNorm.get(parecidos[0]);
    }
    if (alvo === undefined) { avisos.add(`MARCOS: '${nome}' não encontrado em GERENCIAMENTO — ficou sem projeto_id (adicione em ALIASES_MARCOS)`); continue; }
    m.projeto_id = projetosIds[alvo];
  }
}

// ---------- Leitura completa ----------
async function lerPlanilha(file) {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.readFile(file); } catch (e) { throw Object.assign(new Error(`Não foi possível ler a planilha: ${e.message}`), { status: 400 }); }
  const nomes = wb.worksheets.map((w) => w.name);
  for (const obrig of [ABA_PROJETOS, ABA_MARCOS]) {
    if (!nomes.includes(obrig)) throw Object.assign(new Error(`Aba obrigatória '${obrig}' não encontrada. Esta não parece ser a planilha do Hub de Dados (abas: ${nomes.slice(0, 8).join(', ')}…).`), { status: 400 });
  }
  const avisos = new Avisos();
  const abasTarefas = nomes.filter((n) => n !== ABA_PROJETOS && n !== ABA_MARCOS && !n.trim().toUpperCase().startsWith(PREFIXO_ABA_MODELO));
  const projetos = lerProjetos(wb.getWorksheet(ABA_PROJETOS), avisos);
  const marcos = lerMarcos(wb.getWorksheet(ABA_MARCOS), avisos);
  const tarefas = [];
  for (const aba of abasTarefas) tarefas.push(...lerTarefas(wb.getWorksheet(aba), avisos));
  resolverAbas(projetos, abasTarefas, avisos);
  const comProjeto = new Set(projetos.map((p) => p.aba_planilha).filter(Boolean));
  for (const a of abasTarefas) {
    if (comProjeto.has(a)) continue;
    const n = tarefas.filter((t) => t.aba === a).length;
    if (n) avisos.add(`Aba '${a}' (${n} tarefas) não pertence a nenhum projeto de GERENCIAMENTO — tarefas gravadas sem projeto_id`);
  }
  for (const p of projetos) delete p._aba_formula;
  return { projetos, marcos, tarefas, abasTarefas, avisos: avisos.itens };
}

module.exports = { lerPlanilha, resolverMarcos, norm, txt, ratio, closeMatches, COLS_PROJETOS, COLS_TAREFAS, COLS_MARCOS, STATUS_PROJETO, ABA_PROJETOS, ABA_MARCOS };
