@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Reimbursement Automation

echo.
echo [1/4] Checking Node.js...
where node.exe >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js was not found.
  echo Install Node.js 20 or newer, then run this file again.
  echo https://nodejs.org/
  goto :failed
)

where npm.cmd >nul 2>&1
if errorlevel 1 (
  echo [ERROR] npm.cmd was not found.
  echo Repair the Node.js installation, then run this file again.
  goto :failed
)

echo.
echo [2/4] Checking configuration...
if not exist ".env" (
  if not exist ".env.example" (
    echo [ERROR] Both .env and .env.example are missing.
    goto :failed
  )
  copy /Y ".env.example" ".env" >nul 2>&1
  echo [ACTION REQUIRED] A new .env file was created.
  echo Configure the model API, BIP account, bank account, payment bank, and budget item.
  echo File: %CD%\.env
  echo Also copy fill-config.example.json to fill-config.json and complete it.
  goto :failed
)

echo.
echo [3/4] Checking dependencies...
if not exist "node_modules\.bin\tsx.cmd" (
  echo Installing Node.js dependencies. This may take a few minutes...
  call npm.cmd install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    goto :failed
  )
)

where pdftoppm.exe >nul 2>&1
if errorlevel 1 where pdftoppm.cmd >nul 2>&1
if errorlevel 1 (
  echo [WARNING] pdftoppm was not found. Scanned PDF recognition is unavailable.
  echo Text PDFs and JPG/PNG images can still be processed.
)

echo.
echo [4/4] Checking local service port...
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
node.exe "%CD%\scripts\start-preflight.mjs"
set "PREFLIGHT_EXIT_CODE=%ERRORLEVEL%"
if "%PREFLIGHT_EXIT_CODE%"=="10" goto :already_running
if "%PREFLIGHT_EXIT_CODE%"=="30" goto :old_node
if not "%PREFLIGHT_EXIT_CODE%"=="0" goto :failed

echo Starting service...
echo ========================================================
echo Open this address in your browser:
echo %APP_URL%
echo The browser will open automatically after the service starts.
echo Keep this window open while using the application.
echo ========================================================
echo.

rem The service opens the browser itself once it is listening.
if not defined REIMBURSEMENT_NO_BROWSER set "REIMBURSEMENT_OPEN_BROWSER=1"

rem Run the server as a single node process so closing this window stops it completely.
node.exe --import tsx "%CD%\src\server.ts"
set "APP_EXIT_CODE=%ERRORLEVEL%"
goto :stopped

:old_node
rem Node older than 20.6 cannot use --import; fall back to npm start.
if not defined REIMBURSEMENT_NO_BROWSER set "REIMBURSEMENT_OPEN_BROWSER=1"
call npm.cmd start
set "APP_EXIT_CODE=%ERRORLEVEL%"

:stopped
echo.
if not "%APP_EXIT_CODE%"=="0" (
  echo [ERROR] The service stopped with exit code %APP_EXIT_CODE%.
) else (
  echo The service has stopped.
)
pause
exit /b %APP_EXIT_CODE%

:already_running
echo.
echo ========================================================
echo The reimbursement service is already running.
echo Opening the existing page instead of starting it again.
echo ========================================================
if not defined REIMBURSEMENT_NO_BROWSER start "" "%APP_URL%"
exit /b 0

:failed
echo.
echo Startup did not complete. Review the message above.
pause
exit /b 1
