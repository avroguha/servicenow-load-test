@echo off
rem Runs the load test app on a Windows machine without Docker.
rem
rem   scripts\start-windows.cmd
rem
rem Needs Node.js 22 or newer and Google Chrome or Microsoft Edge. The first
rem start installs the one package the app uses. Settings and results are kept
rem in %USERPROFILE%\sn-load-test-data, outside this folder, so updating the code
rem never touches them. The app answers on this machine only:
rem
rem   http://127.0.0.1:8787      sign in: admin / admin until changed
rem
rem Close the window (or press Ctrl+C) to stop it; a run in progress is stopped
rem and its records are removed from ServiceNow first.
setlocal
cd /d "%~dp0.."
where node >nul 2>nul || (echo Node.js is not installed. Get it from nodejs.org, then run this again. & exit /b 1)
if not exist node_modules\playwright-core (
  echo Installing the app's one package...
  call npm ci --omit=dev --no-audit --no-fund || exit /b 1
)
if "%UILOAD_DATA%"=="" set "UILOAD_DATA=%USERPROFILE%\sn-load-test-data"
echo Settings and results: %UILOAD_DATA%
echo Open http://127.0.0.1:8787 in a browser.
node src\server.js
