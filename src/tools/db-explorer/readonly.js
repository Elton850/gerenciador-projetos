// Explorador de Banco — trava do Console SQL: só UMA consulta de leitura (SELECT ou WITH … SELECT).
// Usa o analisador léxico do app (sqlscan.splitBatches): as regras olham só o "código" (comentários, textos '…' e nomes entre
// colchetes/aspas viram espaços), então "DELETE" dentro de um texto ou comentário não bloqueia e não engana a trava.
// Defesa em profundidade: a execução (sql.js) roda numa transação SEMPRE desfeita no final e lê no máximo N linhas.
const { splitBatches } = require('../../sqlscan');

const MAX_SQL_CHARS = 100000;
const BLOCKED = [
  [/\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|DROP|ALTER|CREATE|GRANT|REVOKE|DENY)\b/gi, 'altera dados ou estrutura'],
  [/\bINTO\b/gi, 'SELECT … INTO cria tabela'],
  [/\b(EXEC|EXECUTE)\b/gi, 'executa procedimento ou SQL dinâmico'],
  [/\b(sp_\w+|xp_\w+)/gi, 'procedimento de sistema'],
  [/\b(BACKUP|RESTORE|DBCC|USE|SHUTDOWN|KILL|RECONFIGURE|CHECKPOINT|BULK)\b/gi, 'comando administrativo'],
  [/\b(OPENROWSET|OPENDATASOURCE|OPENQUERY|OPENXML)\b/gi, 'acesso a fonte externa'],
  [/\b(WAITFOR|DECLARE|SET|BEGIN|COMMIT|ROLLBACK|SAVE|GOTO|RAISERROR|THROW|PRINT)\b/gi, 'só consultas: sem variáveis, blocos ou controle de transação'],
  [/\bNEXT\s+VALUE\s+FOR\b/gi, 'NEXT VALUE FOR avança uma sequência'],
];

function checkReadOnly(sql) {
  const text = String(sql || '');
  if (!text.trim()) return { ok: false, errors: ['Informe uma consulta.'] };
  if (text.length > MAX_SQL_CHARS) return { ok: false, errors: [`Consulta grande demais (máx. ${MAX_SQL_CHARS.toLocaleString('pt-BR')} caracteres).`] };
  const { batches, sqlcmdLines } = splitBatches(text);
  const errors = [];
  if (sqlcmdLines.length) errors.push('Diretivas SQLCMD (:comando) não são permitidas.');
  if (batches.length !== 1) errors.push('Use uma única consulta (sem GO).');
  const code = batches.map((b) => b.code).join('\n');
  const body = code.replace(/;\s*$/, '');
  if (body.includes(';')) errors.push('Use uma única consulta (sem “;” no meio).');
  const first = (body.match(/^\s*\(*\s*([A-Za-z]+)/) || [])[1];
  if (!first || !/^(SELECT|WITH)$/i.test(first)) errors.push('A consulta deve começar com SELECT ou WITH.');
  const found = new Map();
  for (const [re, why] of BLOCKED) for (const m of body.matchAll(re)) found.set(m[0].toUpperCase().replace(/\s+/g, ' '), why);
  if (found.size) errors.push(`Bloqueado no Console (somente leitura): ${[...found].map(([k, why]) => `${k} — ${why}`).join('; ')}.`);
  return errors.length ? { ok: false, errors } : { ok: true, errors: [], sql: text.trim().replace(/;\s*$/, '') };
}

module.exports = { checkReadOnly, MAX_SQL_CHARS };
