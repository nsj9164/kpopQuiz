@echo off
chcp 65001 >nul
title K-POP Quiz Server
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 가 설치되어 있지 않아요. https://nodejs.org 에서 설치해주세요.
  pause
  exit /b 1
)
node server.js --open
pause
