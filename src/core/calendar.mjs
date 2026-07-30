// 코어: 날짜·공휴일. 환경 무관.

// 평일 공휴일 라벨/보정 (타임인아웃이 대부분 자체 마킹하지만 안전망 + 라벨용).
// 근로자의 날(5/1)은 관공서 공휴일은 아니나 근로기준법상 유급휴일 → 휴일 처리.
// 음력·대체공휴일 포함 2026 전체. 연도 넘어가면 갱신 필요.
export const KR_HOLIDAYS = {
  '2026-01-01': '신정',
  '2026-02-16': '설날 연휴', '2026-02-17': '설날', '2026-02-18': '설날 연휴',
  '2026-03-01': '삼일절', '2026-03-02': '대체공휴일(삼일절)',
  '2026-05-01': '근로자의 날',
  '2026-05-05': '어린이날',
  '2026-05-24': '부처님오신날', '2026-05-25': '대체공휴일(부처님오신날)',
  '2026-06-03': '지방선거', '2026-06-06': '현충일',
  '2026-08-15': '광복절', '2026-08-17': '대체공휴일(광복절)',
  '2026-09-24': '추석 연휴', '2026-09-25': '추석', '2026-09-26': '추석 연휴', '2026-09-28': '대체공휴일(추석)',
  '2026-10-03': '개천절', '2026-10-05': '대체공휴일(개천절)',
  '2026-10-09': '한글날',
  '2026-12-25': '성탄절',
};
export const DOW = ['일', '월', '화', '수', '목', '금', '토'];

export function monthRange(month) {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const p = (n) => String(n).padStart(2, '0');
  return { y, m, last, sdate: `${y}-${p(m)}-01`, edate: `${y}-${p(m)}-${p(last)}` };
}

// month의 연도 전체 범위(달력 뷰용): sdate=1/1 ~ edate=12/31, months=그 해 12개월 라벨
export function yearRange(month) {
  const y = month.split('-')[0];
  const months = Array.from({ length: 12 }, (_, k) => `${y}-${String(k + 1).padStart(2, '0')}`);
  return { months, sdate: `${y}-01-01`, edate: `${y}-12-31` };
}

// 대상월 기준 넓은 신청일 범위(±2개월) — 다른 달에 신청된 건을 놓치지 않도록
export function submitDateRange(month) {
  const [ty, tm] = String(month).split('-').map(Number);
  const at = (delta) => { const i = tm - 1 + delta; return { y: ty + Math.floor(i / 12), m: ((i % 12) + 12) % 12 + 1 }; };
  const s = at(-2), e = at(+2);
  return { start: `${s.y}-${s.m}-1`, end: `${e.y}-${e.m}-28` };
}

// 야근택시 datetime → 야근일: 자정 넘긴 00~03시 택시는 '전날' 야근
export function yagunDateOf(taxiDate) {
  const [d, t] = String(taxiDate).split(' ');
  const h = +((t || '').split(':')[0] || 12);
  if (h <= 3) { const dt = new Date(d + 'T00:00:00Z'); dt.setUTCDate(dt.getUTCDate() - 1); return dt.toISOString().slice(0, 10); }
  return d;
}
