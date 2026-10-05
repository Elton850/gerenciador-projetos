// Servidor para conferência visual (preview do app no navegador) — SEMPRE com pasta temporária, nunca o data\ real.
//   node scripts/preview-server.js   → porta 4460 (dados vazios de teste)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-preview-'));
for (const k of Object.keys(process.env)) if (k.startsWith('GP_')) delete process.env[k]; // nunca herda a configuração real
Object.assign(process.env, { GP_DATA_DIR: path.join(tmp, 'data'), GP_BACKUP_DIR: path.join(tmp, 'backups'), PORT: '4460' });
const { app } = require('../server');
app.listen(4460, '127.0.0.1', () => console.log(`preview em http://localhost:4460/ — dados temporários em ${tmp}`));
