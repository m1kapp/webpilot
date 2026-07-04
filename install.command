#!/usr/bin/env bash
# webpilot 설치 (1회) — 더블클릭 또는 `bash install.command`
set -e
cd "$(dirname "$0")"
# GUI 더블클릭 시 PATH 보정 (Homebrew/Node 경로)
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.nvm/versions/node/*/bin:$PATH"

echo "🛫 webpilot 설치를 시작합니다"
echo ""

# 1) Node.js 확인
if ! command -v node >/dev/null 2>&1; then
  echo "❌ Node.js가 필요합니다."
  echo "   https://nodejs.org 에서 LTS 버전 설치 후 이 파일을 다시 더블클릭하세요."
  read -p "엔터를 누르면 종료합니다…" _
  exit 1
fi
echo "✓ Node.js $(node -v)"

# 2) Google Chrome 확인 → 있으면 Playwright 크로미움(~150MB) 다운로드 생략
if [ -d "/Applications/Google Chrome.app" ]; then
  echo "✓ Google Chrome 감지 — 시스템 크롬 사용 (크로미움 다운로드 생략)"
  export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
  NEED_CHROMIUM=0
else
  echo "⚠ Google Chrome 미설치 — Playwright 크로미움을 대신 받습니다(~150MB)"
  echo "   (권장: https://google.com/chrome 설치하면 더 가볍습니다)"
  NEED_CHROMIUM=1
fi

# 3) 패키지 설치
echo ""
echo "· 패키지 설치 중… (처음엔 1~2분 걸릴 수 있어요)"
npm install --omit=dev --no-audit --no-fund

# 4) 크롬 없으면 크로미움만 별도 설치
if [ "$NEED_CHROMIUM" = "1" ]; then
  echo "· Playwright 크로미움 설치 중…"
  npx playwright install chromium
fi

echo ""
echo "✅ 설치 완료!"
echo "   이제 'start.command' 를 더블클릭해서 실행하세요."
read -p "엔터를 누르면 이 창을 닫습니다…" _
