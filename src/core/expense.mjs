// 코어: 경비(야근택시·야근식비) 판정과 증빙 표 행 생성. 환경 무관.
import { fmt, parseTimeMin } from './util.mjs';

const hourOf = (d) => { const m = String(d).match(/\s(\d{1,2}):/); return m ? +m[1] : -1; };
export const isNight = (d) => { const h = hourOf(d); return h >= 23 || (h >= 0 && h <= 3); };  // 23~03시
export const isDinner = (d) => { const h = hourOf(d); return h >= 17 && h <= 22; };            // 저녁 17~22시
export const isBreakfast = (d) => { const h = hourOf(d); return h >= 5 && h <= 9; };           // 조식 05~09시
export const isYasikMeal = (d) => isDinner(d) || isBreakfast(d);                               // 야근식비 후보 시간대

// 야근식비 인정 판정: 저녁=그날 야근(초과>0), 조식=그날 출근<08:00. rec=타임인아웃 그날 데이터.
export function yasikClass(item, rec) {
  if (isDinner(item.date)) {
    const ot = rec ? ((rec.weekend || rec.holiday) ? rec.holMin : rec.otMin) : 0;
    if (rec && !rec.missing && ot > 0) return { ok: true, meal: '저녁', why: `야근 ${fmt(ot)}` };
    return { ok: false, meal: '저녁', why: '그날 야근 기록 없음' };
  }
  if (isBreakfast(item.date)) {
    if (rec && rec.inH != null && rec.inH < 8) return { ok: true, meal: '조식', why: `이른출근 ${rec.inText}` };
    return { ok: false, meal: '조식', why: rec && rec.inH != null ? `출근 ${rec.inText} (08시 이후)` : '출근기록 없음' };
  }
  return { ok: false, meal: '기타', why: '저녁/조식 시간대 아님' };
}

// 실제 펀치 기록 → 증빙 표 행
export function yagunProofRowFromRec(rec, dateStr, isHol, item) {
  return {
    date: dateStr, dow: rec.dow, kind: isHol ? 'hol' : 'ot',
    inText: rec.inText, outText: rec.outText,         // outText는 익일이면 '익일 HH:MM'
    workMin: rec.workMin, otMin: isHol ? rec.holMin : rec.otMin,
    taxiAt: item.date, amount: item.amount, corrStatus: '',
  };
}

// 정정 신청(대기)값 → 증빙 표 행 (승인 전 '미리 결의'용)
export function yagunProofRowFromCorr(corr, dateStr, rec, item) {
  const iM = parseTimeMin(corr.reqIn); let oM = parseTimeMin(corr.reqOut);
  const overnight = iM != null && oM != null && oM < iM;
  if (overnight) oM += 1440;
  const workMin = (iM != null && oM != null) ? oM - iM : 0;
  return {
    date: dateStr, dow: rec ? rec.dow : '', kind: 'corr',
    inText: corr.reqIn, outText: overnight ? `익일 ${corr.reqOut}` : corr.reqOut,
    workMin, otMin: Math.max(0, workMin - 480), taxiAt: item.date, amount: item.amount, corrStatus: corr.status || '',
  };
}
