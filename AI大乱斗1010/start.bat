@echo off
rem ===========================================================================
rem  AI Arena - ASCII-named launcher (same as the Chinese-named .bat)
rem  Double-click this file, or the Chinese-named one, whichever you prefer.
rem  This file is intentionally ASCII-only so it never garbles in any codepage.
rem ===========================================================================
chcp 65001 >nul 2>nul
title AI Arena
cd /d "%~dp0"

rem Must be cleared: some environments set this variable, which makes Electron
rem fall back to plain Node, so nothing but a flashing console would appear.
set "ELECTRON_RUN_AS_NODE="

if not exist "node_modules\electron\dist\electron.exe" goto NO_DEPS
if not exist "scripts\launch.js" goto NO_FILES

echo.
echo   Starting AI Arena ... a window will open in a few seconds.
echo   Keep this console open while using the app.
echo   Press Ctrl+C here to quit the app.
echo.

node "scripts\launch.js"
set "EXITCODE=%ERRORLEVEL%"

echo.
if not "%EXITCODE%"=="0" (
  echo   [X] The app exited with error code %EXITCODE%.
  echo       Read the messages above, or see README.md section 1.
) else (
  echo   [OK] The app has closed.
)
echo.
echo   Press any key to close this window...
pause >nul
exit /b %EXITCODE%

:NO_DEPS
echo.
echo   [X] Dependencies are missing: node_modules\electron not found.
echo       Fix: open CMD in this folder and run   npm install
echo.
pause
exit /b 1

:NO_FILES
echo.
echo   [X] scripts\launch.js not found.
echo       Keep this .bat file in the project root folder.
echo.
pause
exit /b 1
