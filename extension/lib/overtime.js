// 초과근무 분석 수집 계층(익스텐션판). src/lib/timeinout.mjs의 getOvertimeEmployee에 대응.
// 계산(cardsToByDay + buildDays)은 전부 코어. 여기선 타임인아웃에서 "가져오는" 일만 한다.
import { openTab, goto, evaluate, closeTab, assertLoggedIn } from './tab.js';
import { getLeaveByDay } from './timeinout.js';
import { buildDays, cardsToByDay, parseCardInOut } from '../core/attendance.js';

const USER_HOST = 'https://user.timeinout.kr';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function getOvertime(month, onProgress = () => {}) {
  onProgress('타임인아웃 여는 중');
  const tabId = await openTab(`${USER_HOST}/InOutMng/InOutHistory`);
  try {
    await assertLoggedIn(tabId, '타임인아웃', `${USER_HOST}/`);
    await sleep(1200);

    onProgress('근태 카드 조회 중');
    const [ty, tm] = month.split('-').map(Number);
    await navigateToMonth(tabId, ty, tm);
    const { cards, hrefs, monthOf, label } = await scrapeCards(tabId);
    // 화면이 실제로 목표월인지 확인한다. 이걸 안 하면 다른 달 카드가 요청한 달로 둔갑한다.
    // 실패하면 월 이동 UI가 어떻게 생겼는지 같이 담아 준다 — 그거 없이는 고칠 수가 없다.
    if (!monthMatches(ty, tm, label, monthOf)) {
      throw await monthMismatchError(tabId, month, ty, tm, label, monthOf);
    }

    onProgress('경계일(자정 넘김) 보정 중');
    const overrides = await fixSpillover(tabId, cards, hrefs);

    onProgress('휴가·출장 반영 중');
    // 휴가 byDay는 이미 있는 연차 수집 로직 재사용
    const leaves = await getLeaveByDay(tabId, month).catch(() => ({}));
    const trips = await fetchTrips(tabId, month).catch(() => ({}));
    const corrections = await fetchSubmittedCorrections(tabId, month).catch(() => ({}));

    onProgress('초과근무 계산 중');
    const result = buildDays(cardsToByDay(cards, overrides), month, corrections, leaves, trips);
    return { month, name: '본인', mode: 'employee', corrections, leaves, trips, ...result };
  } finally {
    await closeTab(tabId);
  }
}

// 헤더의 "YYYY년 M월" 라벨을 목표월까지 ◀/▶ 눌러 이동.
// 데스크톱은 라벨 좌우 좌표를 클릭하지만, 확장에선 라벨 주변의 실제 클릭 요소를 눌러야 한다.
// ⚠ 실제 마크업 의존 — 연도 이동과 같은 부류의 라이브 검증 필요 지점.
const readMonthLabel = (tabId) =>
  evaluate(tabId, () => (document.body.innerText.match(/(\d{4})년\s*(\d{1,2})월/) || [])[0] || '');

async function navigateToMonth(tabId, ty, tm) {
  // 0순위: URL 파라미터. 출장 목록(/InOutMng/List?month=<상대개월>)이 같은 방식을 쓰므로
  // 근태 현황도 받을 가능성이 높다. 되면 클릭을 아예 안 해도 되니 가장 확실하다.
  const now = new Date();
  const offset = (ty * 12 + tm) - (now.getFullYear() * 12 + (now.getMonth() + 1));
  if (offset !== 0) {
    await goto(tabId, `${USER_HOST}/InOutMng/InOutHistory?month=${offset}`);
    await sleep(900);
    const lm = /(\d{4})년\s*(\d{1,2})월/.exec(await readMonthLabel(tabId));
    if (lm && +lm[1] === ty && +lm[2] === tm) return;
  }

  for (let i = 0; i < 24; i++) {
    const label = await readMonthLabel(tabId);
    const lm = label.match(/(\d{4})년\s*(\d{1,2})월/);
    if (lm && +lm[1] === ty && +lm[2] === tm) return;
    const cur = lm ? +lm[1] * 12 + +lm[2] : ty * 12 + tm;
    const goPrev = cur > ty * 12 + tm;

    await evaluate(tabId, (prev) => {
      const all = [...document.querySelectorAll('*')];
      const labelEl = all.find((el) => el.children.length === 0 && /\d{4}년\s*\d{1,2}월/.test(el.textContent || ''));
      if (!labelEl) return;
      // el.click()만으로는 안 먹는 화살표가 있어(포인터 이벤트로 동작) 전체 시퀀스를 흘려보낸다.
      const fire = (el) => {
        if (!el || el === labelEl) return false;
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
          el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        }
        return true;
      };
      // 1순위: 데스크톱과 같은 발상 — 라벨 좌우 좌표에 실제로 있는 요소를 누른다.
      const r = labelEl.getBoundingClientRect();
      const y = r.top + r.height / 2;
      for (const dx of [20, 28, 40]) {
        const el = document.elementFromPoint(prev ? r.left - dx : r.right + dx, y);
        if (fire(el)) return;
      }
      // 2순위: 라벨 주변에서 화살표처럼 생긴 요소를 찾는다(문서 순서상 앞=이전, 뒤=다음).
      const row = labelEl.closest('div, header, nav, section') || labelEl.parentElement;
      const clickable = [...row.querySelectorAll('a,button,i,span,[onclick],[class*=prev],[class*=next],[class*=arrow]')]
        .filter((el) => el.offsetParent !== null && !el.contains(labelEl));
      if (clickable.length >= 2) fire(prev ? clickable[0] : clickable[clickable.length - 1]);
    }, goPrev);

    await sleep(1100);
    // 라벨이 그대로면 어떤 방법도 안 먹은 것. 더 돌아도 같으니 멈추고 호출부 검증에 맡긴다.
    if (await readMonthLabel(tabId) === label) return;
  }
}

// 목표월 화면인지 확인. 화살표 클릭은 실제 마크업에 기대는 취약한 방식이라
// 조용히 실패할 수 있는데, 그때 다른 달 숫자를 요청한 달의 결과로 내놓으면
// 합계·휴일근무가 통째로 틀린 채 그럴듯해 보인다. 틀린 답보다 실패가 낫다.
function monthMatches(ty, tm, label, monthOf) {
  const lm = /(\d{4})년\s*(\d{1,2})월/.exec(label || '');
  const seen = [...new Set(Object.values(monthOf || {}))];
  if (lm && (+lm[1] !== ty || +lm[2] !== tm)) return false;   // 라벨이 다른 달
  if (seen.some((mo) => mo !== tm)) return false;             // 카드가 다른 달
  if (!lm && !seen.length) return false;                      // 아무것도 못 읽음
  return true;
}

// 월 이동에 실패했을 때, 라벨 주변이 실제로 어떻게 생겼는지 긁어 온다.
// 이게 없으면 "화살표가 어디 있나"를 계속 추측해야 한다.
async function describeMonthNav(tabId) {
  return evaluate(tabId, () => {
    const all = [...document.querySelectorAll('*')];
    const labelEl = all.find((el) => el.children.length === 0 && /\d{4}년\s*\d{1,2}월/.test(el.textContent || ''));
    if (!labelEl) return { found: false, url: location.href };
    const brief = (el) => {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 14);
      return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : ''}${t ? ` "${t}"` : ''}`;
    };
    const box = labelEl.getBoundingClientRect();
    const around = [];
    for (const dx of [-60, -40, -28, -20, 20, 28, 40, 60]) {
      const el = document.elementFromPoint(dx < 0 ? box.left + dx : box.right + dx, box.top + box.height / 2);
      if (el && el !== labelEl) around.push(`${dx > 0 ? '+' : ''}${dx}px → ${brief(el)}`);
    }
    const row = labelEl.closest('div, header, nav, section') || labelEl.parentElement;
    const sibs = [...(row ? row.querySelectorAll('a,button,i,span,img,svg,[onclick]') : [])]
      .filter((el) => el.offsetParent !== null && !el.contains(labelEl)).slice(0, 12).map(brief);
    return { found: true, url: location.href, label: brief(labelEl), parent: row ? brief(row) : '', around, sibs };
  }).catch(() => ({ found: false }));
}

async function monthMismatchError(tabId, month, ty, tm, label, monthOf) {
  const lm = /(\d{4})년\s*(\d{1,2})월/.exec(label || '');
  const seen = [...new Set(Object.values(monthOf || {}))];
  const shown = lm ? `${lm[1]}년 ${lm[2]}월` : (seen.length ? `${seen.join('·')}월` : '알 수 없음');
  const nav = await describeMonthNav(tabId);

  const e = new Error(`${ty}년 ${tm}월 화면으로 이동하지 못했어요`);
  const lines = [
    `타임인아웃이 ${shown} 화면에 머물러 있어요. 그대로 계산하면 다른 달 기록이 ${month} 결과로 나오기 때문에 중단했습니다.`,
    `타임인아웃 근태 현황에서 ${ty}년 ${tm}월로 직접 옮긴 뒤 다시 시도하면 조회됩니다.`,
    '',
    '아래는 개발자에게 그대로 전달해주시면 월 이동을 고칠 수 있는 정보예요.',
    `주소: ${nav.url || '(모름)'}`,
  ];
  if (nav.found) {
    lines.push(`월 라벨: ${nav.label}`, `묶은 요소: ${nav.parent}`);
    if (nav.around?.length) lines.push('라벨 좌우 좌표에 있는 것:', ...nav.around.map((x) => `  ${x}`));
    if (nav.sibs?.length) lines.push('주변 클릭 후보:', ...nav.sibs.map((x) => `  ${x}`));
  } else {
    lines.push('월 라벨(YYYY년 M월)을 화면에서 찾지 못했어요.');
  }
  e.detail = lines.join('\n');
  return e;
}

// 근태 카드 스크래핑 — 데스크톱 page.evaluate 그대로.
async function scrapeCards(tabId) {
  return evaluate(tabId, () => {
    const cand = {}, href = {}, monthOf = {};
    document.querySelectorAll('*').forEach((el) => {
      if (el.children.length > 10) return;
      const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
      const dm = t.match(/^(\d{2})\.(\d{2})\s*\(/);
      if (!dm || !/IN /.test(t) || t.length > 280) return;
      const day = parseInt(dm[2], 10);
      if (!cand[day] || t.length < cand[day].length) {
        cand[day] = t;
        monthOf[day] = parseInt(dm[1], 10);   // 카드에 찍힌 '월' — 다른 달 화면인지 가려내는 근거
        const a = el.matches('a[href*="InOutDetail"]') ? el : el.querySelector('a[href*="InOutDetail"]');
        if (a) href[day] = a.getAttribute('href');
      }
    });
    const label = (document.body.innerText.match(/(\d{4})년\s*(\d{1,2})월/) || [])[0] || '';
    return { cards: cand, hrefs: href, monthOf, label };
  });
}

// 자정 넘나든 카드 보정 — 상세페이지를 같은 출처 fetch로 확인(탭 추가로 안 연다).
async function fixSpillover(tabId, cards, hrefs) {
  const days = Object.keys(cards).map(Number).sort((a, b) => a - b);
  const parsed = {};
  for (const d of days) parsed[d] = parseCardInOut(cards[d]);
  const suspects = [];
  for (const d of days) {
    const prev = parsed[d - 1], cur = parsed[d];
    if (!prev || !cur || prev.outH == null || cur.inH == null) continue;
    if (Math.abs((prev.outH % 24) - cur.inH) < 0.05 && hrefs[d]) suspects.push(d);
  }
  if (!suspects.length) return {};
  const hrefList = suspects.map((d) => hrefs[d]);
  const vals = await evaluate(tabId, async (list) => {
    const box = document.createElement('div');
    box.style.cssText = 'position:absolute;left:-99999px;top:0;width:1200px';
    document.body.appendChild(box);
    const out = [];
    for (const href of list) {
      try {
        const html = await (await fetch(href, { credentials: 'include' })).text();
        box.innerHTML = html.replace(/<script[\s\S]*?<\/script>/gi, '');
        const v = [...box.querySelectorAll('input')].map((i) => i.value || '')
          .find((x) => /\d{1,2}:\d{2}:\d{2}\s*~\s*\d{1,2}:\d{2}:\d{2}/.test(x)) || '';
        out.push(v);
      } catch { out.push(''); }
    }
    box.remove();
    return out;
  }, hrefList);

  const overrides = {};
  suspects.forEach((d, i) => {
    const m = (vals[i] || '').match(/(\d{1,2}):(\d{2}):(\d{2})\s*~\s*(\d{1,2}):(\d{2}):(\d{2})/);
    if (!m) return;
    let inH = +m[1] + +m[2] / 60 + +m[3] / 3600;
    let outH = +m[4] + +m[5] / 60 + +m[6] / 3600;
    if (outH < inH) outH += 24;
    overrides[d] = { inH: +inH.toFixed(4), outH: +outH.toFixed(4) };
  });
  return overrides;
}

// 출장·외근 — /InOutMng/List?month=<오늘기준 상대개월>. 승인/진행만 근로일 map으로.
async function fetchTrips(tabId, month) {
  const [ty, tm] = month.split('-').map(Number);
  const now = new Date();
  const offset = (ty * 12 + tm) - (now.getFullYear() * 12 + (now.getMonth() + 1));
  const list = await evaluate(tabId, async (params) => {
    const html = await (await fetch(`/InOutMng/List?month=${params.offset}&part=0&status=0`, { credentials: 'include' })).text();
    const box = document.createElement('div');
    box.innerHTML = html.replace(/<script[\s\S]*?<\/script>/gi, '');
    const out = [];
    for (const li of box.querySelectorAll('li')) {
      const dt = li.querySelector('.card_date .date'), tp = li.querySelector('.card_date .type');
      if (!dt || !tp) continue;
      const state = (li.querySelector('.state') || {}).textContent || '';
      const details = [...li.querySelectorAll('.inout_area li')].map((x) => ({
        k: ((x.querySelector('strong') || {}).textContent || '').trim(),
        v: ((x.querySelector('span') || {}).textContent || '').trim() }));
      out.push({ date: dt.textContent.trim(), type: tp.textContent.trim(), state: state.trim(), details });
    }
    return out;
  }, { offset });

  const map = {};
  for (const it of list || []) {
    if (!/승인|진행/.test(it.state)) continue;
    const mm = /(\d{1,2})\/(\d{1,2})\s*~\s*(\d{1,2})\/(\d{1,2})/.exec(it.date);
    if (!mm) continue;
    const [, sMo, sD, eMo, eD] = mm.map(Number);
    const place = (it.details.find((d) => /출장지|외근지|장소/.test(d.k)) || {}).v || '';
    const region = (it.details.find((d) => /지역/.test(d.k)) || {}).v || '';
    const start = new Date(Date.UTC(ty, sMo - 1, sD)), end = new Date(Date.UTC(ty, eMo - 1, eD));
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      if (d.getUTCMonth() + 1 !== tm) continue;
      map[d.getUTCDate()] = { type: it.type, place, region, state: it.state };
    }
  }
  return map;
}

// 결재함 상신함의 '출퇴근시간수정'(대기·승인)을 근로일 기준으로 매핑.
async function fetchSubmittedCorrections(tabId, month) {
  const html = await evaluate(tabId, async () => {
    try { return await (await fetch('/ApprovalMng/Index', { credentials: 'include' })).text(); }
    catch { return ''; }
  });
  const corrections = {};
  const re = /출퇴근시간수정[\s\S]{0,40}?(대기|승인)[\s\S]*?(\d{4}-\d{2}-\d{2})[\s\S]*?\(신청\)\s*(\d{1,2}:\d{2})\s*~\s*(\d{1,2}:\d{2})/g;
  let m;
  while ((m = re.exec(html || ''))) {
    const [, status, date, reqIn, reqOut] = m;
    if (!date.startsWith(month)) continue;
    corrections[Number(date.slice(8, 10))] = { reason: `출퇴근수정 ${status}`, status, reqIn, reqOut };
  }
  return corrections;
}
