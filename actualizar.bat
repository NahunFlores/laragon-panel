@echo off
title Actualizar Laragon Panel
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0actualizar.ps1" %*
pause
