// 집계 규정 검증. 사내 규정이라 코드만 봐서는 알 수 없는 약속들이라 여기에 못박는다.
//   1. 52h 한도의 대상은 '평일 초과근무'다. 휴일근무는 별도 집계이고 한도에 안 들어간다.
//   2. 평일 초과근무에서 정정일은 제외한다.
//   3. 주 평균 근로는 정정을 포함한다(실제로 일한 시간이므로).
//   4. 기록 누락·미체크아웃 의심일은 어느 쪽에도 안 들어간다.
import { buildDays, summarizeDays, MONTH_LIMIT } from '../src/core/attendance.mjs';

const fails = [];
const check = (name, ok, got) => { console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${got}`}`); if (!ok) fails.push(name); };
const W = (inH, outH) => ({ inH, outH, recogMin: 480, policy: '', inStat: '출근', outStat: '퇴근', nonWork: '' });

// 2026-07: 1일(수) ~ 31일(금). 4·5일 = 토·일.
const byDay = {
  1: W(9, 20),     // 평일 11h 체류 → 근로 9.5h → 초과 1.5h
  2: W(9, 21),     // 평일 12h → 10.5h → 초과 2.5h
  4: W(10, 18),    // 토요일 8h → 휴일근무 6.5h
  5: W(10, 16),    // 일요일 6h → 휴일근무 5h
  8: W(9, 22),     // 평일 13h → 11.5h → 초과 3.5h — 아래에서 정정일로
  9: { inH: 9, outH: null, recogMin: 0, policy: '', inStat: '출근', outStat: '', nonWork: '' }, // 한쪽만 → 누락
};
const built = buildDays(byDay, '2026-07', { 8: { reason: '퇴근 누락', status: '승인' } });
const s = built.summary;

console.log('── 1. 52h 한도는 평일 초과근무만 ──');
console.log(`  평일 초과 ${s.wdOtText} · 휴일 근무 ${s.holText}`);
check('휴일근무가 평일 초과에 섞이지 않음', s.wdOtMin === 240, `${s.wdOtMin}분 (기대 240)`);
check('휴일근무는 따로 집계', s.holMin === 720, `${s.holMin}분 (기대 720: 토 7h + 일 5h)`);
check('한도 판정이 평일 초과 기준', s.overLimit === (s.wdOtMin > MONTH_LIMIT), `overLimit=${s.overLimit}`);

// 휴일근무를 아무리 늘려도 한도 판정이 흔들리면 안 된다.
const heavyHoliday = buildDays({ ...byDay, 4: W(0, 24), 5: W(0, 24), 11: W(0, 24), 12: W(0, 24) }, '2026-07', { 8: { reason: 'x', status: '승인' } });
check('휴일근무 90h여도 한도 초과 아님', heavyHoliday.summary.overLimit === false,
  `휴일 ${heavyHoliday.summary.holText} · overLimit=${heavyHoliday.summary.overLimit}`);

console.log('\n── 2. 평일 초과근무는 정정 제외 ──');
check('정정일(8일)이 초과에서 빠짐', !s.wdOtMin || s.wdOtMin === 240, `${s.wdOtMin}분`);
check('정정일이 목록에 보고됨', s.correctedDays.join() === '8', s.correctedDays.join());

console.log('\n── 3. 주 평균 근로는 정정 포함 ──');
// 정정 제외 총 근로 + 정정일 근로 = 정정 포함 총 근로
const corrDayWork = built.days.find((x) => x.day === 8).workMin;
check('총 근로(정정 포함)에 정정일이 들어감', Math.round(s.totalAllMin) === Math.round(s.totalMin + corrDayWork),
  `${s.totalAllMin} vs ${s.totalMin}+${corrDayWork}`);
check('주 평균이 정정 포함 총 근로 기준', Math.round(s.weeklyAvgMin) === Math.round(s.totalAllMin / (s.spanDays / 7)),
  `${s.weeklyAvgMin} vs ${Math.round(s.totalAllMin / (s.spanDays / 7))}`);
console.log(`  총 근로 ${s.totalAllText} ÷ ${s.weeks}주 = 주 평균 ${s.weeklyAvgText}`);

console.log('\n── 4. 누락·의심일은 어느 쪽에도 없음 ──');
check('한쪽만 찍힌 9일이 누락으로 잡힘', s.missingDays.includes(9), s.missingDays.join());
const withoutMissing = summarizeDays(built.days.filter((x) => !x.missing), { throughDay: s.spanDays });
check('누락일을 빼도 숫자가 같음', withoutMissing.totalAllMin === s.totalAllMin && withoutMissing.wdOtMin === s.wdOtMin,
  `${withoutMissing.totalAllMin}/${withoutMissing.wdOtMin} vs ${s.totalAllMin}/${s.wdOtMin}`);

console.log('\n── 5. 8시간 환산 ──');
check('총 근로 ÷ 8h = 며칠치', Math.abs(s.fullDays - s.totalAllMin / 480) < 0.05, `${s.fullDays}일`);
console.log(`  ${s.totalAllText} = 8시간 기준 ${s.fullDays}일치`);

console.log('\n── 6. 평균 출퇴근 시각 ──');
// 평일 1일(09~20) · 2일(09~21) · 8일 정정(09~22). 휴일 4·5일은 빠져야 한다.
// 평균 출근 = 09:00, 평균 퇴근 = (20+21+22)/3 = 21:00
check('평균 출근 09:00', s.avgInText === '09:00', s.avgInText);
check('평균 퇴근 21:00', s.avgOutText === '21:00', s.avgOutText);
check('정정일이 평균에 포함됨(3일 기준)', s.avgOutDays === 3, `${s.avgOutDays}일`);
check('평균 체류 = 12시간', s.avgStayMin === 720, `${s.avgStayMin}분`);
console.log(`  ${s.avgInText} → ${s.avgOutText} · 체류 ${s.avgStayText} (평일 ${s.avgOutDays}일)`);

// 휴일근무만 잔뜩 있어도 평일 평균은 흔들리지 않아야 한다.
const holNoise = buildDays({ 1: W(9, 18), 4: W(6, 23), 5: W(6, 23), 11: W(6, 23) }, '2026-07');
check('휴일근무는 평균에 안 섞임', holNoise.summary.avgInText === '09:00', holNoise.summary.avgInText);

// 자정을 넘긴 퇴근은 '익일 HH:MM'으로. 22시·익일 02시 → 평균 익일 00:00
const midnight = buildDays({ 1: W(9, 22), 2: W(9, 26) }, '2026-07');
check('자정 넘긴 퇴근 평균 = 익일 00:00', midnight.summary.avgOutText === '익일 00:00', midnight.summary.avgOutText);

// 아직 퇴근 안 찍은 날은 퇴근 평균에서 빠지되 출근 평균에는 들어간다.
const kst = new Date(Date.now() + 9 * 3600 * 1000);
const today = kst.getUTCDate();
const thisMonth = `${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, '0')}`;
const ongoing = buildDays({ [today]: { inH: 8, outH: null, recogMin: 0, policy: '', inStat: '출근', outStat: '', nonWork: '' } }, thisMonth);
const od = ongoing.days.find((x) => x.day === today);
if (od && od.projected) {
  check('진행중인 날은 퇴근 평균에서 제외', ongoing.summary.avgOutDays === 0, `${ongoing.summary.avgOutDays}일`);
  check('진행중인 날도 출근 평균에는 포함', ongoing.summary.avgInDays === 1, `${ongoing.summary.avgInDays}일`);
} else {
  console.log('  (오늘이 휴일이라 진행중 검사는 건너뜀)');
}

console.log('\n── 7. 지난 달은 달 전체로 나눈다 ──');
const past = buildDays({ 1: W(9, 18) }, '2026-03');   // 3월 31일
check('지난 달 분모 = 달 일수', past.summary.spanDays === 31, `${past.summary.spanDays}일`);

console.log(fails.length ? `\n실패 ${fails.length}건: ${fails.join(', ')}` : '\n전부 통과');
process.exit(fails.length ? 1 : 0);
