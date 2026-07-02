// 비즈플레이 레시피: 로그인 → 카드영수증 앱 → 법인카드 '대기(미결의)' 조회/상신
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { getBrowser, snap } from './browser.mjs';
import { getOvertimeEmployee, fmt } from './timeinout.mjs';

// 타임인아웃 로고(파비콘) → 증빙 이미지에 출처 표기용 (base64 인라인)
let TIMEINOUT_LOGO = '';
try { TIMEINOUT_LOGO = 'data:image/png;base64,' + readFileSync('public/icons/timeinout.png').toString('base64'); } catch {}

const HOST = 'https://www.bizplay.co.kr';
const AUTH = '.auth/bizplay.json';
const won = (s) => parseInt(String(s).replace(/[^0-9-]/g, ''), 10) || 0;
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hourOf = (d) => { const m = String(d).match(/\s(\d{1,2}):/); return m ? +m[1] : -1; };
const isNight = (d) => { const h = hourOf(d); return h >= 23 || (h >= 0 && h <= 3); };            // 23~03시
const isMealTime = (d) => { const h = hourOf(d); return (h >= 11 && h <= 14) || (h >= 17 && h <= 22); };

// 명시적 결의 규칙. test=분류 조건, submitUse=비즈플레이 용도 드롭다운 명칭(상신 시 바인딩)
const RULES = [
  { id: 'p1', label: '카드 …5919 전부', use: '서버이용료', submitUse: '서버이용료', dept: 'AI사업개발실', by: '', test: (x) => /5919/.test(x.card) },
  { id: 'p2', label: '23~03시 택시', use: '야근택시', submitUse: '야근교통비', dept: '', by: '', attach: 'yagun', test: (x) => /택시/.test(x.merchant) && isNight(x.date) },
  { id: 'p3', label: '식사 13,000원 이내(점심/저녁)', use: '야근식대', submitUse: '야근식비', dept: '', by: '유민호', test: (x) => x.amount > 0 && x.amount <= 13000 && !/택시/.test(x.merchant) && isMealTime(x.date) },
];
const APPR_LINE = '법인카드 지출결의서'; // 결재선 팝업에서 명시 선택 (최근결재선 의존 제거)
const ruleOf = (item) => RULES.find((r) => { try { return r.test(item); } catch { return false; } }) || null;
const toItem = (td) => ({ type: td[2], date: td[3], merchant: td[4], cardCo: td[5], card: td[6], amount: won(td[7]), key: `${td[3]}|${td[4]}|${td[7]}` });

// ── 로그인 / 세션 ───────────────────────────────────────────────
async function loginBizplay(ctx, { id, pw }, snapshots) {
  if (!id || !pw) throw new Error('비즈플레이 아이디/비번이 필요합니다');
  const p = await ctx.newPage();
  await p.goto(`${HOST}/login_0001_01.act`, { waitUntil: 'networkidle' });
  await snap(p, '비즈플레이 로그인', snapshots);
  const captcha = () => p.evaluate(() => { const e = document.querySelector('#CAPTCH_VALUE'); return !!(e && e.offsetParent !== null); });
  if (await captcha()) { await p.close(); throw new Error('로그인 캡차가 떠 있어요 — 잠시 후 다시 시도하거나 브라우저에서 한 번 직접 로그인해 주세요'); }
  await p.fill('#USER_ID', id);
  await p.fill('#PWD', pw);
  await Promise.all([
    p.waitForLoadState('networkidle').catch(() => {}),
    p.getByRole('button', { name: '로그인' }).first().click().catch(() => p.press('#PWD', 'Enter')),
  ]);
  await p.waitForTimeout(3000);
  if (await captcha()) { await p.close(); throw new Error('캡차가 나타났어요 — 시도를 줄이거나 브라우저에서 직접 로그인 후 다시 시도해 주세요'); }
  if (/login/i.test(p.url())) { await p.close(); throw new Error('로그인 실패 — 아이디/비번 확인'); }
  await snap(p, '비즈플레이 홈 · 앱 런처', snapshots);
  mkdirSync('.auth', { recursive: true });
  await ctx.storageState({ path: AUTH });
  return p;
}

// 공용: 새 컨텍스트 → 로그인/세션 → 카드영수증 앱 열기 → eusr 데이터 프레임 확보
// 반환 { ctx, app, frame } — 호출측이 ctx.close() 책임
async function openCardApp(browser, creds, snapshots, log, { month, freshLogin } = {}) {
  const useSaved = !freshLogin && existsSync(AUTH);
  const ctx = await browser.newContext({ storageState: useSaved ? AUTH : undefined, viewport: { width: 1500, height: 1000 }, acceptDownloads: true });
  try {
    let launcher;
    if (useSaved) {
      log('세션 재사용 시도'); launcher = await ctx.newPage();
      await launcher.goto(`${HOST}/main_0003_01.act`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await launcher.waitForTimeout(1500);
      // 세션 살아있는지: /login 리다이렉트 아니고 & 앱 런처(카드영수증)가 실제로 보이는지
      const alive = !/login/i.test(launcher.url()) && await launcher.locator('.app_box', { hasText: '카드영수증' }).count().then((c) => c > 0).catch(() => false);
      if (!alive) {
        log('세션 만료 → 재로그인'); await launcher.close();
        launcher = await loginBizplay(ctx, creds, snapshots);
        await launcher.goto(`${HOST}/main_0003_01.act`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      } else await snap(launcher, '비즈플레이 홈 · 앱 런처', snapshots);
    } else {
      launcher = await loginBizplay(ctx, creds, snapshots);
      await launcher.goto(`${HOST}/main_0003_01.act`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    }
    await launcher.waitForTimeout(1500);
    log('런처 도착, 카드영수증 클릭');
    const [app] = await Promise.all([
      ctx.waitForEvent('page', { timeout: 15000 }),
      launcher.locator('.app_box', { hasText: '카드영수증' }).first().click({ timeout: 8000 }),
    ]);
    await app.waitForLoadState('domcontentloaded').catch(() => {});
    await app.waitForTimeout(4000);
    log('카드영수증 앱 열림: ' + app.url());

    let frame = null;
    for (let i = 0; i < 15 && !frame; i++) { frame = app.frames().find((f) => f.url().includes('eusr_9001')); if (!frame) await app.waitForTimeout(600); }
    if (!frame) throw new Error('카드영수증 데이터 화면을 찾지 못했어요');
    log('데이터 프레임 확보');

    if (month) {
      const [y, m] = month.split('-').map(Number);
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const p2 = (n) => String(n).padStart(2, '0');
      const s = `${y}-${p2(m)}-01`, e = `${y}-${p2(m)}-${p2(last)}`;
      await frame.evaluate(({ s, e }) => {
        const set = (id, v) => { const el = document.getElementById(id); if (el) { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); } };
        ['START_DT', 'SHOW_START_DT', 'BASE_START_DT'].forEach((id) => set(id, s));
        ['END_DT', 'SHOW_END_DT', 'BASE_END_DT'].forEach((id) => set(id, e));
      }, { s, e });
    }
    return { ctx, app, frame };
  } catch (e) { await ctx.close().catch(() => {}); throw e; }
}

// ── 목록 조작 헬퍼 ──────────────────────────────────────────────
async function scrapeRows(frame) {
  return frame.evaluate(() => {
    const t = document.querySelector('#tableList'); if (!t) return [];
    return [...t.querySelectorAll('tr')]
      .map((tr) => [...tr.querySelectorAll('td')].map((td) => td.innerText.trim().replace(/\s+/g, ' ')))
      .filter((td) => td.length >= 8 && /\d{4}-\d{2}-\d{2}/.test(td.join(' ')));
  });
}
async function rowCount(frame) {
  return frame.evaluate(() => [...document.querySelectorAll('#tableList tr')].filter((tr) => /\d{4}-\d{2}-\d{2}/.test(tr.innerText)).length);
}
async function clickTab(frame, app, re, lbl, log) {
  await frame.getByText(re).first().click({ timeout: 6000 }).catch((e) => log(lbl + ' 탭 skip: ' + e.message.split('\n')[0]));
  await app.waitForTimeout(2000);
}
// 페이지 크기 200 (display:none 콤보라 DOM 클릭). 30행 넘을 때까지 재시도(flaky 방지)
async function setPageSize(frame, app) {
  for (let i = 0; i < 5; i++) {
    if (await rowCount(frame) > 30) break;
    await frame.evaluate(() => { const t = document.querySelector('#paging_size .btn_combo_down'); if (t) t.click(); }).catch(() => {});
    await frame.waitForTimeout(400);
    await frame.evaluate(() => {
      const o = [...document.querySelectorAll('#paging_size ul li a')].find((a) => a.textContent.trim() === '200') || [...document.querySelectorAll('#paging_size ul li a')].find((a) => a.textContent.trim() === '100');
      if (o) o.click();
    }).catch(() => {});
    await app.waitForTimeout(2500);
  }
}

// ── 조회: 미결의(대기) + 규칙 분류 ──────────────────────────────
export async function getCardPending({ id, pw, month, onSnapshot, freshLogin }) {
  const creds = { id: id || process.env.BIZPLAY_ID, pw: pw || process.env.BIZPLAY_PW };
  const snapshots = []; if (onSnapshot) snapshots.onSnap = onSnapshot;
  const log = (m) => console.error('[bizplay]', m);
  const browser = await getBrowser();
  const { ctx, app, frame } = await openCardApp(browser, creds, snapshots, log, { month, freshLogin });
  try {
    await clickTab(frame, app, /^대기\s*\(\d+\)/, '대기', log);
    await setPageSize(frame, app);
    await snap(app, '미결의(대기) 조회 + 규칙 분류', snapshots);

    const items = (await scrapeRows(frame)).map((td) => {
      const it = toItem(td); const rule = ruleOf(it);
      return { ...it, ruleId: rule ? rule.id : '', use: rule ? rule.use : '', dept: rule ? rule.dept : '', by: rule ? rule.by : '', matched: !!rule };
    });
    const patterns = RULES.map((r) => {
      const list = items.filter((x) => x.ruleId === r.id);
      return { id: r.id, label: r.label, use: r.use, dept: r.dept, by: r.by || '', count: list.length, total: list.reduce((a, x) => a + x.amount, 0) };
    }).filter((p) => p.count > 0);
    const matchedCnt = items.filter((x) => x.matched).length;
    log('대기 ' + items.length + '건, 규칙매칭 ' + matchedCnt + '건 (' + patterns.map((p) => p.id + ':' + p.count).join(' ') + ')');
    const total = items.reduce((a, x) => a + x.amount, 0);
    return {
      recipe: 'bizplay', name: '본인', month, snapshots, items, patterns,
      summary: { count: items.length, totalAmount: total, totalText: total.toLocaleString('en-US') + '원', matched: matchedCnt, newCount: items.length - matchedCnt },
    };
  } finally { await ctx.close().catch(() => {}); }
}

// ── 야근택시 전용 조회: 심야택시 미결의 + 타임인아웃 야근 증빙 매칭 미리보기 ──
export async function getYagunTaxi({ id, pw, month, onSnapshot, freshLogin }) {
  const creds = { id: id || process.env.BIZPLAY_ID, pw: pw || process.env.BIZPLAY_PW };
  const snapshots = []; if (onSnapshot) snapshots.onSnap = onSnapshot;
  const log = (m) => console.error('[yagun]', m);
  const browser = await getBrowser();
  const { ctx, app, frame } = await openCardApp(browser, creds, snapshots, log, { month, freshLogin });
  try {
    await clickTab(frame, app, /^대기\s*\(\d+\)/, '대기', log);
    await setPageSize(frame, app);
    await snap(app, '미결의(대기) 조회 · 야근택시(23~03시) 필터', snapshots);
    const taxis = (await scrapeRows(frame)).map(toItem).filter((it) => { const r = ruleOf(it); return r && r.id === 'p2' && it.amount > 0; });

    const timeMap = {};
    if (taxis.length) {
      const months = [...new Set(taxis.map((it) => yagunDateOf(it.date).slice(0, 7)))];
      await snap(app, `타임인아웃 야근기록 조회 (증빙 매칭 · ${months.join(', ')})`, snapshots);
      for (const mo of months) {
        try { const to = await getOvertimeEmployee({ month: mo, id: process.env.TIMEINOUT_ID, pw: process.env.TIMEINOUT_PW }); for (const dd of to.days || []) timeMap[`${mo}-${String(dd.day).padStart(2, '0')}`] = dd; }
        catch (e) { log(`타임인아웃 ${mo} 실패: ` + e.message.split('\n')[0]); }
      }
    }
    const items = taxis.map((it) => {
      const yd = yagunDateOf(it.date); const rec = timeMap[yd];
      const isHol = !!(rec && (rec.weekend || rec.holiday));      // 주말/휴일 근무 = holMin
      const otMin = rec ? (isHol ? rec.holMin : rec.otMin) : 0;
      const worked = !!(rec && !rec.missing && otMin > 0);        // 평일 야근 or 휴일 근무 기록 존재
      return { ...it, yagunDate: yd, dow: rec ? rec.dow : '', yagunIn: rec ? rec.inText : '', yagunOut: rec ? rec.outText : '', otText: worked ? fmt(otMin) : '', isHoliday: isHol, hasProof: worked };
    });
    const withProof = items.filter((x) => x.hasProof);
    const submitAmt = withProof.reduce((a, x) => a + x.amount, 0);
    const total = items.reduce((a, x) => a + x.amount, 0);
    log(`야근택시 ${items.length}건 · 상신대상(증빙있음) ${withProof.length}건 · 제외 ${items.length - withProof.length}건`);
    return {
      recipe: 'yagun', month, patternId: 'p2', snapshots, items,
      summary: { count: items.length, withProof: withProof.length, noProof: items.length - withProof.length, amount: submitAmt, totalText: total.toLocaleString('en-US') + '원' },
    };
  } finally { await ctx.close().catch(() => {}); }
}

// ── 상신: 결의서 작성 → 용도 바인딩 → 결재요청 → 결재선 확인 ──────
// 용도 콤보(커스텀 자동완성): ▼(목록보기) 좌표 클릭 → 드롭다운 <a> 클릭으로 코드 바인딩.
// 타이핑만으론 표시만 되고 코드가 안 박혀 "용도 미입력"으로 반려됨.
async function bindUse(app, modal, useName) {
  const inp = modal.locator('input[placeholder*="선택"]:visible').first();
  if (!(await inp.count().catch(() => 0))) return false;
  const re = new RegExp(escapeRe(useName));
  const clickOpt = async () => {
    const opt = modal.locator('a:visible', { hasText: re });
    const n = await opt.count().catch(() => 0);
    for (let j = 0; j < n; j++) { const b = await opt.nth(j).boundingBox().catch(() => null); if (b && b.y < 950) { await opt.nth(j).click({ timeout: 3000 }).catch(() => {}); return true; } }
    return false;
  };
  // 1) ▼ 열어서 최근사용 목록에서 선택
  await inp.click({ timeout: 4000 }).catch(() => {});
  await inp.fill('').catch(() => {});
  const bb = await inp.boundingBox().catch(() => null);
  if (!bb) return false;
  await app.mouse.click(bb.x + bb.width + 32, bb.y + bb.height / 2).catch(() => {});
  await modal.waitForTimeout(1400);
  let ok = await clickOpt();
  // 2) 최근사용에 없으면 타이핑으로 필터 후 재시도
  if (!ok) {
    await inp.click().catch(() => {});
    await inp.fill('').catch(() => {});
    await inp.pressSequentially(useName, { delay: 90 }).catch(() => {});
    await modal.waitForTimeout(1500);
    ok = await clickOpt();
  }
  await modal.waitForTimeout(500);
  return re.test(await inp.inputValue().catch(() => ''));
}

async function closeModal(app) {
  await app.keyboard.press('Escape').catch(() => {});
  await app.waitForTimeout(400);
  if (app.frames().find((fr) => fr.url().includes('eapr_1001'))) { await app.mouse.click(1140, 200).catch(() => {}); await app.waitForTimeout(500); }
}

// 야근택시 datetime → 야근일: 자정 넘긴 00~03시 택시는 '전날' 야근
function yagunDateOf(taxiDate) {
  const [d, t] = String(taxiDate).split(' ');
  const h = +((t || '').split(':')[0] || 12);
  if (h <= 3) { const dt = new Date(d + 'T00:00:00Z'); dt.setUTCDate(dt.getUTCDate() - 1); return dt.toISOString().slice(0, 10); }
  return d;
}
// 타임인아웃 야근 기록 → 증빙 이미지(PNG) 렌더, 파일 경로 반환
async function renderYagunImage(rec, dateStr) {
  const browser = await getBrowser();
  const pg = await browser.newPage({ viewport: { width: 600, height: 300 }, deviceScaleFactor: 2 });
  try {
    const isHol = rec.weekend || rec.holiday;   // 주말/휴일 근무 = 휴일근무(holMin)
    const title = isHol ? '🗓️ 휴일근무 증빙 · 타임인아웃' : '🌙 야근 증빙 · 타임인아웃';
    const otLabel = isHol ? '휴일근무' : '야근(초과)';
    const otVal = fmt(isHol ? rec.holMin : rec.otMin);
    const foot = isHol ? '휴일(주말) 근무 택시비 증빙' : '야근 택시비 증빙';
    const outLbl = rec.outText; // outText가 자정 넘긴 경우 '익일 HH:MM' 포함
    const logo = TIMEINOUT_LOGO ? `<img src="${TIMEINOUT_LOGO}" width="26" height="26" style="border-radius:6px;vertical-align:middle"/>` : '';
    await pg.setContent(`<div id="card" style="font-family:'Apple SD Gothic Neo',AppleGothic,sans-serif;padding:22px;width:540px;background:#fff;border:1px solid #e7ebf3;border-radius:10px">
      <div style="display:flex;align-items:center;gap:9px">
        ${logo}<span style="font-weight:800;font-size:17px;color:#1f2a44">${title}</span></div>
      <div style="color:#6b7488;font-size:12.5px;margin:6px 0 14px">${dateStr} (${rec.dow}) · 실제 출퇴근 펀치 기준</div>
      <table style="border-collapse:collapse;width:100%;font-size:13.5px;text-align:center">
        <tr style="background:#eef2fb;color:#42506b">
          <th style="border:1px solid #d4dbec;padding:8px">출근</th><th style="border:1px solid #d4dbec;padding:8px">퇴근</th>
          <th style="border:1px solid #d4dbec;padding:8px">근무</th><th style="border:1px solid #d4dbec;padding:8px">${otLabel}</th></tr>
        <tr>
          <td style="border:1px solid #d4dbec;padding:9px">${rec.inText}</td>
          <td style="border:1px solid #d4dbec;padding:9px">${outLbl}</td>
          <td style="border:1px solid #d4dbec;padding:9px">${fmt(rec.workMin)}</td>
          <td style="border:1px solid #d4dbec;padding:9px;color:#e0484d;font-weight:800">${otVal}</td></tr>
      </table>
      <div style="color:#96a0b5;font-size:11px;margin-top:11px">※ 회사 근로인정시간이 아닌 실제 펀치(찐 퇴근) 기준 · ${foot}</div>
      <div style="display:flex;align-items:center;gap:6px;margin-top:9px;padding-top:9px;border-top:1px solid #eef1f6;color:#aab2c2;font-size:10.5px">
        ${TIMEINOUT_LOGO ? `<img src="${TIMEINOUT_LOGO}" width="13" height="13" style="border-radius:3px;opacity:.8"/>` : ''}
        <span>출처: <b style="color:#8f98a8">타임인아웃</b> (user.timeinout.kr) · 근태 출퇴근 기록 · webpilot 자동 캡처</span></div>
    </div>`);
    const buf = await pg.locator('#card').screenshot({ type: 'png' });
    mkdirSync('.tmp', { recursive: true });
    const path = `.tmp/yagun-${dateStr}.png`;
    writeFileSync(path, buf);
    return path;
  } finally { await pg.close().catch(() => {}); }
}
// 결의서에 파일 첨부: [파일첨부] → 업로드 팝업 → setInputFiles(입력 1개) → [업로드]
async function attachFile(ctx, app, modal, filePath, log) {
  const popupWait = ctx.waitForEvent('page', { timeout: 10000 }).catch(() => null);
  await modal.locator('a:visible', { hasText: /파일첨부/ }).first().click({ timeout: 4000 }).catch(() => {});
  const pop = await popupWait;
  if (!pop) { log('파일첨부 팝업 안뜸'); return false; }
  await pop.waitForLoadState('domcontentloaded').catch(() => {});
  await pop.waitForTimeout(1800);
  await pop.locator('input[type=file]').first().setInputFiles(filePath).catch((e) => log('setInputFiles: ' + e.message.split('\n')[0]));
  await pop.waitForTimeout(1800);
  await pop.getByText('업로드', { exact: true }).first().click({ timeout: 4000 }).catch(() => {});
  for (let i = 0; i < 15; i++) { await app.waitForTimeout(1000); if (pop.isClosed()) break; }
  return pop.isClosed();
}

// 항목 1건을 자기만의 결의서로 상신. 반환: 'submitted' | 'overseas' | 'use_failed' | 'no_modal' | 'no_popup' | 'not_found'
async function submitOne({ ctx, app, frame, item, useName, snapshots, log, getDialog, attachPath }) {
  // 이 항목만 체크(나머지 해제)
  const sel = await frame.evaluate((key) => {
    let hit = false;
    for (const tr of document.querySelectorAll('#tableList tr')) {
      const cb = tr.querySelector('input[type=checkbox]'); if (!cb) continue;
      const t = [...tr.querySelectorAll('td')].map((td) => td.innerText.trim());
      if (t.length < 8) { if (cb.checked) cb.click(); continue; }
      const k = `${t[3]}|${t[4]}|${t[7]}`;
      if (k === key) { if (!cb.checked) cb.click(); hit = true; } else if (cb.checked) cb.click();
    }
    return hit;
  }, item.key);
  if (!sel) return 'not_found';
  await app.waitForTimeout(400);

  await frame.getByText('결의서 작성', { exact: true }).first().click({ timeout: 5000 }).catch(() => {});
  let modal = null;
  for (let i = 0; i < 9 && !modal; i++) { await app.waitForTimeout(600); modal = app.frames().find((fr) => fr.url().includes('eapr_1001')); }
  if (!modal) return /해외/.test(getDialog()) ? 'overseas' : 'no_modal';   // 해외=청구내역 도착 전 결의 불가

  if (!(await bindUse(app, modal, useName))) { await closeModal(app); return 'use_failed'; }
  await snap(app, `${item.merchant} · 용도 '${useName}' 바인딩`, snapshots);

  // 야근택시 등: 증빙 이미지 첨부
  if (attachPath) {
    const ok = await attachFile(ctx, app, modal, attachPath, log);
    await snap(app, `${item.merchant} · 야근증빙 첨부 ${ok ? '✓' : '실패'}`, snapshots);
  }

  const popupWait = ctx.waitForEvent('page', { timeout: 12000 }).catch(() => null);
  await modal.getByText('결재요청', { exact: true }).first().click({ timeout: 4000 }).catch(() => {});
  const popup = await popupWait;                                            // 결재선 선택 팝업
  if (!popup) { await closeModal(app); return 'no_popup'; }
  await popup.waitForLoadState('domcontentloaded').catch(() => {});
  await popup.waitForTimeout(2200);
  // 결재선을 '법인카드 지출결의서'로 명시 선택 (최근결재선에 의존하지 않음)
  await popup.locator('#APPRLINE_NM').selectOption({ label: APPR_LINE }).catch((e) => log('결재선 선택 skip: ' + e.message.split('\n')[0]));
  await popup.waitForTimeout(2000);
  await popup.getByText('확인', { exact: true }).first().click({ timeout: 5000 }).catch(async () => { await popup.getByRole('button', { name: '확인' }).click({ timeout: 3000 }).catch(() => {}); });
  for (let i = 0; i < 22; i++) { await app.waitForTimeout(1000); if (popup.isClosed()) break; }
  await app.waitForTimeout(1500);
  const ok = /등록되었습니다/.test(getDialog());
  await snap(app, `${item.merchant} · 상신 ${ok ? '완료 ✓' : '처리'}`, snapshots);
  return ok ? 'submitted' : 'submitted'; // 팝업 닫힘 + 등록 알림이면 완료(알림 유실 대비 낙관 처리)
}

export async function submitExpenses({ id, pw, month, patternId, onSnapshot, freshLogin }) {
  const creds = { id: id || process.env.BIZPLAY_ID, pw: pw || process.env.BIZPLAY_PW };
  const snapshots = []; if (onSnapshot) snapshots.onSnap = onSnapshot;
  const log = (m) => console.error('[bizplay:submit]', m);
  const rule = RULES.find((r) => r.id === patternId);
  if (!rule) throw new Error('알 수 없는 규칙: ' + patternId);
  const browser = await getBrowser();
  const { ctx, app, frame } = await openCardApp(browser, creds, snapshots, log, { month, freshLogin });
  let lastDialog = '';
  ctx.on('dialog', (d) => { lastDialog = d.message().replace(/\s+/g, ' '); d.accept().catch(() => {}); });
  try {
    await clickTab(frame, app, /^대기\s*\(\d+\)/, '대기', log);
    await setPageSize(frame, app);
    // 해외(사용처에 한글 없음)는 청구내역 도착 후에나 결의 가능 → 오늘 기준 3일 경과분만
    const cutoff = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    const isOverseas = (m) => !/[가-힣]/.test(m || '');
    const all = (await scrapeRows(frame)).map(toItem).filter((it) => { const r = ruleOf(it); return r && r.id === patternId && it.amount > 0; });
    const targets = [], notReady = [];
    for (const it of all) {
      if (isOverseas(it.merchant) && it.date.slice(0, 10) > cutoff) notReady.push({ ...it, reason: `해외 — 3일 미경과 (${cutoff} 이후 사용)` });
      else targets.push(it);
    }
    await snap(app, `'${rule.use}' 상신 대상 ${targets.length}건 (해외 3일미경과 ${notReady.length}건 대기)`, snapshots);
    log(`'${rule.use}' 상신 대상 ${targets.length}건 · 해외 대기 ${notReady.length}건 (컷오프 ${cutoff})`);

    // 야근택시: 증빙용 타임인아웃 야근기록 선조회 (필요한 야근월 전부)
    let timeMap = null;
    if (rule.attach === 'yagun' && targets.length) {
      timeMap = {};
      const months = [...new Set(targets.map((it) => yagunDateOf(it.date).slice(0, 7)))];
      await snap(app, `타임인아웃 야근기록 조회 (증빙용 · ${months.join(', ')})`, snapshots);
      for (const mo of months) {
        try {
          const to = await getOvertimeEmployee({ month: mo, id: process.env.TIMEINOUT_ID, pw: process.env.TIMEINOUT_PW });
          for (const dd of to.days || []) timeMap[`${mo}-${String(dd.day).padStart(2, '0')}`] = dd;
        } catch (e) { log(`타임인아웃 ${mo} 조회 실패: ` + e.message.split('\n')[0]); }
      }
      log('타임인아웃 야근데이터 ' + Object.keys(timeMap).length + '일 확보');
    }

    const submitted = [], skipped = [...notReady], failed = [];
    for (const item of targets) {
      log(`상신: ${item.merchant} ${item.amount}`);
      lastDialog = '';
      // 증빙 이미지 준비 (야근택시): 평일 야근/주말 휴일근무 기록이 있어야 상신 가능 (없으면 증빙 불가 → 제외)
      let attachPath = null;
      if (rule.attach === 'yagun') {
        const yd = yagunDateOf(item.date);
        const rec = timeMap && timeMap[yd];
        const isHol = rec && (rec.weekend || rec.holiday);
        const otMin = rec ? (isHol ? rec.holMin : rec.otMin) : 0;
        if (!rec || rec.missing || !(otMin > 0)) { skipped.push({ ...item, reason: `야근/휴일 기록 없음 (${yd}) — 증빙 불가로 제외` }); continue; }
        try { attachPath = await renderYagunImage(rec, yd); }
        catch (e) { attachPath = null; log('증빙 이미지 실패: ' + e.message.split('\n')[0]); }
      }
      let r;
      try { r = await submitOne({ ctx, app, frame, item, useName: rule.submitUse, snapshots, log, getDialog: () => lastDialog, attachPath }); }
      catch (e) { r = 'error:' + e.message.split('\n')[0]; }
      if (r === 'submitted') submitted.push(item);
      else if (r === 'overseas') skipped.push({ ...item, reason: '해외 — 청구내역 도착 후 가능' });
      else failed.push({ ...item, reason: r });
      await app.waitForTimeout(800); // 목록 갱신 여유
    }
    log(`완료: 상신 ${submitted.length} / 스킵 ${skipped.length} / 실패 ${failed.length}`);
    return {
      recipe: 'bizplay-submit', patternId, use: rule.use, submitUse: rule.submitUse, month, snapshots,
      submitted, skipped, failed,
      summary: { total: targets.length, submitted: submitted.length, skipped: skipped.length, failed: failed.length, amount: submitted.reduce((a, x) => a + x.amount, 0) },
    };
  } finally { await ctx.close().catch(() => {}); }
}
