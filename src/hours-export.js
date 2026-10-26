// Exportação mensal dos apontamentos para .xlsx (ExcelJS, já usado na leitura das planilhas). É só LEITURA: nada é alterado.
// 1ª aba = o mês no formato da planilha PSA (mesmas colunas e visual); depois as abas de apoio (detalhado, resumos, observações) no mesmo visual.
// Durações vão como fração de dia (passa de 24 h sem reiniciar), datas como datas e percentuais como percentuais.
const ExcelJS = require('exceljs');
const H = require('./hours');
const { sanitizeFileName } = require('./util');

const WEEKDAYS = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
const MONTHS = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const pad2 = (n) => String(n).padStart(2, '0');
const frac = (min) => min / 1440;
const excelDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }; // UTC: o Excel não desloca o dia
const signed = (min) => (min === 0 ? '00:00' : `${min > 0 ? '+' : '-'}${H.fmtHM(Math.abs(min))}`);
const DUR = '[h]:mm';

// Visual da planilha de horas (PSA): cabeçalho azul com texto branco em negrito, Calibri 11, bordas finas e conteúdo centralizado.
const PSA_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF00B0F0' } };
const YELLOW = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } };
const THIN = { style: 'thin' };
const BOX = { top: THIN, left: THIN, bottom: THIN, right: THIN };
const CENTER = { horizontal: 'center', vertical: 'middle' };
const BODY_FONT = { name: 'Calibri', size: 11 };
const BOLD_FONT = { ...BODY_FONT, bold: true };
const HEAD_FONT = { ...BOLD_FONT, color: { argb: 'FFFFFFFF' } };
function styleHeader(ws, widths) {
  const row = ws.getRow(1);
  row.height = 30;
  row.eachCell((c) => {
    c.font = HEAD_FONT;
    c.fill = PSA_FILL;
    c.alignment = { ...CENTER, wrapText: true };
    c.border = BOX;
  });
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}
// Abas de apoio no mesmo visual da aba do mês: bordas finas nas linhas preenchidas.
function gridRows(ws, cols) {
  ws.eachRow((row, n) => {
    if (n === 1 || !row.values.some((v) => v !== null && v !== undefined && v !== '')) return;
    for (let c = 1; c <= cols; c++) {
      const cell = row.getCell(c);
      cell.border = BOX;
      cell.alignment = { vertical: 'middle', ...(cell.alignment || {}) };
    }
  });
}
const boldRow = (row) => row.eachCell((c) => { c.font = BOLD_FONT; });

// ---- Aba do mês no formato da planilha PSA (uma aba por mês, nome em maiúsculas: SETEMBRO) ----
// MÊS DA COMPETÊNCIA · DATA · DIA · HORA INICIO · HORA FIM · CARGA HORÁRIA (=fim − início − pausas) · CLIENTE (projeto) · ATIVIDADES · COORDENAÇÃO.
// Dia de folga cadastrado (exceção com meta 0 em dia útil, sem horas) entra como linha amarela com o motivo; fim de semana destaca o DIA;
// linha TOTAL (A:E mesclado) e, ao lado (L:O), as horas por cliente e coordenação (como a tabela dinâmica da planilha).
const PSA_COLS = ['MÊS DA COMPETÊNCIA', 'DATA', 'DIA', 'HORA INICIO', 'HORA FIM', 'CARGA HORÁRIA', 'CLIENTE', 'ATIVIDADES', 'COORDENAÇÃO'];
const PSA_WIDTHS = [21.71, 10.71, 13.86, 12.29, 10, 16, 14, 68.43, 15.14, 9.14, 9.14, 19.29, 24.29, 17.43, 24.29];
const PSA_DAY = WEEKDAYS.map((w) => w.replace('-feira', '-Feira')); // igual ao =PRÓPRIO(TEXTO(DIA.DA.SEMANA(…);"DDDD")) da planilha
const SUM_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
// Período que não é um mês inteiro (dia/intervalo, pode atravessar meses): aba “PERÍODO”; MÊS DA COMPETÊNCIA continua sendo o mês de cada linha.
function psaSheet(wb, data, entries, days, period) {
  const ws = wb.addWorksheet(period.kind === 'month' ? MONTHS[period.month - 1].toUpperCase() : 'PERÍODO');
  const label = period.label;
  const monthOf = (date) => `${MONTHS[Number(date.slice(5, 7)) - 1]}/${date.slice(0, 4)}`;
  PSA_WIDTHS.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  const head = ws.getRow(1);
  PSA_COLS.forEach((t, i) => { const c = head.getCell(i + 1); c.value = t; c.font = HEAD_FONT; c.fill = PSA_FILL; c.border = BOX; c.alignment = CENTER; });

  const off = days.filter((d) => d.override && d.target === 0 && d.confirmed === 0 && d.dow >= 1 && d.dow <= 5)
    .map((d) => ({ date: d.date, startMin: 0, off: (d.reason || 'Sem expediente').toUpperCase() }));
  const lines = [...entries, ...off].sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin);
  let r = 1;
  for (const e of lines) {
    r++;
    const row = ws.getRow(r);
    const proj = e.off ? null : data.projects.find((p) => p.id === e.projectId);
    const pause = e.off ? 0 : e.pausedMin || 0;
    row.values = [monthOf(e.date), excelDate(e.date), PSA_DAY[H.dowOf(e.date)], e.off ? 0 : frac(e.startMin), e.off ? 0 : frac(e.endMin),
      { formula: `E${r}-D${r}${pause ? `-TIME(0,${pause},0)` : ''}`, result: e.off ? 0 : frac(H.netMin(e)) },
      e.off || (proj ? proj.name : e.projectName), e.off || e.activity, e.off || e.coordinatorName || '-'];
    for (let c = 1; c <= 9; c++) { const cell = row.getCell(c); cell.border = BOX; cell.alignment = c >= 3 && c <= 6 ? { ...CENTER, wrapText: true } : CENTER; }
    row.getCell(2).numFmt = 'mm-dd-yy'; // formato 14 = data abreviada do Windows (dd/mm/aaaa no pt-BR), igual à planilha
    [4, 5, 6].forEach((c) => { row.getCell(c).numFmt = 'h:mm:ss'; });
    [1, 6, 7, 9].forEach((c) => { row.getCell(c).font = BOLD_FONT; });
    if (e.off) [7, 8, 9].forEach((c) => { const cell = row.getCell(c); cell.fill = YELLOW; cell.font = BODY_FONT; });
  }
  const last = r;
  if (last > 1) {
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: last, column: 9 } };
    ws.addConditionalFormatting({ ref: `C2:C${last}`, rules: [{ type: 'expression', priority: 1, formulae: ['OR(WEEKDAY(B2)=7,WEEKDAY(B2)=1)'], style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFFFFF00' } } } }] });
  }
  const totalMin = entries.reduce((n, e) => n + H.netMin(e), 0);
  const t = ws.getRow(last + 1);
  ws.mergeCells(last + 1, 1, last + 1, 5);
  for (let c = 1; c <= 6; c++) { t.getCell(c).border = BOX; t.getCell(c).alignment = CENTER; }
  t.getCell(1).value = 'TOTAL'; t.getCell(1).font = HEAD_FONT; t.getCell(1).fill = PSA_FILL;
  t.getCell(6).value = last > 1 ? { formula: `SUM(F2:F${last})`, result: frac(totalMin) } : 0;
  t.getCell(6).numFmt = '[h]:mm:ss'; t.getCell(6).font = BOLD_FONT;

  const groups = new Map();
  for (const e of entries) {
    const proj = data.projects.find((p) => p.id === e.projectId);
    const client = proj ? proj.name : e.projectName;
    const coord = e.coordinatorName || '-';
    const k = JSON.stringify([client, coord]);
    groups.set(k, { client, coord, min: (groups.get(k)?.min || 0) + H.netMin(e) });
  }
  const sums = [...groups.values()].sort((a, b) => a.client.localeCompare(b.client, 'pt-BR') || a.coord.localeCompare(b.coord, 'pt-BR'));
  ['MÊS DA COMPETÊNCIA', 'CLIENTE', 'COORDENAÇÃO', 'Soma de CARGA HORÁRIA'].forEach((v, i) => { const c = head.getCell(12 + i); c.value = v; c.font = HEAD_FONT; c.fill = SUM_FILL; });
  sums.forEach((g, i) => {
    const row = ws.getRow(2 + i);
    if (i === 0) row.getCell(12).value = label;
    row.getCell(13).value = g.client; row.getCell(14).value = g.coord;
    row.getCell(15).value = frac(g.min); row.getCell(15).numFmt = '[h]:mm:ss';
  });
  const gt = ws.getRow(2 + sums.length);
  gt.getCell(12).value = 'Total Geral';
  gt.getCell(15).value = frac(totalMin); gt.getCell(15).numFmt = '[h]:mm:ss';
  for (let c = 12; c <= 15; c++) { const cell = gt.getCell(c); cell.font = BOLD_FONT; cell.border = { top: { style: 'thin', color: { argb: 'FF4472C4' } } }; }
}

// opts.period = período de src/hours.js cleanPeriod (padrão: o mês year/month, como antes). opts.projectIds = só esses projetos
// (filtro por coordenador e/ou projetos escolhidos; filterLabel vai no nome do arquivo e filterDetail — a lista completa — na planilha).
// Com filtro, a aba de resumo diário (meta × apontado) sai: a meta é do dia inteiro e não se divide por coordenador/projeto.
// Observações: as dos projetos filtrados e as gerais (sem projeto).
async function buildWorkbook(data, year, month, today, { period: per = null, projectIds = null, filterLabel = '', filterDetail = '' } = {}) {
  const cfg = data.hours;
  const period = per || H.cleanPeriod({ year, month });
  const { from, to } = period;
  const filtered = Array.isArray(projectIds);
  const entries = data.timeEntries.filter((e) => e.date >= from && e.date <= to && (!filtered || projectIds.includes(e.projectId)))
    .sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin);
  const by = H.groupByDate(data.timeEntries);
  const summary = (d) => H.daySummary(cfg, d, by.get(d) || []);
  const competence = (d) => `${d.slice(5, 7)}/${d.slice(0, 4)}`;

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Gerenciador de Projetos';
  wb.created = new Date();

  const sm = H.periodSummary(data, from, to, today);
  psaSheet(wb, data, entries, sm.days, period);

  // ---- Apontamentos (detalhado: pausas, meta e observação de cada apontamento) ----
  const ws = wb.addWorksheet('Apontamentos');
  ws.columns = [
    { header: 'Período' }, { header: 'Data' }, { header: 'Dia da semana' }, { header: 'Projeto' }, { header: 'Coordenador' }, { header: 'Analista de Implantação' }, { header: 'Atividade realizada' },
    { header: 'Horário inicial' }, { header: 'Horário final' }, { header: 'Intervalos/Pausas' }, { header: 'Horas trabalhadas' }, { header: 'Meta diária' },
    { header: '% da Meta - Atividade' }, { header: 'Total do dia' }, { header: '% da Meta - Dia' }, { header: 'Horas restantes (dia)' }, { header: 'Horas excedentes (dia)' }, { header: 'Observação' },
  ];
  for (const e of entries) {
    const d = summary(e.date);
    const proj = data.projects.find((p) => p.id === e.projectId);
    const row = ws.addRow([
      competence(e.date), excelDate(e.date), WEEKDAYS[d.dow], proj ? proj.name : e.projectName, e.coordinatorName || '-', e.analystName || '-', e.activity,
      frac(e.startMin), frac(e.endMin), frac(e.pausedMin || 0), frac(H.netMin(e)), frac(d.target),
      d.target ? H.netMin(e) / d.target : null, frac(d.confirmed), d.target ? d.confirmed / d.target : null, frac(d.remaining), frac(d.over), e.note || '-',
    ]);
    row.getCell(2).numFmt = 'dd/mm/yyyy';
    [8, 9].forEach((c) => { row.getCell(c).numFmt = 'hh:mm'; });
    [10, 11, 12, 14, 16, 17].forEach((c) => { row.getCell(c).numFmt = DUR; });
    [13, 15].forEach((c) => { row.getCell(c).numFmt = '0.00%'; });
    row.getCell(7).alignment = { wrapText: true, vertical: 'top' };
    row.getCell(18).alignment = { wrapText: true, vertical: 'top' };
    [1, 2, 3, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17].forEach((c) => { row.getCell(c).alignment = { horizontal: 'center', vertical: 'top' }; });
  }
  styleHeader(ws, [10, 12, 15, 26, 22, 22, 48, 11, 11, 12, 12, 11, 13, 11, 13, 13, 13, 30]);
  if (entries.length) {
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: entries.length + 1, column: 18 } };
    ws.addRow([]); // linha em branco: o filtro não inclui o total
    const total = ws.addRow(['Total', null, null, null, null, null, `${entries.length} apontamento(s)`, null, null, entries.reduce((n, e) => n + (e.pausedMin || 0), 0) / 1440,
      entries.reduce((n, e) => n + H.netMin(e), 0) / 1440]);
    total.getCell(10).numFmt = DUR; total.getCell(11).numFmt = DUR;
    total.getCell(10).alignment = { horizontal: 'center' }; total.getCell(11).alignment = { horizontal: 'center' };
    boldRow(total);
  }
  gridRows(ws, 18);

  // ---- Resumo Mensal (ou do Período) — só sem filtro ----
  if (!filtered) {
    const tracking = H.trackingFrom(data, today);
    const rs = wb.addWorksheet(period.kind === 'month' ? 'Resumo Mensal' : 'Resumo do Período');
    rs.columns = [{ header: 'Data' }, { header: 'Dia da semana' }, { header: 'Meta' }, { header: 'Apontado' }, { header: 'Diferença' }, { header: 'Status' }, { header: 'Observações' }];
    const noteCount = new Map();
    for (const n of data.timeNotes || []) for (const d of H.datesOfNote(n)) noteCount.set(d, (noteCount.get(d) || 0) + 1);
    for (const d of sm.days) {
      if (d.target === 0 && d.confirmed === 0 && !noteCount.get(d.date)) continue; // dia sem meta, sem horas e sem observação não polui o resumo // fins de semana e dias sem meta e sem horas não poluem o resumo
      const future = d.date > today && d.confirmed === 0;
      const before = d.date < tracking && d.confirmed === 0; // antes de o controle começar: não conta como pendência (mesma regra da meta acumulada)
      const row = rs.addRow([excelDate(d.date), WEEKDAYS[d.dow], frac(d.target), frac(d.confirmed), future || before ? '-' : signed(d.confirmed - d.target),
        future ? 'A vencer' : before ? 'Antes do controle' : H.STATUS_LABEL[d.status] + (d.reason ? ` (${d.reason})` : ''), noteCount.get(d.date) || 0]);
      row.getCell(7).alignment = { horizontal: 'center' };
      row.getCell(1).numFmt = 'dd/mm/yyyy';
      row.getCell(3).numFmt = DUR; row.getCell(4).numFmt = DUR;
      [1, 3, 4, 5, 6].forEach((c) => { row.getCell(c).alignment = { horizontal: 'center' }; });
      if (d.status === 'pendente' || d.status === 'sem_apontamento') { if (!future && !before) row.getCell(6).font = { color: { argb: 'FFB45309' }, bold: true }; }
      if (d.status === 'excedente') row.getCell(6).font = { color: { argb: 'FF0E7D66' }, bold: true };
    }
    styleHeader(rs, [13, 16, 11, 11, 12, 30, 13]);
    gridRows(rs, 7);
    rs.addRow([]);
    const lines = [[period.kind === 'month' ? 'Meta do mês' : 'Meta do período', frac(sm.targetPeriod), null], ['Meta acumulada (até hoje)', frac(sm.targetAccum), null], ['Apontado', frac(sm.confirmed), null], ['Diferença (apontado − acumulada)', null, signed(sm.confirmed - sm.targetAccum)]];
    for (const [label, v, text] of lines) {
      const r = rs.addRow([label, null, v, null, text]);
      r.getCell(3).numFmt = DUR; r.getCell(3).alignment = { horizontal: 'center' }; r.getCell(5).alignment = { horizontal: 'center' };
      r.getCell(1).font = { bold: true };
    }
    rs.addRow([]);
    rs.addRow([`Dias completos: ${sm.counts.completo}  ·  Dias pendentes: ${sm.counts.pendente}  ·  Dias excedentes: ${sm.counts.excedente}`]).getCell(1).font = { italic: true };
  }

  // ---- Resumo por Projeto ----
  const rp = wb.addWorksheet('Resumo por Projeto');
  rp.columns = [{ header: 'Projeto' }, { header: 'Coordenador(es)' }, { header: 'Analista(s) de Implantação' }, { header: 'Horas' }, { header: '% do total' }, { header: 'Apontamentos' }];
  const groups = new Map();
  for (const e of entries) {
    const g = groups.get(e.projectId) || { name: e.projectName, coords: new Set(), analysts: new Set(), min: 0, n: 0 };
    const proj = data.projects.find((p) => p.id === e.projectId);
    g.name = proj ? proj.name : e.projectName;
    if (e.coordinatorName) g.coords.add(e.coordinatorName);
    if (e.analystName) g.analysts.add(e.analystName);
    g.min += H.netMin(e); g.n++;
    groups.set(e.projectId, g);
  }
  const all = [...groups.values()].sort((a, b) => b.min - a.min);
  const totalMin = all.reduce((n, g) => n + g.min, 0);
  for (const g of all) {
    const r = rp.addRow([g.name, [...g.coords].join(', ') || '-', [...g.analysts].join(', ') || '-', frac(g.min), totalMin ? g.min / totalMin : 0, g.n]);
    r.getCell(4).numFmt = DUR; r.getCell(5).numFmt = '0.00%';
    [4, 5, 6].forEach((c) => { r.getCell(c).alignment = { horizontal: 'center' }; });
  }
  styleHeader(rp, [34, 30, 26, 12, 12, 14]);
  if (all.length) {
    rp.addRow([]);
    const t = rp.addRow(['Total', null, null, frac(totalMin), 1, all.reduce((n, g) => n + g.n, 0)]);
    t.getCell(4).numFmt = DUR; t.getCell(5).numFmt = '0.00%';
    [4, 5, 6].forEach((c) => { t.getCell(c).alignment = { horizontal: 'center' }; });
    boldRow(t);
  }
  gridRows(rp, 6);
  if (filtered) {
    rp.addRow([]);
    rp.addRow([`Filtro: ${filterDetail || filterLabel || 'projetos escolhidos'} · ${period.label}`]).getCell(1).font = { italic: true };
  }
  // ---- Observações (uma linha por observação; as evidências ficam no app — aqui só a contagem e os nomes dos arquivos) ----
  const notes = (data.timeNotes || []).filter((n) => H.datesOfNote(n).some((d) => d >= from && d <= to) && (!filtered || !n.projectId || projectIds.includes(n.projectId))).sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
  const ro = wb.addWorksheet('Observações');
  ro.columns = [{ header: 'Data' }, { header: 'Dia da semana' }, { header: 'Projeto' }, { header: 'Categoria' }, { header: 'Título' }, { header: 'Observação' }, { header: 'Qtd. evidências' }, { header: 'Evidências (arquivos)' }, { header: 'Registrada em' }, { header: 'Dias da observação' }];
  // Uma linha por observação E por dia (dá para filtrar por data); “Dias da observação” mostra todos os dias que ela cobre.
  for (const n of notes) for (const day of H.datesOfNote(n).filter((d) => d >= from && d <= to)) {
    const proj = n.projectId ? data.projects.find((p) => p.id === n.projectId) : null;
    const cat = H.noteCategory(data.hours, n.category);
    const row = ro.addRow([excelDate(day), WEEKDAYS[H.dowOf(day)], n.projectId ? (proj ? proj.name : n.projectName) : 'Geral', cat.label, n.title, n.description || '-', n.evidences.length, n.evidences.map((e) => e.name).join('; ') || '-', new Date(n.createdAt), H.datesOfNote(n).map((d) => `${d.slice(8)}/${d.slice(5, 7)}`).join(', ')]);
    row.getCell(1).numFmt = 'dd/mm/yyyy';
    row.getCell(9).numFmt = 'dd/mm/yyyy hh:mm';
    [1, 2, 4, 7, 9].forEach((c) => { row.getCell(c).alignment = { horizontal: 'center', vertical: 'top' }; });
    [3, 5, 6, 8, 10].forEach((c) => { row.getCell(c).alignment = { wrapText: true, vertical: 'top' }; });
  }
  styleHeader(ro, [12, 15, 24, 17, 32, 70, 11, 34, 17, 26]);
  gridRows(ro, 10);
  if (ro.rowCount > 1) ro.autoFilter = { from: { row: 1, column: 1 }, to: { row: ro.rowCount, column: 10 } };
  // Nome: mês = Apontamentos_AAAA_MM (como antes); dia = Apontamentos_AAAA-MM-DD; intervalo = Apontamentos_AAAA-MM-DD_a_AAAA-MM-DD; + _<filtro>.
  const base = period.kind === 'month' ? `Apontamentos_${period.year}_${pad2(period.month)}` : period.kind === 'day' ? `Apontamentos_${from}` : `Apontamentos_${from}_a_${to}`;
  const suffix = filterLabel ? `_${sanitizeFileName(filterLabel, '').replace(/\s*,\s*/g, '+').replace(/\s+/g, '_')}` : '';
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), name: `${base}${suffix}.xlsx`, label: period.label, filter: filterLabel || '', count: entries.length, notes: notes.length };
}

module.exports = { buildWorkbook, WEEKDAYS };
