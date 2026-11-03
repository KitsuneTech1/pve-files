@echo off
setlocal
echo ========================================================
echo   PVE File Desk (pve-files)
echo   Kitsune Technologies LLC
echo ========================================================
echo.

where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js was not found on your system.
    echo Please install Node.js (v18+) from https://nodejs.org/
    pause
    exit /b 1
)

if not exist .env (
    echo Creating default .env configuration...
    copy .env.example .env >nul
)

echo Starting PVE File Desk at http://localhost:3000 ...
start http://localhost:3000
node server.js
pause
