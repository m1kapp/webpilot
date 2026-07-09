// 근태 정정 레시피: 타임인아웃 누락일 탐지 → Flow 활동시간으로 실제 근무시간대 추정
import { existsSync } from 'node:fs';
import { getBrowser, snap } from './browser.mjs';
import { getOvertimeEmployee, getSubmittedCorrections } from './timeinout.mjs';
import { getDayActivity } from './flow.mjs';
import { authPath } from './paths.mjs';
export { getSubmittedCorrections }; // 하위호환: bizplay 등 기존 임포트 유지 (구현은 timeinout으로 이동)

const USER_AUTH = authPath('timeinout-user.json');

// 정정 규칙: 출근 최대 10:30(애매하면 10:30) · 퇴근 최소 18:00 · 근무 9시간 보장
const EARLIEST_IN = 360, LATEST_IN = 630, EARLIEST_OUT = 1080, MIN_WORK = 540; // 분 (06:00 / 10:30 / 18:00 / 9h)
const toMin = (t) => { const m = String(t || '').match(/(\d{1,2}):(\d{2})/); return m ? (+m[1]) * 60 + (+m[2]) : null; };
const toHHMM = (mn) => `${String(Math.floor((mn % 1440) / 60)).padStart(2, '0')}:${String(mn % 60).padStart(2, '0')}`;

// 기존 기록 + Flow 활동으로 누락 유형 판정 + 출퇴근 시각 제안
function analyze(d, flowFirst, flowLast) {
  const inM = toMin(d.inText), outM = toMin(d.outText);
  const inValid = inM != null && inM >= 300 && inM <= 840;   // 05:00~14:00 = 정상 출근
  const outValid = outM != null && outM >= 1020;             // 17:00~ = 정상 퇴근
  const fIn = toMin(flowFirst), fOut = toMin(flowLast);

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

export async function getCorrectionTargets({ month, id, pw, onSnapshot }) {
  const log = (m) => console.error('[correction]', m);
  const to = await getOvertimeEmployee({ month, id, pw, onSnapshot });
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); // KST 기준 오늘
  const p2 = (n) => String(n).padStart(2, '0');

  // 이미 신청한 정정 내역 (ok=false면 확인불가 → 중복 신청 차단)
  const { byDate: submitted, ok: submitOk } = await getSubmittedCorrections(log, month);

  // 정정 대상: 출근/퇴근 누락·의심 (미래·주말/휴일·휴가 제외) — 이미 신청된 것도 상태 표시로 포함
  const targets = (to.days || []).filter((d) => {
    const ds = `${month}-${p2(d.day)}`;
    if (ds > today) return false;
    if (d.weekend || d.holiday || d.isLeave) return false;
    return !d.inText || !d.outText || d.missing || d.suspect;
  });
  const alreadyCount = targets.filter((d) => submitted[`${month}-${p2(d.day)}`]).length;
  log(`정정 대상 ${targets.length}건 (신청됨 ${alreadyCount} · 신청필요 ${targets.length - alreadyCount}) · Flow 활동 조회`);

  const items = [];
  for (const d of targets) {
    const ds = `${month}-${p2(d.day)}`;
    const sub = submitted[ds];
    if (sub) { // 이미 신청됨 — Flow 조회 스킵, 신청 상태로 표시
      items.push({ date: ds, dow: d.dow, status: '신청됨', submitted: true, subStatus: sub.status, reqIn: sub.reqIn, reqOut: sub.reqOut, curIn: d.inText || '', curOut: d.outText || '', flowEvents: [], flowFirst: '', flowLast: '', suggestIn: '', suggestOut: '', hasEvidence: false });
      continue;
    }
    let act = { events: [], firstText: '', lastText: '' };
    try { act = await getDayActivity(ds); } catch (e) { log(`Flow ${ds} 실패: ` + e.message.split('\n')[0]); }
    const { caseLabel, suggestIn, suggestOut } = analyze(d, act.firstText, act.lastText);
    items.push({
      date: ds, dow: d.dow, status: caseLabel, submitted: false,
      curIn: d.inText || '', curOut: d.outText || '',
      flowEvents: act.events.map((e) => `${e.startText}~${e.endText} ${e.name}`),
      flowFirst: act.firstText, flowLast: act.lastText,
      suggestIn, suggestOut, hasEvidence: act.events.length > 0,
    });
  }
  return {
    recipe: 'correction', month, snapshots: to.snapshots || [], items,
    // submitCheckOk=false면 '이미 신청' 확인 실패 → UI에서 신청 버튼 잠금(중복 방지)
    summary: { count: items.length, submitted: alreadyCount, pending: items.length - alreadyCount, withEvidence: items.filter((x) => x.hasEvidence).length, submitCheckOk: submitOk },
  };
}

// 마스킹된 시각 input은 fill/타이핑이 꼬임 → React 네이티브 setter + 이벤트로 값 주입
async function setMaskedTime(page, name, val) {
  await page.evaluate(({ name, val }) => {
    const e = document.querySelector(`input[name="${name}"]`);
    if (!e) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(e, val);
    for (const t of ['input', 'change', 'keyup', 'blur']) e.dispatchEvent(new Event(t, { bubbles: true }));
  }, { name, val });
}

// 실제 상신: /InOutMng/InOutModify 폼에 출근/퇴근/사유 입력 → '수정 요청' 제출 (결재선은 프리셋)
// rows: [{ date:'YYYY-MM-DD', in:'HH:MM', out:'HH:MM' }]
export async function submitCorrections({ rows = [], memo, onSnapshot }) {
  const log = (m) => console.error('[correction:submit]', m);
  const snapshots = []; if (onSnapshot) snapshots.onSnap = onSnapshot;
  if (!existsSync(USER_AUTH)) throw new Error('타임인아웃 세션이 없습니다. 정정 조회를 먼저 실행하세요.');
  const hhmmss = (v) => { const m = String(v).match(/^(\d{1,2}):(\d{2})/); return m ? `${m[1].padStart(2, '0')}:${m[2]}:00` : null; };
  const browser = await getBrowser();
  const ctx = await browser.newContext({ storageState: USER_AUTH });
  const results = [];
  try {
    for (const r of rows) {
      const p = await ctx.newPage();
      p.on('dialog', (d) => d.accept().catch(() => {}));
      try {
        const inV = hhmmss(r.in), outV = hhmmss(r.out);
        if (!inV || !outV) throw new Error('시각 형식 오류(HH:MM)');
        await p.goto(`https://user.timeinout.kr/InOutMng/InOutModify?CheckDay=${r.date}`, { waitUntil: 'networkidle', timeout: 25000 });
        if (/login/i.test(p.url())) throw new Error('세션 만료 — 정정 조회를 먼저 실행');
        await p.waitForSelector('input[name="InOutData[0].inTimeApproval"]', { timeout: 8000 });
        await setMaskedTime(p, 'InOutData[0].inTimeApproval', inV);
        await setMaskedTime(p, 'InOutData[0].OutTimeApproval', outV);
        await p.fill('textarea[name="RequestInOutMemo"]', memo || '실제 근무시간으로 정정 요청 (webwing)');
        await snap(p, `정정 입력 ${r.date} · 출 ${inV} / 퇴 ${outV}`, snapshots);
        await p.getByRole('button', { name: '수정 요청' }).click({ timeout: 8000 });
        await p.waitForTimeout(2500);
        const ok = p.getByRole('button', { name: /^확인$/ });      // 확인 모달 있으면 수락
        if (await ok.count()) await ok.first().click({ timeout: 3000 }).catch(() => {});
        await p.waitForTimeout(2000);
        await snap(p, `정정 신청 제출 완료 ${r.date}`, snapshots);
        results.push({ date: r.date, in: inV, out: outV, ok: true });
        log(`정정 신청 완료: ${r.date} ${inV}~${outV}`);
      } catch (e) { const msg = e.message.split('\n')[0]; results.push({ date: r.date, ok: false, msg }); log(`정정 실패 ${r.date}: ${msg}`); }
      finally { await p.close().catch(() => {}); }
    }
  } finally { await ctx.close().catch(() => {}); }
  return { recipe: 'correction-submit', results, snapshots, okCount: results.filter((x) => x.ok).length, failCount: results.filter((x) => !x.ok).length };
}
