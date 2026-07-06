@echo off
chcp 65001 >nul
REM webwing 실행 - 더블클릭. 서버 시작 + 브라우저 자동 오픈. 이 창을 닫으면 종료.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 ( echo [X] Node.js가 없습니다. install.bat 를 먼저 실행하세요. & pause & exit /b 1 )
if not exist node_modules ( echo [!] 아직 설치가 안 됐어요. install.bat 를 먼저 실행하세요. & pause & exit /b 1 )

if "%PORT%"=="" set "PORT=18181"
echo webwing 시작 중... (포트 %PORT%, 막히면 자동으로 다음 포트)
echo 브라우저가 곧 열립니다. 이 창을 닫으면 종료됩니다.

del /q ".tmp\webwing.port" 2>nul

REM 서버가 실제 포트(.tmp\webwing.port)를 기록할 때까지 기다렸다가 그 포트로 브라우저 오픈
start "" /b powershell -NoProfile -Command "$p=$env:PORT; for($i=0;$i -lt 30;$i++){ if(Test-Path '.tmp\webwing.port'){ $p=(Get-Content '.tmp\webwing.port').Trim(); break }; Start-Sleep -Milliseconds 500 }; Start-Process ('http://127.0.0.1:'+$p)" >nul 2>nul

node server.mjs
