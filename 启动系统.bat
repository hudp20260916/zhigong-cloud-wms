@echo off
setlocal
title Zhigong System Launcher
cd /d "%~dp0"

rem ---- locate node runtime (do not rely on PATH) ----
set "NODE_HOME=C:\Users\admin\.workbuddy\binaries\node\versions\22.22.2-6"
if not exist "%NODE_HOME%\node.exe" (
  for /f "delims=" %%i in ('where node 2^>nul') do if not defined ND set "ND=%%i"
  if defined ND for %%i in ("%ND%") do set "NODE_HOME=%%~dpi"
)
if not exist "%NODE_HOME%\node.exe" (
  echo [ERROR] Node runtime not found: %NODE_HOME%
  echo Install Node.js LTS, or fix NODE_HOME in this .bat
  pause
  exit /b 1
)
set "PATH=%NODE_HOME%;%PATH%"

echo ============================================
echo   Zhigong Cloud Warehouse - start services
echo   Keep the two black windows OPEN.
echo ============================================
echo node: %NODE_HOME%

echo [1/2] Starting API server on port 3001 ...
start "API-3001" cmd /k "cd /d "%~dp0" && npm run dev:server"

echo       waiting 8s for API to warm up ...
ping -n 8 127.0.0.1 >nul

echo [2/2] Starting web server on port 5173 (LAN enabled) ...
start "WEB-5173" cmd /k "cd /d "%~dp0web" && npx vite --host"

echo       waiting 8s for web to warm up ...
ping -n 8 127.0.0.1 >nul

start "" http://localhost:5173

for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /R "IPv4"') do set "LANIP=%%a"
set "LANIP=%LANIP: =%"

echo.
echo ============================================
echo   Services are up.
echo     PC    : http://localhost:5173
echo     Phone : http://%LANIP%:5173
echo   Stop services: double-click 停止系统.bat
echo ============================================
echo.
pause
