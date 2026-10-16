// Exportação do Controle de Horas: 1ª aba no formato da planilha PSA (aba do mês, colunas, visual, folga, pausa, total e resumo L:O).
// Só regra pura (buildWorkbook): sem servidor e sem disco.
const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const H = require('../src/hours');
const { buildWorkbook } = require('../src/hours-export');

const frac = (v) => (v instanceof Date ? (v.getTime() - Date.UTC(1899, 11, 30)) / 86400000 : v);
const entry = (id, date, start, end, extra = {}) => ({ id, projectId: 'p1', projectName: 'Cliente Alfa', date, startMin: H.parseHM(start), endMin: H.parseHM(end), pausedMin: 0,
  activity: `Carga ${id}`, note: '', coordinatorId: 'c1', coordinatorName: 'Carla Coord', analystId: null, analystName: '', source: 'manual', createdAt: '2026-09-01T00:00:00.000Z', ...extra });

test('aba do mês no formato PSA: colunas, visual, folga em amarelo, pausa descontada, TOTAL e resumo por cliente/coordenação', async () => {
  const data = { projects: [{ id: 'p1', name: 'Cliente Alfa' }, { id: 'p2', name: 'Cliente Beta' }], coordinators: [], hours: H.defaultHours(), timeNotes: [],
    timeEntries: [entry('a', '2026-09-01', '08:00', '12:00'), entry('b', '2026-09-01', '13:30', '18:00', { pausedMin: 30 }),
      entry('c', '2026-09-02', '08:00', '10:00', { projectId: 'p2', projectName: 'Cliente Beta', coordinatorName: 'Duda Coord' }), entry('d', '2026-09-05', '09:00', '10:00')] };
  data.hours.overrides.push({ date: '2026-09-07', targetMin: 0, reason: 'Feriado' });
  const out = await buildWorkbook(data, 2026, 9, '2026-09-30');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(out.buffer);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['SETEMBRO', 'Apontamentos', 'Resumo Mensal', 'Resumo por Projeto', 'Observações']);
  const ws = wb.getWorksheet('SETEMBRO');
  assert.deepEqual(ws.getRow(1).values.slice(1, 10), ['MÊS DA COMPETÊNCIA', 'DATA', 'DIA', 'HORA INICIO', 'HORA FIM', 'CARGA HORÁRIA', 'CLIENTE', 'ATIVIDADES', 'COORDENAÇÃO']);
  const h1 = ws.getCell('A1');
  assert.equal(h1.fill.fgColor.argb, 'FF00B0F0');
  assert.equal(h1.font.bold, true);
  assert.equal(h1.border.top.style, 'thin');
  assert.equal(ws.getColumn(8).width, 68.43);

  // linhas: 4 apontamentos + o feriado (dia útil com meta 0), em ordem de data/horário
  assert.equal(ws.getCell('H2').value, 'Carga a');
  assert.equal(ws.getCell('A2').value, 'Setembro/2026');
  assert.equal(ws.getCell('B2').numFmt, 'mm-dd-yy');
  assert.equal(ws.getCell('C2').value, 'Terça-Feira');
  assert.equal(ws.getCell('D2').numFmt, 'h:mm:ss');
  assert.equal(ws.getCell('G2').value, 'Cliente Alfa');
  assert.equal(ws.getCell('I2').value, 'Carla Coord');
  assert.equal(ws.getCell('F2').formula, 'E2-D2');
  assert.equal(ws.getCell('F3').formula, 'E3-D3-TIME(0,30,0)', 'pausa descontada da carga horária');
  assert.ok(Math.abs(frac(ws.getCell('F3').result) - 240 / 1440) < 1e-9);
  assert.equal(ws.getCell('C5').value, 'Sábado');
  assert.equal(ws.getCell('G6').value, 'FERIADO');
  assert.equal(ws.getCell('H6').fill.fgColor.argb, 'FFFFFF00');

  // TOTAL (A:E mesclado) com a soma das horas
  assert.equal(ws.getCell('A7').value, 'TOTAL');
  assert.equal(ws.getCell('E7').master.address, 'A7');
  assert.equal(ws.getCell('F7').formula, 'SUM(F2:F6)');
  assert.equal(ws.getCell('F7').numFmt, '[h]:mm:ss');
  assert.ok(Math.abs(frac(ws.getCell('F7').result) - (240 + 240 + 120 + 60) / 1440) < 1e-9);
  assert.ok(ws.autoFilter);

  // resumo ao lado: cliente + coordenação, e Total Geral
  assert.deepEqual(ws.getRow(1).values.slice(12, 16), ['MÊS DA COMPETÊNCIA', 'CLIENTE', 'COORDENAÇÃO', 'Soma de CARGA HORÁRIA']);
  assert.deepEqual([ws.getCell('L2').value, ws.getCell('M2').value, ws.getCell('N2').value], ['Setembro/2026', 'Cliente Alfa', 'Carla Coord']);
  assert.ok(Math.abs(frac(ws.getCell('O2').value) - 540 / 1440) < 1e-9);
  assert.deepEqual([ws.getCell('M3').value, ws.getCell('N3').value], ['Cliente Beta', 'Duda Coord']);
  assert.equal(ws.getCell('L4').value, 'Total Geral');
  assert.ok(Math.abs(frac(ws.getCell('O4').value) - 660 / 1440) < 1e-9);

  // abas de apoio no mesmo visual
  assert.equal(wb.getWorksheet('Apontamentos').getCell('A1').fill.fgColor.argb, 'FF00B0F0');
  assert.equal(wb.getWorksheet('Apontamentos').getCell('A2').border.left.style, 'thin');
});

test('mês sem apontamentos: só cabeçalho e TOTAL zerado', async () => {
  const data = { projects: [], coordinators: [], hours: H.defaultHours(), timeNotes: [], timeEntries: [] };
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await buildWorkbook(data, 2026, 10, '2026-10-16')).buffer);
  const ws = wb.getWorksheet('OUTUBRO');
  assert.equal(ws.getCell('A2').value, 'TOTAL');
  assert.equal(frac(ws.getCell('F2').value), 0);
  assert.equal(ws.getCell('L2').value, 'Total Geral');
});
