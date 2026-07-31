// 실물 비즈플레이에서 "카드영수증 앱이 어떻게 열리는지" 직접 눌러 보고 알아내는 도구.
//
// 확장은 런처의 앱 아이콘을 눌러 window.open을 가로채 앱 주소를 얻으려 하는데,
// 실제 화면에서 아이콘을 못 찾거나 클릭이 주소를 만들지 않아 막혔다.
// 여기서는 아이콘 후보를 전부 훑고, 하나 눌렀을 때 실제로 무슨 일이 일어나는지
// (window.open · 같은 탭 이동 · 새 탭) 기록한다.
//
// 비밀번호는 이 창의 실제 사이트로만 간다 — 스크립트는 입력을 읽지도 저장하지도 않는다.
// 프로필은 .probe-profile에 남아 다음 실행 때 로그인이 유지된다(.gitignore 처리됨).
//
//   npm run ext:probe-bizplay
import { chromium } from 'playwright';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, 'extension');
const PROFILE = join(ROOT, '.probe-profile');
const LAUNCHER = 'https://www.bizplay.co.kr/main_0003_01.act';

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false, viewport: null,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
const page = ctx.pages()[0] || await ctx.newPage();
await page.goto(LAUNCHER, { waitUntil: 'domcontentloaded' }).catch(() => {});

console.log('\n브라우저를 띄웠습니다. 창에서 비즈플레이에 로그인해주세요.');
console.log('(비밀번호는 이 창의 실제 사이트로만 갑니다 — 스크립트는 읽지 않습니다)\n');

// ── 1. 로그인 대기 ── 비밀번호칸이 사라지고 '카드영수증' 글자가 보이면 들어온 것.
let ready = false;
for (let i = 0; i < 300; i++) {
  const st = await page.evaluate(() => ({
    pw: !!document.querySelector('input[type="password"], #PWD'),
    hasApp: /카드영수증/.test(document.body.innerText || ''),
    url: location.href,
  })).catch(() => ({ pw: true, hasApp: false, url: '' }));
  if (!st.pw && st.hasApp) { ready = true; console.log(`\n로그인 확인됨. 현재 주소: ${st.url}`); break; }
  if (i % 10 === 0) process.stdout.write('.');
  await page.waitForTimeout(1000);
}
if (!ready) {
  console.log('\n로그인 또는 "카드영수증" 아이콘을 확인하지 못했습니다.');
  console.log('앱 목록이 보이는 화면까지 들어간 뒤 다시 실행해주세요.');
  const url = await page.url();
  console.log(`현재 주소: ${url}`);
  await ctx.close(); process.exit(1);
}

const brief = (el) => el;   // 페이지 안에서 만든 문자열을 그대로 쓴다

// ── 2. '카드영수증'이 들어간 요소를 전부 훑는다 ──
const cands = await page.evaluate(() => {
  const desc = (el) => {
    const cls = typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\s+/).slice(0, 4).join('.') : '';
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 20);
    const r = el.getBoundingClientRect();
    return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls}` +
      ` [${Math.round(r.width)}x${Math.round(r.height)}]${el.offsetParent ? '' : ' (숨김)'}` +
      `${el.getAttribute('href') ? ` href=${el.getAttribute('href').slice(0, 60)}` : ''}` +
      `${el.getAttribute('onclick') ? ` onclick=${el.getAttribute('onclick').slice(0, 70)}` : ''}` +
      ` "${t}"`;
  };
  const path = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 7; n = n.parentElement) {
      if (n.id) { parts.unshift(`#${CSS.escape(n.id)}`); break; }
      const i = n.parentElement ? [...n.parentElement.children].indexOf(n) : 0;
      parts.unshift(`${n.tagName.toLowerCase()}:nth-child(${i + 1})`);
    }
    return parts.join(' > ');
  };
  const all = [...document.querySelectorAll('*')]
    .filter((el) => /카드영수증/.test(el.textContent || '') && (el.textContent || '').length < 60);
  // 가장 안쪽(글자를 직접 감싼) 것부터 바깥으로
  all.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
  return {
    appBoxCount: document.querySelectorAll('.app_box').length,
    frames: [...document.querySelectorAll('iframe')].map((f) => f.src || '(src 없음)'),
    items: all.slice(0, 12).map((el) => ({ desc: desc(el), sel: path(el) })),
  };
});

console.log(`\n── 화면 구조 ──`);
console.log(`  .app_box 개수: ${cands.appBoxCount}`);
console.log(`  iframe: ${cands.frames.length ? cands.frames.join(', ') : '없음'}`);
console.log(`\n── '카드영수증'이 들어간 요소 ${cands.items.length}개 (안쪽 → 바깥) ──`);
for (const it of cands.items) console.log(`  ${it.desc}`);

// ── 3. 후보를 하나씩 눌러 무슨 일이 일어나는지 본다 ──
console.log(`\n── 하나씩 눌러 봅니다 ──`);
const wins = [];
for (const it of cands.items.slice(0, 6)) {
  await page.goto(LAUNCHER, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1500);
  const before = page.url();

  // 새 탭(팝업)이 뜨는지 감시
  let popupUrl = null;
  const onPage = (p) => { popupUrl = popupUrl || p.url(); };
  ctx.on('page', onPage);

  // window.open을 메인 월드에서 가로챈다 (Playwright evaluate는 메인 월드)
  const opened = await page.evaluate((sel) => new Promise((resolve) => {
    const el = document.querySelector(sel);
    if (!el) return resolve({ error: '요소 없음' });
    const orig = window.open;
    let done = false;
    const finish = (v) => { if (done) return; done = true; window.open = orig; resolve(v); };
    window.open = function (u) { finish({ via: 'window.open', url: u ? new URL(u, location.href).href : null }); return { closed: false, focus() {}, close() {} }; };
    const r = el.getBoundingClientRect();
    (document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) || el).click();
    setTimeout(() => finish({ via: null }), 3000);
  }), it.sel).catch((e) => ({ error: String(e).slice(0, 60) }));

  await page.waitForTimeout(2000);
  ctx.off('page', onPage);
  const after = page.url();
  const navigated = after !== before;

  let how = '아무 일도 없음';
  if (opened?.error) how = `오류: ${opened.error}`;
  else if (opened?.via === 'window.open') how = `window.open → ${opened.url || '(주소 없음)'}`;
  else if (popupUrl) how = `새 탭 → ${popupUrl}`;
  else if (navigated) how = `같은 탭 이동 → ${after}`;

  const good = /window\.open|새 탭|같은 탭 이동/.test(how);
  console.log(`  ${good ? '✔' : '·'} ${it.desc.slice(0, 70)}`);
  console.log(`      ${how}`);
  if (good) wins.push({ sel: it.sel, desc: it.desc, how });

  // 팝업으로 열렸으면 그 안의 iframe도 본다 — 확장이 찾는 eusr_9001이 있는지
  if (good) {
    const appUrl = opened?.url || popupUrl || after;
    const probe = await ctx.newPage();
    await probe.goto(appUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await probe.waitForTimeout(4000);
    const frames = probe.frames().map((f) => f.url()).filter((u) => u && u !== 'about:blank');
    console.log(`      앱 안의 프레임 ${frames.length}개:`);
    for (const f of frames) console.log(`        ${f.slice(0, 110)}${/eusr_9001/.test(f) ? '   ← 확장이 찾는 것' : ''}`);
    await probe.close();
    break;   // 하나 찾았으면 충분
  }
}

console.log('\n── 정리 ──');
if (wins.length) {
  for (const w of wins) console.log(`  ✔ ${w.how}\n     셀렉터: ${w.sel}`);
} else {
  console.log('  어떤 후보도 앱을 열지 못했습니다. 위 요소 목록을 그대로 전달해주세요.');
}
console.log('\n브라우저는 열어 둡니다. 확인이 끝나면 창을 닫으세요.');
