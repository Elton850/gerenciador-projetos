// Teste local das VALIDAÇÕES da Folha no SQL Server LOCAL (nunca produção, nunca o RM): cria o banco descartável GP_LV_FOLHA_TESTE,
// grava a cópia de cada tabela do RM como a ferramenta grava (tudo NVARCHAR, gravação em massa) e cria as ZMIGRA_* com as colunas
// que as validações usam. Confere que as 13 validações compilam e que uma linha que existe no RM não aparece como "não subiu"
// (datas em texto + FORMAT(CAST(... AS DATE)), números com vírgula na carga × ponto no RM). Apaga o banco no fim.
// Uso: node scripts/e2e-lv-folha-local.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const core = require('../src/db-core');
const C = require('../src/tools/load-validator/catalog');
const SQLM = require('../src/tools/load-validator/sql');

const DB = 'GP_LV_FOLHA_TESTE';
const master = { server: 'localhost', auth: 'windows', database: 'master' };
const conn = { server: 'localhost', auth: 'windows', database: DB };
const run = (c, sql) => core.withPool(c, '', (h) => new h.sql.Request(h.pool).batch(sql));
const q = (s) => `[${s.replace(/]/g, ']]')}]`;

// Uma linha "do RM" (como a API devolve: data ISO com fuso, visto nos backups reais) e a linha equivalente da carga (TXT do Hop).
// A data com hora (DTMUDANCA) prova que a validação compara só o dia (LEFT 10), como o arquivo de origem.
const D = '2024-03-05T00:00:00-03:00'; const DDMM = '05032024';
const RM = { CODCOLIGADA: 1, CHAPA: '00001', NOME: 'FULANO', NRODEPEND: 1, CPF: '00000000000', DTNASCIMENTO: D, FIMPERAQUIS: D, INICIOPERAQUIS: D, PERIODOABERTO: 1, DATAPAGTO: D, DATAINICIO: D, DATAFIM: D, DATAAVISO: D,
  IRRF: 10.5, BASEIRRF: 1000.25, LIQUIDO: 900.75, CODEVENTO: '001', REF: 30, VALOR: 1234.5, DTMUDANCA: '2024-03-05T14:37:12-03:00', MOTIVO: '01', SALARIO: 2500.1, CODFUNCAO: '10', CODSECAO: '01.01', DATAMUDANCA: D, NOVASITUACAO: 'A',
  DTCONTRIBUICAO: D, CODSINDICATO: '05', NRODEPENDIRRF: 1, NRODEPENDSALFAM: 0, DTINICIO: D, DTFINAL: null, TIPO: 'P', ANOCOMP: 2024, MESCOMP: 3, NROPERIODO: 1, BASEINSS: 1000.25, BASEFGTS: 1000.25, DTPAGTO: D, VALORORIGINAL: 1234.5 };
function cargaValue(col, rmCol) { // valor da carga para a coluna da ZMIGRA, a partir do nome usado na validação
  if (/^Data|DATAMUDANCA$/i.test(col)) return /hh:mm/.test(col) || col === 'DATAMUDANCA' ? `${DDMM} 00:00:00` : DDMM;
  if (rmCol !== undefined && typeof rmCol === 'number') return String(rmCol).replace('.', ',');
  return rmCol === undefined ? null : rmCol;
}

(async () => {
  await run(master, `IF DB_ID('${DB}') IS NOT NULL BEGIN ALTER DATABASE [${DB}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${DB}] END; CREATE DATABASE [${DB}]`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-lvf-'));
  try {
    const sys = C.systemOf('folha');
    const ctx = { progress: () => {}, isCancelled: () => false };
    for (const t of sys.tables) {
      const cols = C.outputColumns(C.renderRm(t, { coligada: 1, periods: '' }));
      const file = path.join(tmp, `${t.table}.json`);
      fs.writeFileSync(file, JSON.stringify({ columns: cols, rows: [cols.map((c) => (RM[c] === null || RM[c] === undefined ? null : String(RM[c])))] }));
      const r = await SQLM.replace(core, conn, '', { table: t.table, rowsFile: file, allowed: [t.table] }, ctx);
      assert.equal(r.mode, 'bulk', t.table);
      for (const v of t.validations) {
        const src = C.sourceOf(v.sql);
        const used = new Set([...v.sql.matchAll(new RegExp(`${src}\\.(?:\\[([^\\]]+)\\]|(\\w+))`, 'g'))].map((m) => m[1] || m[2]).filter((c) => c !== '*'));
        const rmOf = (c) => { const k = Object.keys(RM).find((x) => x.toUpperCase() === c.toUpperCase()); if (k) return RM[k];
          const map = { 'Nome do Dependente': 'NOME', 'Desconto de Irrf': 'IRRF', 'Base de Irrf': 'BASEIRRF', 'Valor Líquido do Recibo de Fêrias': 'LIQUIDO', 'Valor referência do evento': 'REF', 'Valor da verba': 'VALOR',
            'Motivo de alteração salarial': 'MOTIVO', 'Valor atual do salário': 'SALARIO', 'Código do Motivo da Mud. De Função': 'MOTIVO', 'Código da Função': 'CODFUNCAO', 'Código do Motivo da Mud. De Seção': 'MOTIVO',
            'Código da Seção': 'CODSECAO', 'Código do sindicato': 'CODSINDICATO', 'Data final': 'DTFINAL', 'Motivo do afastamento': 'MOTIVO', 'Ano de Competência': 'ANOCOMP', 'Mês de Competência': 'MESCOMP',
            'Número do Período': 'NROPERIODO', 'Código do Evento': 'CODEVENTO', 'Referência': 'REF', 'Valor': 'VALOR', 'Valor original': 'VALORORIGINAL' };
          return RM[map[c]]; };
        const list = [...used];
        await run(conn, `CREATE TABLE dbo.${q(src)} (${list.map((c) => `${q(c)} NVARCHAR(200) NULL`).join(', ')})`);
        const vals = list.map((c) => { const rv = rmOf(c); const cv = c === 'Data final' && rv === null ? null : cargaValue(c, rv); return cv === null ? 'NULL' : `N'${String(cv).replace(/'/g, "''")}'`; });
        // carga com DUAS coligadas num arquivo só (como as ZMIGRA da BOA LOCAÇÃO): coligada 1 = linha igual ao RM + CHAPA 99999
        // (não subiu); coligada 3 = linha que não está no RM (o RM só tem a coligada 1)
        const other = list.map((c, i) => (c.toUpperCase() === 'CODCOLIGADA' ? "N'3'" : vals[i]));
        await run(conn, `INSERT dbo.${q(src)} VALUES (${vals.join(', ')}), (${list.map((c) => (/^CHAPA$|^Chapa$/.test(c) ? "N'99999'" : vals[list.indexOf(c)])).join(', ')}), (${other.join(', ')})`);
      }
    }
    const items = sys.tables.flatMap((t) => t.validations.map((v) => ({ label: v.label, sql: v.sql, source: C.sourceOf(v.sql), file: path.join(tmp, `NAO_SUBIU_${v.label}.csv`) })));
    const val = (extra) => SQLM.validate(core, conn, '', { items, ...extra }, { progress: () => {} });
    // sem coligadas (como antes): a carga inteira — a coligada 3 entra como "não subiu"
    for (const v of await val({})) { assert.equal(v.error, undefined, `${v.label}: ${v.error}`); assert.deepEqual([v.label, v.carga, v.missing], [v.label, 3, 2], v.label); }
    // só a coligada 1: a coligada 3 da carga fica de fora
    for (const v of await val({ coligadas: [1] })) {
      assert.equal(v.error, undefined, `${v.label}: ${v.error}`);
      assert.deepEqual([v.label, v.carga, v.missing, v.scoped, v.byColigada], [v.label, 2, 1, true, [{ coligada: 1, carga: 2, missing: 1 }]], `${v.label}: a linha igual ao RM sobe; só a CHAPA 99999 "não subiu"`);
    }
    // coligadas 1 e 3: quebra por coligada (a 3 não está no RM: 100% "não subiu")
    for (const v of await val({ coligadas: [1, 3] })) assert.deepEqual([v.carga, v.missing, v.byColigada], [3, 2, [{ coligada: 1, carga: 2, missing: 1 }, { coligada: 3, carga: 1, missing: 1 }]], v.label);
    // RM sem linhas nas coligadas: toda a carga delas "não subiu", sem comparar com a cópia da base
    const empty = await SQLM.validate(core, conn, '', { items: items.map((i) => ({ ...i, rmEmpty: true })), coligadas: [3] }, { progress: () => {} });
    for (const v of empty) assert.deepEqual([v.carga, v.missing, v.rmEmpty], [1, 1, true], v.label);
    console.log(`e2e Validação de Carga (Folha): OK — ${items.length} validações compilaram e casaram com a cópia em texto, por coligada`);
  } finally {
    await run(master, `ALTER DATABASE [${DB}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${DB}]`).catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
