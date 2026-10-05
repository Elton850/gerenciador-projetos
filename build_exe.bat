@echo off
rem Gera o aplicativo desktop "Gerenciador de Projetos.exe" na pasta app\ (requer Node.js; a primeira vez baixa o Electron).
rem Os dados ficam na pasta "data" ao lado da pasta app\ - a mesma usada pelo modo web (iniciar.bat).
cd /d "%~dp0"
if not exist node_modules call npm install
call npm run build:desktop
pause
