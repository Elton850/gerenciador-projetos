#!/usr/bin/env node
// Publica uma versão nova do aplicativo no canal (pasta compartilhada) — de QUALQUER computador com acesso à pasta e a senha da chave.
//   1. aumente a versão:      npm version patch   (ou minor / major)
//   2. publique:              npm run publicar -- --canal "G:\Meu Drive\GerenciadorProjetos-canal" --notas "o que mudou"
// Gera o aplicativo (npm run build:desktop; feche o app antes), assina com a chave da pasta do canal (pede a senha) e grava no canal o
// pacote de atualização e o de instalação. Opções: --sem-build (publica o app\ já gerado) · --nova-chave (a pasta ainda não tem chave:
// cria uma com a senha informada; as instalações passam a confiar nela pela tela, com a mesma senha). Senha também por GP_CHAVE_SENHA.
// A mesma publicação existe na tela: Configurações → Atualizações → Publicar esta versão.
'use strict';
const path = require('path');
const readline = require('readline');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };

// Pergunta a senha sem ecoar no terminal.
function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
    rl.question(question, (a) => { rl.close(); process.stdout.write('\n'); resolve(a); });
  });
}

(async () => {
  const canal = opt('canal');
  if (!canal) throw new Error('Informe a pasta do canal: npm run publicar -- --canal "<pasta>" --notas "<o que mudou>"');
  const channelDir = path.resolve(canal);
  const C = require('../src/channel');
  const hasKey = !!C.readKeyFile(channelDir);
  const createKey = args.includes('--nova-chave');
  if (!hasKey && !createKey) throw Object.assign(new Error('A pasta de publicação ainda não tem chave de publicação.'), { code: 'KEY_MISSING' });
  let password = process.env.GP_CHAVE_SENHA;
  if (!password) {
    password = await ask('Senha da chave de publicação: ');
    if (!hasKey && (await ask('Repita a senha: ')) !== password) throw new Error('As senhas não conferem.');
  }
  if (hasKey) C.unlockChannelKey(channelDir, password); // senha errada: avisa antes de gerar o aplicativo
  if (!args.includes('--sem-build')) execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-desktop.js')], { stdio: 'inherit' });
  const { publishApp } = require('../src/updates');
  const entry = await publishApp({
    appDir: path.join(ROOT, 'app'), channelDir, version: require('../package.json').version,
    electron: require('electron/package.json').version, schemaVersion: require('../src/migrations').SCHEMA_VERSION,
    notes: opt('notas') || '', password, createKey,
  });
  console.log(`Publicado ${entry.version} em ${channelDir} (chave ${entry.keyId})`);
  console.log(`  atualização: ${entry.update.file} (${(entry.update.size / 1048576).toFixed(1)} MB)`);
  console.log(`  instalação:  ${entry.install.file} (${(entry.install.size / 1048576).toFixed(1)} MB)`);
})().catch((e) => {
  console.error(`Falha ao publicar: ${e.message}`);
  if (e.code === 'KEY_MISSING') console.error('Para criar a chave desta pasta (uma vez): acrescente --nova-chave ao comando.');
  process.exit(1);
});
