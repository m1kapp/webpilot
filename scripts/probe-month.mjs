// 실제 타임인아웃에서 "월 이동이 어떻게 동작하는지" 직접 눌러 보고 알아내는 도구.
//
// 가짜 서버로는 내가 상상한 화면만 검증된다. 실제 화면이 어떻게 생겼는지는
// 실물을 눌러 봐야 안다. 그래서 확장을 얹은 브라우저를 띄우고, 로그인만 사람이 한 뒤
// 라벨 주변의 후보를 하나씩 눌러 어느 것이 달을 바꾸는지 기록한다.
//
// 비밀번호는 이 창의 실제 사이트로만 간다 — 스크립트는 입력을 읽지도 저장하지도 않는다.
// 프로필은 .probe-profile에 남아 다음 실행 때 로그인이 유지된다(.gitignore 처리됨).
//
//   npm run ext:probe            # 기본: 이번 달 기준 한 달 전으로 이동 시도
//   npm run ext:probe 2026-06    # 특정 달로
import { chromium } from 'playwright';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, 'extension');
const PROFILE = join(ROOT, '.probe-profile');
const URL_HISTORY = 'https://user.timeinout.kr/InOutMng/InOutHistory';

const arg = process.argv[2];
const now = new Date();
const target = arg && /^\d{4}-\d{2}$/.test(arg)
  ? arg
  : `${now.getFullYear()}-${String(now.getMonth() === 0 ? 12 : now.getMonth()).padStart(2, '0')}`;
const [ty, tm] = target.split('-').map(Number);

const ctx = await chromium.launchPersistentContext(PROFILE, { headless: false, viewport: null });
const page = ctx.pages()[0] || await ctx.newPage();
await page.goto(URL_HISTORY, { waitUntil: 'domcontentloaded' }).catch(() => {});

const readLabel = () => page.evaluate(() =>
  (document.body.innerText.match(/(\d{4})년\s*(\d{1,2})월/) || [])[0] || '').catch(() => '');

// ── 1. 로그인 대기 ── 비밀번호칸이 사라지고 월 라벨이 보이면 들어온 것으로 본다.
console.log('\n브라우저를 띄웠습니다. 창에서 타임인아웃에 로그인해주세요.');
console.log('(비밀번호는 이 창의 실제 사이트로만 갑니다 — 스크립트는 읽지 않습니다)\n');
let label = '';
for (let i = 0; i < 300; i++) {                       // 최대 5분
  const state = await page.evaluate(() => ({
    pw: !!document.querySelector('input[type="password"]'),
    label: (document.body.innerText.match(/(\d{4})년\s*(\d{1,2})월/) || [])[0] || '',
  })).catch(() => ({ pw: true, label: '' }));
  if (!state.pw && state.label) { label = state.label; break; }
  if (i % 10 === 0) process.stdout.write('.');
  await page.waitForTimeout(1000);
}
if (!label) {
  console.log('\n로그인을 확인하지 못했습니다. 근태 현황 화면까지 들어간 뒤 다시 실행해주세요.');
  await ctx.close(); process.exit(1);
}
console.log(`\n로그인 확인됨. 지금 화면: ${label}\n`);

const results = [];

// ── 2. URL 파라미터 ── 출장 목록이 쓰는 방식(?month=<상대개월>)이 여기서도 통하는지.
const offset = (ty * 12 + tm) - (now.getFullYear() * 12 + (now.getMonth() + 1));
console.log(`── URL 파라미터 (?month=${offset}) ──`);
await page.goto(`${URL_HISTORY}?month=${offset}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
await page.waitForTimeout(1500);
const urlLabel = await readLabel();
const urlWorks = urlLabel && urlLabel !== label;
console.log(`  결과: ${urlLabel || '(라벨 없음)'} ${urlWorks ? '← 바뀜 ✔' : '← 그대로'}\n`);
results.push({ 방법: `URL ?month=${offset}`, 결과: urlLabel, 성공: !!urlWorks });

// ── 3. 클릭 후보를 하나씩 눌러 본다 ──
// 라벨 주변에서 눌릴 만한 것을 모으고, 하나 누를 때마다 라벨이 바뀌는지 보고 원위치.
const candidates = await page.evaluate(() => {
  const all = [...document.querySelectorAll('*')];
  const labelEl = all.find((el) => el.children.length === 0 && /\d{4}년\s*\d{1,2}월/.test(el.textContent || ''));
  if (!labelEl) return [];
  const brief = (el) => {
    const cls = typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 16);
    return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls}${t ? ` "${t}"` : ''}`;
  };
  const path = (el) => {                       // 다시 찾아가기 위한 좌표 대신의 경로
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 6; n = n.parentElement) {
      const i = n.parentElement ? [...n.parentElement.children].indexOf(n) : 0;
      parts.unshift(`${n.tagName.toLowerCase()}:nth-child(${i + 1})`);
      if (n.id) { parts[0] = `#${CSS.escape(n.id)}`; break; }
    }
    return parts.join(' > ');
  };
  const visible = (el) => el.offsetParent !== null && !el.contains(labelEl) && el !== labelEl;
  const row = labelEl.closest('div, header, nav, section') || labelEl.parentElement;
  const near = row ? [...row.querySelectorAll('a,button,i,span,img,svg,[onclick],[class*=prev],[class*=next],[class*=arrow]')] : [];
  const worded = all.filter((el) => el.children.length === 0
    && /^(이전|다음|지난)\s*(달|월)?$|^[◀▶‹›<>←→❮❯]$/.test((el.textContent || '').trim()));
  const box = labelEl.getBoundingClientRect();
  const byPoint = [-40, -28, -20, 20, 28, 40]
    .map((dx) => document.elementFromPoint(dx < 0 ? box.left + dx : box.right + dx, box.top + box.height / 2))
    .filter(Boolean);
  const seen = new Set();
  return [...worded, ...near, ...byPoint].filter((el) => {
    if (!el || !visible(el)) return false;
    const p = path(el); if (seen.has(p)) return false; seen.add(p); return true;
  }).slice(0, 14).map((el) => ({ desc: brief(el), sel: path(el) }));
});

console.log(`── 클릭 후보 ${candidates.length}개를 하나씩 눌러 봅니다 ──`);
for (const c of candidates) {
  await page.goto(URL_HISTORY, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1200);
  const before = await readLabel();
  const clicked = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    el.click();
    return true;
  }, c.sel).catch(() => false);
  if (!clicked) { console.log(`  · ${c.desc} → 요소를 다시 못 찾음`); continue; }
  await page.waitForTimeout(1500);
  const after = await readLabel();
  const moved = after && after !== before;
  console.log(`  ${moved ? '✔' : '·'} ${c.desc} → ${after || '(없음)'}${moved ? '  ← 달이 바뀜' : ''}`);
  results.push({ 방법: `click ${c.desc}`, 셀렉터: c.sel, 결과: after, 성공: !!moved });
}

// ── 4. 확장 자체로 목표월 조회 ── 실제 경로가 끝까지 도는지.
console.log(`\n── 확장으로 ${target} 조회 ──`);
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
if (sw) {
  const panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${new URL(sw.url()).host}/page/index.html`);
  const res = await panel.evaluate((mo) => new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'overtime', month: mo }, (r) => resolve(r));
  }), target).catch((e) => ({ ok: false, error: String(e) }));
  if (res?.ok) {
    const s = res.data.summary;
    console.log(`  ✔ 성공 — 평일 초과 ${s.wdOtText} · 휴일 근무 ${s.holText} · 총 근로 ${s.totalAllText}`);
  } else {
    console.log(`  ✗ 실패 — ${res?.error || '(응답 없음)'}`);
    if (res?.detail) console.log(res.detail.split('\n').map((l) => '    ' + l).join('\n'));
  }
}

const winners = results.filter((r) => r.성공);
console.log('\n── 정리 ──');
if (winners.length) {
  console.log('달을 실제로 바꾼 방법:');
  for (const w of winners) console.log(`  ✔ ${w.방법}${w.셀렉터 ? `   (${w.셀렉터})` : ''}`);
} else {
  console.log('  어떤 방법도 달을 바꾸지 못했습니다. 위 후보 목록을 그대로 전달해주세요.');
}
console.log('\n브라우저는 열어 둡니다. 확인이 끝나면 창을 닫으세요.');
