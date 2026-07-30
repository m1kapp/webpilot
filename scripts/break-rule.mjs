// 휴게 공제 규칙 검증.
// 예전에는 근로시간 계산이 하루 일괄 90분을 뺐다. 차트는 순차로(4h→점심 1h→4h→저녁 30m)
// 쪼개는데 계산만 일괄이라, 짧은 날은 먹지도 않은 저녁까지 공제됐다.
// 여기서 두 가지를 본다 — 규칙이 상식에 맞는지, 그리고 차트와 계산이 같은 양을 떼는지.
import { breakMinFor, buildDays } from '../src/core/attendance.mjs';
import { segmentDay } from '../src/core/clockchart.mjs';

const fails = [];
const check = (name, ok, got) => { console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${got}`}`); if (!ok) fails.push(name); };

console.log('── 체류 시간별 휴게 공제 ──');
const CASES = [
  [3, 0, '3시간만 있었으면 휴게 없음'],
  [4, 0, '4시간 — 점심 전'],
  [4.5, 30, '4시간 30분 — 점심 30분만'],
  [5, 60, '5시간 — 점심 1시간 다 참'],
  [9, 60, '9시간 — 아직 저녁 전'],
  [9.25, 15, '9시간 15분 — 저녁 15분'],
  [9.5, 90, '9시간 30분 — 점심+저녁 다 참'],
  [14.8, 90, '14시간 48분 — 최대 90분에서 멈춤'],
];
for (const [span, want, label] of CASES) {
  const got = Math.round(breakMinFor(span));
  const expect = span === 9.25 ? 75 : want;   // 9.25h = 점심 60 + 저녁 15
  check(`${label} → ${expect}분`, got === expect, `${got}분`);
}

console.log('\n── 차트 쪼개기와 계산이 같은 양을 떼는가 ──');
// 하루 종일 붙어 있는 날부터 반차까지 훑는다.
for (let span = 1; span <= 15; span += 0.5) {
  const inH = 9, outH = 9 + span;
  const built = buildDays({ 15: { inH, outH, recogMin: 480, policy: '', inStat: '출근', outStat: '퇴근', nonWork: '' } }, '2026-07');
  const day = built.days.find((d) => d.day === 15);
  const seg = segmentDay(day, {});
  // 막대에서 근무로 칠해지는 부분(점심·저녁 제외) = 계산상 근로시간이어야 한다
  const paintedWorkH = (seg.am || 0) + (seg.pm || 0) + (seg.ot || 0);
  const okMatch = Math.abs(paintedWorkH * 60 - day.workMin) < 0.6;
  if (!okMatch) check(`체류 ${span}h — 막대 ${(paintedWorkH * 60).toFixed(0)}분 vs 계산 ${day.workMin.toFixed(0)}분`, false, '불일치');
}
check('모든 체류 시간에서 막대 = 계산', !fails.some((f) => f.includes('막대')), '위 목록 참고');

console.log('\n── 초과근무가 나는 날은 숫자가 안 바뀌어야 한다 ──');
// 9.5시간 이상 머문 날은 예전 일괄 90분과 결과가 같다 = 기존 초과근무 수치 보존
for (const span of [9.5, 11, 12.5, 14.8]) {
  const got = Math.round(breakMinFor(span));
  check(`체류 ${span}h 공제 90분 유지`, got === 90, `${got}분`);
}

console.log('\n── 짧은 날이 실제로 개선되는가 ──');
const short = buildDays({ 3: { inH: 9, outH: 13, recogMin: 240, policy: '', inStat: '출근', outStat: '퇴근', nonWork: '' } }, '2026-07');
const d3 = short.days.find((d) => d.day === 3);
check('09:00~13:00(반차) 근로 4시간', Math.round(d3.workMin) === 240, `${d3.workMin}분`);
console.log(`  예전 일괄 90분이면 ${240 - 90}분으로 잡혔을 날이다.`);

console.log(fails.length ? `\n실패 ${fails.length}건: ${fails.join(', ')}` : '\n전부 통과');
process.exit(fails.length ? 1 : 0);
