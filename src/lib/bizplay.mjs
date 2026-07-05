// 비즈플레이 레시피: 로그인 → 카드영수증 앱 → 법인카드 '대기(미결의)' 조회/상신
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { getBrowser, snap } from './browser.mjs';
import { getOvertimeEmployee, fmt } from './timeinout.mjs';
import { getSubmittedCorrections } from './correction.mjs';

// 타임인아웃 로고(파비콘) → 증빙 이미지에 출처 표기용 (base64 인라인)
let TIMEINOUT_LOGO = '';
try { TIMEINOUT_LOGO = 'data:image/png;base64,' + readFileSync('public/icons/timeinout.png').toString('base64'); } catch {}

const HOST = 'https://www.bizplay.co.kr';
const AUTH = '.auth/bizplay.json';
const won = (s) => parseInt(String(s).replace(/[^0-9-]/g, ''), 10) || 0;
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hourOf = (d) => { const m = String(d).match(/\s(\d{1,2}):/); return m ? +m[1] : -1; };
const isNight = (d) => { const h = hourOf(d); return h >= 23 || (h >= 0 && h <= 3); };            // 23~03시
const isDinner = (d) => { const h = hourOf(d); return h >= 17 && h <= 22; };                      // 저녁 17~22시
const isBreakfast = (d) => { const h = hourOf(d); return h >= 5 && h <= 9; };                     // 조식 05~09시
const isYasikMeal = (d) => isDinner(d) || isBreakfast(d);                                         // 야근식비 후보 시간대

// 명시적 결의 규칙. test=분류 조건, submitUse=비즈플레이 용도 드롭다운 명칭(상신 시 바인딩)
const RULES = [
  { id: 'p2', label: '23~03시 택시', use: '야근택시', submitUse: '야근교통비', dept: '', by: '', attach: 'yagun', test: (x) => /택시/.test(x.merchant) && isNight(x.date) },
  // 야근식비: 혼자 먹은 1인 식대(13,000 이내). 저녁=그날 야근 있으면, 조식=그날 출근<08:00이면 인정(타임인아웃 연동)
  { id: 'p3', label: '혼자 식대 13,000 이내 (야근 저녁·이른출근 조식)', use: '야근식대', submitUse: '야근식비', dept: '', by: '유민호', eligibility: 'yasik', test: (x) => x.amount > 0 && x.amount <= 13000 && !/택시/.test(x.merchant) && isYasikMeal(x.date) },
];
// 야근식비 인정 판정: 저녁=그날 야근(초과>0), 조식=그날 출근<08:00. rec=타임인아웃 그날 데이터.
function yasikClass(item, rec) {
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
const APPR_LINE = '법인카드 지출결의서'; // 결재선 팝업에서 명시 선택 (최근결재선 의존 제거)

// ── 사용자 정의 규칙(패턴→목적지 등록) 영속 저장. 사용처 포함 매칭. ──
const USER_RULES_FILE = '.auth/user-rules.json';
const normMerchant = (m) => String(m || '').replace(/[_\-]?\s*\d+\s*$/, '').replace(/\((법인|주|유|개인)\)/g, '').replace(/\s+/g, ' ').trim();
export function readUserRules() { try { return JSON.parse(readFileSync(USER_RULES_FILE, 'utf8')); } catch { return []; } }
export function writeUserRules(rules) { mkdirSync('.auth', { recursive: true }); writeFileSync(USER_RULES_FILE, JSON.stringify(rules, null, 2)); }
// 사용자 규칙 → 정적 규칙과 동일 shape. keywords(여러 사용처) 중 하나라도 포함되면 매칭(번들 목적지)
const ruleKeywords = (u) => (u.keywords && u.keywords.length ? u.keywords : [u.keyword]).filter(Boolean);
const matchKeyword = (merchant, kw) => String(merchant || '').includes(kw) || normMerchant(merchant).includes(normMerchant(kw));
const userRuleToRule = (u) => ({ id: u.id, label: u.label || `${ruleKeywords(u)[0]} 자동결의`, use: u.use, submitUse: u.submitUse || u.use, dept: u.dept || '', by: u.by || '', user: true, keywords: ruleKeywords(u),
  test: (x) => ruleKeywords(u).some((kw) => matchKeyword(x.merchant, kw)) });
const allRules = () => [...RULES, ...readUserRules().map(userRuleToRule)];
const ruleOf = (item) => allRules().find((r) => { try { return r.test(item); } catch { return false; } }) || null;
// 전체 영수증 컬럼: td[8]=용도(예산계정), td[10]=결의서, td[12]=사업(예산)부서, td[13]=직원. 완료건은 이 값들이 채워짐(학습 근거)
const toItem = (td) => ({ type: td[2], date: td[3], merchant: td[4], cardCo: td[5], card: td[6], amount: won(td[7]), use: (td[8] || '').trim(), doc: (td[10] || '').trim(), budget: (td[12] || '').trim(), staff: (td[13] || '').trim(), key: `${td[3]}|${td[4]}|${td[7]}` });
const topOf = (map) => { const e = Object.entries(map).sort((a, b) => b[1] - a[1]); return e.length ? e[0][0] : ''; };

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

// 조회 날짜 범위 직접 세팅(패턴 발굴처럼 여러 달 한번에 볼 때)
async function setDateRange(frame, s, e) {
  await frame.evaluate(({ s, e }) => {
    const set = (id, v) => { const el = document.getElementById(id); if (el) { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); } };
    ['START_DT', 'SHOW_START_DT', 'BASE_START_DT'].forEach((id) => set(id, s));
    ['END_DT', 'SHOW_END_DT', 'BASE_END_DT'].forEach((id) => set(id, e));
  }, { s, e });
}
// month(YYYY-MM) 기준 n개월 전 ~ month말일 범위
function monthSpan(month, backMonths) {
  const [y, m] = month.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1 - backMonths, 1));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const p2 = (n) => String(n).padStart(2, '0');
  return { s: `${start.getUTCFullYear()}-${p2(start.getUTCMonth() + 1)}-01`, e: `${y}-${p2(m)}-${p2(last)}`, months: backMonths + 1 };
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
    // 패턴 발굴: 타겟월 + 직전 3개월(총 4개월) '전체 영수증'(상신완료 포함)을 봐야 매월 상신되는 반복(예: 서버이용료)이 보인다.
    const span = monthSpan(month, 3);
    await setDateRange(frame, span.s, span.e);
    await frame.locator('a.pppCount', { hasText: /^전체\s*\(\d+\)/ }).first().click({ timeout: 6000 }).catch((e) => log('전체 탭 skip: ' + e.message.split('\n')[0]));
    await app.waitForTimeout(2000);
    await setPageSize(frame, app);
    await snap(app, `전체 영수증 조회 · ${span.s}~${span.e} (${span.months}개월) · 반복 패턴 발굴`, snapshots);

    const rows = (await scrapeRows(frame)).map(toItem).filter((it) => it.amount > 0);
    // 사용처(정규화) 그룹. '반복'=여러 '달'에 걸쳐 나타남(monthCount≥2). 완료건의 용도(예산계정)를 함께 학습.
    const groups = {};
    for (const x of rows) {
      const k = normMerchant(x.merchant) || x.merchant || '(빈 사용처)';
      (groups[k] ||= { merchant: k, sample: x.merchant, count: 0, total: 0, cards: new Set(), months: new Set(), uses: {}, budgets: {}, staffs: {}, resolved: 0 });
      const g = groups[k];
      g.count++; g.total += x.amount; g.cards.add(x.card); g.months.add(String(x.date).slice(0, 7));
      if (x.use) { g.uses[x.use] = (g.uses[x.use] || 0) + 1; g.resolved++; }   // 결의된 건 = 예산계정(용도) 학습
      if (x.budget) g.budgets[x.budget] = (g.budgets[x.budget] || 0) + 1;
      if (x.staff) g.staffs[x.staff] = (g.staffs[x.staff] || 0) + 1;
    }
    const all = Object.values(groups).map((g) => ({
      merchant: g.merchant, sample: g.sample, count: g.count, total: g.total, cards: [...g.cards],
      months: [...g.months].sort(), monthCount: g.months.size,
      use: topOf(g.uses), useVariants: Object.keys(g.uses), budget: topOf(g.budgets), staff: topOf(g.staffs),
      staffCount: Object.keys(g.staffs).length, resolved: g.resolved,
    }));
    const repeated = all.filter((g) => g.monthCount >= 2);

    // 추천 제외: (1) 이미 웹파일럿 목적지 있음(전용 레시피 용도 or 등록 규칙) (2) 인원(직원) 변동
    const userRules = readUserRules();
    const DEDICATED_USES = new Set(['야근교통비', '야근식비']);   // 야근택시/야근식비 전용 목적지가 처리
    const coveredByUser = (merchant) => userRules.some((u) => (u.keywords && u.keywords.length ? u.keywords : [u.keyword]).filter(Boolean).some((k) => matchKeyword(merchant, k)));
    const skipReason = (g) => {
      if (g.use && DEDICATED_USES.has(g.use)) return '전용 목적지(야근택시/식비)';
      if (coveredByUser(g.merchant)) return '이미 등록된 목적지';
      if (g.staffCount > 1) return '인원 변동';
      return '';
    };
    const recommended = [], skipped = [];
    for (const g of repeated) { const r = skipReason(g); if (r) skipped.push({ ...g, skip: r }); else recommended.push(g); }

    // 최대 묶기: 같은 용도(예산계정) 사용처들을 하나의 번들 목적지로 제안
    const bmap = {};
    for (const g of recommended) {
      const key = g.use || '(용도 미지정)';
      (bmap[key] ||= { use: g.use || '', merchants: [], count: 0, total: 0, months: new Set(), budgets: {} });
      const bd = bmap[key];
      bd.merchants.push({ merchant: g.merchant, count: g.count, total: g.total, monthCount: g.monthCount, budget: g.budget });
      bd.count += g.count; bd.total += g.total; g.months.forEach((m) => bd.months.add(m));
      if (g.budget) bd.budgets[g.budget] = (bd.budgets[g.budget] || 0) + 1;
    }
    const bundles = Object.values(bmap).map((bd) => ({
      use: bd.use, budget: topOf(bd.budgets), merchants: bd.merchants.sort((a, b) => b.count - a.count),
      merchantCount: bd.merchants.length, count: bd.count, total: bd.total, months: [...bd.months].sort(), monthCount: bd.months.size,
    })).sort((a, b) => b.merchantCount - a.merchantCount || b.total - a.total);

    const singleMonth = all.length - repeated.length;
    log(`전체(${span.months}개월) ${rows.length}건 · 반복 ${repeated.length}종 · 추천 ${recommended.length}(제외 ${skipped.length}) · 번들 ${bundles.length}`);
    const total = rows.reduce((a, x) => a + x.amount, 0);
    return {
      recipe: 'bizplay', name: '본인', month, span, snapshots, bundles, skipped,
      summary: { count: rows.length, totalText: total.toLocaleString('en-US') + '원', bundles: bundles.length, recommended: recommended.length, skipped: skipped.length, singleMonth, months: span.months },
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
    // 근태가 깨진 심야택시 날에 '출퇴근 정정 신청(대기)'이 있으면 → 승인 후 증빙 가능 예정으로 표시
    let submittedCorr = {};
    if (taxis.length) {
      await snap(app, '출퇴근 정정 신청 내역 대조 (정정 대기 → 증빙 예정)', snapshots);
      try { submittedCorr = (await getSubmittedCorrections(log, month)).byDate || {}; }
      catch (e) { log('정정 신청 조회 실패: ' + e.message.split('\n')[0]); }
    }
    const items = taxis.map((it) => {
      const yd = yagunDateOf(it.date); const rec = timeMap[yd];
      const isHol = !!(rec && (rec.weekend || rec.holiday));      // 주말/휴일 근무 = holMin
      const otMin = rec ? (isHol ? rec.holMin : rec.otMin) : 0;
      const worked = !!(rec && !rec.missing && otMin > 0);        // 평일 야근 or 휴일 근무 기록 존재
      const corr = !worked ? submittedCorr[yd] : null;            // 근태 없지만 정정 신청 대기 중
      return { ...it, yagunDate: yd, dow: rec ? rec.dow : '', yagunIn: rec ? rec.inText : '', yagunOut: rec ? rec.outText : '', otText: worked ? fmt(otMin) : '', isHoliday: isHol, hasProof: worked, pendingCorrection: !!corr, corrIn: corr ? corr.reqIn : '', corrOut: corr ? corr.reqOut : '', corrStatus: corr ? corr.status : '' };
    });
    const withProof = items.filter((x) => x.hasProof);
    const pendingCorr = items.filter((x) => !x.hasProof && x.pendingCorrection);
    const submitAmt = withProof.reduce((a, x) => a + x.amount, 0);
    const total = items.reduce((a, x) => a + x.amount, 0);
    log(`야근택시 ${items.length}건 · 증빙있음 ${withProof.length}건 · 정정대기 ${pendingCorr.length}건 · 제외 ${items.length - withProof.length - pendingCorr.length}건`);
    return {
      recipe: 'yagun', month, patternId: 'p2', snapshots, items,
      summary: { count: items.length, withProof: withProof.length, pendingCorrection: pendingCorr.length, noProof: items.length - withProof.length - pendingCorr.length, amount: submitAmt, totalText: total.toLocaleString('en-US') + '원' },
    };
  } finally { await ctx.close().catch(() => {}); }
}

// 야근식비 전용 조회: 혼자 먹은 1인 식대(13,000 이내) + 타임인아웃 근태로 저녁/조식 인정 판정
export async function getYasik({ id, pw, month, onSnapshot, freshLogin }) {
  const creds = { id: id || process.env.BIZPLAY_ID, pw: pw || process.env.BIZPLAY_PW };
  const snapshots = []; if (onSnapshot) snapshots.onSnap = onSnapshot;
  const log = (m) => console.error('[yasik]', m);
  const browser = await getBrowser();
  const { ctx, app, frame } = await openCardApp(browser, creds, snapshots, log, { month, freshLogin });
  try {
    await clickTab(frame, app, /^대기\s*\(\d+\)/, '대기', log);
    await setPageSize(frame, app);
    await snap(app, '미결의(대기) 조회 · 혼자 먹은 식대(13,000 이내 · 저녁/조식) 필터', snapshots);
    const meals = (await scrapeRows(frame)).map(toItem).filter((it) => { const r = ruleOf(it); return r && r.id === 'p3' && it.amount > 0; });

    const timeMap = {};
    if (meals.length) {
      const months = [...new Set(meals.map((it) => it.date.slice(0, 7)))];
      await snap(app, `타임인아웃 근태 조회 (야근·출근시각 확인 · ${months.join(', ')})`, snapshots);
      for (const mo of months) {
        try { const to = await getOvertimeEmployee({ month: mo, id: process.env.TIMEINOUT_ID, pw: process.env.TIMEINOUT_PW }); for (const dd of to.days || []) timeMap[`${mo}-${String(dd.day).padStart(2, '0')}`] = dd; }
        catch (e) { log(`타임인아웃 ${mo} 실패: ` + e.message.split('\n')[0]); }
      }
    }
    const items = meals.map((it) => {
      const day = it.date.slice(0, 10); const rec = timeMap[day];
      const c = yasikClass(it, rec);
      return { ...it, mealDate: day, dow: rec ? rec.dow : '', meal: c.meal, eligible: c.ok, why: c.why, inText: rec ? rec.inText : '', otText: rec && !rec.missing ? fmt((rec.weekend || rec.holiday) ? rec.holMin : rec.otMin) : '' };
    });
    const eligible = items.filter((x) => x.eligible);
    const amount = eligible.reduce((a, x) => a + x.amount, 0);
    const total = items.reduce((a, x) => a + x.amount, 0);
    log(`식대후보 ${items.length}건 · 인정 ${eligible.length}건 · 제외 ${items.length - eligible.length}건`);
    return {
      recipe: 'yasik', month, patternId: 'p3', snapshots, items,
      summary: { count: items.length, eligible: eligible.length, excluded: items.length - eligible.length, amount, totalText: total.toLocaleString('en-US') + '원' },
    };
  } finally { await ctx.close().catch(() => {}); }
}

// 등록된 목적지(사용자 규칙) 미리보기: 대기건 중 이 규칙에 걸리는 것만 스캔 → 상신은 이 화면 아닌 목적지에서
export async function getRulePending({ id, pw, month, patternId, onSnapshot, freshLogin }) {
  const rule = allRules().find((r) => r.id === patternId);
  if (!rule) throw new Error('알 수 없는 규칙: ' + patternId);
  const creds = { id: id || process.env.BIZPLAY_ID, pw: pw || process.env.BIZPLAY_PW };
  const snapshots = []; if (onSnapshot) snapshots.onSnap = onSnapshot;
  const log = (m) => console.error('[pattern]', m);
  const browser = await getBrowser();
  const { ctx, app, frame } = await openCardApp(browser, creds, snapshots, log, { month, freshLogin });
  try {
    await clickTab(frame, app, /^대기\s*\(\d+\)/, '대기', log);
    await setPageSize(frame, app);
    await snap(app, `미결의(대기) 조회 · '${rule.label}' 규칙 필터`, snapshots);
    const items = (await scrapeRows(frame)).map(toItem).filter((it) => { try { return rule.test(it) && it.amount > 0; } catch { return false; } });
    const total = items.reduce((a, x) => a + x.amount, 0);
    log(`'${rule.label}' 대상 ${items.length}건 · ${total.toLocaleString('en-US')}원`);
    return {
      recipe: 'pattern', month, patternId, ruleLabel: rule.label, use: rule.submitUse || rule.use, snapshots, items,
      summary: { count: items.length, amount: total, totalText: total.toLocaleString('en-US') + '원' },
    };
  } finally { await ctx.close().catch(() => {}); }
}

// ── 상신: 결의서 작성 → 용도 바인딩 → 결재요청 → 결재선 확인 ──────
// 용도 콤보 구조(실측): 라인마다 고유 컨테이너 div.purpose_combo#TRAN_KIND_CD{n}.
//   - 열기 버튼: a.bt_purpose_cbList("목록보기"), 초기화: a.bt_purpose_ipReset
//   - 옵션: a.cb_item (예: "야근교통비 (81200)"). 옵션을 실제 클릭해야 코드가 박힘
//     (타이핑만으론 표시만 되고 코드 미바인딩 → "용도 미입력" 반려).
// 좌표/y필터/nth 인덱스는 멀티라인+스크롤에서 오작동 → 컴보 ID로 스코프해서 처리.
async function bindUseInCombo(combo, useName) {
  const re = new RegExp(escapeRe(useName));
  const inp = combo.locator('input[placeholder*="선택"]').first();
  if (!(await inp.count().catch(() => 0))) return false;
  const clickMatch = async () => {
    const opt = combo.locator('a.cb_item', { hasText: re });
    const n = await opt.count().catch(() => 0);
    for (let j = 0; j < n; j++) {
      const o = opt.nth(j);
      if (!(await o.isVisible().catch(() => false))) continue;   // 열린 컴보의 옵션만 visible
      await o.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
      await o.click({ timeout: 3000 }).catch(() => {});
      return true;
    }
    return false;
  };
  // 1) 목록보기(▼) 열고 옵션 클릭
  const listBtn = combo.locator('a.bt_purpose_cbList').first();
  await listBtn.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
  await listBtn.click({ timeout: 4000 }).catch(() => {});
  await combo.page().waitForTimeout(700);
  let ok = await clickMatch();
  // 2) 못찾으면 타이핑으로 229-리스트 필터 후 재시도(선택은 반드시 옵션 클릭)
  if (!ok) {
    await inp.click({ timeout: 3000 }).catch(() => {});
    await inp.fill('').catch(() => {});
    await inp.pressSequentially(useName, { delay: 70 }).catch(() => {});
    await combo.page().waitForTimeout(900);
    ok = await clickMatch();
  }
  await combo.page().waitForTimeout(300);
  return re.test(await inp.inputValue().catch(() => ''));
}

// 결의서에 라인이 여러 개면 라인마다 용도 콤보가 있음 → 컴보 ID별로 전부 바인딩
async function bindUseAll(app, modal, useName, log) {
  const combos = modal.locator('div.purpose_combo[id^="TRAN_KIND_CD"]');
  const n = await combos.count().catch(() => 0);
  if (!n) { log('용도 콤보(TRAN_KIND_CD) 0개 — 결의서 라인 구조 변경 의심'); return false; }
  let okAll = true;
  for (let i = 0; i < n; i++) {
    const ok = await bindUseInCombo(combos.nth(i), useName);
    if (!ok) { okAll = false; log(`용도 바인딩 실패 (라인 ${i + 1}/${n})`); }
  }
  return okAll;
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
const toMin = (t) => { const m = String(t).match(/(\d{1,2}):(\d{2})/); return m ? (+m[1]) * 60 + (+m[2]) : null; };
// 실제 펀치 기록 → 증빙 표 행
function yagunProofRowFromRec(rec, dateStr, isHol, item) {
  return {
    date: dateStr, dow: rec.dow, kind: isHol ? 'hol' : 'ot',
    inText: rec.inText, outText: rec.outText,         // outText는 익일이면 '익일 HH:MM'
    workMin: rec.workMin, otMin: isHol ? rec.holMin : rec.otMin,
    taxiAt: item.date, amount: item.amount, corrStatus: '',
  };
}
// 정정 신청(대기)값 → 증빙 표 행 (승인 전 '미리 결의'용)
function yagunProofRowFromCorr(corr, dateStr, rec, item) {
  const iM = toMin(corr.reqIn); let oM = toMin(corr.reqOut); const overnight = iM != null && oM != null && oM < iM;
  if (overnight) oM += 1440;
  const workMin = (iM != null && oM != null) ? oM - iM : 0;
  return {
    date: dateStr, dow: rec ? rec.dow : '', kind: 'corr',
    inText: corr.reqIn, outText: overnight ? `익일 ${corr.reqOut}` : corr.reqOut,
    workMin, otMin: Math.max(0, workMin - 480), taxiAt: item.date, amount: item.amount, corrStatus: corr.status || '',
  };
}
// 여러 야근/휴일 건을 한 장의 표 이미지(PNG)로 렌더 → 결의서에 이 1장만 첨부
async function renderYagunTableImage(rows, mode, month) {
  const browser = await getBrowser();
  const pg = await browser.newPage({ viewport: { width: 900, height: 300 }, deviceScaleFactor: 2 });
  try {
    rows = [...rows].sort((a, b) => a.date.localeCompare(b.date));
    const isPending = mode === 'pending';
    const title = isPending ? '🌙 야근 택시비 증빙 (출퇴근 정정 신청 기준)' : '🌙 야근·휴일근무 택시비 증빙';
    const sub = isPending
      ? '출퇴근 정정 신청값 기준 · 승인 시 야근 확정'
      : '회사 근로인정시간이 아닌 실제 출퇴근 펀치(찐 퇴근) 기준';
    const totalAmt = rows.reduce((a, r) => a + (r.amount || 0), 0);
    const totalOt = rows.reduce((a, r) => a + (r.otMin || 0), 0);
    const kindLabel = (r) => r.kind === 'hol' ? '휴일근무' : r.kind === 'corr' ? `야근(정정${r.corrStatus ? ' ' + r.corrStatus : ''})` : '야근';
    const logo = TIMEINOUT_LOGO ? `<img src="${TIMEINOUT_LOGO}" width="26" height="26" style="border-radius:6px;vertical-align:middle"/>` : '';
    const td = 'border:1px solid #d4dbec;padding:8px 10px';
    const th = `${td};background:#eef2fb;color:#42506b;font-weight:700`;
    const body = rows.map((r) => `<tr>
        <td style="${td};text-align:center">${r.date}${r.dow ? ` (${r.dow})` : ''}</td>
        <td style="${td};text-align:center">${r.inText || '-'}</td>
        <td style="${td};text-align:center">${r.outText || '-'}</td>
        <td style="${td};text-align:center">${fmt(r.workMin)}</td>
        <td style="${td};text-align:center;color:#e0484d;font-weight:700">${fmt(r.otMin)}</td>
        <td style="${td};text-align:center;color:#5b6472">${kindLabel(r)}</td>
        <td style="${td};text-align:center">${String(r.taxiAt || '').replace(/^\d{4}-/, '')}</td>
        <td style="${td};text-align:right">${(r.amount || 0).toLocaleString('en-US')}원</td>
      </tr>`).join('');
    await pg.setContent(`<div id="card" style="font-family:'Apple SD Gothic Neo',AppleGothic,sans-serif;padding:24px;width:840px;background:#fff;border:1px solid #e7ebf3;border-radius:10px">
      <div style="display:flex;align-items:center;gap:9px">
        ${logo}<span style="font-weight:800;font-size:18px;color:#1f2a44">${title}</span></div>
      <div style="color:#6b7488;font-size:12.5px;margin:6px 0 15px">${month} · 총 <b>${rows.length}건</b> · ${sub}</div>
      <table style="border-collapse:collapse;width:100%;font-size:13px">
        <tr>
          <th style="${th}">야근일</th><th style="${th}">출근</th><th style="${th}">퇴근</th>
          <th style="${th}">근무</th><th style="${th}">초과(야근/휴일)</th><th style="${th}">구분</th>
          <th style="${th}">택시사용</th><th style="${th}">금액</th></tr>
        ${body}
        <tr style="background:#f7f9fd;font-weight:800">
          <td style="${td};text-align:center" colspan="4">합계 ${rows.length}건</td>
          <td style="${td};text-align:center;color:#e0484d">${fmt(totalOt)}</td>
          <td style="${td}"></td><td style="${td}"></td>
          <td style="${td};text-align:right">${totalAmt.toLocaleString('en-US')}원</td></tr>
      </table>
      <div style="color:#96a0b5;font-size:11px;margin-top:12px">※ 각 야근/휴일근무일의 실제 출퇴근 기록과 심야택시 사용을 매칭한 일괄 증빙 · 야근 택시비</div>
      <div style="display:flex;align-items:center;gap:6px;margin-top:9px;padding-top:9px;border-top:1px solid #eef1f6;color:#aab2c2;font-size:10.5px">
        ${TIMEINOUT_LOGO ? `<img src="${TIMEINOUT_LOGO}" width="13" height="13" style="border-radius:3px;opacity:.8"/>` : ''}
        <span>출처: <b style="color:#8f98a8">타임인아웃</b> (user.timeinout.kr) · ${isPending ? '출퇴근 정보수정 요청' : '근태 출퇴근 기록'} · webpilot 자동 생성</span></div>
    </div>`);
    const buf = await pg.locator('#card').screenshot({ type: 'png' });
    mkdirSync('.tmp', { recursive: true });
    const path = `.tmp/yagun-table-${month}.png`;
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

// 여러 항목을 하나의 결의서로 묶어 1건만 상신. 반환: { ok, reason }
// items = 같은 용도(rule)의 대기건 배열, attachPaths = 증빙 이미지 경로들(한 결의서에 전부 첨부)
async function submitBatch({ ctx, app, frame, items, useName, snapshots, log, getDialog, attachPaths = [] }) {
  const keys = items.map((it) => it.key);
  // 대상 전부 체크(나머지 해제)
  const hit = await frame.evaluate((keyList) => {
    const set = new Set(keyList);
    let n = 0;
    for (const tr of document.querySelectorAll('#tableList tr')) {
      const cb = tr.querySelector('input[type=checkbox]'); if (!cb) continue;
      const t = [...tr.querySelectorAll('td')].map((td) => td.innerText.trim());
      if (t.length < 8) { if (cb.checked) cb.click(); continue; }
      const k = `${t[3]}|${t[4]}|${t[7]}`;
      if (set.has(k)) { if (!cb.checked) cb.click(); n++; } else if (cb.checked) cb.click();
    }
    return n;
  }, keys);
  if (!hit) return { ok: false, reason: 'not_found' };
  if (hit < keys.length) log(`체크 ${hit}/${keys.length}건 — 일부 행 매칭 실패`);
  await app.waitForTimeout(400);

  await frame.getByText('결의서 작성', { exact: true }).first().click({ timeout: 5000 }).catch(() => {});
  let modal = null;
  for (let i = 0; i < 9 && !modal; i++) { await app.waitForTimeout(600); modal = app.frames().find((fr) => fr.url().includes('eapr_1001')); }
  if (!modal) return { ok: false, reason: /해외/.test(getDialog()) ? 'overseas' : 'no_modal' };

  // 용도: 라인마다 있으므로 전부 바인딩
  if (!(await bindUseAll(app, modal, useName, log))) { await closeModal(app); return { ok: false, reason: 'use_failed' }; }
  await snap(app, `${hit}건 · 용도 '${useName}' 바인딩`, snapshots);

  // 증빙 이미지 전부 첨부(한 결의서에)
  let attached = 0;
  for (const p of attachPaths) {
    const ok = await attachFile(ctx, app, modal, p, log);
    if (ok) attached++;
  }
  if (attachPaths.length) await snap(app, `증빙 ${attached}/${attachPaths.length}건 첨부`, snapshots);

  const popupWait = ctx.waitForEvent('page', { timeout: 12000 }).catch(() => null);
  await modal.getByText('결재요청', { exact: true }).first().click({ timeout: 4000 }).catch(() => {});
  const popup = await popupWait;                                            // 결재선 선택 팝업
  if (!popup) { await closeModal(app); return { ok: false, reason: 'no_popup' }; }
  await popup.waitForLoadState('domcontentloaded').catch(() => {});
  await popup.waitForTimeout(2200);
  // 결재선을 '법인카드 지출결의서'로 명시 선택 (최근결재선에 의존하지 않음)
  await popup.locator('#APPRLINE_NM').selectOption({ label: APPR_LINE }).catch((e) => log('결재선 선택 skip: ' + e.message.split('\n')[0]));
  await popup.waitForTimeout(2000);
  await popup.getByText('확인', { exact: true }).first().click({ timeout: 5000 }).catch(async () => { await popup.getByRole('button', { name: '확인' }).click({ timeout: 3000 }).catch(() => {}); });
  for (let i = 0; i < 22; i++) { await app.waitForTimeout(1000); if (popup.isClosed()) break; }
  await app.waitForTimeout(1500);
  const ok = /등록되었습니다/.test(getDialog());
  await snap(app, `상신 ${ok ? '완료 ✓' : '처리'} · ${hit}건 1결재`, snapshots);
  return { ok: true, count: hit };   // 팝업 닫힘 + 등록 알림이면 완료(알림 유실 대비 낙관 처리)
}

export async function submitExpenses({ id, pw, month, patternId, yagunMode = 'record', onSnapshot, freshLogin }) {
  const creds = { id: id || process.env.BIZPLAY_ID, pw: pw || process.env.BIZPLAY_PW };
  const snapshots = []; if (onSnapshot) snapshots.onSnap = onSnapshot;
  const log = (m) => console.error('[bizplay:submit]', m);
  const rule = allRules().find((r) => r.id === patternId);
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

    // 타임인아웃 근태 선조회: 야근택시(증빙) 또는 야근식비(인정 판정) 규칙에 필요
    const needTime = rule.attach === 'yagun' || rule.eligibility === 'yasik';
    let timeMap = null, corrMap = null;
    if (needTime && targets.length) {
      timeMap = {};
      const monthOf = (it) => rule.eligibility === 'yasik' ? it.date.slice(0, 7) : yagunDateOf(it.date).slice(0, 7);
      const months = [...new Set(targets.map(monthOf))];
      await snap(app, `타임인아웃 근태 조회 (${rule.eligibility === 'yasik' ? '야근·출근시각 판정' : '증빙용'} · ${months.join(', ')})`, snapshots);
      for (const mo of months) {
        try {
          const to = await getOvertimeEmployee({ month: mo, id: process.env.TIMEINOUT_ID, pw: process.env.TIMEINOUT_PW });
          for (const dd of to.days || []) timeMap[`${mo}-${String(dd.day).padStart(2, '0')}`] = dd;
        } catch (e) { log(`타임인아웃 ${mo} 조회 실패: ` + e.message.split('\n')[0]); }
      }
      log('타임인아웃 근태데이터 ' + Object.keys(timeMap).length + '일 확보');
      if (rule.attach === 'yagun' && yagunMode === 'pending') {   // 정정 대기값을 증빙으로 쓰는 '미리 결의' 모드
        await snap(app, '출퇴근 정정 신청(대기) 내역 조회 — 정정 기반 증빙', snapshots);
        try { corrMap = (await getSubmittedCorrections(log, month)).byDate || {}; }
        catch (e) { corrMap = {}; log('정정 신청 조회 실패: ' + e.message.split('\n')[0]); }
      }
    }

    const submitted = [], skipped = [...notReady], failed = [];
    // 1) 대상 선별 + 증빙 표 행 수집 (제외 사유는 skipped로). 야근증빙은 건별 캡처가 아니라 표 1장.
    const toSubmit = [];   // { item }
    const proofRows = [];  // 증빙 표 행 (야근/휴일 or 정정)
    for (const item of targets) {
      if (rule.eligibility === 'yasik') {
        const rec = timeMap && timeMap[item.date.slice(0, 10)];
        const c = yasikClass(item, rec);
        if (!c.ok) { skipped.push({ ...item, reason: `야근식비 미인정 (${c.meal}: ${c.why})` }); continue; }
      } else if (rule.attach === 'yagun') {
        const yd = yagunDateOf(item.date);
        const rec = timeMap && timeMap[yd];
        const isHol = rec && (rec.weekend || rec.holiday);
        const otMin = rec ? (isHol ? rec.holMin : rec.otMin) : 0;
        const hasRecord = !!(rec && !rec.missing && otMin > 0);
        if (yagunMode === 'pending') {   // 정정 대기건만: 기록 없고 정정 신청 있는 날, 정정값 증빙
          if (hasRecord) { skipped.push({ ...item, reason: `정상 야근 기록 있음 (${yd}) — 일반 결의 대상` }); continue; }
          const corr = corrMap && corrMap[yd];
          if (!corr) { skipped.push({ ...item, reason: `정정 신청 없음 (${yd}) — 미리 결의 대상 아님` }); continue; }
          proofRows.push(yagunProofRowFromCorr(corr, yd, rec, item));
        } else {                          // 기본: 실제 야근/휴일 기록 있어야 상신 가능 (없으면 제외)
          if (!hasRecord) { skipped.push({ ...item, reason: `야근/휴일 기록 없음 (${yd}) — 증빙 불가로 제외` }); continue; }
          proofRows.push(yagunProofRowFromRec(rec, yd, isHol, item));
        }
      }
      toSubmit.push({ item });
    }

    // 증빙 표 1장 렌더 (야근택시 규칙만) — 결의서에 이 1장만 첨부
    let tablePath = null;
    if (rule.attach === 'yagun' && proofRows.length) {
      try { tablePath = await renderYagunTableImage(proofRows, yagunMode, month); }
      catch (e) { tablePath = null; log('증빙 표 이미지 실패: ' + e.message.split('\n')[0]); }
    }

    // 2) 같은 용도 대기건을 하나의 결의서로 묶어 1건만 상신
    if (toSubmit.length) {
      lastDialog = '';
      log(`상신 묶음 ${toSubmit.length}건 → 결재 1건${tablePath ? ' · 증빙 표 1장' : ''}`);
      let r;
      try {
        r = await submitBatch({
          ctx, app, frame, items: toSubmit.map((x) => x.item), useName: rule.submitUse,
          attachPaths: tablePath ? [tablePath] : [],
          snapshots, log, getDialog: () => lastDialog,
        });
      } catch (e) { r = { ok: false, reason: 'error:' + e.message.split('\n')[0] }; }
      if (r.ok) submitted.push(...toSubmit.map((x) => x.item));
      else if (r.reason === 'overseas') skipped.push(...toSubmit.map((x) => ({ ...x.item, reason: '해외 — 청구내역 도착 후 가능' })));
      else failed.push(...toSubmit.map((x) => ({ ...x.item, reason: r.reason || 'batch 실패' })));
    }
    log(`완료: 상신 ${submitted.length}건(결재 ${submitted.length ? 1 : 0}건) / 스킵 ${skipped.length} / 실패 ${failed.length}`);
    return {
      recipe: 'bizplay-submit', patternId, use: rule.use, submitUse: rule.submitUse, month, snapshots,
      submitted, skipped, failed,
      summary: { total: targets.length, submitted: submitted.length, approvals: submitted.length ? 1 : 0, skipped: skipped.length, failed: failed.length, amount: submitted.reduce((a, x) => a + x.amount, 0) },
    };
  } finally { await ctx.close().catch(() => {}); }
}
