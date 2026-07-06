#!/usr/bin/env bash
# webwing 실행 — 더블클릭. 서버 시작 + 브라우저 자동 오픈. 이 창을 닫으면 종료.
cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:$HOME/.local/lib/nodejs/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
for d in "$HOME"/.nvm/versions/node/*/bin "$HOME"/.volta/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done
command -v node >/dev/null 2>&1 || export PATH="$(/bin/zsh -lic 'printf %s "$PATH"' 2>/dev/null):$PATH"
PORT="${PORT:-18181}"

if ! command -v node >/dev/null 2>&1; then
  echo "❌ Node.js가 없습니다. 먼저 install.command 를 실행하세요."
  read -p "엔터를 누르면 종료…" _; exit 1
fi
if [ ! -d node_modules ]; then
  echo "⚠ 아직 설치가 안 됐어요. install.command 를 먼저 더블클릭하세요."
  read -p "엔터를 누르면 종료…" _; exit 1
fi

echo "🛫 webwing 시작 중… (포트 $PORT, 막히면 자동으로 다음 포트)"
rm -f .tmp/webwing.port
PORT="$PORT" node server.mjs &
SERVER_PID=$!
# 서버가 실제 포트 기록할 때까지 대기
ACTUAL=""
for i in $(seq 1 30); do [ -f .tmp/webwing.port ] && ACTUAL="$(cat .tmp/webwing.port 2>/dev/null)" && break; sleep 0.5; done
ACTUAL="${ACTUAL:-$PORT}"
open "http://127.0.0.1:$ACTUAL" 2>/dev/null || echo "브라우저에서 http://127.0.0.1:$ACTUAL 를 열어주세요"
echo ""
echo "실행 중입니다. 이 터미널 창을 닫거나 Ctrl+C 하면 종료됩니다."
trap 'kill $SERVER_PID 2>/dev/null' EXIT
wait $SERVER_PID
