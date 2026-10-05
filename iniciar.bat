@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules (
  echo Instalando dependencias pela primeira vez...
  call npm install
)
rem O proprio servidor abre o navegador (no modo nuvem, com o endereco de inicializacao protegido).
set GP_OPEN_BROWSER=1
node server.js
pause
