@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Chua co Node.js. Hay cai Node.js 24 LTS kem npm roi thu lai.
  pause
  exit /b 1
)
node scripts\launch.mjs
set "DLS_EXIT=%ERRORLEVEL%"
if not "%DLS_EXIT%"=="0" pause
exit /b %DLS_EXIT%
