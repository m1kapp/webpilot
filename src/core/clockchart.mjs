// 출퇴근 시각 분포 차트의 "계산" 부분. 그리기는 환경마다 다르다(데스크톱=Chart.js, 확장=캔버스 직접).
// 하루를 세로 막대 하나로 본다. 막대는 출근 시각에서 시작해 퇴근 시각에서 끝나고,
// 그 안을 [근무 4h][점심 1h][근무 4h][저녁 30m][야근 나머지] 로 쪼갠다.
// base = 막대가 시작하는 시각(= 그 위는 투명). 나머지 키는 각 구간의 "길이(시간)".

export const CLOCK_COLORS = {
  work: '#4b62d6',
  lunch: 'rgba(75,98,214,0.22)',
  dinner: 'rgba(75,98,214,0.16)',
  ot: '#e5544c',
  hol: '#c2362b',
  leave: '#2f9d70',
  hday: '#ecdca9',
  trip: '#9aa8e0',
  corr: '#1f93b0',
  miss: '#eceef4',
};

// 막대를 아래에서 위로 쌓는 순서. base는 투명 오프셋이라 제외한다.
export const CLOCK_STACK = [
  { key: 'am', color: CLOCK_COLORS.work, label: '근무' },
  { key: 'lunch', color: CLOCK_COLORS.lunch, label: '점심(1h)' },
  { key: 'pm', color: CLOCK_COLORS.work, label: null },       // 범례에는 '근무' 하나만 노출
  { key: 'dinner', color: CLOCK_COLORS.dinner, label: '저녁(30m)' },
  { key: 'ot', color: CLOCK_COLORS.ot, label: '야근' },
  { key: 'hol', color: CLOCK_COLORS.hol, label: '휴일근무' },
  { key: 'leave', color: CLOCK_COLORS.leave, label: '휴가' },
  { key: 'hday', color: CLOCK_COLORS.hday, label: '공휴일' },
  { key: 'trip', color: CLOCK_COLORS.trip, label: '출장' },
  { key: 'corr', color: CLOCK_COLORS.corr, label: '정정' },
  { key: 'miss', color: CLOCK_COLORS.miss, label: '기록누락' },
];

const EMPTY = { base: 0, am: 0, lunch: 0, pm: 0, dinner: 0, ot: 0, hol: 0, leave: 0, hday: 0, trip: 0, corr: 0, miss: 0 };
const hh2dec = (s) => { const m = /(\d{1,2}):(\d{2})/.exec(s || ''); return m ? +m[1] + +m[2] / 60 : null; };

// 출근~퇴근 구간을 근무/휴게/야근으로 쪼갠다. 휴게는 실제 펀치가 아니라 규정상 공제분이라 순서대로 깎는다.
function splitWorkday(inH, outH) {
  if (inH == null || outH == null) return { ...EMPTY };
  let left = outH - inH;
  const am = Math.min(left, 4); left -= am;
  const lunch = Math.min(left, 1); left -= lunch;
  const pm = Math.min(left, 4); left -= pm;
  const dinner = Math.min(left, 0.5); left -= dinner;
  return { ...EMPTY, base: inH, am, lunch, pm, dinner, ot: Math.max(0, left) };
}

// buildDays의 하루 → 막대 세그먼트. 근무 외의 날(휴가·공휴일·출장·누락)은 09~18 자리에 블록으로 세운다.
export function segmentDay(x, { excludeCorrected = true } = {}) {
  // 정정한 날: 합계에서 빼는 설정이면 청록 통짜로 따로 보여준다(근무로 안 셈).
  if (x.corrected && x.inH != null && excludeCorrected) return { ...EMPTY, base: x.inH, corr: x.outH - x.inH };
  // 정정 신청은 했는데 펀치가 아직 없는 날 — 신청한 시각대로 그린다.
  if (x.corrected && x.inH == null) {
    const ci = hh2dec(x.corrIn), co = hh2dec(x.corrOut);
    if (ci != null && co != null) return { ...EMPTY, base: ci, corr: (co < ci ? co + 24 : co) - ci };
  }
  if (x.missing) {
    // 반차·반반차는 휴가만큼 초록, 나머지는 회색
    if (x.isLeave && x.leaveDays < 1) {
      const lh = Math.max(1, x.leaveHours || 2);
      return { ...EMPTY, base: 9, leave: lh, miss: Math.max(0, 9 - lh) };
    }
    return { ...EMPTY, base: 9, miss: 9 };
  }
  if (x.isLeave && x.workMin === 0 && !x.holiday) {
    return { ...EMPTY, base: 9, leave: x.leaveDays >= 1 ? 9 : Math.max(1, x.leaveHours || 4) };
  }
  // 휴일에 실제로 나와 일한 날은 출근~퇴근 전체를 진한 보라 단독 막대로
  if (x.holiday && x.holMin > 0 && x.inH != null) return { ...EMPTY, base: x.inH, hol: x.outH - x.inH };
  if (x.holiday && !x.weekend) return { ...EMPTY, base: 9, hday: 9 };  // 평일 공휴일(근로자의 날·대체 등)
  if (x.holiday) return { ...EMPTY };                                   // 그냥 주말 → 빈칸
  if (x.isTrip && x.inH == null) return { ...EMPTY, base: 9, trip: 9 };
  return splitWorkday(x.inH, x.outH);
}

// 막대에 붙일 설명. 툴팁 제목으로 쓴다.
export function describeDay(x) {
  if (x.corrected) return `정정 · ${x.correctReason || x.correctStatus || ''}`.trim();
  if (x.missing) return x.status || '기록 누락';
  if (x.holiday && !x.weekend && !(x.holMin > 0 && x.inH != null)) return `🏖 ${x.status || '공휴일'}`;
  if (x.isTrip && x.inH == null) return `✈ ${x.tripType || '출장'}${x.tripPlace ? ' · ' + x.tripPlace : ''}`;
  if (x.isLeave && x.workMin === 0) return `휴가 · ${x.leaveType || ''}${x.leaveDetail ? ' ' + x.leaveDetail : ''}`.trim();
  if (x.inH == null) return x.status || '기록 없음';
  return `${x.inText} ~ ${x.outText}${x.projected ? ' (진행중)' : ''}`;
}

// 여러 날 → 세그먼트 배열 + y축 범위. y축은 시각이고 위가 이르다(아래로 갈수록 늦은 시각).
export function segmentDays(days, opts = {}) {
  const segs = days.map((x) => ({ ...segmentDay(x, opts), projected: !!x.projected, day: x }));
  const latest = Math.max(0, ...days.map((x) => x.outH || 0));
  return {
    segs,
    yMin: 6,
    yMax: Math.max(24, Math.ceil(latest + 1)),   // 익일 퇴근이 있으면 24 아래까지 늘린다
  };
}

// 범례에 실제로 등장하는 항목만 남긴다. 좁은 화면에서 안 쓰는 색을 늘어놓지 않으려고.
export function usedLegend(segs) {
  return CLOCK_STACK.filter((s) => s.label && segs.some((g) => (g[s.key] || 0) > 0.01));
}
