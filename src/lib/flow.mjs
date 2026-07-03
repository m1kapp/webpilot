// Flow 오픈 API 클라이언트 (api.flow.team, x-flow-api-key 인증)
// 근태 정정용: 그날 캘린더 활동시간(첫 일정~마지막 일정)으로 실제 근무시간대 추정
const HOST = 'https://api.flow.team';
const key = () => process.env.FLOW_API_KEY || '';

async function flowGet(path, params = {}) {
  if (!key()) throw new Error('FLOW_API_KEY가 .env에 없습니다');
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${HOST}${path}${qs ? '?' + qs : ''}`, { headers: { 'x-flow-api-key': key() } });
  const json = await res.json().catch(() => ({}));
  if (!json?.response?.success) throw new Error(json?.response?.error?.message || `Flow API 오류 (${res.status})`);
  return json.response.data;
}

const hhmm = (yyyymmddhhmmss) => {
  const s = String(yyyymmddhhmmss || '');
  return s.length >= 12 ? `${s.slice(8, 10)}:${s.slice(10, 12)}` : '';
};

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
    events,
    firstStart: first ? first.start : null, firstText: first ? first.startText : '',
    lastEnd: last ? (last.end || last.start) : null, lastText: last ? (last.endText || last.startText) : '',
  };
}

// 특정 키워드로 내 게시물 시간 조회(보조 근거) — searchPosts는 날짜필터 없어 클라이언트 필터
export async function getPostsByKeyword(searchWord, { orderType = 'LATEST' } = {}) {
  const data = await flowGet('/user/search/posts', { searchWord, orderType });
  return (data?.posts || []).map((p) => ({ title: p.ttl, commtTitle: p.commtTtl, registerId: p.registerId, at: p.registeredDateTime }));
}
