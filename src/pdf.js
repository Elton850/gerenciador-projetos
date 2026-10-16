// PDF dos documentos gerados pelo PRÓPRIO app: o Chromium do Electron (o servidor roda no processo principal, ADR-010) imprime em A4 o
// HTML do documento numa janela invisível, sem JavaScript. Nenhum programa externo é executado (ADR-006/ADR-012 continuam valendo):
// por isso o PDF sai no layout neutro da prévia — sem o papel timbrado (cabeçalho/rodapé/logo do .docx), que só o Word reproduz.
// No modo web (node server.js, sem Electron) não há como imprimir: erro amigável. Testes trocam o renderizador (setRenderer).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { httpError, uid } = require('./util');

async function electronRender(html) {
  if (!process.versions.electron) throw httpError(501, 'O PDF só pode ser gerado no aplicativo (desktop). Baixe o Word ou abra pelo aplicativo.');
  const { BrowserWindow } = require('electron');
  // Arquivo temporário do próprio app (não é pasta do usuário): data: URL tem limite de tamanho.
  const file = path.join(os.tmpdir(), `gp-pdf-${uid()}.html`);
  fs.writeFileSync(file, html, 'utf8');
  const win = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  try {
    await win.loadFile(file);
    return await win.webContents.printToPDF({
      pageSize: 'A4', printBackground: true, margins: { top: 0.79, bottom: 0.79, left: 0.79, right: 0.79 }, // 2 cm, como o Word padrão
      displayHeaderFooter: true, headerTemplate: '<span></span>',
      footerTemplate: '<div style="width:100%;font:8px Arial,sans-serif;text-align:right;padding-right:0.79in;color:#444">Página <span class="pageNumber"></span></div>',
    });
  } finally {
    win.destroy();
    fs.rm(file, { force: true }, () => {});
  }
}

let renderer = electronRender;
const setRenderer = (fn) => { renderer = fn || electronRender; };
const htmlToPdf = (html) => renderer(html);

module.exports = { htmlToPdf, setRenderer };
