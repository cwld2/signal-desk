@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 20 or newer first.
  pause
  exit /b 1
)

start "畅神妙妙屋" /min node "%~dp0server.js"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:4173"
endlocal
