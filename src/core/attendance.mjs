// 코어: 근태 계산. 정규화된 byDay를 받아 일자별 결과 + 월 합계를 만든다.
// 수집 방식(Playwright 다운로드 / 확장 탭 주입)과 무관 — 어댑터가 byDay 모양만 맞춰 주면 된다.
import { DOW, KR_HOLIDAYS, monthRange } from './calendar.mjs';
import { fmt, hhmm, kstNow, parseDurMin, parseTimeH, serialToDate } from './util.mjs';

export const DAILY_BASE = 8 * 60;      // 480분
export const MONTH_LIMIT = 52 * 60;    // 3120분
export const BREAK_MIN = 90;           // 점심 60 + 저녁 30
export const SUSPECT_MIN = 16 * 60;    // 16시간 초과 = 미체크아웃 의심

// 공용 계산부: 정규화 byDay { inH, outH(익일이면 >24), recogMin, policy, inStat, outStat, nonWork } → days + summary
export function buildDays(byDay, month, corrections = {}, leaves = {}, trips = {}) {
  const { y, m, last } = monthRange(month);
  const days = [];
  let totalMin = 0, wdOtSum = 0, holSum = 0, recogTotal = 0;
  let adjTotal = 0, adjWdOt = 0, adjHol = 0;
  const nowKST = kstNow();
  const todayStr = nowKST.toISOString().slice(0, 10);
  const nowH = nowKST.getUTCHours() + nowKST.getUTCMinutes() / 60;
  for (let day = 1; day <= last; day++) {
    const dow = new Date(Date.UTC(y, m - 1, day)).getUTCDay();
    const weekend = dow === 0 || dow === 6;
    const dateStr = `${y}-${String(m).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const namedHol = KR_HOLIDAYS[dateStr];
    const e = byDay[day];
    const holidayPolicy = e ? /휴일|휴무/.test(e.policy) || /휴일/.test(e.nonWork) : false;
    const holiday = weekend || holidayPolicy || !!namedHol;

    const hasIn = !!(e && e.inH != null);
    let hasOut = !!(e && e.outH != null);
    // 오늘, 출근만 찍히고 아직 퇴근 전 → "지금 퇴근한다면"으로 가정해 초과근무 계산(화면에서 점선으로 구분)
    const projected = dateStr === todayStr && hasIn && !hasOut;
    if (projected) hasOut = true;
    const effOutH = projected ? nowH : (e && e.outH != null ? e.outH : null);
    const rawWork = (hasIn && hasOut) ? Math.max(0, (effOutH - e.inH) * 60 - BREAK_MIN) : 0; // 찐 근로(휴게 제외)
    const recogWork = e ? (e.recogMin || 0) : 0;                // 회사 인정 근로
    const suspect = rawWork > SUSPECT_MIN;                       // 미체크아웃 의심
    // 보정: 의심일은 회사 인정값으로 대체
    const realWork = suspect ? recogWork : rawWork;
    const baseMin = holiday ? 0 : Math.min(realWork, DAILY_BASE);
    const wdOtMin = holiday ? 0 : Math.max(0, realWork - DAILY_BASE);
    const holMin = holiday ? realWork : 0;

    const inH = hasIn ? e.inH : null;
    const outH = (hasIn && hasOut) ? effOutH : null;
    const recogOutH = null;

    const lv = leaves[day];
    const trip = !holiday ? trips[day] : null;   // 출장·외근(평일). 승인/진행만 상위에서 걸러 옴
    const isFullLeave = !!(lv && lv.days >= 1);
    const isAbsent = !!(e && e.inStat === '결근');
    // 한쪽만 찍힘(출근만/퇴근만)
    const oneSided = !!(e && ((hasIn && !hasOut) || (!hasIn && hasOut)));
    // 기록 누락: 평일(공휴일X, 종일휴가X, 출장X)인데 기록없음/한쪽만/이상치(미체크아웃 의심)/결근
    const missing = !holiday && !isFullLeave && !trip && (realWork === 0 || oneSided || suspect || isAbsent);

    let status = '';
    if (missing) {
      const why = suspect ? '미체크아웃 의심' : oneSided ? '한쪽만 기록' : isAbsent ? '결근' : '기록 누락';
      status = lv ? `${lv.type} ${lv.detail} · ${why}` : why;
    }
    else if (trip && realWork === 0) status = `${trip.type}${trip.place ? ' · ' + trip.place : ''}`;
    else if (isFullLeave || (lv && realWork === 0)) status = `${lv.type}${lv.detail ? ' ' + lv.detail : ''}`;
    else if (e) {
      if (namedHol) status = namedHol + (realWork > 0 ? ' 근무' : '');
      else if (holidayPolicy) status = realWork > 0 ? '휴일근무' : (e.policy || '휴일');
      else if (weekend && realWork > 0) status = '주말근로';
      else if (lv) status = `${lv.type}${lv.detail ? ' ' + lv.detail : ''}(+근무)`;
      else if (e.inStat && e.inStat !== '출근') status = e.inStat;         // 지각 등
      else if (e.outStat && !['퇴근', '-'].includes(e.outStat)) status = e.outStat; // 조퇴 등
      else if (weekend) status = '휴일';
    } else if (namedHol) status = namedHol;
    else if (weekend) status = '휴일';

    const capped = e && !suspect && !projected && rawWork - recogWork > 1; // 인정시간에 잘린(정상) 날
    const corr = corrections[day];
    days.push({
      day, dow: DOW[dow], weekend, holiday, projected, // projected: 아직 퇴근 전, 지금 시각 기준 가정 계산
      workMin: realWork, rawWorkMin: rawWork, recogWorkMin: recogWork,
      baseH: +(baseMin / 60).toFixed(2), otH: +(wdOtMin / 60).toFixed(2), holH: +(holMin / 60).toFixed(2),
      otMin: Math.round(wdOtMin), holMin: Math.round(holMin),
      inH, outH, recogOutH, inText: hhmm(inH), outText: hhmm(outH),   // 출퇴근 막대는 항상 '찐 펀치'
      capped, cutMin: capped ? Math.round(rawWork - recogWork) : 0,
      suspect, missing,
      corrected: !!corr, correctReason: corr ? corr.reason : '', correctStatus: corr ? corr.status : '',
      corrIn: corr && corr.reqIn ? corr.reqIn : '', corrOut: corr && corr.reqOut ? corr.reqOut : '',
      isLeave: !!lv, leaveType: lv ? lv.type : '', leaveDetail: lv ? lv.detail : '', leaveDays: lv ? lv.days : 0, leaveHours: lv ? lv.hours : 0,
      isTrip: !!trip, tripType: trip ? trip.type : '', tripPlace: trip ? trip.place : '', tripRegion: trip ? trip.region : '',
      status,
    });
    // 보정 총합(의심일=인정값)
    totalMin += realWork; wdOtSum += wdOtMin; holSum += holMin;
    recogTotal += recogWork;
    // raw 총합(찐 펀치 그대로)
    adjTotal += rawWork;
    if (!holiday) adjWdOt += Math.max(0, rawWork - DAILY_BASE); else adjHol += rawWork;
  }
  const otSum = wdOtSum + holSum;                 // 보정 초과근무
  const rawOtSum = adjWdOt + adjHol;              // raw 초과근무
  const gap = totalMin - recogTotal;              // 회사가 안 쳐준 시간(보정 기준)
  return {
    month, days,
    summary: {
      totalMin, totalText: fmt(totalMin),
      otSum, otText: fmt(otSum), otHours: +(otSum / 60).toFixed(1),
      wdOtMin: wdOtSum, wdOtText: fmt(wdOtSum),
      holMin: holSum, holText: fmt(holSum),
      recogMin: recogTotal, recogText: fmt(recogTotal),
      gapMin: gap, gapText: fmt(gap),
      rawTotalMin: adjTotal, rawTotalText: fmt(adjTotal),
      rawOtSum, rawOtText: fmt(rawOtSum), rawOtHours: +(rawOtSum / 60).toFixed(1),
      cappedDays: days.filter(d => d.capped).length,
      suspectDays: days.filter(d => d.suspect).length,
      limitHours: 52, over52: otSum > MONTH_LIMIT,
    },
  };
}

// 관리자 xlsx 시트 행 → 정규화 byDay
// 컬럼: 0날짜 7근로정책상세 8실출근 9실퇴근 10인정출근 11인정퇴근 12출근상태 13퇴근상태 15비업무
export function rowsToByDay(rows) {
  const toH = (serial, inSerial) => serial == null ? null : +(((serial - Math.floor(inSerial ?? serial)) * 24)).toFixed(4);
  const netWork = (a, b) => (a == null || b == null) ? 0 : Math.max(0, (b - a) * 1440 - BREAK_MIN);
  const byDay = {};
  for (const r of rows) {
    const s = r[0]; if (typeof s !== 'number') continue;
    const realIn = typeof r[8] === 'number' ? r[8] : null;
    const realOut = typeof r[9] === 'number' ? r[9] : null;
    byDay[serialToDate(s).getUTCDate()] = {
      inH: toH(realIn),
      outH: (realOut != null && realIn != null) ? toH(realOut, realIn) : null,
      recogMin: netWork(typeof r[10] === 'number' ? r[10] : null, typeof r[11] === 'number' ? r[11] : null),
      policy: String(r[7] || ''), inStat: String(r[12] || ''), outStat: String(r[13] || ''), nonWork: String(r[15] || ''),
    };
  }
  return byDay;
}

// 카드 텍스트에서 IN/OUT 시각만 가볍게 파싱 (스필오버 의심 탐지용 — cardsToByDay와 로직 공유)
export function parseCardInOut(t) {
  const inM = (t.match(/IN\s+([\d:]+|-)/) || [])[1];
  const outM = (t.match(/OUT\s+([\d:]+|-)/) || [])[1];
  let inH = inM && inM !== '-' ? parseTimeH(inM) : null;
  let outH = outM && outM !== '-' ? parseTimeH(outM) : null;
  if (inH != null && outH != null && outH < inH) outH += 24;
  return { inH, outH };
}

// 직원 캘린더 카드 텍스트 → 정규화 byDay
export function cardsToByDay(cards, overrides = {}) {
  const byDay = {};
  for (const [day, t] of Object.entries(cards)) {
    const recM = (t.match(/인정\s*시간\s+([\d]+\s*시간\s*[\d]*\s*분|[\d]+\s*분|-)/) || [])[1] || '-';
    const inStat = (t.match(/출근\s*상태\s+(\S+)/) || [])[1] || '';
    const outStat = (t.match(/퇴근\s*상태\s+(\S+)/) || [])[1] || '';
    const nonWork = (t.match(/비업무\s+(\S+)/) || [])[1] || '';
    const { inH, outH } = overrides[day] || parseCardInOut(t);
    byDay[+day] = { inH, outH, recogMin: recM === '-' ? 0 : parseDurMin(recM), policy: '', inStat, outStat, nonWork };
  }
  return byDay;
}
