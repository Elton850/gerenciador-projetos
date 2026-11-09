// Gera src/tools/load-validator/catalog-folha.js a partir de docs/fontes/"SQL FOLHA - VERIFICA DIFERENCA ENTRE RM E ORIGEM.txt"
// (cópia do "SQL - VERIFICA DIFERENÇA ENTRE RM E ORIGEM" da área de migração). Uso: node scripts/gera-catalogo-folha.js
//
// Cada bloco do arquivo: título entre linhas "=====", "-USAR NO RM" + consulta do RM e (quase sempre) a consulta de validação na
// base de migração (ZMIGRA_* × cópia do RM). Adaptações — as MESMAS regras do modelo do Educacional, nada além disso:
//  1. Coligada: o arquivo da Folha não filtra; acrescenta "WHERE CODCOLIGADA = {{CODCOLIGADA}}" (o do Educacional já tinha o filtro).
//  2. Datas: a cópia do RM é gravada como texto; datas saem do RM já em texto, CONVERT(VARCHAR(19), col, 120) = AAAA-MM-DD HH:MM:SS
//     (o Educacional usa a mesma técnica com o estilo 23). Sem isso o RM devolve "2026-02-04T00:00:00-03:00".
//  3. Validações: FORMAT(<tabela RM>.<data>, ...) vira FORMAT(CAST(<tabela RM>.<data> AS DATE), ...) — FORMAT não aceita texto.
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'docs', 'fontes', 'SQL FOLHA - VERIFICA DIFERENCA ENTRE RM E ORIGEM.txt');
const OUT = path.join(__dirname, '..', 'src', 'tools', 'load-validator', 'catalog-folha.js');
const DATE_COL = /^(DT\w*|DATA\w*|\w*PERAQUIS)$/;

function blocks(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out = []; let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^=+$/.test(l.trim()) && lines[i + 1] && /=+$/.test(lines[i + 1].trim()) && !/^=+$/.test(lines[i + 1].trim())) {
      cur = { title: lines[i + 1].replace(/=+$/, '').trim(), body: [] }; out.push(cur); i += 2; continue;
    }
    if (cur) cur.body.push(l);
  }
  return out;
}

// Separa o bloco em: consulta do RM (depois de "-USAR NO RM") e consulta de validação (o SELECT seguinte, até o fim).
function split(body) {
  const text = body.join('\n');
  const rmAt = text.search(/^-USAR NO RM\s*$/m);
  if (rmAt < 0) throw new Error('bloco sem -USAR NO RM');
  const after = text.slice(rmAt).split('\n').slice(1).join('\n');
  const parts = after.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const rm = parts.shift();
  const rest = parts.join('\n\n').replace(/^-[^\n]*\n/gm, '').trim(); // tira rótulos como "-VERIFICA PERIODOS DE FICHA"
  return { rm, validation: rest || null };
}

function adaptRm(sql) {
  const m = sql.match(/^SELECT\s+([\s\S]*?)\s+FROM\s+(\w+)\s*$/i);
  if (!m) throw new Error(`consulta do RM fora do formato esperado:\n${sql}`);
  const cols = m[1].split(',').map((c) => c.trim()).filter(Boolean);
  const table = m[2].toUpperCase();
  const sel = cols.map((c) => (DATE_COL.test(c) ? `CONVERT(VARCHAR(19), ${c}, 120) AS ${c}` : c));
  return { table, cols, sql: `SELECT\n  ${sel.join(',\n  ')}\nFROM ${table}\nWHERE CODCOLIGADA = {{CODCOLIGADA}}` };
}

function adaptValidation(sql, table) {
  return sql.replace(new RegExp(`FORMAT\\(\\s*${table}\\.(\\w+)\\s*,`, 'g'), (_, c) => `FORMAT(CAST(${table}.${c} AS DATE),`)
    .replace(/[ \t]+$/gm, '').replace(/\t/g, ' ');
}

const tables = blocks(fs.readFileSync(SRC, 'utf8')).map((b) => {
  const { rm, validation } = split(b.body);
  const r = adaptRm(rm);
  return { table: r.table, title: b.title, rmSql: r.sql, validations: validation ? [{ label: r.table, sql: adaptValidation(validation, r.table) }] : [] };
});

const head = `// GERADO por scripts/gera-catalogo-folha.js a partir de docs/fontes/"SQL FOLHA - VERIFICA DIFERENCA ENTRE RM E ORIGEM.txt".
// Não editar à mão: rode o gerador. Adaptações (iguais às do Educacional): filtro da coligada, datas do RM em texto
// (CONVERT 120) e CAST(... AS DATE) nas validações. Parâmetro: {{CODCOLIGADA}}.
// TABLES: ordem do arquivo de origem. rmSql roda NO RM (consulta temporária, sistema P); validations rodam NA BASE DE MIGRAÇÃO (só
// leitura) e devolvem as linhas da carga (ZMIGRA_*) que não estão na cópia do RM. COMPLEMENT: vazio (não há chaves de TXT da Folha).
'use strict';

`;
const body = `const TABLES = ${JSON.stringify(tables.map(({ title, ...t }) => ({ ...t, title })), null, 2)};

const COMPLEMENT = [];

module.exports = { TABLES, COMPLEMENT };
`;
fs.writeFileSync(OUT, head + body);
console.log(`${tables.length} tabelas → ${path.relative(process.cwd(), OUT)}`);
for (const t of tables) console.log(`  ${t.table.padEnd(16)} validações: ${t.validations.length}  (${t.title})`);
