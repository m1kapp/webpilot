// 웹 대시보드와 확장이 같은 합계를 내는지 대조한다.
//
// 웹은 처음부터 52h 한도를 '평일 초과근무'에만 걸었다(public/index.html: ot += x.otMin,
// over52 = ot > 52h). 휴일근무는 hol로 따로 뒀다. 확장이 그 둘을 합쳐 '초과근무 합계'로
// 부르면서 어긋났고, 정정·누락일을 빼지 않아 한 번 더 어긋났다.
// 여기서는 웹 화면의 계산식을 그대로 옮겨 적고 코어가 같은 값을 내는지 본다.
import { buildDays, summarizeDays } from '../src/core/attendance.mjs';

// public/index.html:1274-1281 의 합계 루프를 그대로 베낀 것(비교 기준).
// exclude는 '정정한 날은 초과근무 합계에서 제외' 체크박스이고 화면 기본값은 켜짐이다.
function webDashboardTotals(days, exclude = true) {
  let ot = 0, hol = 0;
  for (const x of days) {
    if (x.missing) continue;
    if (x.corrected && exclude) continue;
    hol += x.holMin;
    ot += x.otMin;      // 웹의 '초과근무 합계' = 평일 8h 초과분. 휴일근무는 안 섞인다.
  }
  return { wdOt: ot, hol, over52: ot > 52 * 60 };
}

const D = (day, inH, outH) => [day, { inH, outH, recogMin: 480, policy: '', inStat: '출근', outStat: '퇴근', nonWork: '' }];
const byDay = Object.fromEntries([
  D(1, 9, 20),            // 평일 야근
  D(2, 9, 23),            // 평일 야근
  D(4, 9, 30),            // 21시간 체류 — 미체크아웃 의심 → 양쪽 다 제외
  D(11, 10, 18),          // 토요일 → 휴일근무
  D(12, 10, 22),          // 일요일 → 휴일근무
  D(8, 9, 22),            // 평일 야근 — 아래에서 정정일로 지정
  D(9, 9, null),          // 한쪽만 기록 → 누락
]);
const built = buildDays(byDay, '2026-07', { 8: { reason: '퇴근 누락', status: '승인' } });
const web = webDashboardTotals(built.days);
const core = summarizeDays(built.days, { throughDay: built.summary.spanDays });

const fails = [];
const check = (name, ok, got) => { console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${got}`}`); if (!ok) fails.push(name); };

console.log('── 웹 대시보드 vs 코어 ──');
console.log(`  웹    평일 초과 ${web.wdOt}분 · 휴일 근무 ${web.hol}분 · 52h 초과 ${web.over52}`);
console.log(`  코어  평일 초과 ${core.wdOtMin}분 · 휴일 근무 ${core.holMin}분 · 52h 초과 ${core.overLimit}`);
check('평일 초과근무 일치', web.wdOt === core.wdOtMin, `웹 ${web.wdOt} vs 코어 ${core.wdOtMin}`);
check('휴일 근무 일치', web.hol === core.holMin, `웹 ${web.hol} vs 코어 ${core.holMin}`);
check('52h 한도 판정 일치', web.over52 === core.overLimit, `웹 ${web.over52} vs 코어 ${core.overLimit}`);

console.log('\n── 예전 확장이 쓰던 값과의 차이(회귀 방지) ──');
const oldHeadline = built.summaryRaw.otSum;   // 평일+휴일을 합치고 아무것도 안 뺀 값
console.log(`  예전 '초과근무 합계' ${oldHeadline}분 vs 지금 '평일 초과근무' ${core.wdOtMin}분`);
check('예전 값이 더 큼(합산·미제외 때문)', oldHeadline > core.wdOtMin, `${oldHeadline} vs ${core.wdOtMin}`);
check('휴일근무가 한도 대상에서 빠졌음', core.wdOtMin + core.holMin !== core.wdOtMin || core.holMin === 0,
  `평일 ${core.wdOtMin} · 휴일 ${core.holMin}`);

console.log('\n── 제외 목록 ──');
check('정정일 보고', core.correctedDays.includes(8), core.correctedDays.join());
check('의심일 보고', core.suspectDays.includes(4), core.suspectDays.join());
check('누락일 보고', core.missingDays.includes(9), core.missingDays.join());

console.log(fails.length ? `\n실패 ${fails.length}건: ${fails.join(', ')}` : '\n전부 통과');
process.exit(fails.length ? 1 : 0);
