@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-particle-rose.ps1"
if errorlevel 1 pause
endlocal
