// 비즈플레이 수집(익스텐션판) — 카드영수증 앱의 미결의(대기)에서 야근택시·야근식비 후보를 뽑아
// 타임인아웃 근태로 증빙 가능 여부를 판정한다. src/lib/bizplay.mjs의 getYagunTaxi/getYasik에 대응.
// ⚠ 상신(일괄결의)은 제외 — 실제 경비 시스템에 쓰기라 실계정 검증 후. 여기선 조회·판정까지.
// ⚠ 카드영수증은 런처→새 탭→eusr_9001 iframe 구조라 라이브 검증 필요.
import { openTab, closeTab, evaluate, evaluateAllFrames, clickOpensTab, findFrame, evaluateFrame } from './tab.js';
import { getOvertime } from './overtime.js';
import { isNight, isYasikMeal, yasikClass } from '../core/expense.js';
import { yagunDateOf } from '../core/calendar.js';

const HOST = 'https://www.bizplay.co.kr';
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
    const a = (k) => { const v = el.getAttribute?.(k); return v ? ` ${k}=${v.slice(0, 70)}` : ''; };
    return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls} [${Math.round(r.width)}x${Math.round(r.height)}]`
      + `${el.offsetParent ? '' : ' (숨김)'}${a('href')}${a('onclick')}${a('alt')}`;
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
  return { url: location.href, count: found.length, items: found.slice(0, 6).map(desc), sample };
}

// 런처 → 카드영수증 앱(새 탭) → 데이터 iframe. 대상월로 날짜범위까지 세팅한 frame 참조 반환.
async function openCardApp(month, onProgress) {
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
  await sleep(1200);
  // 핵심: 앱은 window.open으로 새 창을 여는데, 확장의 자동 클릭은 신뢰 제스처가 아니라 팝업 차단됨.
  // → window.open을 가로채 URL만 뽑고, 그 URL을 확장이 직접 chrome.tabs.create로 연다(팝업 차단 없음).
  //   사용자가 팝업 허용 등 아무 조작도 할 필요 없음.
  const beforeUrl = await evaluate(launcher, () => location.href);
  // 아이콘이 어느 프레임에 있는지부터 찾는다. 포털이라 앱 목록이 iframe 안에 있을 수 있고,
  // 늦게 그려지기도 해서 몇 번 다시 본다.
  let iconFrame = null;
  for (let i = 0; i < 6 && iconFrame == null; i++) {
    const hits = await evaluateAllFrames(launcher, findCardReceipt);
    const hit = hits.find((h) => h.result?.count > 0);
    if (hit) { iconFrame = hit.frameId; break; }
    await sleep(1000);
  }

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
    const el = (at && target.contains(at)) ? at : target;
    // click()만으로는 안 먹는 타일이 있다(mousedown·pointerup에 걸어 둔 경우). 전체 시퀀스를 흘려보낸다.
    for (const type of ['pointerover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
    setTimeout(() => finish(null), 3000); // window.open 안 쓰면 null (아래에서 같은탭 이동/새탭 폴백)
  }), undefined, { world: 'MAIN', frameId: iconFrame });

  let appTabId = null;
  if (openedUrl) {
    // 가로챈 URL을 확장이 직접 연다 (팝업 차단 회피)
    appTabId = await openTab(openedUrl);
  } else {
    // 폴백1: 클릭이 같은 탭을 앱으로 이동시켰는지
    await sleep(1200);
    const nowUrl = await evaluate(launcher, () => location.href).catch(() => beforeUrl);
    if (nowUrl && nowUrl !== beforeUrl && !/main_0003/.test(nowUrl)) appTabId = launcher;
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
  if (appTabId == null) {
    // 아이콘을 못 찾은 건지, 찾았는데 클릭이 주소를 안 만든 건지 구분이 안 되면 고칠 수가 없다.
    // 화면에서 '카드영수증'이 들어간 요소를 훑어 에러에 같이 담는다.
    const frames = await evaluateAllFrames(launcher, findCardReceipt).catch(() => []);

    await closeTab(launcher);
    const e = new Error('카드영수증 앱이 안 열렸어요');
    const lines = [
      iconFrame == null
        ? `'카드영수증' 앱 아이콘을 화면에서 찾지 못했어요.`
        : `'카드영수증' 아이콘을 눌렀지만 앱 주소를 잡지 못했어요.`,
      `현재 화면: ${beforeUrl}`,
      '로그인이 풀리지 않았는지, 카드영수증 앱이 화면에 보이는지 확인해주세요.',
      '',
      '아래는 개발자에게 그대로 전달해주시면 고칠 수 있는 정보예요.',
      `프레임 ${frames.length}개를 훑었습니다.`,
    ];
    for (const f of frames) {
      const r = f.result;
      if (!r) { lines.push(`  · (프레임 ${f.frameId}: 읽지 못함)`); continue; }
      lines.push(`  · ${r.url.slice(0, 90)}  — 일치 ${r.count}개`);
      for (const x of r.items || []) lines.push(`      ${x}`);
      if (!r.count && r.sample?.length) lines.push(`      이 화면에 보이는 것: ${r.sample.join(' / ')}`);
    }
    e.detail = lines.join('\n');
    throw e;
  }
  if (appTabId !== launcher) await closeTab(launcher); // 앱을 새 탭으로 열었으면 런처는 닫음

  const frameId = await findFrame(appTabId, 'eusr_9001');
  if (frameId == null) {
    const url = await evaluate(appTabId, () => location.href).catch(() => '');
    await closeTab(appTabId);
    const e = new Error('카드영수증 데이터 화면을 못 찾았어요');
    e.detail = `카드영수증 앱은 열렸는데 데이터 프레임(eusr_9001)이 안 보여요.\n현재 주소: ${url || '(알 수 없음)'}\n앱이 완전히 로드되기 전이거나 화면 구조가 바뀌었을 수 있어요. 다시 시도해보고, 계속 실패하면 알려주세요.`;
    throw e;
  }
  const appTab = appTabId; // 이후 단계는 이 탭을 씀
  const appUrl = await evaluate(appTab, () => location.href).catch(() => '');
  onProgress('카드영수증 앱 여는 중', {
    런처: beforeUrl,
    '앱 주소': appUrl || '(못 읽음)',
    '연 방법': openedUrl ? 'window.open 가로채기' : (appTabId === launcher ? '같은 탭 이동' : '새 탭'),
    '데이터 프레임': 'eusr_9001 찾음',
  });
  await sleep(1500);

  // 대상월 날짜 범위 세팅
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const p2 = (n) => String(n).padStart(2, '0');
  await evaluateFrame(appTab, frameId, (r) => {
    const set = (id, v) => { const el = document.getElementById(id); if (el) { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); } };
    ['START_DT', 'SHOW_START_DT', 'BASE_START_DT'].forEach((id) => set(id, r.s));
    ['END_DT', 'SHOW_END_DT', 'BASE_END_DT'].forEach((id) => set(id, r.e));
  }, { s: `${y}-${p2(m)}-01`, e: `${y}-${p2(m)}-${p2(last)}` });

  return { appTab, frameId };
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
      [...document.querySelectorAll('#tableList tr')].filter((tr) => /\d{4}-\d{2}-\d{2}/.test(tr.innerText)).length);
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
  // 행 스크래핑
  return evaluateFrame(appTab, frameId, () => {
    const t = document.querySelector('#tableList'); if (!t) return [];
    return [...t.querySelectorAll('tr')]
      .map((tr) => [...tr.querySelectorAll('td')].map((td) => td.innerText.trim().replace(/\s+/g, ' ')))
      .filter((td) => td.length >= 8 && /\d{4}-\d{2}-\d{2}/.test(td.join(' ')));
  });
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
export async function getYagunTaxi(month, onProgress = () => {}) {
  const { appTab, frameId } = await openCardApp(month, onProgress);
  try {
    onProgress('미결의(대기) 조회 중');
    const rows = await loadPendingRows(appTab, frameId);
    onProgress('미결의(대기) 조회 중', {
      '긁은 행': `${rows.length}건`,
      예시: rows.slice(0, 3).map((td) => `${td[3]} · ${td[4]} · ${td[7]}`),
    });
    const taxis = rows.map(toItem).filter((it) => /택시/.test(it.merchant) && isNight(it.date) && it.amount > 0);
    onProgress('미결의(대기) 조회 중', {
      '심야 택시 후보': `${taxis.length}건`,
      기준: '사용처에 택시 + 23~03시 결제',
      '걸러진 건': `${rows.length - taxis.length}건 (택시 아님·주간 결제)`,
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
    onProgress('타임인아웃 근태 매칭', {
      '증빙 있음': `${withProof.length}건`,
      '증빙 없음': `${items.length - withProof.length}건`,
      판정: items.slice(0, 4).map((x) => `${x.yagunDate} ${x.merchant} → ${x.hasProof ? `야근 ${x.otText}` : '그날 야근 기록 없음'}`),
    });
    const submitAmt = withProof.reduce((a, x) => a + x.amount, 0);
    const total = items.reduce((a, x) => a + x.amount, 0);
    return {
      recipe: 'yagun', month, items,
      summary: { count: items.length, withProof: withProof.length, noProof: items.length - withProof.length,
        amount: submitAmt, amountText: submitAmt.toLocaleString('en-US') + '원', totalText: total.toLocaleString('en-US') + '원' },
    };
  } finally { await closeTab(appTab); }
}

// ── 야근식비 (조회) ──
export async function getYasik(month, onProgress = () => {}) {
  const { appTab, frameId } = await openCardApp(month, onProgress);
  try {
    onProgress('미결의(대기) 조회 중');
    const rows = await loadPendingRows(appTab, frameId);
    onProgress('미결의(대기) 조회 중', {
      '긁은 행': `${rows.length}건`,
      예시: rows.slice(0, 3).map((td) => `${td[3]} · ${td[4]} · ${td[7]}`),
    });
    const meals = rows.map(toItem).filter((it) => it.amount > 0 && it.amount <= 13000 && !/택시/.test(it.merchant) && isYasikMeal(it.date));
    onProgress('미결의(대기) 조회 중', {
      '식대 후보': `${meals.length}건`,
      기준: '13,000원 이하 + 저녁(17~22시) 또는 조식(05~09시) + 택시 아님',
      '걸러진 건': `${rows.length - meals.length}건 (금액 초과·시간대 밖)`,
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
  } finally { await closeTab(appTab); }
}
