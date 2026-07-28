@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 20 or newer first.
  pause
  exit /b 1
)

node "%~dp0scripts\build-portable.js"
if errorlevel 1 (
  echo Packaging failed.
  pause
  exit /b 1
)

echo.
echo Portable package created in the dist folder.
pause
endlocal
