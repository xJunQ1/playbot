@echo off
setlocal enabledelayedexpansion

rem ============================================================
rem  Launch the local souls demo with hardware-acceleration flags.
rem  Usage:  run-hw.bat [vulkan^|d3d11^|none]
rem ============================================================

set "BACKEND=%~1"
if "%BACKEND%"=="" set "BACKEND=vulkan"
set "URL=http://127.0.0.1:5173/"
set "PROFILE=%LOCALAPPDATA%\souls-demo-hw-profile"

set "BROWSER="
for %%P in (
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
) do (
  if not defined BROWSER if exist %%P set "BROWSER=%%~P"
)

if not defined BROWSER (
  echo [x] Chrome / Edge not found. Edit BROWSER in this file.
  pause
  exit /b 1
)

set "ANGLE=--use-angle=%BACKEND%"
if /i "%BACKEND%"=="none" set "ANGLE="

echo Browser : !BROWSER!
echo ANGLE   : %BACKEND%
echo URL     : %URL%
echo Profile : %PROFILE%  ^(separate profile, your daily browser is untouched^)
echo.

start "" "!BROWSER!" %ANGLE% --enable-zero-copy --enable-gpu-rasterization --ignore-gpu-blocklist --user-data-dir="%PROFILE%" --new-window "%URL%"

echo Started. Verify with:
echo   1^) open  chrome://gpu   ^(Edge: edge://gpu^)
echo   2^) "Compositing" and "WebGL" should say Hardware accelerated
echo   3^) "GL_RENDERER" should read ANGLE ^(Intel, Vulkan ...^) or D3D11
echo   4^) back in the game, the HUD shows FPS / quality
echo.
timeout /t 6 >nul
