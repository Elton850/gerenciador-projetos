// Gera as fixtures .bt (dados fictícios) usadas no teste de paridade com o app de referência "bt sql gui".
// Os bytes são gravados em latin-1, como os arquivos reais. Rodar: node test/fixtures/bt/make.js
// Depois de mudar uma fixture, gere de novo a referência: scripts/bt-parity-reference.py (ver o cabeçalho dele).
const fs = require('fs');
const path = require('path');

const out = path.join(__dirname, 'files');
fs.mkdirSync(out, { recursive: true });
const write = (name, text) => fs.writeFileSync(path.join(out, name), Buffer.from(text, 'latin1'));

// 1) Dois blocos permitidos, CRLF, '|' no fim da linha, '$XX', '@' = NULL.
write('CLIENTES_01.bt', [
  '[EPG]',
  '[CODIGO:s;NOME:s;CIDADE:s]',
  '001|Cliente Alfa|S$E3o Paulo|',
  '002|Cliente Beta|@|',
  '003||Curitiba|',
  '[EMP]',
  '[CODEMP:n;RAZAO:s]',
  '1|Empresa Exemplo LTDA',
  '2|Com $7C barra',
  '',
].join('\r\n'));

// 2) Mesmo bloco EPG com caixa diferente e coluna nova (alinha e acrescenta coluna), LF, e lote maior que 100 linhas.
const many = [];
for (let i = 1; i <= 250; i++) many.push(`${String(i).padStart(4, '0')}|nome ${i}|Cidade ${i % 7}|${i % 3 ? 'A' : '@'}`);
write('CLIENTES_02.bt', ['[EPG]', '[codigo:s;Nome:s;CIDADE:s;STATUS:s]', ...many, '[EMP]', '[CODEMP:n;RAZAO:s]', '3|Outra Empresa', ''].join('\n'));

// 3) Casos especiais: campos repetidos/vazios, linhas com campos a menos/mais, \r sozinho como fim de linha, linhas em branco
// com espaços, bloco sem cabeçalho, "[]", bloco fora da lista, "$40" vira '@' (e então NULL), acentos latin-1, \xa0 e \x1c.
write('ESPECIAIS.bt', [
  '  [EST]  ',
  '[ID:n;ID:s;;nome:s;NOME:s]',
  '1|a|b|c|d',
  '2|x',
  '3|a|b|c|d|e|f',
  '4|a|b|c|d|||',
  '5|$40|$4a$4A|$ZZ|ação é Ç',
  '\xa0',
  '\x1c[FOL]\x1c',
  '9|sem cabeçalho',
  '[FOL]',
  '[MATRIC]',
  '[]',
  'linha sem bloco',
  '[ZZZ_FORA]',
  '[A:s;B:s]',
  '1|2',
  '[TB_MOT_DES]',
  '[MOTIVO:s;DESCR:s]',
  'M1|Motivo   com espaços  ',
  '   ',
  'M2|$',
].join('\r'));

// 4) Vazio e 5) sem nenhum bloco (formato não reconhecido).
write('VAZIO.bt', '');
write('INVALIDO.bt', 'isto nao e um arquivo bt\nsem blocos\n');
console.log(`fixtures em ${out}`);
