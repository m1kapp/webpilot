// Flow 오픈 API 클라이언트(익스텐션판). src/lib/flow.mjs와 동일 로직.
// 쿠키가 아니라 API 키 헤더 인증이라 탭 없이 백그라운드에서 바로 fetch한다. 키는 chrome.storage.local에.
const HOST = 'https://api.flow.team';

export async function getFlowKey() {
  const { flowApiKey } = await chrome.storage.local.get('flowApiKey');
  return flowApiKey || '';
}
export async function setFlowKey(key) {
  await chrome.storage.local.set({ flowApiKey: key || '' });
}

async function flowGet(path, params = {}) {
  const key = await getFlowKey();
  if (!key) { const e = new Error('Flow API 키가 없습니다.'); e.needsFlowKey = true; throw e; }
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${HOST}${path}${qs ? '?' + qs : ''}`, { headers: { 'x-flow-api-key': key } });
  const json = await res.json().catch(() => ({}));
  if (!json?.response?.success) throw new Error(json?.response?.error?.message || `Flow API 오류 (${res.status})`);
  return json.response.data;
}

const hhmm = (v) => { const s = String(v || ''); return s.length >= 12 ? `${s.slice(8, 10)}:${s.slice(10, 12)}` : ''; };

// 키 유효성 확인(설정 저장 전 검증용)
export async function verifyFlowKey(apiKey) {
  if (!apiKey) throw new Error('API 키가 필요합니다');
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
  const res = await fetch(`${HOST}/user/calendars/events?startDateTime=${today}000000&endDateTime=${today}235959`,
    { headers: { 'x-flow-api-key': apiKey } });
  const json = await res.json().catch(() => ({}));
  if (!json?.response?.success) throw new Error(json?.response?.error?.message || `flow.team API 키 확인 실패 (${res.status})`);
  return true;
}

// 특정 일자(YYYY-MM-DD)의 내 캘린더 활동 → 첫/마지막 시각 + 일정 목록
export async function getDayActivity(dateStr) {
  const d = String(dateStr).replace(/-/g, '');
  const data = await flowGet('/user/calendars/events', { startDateTime: `${d}000000`, endDateTime: `${d}235959` });
  const events = (data?.events || [])
    .filter((e) => e.allDayYn !== 'Y' && e.eventStartDateTime)
    .map((e) => ({ name: e.eventName, start: e.eventStartDateTime, end: e.eventFinishDateTime, startText: hhmm(e.eventStartDateTime), endText: hhmm(e.eventFinishDateTime) }))
    .sort((a, b) => String(a.start).localeCompare(String(b.start)));
  const first = events[0] || null;
  const last = events.reduce((m, e) => (!m || String(e.end || e.start) > String(m.end || m.start) ? e : m), null);
  return {
    events, firstText: first ? first.startText : '', lastText: last ? (last.endText || last.startText) : '',
  };
}
