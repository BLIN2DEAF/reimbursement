@echo off
setlocal EnableExtensions
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%CD%\scripts\configure-offline.ps1"
if errorlevel 1 (
  pause
  exit /b 1
)

pause
exit /b 0
