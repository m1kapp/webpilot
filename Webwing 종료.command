#!/usr/bin/env bash
# Webwing 종료 — 백그라운드 서버 정지.
pkill -f "node server.mjs" 2>/dev/null
osascript -e 'display notification "종료됨" with title "Webwing"' 2>/dev/null || echo "Webwing 종료됨"
