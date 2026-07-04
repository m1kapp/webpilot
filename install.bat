@echo off
chcp 65001 >nul
REM webpilot 설치 (1회) - 더블클릭
setlocal
cd /d "%~dp0"

echo ============================
echo   webpilot 설치를 시작합니다
echo ============================
echo.

REM 1) Node.js 확인
where node >nul 2>nul
if errorlevel 1 (
  echo [X] Node.js가 필요합니다.
  echo     https://nodejs.org 에서 LTS 설치 후 이 파일을 다시 더블클릭하세요.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do echo [OK] Node.js %%v

REM 2) Google Chrome 확인 -> 있으면 Playwright 크로미움 다운로드 생략
set "HASCHROME="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "HASCHROME=1"
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "HASCHROME=1"
if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "HASCHROME=1"
if defined HASCHROME (
  echo [OK] Google Chrome 감지 - 시스템 크롬 사용 ^(크로미움 다운로드 생략^)
  set "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1"
) else (
  echo [!] Google Chrome 미설치 - Playwright 크로미움을 받습니다 ^(~150MB^)
  echo     권장: https://google.com/chrome 설치하면 더 가볍습니다
)

REM 3) 패키지 설치
echo.
echo - 패키지 설치 중... ^(처음엔 1~2분 걸릴 수 있어요^)
call npm install --omit=dev --no-audit --no-fund
if errorlevel 1 ( echo [X] npm install 실패 & pause & exit /b 1 )

REM 4) 크롬 없으면 크로미움만 설치
if not defined HASCHROME (
  echo - Playwright 크로미움 설치 중...
  call npx playwright install chromium
)

echo.
echo [완료] 이제 start.bat 를 더블클릭해서 실행하세요.
pause
