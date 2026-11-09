// Teste de CONEXÃO com a API do RM (só leitura) usando LINK_API, LOGIN_RM e PASSWORD_RM de um .env — para conferir o acesso antes
// de usar a Validação de Carga. Faz exatamente o "Testar" da ferramenta: autentica, procura a consulta ZMV.TESTE (que não existe)
// no cadastro de Consultas SQL e chama a API REST de Consulta SQL. NÃO cria, executa nem apaga consulta nenhuma. A senha nunca é
// mostrada. Uso: node scripts/lv-testar-conexao-rm.js ["C:\Gerenciador de Projetos\.env"] [S|P]   (P = Folha; padrão: os dois)
'use strict';
const fs = require('fs');
const RM = require('../src/tools/load-validator/rm');

const envFile = process.argv[2] || 'C:\\Gerenciador de Projetos\\.env';
const systems = process.argv[3] ? [process.argv[3].toUpperCase()] : ['S', 'P'];

function readEnv(file) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
    if (m && !line.trim().startsWith('#')) out[m[1].toUpperCase()] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

(async () => {
  const env = readEnv(envFile);
  const missing = ['LINK_API', 'LOGIN_RM', 'PASSWORD_RM'].filter((k) => !env[k]);
  if (missing.length) throw new Error(`Faltam no ${envFile}: ${missing.join(', ')}`);
  const rm = { url: RM.cleanUrl(env.LINK_API), user: env.LOGIN_RM, password: env.PASSWORD_RM };
  console.log(`RM: ${rm.url} · usuário ${rm.user} · senha: (oculta)`);
  let falhou = false;
  for (const s of systems) {
    try {
      const r = await RM.test(rm, s);
      console.log(`[ok] sistema ${s} (${s === 'P' ? 'Folha' : s === 'S' ? 'Educacional' : '?'}): conectado em ${r.ms} ms`);
    } catch (e) { falhou = true; console.log(`[X] sistema ${s}: ${e.message}`); }
  }
  process.exitCode = falhou ? 1 : 0;
})().catch((e) => { console.error(`[X] ${e.message}`); process.exitCode = 1; });
