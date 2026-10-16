// PDF do documento gerado = o MESMO .docx (papel timbrado + formatação copiada do original) convertido pelo Word instalado.
// Exceção estreita ao ADR-006 registrada no ADR-017: script PowerShell FIXO (dados só por variáveis de ambiente), Word invisível com
// macros desativadas, abre SÓ o .docx que o app acabou de gerar, numa pasta temporária do app (nunca pasta do usuário), somente leitura,
// fora dos "recentes"; exporta PDF e fecha o documento. Se o Word já estava aberto pelo usuário, nunca o fecha. Uma conversão por vez.
// Sem Word (ou falha) → quem chama usa o PDF do próprio app (src/pdf.js). Testes trocam o conversor (setRunner).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { uid } = require('./util');
const { runPowerShell } = require('./powershell');

const NO_WORD = 'WORD_NOT_FOUND';
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$in = $env:GP_DOCX_IN; $out = $env:GP_PDF_OUT
try { $w = New-Object -ComObject Word.Application } catch { [Console]::Error.Write('WORD_NOT_FOUND'); exit 3 }
$doc = $null
$own = (-not $w.Visible) -and ($w.Documents.Count -eq 0)   # instância criada agora (não a do usuário)
$alerts = $w.DisplayAlerts; $security = $w.AutomationSecurity
try {
  $w.DisplayAlerts = 0
  $w.AutomationSecurity = 3                                  # msoAutomationSecurityForceDisable: nenhuma macro roda
  $doc = $w.Documents.Open($in, $false, $true, $false)        # ConfirmConversions, ReadOnly, AddToRecentFiles
  $doc.SaveAs2($out, 17)                                      # wdFormatPDF
} finally {
  if ($doc) { $doc.Close(0); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($doc) }
  $w.DisplayAlerts = $alerts; $w.AutomationSecurity = $security
  if ($own -and $w.Documents.Count -eq 0) {
    $w.NormalTemplate.Saved = $true                              # nenhuma pergunta invisível sobre o Normal.dotm ao sair
    $w.Quit()                                                    # sem argumento (no PowerShell 5.1, Quit(0) exige [ref])
  }
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($w); [GC]::Collect(); [GC]::WaitForPendingFinalizers()
}
`;

async function wordRun(docx) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gp-word-${uid()}-`));
  const inFile = path.join(dir, 'documento.docx');
  const outFile = path.join(dir, 'documento.pdf');
  try {
    fs.writeFileSync(inFile, docx);
    try {
      await runPowerShell(SCRIPT, { env: { GP_DOCX_IN: inFile, GP_PDF_OUT: outFile }, timeoutMs: 120000 });
    } catch (e) {
      if (e.exitCode === 3 || String(e.message).includes(NO_WORD)) throw Object.assign(new Error('Microsoft Word não encontrado neste computador.'), { code: NO_WORD });
      throw new Error(`O Word não conseguiu converter o documento: ${e.message}`);
    }
    const pdf = fs.readFileSync(outFile);
    if (pdf.slice(0, 5).toString() !== '%PDF-') throw new Error('O Word não gerou um PDF válido.');
    return pdf;
  } finally {
    fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }, () => {}); // o Word pode levar um instante para soltar o arquivo
  }
}

let runner = wordRun;
let queue = Promise.resolve();
const setRunner = (fn) => { runner = fn || wordRun; };
// Uma conversão por vez (o Word por automação não lida bem com chamadas simultâneas).
function docxToPdf(docx) {
  const job = queue.then(() => runner(docx));
  queue = job.catch(() => {});
  return job;
}

module.exports = { docxToPdf, setRunner, NO_WORD };
