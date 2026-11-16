@echo off
setlocal
rem ============================================================
rem  Launch the game inside the bundled Electron shell.
rem  Hardware backend / vsync are stored in
rem  %APPDATA%\souls-demo\gpu-config.json and can be changed
rem  from the in-game settings page (needs a restart).
rem ============================================================

rem Some environments export ELECTRON_RUN_AS_NODE=1, which makes
rem electron.exe behave like plain node and crash. Clear it.
set "ELECTRON_RUN_AS_NODE="

cd /d "%~dp0.."

if not exist "node_modules\electron\dist\electron.exe" (
  echo [x] Electron is not installed. Run:  npm install
  pause
  exit /b 1
)

echo Starting Electron shell ...
start "" "node_modules\electron\dist\electron.exe" "electron\main.cjs"
