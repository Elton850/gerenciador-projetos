#!/usr/bin/env node
// Publica uma versão nova do aplicativo no canal (pasta compartilhada) — computador de desenvolvimento.
//   1. aumente a versão:      npm version patch   (ou minor / major)
//   2. publique:              npm run publicar -- --canal "D:\OneDrive\GerenciadorProjetos-canal" --notas "o que mudou"
// Gera o aplicativo (npm run build:desktop; feche o app antes), assina e grava no canal o pacote de atualização e o de instalação.
// Opções: --sem-build (publica o app\ já gerado). A mesma publicação existe na tela: Configurações → Atualizações → Publicar esta versão.
'use strict';
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };

(async () => {
  const canal = opt('canal');
  if (!canal) throw new Error('Informe a pasta do canal: npm run publicar -- --canal "<pasta>" --notas "<o que mudou>"');
  if (!args.includes('--sem-build')) execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-desktop.js')], { stdio: 'inherit' });
  const { publishApp } = require('../src/updates');
  const { protect, unprotect } = require('../src/secrets');
  const entry = await publishApp({
    appDir: path.join(ROOT, 'app'), channelDir: path.resolve(canal), version: require('../package.json').version,
    electron: require('electron/package.json').version, schemaVersion: require('../src/migrations').SCHEMA_VERSION,
    notes: opt('notas') || '', protect, unprotect,
  });
  console.log(`Publicado ${entry.version} em ${path.resolve(canal)}`);
  console.log(`  atualização: ${entry.update.file} (${(entry.update.size / 1048576).toFixed(1)} MB)`);
  console.log(`  instalação:  ${entry.install.file} (${(entry.install.size / 1048576).toFixed(1)} MB)`);
})().catch((e) => { console.error(`Falha ao publicar: ${e.message}`); process.exit(1); });
