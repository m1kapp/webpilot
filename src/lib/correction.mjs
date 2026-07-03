// 근태 정정 레시피: 타임인아웃 누락일 탐지 → Flow 활동시간으로 실제 근무시간대 추정
import { existsSync } from 'node:fs';
import { getBrowser } from './browser.mjs';
import { getOvertimeEmployee } from './timeinout.mjs';
import { getDayActivity } from './flow.mjs';

const USER_AUTH = '.auth/timeinout-user.json';
// 결재함 상신함에서 '이미 신청한 출퇴근시간수정' 내역 수집 → date별 {status, reqIn, reqOut}
async function getSubmittedCorrections(log) {
  if (!existsSync(USER_AUTH)) return {};
  const myName = process.env.TIMEINOUT_NAME || '유민호';
  const browser = await getBrowser();
  const ctx = await browser.newContext({ storageState: USER_AUTH });
  try {
    const p = await ctx.newPage();
    await p.goto('https://user.timeinout.kr/ApprovalMng/Index', { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
    if (/login/i.test(p.url())) { log('결재함 세션 만료 — 신청내역 skip'); return {}; }
    await p.getByText('상신함', { exact: true }).first().click({ timeout: 5000 }).catch(() => {});
    await p.waitForTimeout(3000);
    const map = await p.evaluate((nm) => {
      const out = {};
      for (const el of document.querySelectorAll('tr, li, [class*=doc], [class*=list] > div')) {
        const t = (el.innerText || '').replace(/\s+/g, ' ');
        if (!/출퇴근시간수정/.test(t) || !t.includes('신청자 ' + nm)) continue;
        const m = t.match(/출퇴근시간수정\s*(대기|승인|반려)?[\s\S]*?신청 내용\s*(\d{4}-\d{2}-\d{2})[\s\S]*?\(신청\)\s*(\d{1,2}:\d{2})\s*~\s*(\d{1,2}:\d{2})/);
        if (m && m[1] !== '반려' && !out[m[2]]) out[m[2]] = { status: m[1] || '대기', reqIn: m[3], reqOut: m[4] };
      }
      return out;
    }, myName);
    log('이미 신청된 정정 ' + Object.keys(map).length + '건: ' + Object.keys(map).join(', '));
    return map;
  } catch (e) { log('결재함 조회 실패: ' + e.message.split('\n')[0]); return {}; }
  finally { await ctx.close().catch(() => {}); }
}

// 정정 규칙: 출근 최대 10:30(애매하면 10:30) · 퇴근 최소 18:00 · 근무 9시간 보장
const LATEST_IN = 630, EARLIEST_OUT = 1080, MIN_WORK = 540; // 분
const toMin = (t) => { const m = String(t || '').match(/(\d{1,2}):(\d{2})/); return m ? (+m[1]) * 60 + (+m[2]) : null; };
const toHHMM = (mn) => `${String(Math.floor((mn % 1440) / 60)).padStart(2, '0')}:${String(mn % 60).padStart(2, '0')}`;

// 기존 기록 + Flow 활동으로 누락 유형 판정 + 출퇴근 시각 제안
function analyze(d, flowFirst, flowLast) {
  const inM = toMin(d.inText), outM = toMin(d.outText);
  const inValid = inM != null && inM >= 300 && inM <= 840;   // 05:00~14:00 = 정상 출근
  const outValid = outM != null && outM >= 1020;             // 17:00~ = 정상 퇴근
  const fIn = toMin(flowFirst), fOut = toMin(flowLast);

  // 출근: 유효하면 유지, 아니면 Flow 첫 활동(단 10:30 넘으면 10:30) or 10:30
  const sIn = inValid ? inM : Math.min(fIn != null ? fIn : LATEST_IN, LATEST_IN);
  // 퇴근: 유효하면 유지, 아니면 max(18:00, Flow 마지막)
  let sOut = outValid ? outM : Math.max(EARLIEST_OUT, fOut != null ? fOut : EARLIEST_OUT);
  if (sOut - sIn < MIN_WORK) sOut = sIn + MIN_WORK;          // 근무 9시간 보장

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
  const today = new Date().toISOString().slice(0, 10);
  const p2 = (n) => String(n).padStart(2, '0');

  // 이미 신청한 정정(대기/승인) 내역
  const submitted = await getSubmittedCorrections(log);

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
    summary: { count: items.length, submitted: alreadyCount, pending: items.length - alreadyCount, withEvidence: items.filter((x) => x.hasEvidence).length },
  };
}
