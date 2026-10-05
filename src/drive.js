// Link de pasta do Google Drive: usado só para o atalho "Abrir no Google Drive" (o app não navega dentro do
// Drive, nem baixa nada de lá — é uma referência, como o link do Google Sheets nas planilhas).
function parseDriveFolderUrl(url) {
  let u;
  try { u = new URL(String(url).trim()); } catch { return null; }
  if (u.protocol !== 'https:' || u.hostname !== 'drive.google.com') return null;
  return { url: u.toString() };
}

module.exports = { parseDriveFolderUrl };
