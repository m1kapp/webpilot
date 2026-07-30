// 코어: 환경 무관 유틸. Node API·Playwright·chrome.* 어느 것도 import하지 않는다.
// 데스크톱(Playwright)과 브라우저 확장이 이 파일을 그대로 공유한다.

// 단계별 소요시간 로그 — "왜 느린지" 눈에 보이게. tick('단계명') → "단계명 (+구간초, 누적 총초)"
export function stopwatch(tag) {
  const start = Date.now();
  let last = start;
  return (label) => {
    const now = Date.now();
    const step = ((now - last) / 1000).toFixed(1);
    const total = ((now - start) / 1000).toFixed(1);
    last = now;
    console.error(`[${tag}] ${label} (+${step}s, 누적 ${total}s)`);
  };
}

// 동시 실행 개수 제한 풀 — 순차로 돌면 느린 반복 작업(상세페이지 여러 건 등)을 병렬화
export async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// 엑셀 serial → UTC Date
export const serialToDate = (s) => new Date(Math.round((s - 25569) * 86400 * 1000));

export const fmt = (m) => { const s = m < 0 ? '-' : ''; m = Math.abs(m); return `${s}${Math.floor(m / 60)}시간 ${String(Math.round(m % 60)).padStart(2, '0')}분`; };

// 소수 시각(9.5) → 'HH:MM'. 24 넘으면 '익일 HH:MM'
export const hhmm = (dec) => { if (dec == null) return ''; let total = Math.round(dec * 60); let over = false; if (total >= 1440) { total -= 1440; over = true; } const h = Math.floor(total / 60); const mm = total % 60; return `${over ? '익일 ' : ''}${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`; };

export const parseTimeH = (str) => { const m = String(str).match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/); return m ? +(+m[1] + (+m[2]) / 60 + (+(m[3] || 0)) / 3600).toFixed(4) : null; };
export const parseDurMin = (str) => { const h = String(str).match(/(\d+)\s*시간/); const mi = String(str).match(/(\d+)\s*분/); return (h ? +h[1] : 0) * 60 + (mi ? +mi[1] : 0); };
export const parseTimeMin = (t) => { const m = String(t || '').match(/(\d{1,2}):(\d{2})/); return m ? (+m[1]) * 60 + (+m[2]) : null; };

// 한국 시각 기준 오늘(UTC+9 트릭 — 저장소 전반의 관례)
export const kstNow = () => new Date(Date.now() + 9 * 3600 * 1000);
export const kstToday = () => kstNow().toISOString().slice(0, 10);
