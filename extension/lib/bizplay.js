// 비즈플레이 수집(익스텐션판) — 카드영수증 앱의 미결의(대기)에서 야근택시·야근식비 후보를 뽑아
// 타임인아웃 근태로 증빙 가능 여부를 판정한다. src/lib/bizplay.mjs의 getYagunTaxi/getYasik에 대응.
// ⚠ 상신(일괄결의)은 제외 — 실제 경비 시스템에 쓰기라 실계정 검증 후. 여기선 조회·판정까지.
// ⚠ 카드영수증은 런처→새 탭→eusr_9001 iframe 구조라 라이브 검증 필요.
import { openTab, closeTab, evaluate, evaluateAllFrames, clickOpensTab, findFrame, listFrames, evaluateFrame } from './tab.js';
import { getOvertime } from './overtime.js';
import { isNight, isYasikMeal, yasikClass } from '../core/expense.js';
import { yagunDateOf } from '../core/calendar.js';

const HOST = 'https://www.bizplay.co.kr';
// 카드영수증 앱은 비즈플레이가 아니라 앱 플랫폼(appplay.co.kr)의 회사별 하위 도메인에서 돈다.
// 예: https://webank.appplay.co.kr/eusr_9001_01.act — 그래서 매니페스트에 둘 다 들어 있다.
const APP_TAB_PATTERNS = ['https://www.bizplay.co.kr/*', 'https://*.appplay.co.kr/*'];
// 진단에 찍어서 "확장을 새로고침했는지"를 바로 가린다. 수집 로직을 고칠 때 같이 올린다.
const BUILD = '2026-08-05q';
const STEP = '카드영수증 앱 여는 중';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const won = (s) => parseInt(String(s).replace(/[^0-9-]/g, ''), 10) || 0;
const fmt = (m) => `${Math.floor(m / 60)}시간 ${String(Math.round(m % 60)).padStart(2, '0')}분`;
// 완료 행 컬럼: td[2]종류 td[3]일시 td[4]사용처 td[7]금액
const toItem = (td) => ({ type: td[2], date: td[3], merchant: td[4], amount: won(td[7]),
  key: `${td[3]}|${td[4]}|${td[7]}` });

// 프레임 하나에서 '카드영수증' 타일을 찾는다. 글자로만 찾으면 아이콘이 이미지이거나
// 라벨이 alt/title에만 있는 화면에서 놓친다. 진단에 쓰려고 요소 설명도 같이 돌려준다.
// ⚠ 직렬화돼 페이지로 건너간다 — 바깥 변수를 못 데려간다.
function findCardReceipt() {
  const rx = /카드\s*영수증|카드영수증/;
  const desc = (el) => {
    const cls = typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\s+/).slice(0, 4).join('.') : '';
    const r = el.getBoundingClientRect();
    // 속성을 전부 적는다. 앱 주소가 data-* 같은 데 들어 있으면 클릭 없이 그걸로 열 수 있다.
    const attrs = [...(el.attributes || [])]
      .filter((a) => a.name !== 'class' && a.name !== 'style')
      .map((a) => ` ${a.name}=${String(a.value).slice(0, 60)}`).join('');
    return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls} [${Math.round(r.width)}x${Math.round(r.height)}]`
      + `${el.offsetParent ? '' : ' (숨김)'}${attrs}`;
  };
  const hit = (el) => {
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    const a = ['alt', 'title', 'aria-label', 'onclick'].map((k) => el.getAttribute?.(k) || '').join(' ');
    return (t.length < 60 && rx.test(t)) || rx.test(a);
  };
  const found = [...document.querySelectorAll('*')].filter(hit);
  found.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
  // 아무것도 못 찾았을 때 "이 프레임에 뭐가 있긴 한가"를 가늠할 단서
  const sample = [...document.querySelectorAll('a,button,li,[onclick]')]
    .filter((el) => el.offsetParent !== null)
    .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
    .filter((t) => t && t.length < 24).slice(0, 15);
  // 가장 바깥 타일의 HTML 원문 — 앱 id·핸들러 단서가 여기 다 있다.
  const tile = found.map((el) => el.closest('a,li,[onclick]')).find(Boolean);
  const html = tile ? tile.outerHTML.replace(/\s+/g, ' ').slice(0, 400) : '';
  return { url: location.href, count: found.length, items: found.slice(0, 6).map(desc), sample, html };
}

// 타일에 주소가 없을 때(href·onclick·data-url 전부 없음) 앱 주소는 페이지 JS가 만든다.
// 그래서 스크립트 원문에서 .act 주소를 긁어 후보를 뽑는다. 인라인 스크립트와
// 같은 출처 외부 스크립트를 함께 본다.
// ⚠ 직렬화돼 페이지로 건너간다 — 바깥 변수를 못 데려간다.
async function scrapeActUrls() {
  const texts = [];
  for (const s of document.querySelectorAll('script')) {
    if (s.src) {
      try {
        const u = new URL(s.src, location.href);
        if (u.origin === location.origin) texts.push(await (await fetch(u.href, { credentials: 'include' })).text());
      } catch { /* 못 읽는 스크립트는 넘어간다 */ }
    } else if (s.textContent) texts.push(s.textContent);
  }
  texts.push(document.documentElement.innerHTML);

  const found = new Set();
  for (const t of texts) {
    for (const m of t.matchAll(/['"`]([^'"`\s<>]*\.act(?:\?[^'"`\s<>]*)?)['"`]/g)) found.add(m[1]);
    for (const m of t.matchAll(/['"`]([^'"`\s<>]*eusr[^'"`\s<>]*)['"`]/g)) found.add(m[1]);
  }
  // 카드영수증일 법한 것부터. 9001·eusr·card·rcpt가 들어가면 가산점.
  const score = (u) => (/eusr[_-]?9001/i.test(u) ? 6 : 0) + (/eusr/i.test(u) ? 3 : 0)
    + (/card|rcpt|receipt|영수증/i.test(u) ? 2 : 0) + (/sme/i.test(u) ? 1 : 0);
  return [...found]
    .filter((u) => !/main_0003|bizpr_main|login/i.test(u))
    .map((u) => { try { return new URL(u, location.href).href; } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => score(b) - score(a))
    .slice(0, 12);
}

// 카드영수증 앱 주소 기억.
// 이 타일은 확장이 절대 못 누른다 — 핸들러가 신뢰 제스처(isTrusted)를 요구하는데
// 확장의 합성 이벤트로는 만들 수 없다(데스크톱판은 Playwright라 진짜 클릭이 나갔다).
// 주소도 정적 스크립트에 없어서 긁어낼 수 없다. 그래서 로그인과 같은 방식으로 간다:
// 사람이 한 번만 직접 열고, 그때 주소를 붙잡아 다음부터는 바로 연다.
const APP_URL_KEY = 'bizplayCardAppUrl';
export const getCardAppUrl = async () => (await chrome.storage.local.get(APP_URL_KEY))[APP_URL_KEY] || '';
export const setCardAppUrl = (url) => chrome.storage.local.set({ [APP_URL_KEY]: url || '' });

// 주소를 붙잡는 감시는 패널(page/app.js)에서 돈다 — 서비스 워커는 몇 분짜리 폴링 도중
// 크롬에 종료되어 응답이 영영 안 온다. 여기서는 저장된 주소를 읽고 쓰기만 한다.

// 실물 화면은 표에 id가 없을 수도 있다. 그래서 내용으로 판별한다 —
// '결의상태 … 대기(91)' 같은 글자, 또는 날짜와 금액이 든 8칸 이상짜리 표.
function looksLikeReceiptList() {
  const t = document.body ? document.body.innerText || '' : '';
  if (/대기\s*\(\d+\)/.test(t) || /결의상태/.test(t)) return true;
  return [...document.querySelectorAll('table tr')].some((tr) => {
    const tds = tr.querySelectorAll('td');
    return tds.length >= 8 && /\d{4}-\d{2}-\d{2}/.test(tr.innerText || '');
  });
}
const hasPendingTable = (tabId, frameId) =>
  evaluate(tabId, looksLikeReceiptList, undefined, { frameId }).catch(() => false);

// 카드영수증 앱은 회사별로 프레임 URL·이름이 다르고, 최상위 로드 완료 뒤에도
// 내부 앱을 몇 초 늦게 붙이는 경우가 있다. eusr_9001이라는 이름만 기다리면
// 주소는 맞는데도 "미결의 목록 아님"으로 너무 일찍 닫아 버린다.
// 모든 프레임을 내용으로 반복 검사해 실제 목록이 나타난 프레임을 돌려준다.
async function receiptFrameOnce(tabId) {
  const hits = await evaluateAllFrames(tabId, () => {
    const text = document.body?.innerText || '';
    const datedRows = [...document.querySelectorAll('table tr')].filter((tr) =>
      tr.querySelectorAll('td').length >= 8 && /\d{4}-\d{2}-\d{2}/.test(tr.innerText || '')).length;
    const score = (/대기\s*\(\d+\)/.test(text) ? 4 : 0)
      + (/결의상태/.test(text) ? 3 : 0)
      + (document.querySelector('#tableList') ? 2 : 0)
      + (document.querySelector('#paging_size') ? 1 : 0)
      + (datedRows ? 4 : 0);
    return { url: location.href, score, datedRows };
  }).catch(() => []);
  const best = hits.filter((h) => h.result?.score > 0)
    .sort((a, b) => b.result.score - a.result.score)[0];
  return best ? { frameId: best.frameId, frameCount: hits.length, url: best.result.url } : null;
}

async function waitForReceiptFrame(tabId, onProgress = () => {}, label = '카드영수증 화면 로딩',
  { tries = 20, gap = 600 } = {}) {
  for (let i = 0; i < tries; i++) {
    if (i === 0 || i % 5 === 4) onProgress(STEP, { try: `${label} (${i + 1}/${tries})` });
    const best = await receiptFrameOnce(tabId);
    if (best) {
      onProgress(STEP, { try: label, result: `목록 찾음 · 프레임 ${best.frameCount}개 검사` });
      return best.frameId;
    }
    await sleep(gap);
  }
  return null;
}

// 사용자가 이미 정상 카드영수증 화면을 열어 둔 경우 그 탭의 앱 초기화 문맥을 그대로 쓴다.
// rcard_main.act를 새 탭에 GET으로 다시 열면 주소는 같아도 목록이 안 뜨는 회사 설정이 있다.
// 사용자 탭이므로 수집이 끝나도 닫지 않는다.
async function findOpenReceiptTab(excludeTabId) {
  const tabs = await chrome.tabs.query({ url: APP_TAB_PATTERNS }).catch(() => []);
  // 눈앞의 활성 탭부터. 실패 시도가 만든 빈 카드영수증 탭보다 사람이 연 정상 탭을 먼저 잡는다.
  tabs.sort((a, b) => Number(b.active) - Number(a.active));
  for (const tab of tabs) {
    if (tab.id == null || tab.id === excludeTabId || !tab.url
      || /main_0003|bizpr_main/.test(tab.url)) continue;
    const found = await receiptFrameOnce(tab.id);
    if (found) return { tabId: tab.id, frameId: found.frameId, url: tab.url };
  }
  return null;
}

// 런처 → 카드영수증 앱(새 탭 또는 같은 페이지 iframe) → 데이터 프레임.
// 대상월로 날짜범위까지 세팅한 frame 참조 반환.
export async function openCardApp(month, onProgress) {
  onProgress('비즈플레이 여는 중');
  const launcher = await openTab(`${HOST}/main_0003_01.act`);
  await sleep(1000);
  // 로그인/세션 확인 — 비밀번호칸 or "세션 종료" 안내 문구
  const loginScreen = await evaluate(launcher, () =>
    /login/i.test(location.href)
    || !!document.querySelector('#PWD, input[type="password"]')
    || /세션이?\s*종료|로그인\s*후\s*이용/.test((document.body.innerText || '')));
  if (loginScreen) {
    await closeTab(launcher);
    const e = new Error('비즈플레이에 로그인되어 있지 않습니다. 로그인한 뒤 다시 실행해주세요.');
    e.needsLogin = { service: '비즈플레이', loginUrl: `${HOST}/login_0001_01.act` };
    throw e;
  }

  onProgress('카드영수증 앱 여는 중');
  // 최우선: 이미 열려 있고 실제 목록까지 보이는 탭. 주소만 재사용하는 것보다 확실하다.
  const opened = await findOpenReceiptTab(launcher);
  if (opened) {
    await closeTab(launcher);
    await setCardAppUrl(opened.url);
    onProgress(STEP, { try: '열려 있는 카드영수증 탭 사용', result: '미결의 목록 찾음' });
    onProgress(STEP, { '앱 주소': opened.url, '연 방법': '이미 열려 있는 탭', '데이터 프레임': opened.frameId });
    return finishCardApp(opened.tabId, opened.frameId, month, false);
  }
  // 0순위: 지난번에 사람이 열어 준 주소. 아직 유효하면 클릭을 아예 건너뛴다.
  const saved = await getCardAppUrl();
  if (saved) {
    onProgress(STEP, { try: `기억해 둔 주소로 열기: ${saved.replace(/^https?:\/\//, '').slice(0, 50)}` });
    const t = await openTab(saved).catch(() => null);
    if (t != null) {
      const fid = await waitForReceiptFrame(t, onProgress, '기억한 주소의 목록 기다리는 중');
      if (fid != null) {
        await closeTab(launcher);
        onProgress('카드영수증 앱 여는 중', { '앱 주소': saved, '연 방법': '기억해 둔 주소', '데이터 프레임': fid });
        return finishCardApp(t, fid, month, true);
      }
      onProgress(STEP, { try: '기억해 둔 주소', result: '12초 기다렸지만 목록을 못 찾음' });
      await closeTab(t);
    }
  }
  await sleep(1200);
  // 핵심: 앱은 window.open으로 새 창을 여는데, 확장의 자동 클릭은 신뢰 제스처가 아니라 팝업 차단됨.
  // → window.open을 가로채 URL만 뽑고, 그 URL을 확장이 직접 chrome.tabs.create로 연다(팝업 차단 없음).
  //   사용자가 팝업 허용 등 아무 조작도 할 필요 없음.
  const beforeUrl = await evaluate(launcher, () => location.href);
  const framesBefore = (await listFrames(launcher)).map((f) => `${f.frameId}|${f.url}`);
  // 아이콘이 어느 프레임에 있는지부터 찾는다. 포털이라 앱 목록이 iframe 안에 있을 수 있고,
  // 늦게 그려지기도 해서 몇 번 다시 본다.
  let iconFrame = null;
  for (let i = 0; i < 6 && iconFrame == null; i++) {
    onProgress(STEP, { try: `'카드영수증' 아이콘 찾는 중 (${i + 1}/6)` });
    const hits = await evaluateAllFrames(launcher, findCardReceipt);
    const hit = hits.find((h) => h.result?.count > 0);
    if (hit) {
      iconFrame = hit.frameId;
      onProgress(STEP, { try: `아이콘 찾기 (프레임 ${hits.length}개)`, result: `${hit.result.count}개 일치` });
      break;
    }
    await sleep(1000);
  }
  if (iconFrame == null) onProgress(STEP, { try: '아이콘 찾기', result: '못 찾음' });

  // ⚠ 반드시 메인 월드에서. 기본 격리 월드에서 window.open을 덮어써 봐야 페이지의
  //    onclick이 부르는 건 페이지 쪽 window.open이라 가로채지지 않는다.
  const openedUrl = iconFrame == null ? null : await evaluate(launcher, () => new Promise((resolve) => {
    const orig = window.open;
    let done = false;
    const finish = (u) => { if (done) return; done = true; window.open = orig; resolve(u || null); };
    window.open = function (u) { finish(u ? new URL(u, location.href).href : null); return { closed: false, focus() {}, close() {} }; };
    // 글자·alt·title·onclick 어디에 적혀 있든 '카드영수증' 타일을 찾는다.
    const rx = /카드\s*영수증|카드영수증/;
    const hit = (el) => {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const a = ['alt', 'title', 'aria-label', 'onclick'].map((k) => el.getAttribute?.(k) || '').join(' ');
      return (t.length < 60 && rx.test(t)) || rx.test(a);
    };
    const cand = [...document.querySelectorAll('*')]
      .filter((el) => hit(el) && el.offsetParent !== null && el.getBoundingClientRect().width > 0);
    // 글자를 직접 감싼 가장 안쪽 요소부터, 실제로 눌리는 조상(a/button/onclick)까지 올라가며 시도
    cand.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
    const box = cand[0];
    if (!box) return;
    const target = box.closest('a,button,[onclick],li') || box;

    // href가 진짜 주소면 클릭할 것도 없이 그게 앱 주소다.
    const href = target.getAttribute?.('href') || '';
    if (href && !/^#|^javascript:/i.test(href)) return finish(new URL(href, location.href).href);

    // 화면 밖이면 좌표가 엉뚱한 요소를 가리킨다 — 먼저 보이는 자리로 끌어온다.
    target.scrollIntoView({ block: 'center', inline: 'center' });
    const r = target.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    // 리스너가 타일(a)에 걸렸는지 안쪽 아이콘(img)에 걸렸는지 알 수 없다 — 둘 다 두드린다.
    // click()만으로는 안 먹는 경우가 있어(mousedown·pointerup에 걸어 둔 경우) 전체 시퀀스를 흘려보낸다.
    const targets = [...new Set([at && target.contains(at) ? at : null, box, target].filter(Boolean))];
    for (const el of targets) {
      for (const type of ['pointerover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      if (typeof el.click === 'function') el.click();
    }
    setTimeout(() => finish(null), 3000); // window.open 안 쓰면 null (아래에서 같은탭 이동/새탭 폴백)
  }), undefined, { world: 'MAIN', frameId: iconFrame });

  onProgress(STEP, { try: '타일 클릭(포인터 이벤트 전체)', result: openedUrl ? `window.open 가로챔: ${openedUrl.slice(0, 50)}` : '아무 주소도 안 나옴' });

  let appTabId = null;
  let inlineFrame = null;   // 앱이 런처 페이지 안 iframe에 뜬 경우 그 프레임
  if (openedUrl) {
    // 가로챈 URL을 확장이 직접 연다 (팝업 차단 회피)
    appTabId = await openTab(openedUrl);
  } else {
    // 폴백0: 앱이 같은 페이지의 iframe에 뜨는 구조. 새 탭도 window.open도 아니라
    // 주소만 봐서는 아무 일도 안 일어난 것처럼 보인다. 프레임이 새로 채워졌는지로 가린다.
    for (let i = 0; i < 12 && inlineFrame == null; i++) {
      if (i % 4 === 0) onProgress(STEP, { try: `같은 페이지에 앱 프레임이 뜨는지 (${i + 1}/12)` });
      await sleep(800);
      const now = await listFrames(launcher);
      const fresh = now.find((f) => f.url && !/^about:/.test(f.url)
        && !framesBefore.includes(`${f.frameId}|${f.url}`) && f.frameId !== 0);
      if (fresh) inlineFrame = fresh;
    }
    onProgress(STEP, { try: '같은 페이지 iframe', result: inlineFrame ? inlineFrame.url.slice(0, 50) : '안 뜸' });
    if (inlineFrame) appTabId = launcher;

    // 폴백1: 클릭이 같은 탭을 앱으로 이동시켰는지
    if (appTabId == null) {
      await sleep(1200);
      const nowUrl = await evaluate(launcher, () => location.href).catch(() => beforeUrl);
      if (nowUrl && nowUrl !== beforeUrl && !/main_0003/.test(nowUrl)) appTabId = launcher;
    }
    // 폴백2: 팝업이 실제로 떴다면 그 탭을 잡는다. onCreated로 기다렸다가 로드 완료된 id를 받는다.
    if (appTabId == null && iconFrame != null) {
      appTabId = await clickOpensTab(launcher, () => {
        const rx = /카드\s*영수증|카드영수증/;
        const cand = [...document.querySelectorAll('*')].filter((el) => {
          const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
          const a = ['alt', 'title', 'aria-label', 'onclick'].map((k) => el.getAttribute?.(k) || '').join(' ');
          return ((t.length < 60 && rx.test(t)) || rx.test(a)) && el.offsetParent !== null;
        }).sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
        const box = cand[0];
        if (box) {
          const target = box.closest('a,button,[onclick],li') || box;
          const r = target.getBoundingClientRect();
          (document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) || target).click();
        }
      }, undefined, { frameId: iconFrame });
    }
  }
  // 폴백3: 타일에 주소가 없고 클릭도 아무 일을 안 하면, 페이지 스크립트에서 앱 주소를 찾아 직접 연다.
  let actTried = [];
  if (appTabId == null) {
    // 스크립트도 아이콘과 같은 프레임(포털 iframe) 안에 있다 — 모든 프레임에서 긁어 합친다.
    onProgress(STEP, { try: '페이지 스크립트에서 앱 주소 찾는 중' });
    const perFrame = await evaluateAllFrames(launcher, scrapeActUrls).catch(() => []);
    actTried = [...new Set(perFrame.flatMap((f) => f.result || []))];
    onProgress(STEP, { try: '스크립트에서 주소 긁기', result: `후보 ${actTried.length}개` });
    for (const url of actTried.slice(0, 6)) {
      onProgress(STEP, { try: `후보 열어보기: ${url.replace(/^https?:\/\//, '').slice(0, 45)}` });
      const t = await openTab(url).catch(() => null);
      if (t == null) continue;
      const fid = await waitForReceiptFrame(t, onProgress, '후보 주소의 목록 기다리는 중', { tries: 12, gap: 600 });
      if (fid != null) { appTabId = t; inlineFrame = { frameId: fid, url }; break; }
      onProgress(STEP, { try: '후보 확인', result: '미결의 목록 아님' });
      await closeTab(t);
    }
  }

  if (appTabId == null) {
    // 아이콘을 못 찾은 건지, 찾았는데 클릭이 주소를 안 만든 건지 구분이 안 되면 고칠 수가 없다.
    // 화면에서 '카드영수증'이 들어간 요소를 훑어 에러에 같이 담는다.
    const frames = await evaluateAllFrames(launcher, findCardReceipt).catch(() => []);

    await closeTab(launcher);
    const e = new Error(`카드영수증 앱이 안 열렸어요 (${BUILD})`);
    const lines = [
      `[Webwing ${BUILD}]`,
      iconFrame == null
        ? `'카드영수증' 앱 아이콘을 화면에서 찾지 못했어요.`
        : `'카드영수증' 아이콘을 눌렀지만 앱 주소를 잡지 못했어요.`,
      `현재 화면: ${beforeUrl}`,
      '로그인이 풀리지 않았는지, 카드영수증 앱이 화면에 보이는지 확인해주세요.',
      '',
      '아래는 개발자에게 그대로 전달해주시면 고칠 수 있는 정보예요.',
      `아이콘 찾음: ${iconFrame == null ? '아니오' : '예'} · 클릭 후 새 프레임: ${inlineFrame ? inlineFrame.url.slice(0, 60) : '없음'}`,
      actTried.length
        ? `스크립트에서 찾은 주소 후보 ${actTried.length}개 (앞 6개를 열어 봤지만 미결의 목록이 없었어요):`
        : '스크립트에서 .act 주소를 찾지 못했어요.',
      ...actTried.slice(0, 8).map((u) => `  ${u.slice(0, 100)}`),
      `프레임 ${frames.length}개를 훑었습니다.`,
    ];
    for (const f of frames) {
      const r = f.result;
      if (!r) { lines.push(`  · (프레임 ${f.frameId}: 읽지 못함)`); continue; }
      lines.push(`  · ${r.url.slice(0, 90)}  — 일치 ${r.count}개`);
      for (const x of r.items || []) lines.push(`      ${x}`);
      if (r.html) lines.push('      타일 원문:', `        ${r.html}`);
      if (!r.count && r.sample?.length) lines.push(`      이 화면에 보이는 것: ${r.sample.join(' / ')}`);
    }
    lines.push('',
      '이 화면의 앱 타일은 확장이 눌러도 반응하지 않습니다(브라우저가 만든 진짜 클릭만 받습니다).',
      '아래 버튼으로 한 번만 직접 열어 주시면 주소를 기억해 다음부터는 바로 조회합니다.');
    e.detail = lines.join('\n');
    e.needsAppUrl = { service: '비즈플레이', app: '카드영수증' };
    throw e;
  }
  if (appTabId !== launcher) await closeTab(launcher); // 앱을 새 탭으로 열었으면 런처는 닫음

  // 데이터 프레임 찾기. eusr_9001이 1순위지만 프레임 이름은 바뀔 수 있으므로,
  // 못 찾으면 '대기(n)' 탭과 #tableList가 실제로 있는 프레임을 내용으로 가려낸다.
  let frameId = inlineFrame ? inlineFrame.frameId : null;
  if (frameId == null || !(await hasPendingTable(appTabId, frameId))) {
    frameId = await findFrame(appTabId, 'eusr_9001', { tries: 8 });
  }
  if (frameId == null || !(await hasPendingTable(appTabId, frameId))) {
    frameId = await waitForReceiptFrame(appTabId, onProgress, '앱 안의 미결의 목록 기다리는 중');
  }
  if (frameId == null) {
    const frames = await listFrames(appTabId);
    await closeTab(appTabId);
    const e = new Error('카드영수증 데이터 화면을 못 찾았어요');
    e.detail = ['카드영수증 앱은 열렸는데 미결의 목록이 있는 화면을 못 찾았어요.',
      '앱이 완전히 로드되기 전이거나 화면 구조가 바뀌었을 수 있어요.',
      '', '아래는 개발자에게 그대로 전달해주세요.', `프레임 ${frames.length}개:`,
      ...frames.map((f) => `  ${f.url.slice(0, 100)}`)].join('\n');
    throw e;
  }
  const appUrl = await evaluate(appTabId, () => location.href).catch(() => '');
  onProgress('카드영수증 앱 여는 중', {
    런처: beforeUrl,
    '앱 주소': appUrl || '(못 읽음)',
    '연 방법': openedUrl ? 'window.open 가로채기'
      : inlineFrame ? '같은 페이지 iframe'
      : appTabId === launcher ? '같은 탭 이동' : '새 탭',
  });
  // 다음부터는 클릭 없이 바로 열 수 있게 기억해 둔다.
  if (appUrl && !/main_0003|bizpr_main/.test(appUrl)) await setCardAppUrl(appUrl);
  return finishCardApp(appTabId, frameId, month, true);
}

// 데이터 프레임에 대상월 날짜 범위를 넣고 참조를 돌려준다. 어느 경로로 열었든 여기로 모인다.
async function finishCardApp(appTab, frameId, month, shouldClose) {
  await sleep(1500);
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const p2 = (n) => String(n).padStart(2, '0');
  await evaluateFrame(appTab, frameId ?? 0, (r) => {
    const set = (id, v) => { const el = document.getElementById(id); if (el) { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); } };
    ['START_DT', 'SHOW_START_DT', 'BASE_START_DT'].forEach((id) => set(id, r.s));
    ['END_DT', 'SHOW_END_DT', 'BASE_END_DT'].forEach((id) => set(id, r.e));
  }, { s: `${y}-${p2(m)}-01`, e: `${y}-${p2(m)}-${p2(last)}` }).catch(() => {});
  return { appTab, frameId: frameId ?? 0, shouldClose };
}

// '대기(n)' 탭 클릭 + 페이지 크기 키우기 + 행 스크래핑
async function loadPendingRows(appTab, frameId) {
  // 대기 탭
  await evaluateFrame(appTab, frameId, () => {
    const el = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && /^대기\s*\(\d+\)/.test((e.textContent || '').trim()));
    el?.click();
  });
  await sleep(2000);
  // 페이지 크기 200 (30행 넘을 때까지 재시도)
  for (let i = 0; i < 5; i++) {
    const n = await evaluateFrame(appTab, frameId, () =>
      [...document.querySelectorAll('tr')].filter((tr) => tr.querySelectorAll('td').length >= 8
        && /\d{4}-\d{2}-\d{2}/.test(tr.innerText || '')).length);
    if (n > 30) break;
    await evaluateFrame(appTab, frameId, () => { document.querySelector('#paging_size .btn_combo_down')?.click(); });
    await sleep(400);
    await evaluateFrame(appTab, frameId, () => {
      const o = [...document.querySelectorAll('#paging_size ul li a')].find((a) => a.textContent.trim() === '200')
        || [...document.querySelectorAll('#paging_size ul li a')].find((a) => a.textContent.trim() === '100');
      o?.click();
    });
    await sleep(2500);
  }
  // 행 스크래핑 — #tableList가 없는 화면도 있어서 문서 전체의 tr에서 조건으로 고른다.
  // 컬럼: td[2]종류 td[3]사용일시 td[4]사용처 td[7]사용금액 (실물 화면에서 확인)
  return evaluateFrame(appTab, frameId, () =>
    [...document.querySelectorAll('tr')]
      .map((tr) => [...tr.querySelectorAll('td')].map((td) => td.innerText.trim().replace(/\s+/g, ' ')))
      .filter((td) => td.length >= 8 && /\d{4}-\d{2}-\d{2}/.test(td.join(' '))));
}

// 서비스 워커의 OffscreenCanvas로 야근택시 증빙 PNG를 만든다.
// 파일 경로를 가질 수 없는 확장 환경이므로 base64 File로 업로드 팝업에 주입한다.
async function renderTaxiEvidenceFile(items, month) {
  if (typeof OffscreenCanvas === 'undefined') throw new Error('이 브라우저에서 증빙 이미지 생성을 지원하지 않아요');
  const rows = [...items].sort((a, b) => String(a.yagunDate).localeCompare(String(b.yagunDate)));
  const w = 1080, rowH = 46, h = 150 + Math.max(1, rows.length) * rowH + 60;
  const canvas = new OffscreenCanvas(w, h), c = canvas.getContext('2d');
  c.fillStyle = '#fff'; c.fillRect(0, 0, w, h);
  // 출처를 글자만이 아니라 실제 타임인아웃 로고로도 식별한다.
  const logo = await fetch(chrome.runtime.getURL('icons/svc-timeinout.png'))
    .then((r) => r.blob()).then((b) => createImageBitmap(b)).catch(() => null);
  if (logo) c.drawImage(logo, 34, 22, 42, 42);
  c.fillStyle = '#1f2a44'; c.font = '700 28px sans-serif'; c.fillText('야근·휴일근무 택시비 증빙', 88, 48);
  c.fillStyle = '#6b7488'; c.font = '16px sans-serif'; c.fillText(`${month} · 타임인아웃 실제 출퇴근 기록 기준`, 88, 79);
  const cols = [36, 170, 300, 410, 525, 690, 890];
  const heads = ['근무일', '구분', '출근', '퇴근', '초과근무', '택시사용', '금액'];
  c.fillStyle = '#eef2fb'; c.fillRect(28, 96, w - 56, 40);
  c.fillStyle = '#42506b'; c.font = '700 16px sans-serif'; heads.forEach((x, i) => c.fillText(x, cols[i], 122));
  c.font = '16px sans-serif';
  rows.forEach((r, i) => {
    const y = 136 + i * rowH;
    c.fillStyle = i % 2 ? '#f8faff' : '#fff'; c.fillRect(28, y, w - 56, rowH);
    c.fillStyle = '#2b3448';
    const vals = [r.yagunDate || '', r.isHoliday ? '휴일근무' : '야근', r.yagunIn || '-', r.yagunOut || '-', r.otText || '-',
      String(r.date || '').replace(/^\d{4}-/, ''), `${Number(r.amount || 0).toLocaleString('en-US')}원`];
    vals.forEach((x, j) => c.fillText(String(x), cols[j], y + 29));
    c.strokeStyle = '#dce2ef'; c.beginPath(); c.moveTo(28, y + rowH); c.lineTo(w - 28, y + rowH); c.stroke();
  });
  const total = rows.reduce((s, r) => s + Number(r.amount || 0), 0);
  c.fillStyle = '#1f2a44'; c.font = '700 17px sans-serif';
  c.fillText(`합계 ${rows.length}건 · ${total.toLocaleString('en-US')}원`, 36, h - 30);
  c.fillStyle = '#8f98a8'; c.font = '13px sans-serif'; c.fillText('출처: 타임인아웃 근태 기록 · Webwing 자동 생성', 650, h - 30);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { name: `webwing-yagun-${month}.png`, type: 'image/png', base64: btoa(binary) };
}

const tabAlive = (tabId) => chrome.tabs.get(tabId).then(() => true).catch(() => false);
async function waitTabClosed(tabId, tries = 22) {
  for (let i = 0; i < tries; i++) { if (!(await tabAlive(tabId))) return true; await sleep(700); }
  return false;
}

// 구형 Bizplay 팝업은 window.open('', name) 뒤 form target=name으로 POST한다.
// 합성 클릭에서는 그 빈 창이 차단되므로, 캡처한 폼을 같은 appplay 출처의 새 탭에서
// _self로 다시 제출해 쿠키·hidden field를 그대로 살린다.
async function openCapturedFormTab(form) {
  if (!form?.action || !/^https:\/\/(?:[^/]+\.)?(?:appplay|bizplay)\.co\.kr\//i.test(form.action)) return null;
  let seed;
  try {
    const base = new URL(form.baseUrl || form.action);
    seed = base.href;
  } catch { return null; }
  const tabId = await openTab(seed).catch(() => null);
  if (tabId == null) return null;
  const submitted = await evaluate(tabId, (spec) => {
    const f = document.createElement('form');
    f.method = spec.method || 'POST'; f.action = spec.action; f.target = '_self';
    if (spec.enctype) f.enctype = spec.enctype;
    for (const [name, value] of spec.fields || []) {
      const input = document.createElement('input'); input.type = 'hidden'; input.name = name; input.value = value;
      f.appendChild(input);
    }
    document.documentElement.appendChild(f);
    HTMLFormElement.prototype.submit.call(f);
    return true;
  }, form, { world: 'MAIN' }).catch(() => false);
  if (!submitted) { await closeTab(tabId); return null; }
  await sleep(600);
  for (let i = 0; i < 50; i++) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || tab.status === 'complete') break;
    await sleep(250);
  }
  return tabId;
}

// 팝업 호출은 클릭한 하위 프레임이 아니라 parent/top의 유틸 함수에서 실행되기도 한다.
// 탭의 MAIN world 전체 프레임에 짧게 훅을 걸어 window.open과 form POST를 모두 포착한다.
async function installPopupCapture(tabId) {
  return chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: 'MAIN', func: () => {
    window.__webwingPopupCapture?.restore?.();
    const state = { urls: [], forms: [], formRefs: [], blanks: 0, frameUrl: location.href };
    const origOpen = window.open;
    const origSubmit = HTMLFormElement.prototype.submit;
    const origRequestSubmit = HTMLFormElement.prototype.requestSubmit;
    const snapshotForm = (form, submitter) => {
      const data = new FormData(form);
      if (submitter?.name) data.append(submitter.name, submitter.value || '');
      return { action: new URL(form.action || location.href, location.href).href, target: form.target || '',
        method: (form.method || 'POST').toUpperCase(), enctype: form.enctype || '', baseUrl: location.href,
        fields: [...data.entries()].filter(([, v]) => typeof v === 'string') };
    };
    const captureForm = (form, submitter) => { try {
      const refIndex = state.formRefs.push({ form, submitter }) - 1;
      state.forms.push({ ...snapshotForm(form, submitter), refIndex });
    } catch {} };
    const onSubmit = (event) => { event.preventDefault(); captureForm(event.target, event.submitter); };
    window.open = function (u) {
      let href = ''; try { href = u ? new URL(u, location.href).href : ''; } catch {}
      if (href) state.urls.push(href); else state.blanks++;
      const remember = (v) => { try { state.urls.push(new URL(v, location.href).href); } catch {} };
      const locationStub = {};
      Object.defineProperty(locationStub, 'href', { set: remember, get() { return state.urls.at(-1) || ''; } });
      const popup = { closed: false, focus() {}, close() {}, document: { open() {}, write() {}, close() {} } };
      Object.defineProperty(popup, 'location', { set: remember, get() { return locationStub; } });
      return popup;
    };
    HTMLFormElement.prototype.submit = function () { captureForm(this); };
    if (origRequestSubmit) HTMLFormElement.prototype.requestSubmit = function (submitter) { captureForm(this, submitter); };
    document.addEventListener('submit', onSubmit, true);
    state.restore = () => {
      window.open = origOpen; HTMLFormElement.prototype.submit = origSubmit;
      if (origRequestSubmit) HTMLFormElement.prototype.requestSubmit = origRequestSubmit;
      document.removeEventListener('submit', onSubmit, true);
    };
    state.replay = (refIndex, targetName) => {
      const ref = state.formRefs[refIndex]; if (!ref?.form) return false;
      const form = ref.form; form.target = targetName;
      if (ref.submitter?.name) {
        const hidden = document.createElement('input'); hidden.type = 'hidden';
        hidden.name = ref.submitter.name; hidden.value = ref.submitter.value || ''; form.appendChild(hidden);
      }
      state.restore();
      try { origOpen.call(window, '', targetName); } catch {}
      origSubmit.call(form); return true;
    };
    window.__webwingPopupCapture = state;
    return { url: location.href };
  } }).catch(() => []);
}

async function readPopupCapture(tabId) {
  const rows = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: 'MAIN', func: () => {
    const state = window.__webwingPopupCapture;
    if (!state) return null;
    return { frameUrl: state.frameUrl, urls: [...state.urls], forms: [...state.forms], blanks: state.blanks };
  } }).catch(() => []);
  return (rows || []).map((x) => ({ frameId: x.frameId, result: x.result })).filter((x) => x.result);
}

async function restorePopupCapture(tabId) {
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: 'MAIN', func: () => {
    window.__webwingPopupCapture?.restore?.(); delete window.__webwingPopupCapture;
  } }).catch(() => []);
}

// 이름이 지정된 실제 탭을 먼저 만든 뒤 캡처 당시의 원본 form.submit을 다시 호출한다.
// 복제 폼과 달리 Bizplay가 폼 객체에 심어 둔 상태와 named-window/opener 관계가 보존된다.
async function replayCapturedFormToNamedTab(sourceTabId, sourceFrameId, form) {
  if (!form?.action || !/^https:\/\/(?:[^/]+\.)?(?:appplay|bizplay)\.co\.kr\//i.test(form.action)) return null;
  const targetName = form.target && !/^_(?:self|blank|parent|top)$/i.test(form.target)
    ? form.target : `webwing-upload-${Date.now()}`;
  const seed = form.baseUrl || new URL(form.action).origin;
  const targetTabId = await openTab(seed).catch(() => null);
  if (targetTabId == null) return null;
  const named = await evaluate(targetTabId, (name) => { window.name = name; return window.name === name; }, targetName,
    { world: 'MAIN' }).catch(() => false);
  if (!named) { await closeTab(targetTabId); return null; }
  let resolveCreated;
  const created = new Promise((resolve) => { resolveCreated = resolve; });
  const onCreated = (tab) => { chrome.tabs.onCreated.removeListener(onCreated); resolveCreated(tab.id); };
  chrome.tabs.onCreated.addListener(onCreated);
  const createdTimer = setTimeout(() => { chrome.tabs.onCreated.removeListener(onCreated); resolveCreated(null); }, 2600);
  const replayed = await evaluate(sourceTabId, ({ refIndex, name }) =>
    !!window.__webwingPopupCapture?.replay?.(refIndex, name), { refIndex: form.refIndex, name: targetName },
  { frameId: sourceFrameId, world: 'MAIN' }).catch(() => false);
  if (!replayed) {
    clearTimeout(createdTimer); chrome.tabs.onCreated.removeListener(onCreated);
    await closeTab(targetTabId); return null;
  }
  const createdId = await created;
  clearTimeout(createdTimer);
  let resultTabId = targetTabId;
  if (createdId != null && createdId !== targetTabId) {
    resultTabId = createdId; await closeTab(targetTabId);
  }
  await sleep(700);
  for (let i = 0; i < 50; i++) {
    const tab = await chrome.tabs.get(resultTabId).catch(() => null);
    if (!tab || tab.status === 'complete') break;
    await sleep(250);
  }
  return resultTabId;
}

async function openCapturedPopup(tabId, frameId, buttonText) {
  const beforeFrames = await listFrames(tabId);
  await installPopupCapture(tabId);
  let resolveCreated;
  const created = new Promise((resolve) => { resolveCreated = resolve; });
  const onCreated = (tab) => { chrome.tabs.onCreated.removeListener(onCreated); resolveCreated(tab.id); };
  chrome.tabs.onCreated.addListener(onCreated);
  const createdTimer = setTimeout(() => { chrome.tabs.onCreated.removeListener(onCreated); resolveCreated(null); }, 2300);
  const clicked = await evaluate(tabId, (label) => {
    const norm = (v) => String(v || '').replace(/\s+/g, '');
    const el = [...document.querySelectorAll('a,button,input[type=button],input[type=submit],[role=button],[onclick]')]
      .find((e) => norm(e.textContent || e.value).includes(norm(label)) && e.offsetParent !== null);
    if (!el) return { ok: false };
    const info = { ok: true, html: el.outerHTML.replace(/\s+/g, ' ').slice(0, 900),
      onclick: el.getAttribute('onclick') || '', href: el.getAttribute('href') || '', url: location.href };
    el.click(); return info;
  }, buttonText, { frameId, world: 'MAIN' }).catch((e) => ({ ok: false, error: e.message }));
  await sleep(1900);
  const captures = await readPopupCapture(tabId);
  const createdId = await created;
  clearTimeout(createdTimer);
  const forms = captures.flatMap((x) => (x.result.forms || []).map((form) => ({ frameId: x.frameId, form })));
  const urls = captures.flatMap((x) => x.result.urls || []);
  let opened = null, source = '없음';
  if (forms.length) {
    const hit = forms.at(-1);
    opened = await replayCapturedFormToNamedTab(tabId, hit.frameId, hit.form);
    source = opened == null ? '원본 POST 폼 재생 실패' : '원본 POST 폼 재생';
    if (opened == null) opened = await openCapturedFormTab(hit.form);
  }
  if (opened == null && urls.length) { opened = await openTab(urls.at(-1)).catch(() => null); source = '팝업 URL'; }
  if (opened == null && createdId != null) { opened = createdId; source = '실제 생성 탭'; }
  await restorePopupCapture(tabId);
  if (opened != null) {
    await chrome.tabs.update(opened, { active: false }).catch(() => {});
    for (let i = 0; i < 20; i++) {
      const tab = await chrome.tabs.get(opened).catch(() => null);
      if (!tab || tab.status === 'complete') break;
      await sleep(250);
    }
  }
  const afterFrames = await listFrames(tabId);
  return { tabId: opened, debug: { clicked, source,
    capture: captures.map((x) => `${x.frameId} · ${x.result.frameUrl} · 빈창 ${x.result.blanks} · URL ${x.result.urls.length} · 폼 ${(x.result.forms || []).map((f) => `${f.method} ${f.action} target=${f.target || '(없음)'} 필드${f.fields.length}`).join(', ') || '0'}`),
    newFrames: afterFrames.filter((x) => !beforeFrames.some((b) => b.frameId === x.frameId)).map((x) => `${x.frameId} · ${x.url}`) } };
}

async function findActionFrames(tabId, label) {
  return evaluateAllFrames(tabId, (want) => {
    const norm = (v) => String(v || '').replace(/\s+/g, '');
    const els = [...document.querySelectorAll('a,button,input[type=button],input[type=submit]')];
    const found = els.filter((e) => norm(e.textContent || e.value).includes(norm(want)) && e.offsetParent !== null);
    return { count: found.length, url: location.href,
      examples: found.slice(0, 3).map((e) => e.outerHTML.replace(/\s+/g, ' ').slice(0, 500)) };
  }, label).catch(() => []);
}

async function findFrameWithSelector(tabId, selector, tries = 10) {
  for (let i = 0; i < tries; i++) {
    const frames = await evaluateAllFrames(tabId, (sel) => ({ found: !!document.querySelector(sel), url: location.href }), selector).catch(() => []);
    const hit = frames.find((x) => x.result?.found);
    if (hit) return { frameId: hit.frameId, frames };
    await sleep(350);
  }
  return { frameId: null, frames: [] };
}

// 앱 껍데기에 상시 존재하는 BBFileElement는 파일 선택을 네이티브 드라이버로 넘기는
// 공용 브리지일 뿐 증빙 업로드 input이 아니다. 이걸 잡으면 파일 수만 1이 되고 요청은 0건이다.
const UPLOAD_FILE_SELECTOR = 'input[type=file]:not(#BBFileElement):not([onchange*="_WE_DRIVER.changeFileList"])';

// 버튼이 결의 모달의 어느 하위 프레임에 있든 찾아 클릭한다.
// 파일첨부는 팝업뿐 아니라 같은 탭에 업로드 iframe을 만드는 변형도 지원한다.
async function openUploadTarget(tabId, preferredFrame) {
  const scanned = await findActionFrames(tabId, '파일첨부');
  const attempts = [];
  const frames = scanned.filter((x) => x.result?.count > 0).map((x) => x.frameId);
  if (frames.includes(preferredFrame)) {
    frames.splice(frames.indexOf(preferredFrame), 1);
    frames.unshift(preferredFrame);
  }
  for (const frameId of frames) {
    const opened = await openCapturedPopup(tabId, frameId, '파일첨부');
    attempts.push(opened.debug);
    if (opened.tabId != null) {
      const popupInput = await findFrameWithSelector(opened.tabId, UPLOAD_FILE_SELECTOR, 14);
      if (popupInput.frameId != null) return { tabId: opened.tabId, frameId: popupInput.frameId, popup: true, actionFrame: frameId, scanned, attempts };
      await closeTab(opened.tabId);
    }
    const inline = await findFrameWithSelector(tabId, UPLOAD_FILE_SELECTOR, 4);
    if (inline.frameId != null) return { tabId, frameId: inline.frameId, popup: false, actionFrame: frameId, scanned, attempts };
  }
  return { tabId: null, frameId: null, popup: false, actionFrame: null, scanned, attempts };
}

// 실화면의 첨부 UI는 세 종류다: 성공 후 닫히는 팝업, 사라지는 iframe,
// 그대로 남아서 "완료"만 표시하는 iframe. 마지막 종류를 닫힘만 기다리면 이미
// 첨부됐는데도 실패로 오인한다. 네트워크 성공·완료 문구·결의서의 파일명을 함께 본다.
async function installUploadProbe(tabId, frameId) {
  return evaluate(tabId, () => {
    const old = window.__webwingUploadProbe;
    old?.restore?.();
    const state = { requests: 0, successes: 0, failures: 0, submitted: 0 };
    const origFetch = window.fetch;
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    const onSubmit = () => { state.submitted++; };
    window.fetch = function (...args) {
      state.requests++;
      return origFetch.apply(this, args).then((res) => {
        if (res.ok) state.successes++; else state.failures++;
        return res;
      }, (err) => { state.failures++; throw err; });
    };
    XMLHttpRequest.prototype.open = function (...args) {
      this.__webwingUploadRequest = true;
      return origOpen.apply(this, args);
    };
    XMLHttpRequest.prototype.send = function (...args) {
      if (this.__webwingUploadRequest) {
        state.requests++;
        this.addEventListener('loadend', () => {
          if (this.status >= 200 && this.status < 400) state.successes++;
          else state.failures++;
        }, { once: true });
      }
      return origSend.apply(this, args);
    };
    document.addEventListener('submit', onSubmit, true);
    state.restore = () => {
      window.fetch = origFetch;
      XMLHttpRequest.prototype.open = origOpen;
      XMLHttpRequest.prototype.send = origSend;
      document.removeEventListener('submit', onSubmit, true);
    };
    window.__webwingUploadProbe = state;
    return true;
  }, undefined, { frameId, world: 'MAIN' }).catch(() => false);
}

async function readUploadProbe(tabId, frameId) {
  return evaluate(tabId, () => {
    const p = window.__webwingUploadProbe || {};
    const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
    const actions = [...document.querySelectorAll('button,a,input[type=button],input[type=submit],input[type=image],[role=button],[onclick]')]
      .filter((e) => e.offsetParent !== null)
      .map((e) => (e.textContent || e.value || e.getAttribute('alt') || e.getAttribute('title') || '')
        .replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 12);
    const input = [...document.querySelectorAll('input[type=file]')]
      .find((e) => e.id !== 'BBFileElement' && !/_WE_DRIVER\.changeFileList/.test(e.getAttribute('onchange') || ''));
    return { requests: p.requests || 0, successes: p.successes || 0, failures: p.failures || 0,
      submitted: p.submitted || 0, text: text.slice(0, 220), actions, url: location.href,
      hasFile: !!input, fileCount: input?.files?.length || 0,
      fileInput: input?.outerHTML?.replace(/\s+/g, ' ').slice(0, 260) || '' };
  }, undefined, { frameId, world: 'MAIN' }).catch(() => null);
}

async function restoreUploadProbe(tabId, frameId) {
  await evaluate(tabId, () => {
    window.__webwingUploadProbe?.restore?.();
    delete window.__webwingUploadProbe;
  }, undefined, { frameId, world: 'MAIN' }).catch(() => {});
}

async function findAttachedFile(tabId, fileName, uploadFrame) {
  const base = String(fileName || '').replace(/\.[^.]+$/, '');
  const frames = await evaluateAllFrames(tabId, ({ name, stem }) => {
    const haystack = [document.body?.innerText || '', ...[...document.querySelectorAll('[title],[data-file-name],a[href]')]
      .map((e) => `${e.getAttribute('title') || ''} ${e.getAttribute('data-file-name') || ''} ${e.getAttribute('href') || ''}`)]
      .join(' ');
    return { found: haystack.includes(name) || (stem.length > 8 && haystack.includes(stem)), url: location.href };
  }, { name: fileName, stem: base }).catch(() => []);
  return frames.find((x) => x.frameId !== uploadFrame && x.result?.found) || null;
}

async function openPopupFromAnyFrame(tabId, preferredFrame, label) {
  const scanned = await findActionFrames(tabId, label);
  const attempts = [];
  const frames = scanned.filter((x) => x.result?.count > 0).map((x) => x.frameId);
  if (frames.includes(preferredFrame)) {
    frames.splice(frames.indexOf(preferredFrame), 1);
    frames.unshift(preferredFrame);
  }
  for (const frameId of frames) {
    const opened = await openCapturedPopup(tabId, frameId, label);
    attempts.push(opened.debug);
    if (opened.tabId != null) return { tabId: opened.tabId, actionFrame: frameId, scanned, attempts };
  }
  return { tabId: null, actionFrame: null, scanned, attempts };
}

async function installDialogCapture(tabId, frameId = 0) {
  await evaluate(tabId, () => {
    if (window.__webwingDialogRestore) return;
    const alert = window.alert, confirm = window.confirm;
    window.__webwingDialogs = [];
    window.alert = (m) => { window.__webwingDialogs.push(String(m || '')); };
    window.confirm = (m) => { window.__webwingDialogs.push(String(m || '')); return true; };
    window.__webwingDialogRestore = () => { window.alert = alert; window.confirm = confirm; delete window.__webwingDialogRestore; };
  }, undefined, { frameId, world: 'MAIN' }).catch(() => {});
}

// 결의 모달 자체(eapr_1001)와 용도 입력 폼이 서로 다른 하위 프레임인 실화면이 있다.
// URL 이름을 더 추측하지 않고 모든 프레임에서 TRAN_KIND_CD·목록보기 신호를 찾아 실제 폼을 고른다.
async function findPurposeFormFrame(tabId, tries = 18) {
  let last = [];
  for (let i = 0; i < tries; i++) {
    last = await evaluateAllFrames(tabId, () => {
      const signals = document.querySelectorAll(
        '.purpose_combo,[id^="TRAN_KIND_CD"],[name^="TRAN_KIND_CD"],a.bt_purpose_cbList').length;
      return { signals, url: location.href, title: document.title || '',
        text: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 90) };
    }).catch(() => []);
    const hit = last.filter((x) => x.result?.signals > 0)
      .sort((a, b) => b.result.signals - a.result.signals)[0];
    if (hit) return { frameId: hit.frameId, signals: hit.result.signals, frames: last };
    await sleep(450);
  }
  return { frameId: null, signals: 0, frames: last };
}

// 조회 결과에서 사용자가 두 번 확인한 뒤 호출되는 실제 결의 상신.
// kind=yagun은 증빙 PNG 필수, yasik은 인정 건만 용도 바인딩 후 한 결재로 묶는다.
export async function submitExpenseApproval(kind, month, items = [], proofFile = null, onProgress = () => {}) {
  if (!['yagun', 'yasik'].includes(kind)) throw new Error('알 수 없는 경비 종류예요');
  const useName = kind === 'yagun' ? '야근교통비' : '야근식비';
  const targets = items.filter((x) => x?.key && x.amount > 0);
  if (!targets.length) throw new Error('결재 올릴 인정 건이 없어요');
  onProgress('상신 대상 다시 확인', { try: `${useName} ${targets.length}건` });
  const { appTab, frameId, shouldClose } = await openCardApp(month, onProgress);
  let modalFrame = null, uploadTab = null, approvalTab = null;
  try {
    await loadPendingRows(appTab, frameId);
    await installDialogCapture(appTab, frameId);
    const keys = targets.map((x) => x.key);
    const hit = await evaluateFrame(appTab, frameId, (wanted) => {
      const set = new Set(wanted); let n = 0;
      for (const tr of document.querySelectorAll('tr')) {
        const tds = [...tr.querySelectorAll('td')];
        const cb = tr.querySelector('input[type=checkbox]'); if (!cb || tds.length < 8) continue;
        const key = `${tds[3].innerText.trim()}|${tds[4].innerText.trim()}|${tds[7].innerText.trim()}`;
        const yes = set.has(key); if (cb.checked !== yes) cb.click(); if (yes) n++;
      }
      return n;
    }, keys);
    onProgress('상신 대상 다시 확인', { try: '미결의 행 체크', result: `${hit}/${targets.length}건` });
    if (hit !== targets.length) throw new Error(`미결의 행이 바뀌었어요 (${hit}/${targets.length}건만 찾음). 다시 조회해주세요.`);

    onProgress('결의서 작성', { try: `${hit}건을 결재 1건으로 묶기` });
    const clicked = await evaluate(appTab, () => {
      const el = [...document.querySelectorAll('a,button')].find((e) => /결의서\s*작성/.test((e.textContent || '').trim()) && e.offsetParent !== null);
      if (!el) return false; el.click(); return true;
    }, undefined, { frameId, world: 'MAIN' });
    if (!clicked) throw new Error('결의서 작성 버튼을 못 찾았어요');
    modalFrame = await findFrame(appTab, 'eapr_1001', { tries: 18, gap: 500 });
    if (modalFrame == null) throw new Error('결의서 작성 화면이 열리지 않았어요');
    await installDialogCapture(appTab, modalFrame);

    onProgress('용도 입력', { try: `모든 항목에 '${useName}' 선택` });
    const purposeForm = await findPurposeFormFrame(appTab);
    if (purposeForm.frameId == null) {
      onProgress('용도 입력', {
        try: '결의서 전체 프레임에서 TRAN_KIND_CD·용도 콤보 검색', result: '입력칸 0개',
        프레임: purposeForm.frames.map((x) => `${x.frameId} · ${x.result?.url || '?'} · 신호 ${x.result?.signals || 0}`),
      });
      throw new Error('결의서의 용도 입력칸을 못 찾았어요');
    }
    const purposeFrame = purposeForm.frameId;
    const comboCount = await evaluateFrame(appTab, purposeFrame, () => {
      const anchors = [...document.querySelectorAll('.purpose_combo,[id^="TRAN_KIND_CD"],[name^="TRAN_KIND_CD"],a.bt_purpose_cbList')];
      const roots = anchors.map((el) => el.closest('.purpose_combo')
        || (el.matches('input,select,a') ? el.closest('td,li,div') : el)).filter(Boolean);
      return new Set(roots).size;
    });
    for (let i = 0; i < comboCount; i++) {
      await evaluateFrame(appTab, purposeFrame, (idx) => {
        const anchors = [...document.querySelectorAll('.purpose_combo,[id^="TRAN_KIND_CD"],[name^="TRAN_KIND_CD"],a.bt_purpose_cbList')];
        const roots = [...new Set(anchors.map((el) => el.closest('.purpose_combo')
          || (el.matches('input,select,a') ? el.closest('td,li,div') : el)).filter(Boolean))];
        const combo = roots[idx];
        const btn = combo?.querySelector('a.bt_purpose_cbList,[class*="purpose"][class*="List"],button,[role="button"]');
        btn?.click();
      }, i);
      await sleep(450);
      const bound = await evaluateFrame(appTab, purposeFrame, ({ idx, use }) => {
        const anchors = [...document.querySelectorAll('.purpose_combo,[id^="TRAN_KIND_CD"],[name^="TRAN_KIND_CD"],a.bt_purpose_cbList')];
        const roots = [...new Set(anchors.map((el) => el.closest('.purpose_combo')
          || (el.matches('input,select,a') ? el.closest('td,li,div') : el)).filter(Boolean))];
        const combo = roots[idx];
        const scoped = [...(combo?.querySelectorAll('a.cb_item,[role="option"],option') || [])];
        const opts = scoped.length ? scoped : [...document.querySelectorAll('a.cb_item,[role="option"],option')];
        const opt = opts.find((e) => (e.textContent || '').includes(use) && e.offsetParent !== null)
          || opts.find((e) => (e.textContent || '').includes(use));
        if (!opt) return false;
        if (opt.tagName === 'OPTION') { const sel = opt.closest('select'); sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
        else opt.click();
        const inp = combo?.querySelector('input[placeholder*="선택"],input:not([type=hidden]),select');
        return !!inp;
      }, { idx: i, use: useName });
      if (!bound) throw new Error(`용도 '${useName}' 옵션을 못 찾았어요 (항목 ${i + 1})`);
    }
    onProgress('용도 입력', { try: useName, result: `${comboCount}개 항목 선택 완료`,
      위치: purposeFrame === modalFrame ? '결의 모달 프레임' : `하위 프레임 ${purposeFrame}` });

    if (kind === 'yagun') {
      onProgress('야근 증빙 첨부', { try: '타임인아웃 근태 증빙 PNG 생성' });
      const file = proofFile?.base64 && proofFile?.type === 'image/png'
        ? proofFile : await renderTaxiEvidenceFile(targets, month);
      const upload = await openUploadTarget(appTab, modalFrame);
      uploadTab = upload.popup ? upload.tabId : null;
      if (upload.tabId == null) {
        onProgress('야근 증빙 첨부', { try: '결의서 전체 프레임에서 파일첨부 버튼 검색', result: '첨부 화면 못 엶',
          프레임: upload.scanned.map((x) => `${x.frameId} · ${x.result?.url || '?'} · 버튼 ${x.result?.count || 0}`) });
        for (const attempt of upload.attempts || []) {
          onProgress('야근 증빙 첨부', { try: '파일첨부 요소', result: attempt.clicked?.html || attempt.clicked?.error || '클릭 요소 없음' });
          onProgress('야근 증빙 첨부', { try: '전체 프레임 팝업 감시', result:
            `${attempt.source} · ${(attempt.capture || []).join(' / ') || '캡처 없음'} · 새 프레임 ${(attempt.newFrames || []).join(' / ') || '없음'}` });
        }
        throw new Error('증빙 파일첨부 창이 열리지 않았어요');
      }
      onProgress('야근 증빙 첨부', { try: '파일첨부 버튼', result: upload.popup ? '팝업 열림' : '같은 탭의 첨부 프레임 열림',
        위치: `프레임 ${upload.actionFrame}` });
      // 실제 Bizplay 첨부 화면은 별도 실행 버튼 없이 file input의 change에서 곧바로
      // 업로드한다. change 이벤트보다 먼저 감시를 켜야 그 요청의 성공을 놓치지 않는다.
      await installUploadProbe(upload.tabId, upload.frameId);
      const setFile = await evaluate(upload.tabId, (f) => {
        const input = [...document.querySelectorAll('input[type=file]')]
          .find((e) => e.id !== 'BBFileElement' && !/_WE_DRIVER\.changeFileList/.test(e.getAttribute('onchange') || ''));
        if (!input) return false;
        const bin = atob(f.base64), bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const dt = new DataTransfer(); dt.items.add(new File([bytes], f.name, { type: f.type }));
        input.files = dt.files; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
        return input.files.length === 1;
      }, file, { frameId: upload.frameId, world: 'MAIN' });
      if (!setFile) {
        await restoreUploadProbe(upload.tabId, upload.frameId);
        throw new Error('증빙 파일 입력칸을 못 찾았어요');
      }
      let uploadClick = { clicked: false, actions: [] };
      // 파일 선택 뒤에 버튼을 늦게 그리는 업로더도 있다. button/a만 보지 않고
      // div·span·이미지형 컨트롤까지 텍스트로 찾아 실제 클릭 가능한 조상을 누른다.
      for (let i = 0; i < 9 && !uploadClick.clicked; i++) {
        uploadClick = await evaluate(upload.tabId, () => {
          const label = (e) => (e.textContent || e.value || e.getAttribute?.('alt') || e.getAttribute?.('title') || '')
            .replace(/\s+/g, ' ').trim();
          const actionable = 'button,a,input[type=button],input[type=submit],input[type=image],[role=button],[onclick]';
          const visible = [...document.querySelectorAll(actionable)].filter((e) => e.offsetParent !== null && !e.disabled);
          const all = [...document.querySelectorAll('body *')]
            .filter((e) => e.offsetParent !== null && /업로드|파일\s*첨부|첨부하기|파일\s*추가|전송|등록|저장|확인/.test(label(e)))
            .sort((a, b) => label(a).length - label(b).length);
          const exact = visible.find((e) => /^업로드$/.test(label(e)));
          const textHit = all.find((e) => /^(업로드|파일\s*첨부|첨부하기|파일\s*추가|전송|등록|저장|확인)$/.test(label(e))) || all[0];
          const action = exact || textHit?.closest(actionable) || textHit
            || visible.find((e) => /업로드|첨부|추가|전송|등록|저장|확인/.test(label(e)));
          const actions = visible.map(label).filter(Boolean).slice(0, 16);
          const fileInput = [...document.querySelectorAll('input[type=file]')]
            .find((e) => e.id !== 'BBFileElement' && !/_WE_DRIVER\.changeFileList/.test(e.getAttribute('onchange') || ''));
          if (!action || action.matches('input[type=file]')) {
            return { clicked: false, actions, hasForm: !!fileInput?.form };
          }
          const picked = label(action) || action.tagName.toLowerCase(); action.click();
          return { clicked: true, label: picked, actions, hasForm: !!fileInput?.form };
        }, undefined, { frameId: upload.frameId, world: 'MAIN' }).catch(() => ({ clicked: false, actions: [], frameGone: true }));
        if (!uploadClick.clicked) await sleep(350);
      }
      // 텍스트 컨트롤도 없지만 file input이 form 안에 있으면 브라우저의 정식 submit 경로를 쓴다.
      if (!uploadClick.clicked && uploadClick.hasForm) {
        uploadClick = await evaluate(upload.tabId, () => {
          const input = [...document.querySelectorAll('input[type=file]')]
            .find((e) => e.id !== 'BBFileElement' && !/_WE_DRIVER\.changeFileList/.test(e.getAttribute('onchange') || ''));
          const form = input?.form;
          if (!form) return { clicked: false, actions: [] };
          form.requestSubmit(); return { clicked: true, label: '첨부 폼 제출', actions: [] };
        }, undefined, { frameId: upload.frameId, world: 'MAIN' }).catch(() => ({ clicked: false, actions: [], frameGone: true }));
      }
      if (!uploadClick?.clicked) {
        onProgress('야근 증빙 첨부', { try: '첨부 화면의 실행 버튼 검색',
          result: '버튼 없음 → 파일 선택 자동 업로드 기다림' });
      }
      const uploadMode = uploadClick?.clicked ? `${uploadClick.label} 버튼 클릭` : '파일 선택 자동 업로드';
      let uploadDoneBy = '', lastUploadState = null;
      for (let i = 0; i < 34; i++) {
        if (upload.popup && !(await tabAlive(upload.tabId))) { uploadDoneBy = '첨부창 닫힘'; break; }
        if (!upload.popup) {
          const frames = await listFrames(appTab);
          if (!frames.some((x) => x.frameId === upload.frameId)) { uploadDoneBy = '첨부 프레임 닫힘'; break; }
        }
        lastUploadState = await readUploadProbe(upload.tabId, upload.frameId);
        if (lastUploadState?.successes > 0) { uploadDoneBy = '업로드 응답 성공'; break; }
        const failedText = /업로드\s*(실패|오류)|첨부\s*(실패|오류)|error/i.test(lastUploadState?.text || '');
        const successText = /업로드\s*(완료|성공)|첨부\s*(완료|성공)|등록되었습니다|저장되었습니다/.test(lastUploadState?.text || '');
        if (successText && !failedText) { uploadDoneBy = '첨부 화면 완료 표시'; break; }
        const attached = await findAttachedFile(appTab, file.name, upload.popup ? -1 : upload.frameId);
        if (attached) { uploadDoneBy = `결의서 파일 표시 (프레임 ${attached.frameId})`; break; }
        await sleep(450);
      }
      if (await tabAlive(upload.tabId)) await restoreUploadProbe(upload.tabId, upload.frameId);
      if (!uploadDoneBy) {
        onProgress('야근 증빙 첨부', { try: `${uploadMode} 후 완료 신호 확인`, result: '완료 신호 없음' });
        onProgress('야근 증빙 첨부', { try: '첨부 화면 통신', result: lastUploadState
          ? `요청 ${lastUploadState.requests} · 성공 ${lastUploadState.successes} · 실패 ${lastUploadState.failures} · 폼제출 ${lastUploadState.submitted}` : '읽지 못함' });
        onProgress('야근 증빙 첨부', { try: '파일 입력 상태', result: lastUploadState
          ? `파일 ${lastUploadState.fileCount}개 · ${lastUploadState.fileInput || 'input 정보 없음'}` : '읽지 못함' });
        onProgress('야근 증빙 첨부', { try: '첨부 화면 문구·컨트롤', result:
          `${lastUploadState?.text || '(문구 없음)'} · ${(lastUploadState?.actions || uploadClick.actions || []).join(' / ') || '(컨트롤 없음)'}` });
        throw new Error('증빙 업로드가 완료되지 않았어요');
      }
      uploadTab = null;
      onProgress('야근 증빙 첨부', { try: file.name, result: `첨부 완료 · ${uploadDoneBy}` });
    }

    onProgress('결재선 선택', { try: '결재요청 → 법인카드 지출결의서' });
    const approval = await openPopupFromAnyFrame(appTab, modalFrame, '결재요청');
    approvalTab = approval.tabId;
    if (approvalTab == null) {
      onProgress('결재선 선택', { try: '결의서 전체 프레임에서 결재요청 버튼 검색', result: '팝업 못 엶',
        프레임: approval.scanned.map((x) => `${x.frameId} · ${x.result?.url || '?'} · 버튼 ${x.result?.count || 0}`) });
      for (const attempt of approval.attempts || []) onProgress('결재선 선택', { try: '전체 프레임 팝업 감시', result:
        `${attempt.source} · ${(attempt.capture || []).join(' / ') || '캡처 없음'}` });
      throw new Error('결재선 선택 창이 열리지 않았어요');
    }
    const line = await evaluate(approvalTab, () => {
      const sel = document.querySelector('#APPRLINE_NM'); if (!sel) return false;
      const opt = [...sel.options].find((o) => /법인카드\s*지출결의서/.test(o.textContent || ''));
      if (!opt) return false; sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); return true;
    }, undefined, { world: 'MAIN' });
    if (!line) throw new Error("결재선 '법인카드 지출결의서'를 못 찾았어요");
    await sleep(500);
    await evaluate(approvalTab, () => {
      const el = [...document.querySelectorAll('button,a,input[type=button],input[type=submit]')]
        .find((e) => /^확인$/.test((e.textContent || e.value || '').trim()) && e.offsetParent !== null);
      el?.click();
    }, undefined, { world: 'MAIN' });
    if (!(await waitTabClosed(approvalTab))) throw new Error('결재선 확인이 완료되지 않았어요');
    approvalTab = null;
    await sleep(900);
    const dialogs = await evaluate(appTab, () => {
      const d = window.__webwingDialogs || []; window.__webwingDialogRestore?.(); return d;
    }, undefined, { frameId, world: 'MAIN' }).catch(() => []);
    const failed = /오류|실패|필수|선택해/.test(dialogs.join(' '));
    if (failed) throw new Error(dialogs.join(' · '));
    onProgress('상신 완료 확인', { try: `${targets.length}건 · 결재 1건`, result: '상신 완료', 안내: dialogs.join(' · ') || undefined });
    return { recipe: 'expense-submit', kind, month, submitted: targets,
      summary: { submitted: targets.length, approvals: 1, failed: 0,
        amount: targets.reduce((s, x) => s + Number(x.amount || 0), 0) } };
  } finally {
    if (uploadTab != null && await tabAlive(uploadTab)) await closeTab(uploadTab);
    if (approvalTab != null && await tabAlive(approvalTab)) await closeTab(approvalTab);
    if (shouldClose) await closeTab(appTab);
  }
}

// 여러 달의 타임인아웃 근태를 모아 date→day 레코드 map
async function collectAttendance(months, onProgress) {
  const timeMap = {};
  for (const mo of months) {
    onProgress(`타임인아웃 근태 매칭 (${mo})`);
    try {
      const to = await getOvertime(mo);
      for (const dd of to.days || []) timeMap[`${mo}-${String(dd.day).padStart(2, '0')}`] = dd;
    } catch { /* 그 달 실패는 스킵 — 증빙 없음으로 처리 */ }
  }
  return timeMap;
}

// ── 야근택시 (조회) ──
// 확장에 없는 도메인에서 앱이 도는 경우, 크롬이 내는 원문은 알아보기 어렵다. 사람 말로 바꾼다.
function wrapHostPermission(e) {
  const m = /Cannot access contents of url "([^"]+)"/.exec(e?.message || '');
  if (!m) return e;
  const host = (() => { try { return new URL(m[1]).host; } catch { return m[1]; } })();
  const err = new Error(`이 확장에 ${host} 접근 권한이 없어요`);
  err.detail = [`카드영수증 앱이 ${host} 에서 열렸는데, 확장이 그 도메인을 읽도록 허용돼 있지 않아요.`,
    '회사마다 앱 도메인이 달라서 생기는 문제예요. 이 주소를 알려주시면 다음 판올림에 넣겠습니다.',
    '', `기술 정보: ${e.message}`].join('\n');
  return err;
}

export async function getYagunTaxi(month, onProgress = () => {}) {
  const { appTab, frameId, shouldClose } = await openCardApp(month, onProgress);
  try {
    onProgress('미결의(대기) 조회 중');
    const rows = await loadPendingRows(appTab, frameId);
    onProgress('미결의(대기) 조회 중', {
      '긁은 행': `${rows.length}건`,
      예시: rows.slice(0, 3).map((td) => `${td[3]} · ${td[4]} · ${td[7]}`),
    });
    // 화면의 조회기간이 대상월과 다를 수 있다(실물은 7/1~8/5가 걸려 있었다).
    // 날짜 UI를 못 건드려도 결과가 어긋나지 않게 여기서 대상월로 자른다.
    // 심야 택시는 자정을 넘기면 전날 야근이므로 '야근일' 기준으로 판단한다.
    const inMonth = rows.map(toItem).filter((it) => yagunDateOf(it.date).slice(0, 7) === month);
    const taxis = inMonth.filter((it) => /택시/.test(it.merchant) && isNight(it.date) && it.amount > 0);
    onProgress('미결의(대기) 조회 중', {
      '심야 택시 후보': `${taxis.length}건`,
      기준: '사용처에 택시 + 23~03시 결제',
      '걸러진 건': `${rows.length - taxis.length}건 (다른 달·택시 아님·주간 결제)`,
      '대상월 밖': `${rows.length - inMonth.length}건`,
    });

    const timeMap = taxis.length
      ? await collectAttendance([...new Set(taxis.map((it) => yagunDateOf(it.date).slice(0, 7)))], onProgress)
      : {};

    const items = taxis.map((it) => {
      const yd = yagunDateOf(it.date); const rec = timeMap[yd];
      const isHol = !!(rec && (rec.weekend || rec.holiday));
      const otMin = rec ? (isHol ? rec.holMin : rec.otMin) : 0;
      const worked = !!(rec && !rec.missing && otMin > 0);
      return { ...it, yagunDate: yd, dow: rec ? rec.dow : '', yagunIn: rec ? rec.inText : '', yagunOut: rec ? rec.outText : '',
        otText: worked ? fmt(otMin) : '', isHoliday: isHol, hasProof: worked };
    });
    const withProof = items.filter((x) => x.hasProof);
    const proofFile = withProof.length ? await renderTaxiEvidenceFile(withProof, month).catch(() => null) : null;
    onProgress('타임인아웃 근태 매칭', {
      '증빙 있음': `${withProof.length}건`,
      '증빙 없음': `${items.length - withProof.length}건`,
      판정: items.slice(0, 4).map((x) => `${x.yagunDate} ${x.merchant} → ${x.hasProof ? `야근 ${x.otText}` : '그날 야근 기록 없음'}`),
    });
    const submitAmt = withProof.reduce((a, x) => a + x.amount, 0);
    const total = items.reduce((a, x) => a + x.amount, 0);
    return {
      recipe: 'yagun', month, items, proofFile,
      summary: { count: items.length, withProof: withProof.length, noProof: items.length - withProof.length,
        amount: submitAmt, amountText: submitAmt.toLocaleString('en-US') + '원', totalText: total.toLocaleString('en-US') + '원' },
    };
  } catch (e) { throw wrapHostPermission(e); } finally { if (shouldClose) await closeTab(appTab); }
}

// ── 야근식비 (조회) ──
export async function getYasik(month, onProgress = () => {}) {
  const { appTab, frameId, shouldClose } = await openCardApp(month, onProgress);
  try {
    onProgress('미결의(대기) 조회 중');
    const rows = await loadPendingRows(appTab, frameId);
    onProgress('미결의(대기) 조회 중', {
      '긁은 행': `${rows.length}건`,
      예시: rows.slice(0, 3).map((td) => `${td[3]} · ${td[4]} · ${td[7]}`),
    });
    // 화면 조회기간이 대상월과 달라도 결과가 어긋나지 않게 여기서 자른다.
    const inMonth = rows.map(toItem).filter((it) => it.date.slice(0, 7) === month);
    const meals = inMonth.filter((it) => it.amount > 0 && it.amount <= 13000 && !/택시/.test(it.merchant) && isYasikMeal(it.date));
    onProgress('미결의(대기) 조회 중', {
      '식대 후보': `${meals.length}건`,
      기준: '13,000원 이하 + 저녁(17~22시) 또는 조식(05~09시) + 택시 아님',
      '걸러진 건': `${rows.length - meals.length}건 (다른 달·금액 초과·시간대 밖)`,
      '대상월 밖': `${rows.length - inMonth.length}건`,
    });

    const timeMap = meals.length
      ? await collectAttendance([...new Set(meals.map((it) => it.date.slice(0, 7)))], onProgress)
      : {};

    const items = meals.map((it) => {
      const day = it.date.slice(0, 10); const rec = timeMap[day];
      const c = yasikClass(it, rec);
      return { ...it, mealDate: day, dow: rec ? rec.dow : '', meal: c.meal, eligible: c.ok, why: c.why,
        inText: rec ? rec.inText : '', otText: rec && !rec.missing ? fmt((rec.weekend || rec.holiday) ? rec.holMin : rec.otMin) : '' };
    });
    const eligible = items.filter((x) => x.eligible);
    onProgress('타임인아웃 근태 매칭', {
      인정: `${eligible.length}건`,
      제외: `${items.length - eligible.length}건`,
      판정: items.slice(0, 4).map((x) => `${x.mealDate} ${x.merchant} → ${x.why}`),
    });
    const amount = eligible.reduce((a, x) => a + x.amount, 0);
    const total = items.reduce((a, x) => a + x.amount, 0);
    return {
      recipe: 'yasik', month, items,
      summary: { count: items.length, eligible: eligible.length, excluded: items.length - eligible.length,
        amount, amountText: amount.toLocaleString('en-US') + '원', totalText: total.toLocaleString('en-US') + '원' },
    };
  } catch (e) { throw wrapHostPermission(e); } finally { if (shouldClose) await closeTab(appTab); }
}
