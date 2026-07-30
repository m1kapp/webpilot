// 초과근무 분석 수집 계층(익스텐션판). src/lib/timeinout.mjs의 getOvertimeEmployee에 대응.
// 계산(cardsToByDay + buildDays)은 전부 코어. 여기선 타임인아웃에서 "가져오는" 일만 한다.
import { openTab, evaluate, closeTab, assertLoggedIn } from './tab.js';
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
    const { cards, hrefs } = await scrapeCards(tabId);

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
async function navigateToMonth(tabId, ty, tm) {
  for (let i = 0; i < 24; i++) {
    const label = await evaluate(tabId, () => (document.body.innerText.match(/(\d{4})년\s*(\d{1,2})월/) || [])[0] || '');
    const lm = label.match(/(\d{4})년\s*(\d{1,2})월/);
    if (lm && +lm[1] === ty && +lm[2] === tm) return;
    const cur = lm ? +lm[1] * 12 + +lm[2] : ty * 12 + tm;
    const goPrev = cur > ty * 12 + tm;
    const moved = await evaluate(tabId, (prev) => {
      // 월 라벨 요소를 찾고, 그 좌우의 클릭 가능한 형제(화살표)를 누른다.
      const all = [...document.querySelectorAll('*')];
      const labelEl = all.find((el) => el.children.length === 0 && /\d{4}년\s*\d{1,2}월/.test(el.textContent || ''));
      if (!labelEl) return false;
      const row = labelEl.closest('div, header, nav, section') || labelEl.parentElement;
      const clickable = [...row.querySelectorAll('a,button,i,span,[onclick],[class*=prev],[class*=next],[class*=arrow]')]
        .filter((el) => el.offsetParent !== null);
      if (clickable.length < 2) {
        // 화살표를 못 찾으면 라벨 좌우 좌표로 클릭 시도(데스크톱과 동일 발상)
        const r = labelEl.getBoundingClientRect();
        const x = prev ? r.left - 20 : r.right + 20;
        const el = document.elementFromPoint(x, r.top + r.height / 2);
        if (el) { el.click(); return true; }
        return false;
      }
      // 문서 순서상 앞=이전, 뒤=다음으로 가정
      (prev ? clickable[0] : clickable[clickable.length - 1]).click();
      return true;
    }, goPrev);
    if (!moved) return; // 더 못 움직이면 현재 화면 그대로 진행
    await sleep(1100);
  }
}

// 근태 카드 스크래핑 — 데스크톱 page.evaluate 그대로.
async function scrapeCards(tabId) {
  return evaluate(tabId, () => {
    const cand = {}, href = {};
    document.querySelectorAll('*').forEach((el) => {
      if (el.children.length > 10) return;
      const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
      const dm = t.match(/^(\d{2})\.(\d{2})\s*\(/);
      if (!dm || !/IN /.test(t) || t.length > 280) return;
      const day = parseInt(dm[2], 10);
      if (!cand[day] || t.length < cand[day].length) {
        cand[day] = t;
        const a = el.matches('a[href*="InOutDetail"]') ? el : el.querySelector('a[href*="InOutDetail"]');
        if (a) href[day] = a.getAttribute('href');
      }
    });
    return { cards: cand, hrefs: href };
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
