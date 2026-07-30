// 웹 대시보드와 확장이 같은 합계를 내는지 대조한다.
// 예전 버그: 웹은 화면에서 합계를 다시 계산하면서 누락·의심일과 정정일을 뺐는데,
// 코어 롤업은 그걸 안 빼서 그대로 쓰는 확장이 초과근무를 과다 집계했다.
// 여기서는 웹 화면(public/index.html)의 계산식을 그대로 옮겨 적고,
// 코어 summarizeDays가 같은 값을 내는지 본다.
import { buildDays, summarizeDays } from '../src/core/attendance.mjs';

// public/index.html:1274-1281 의 합계 루프를 그대로 베낀 것(비교 기준).
function webDashboardTotals(days, exclude) {
  let ot = 0, hol = 0;
  for (const x of days) {
    if (x.missing) continue;
    if (x.corrected && exclude) continue;
    hol += x.holMin;
    ot += x.otMin;
  }
  return { ot: ot + hol, wdOt: ot, hol };
}

// 하루치 원시 입력. inH/outH는 시(hour) 소수.
const D = (day, inH, outH, extra = {}) => [day, { inH, outH, recogMin: 480, policy: '', inStat: '출근', outStat: '퇴근', nonWork: '', ...extra }];

const byDay = Object.fromEntries([
  D(1, 9, 20),            // 평일 야근 — 11h − 1.5h = 9.5h → 초과 1.5h
  D(2, 9, 23),            // 평일 야근 — 14h − 1.5 = 12.5h → 초과 4.5h
  D(4, 9, 30),            // 21시간 — 미체크아웃 의심(16h 초과) → 제외 대상
  D(6, 10, 18),           // 토요일 → 휴일근무
  D(7, 10, 22),           // 일요일 → 휴일근무
  D(8, 9, 22),            // 평일 야근, 아래에서 정정일로 지정
  D(9, 9, null),          // 한쪽만 기록 → 누락
]);
const corrections = { 8: { reason: '퇴근 누락', status: '승인' } };
const built = buildDays(byDay, '2026-07', corrections);

const fails = [];
const check = (name, ok, got) => { console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${got}`}`); if (!ok) fails.push(name); };

for (const exclude of [true, false]) {
  const web = webDashboardTotals(built.days, exclude);
  const core = summarizeDays(built.days, { excludeCorrected: exclude });
  console.log(`\n── 정정 제외 ${exclude ? 'ON' : 'OFF'} ──`);
  console.log(`  웹 기준   초과합계 ${web.ot}분 (평일 ${web.wdOt} · 휴일 ${web.hol})`);
  console.log(`  코어      초과합계 ${core.otSum}분 (평일 ${core.wdOtMin} · 휴일 ${core.holMin})`);
  check(`초과 합계 일치 (제외 ${exclude ? 'ON' : 'OFF'})`, web.ot === core.otSum, `웹 ${web.ot} vs 코어 ${core.otSum}`);
  check(`평일 초과 일치 (제외 ${exclude ? 'ON' : 'OFF'})`, web.wdOt === core.wdOtMin, `웹 ${web.wdOt} vs 코어 ${core.wdOtMin}`);
  check(`휴일 근무 일치 (제외 ${exclude ? 'ON' : 'OFF'})`, web.hol === core.holMin, `웹 ${web.hol} vs 코어 ${core.holMin}`);
}

// 날것 롤업은 더 커야 한다 — 그게 확장이 쓰던 값이고, 과다 집계의 정체다.
const on = summarizeDays(built.days, { excludeCorrected: true });
console.log(`\n날것 롤업(예전 확장이 쓰던 값) ${built.summaryRaw.otSum}분 vs 화면 합계 ${on.otSum}분`);
check('날것 롤업이 화면 합계보다 큼(과다 집계 재현)', built.summaryRaw.otSum > on.otSum,
  `${built.summaryRaw.otSum} vs ${on.otSum}`);
check('제외된 날이 보고됨', on.missingDays.length > 0 && on.correctedDays.length > 0 && on.suspectDays.length > 0,
  `누락 ${on.missingDays} · 정정 ${on.correctedDays} · 의심 ${on.suspectDays}`);
check('buildDays 기본 summary가 화면 규칙을 따름', built.summary.otSum === on.otSum,
  `${built.summary.otSum} vs ${on.otSum}`);

console.log(fails.length ? `\n실패 ${fails.length}건: ${fails.join(', ')}` : '\n전부 통과');
process.exit(fails.length ? 1 : 0);
