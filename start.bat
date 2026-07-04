@echo off
chcp 65001 >nul
REM webpilot 실행 - 더블클릭. 서버 시작 + 브라우저 자동 오픈. 이 창을 닫으면 종료.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 ( echo [X] Node.js가 없습니다. install.bat 를 먼저 실행하세요. & pause & exit /b 1 )
if not exist node_modules ( echo [!] 아직 설치가 안 됐어요. install.bat 를 먼저 실행하세요. & pause & exit /b 1 )

if "%PORT%"=="" set "PORT=8181"
echo webpilot 시작 중... (포트 %PORT%)
echo 브라우저가 곧 열립니다. 이 창을 닫으면 종료됩니다.

REM 서버 뜰 시간(3초) 뒤 기본 브라우저로 오픈
start "" /b powershell -NoProfile -Command "Start-Sleep 3; Start-Process 'http://127.0.0.1:%PORT%'" >nul 2>nul

node server.mjs
