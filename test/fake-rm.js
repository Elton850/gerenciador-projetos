// RM SIMULADO para testes da Validação de Carga (não é uma suíte: não termina em .test.js). wsDataServer (SOAP: ReadRecord,
// ReadView, SaveRecord, DeleteRecordByKey; Fault com HTTP 200 como o RM real) + REST de Consulta SQL (GET RealizaConsulta).
// Usuário/senha fictícios: integracao / senha-ficticia. `rows[código]` = linhas que a consulta devolve.
'use strict';
const http = require('http');

const xesc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const xun = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const field = (xml, tag) => { const m = xml.match(new RegExp(`<tot:${tag}>([\\s\\S]*?)</tot:${tag}>`)); return m ? xun(m[1]) : null; };
const inner = (xml, tag) => { const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)); return m ? xun(m[1]) : null; };
// EMAIL com caractere de controle (&#x1;): o RM real devolve isso em alguns cadastros; o cliente precisa limpar.
const recXml = (c) => `<GConsSql><CODCOLIGADA>0</CODCOLIGADA><APLICACAO>S</APLICACAO><CODSENTENCA>${xesc(c.code)}</CODSENTENCA><TITULO>${xesc(c.title)}</TITULO><SENTENCA>${xesc(c.sentence.replace(/\n/g, '\r\n'))}</SENTENCA><USRULTALTERACAO>${xesc(c.user)}</USRULTALTERACAO><DTULTALTERACAO>2026-01-01T00:00:00</DTULTALTERACAO><EMAIL>x&#x1;y</EMAIL></GConsSql>`;
const envelope = (op, result) => `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><${op}Response xmlns="http://www.totvs.com/"><${op}Result>${xesc(result)}</${op}Result></${op}Response></s:Body></s:Envelope>`;
const fault = (msg) => `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>a:InternalServiceFault</faultcode><faultstring xml:lang="pt-BR">${xesc(msg)}</faultstring></s:Fault></s:Body></s:Envelope>`;

// Entende as sentenças que a ferramenta monta sobre a consulta do modelo: contagem (COUNT_BIG/MIN/MAX da coluna de divisão)
// e parte (WHERE Q.[col] BETWEEN a AND b / IS NULL). Qualquer outra devolve as linhas inteiras.
function evaluate(sentence, rows) {
  const s = String(sentence);
  if (/COUNT_BIG\(\*\) AS N/.test(s)) {
    const m = s.match(/COUNT_BIG\(Q\.\[(\w+)\]\)/);
    if (!m) return [{ N: rows.length }];
    const vals = rows.map((r) => r[m[1]]).filter((v) => v !== null && v !== undefined);
    return [{ N: rows.length, NN: vals.length, LO: vals.length ? Math.min(...vals) : null, HI: vals.length ? Math.max(...vals) : null }];
  }
  let m = s.match(/WHERE Q\.\[(\w+)\] BETWEEN (-?\d+) AND (-?\d+)$/);
  if (m) return rows.filter((r) => r[m[1]] !== null && r[m[1]] !== undefined && r[m[1]] >= Number(m[2]) && r[m[1]] <= Number(m[3]));
  m = s.match(/WHERE Q\.\[(\w+)\] IS NULL$/);
  if (m) return rows.filter((r) => r[m[1]] === null || r[m[1]] === undefined);
  return rows;
}

function createFakeRm() {
  const fake = { consultas: new Map(), ops: [], restFail: false, hang: false, rows: {}, sentences: [], filters: [] };
  fake.server = http.createServer((req, res) => {
    const auth = Buffer.from(String(req.headers.authorization || '').replace(/^Basic /, ''), 'base64').toString();
    if (auth !== 'integracao:senha-ficticia') { res.writeHead(401); res.end(); return; }
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.method === 'GET' && req.url.startsWith('/api/framework/v1/consultaSQLServer/RealizaConsulta/')) {
        const code = decodeURIComponent(req.url.split('/')[6]);
        fake.ops.push(`GET ${code}`);
        if (fake.hang) return; // RM que não responde (timeout do cliente); a conexão é derrubada em close()
        if (fake.restFail || !fake.consultas.has(code)) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"message":"erro"}'); return; }
        const sentence = fake.consultas.get(code).sentence;
        fake.sentences.push(sentence);
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(evaluate(sentence, fake.rows[code] || []))); return;
      }
      const op = String(req.headers.soapaction || '').split('/').pop();
      fake.ops.push(op);
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      const pk = (field(body, 'PrimaryKey') || '').split(';')[2];
      if (op === 'ReadRecord') { const c = fake.consultas.get(pk); res.end(envelope(op, c ? `<GlbConsSql>${recXml(c)}</GlbConsSql>` : '<GlbConsSql />')); return; }
      if (op === 'ReadView') {
        // filtro do RM: entende o "CODSENTENCA LIKE 'ZMV.%'" que a ferramenta usa (o RM real aplica o WHERE no banco)
        const filtro = field(body, 'Filtro') || ''; fake.filters.push(filtro);
        const like = filtro.match(/CODSENTENCA LIKE '([^']*)%'/);
        const list = [...fake.consultas.values()].filter((c) => !like || c.code.startsWith(like[1]));
        res.end(envelope(op, `<NewDataSet>${list.map(recXml).join('')}</NewDataSet>`)); return;
      }
      if (op === 'SaveRecord') {
        const x = field(body, 'XML');
        const c = { code: inner(x, 'CODSENTENCA'), title: inner(x, 'TITULO'), sentence: inner(x, 'SENTENCA'), user: 'integracao' };
        if (c.code.length > 16) { res.end(envelope(op, 'Cannot set column CODSENTENCA. The value violates the MaxLength limit')); return; }
        fake.consultas.set(c.code, c); res.end(envelope(op, `0;S;${c.code}`)); return;
      }
      if (op === 'DeleteRecordByKey') { fake.consultas.delete(pk); res.end(envelope(op, 'Exclusão de registro(s) realizado com sucesso')); return; }
      res.end(fault(`operação ${op} não simulada`));
    });
  });
  fake.listen = (port) => new Promise((r) => fake.server.listen(port, '127.0.0.1', r));
  fake.close = () => { fake.server.closeAllConnections(); fake.server.close(); };
  fake.conn = (port) => ({ url: `http://127.0.0.1:${port}`, user: 'integracao', password: 'senha-ficticia' });
  return fake;
}

module.exports = { createFakeRm };
