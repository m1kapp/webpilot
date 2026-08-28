// 타임인아웃 수집 계층(익스텐션판). src/lib/timeinout.mjs의 fetchEmployeeLeaves에 대응.
// 로그인 자동화가 없다 — 사용자가 이미 로그인한 세션을 그대로 쓴다.
import { openTab, goto, evaluate, closeTab, assertLoggedIn } from './tab.js';
import { DOW, KR_HOLIDAYS } from '../core/calendar.js'; // npm run ext:sync 로 src/core에서 복사됨

const USER_HOST = 'https://user.timeinout.kr';
const MAX_DETAIL = 20; // 휴가 종류 확인용 상세페이지 조회 상한(원본과 동일)

export async function getLeaveStatus(year, onProgress = () => {}) {
  onProgress('타임인아웃 휴가 페이지 여는 중…');
  const tabId = await openTab(`${USER_HOST}/Leave/Index`);
  try {
    await assertLoggedIn(tabId, '타임인아웃', `${USER_HOST}/`);

    // 화면이 다른 해를 보고 있으면 '이전 해/다음 해'를 눌러 맞춘다.
    onProgress(`${year}년으로 이동하는 중…`);
    for (let i = 0; i < 8; i++) {
      const shown = await evaluate(tabId, () => {
        const m = (document.body.innerText || '').match(/(\d{4})년/);
        return m ? +m[1] : 0;
      });
      if (!shown || shown === year) break;
      await evaluate(tabId, (want) => {
        const label = want < 0 ? '이전 해' : '다음 해';
        const el = [...document.querySelectorAll('a,button,span,div')]
          .find((e) => e.textContent.trim() === label);
        el?.click();
      }, shown > year ? -1 : 1);
      await sleep(900);
    }

    onProgress('잔여 연차 읽는 중…');
    // innerText는 "실제로 렌더된 화면"에서만 제대로 나온다 — 그래서 탭에서 꺼내 온다.
    const text = await evaluate(tabId, () => document.body.innerText.replace(/\s+/g, ' '));

    const rows = await evaluate(tabId, () =>
      [...document.querySelectorAll('ul.card_list > li')].map((li) => ({
        href: li.querySelector('a')?.getAttribute('href') || '',
        date: (li.querySelector('.card_date .date')?.innerText || '').match(/\d{4}-\d{2}-\d{2}/)?.[0] || '',
        detail: (li.querySelector('.inout_area li:nth-child(1) span')?.innerText || '').trim(),
        days: parseFloat((li.querySelector('.inout_area li:nth-child(2) span')?.innerText || '').replace(/[^0-9.]/g, '')) || 0,
      })).filter((r) => r.date && r.href));

    // ── 해석은 여기(백그라운드)에서. 페이지에서는 원문만 꺼내 왔다 ──
    const balance = [];
    const balRe = /([가-힣]{2,8})\s*전체일수\s*([\d.]+)일\s*잔여일수\s*([\d.]+)일\s*만료일\s*(\d{4}-\d{2}-\d{2})/g;
    let bm;
    while ((bm = balRe.exec(text))) {
      balance.push({ type: bm[1], total: parseFloat(bm[2]) || 0, remaining: parseFloat(bm[3]) || 0, expire: bm[4] });
    }

    // 목록엔 종류가 없다(연차/기타휴가/경조사 구분은 상세페이지에만 있음).
    // 탭을 여러 개 여는 대신, 페이지 안에서 같은 출처로 fetch해 오프스크린 요소에 넣고 innerText를 얻는다.
    // display:none이 아니라 화면 밖 배치인 이유 — 숨기면 innerText가 비기 때문.
    const hrefs = [...new Set(rows.map((r) => r.href))].slice(0, MAX_DETAIL);
    let typeByDate = {};
    if (hrefs.length) {
      onProgress(`휴가 종류 확인 중… (${hrefs.length}건)`);
      const texts = await evaluate(tabId, async (list) => {
        const box = document.createElement('div');
        box.style.cssText = 'position:absolute;left:-99999px;top:0;width:1200px';
        document.body.appendChild(box);
        const out = [];
        for (const href of list) {
          try {
            const html = await (await fetch(href, { credentials: 'include' })).text();
            box.innerHTML = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<img\b[^>]*>/gi, '');
            out.push(box.innerText.replace(/\s+/g, ' '));
          } catch { out.push(''); }
        }
        box.remove();
        return out;
      }, hrefs);

      const dRe = /(\d{4}-\d{2}-\d{2})\s*\([^)]*\)\s*([가-힣]{2,8})\s*(1일\(종일\)|반차|반반차)/g;
      for (const t of texts || []) {
        let dm;
        while ((dm = dRe.exec(t || ''))) typeByDate[dm[1]] = dm[2];
      }
    }

    const history = rows
      .map((r) => ({
        date: r.date,
        dow: DOW[new Date(r.date + 'T00:00:00Z').getUTCDay()],
        type: typeByDate[r.date] || '연차휴가',
        detail: r.detail,
        days: r.days,
      }))
      .sort((a, b) => b.date.localeCompare(a.date));

    const holidays = Object.fromEntries(
      Object.entries(KR_HOLIDAYS).filter(([d]) => d.startsWith(String(year))));

    return { year, leaveBalance: balance, leaveHistory: history, holidays };
  } finally {
    await closeTab(tabId);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 초과근무 분석용: 이미 열린 탭을 Leave 페이지로 옮겨 "그 달"의 휴가만 byDay로.
// 반환 { 일: { type, detail, days, hours } } — buildDays의 leaves 인자에 그대로 들어간다.
export async function getLeaveByDay(tabId, month) {
  const year = Number(month.slice(0, 4));
  await goto(tabId, `${USER_HOST}/Leave/Index`);
  await sleep(1000);
  // 연도 맞추기(연차 수집과 동일)
  for (let i = 0; i < 8; i++) {
    const shown = await evaluate(tabId, () => {
      const m = (document.body.innerText || '').match(/(\d{4})년/); return m ? +m[1] : 0;
    });
    if (!shown || shown === year) break;
    await evaluate(tabId, (want) => {
      const label = want < 0 ? '이전 해' : '다음 해';
      [...document.querySelectorAll('a,button,span,div')].find((e) => e.textContent.trim() === label)?.click();
    }, shown > year ? -1 : 1);
    await sleep(900);
  }
  // evaluate 안의 함수는 페이지로 직렬화된다. 바깥 변수(month)를 그 안에서 참조하면
  // ReferenceError가 나므로, DOM 원문만 가져온 뒤 확장 백그라운드에서 월을 거른다.
  const allRows = await evaluate(tabId, () =>
    [...document.querySelectorAll('ul.card_list > li')].map((li) => ({
      href: li.querySelector('a')?.getAttribute('href') || '',
      date: (li.querySelector('.card_date .date')?.innerText || '').match(/\d{4}-\d{2}-\d{2}/)?.[0] || '',
      detail: (li.querySelector('.inout_area li:nth-child(1) span')?.innerText || '').trim(),
      days: parseFloat((li.querySelector('.inout_area li:nth-child(2) span')?.innerText || '').replace(/[^0-9.]/g, '')) || 0,
    })).filter((r) => r.date && r.href));
  const rows = (allRows || []).filter((r) => r.date.startsWith(month));

  // 그 달 것만 종류 확인
  const hrefs = [...new Set(rows.map((r) => r.href))].slice(0, MAX_DETAIL);
  const typeByDate = {};
  if (hrefs.length) {
    const texts = await evaluate(tabId, async (list) => {
      const box = document.createElement('div');
      box.style.cssText = 'position:absolute;left:-99999px;top:0;width:1200px';
      document.body.appendChild(box);
      const out = [];
      for (const href of list) {
        try {
          const html = await (await fetch(href, { credentials: 'include' })).text();
          box.innerHTML = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<img\b[^>]*>/gi, '');
          out.push(box.innerText.replace(/\s+/g, ' '));
        } catch { out.push(''); }
      }
      box.remove();
      return out;
    }, hrefs);
    const dRe = /(\d{4}-\d{2}-\d{2})\s*\([^)]*\)\s*([가-힣]{2,8})\s*(1일\(종일\)|반차|반반차)/g;
    for (const t of texts || []) { let dm; while ((dm = dRe.exec(t || ''))) typeByDate[dm[1]] = dm[2]; }
  }

  const byDay = {};
  for (const r of rows) {
    const type = typeByDate[r.date] || '연차휴가';
    byDay[Number(r.date.slice(8, 10))] = { type, detail: r.detail, days: r.days, hours: Math.round(r.days * 8) };
  }
  return byDay;
}
