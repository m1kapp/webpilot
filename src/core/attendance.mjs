// 코어: 근태 계산. 정규화된 byDay를 받아 일자별 결과 + 월 합계를 만든다.
// 수집 방식(Playwright 다운로드 / 확장 탭 주입)과 무관 — 어댑터가 byDay 모양만 맞춰 주면 된다.
import { DOW, KR_HOLIDAYS, monthRange } from './calendar.mjs';
import { fmt, hhmm, kstNow, parseDurMin, parseTimeH, serialToDate } from './util.mjs';

export const DAILY_BASE = 8 * 60;      // 480분
export const MONTH_LIMIT = 52 * 60;    // 3120분
export const BREAK_MIN = 90;           // 점심 60 + 저녁 30 (하루 최대 공제)

// 휴게는 근무가 길어질수록 순서대로 붙는다 — 4시간 일하고 점심 1시간, 다시 4시간 일하고 저녁 30분.
// 차트(clockchart)가 막대를 쪼개는 방식과 같은 규칙이다. 예전에는 여기서만 일괄 90분을 빼서,
// 반차처럼 짧은 날에도 먹지도 않은 저녁 30분이 공제돼 근로시간이 실제보다 적게 잡혔다.
// 9시간 30분 이상 머문 날은 결과가 90분으로 같다 — 즉 초과근무가 나는 날의 숫자는 변하지 않는다.
export function breakMinFor(spanH) {
  if (spanH == null || !(spanH > 0)) return 0;
  const lunch = Math.min(Math.max(0, spanH - 4), 1);
  const dinner = Math.min(Math.max(0, spanH - 9), 0.5);
  return (lunch + dinner) * 60;
}
export const SUSPECT_MIN = 16 * 60;    // 16시간 초과 = 미체크아웃 의심

// 공용 계산부: 정규화 byDay { inH, outH(익일이면 >24), recogMin, policy, inStat, outStat, nonWork } → days + summary
export function buildDays(byDay, month, corrections = {}, leaves = {}, trips = {}, opts = {}) {
  const { y, m, last } = monthRange(month);
  const days = [];
  let totalMin = 0, wdOtSum = 0, holSum = 0, recogTotal = 0;
  let adjTotal = 0, adjWdOt = 0, adjHol = 0;
  const nowKST = kstNow();
  const todayStr = nowKST.toISOString().slice(0, 10);
  const nowH = nowKST.getUTCHours() + nowKST.getUTCMinutes() / 60;
  const ymNow = nowKST.getUTCFullYear() * 100 + (nowKST.getUTCMonth() + 1);
  const ymThis = y * 100 + m;
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
    const spanH = (hasIn && hasOut) ? effOutH - e.inH : null;                  // 출근~퇴근 체류 시간
    const rawWork = spanH != null ? Math.max(0, spanH * 60 - breakMinFor(spanH)) : 0; // 찐 근로(휴게 제외)
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
    // 이번 달이면 오늘까지, 지난 달이면 달 전체를 주 평균의 분모로 삼는다.
    summary: summarizeDays(days, { throughDay: ymThis === ymNow ? nowKST.getUTCDate() : last, ...opts }),
    // 아무것도 안 뺀 날것 롤업. 화면에는 안 쓰고 대조·디버깅용으로만 남긴다.
    summaryRaw: {
      totalMin, totalText: fmt(totalMin),
      otSum, otText: fmt(otSum), otHours: +(otSum / 60).toFixed(1),
      wdOtMin: wdOtSum, wdOtText: fmt(wdOtSum),
      holMin: holSum, holText: fmt(holSum),
      recogMin: recogTotal, recogText: fmt(recogTotal),
      gapMin: gap, gapText: fmt(gap),
      rawTotalMin: adjTotal, rawTotalText: fmt(adjTotal),
      rawOtSum, rawOtText: fmt(rawOtSum), rawOtHours: +(rawOtSum / 60).toFixed(1),
    },
  };
}

// 화면에 쓰는 합계. buildDays의 날것 롤업과 달리 두 가지를 뺀다.
//   · 기록 누락·미체크아웃 의심일 — 펀치를 못 믿으니 초과로 세면 안 된다
//   · 정정 신청한 날 — 기본은 제외(정정 결과로 따로 정산되므로 중복이 된다)
// 이 규칙이 데스크톱 화면에만 있어서 확장이 초과근무를 과다 집계했다.
// 합계는 항상 "차트에 색으로 보이는 영역의 합"과 일치해야 한다.
// 지표마다 정정일 취급이 다르다. 한도 관리용 숫자에서는 빼고, 실제로 얼마나 일했나를
// 보는 숫자에서는 넣는다. 하나의 토글로 전부 뒤집으면 둘 중 하나는 반드시 틀린다.
//   · 평일 초과근무(52h 한도 대상) — 정정·누락·의심일 제외
//   · 주 평균 근로·총 근로       — 정정 포함(실제 일한 시간이므로), 누락·의심만 제외
export function summarizeDays(days, { throughDay = 0 } = {}) {
  let totalMin = 0, totalAllMin = 0, wdOtSum = 0, holSum = 0, recogTotal = 0, projOt = 0;
  let inSum = 0, inCnt = 0, outSum = 0, outCnt = 0;
  const missingDays = [], correctedDays = [], suspectDays = [];
  for (const x of days) {
    if (x.suspect) suspectDays.push(x.day);
    if (x.missing) { missingDays.push(x.day); continue; }   // 펀치를 못 믿는 날은 어느 쪽에도 안 넣는다
    totalAllMin += x.workMin;                               // 정정 포함 — "실제로 일한 시간"

    // 평균 출퇴근 시각 — 평일만. 휴일근무는 불규칙해서 섞으면 평균이 왜곡된다.
    // 정정일은 넣는다(실제로 그 시각에 있었으므로). 퇴근은 아직 안 찍은 날을 뺀다 —
    // 진행중인 날의 '지금 시각'은 퇴근 시각이 아니다.
    if (!x.holiday && x.inH != null) { inSum += x.inH; inCnt++; }
    if (!x.holiday && x.outH != null && !x.projected) { outSum += x.outH; outCnt++; }

    if (x.corrected) { correctedDays.push(x.day); continue; }
    totalMin += x.workMin;
    wdOtSum += x.otMin;
    holSum += x.holMin;
    recogTotal += x.recogWorkMin;
    if (x.projected) projOt += x.otMin;                     // 아직 퇴근 전 — 확정분과 구분
  }

  // 주 평균: 지난 달은 달 전체로, 이번 달은 오늘까지로 나눈다.
  // 월말까지 다 지나지도 않았는데 31일로 나누면 평균이 실제보다 낮게 보인다.
  const span = throughDay > 0 ? Math.min(throughDay, days.length) : days.length;
  const weeks = Math.max(span, 1) / 7;
  const weeklyAvgMin = totalAllMin / weeks;

  return {
    // 52h 한도의 대상 — 평일 초과근무만. 휴일근무는 여기 안 들어간다.
    wdOtMin: wdOtSum, wdOtText: fmt(wdOtSum), wdOtHours: +(wdOtSum / 60).toFixed(1),
    limitHours: 52, overLimit: wdOtSum > MONTH_LIMIT,
    limitRemainMin: Math.max(0, MONTH_LIMIT - wdOtSum), limitOverMin: Math.max(0, wdOtSum - MONTH_LIMIT),
    projOtMin: projOt, confirmedOtMin: wdOtSum - projOt,

    // 휴일근무 — 별도 집계. 한도와 무관.
    holMin: holSum, holText: fmt(holSum),

    // 평균 출퇴근 시각 (평일·정정 포함). 자정을 넘긴 퇴근은 hhmm이 '익일 HH:MM'으로 낸다.
    avgInH: inCnt ? +(inSum / inCnt).toFixed(4) : null,
    avgOutH: outCnt ? +(outSum / outCnt).toFixed(4) : null,
    avgInText: inCnt ? hhmm(inSum / inCnt) : '',
    avgOutText: outCnt ? hhmm(outSum / outCnt) : '',
    avgStayMin: inCnt && outCnt ? Math.round((outSum / outCnt - inSum / inCnt) * 60) : 0,
    avgStayText: inCnt && outCnt ? fmt(Math.round((outSum / outCnt - inSum / inCnt) * 60)) : '',
    avgInDays: inCnt, avgOutDays: outCnt,

    // 실제로 일한 시간 (정정 포함)
    totalAllMin, totalAllText: fmt(totalAllMin),
    weeklyAvgMin: Math.round(weeklyAvgMin), weeklyAvgText: fmt(Math.round(weeklyAvgMin)),
    weeks: +weeks.toFixed(2), spanDays: span,
    fullDays: +(totalAllMin / DAILY_BASE).toFixed(1),   // 8시간 = 하루로 환산하면 며칠치인가

    // 정정 제외 기준(한도 대상과 같은 날짜 집합)
    totalMin, totalText: fmt(totalMin),
    recogMin: recogTotal, recogText: fmt(recogTotal),
    gapMin: totalMin - recogTotal, gapText: fmt(totalMin - recogTotal),

    missingDays, correctedDays, suspectDays,
    cappedDays: days.filter((d) => d.capped).length,
  };
}

// 관리자 xlsx 시트 행 → 정규화 byDay
// 컬럼: 0날짜 7근로정책상세 8실출근 9실퇴근 10인정출근 11인정퇴근 12출근상태 13퇴근상태 15비업무
export function rowsToByDay(rows) {
  const toH = (serial, inSerial) => serial == null ? null : +(((serial - Math.floor(inSerial ?? serial)) * 24)).toFixed(4);
  // 엑셀 시리얼(하루=1)이라 24를 곱해 시간으로 바꿔 휴게를 매긴다.
  const netWork = (a, b) => {
    if (a == null || b == null) return 0;
    const spanH = (b - a) * 24;
    return Math.max(0, spanH * 60 - breakMinFor(spanH));
  };
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
