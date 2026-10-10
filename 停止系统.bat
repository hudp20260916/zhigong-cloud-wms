@echo off
title Zhigong System Stopper
cd /d "%~dp0"

echo Stopping services on port 3001 and 5173 ...

for %%P in (3001 5173) do (
  for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%%P " ^| findstr /I LISTENING') do (
    echo   killing PID %%a  (port %%P)
    taskkill /F /PID %%a >nul 2>&1
  )
)

echo.
echo Done. Ports 3001 / 5173 are free now.
echo.
pause
