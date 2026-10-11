@echo off
rem ============================================================
rem  Campus Network Auto Login  (172.19.1.1)
rem  This launcher is intentionally ASCII-only: cmd.exe reads
rem  batch files with the OEM code page, and UTF-8 Chinese text
rem  here would be garbled or mis-parsed. All Chinese output
rem  comes from the Node.js program instead.
rem ============================================================
chcp 65001 >nul
title Campus Network Login 172.19.1.1
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found.
    echo         Please install Node.js 22 or newer: https://nodejs.org/
    echo.
    pause
    exit /b 1
)

echo Starting campus network authentication, please wait...
node "src\main.mjs" %*
set EXITCODE=%ERRORLEVEL%

echo.
if "%EXITCODE%"=="0" (
    echo [DONE] Authentication flow finished.
) else (
    echo [WARN] Exited with code %EXITCODE%. See the log above.
)
echo.
pause
