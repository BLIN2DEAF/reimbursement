@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Reimbursement Automation Offline

set "OFFLINE_NODE=%CD%\runtime\node\node.exe"
set "OFFLINE_BROWSER=%CD%\runtime\ms-playwright"
set "OFFLINE_POPPLER_BIN=%CD%\runtime\poppler\Library\bin"

if not exist "%OFFLINE_NODE%" (
  echo [ERROR] Bundled Node.js runtime is missing.
  echo Please extract the complete offline ZIP again.
  goto :failed
)
set "OFFLINE_CHROMIUM_FOUND="
for /d %%D in ("%OFFLINE_BROWSER%\chromium-*") do (
  if exist "%%~fD\chrome-win64\chrome.exe" set "OFFLINE_CHROMIUM_FOUND=1"
)
if not defined OFFLINE_CHROMIUM_FOUND (
  echo [ERROR] Bundled Chromium runtime is missing.
  echo Please extract the complete offline ZIP again.
  goto :failed
)
if not exist "%OFFLINE_POPPLER_BIN%\pdftoppm.exe" (
  echo [ERROR] Bundled Poppler runtime is missing.
  echo Please extract the complete offline ZIP again.
  goto :failed
)

if not exist ".env" goto :configure
if not exist "fill-config.json" goto :configure
goto :configured

:configure
echo First-time configuration is required.
call "%CD%\1-????.bat"
if errorlevel 1 goto :failed

:configured
set "REIMBURSEMENT_OFFLINE=1"
set "PLAYWRIGHT_BROWSERS_PATH=%OFFLINE_BROWSER%"
set "PATH=%OFFLINE_POPPLER_BIN%;%PATH%"

set "APP_HOST=127.0.0.1"
set "APP_PORT=8080"
for /f "usebackq tokens=1,* delims==" %%A in ("%CD%\.env") do (
  if /I "%%A"=="HOST" set "APP_HOST=%%B"
  if /I "%%A"=="PORT" set "APP_PORT=%%B"
)
set "APP_HOST=%APP_HOST:"=%"
set "APP_PORT=%APP_PORT:"=%"
set "APP_BROWSER_HOST=%APP_HOST%"
if "%APP_BROWSER_HOST%"=="0.0.0.0" set "APP_BROWSER_HOST=127.0.0.1"
if "%APP_BROWSER_HOST%"=="::" set "APP_BROWSER_HOST=127.0.0.1"
if "%APP_BROWSER_HOST%"=="[::]" set "APP_BROWSER_HOST=127.0.0.1"
set "APP_URL=http://%APP_BROWSER_HOST%:%APP_PORT%"

"%OFFLINE_NODE%" "%CD%\scripts\start-preflight.mjs"
set "PREFLIGHT_EXIT_CODE=%ERRORLEVEL%"
if "%PREFLIGHT_EXIT_CODE%"=="10" goto :already_running
if not "%PREFLIGHT_EXIT_CODE%"=="0" goto :failed

echo.
echo Starting the offline reimbursement system...
echo Keep this window open while using the application.
echo Address: %APP_URL%
rem The service opens the browser itself once it is listening.
if not defined REIMBURSEMENT_NO_BROWSER set "REIMBURSEMENT_OPEN_BROWSER=1"

rem Single node process: closing this window stops the service completely.
"%OFFLINE_NODE%" --import tsx "%CD%\src\server.ts"
set "APP_EXIT_CODE=%ERRORLEVEL%"
if not "%APP_EXIT_CODE%"=="0" echo [ERROR] The service stopped with exit code %APP_EXIT_CODE%.
pause
exit /b %APP_EXIT_CODE%

:already_running
echo The reimbursement service is already running at %APP_URL%.
if not defined REIMBURSEMENT_NO_BROWSER start "" "%APP_URL%"
exit /b 0

:failed
echo.
echo Startup did not complete. Review the message above.
pause
exit /b 1
