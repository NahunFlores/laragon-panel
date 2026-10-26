@echo off
title Laragon Panel
cd /d "%~dp0"
for /f "delims=" %%p in ('node -e "try{console.log(require('./config').panelPort)}catch(e){console.log(9090)}"') do set PORT=%%p
start "" http://127.0.0.1:%PORT%
node server.js
pause
