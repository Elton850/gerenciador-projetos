// PARIDADE com o app de referência "bt sql gui" (Ferramentas Auxiliares\conversor_bt_sql_gui\app.py).
// test/fixtures/bt/reference.json foi gerado rodando o código ORIGINAL (scripts/bt-parity-reference.py) sobre as fixtures de
// test/fixtures/bt/files. Aqui o MESMO fluxo de importação do app (importFile + regras de nome/agrupamento) roda com um banco
// em memória e precisa produzir exatamente os mesmos bancos, tabelas, colunas, quantidades e valores.
// Para conferir de novo contra o app original: BT_REFERENCE_APP=<caminho do app.py> npm test (precisa de Python + pandas).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const P = require('../src/tools/bt-importer/plan');
const { importFile } = require('../src/tools/bt-importer/sql');

const FIX = path.join(__dirname, 'fixtures', 'bt');
const REF = JSON.parse(fs.readFileSync(path.join(FIX, 'reference.json'), 'utf8'));

// Banco em memória com as mesmas operações do adaptador SQL (colunas novas entram como NULL nas linhas antigas).
function memoryTarget() {
  const dbs = {};
  const adapter = (database) => {
    const db = (dbs[database] ||= {});
    return {
      async getColumns(t) { return db[t] ? [...db[t].columns] : null; },
      async createTable(t, cols) { assert.ok(!db[t], `tabela ${t} criada duas vezes`); db[t] = { columns: [...cols], rows: [] }; },
      async addColumns(t, cols) { for (const c of cols) { db[t].columns.push(c); for (const r of db[t].rows) r.push(null); } },
      async insert(t, cols, rows) {
        const pos = new Map(db[t].columns.map((c, i) => [c, i]));
        for (const row of rows) { const out = new Array(db[t].columns.length).fill(null); cols.forEach((c, i) => { out[pos.get(c)] = row[i]; }); db[t].rows.push(out); }
        return rows.length;
      },
    };
  };
  return { dbs, adapter };
}

async function runScenario(sc) {
  const target = memoryTarget();
  const settings = { ...P.DEFAULT_SETTINGS, onlyAllowed: sc.onlyRequired, batchSize: sc.batchSize };
  const mappings = P.canonicalizeDatabases(sc.mappings.map(([file]) => ({ file, database: (sc.mappings.find((m) => m[0] === file) || [])[1] })));
  const warnings = [];
  for (const m of mappings) {
    target.dbs[m.database] ||= {}; // o original prepara (cria) todos os bancos do mapeamento antes de importar
    const r = await importFile(target.adapter(m.database), { filePath: path.join(FIX, 'files', m.file), settings });
    for (const a of r.altered) warnings.push(`[SCHEMA] ${m.database}.dbo.${a.table}: adicionando colunas ${a.columns.join(', ')}`);
    if (r.malformed) warnings.push(`[AVISO] ${m.file}: ${r.malformed} linha(s)`);
    if (!Object.keys(r.tables).length) warnings.push('[AVISO] sem tabela');
  }
  return { dbs: target.dbs, warnings };
}

test('paridade: lista de tabelas permitidas e nomes padrão de banco iguais aos do app original', () => {
  assert.deepEqual([...P.DEFAULT_ALLOWED_TABLES].sort(), REF.requiredTables);
  for (const [file, name] of Object.entries(REF.defaultNames)) assert.equal(P.defaultDbName(file), name, file);
});

for (const sc of REF.scenarios) {
  test(`paridade: cenário "${sc.name}" — bancos, tabelas, colunas, quantidades e valores idênticos ao app original`, async () => {
    // O mapeamento do cenário usa o nome padrão do original quando não foi informado: confere que o nosso dá o mesmo.
    for (const [file, db] of sc.mappings) assert.equal(P.canonicalizeDatabases([{ database: db }])[0].database, db, file);
    const { dbs, warnings } = await runScenario(sc);
    assert.deepEqual(dbs, Object.fromEntries(Object.entries(sc.databases)), 'conteúdo dos bancos');
    const schema = sc.warnings.filter((w) => w.startsWith('[SCHEMA]'));
    assert.deepEqual(warnings.filter((w) => w.startsWith('[SCHEMA]')), schema, 'colunas acrescentadas');
    const malformedRef = sc.warnings.filter((w) => /linha\(s\) tinham/.test(w)).map((w) => w.match(/^\[AVISO\] (.+?): (\d+) linha/).slice(1).join(':'));
    assert.deepEqual(warnings.filter((w) => /linha\(s\)$/.test(w)).map((w) => w.match(/^\[AVISO\] (.+?): (\d+) linha/).slice(1).join(':')), malformedRef, 'linhas ajustadas');
    assert.equal(warnings.filter((w) => w === '[AVISO] sem tabela').length, sc.warnings.filter((w) => /Nenhuma tabela com dados/.test(w)).length, 'arquivos sem dados');
  });
}

test('paridade: AUTO com [ARQUIVO] e nome fixo (mesmo banco para todos), como no original', () => {
  assert.equal(P.applyPattern('ZMIGRA_TESTE_[ARQUIVO]_PRD2', 'tesla.bt'), 'ZMIGRA_TESTE_TESLA_PRD2');
  assert.equal(P.applyPattern('historico', 'HIST_01.bt'), 'historico');
  assert.equal(P.applyPattern('X_[ARQUIVO]_[ARQUIVO]', 'a.bt'), 'X_A_A');
});

// Confere a referência guardada contra o app original de verdade, quando ele está disponível nesta máquina.
test('paridade: referência guardada = saída atual do app original (BT_REFERENCE_APP)', { skip: !process.env.BT_REFERENCE_APP && 'defina BT_REFERENCE_APP para rodar o app original' }, () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gp-btref-')), 'ref.json');
  const r = spawnSync('py', ['-I', path.join(__dirname, '..', 'scripts', 'bt-parity-reference.py'), process.env.BT_REFERENCE_APP, path.join(FIX, 'files'), out], { cwd: os.tmpdir(), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), REF);
});
