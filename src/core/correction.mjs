// 코어: 근태 정정 제안값 계산. 환경 무관.
import { parseTimeMin } from './util.mjs';

// 정정 규칙: 출근 최대 10:30(애매하면 10:30) · 퇴근 최소 18:00 · 근무 9시간 보장
const EARLIEST_IN = 360, LATEST_IN = 630, EARLIEST_OUT = 1080, MIN_WORK = 540; // 분 (06:00 / 10:30 / 18:00 / 9h)
const toHHMM = (mn) => `${String(Math.floor((mn % 1440) / 60)).padStart(2, '0')}:${String(mn % 60).padStart(2, '0')}`;

// 기존 기록 + Flow 활동으로 누락 유형 판정 + 출퇴근 시각 제안
export function suggestCorrection(d, flowFirst, flowLast) {
  const inM = parseTimeMin(d.inText), outM = parseTimeMin(d.outText);
  const inValid = inM != null && inM >= 300 && inM <= 840;   // 05:00~14:00 = 정상 출근
  const outValid = outM != null && outM >= 1020;             // 17:00~ = 정상 퇴근
  const fIn = parseTimeMin(flowFirst), fOut = parseTimeMin(flowLast);

  // 출근: 유효하면 유지. 아니면 Flow 첫 활동이 오전(06:00~10:30) 범위일 때만 채택, 그 밖(심야 등)은 10:30
  const sIn = inValid ? inM : (fIn != null && fIn >= EARLIEST_IN && fIn <= LATEST_IN ? fIn : LATEST_IN);
  // 퇴근: 유효하면 실제 기록 유지(덮어쓰지 않음). 아니면 max(18:00, Flow 마지막)
  let sOut = outValid ? outM : Math.max(EARLIEST_OUT, fOut != null ? fOut : EARLIEST_OUT);
  // 근무 9시간 보장은 '퇴근이 유효 기록이 아닐 때'만 — 실제 퇴근 기록을 조작하지 않도록
  if (!outValid && sOut - sIn < MIN_WORK) sOut = sIn + MIN_WORK;

  let caseLabel;
  if (!d.inText && !d.outText) caseLabel = /결근/.test(d.status || '') ? '결근 · 양쪽 입력' : '양쪽 누락';
  else if (inValid && !outValid) caseLabel = '퇴근 누락';
  else if (!inValid && outValid) caseLabel = '출근 누락';
  else caseLabel = '기록 이상 · 재입력';

  return { caseLabel, suggestIn: toHHMM(sIn), suggestOut: toHHMM(sOut) };
}
