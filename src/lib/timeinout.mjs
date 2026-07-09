// 타임인아웃 레시피 코어: 로그인 → 출퇴근 현황(/InOutMng, 찐 출퇴근) 다운로드 → 초과근무 분석
// 핵심: 회사 "근로인정시간"(정량 12시간 상한)이 아니라 실제 펀치(출근~퇴근)로 계산
import xlsx from 'xlsx';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getBrowser, closeBrowser, snap } from './browser.mjs';
import { authPath, ensureAuthDir } from './paths.mjs';
export { closeBrowser };

const HOST = 'https://com.timeinout.kr';
const USER_HOST = 'https://user.timeinout.kr';
const AUTH = authPath('timeinout-admin.json');
const USER_AUTH = authPath('timeinout-user.json');
const DAILY_BASE = 8 * 60;      // 480분
const MONTH_LIMIT = 52 * 60;    // 3120분
const BREAK_MIN = 90;           // 점심 60 + 저녁 30
const SUSPECT_MIN = 16 * 60;    // 16시간 초과 = 미체크아웃 의심
// 평일 공휴일 라벨/보정 (타임인아웃이 대부분 자체 마킹하지만 안전망 + 라벨용).
// 근로자의 날(5/1)은 관공서 공휴일은 아니나 근로기준법상 유급휴일 → 휴일 처리.
// 음력·대체공휴일 포함 2026 전체. 연도 넘어가면 갱신 필요.
const KR_HOLIDAYS = {
  '2026-01-01': '신정',
  '2026-02-16': '설날 연휴', '2026-02-17': '설날', '2026-02-18': '설날 연휴',
  '2026-03-01': '삼일절', '2026-03-02': '대체공휴일(삼일절)',
  '2026-05-01': '근로자의 날',
  '2026-05-05': '어린이날',
  '2026-05-24': '부처님오신날', '2026-05-25': '대체공휴일(부처님오신날)',
  '2026-06-03': '지방선거', '2026-06-06': '현충일',
  '2026-08-15': '광복절', '2026-08-17': '대체공휴일(광복절)',
  '2026-09-24': '추석 연휴', '2026-09-25': '추석', '2026-09-26': '추석 연휴', '2026-09-28': '대체공휴일(추석)',
  '2026-10-03': '개천절', '2026-10-05': '대체공휴일(개천절)',
  '2026-10-09': '한글날',
  '2026-12-25': '성탄절',
};
const DOW = ['일', '월', '화', '수', '목', '금', '토'];
const serialToDate = (s) => new Date(Math.round((s - 25569) * 86400 * 1000)); // UTC
export const fmt = (m) => { const s = m < 0 ? '-' : ''; m = Math.abs(m); return `${s}${Math.floor(m / 60)}시간 ${String(Math.round(m % 60)).padStart(2, '0')}분`; };
const hhmm = (dec) => { if (dec == null) return ''; let total = Math.round(dec * 60); let over = false; if (total >= 1440) { total -= 1440; over = true; } const h = Math.floor(total / 60); const mm = total % 60; return `${over ? '익일 ' : ''}${String(h).padStart(2,'0')}:${String(mm).padStart(2,'0')}`; };

function monthRange(month) {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const p = (n) => String(n).padStart(2, '0');
  return { y, m, last, sdate: `${y}-${p(m)}-01`, edate: `${y}-${p(m)}-${p(last)}` };
}

async function isLoggedIn(context) {
  const page = await context.newPage();
  await page.goto(`${HOST}/`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  const ok = !/login/i.test(page.url()) && (await page.locator('input[name="Password"]').count()) === 0;
  await page.close();
  return ok;
}

async function login(context, { id, pw }, snapshots) {
  if (!id || !pw) throw new Error('아이디/비번이 필요합니다');
  const page = await context.newPage();
  await page.goto(`${HOST}/`, { waitUntil: 'networkidle' });
  await snap(page, '타임인아웃 관리자 로그인', snapshots);
  await page.fill('input[name="Email"]', id);
  await page.fill('input[name="Password"]', pw);
  await Promise.all([
    page.waitForLoadState('networkidle').catch(() => {}),
    page.getByRole('button', { name: '로그인' }).first().click(),
  ]);
  await page.waitForTimeout(1500);
  if (/login/i.test(page.url()) || (await page.locator('input[name="Password"]').count()) > 0) {
    await page.close();
    throw new Error('로그인 실패 — 아이디/비번 또는 추가인증 확인');
  }
  await snap(page, '로그인 완료 · 관리자 대시보드', snapshots);
  const detected = await page.locator('span.name').first().innerText({ timeout: 2000 }).catch(() => '');
  ensureAuthDir();
  await context.storageState({ path: AUTH });
  await page.close();
  return (detected || '').trim();
}

// 출퇴근 현황 Excel(찐 출퇴근 포함) 다운로드
async function downloadInOut(context, { sdate, edate, name }, snapshots) {
  const page = await context.newPage();
  await page.goto(`${HOST}/InOutMng`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await page.evaluate(({ s, e, nm }) => {
    const set = (sel, v) => { const el = document.querySelector(sel); if (el) { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); } };
    set('#SDate', s); set('#EDate', e);
    for (const kw of document.querySelectorAll('input[name="keyword"], input[name="Keyword"]')) {
      kw.value = nm; kw.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, { s: sdate, e: edate, nm: name });
  await page.getByRole('button', { name: '검색' }).first().click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1200);
  await snap(page, `출퇴근 기록 조회 · ${name} (찐 출퇴근)`, snapshots);
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }),
    page.getByText('Excel 다운로드', { exact: true }).first().click(),
  ]);
  const dest = join(tmpdir(), `timeinout-inout-${Date.now()}.xlsx`);
  await download.saveAs(dest);
  await page.close();
  return dest;
}

// 정정(수동수정) 신청 이력: 근로일 기준으로 그 달 정정된 날 map 반환
async function fetchCorrections(context, { sdate, edate, name }, snapshots) {
  const page = await context.newPage();
  try {
    await page.goto(`${HOST}/InOutMng/Result`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    await page.selectOption('#DateKind', { label: '근로일' }).catch(async () => {
      await page.selectOption('#DateKind', '1').catch(() => {});
    });
    await page.evaluate(({ s, e, nm }) => {
      const set = (sel, v) => { const el = document.querySelector(sel); if (el) { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); } };
      set('#SDate', s); set('#EDate', e);
      for (const kw of document.querySelectorAll('input[name="keyword"]')) { kw.value = nm; kw.dispatchEvent(new Event('input', { bubbles: true })); }
    }, { s: sdate, e: edate, nm: name });
    await page.getByRole('button', { name: '검색' }).first().click().catch(() => {});
    await page.waitForLoadState('networkidle');
    // 검색 결과(해당 월 데이터)가 표에 나타날 때까지 대기 — 기본뷰(오늘=빈결과) 잔상 스크랩 방지
    await page.waitForFunction((ym) => {
      const t = document.querySelector('table');
      return !!t && t.innerText.includes(ym);
    }, sdate.slice(0, 7), { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(400);
    const res = await page.evaluate(() => {
      const t = document.querySelector('table');
      const emptyMsg = t ? /존재하지\s*않습니다|목록이\s*존재/.test(t.innerText) : false;
      const rows = [...document.querySelectorAll('table tr')].map(tr => [...tr.querySelectorAll('td')].map(td => td.innerText.trim())).filter(c => c.length >= 5);
      return { emptyMsg, rows };
    });
    if (!res.rows.length && !res.emptyMsg) return null; // 표 미로딩 → 상위에서 재시도
    await snap(page, '정정(수동수정) 내역 조회', snapshots);
    const map = {};
    for (const c of res.rows) {
      const dates = c.filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x));
      if (!dates.length) continue;
      const workDate = dates.length >= 2 ? dates[1] : dates[0]; // 1=요청일, 2=근로일
      if (workDate < sdate || workDate > edate) continue;
      const idx = c.indexOf(workDate);
      map[Number(workDate.slice(8, 10))] = { reason: c[idx + 1] || '', status: c[idx + 2] || '' };
    }
    return map;
  } catch { return null; } finally { await page.close(); }
}

// 휴가 현황(/Leave/Daily): 근로일별 휴가 map { day: {type, detail, days, hours} }
async function fetchLeaves(context, { sdate, edate, name }, snapshots) {
  const page = await context.newPage();
  try {
    await page.goto(`${HOST}/Leave/Daily`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    await page.evaluate(({ s, e, nm }) => {
      const set = (sel, v) => { const el = document.querySelector(sel); if (el) { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); } };
      set('#SDate', s); set('#EDate', e);
      for (const kw of document.querySelectorAll('input[name="Keyword"], input[name="keyword"]')) { kw.value = nm; kw.dispatchEvent(new Event('input', { bubbles: true })); }
    }, { s: sdate, e: edate, nm: name });
    await page.getByRole('button', { name: '검색' }).first().click().catch(() => {});
    await page.waitForLoadState('networkidle');
    // 검색 결과(해당 월 데이터)가 표에 나타날 때까지 대기 — 기본뷰(오늘=빈결과) 잔상 스크랩 방지
    await page.waitForFunction((ym) => {
      const t = document.querySelector('table');
      return !!t && t.innerText.includes(ym);
    }, sdate.slice(0, 7), { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(400);
    const res = await page.evaluate(() => {
      const t = document.querySelector('table');
      const emptyMsg = t ? /존재하지\s*않습니다|목록이\s*존재/.test(t.innerText) : false;
      const rows = [...document.querySelectorAll('table tr')].map(tr => [...tr.querySelectorAll('td')].map(td => td.innerText.trim())).filter(c => c.length >= 6);
      return { emptyMsg, rows };
    });
    if (!res.rows.length && !res.emptyMsg) return null; // 표 미로딩 → 상위에서 재시도
    await snap(page, '휴가(연차) 내역 조회', snapshots);
    const map = {};
    for (const c of res.rows) {
      const i = c.findIndex(x => /^\d{4}-\d{2}-\d{2}$/.test(x)); // 휴가일
      if (i < 0) continue;
      const date = c[i];
      if (date < sdate || date > edate) continue;
      map[Number(date.slice(8, 10))] = {
        type: c[i + 1] || '휴가', detail: c[i + 2] || '',
        days: parseFloat(String(c[i + 3]).replace(/[^0-9.]/g, '')) || 0,
        hours: parseFloat(String(c[i + 4]).replace(/[^0-9.]/g, '')) || 0,
      };
    }
    return map;
  } catch { return null; } finally { await page.close(); }
}

// 관리자 xlsx → 정규화된 byDay → 공용 계산
// xlsx 컬럼: 0날짜 7근로정책상세 8실출근 9실퇴근 10인정출근 11인정퇴근 12출근상태 13퇴근상태 15비업무
function analyze(xlsxPath, month, corrections = {}, leaves = {}) {
  const wb = xlsx.readFile(xlsxPath);
  const rows = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' }).slice(1);
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
  return buildDays(byDay, month, corrections, leaves);
}

// 공용 계산부: 정규화 byDay { inH, outH(익일이면 >24), recogMin, policy, inStat, outStat, nonWork } → days + summary
function buildDays(byDay, month, corrections = {}, leaves = {}, trips = {}) {
  const { y, m, last } = monthRange(month);
  const days = [];
  let totalMin = 0, wdOtSum = 0, holSum = 0, recogTotal = 0;
  let adjTotal = 0, adjWdOt = 0, adjHol = 0;
  for (let day = 1; day <= last; day++) {
    const dow = new Date(Date.UTC(y, m - 1, day)).getUTCDay();
    const weekend = dow === 0 || dow === 6;
    const dateStr = `${y}-${String(m).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const namedHol = KR_HOLIDAYS[dateStr];
    const e = byDay[day];
    const holidayPolicy = e ? /휴일|휴무/.test(e.policy) || /휴일/.test(e.nonWork) : false;
    const holiday = weekend || holidayPolicy || !!namedHol;

    const hasIn = !!(e && e.inH != null), hasOut = !!(e && e.outH != null);
    const rawWork = (hasIn && hasOut) ? Math.max(0, (e.outH - e.inH) * 60 - BREAK_MIN) : 0; // 찐 근로(휴게 제외)
    const recogWork = e ? (e.recogMin || 0) : 0;                // 회사 인정 근로
    const suspect = rawWork > SUSPECT_MIN;                       // 미체크아웃 의심
    // 보정: 의심일은 회사 인정값으로 대체
    const realWork = suspect ? recogWork : rawWork;
    const baseMin = holiday ? 0 : Math.min(realWork, DAILY_BASE);
    const wdOtMin = holiday ? 0 : Math.max(0, realWork - DAILY_BASE);
    const holMin = holiday ? realWork : 0;

    const inH = hasIn ? e.inH : null;
    const outH = (hasIn && hasOut) ? e.outH : null;
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

    const capped = e && !suspect && rawWork - recogWork > 1; // 인정시간에 잘린(정상) 날
    const corr = corrections[day];
    days.push({
      day, dow: DOW[dow], weekend, holiday,
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

// ───────────── 직원(본인) 모드: user.timeinout.kr ─────────────
// 대상월 기준 넓은 신청일 범위(±2개월)로 상신함을 조회 — 다른 달에 신청된 건을 놓치지 않도록
function submitDateRange(month) {
  const [ty, tm] = String(month).split('-').map(Number);
  const at = (delta) => { const i = tm - 1 + delta; return { y: ty + Math.floor(i / 12), m: ((i % 12) + 12) % 12 + 1 }; };
  const s = at(-2), e = at(+2);
  return { start: `${s.y}-${s.m}-1`, end: `${e.y}-${e.m}-28` };
}
// 결재함 상신함에서 '이미 신청한 출퇴근시간수정' 내역 수집 (직원 세션 필요)
// 반환: { byDate: {근로일:{status,reqIn,reqOut}}, ok } — ok=false면 조회 신뢰불가(중복 신청 차단용)
export async function getSubmittedCorrections(log, month) {
  if (!existsSync(USER_AUTH)) return { byDate: {}, ok: false, reason: '세션파일 없음' };
  const myName = process.env.TIMEINOUT_NAME || '유민호';
  const browser = await getBrowser();
  const ctx = await browser.newContext({ storageState: USER_AUTH });
  try {
    const p = await ctx.newPage();
    await p.goto(`${USER_HOST}/ApprovalMng/Index`, { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
    if (/login/i.test(p.url())) { log('결재함 세션 만료 — 신청내역 확인불가'); return { byDate: {}, ok: false, reason: '세션 만료' }; }
    await p.getByText('상신함', { exact: true }).first().click({ timeout: 5000 }).catch(() => {});
    await p.waitForTimeout(2000);
    // 기본 뷰는 당월만 보일 수 있어, 신청일 범위를 넓혀 재조회
    const { start, end } = submitDateRange(month);
    let u = p.url();
    if (/SDate=/.test(u)) {
      u = u.replace(/SDate=[^&]*/, 'SDate=' + start).replace(/EDate=[^&]*/, 'EDate=' + end);
      await p.goto(u, { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
      await p.waitForTimeout(2000);
    }
    const res = await p.evaluate((nm) => {
      const out = {}; let docs = 0, matched = 0;
      for (const el of document.querySelectorAll('tr, li, [class*=doc], [class*=list] > div')) {
        const t = (el.innerText || '').replace(/\s+/g, ' ');
        if (!/출퇴근시간수정/.test(t)) continue;
        docs++;
        if (!t.includes('신청자 ' + nm)) continue;
        matched++;
        const m = t.match(/출퇴근시간수정\s*(대기|승인|반려)?[\s\S]*?신청 내용\s*(\d{4}-\d{2}-\d{2})[\s\S]*?\(신청\)\s*(\d{1,2}:\d{2})\s*~\s*(\d{1,2}:\d{2})/);
        if (m && m[1] !== '반려' && !out[m[2]]) out[m[2]] = { status: m[1] || '확인', reqIn: m[3], reqOut: m[4] };
      }
      return { out, docs, matched };
    }, myName);
    // 출퇴근시간수정 문서는 있는데 내 이름으로 하나도 안 잡히면 마크업/이름형식 변경 의심 → 신뢰불가
    const ok = !(res.docs > 0 && res.matched === 0);
    log(`이미 신청된 정정 ${Object.keys(res.out).length}건 (문서 ${res.docs}·매칭 ${res.matched}${ok ? '' : ' ⚠확인불가'})`);
    return { byDate: res.out, ok, reason: ok ? '' : '신청자 매칭 0' };
  } catch (e) { log('결재함 조회 실패: ' + e.message.split('\n')[0]); return { byDate: {}, ok: false, reason: '조회 실패' }; }
  finally { await ctx.close().catch(() => {}); }
}

const parseTimeH = (str) => { const m = String(str).match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/); return m ? +(+m[1] + (+m[2]) / 60 + (+(m[3] || 0)) / 3600).toFixed(4) : null; };
const parseDurMin = (str) => { const h = String(str).match(/(\d+)\s*시간/); const mi = String(str).match(/(\d+)\s*분/); return (h ? +h[1] : 0) * 60 + (mi ? +mi[1] : 0); };

async function loginUser(context, { id, pw }, snapshots) {
  if (!id || !pw) throw new Error('아이디/비번이 필요합니다');
  const page = await context.newPage();
  await page.goto(`${USER_HOST}/`, { waitUntil: 'networkidle' });
  await snap(page, '타임인아웃 직원 로그인', snapshots);
  await page.fill('input[name="Email"]', id);
  await page.fill('input[name="Password"]', pw);
  await Promise.all([page.waitForLoadState('networkidle').catch(() => {}), page.getByRole('button', { name: '로그인' }).first().click()]);
  await page.waitForTimeout(1800);
  if (/login/i.test(page.url()) || (await page.locator('input[name="Password"]').count()) > 0) {
    await page.close(); throw new Error('로그인 실패 — 아이디/비번 확인');
  }
  await snap(page, '직원 홈 · 나의 근태', snapshots);
  ensureAuthDir();
  await context.storageState({ path: USER_AUTH });
  await page.close();
}

// 나의 근태(일별)에서 해당 월 카드 스크래핑
async function fetchEmployeeCards(context, month, snapshots) {
  const [ty, tm] = month.split('-').map(Number);
  const page = await context.newPage();
  await page.goto(`${USER_HOST}/InOutMng/InOutHistory`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  // 헤더 월 라벨을 목표 월까지 ◀/▶ 이동
  for (let i = 0; i < 24; i++) {
    const label = await page.evaluate(() => (document.body.innerText.match(/(\d{4})년\s*(\d{1,2})월/) || [])[0] || '');
    const lm = label.match(/(\d{4})년\s*(\d{1,2})월/);
    if (lm && +lm[1] === ty && +lm[2] === tm) break;
    const cur = lm ? +lm[1] * 12 + +lm[2] : ty * 12 + tm;
    const goPrev = cur > ty * 12 + tm;
    const el = page.getByText(/\d{4}년\s*\d{1,2}월/).first();
    const box = await el.boundingBox();
    if (!box) break;
    await page.mouse.click(box.x + (goPrev ? -28 : box.width + 28), box.y + box.height / 2);
    await page.waitForTimeout(1200);
  }
  await page.waitForTimeout(600);
  await snap(page, `나의 근태 ${ty}년 ${tm}월 조회`, snapshots);
  const cards = await page.evaluate(() => {
    const cand = {};
    document.querySelectorAll('*').forEach((el) => {
      if (el.children.length > 10) return;
      const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
      const dm = t.match(/^(\d{2})\.(\d{2})\s*\(/);
      if (!dm || !/IN /.test(t) || t.length > 280) return;
      const day = parseInt(dm[2], 10);
      if (!cand[day] || t.length < cand[day].length) cand[day] = t;
    });
    return cand;
  });
  await page.close();
  return cards;
}

// 나의 휴가(연차) 내역 리스트 스크래핑
async function fetchEmployeeLeaves(context, month, snapshots) {
  const ty = Number(month.split('-')[0]);
  const page = await context.newPage();
  try {
    await page.goto(`${USER_HOST}/Leave/Index`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    for (let i = 0; i < 8; i++) { // 연도 맞추기
      const ly = parseInt((await page.evaluate(() => (document.body.innerText.match(/(\d{4})년/) || [])[1] || '')), 10);
      if (!ly || ly === ty) break;
      await page.getByText(ly > ty ? '이전 해' : '다음 해', { exact: true }).first().click().catch(() => {});
      await page.waitForTimeout(1000);
    }
    await snap(page, '나의 휴가(연차) 내역', snapshots);
    const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
    const map = {};
    const re = /(\d{4}-\d{2}-\d{2})\s*\([^)]*\)\s*휴가명\s*(.+?)\s*휴가일수\s*([\d.]+)\s*일/g;
    let mm;
    while ((mm = re.exec(text))) {
      const [, date, rawName, daysStr] = mm;
      if (!date.startsWith(month)) continue;
      const days = parseFloat(daysStr) || 0;
      map[Number(date.slice(8, 10))] = { type: '연차휴가', detail: rawName.trim(), days, hours: Math.round(days * 8) };
    }
    return map;
  } catch { return {}; } finally { await page.close(); }
}

function analyzeEmployee(cards, month, corrections = {}, leaves = {}, trips = {}) {
  const byDay = {};
  for (const [day, t] of Object.entries(cards)) {
    const inM = (t.match(/IN\s+([\d:]+|-)/) || [])[1];
    const outM = (t.match(/OUT\s+([\d:]+|-)/) || [])[1];
    const recM = (t.match(/인정\s*시간\s+([\d]+\s*시간\s*[\d]*\s*분|[\d]+\s*분|-)/) || [])[1] || '-';
    const inStat = (t.match(/출근\s*상태\s+(\S+)/) || [])[1] || '';
    const outStat = (t.match(/퇴근\s*상태\s+(\S+)/) || [])[1] || '';
    const nonWork = (t.match(/비업무\s+(\S+)/) || [])[1] || '';
    let inH = inM && inM !== '-' ? parseTimeH(inM) : null;
    let outH = outM && outM !== '-' ? parseTimeH(outM) : null;
    if (inH != null && outH != null && outH < inH) outH += 24; // 익일 퇴근
    byDay[+day] = { inH, outH, recogMin: recM === '-' ? 0 : parseDurMin(recM), policy: '', inStat, outStat, nonWork };
  }
  return buildDays(byDay, month, corrections, leaves, trips);
}

// 출장·외근 내역 (user 사이트 /InOutMng/List, 월 단위). 승인/진행건만 근로일 map으로.
async function fetchEmployeeTrips(context, month, snapshots) {
  const [ty, tm] = month.split('-').map(Number);
  const now = new Date();
  const offset = (ty * 12 + tm) - (now.getFullYear() * 12 + (now.getMonth() + 1)); // 오늘 기준 상대 개월
  const page = await context.newPage();
  try {
    await page.goto(`${USER_HOST}/InOutMng/List?month=${offset}&part=0&status=0`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    await snap(page, '출장·외근 내역', snapshots);
    const raw = await page.evaluate(() => {
      const out = [];
      for (const li of document.querySelectorAll('li')) {
        const dt = li.querySelector('.card_date .date'), tp = li.querySelector('.card_date .type');
        if (!dt || !tp) continue;
        const state = (li.querySelector('.state') || {}).textContent || '';
        const details = [...li.querySelectorAll('.inout_area li')].map(x => ({ k: ((x.querySelector('strong') || {}).textContent || '').trim(), v: ((x.querySelector('span') || {}).textContent || '').trim() }));
        out.push({ date: dt.textContent.trim(), type: tp.textContent.trim(), state: state.trim(), details });
      }
      return JSON.stringify(out);
    });
    const list = JSON.parse(raw);
    const map = {};
    for (const it of list) {
      if (!/승인|진행/.test(it.state)) continue; // 반려·대기 제외
      const mm = /(\d{1,2})\/(\d{1,2})\s*~\s*(\d{1,2})\/(\d{1,2})/.exec(it.date);
      if (!mm) continue;
      const [, sMo, sD, eMo, eD] = mm.map(Number);
      const place = (it.details.find(d => /출장지|외근지|장소/.test(d.k)) || {}).v || '';
      const region = (it.details.find(d => /지역/.test(d.k)) || {}).v || '';
      const start = new Date(Date.UTC(ty, sMo - 1, sD)), end = new Date(Date.UTC(ty, eMo - 1, eD));
      for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
        if (d.getUTCMonth() + 1 !== tm) continue;
        map[d.getUTCDate()] = { type: it.type, place, region, state: it.state };
      }
    }
    return map;
  } catch { return {}; } finally { await page.close(); }
}

export async function getOvertimeEmployee({ month, id, pw, onSnapshot }) {
  const creds = { id: id || process.env.TIMEINOUT_ID, pw: pw || process.env.TIMEINOUT_PW };
  const snapshots = [];
  if (onSnapshot) snapshots.onSnap = onSnapshot; // 캡처 즉시 전송
  const browser = await getBrowser();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1200 } });
  try {
    await loginUser(ctx, creds, snapshots);
    const cards = await fetchEmployeeCards(ctx, month, snapshots);
    const leaves = await fetchEmployeeLeaves(ctx, month, snapshots);
    const trips = await fetchEmployeeTrips(ctx, month, snapshots).catch(() => ({}));
    // 정정 트래킹: 결재함 상신함의 '출퇴근시간수정'(대기·승인)을 근로일 기준으로 매핑
    const sub = await getSubmittedCorrections((m) => console.error('[timeinout]', m), month).catch(() => ({ byDate: {} }));
    const corrections = {};
    for (const [date, v] of Object.entries(sub.byDate || {})) {
      if (!date.startsWith(month)) continue;
      corrections[Number(date.slice(8, 10))] = { reason: `출퇴근수정 ${v.status}`, status: v.status, reqIn: v.reqIn, reqOut: v.reqOut };
    }
    return { name: '본인', mode: 'employee', corrections, leaves, trips, snapshots, ...analyzeEmployee(cards, month, corrections, leaves, trips) };
  } finally {
    await ctx.close().catch(() => {}); // 컨텍스트만 닫고 브라우저는 재사용
  }
}

export async function getOvertime({ month, name, id, pw }) {
  const creds = { id: id || process.env.TIMEINOUT_ID, pw: pw || process.env.TIMEINOUT_PW };
  const freshLogin = !!(id && pw); // UI로 자격증명을 주면 항상 새로 로그인(스냅샷 연출)
  const { sdate, edate } = monthRange(month);
  const snapshots = [];
  const browser = await getBrowser();
  let main = null;
  try {
    // 1) 로그인/세션 확보 + 출퇴근 원본 다운로드
    main = await browser.newContext({
      storageState: (!freshLogin && existsSync(AUTH)) ? AUTH : undefined,
      viewport: { width: 1400, height: 900 }, acceptDownloads: true,
    });
    let detectedName = '';
    if (freshLogin || !existsSync(AUTH) || !(await isLoggedIn(main))) detectedName = await login(main, creds, snapshots);
    // 이름 비우면 로그인한 본인으로 자동 지정
    const who = (name && name.trim()) ? name.trim() : (detectedName || process.env.TIMEINOUT_NAME || '유민호');
    const xlsxPath = await downloadInOut(main, { sdate, edate, name: who }, snapshots);
    await main.close(); main = null;

    // 2) 정정·휴가는 각각 독립 컨텍스트로 (ASP.NET 세션 검색조건 오염 방지)
    const retry = async (fn) => (await fn()) ?? (await fn()) ?? {};
    const inFreshCtx = async (fn) => {
      const ctx = await browser.newContext({ storageState: AUTH, viewport: { width: 1400, height: 900 } });
      try { return await retry(() => fn(ctx)); } finally { await ctx.close(); }
    };
    const corrections = await inFreshCtx((ctx) => fetchCorrections(ctx, { sdate, edate, name: who }, snapshots));
    const leaves = await inFreshCtx((ctx) => fetchLeaves(ctx, { sdate, edate, name: who }, snapshots));
    return { name: who, corrections, leaves, snapshots, ...analyze(xlsxPath, month, corrections, leaves) };
  } finally {
    if (main) await main.close().catch(() => {}); // 컨텍스트만 닫고 브라우저는 재사용
  }
}
