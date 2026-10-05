@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules (
  echo Instalando dependencias pela primeira vez...
  call npm install
)
start "" http://localhost:4317
node server.js
pause
