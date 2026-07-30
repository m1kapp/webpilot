// 확장 통합 테스트: Chromium에 확장을 실제로 로드하고, user.timeinout.kr을 로컬 가짜 서버로 돌려
// 수집 → 파싱 → 화면 렌더까지 전 구간을 돌린다. 실제 계정·비밀번호는 쓰지 않는다.
//
// Playwright의 route()는 확장이 chrome.tabs.create로 연 탭에 걸리지 않는다.
// 그래서 --host-resolver-rules로 도메인 자체를 로컬 https 서버에 매핑한다(네트워크 계층이라 확장 탭에도 적용).
import { chromium } from 'playwright';
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const workdir = mkdtempSync(join(tmpdir(), 'wp-ext-'));
const PORT = 18443;

// ── 가짜 타임인아웃 ──
const LEAVES = [
  ['1', '2026-06-12', '1일(종일)', 1, '연차휴가'],
  ['2', '2026-06-11', '1일(종일)', 1, '연차휴가'],
  ['3', '2026-06-08', '1일(종일)', 1, '연차휴가'],
  ['4', '2026-06-02', '반반차', 0.25, '연차휴가'],
  ['5', '2026-04-30', '반차', 0.5, '연차휴가'],
  ['6', '2026-04-29', '반차', 0.5, '연차휴가'],
  ['7', '2026-04-10', '반차', 0.5, '연차휴가'],
  ['8', '2026-04-03', '반반차', 0.25, '연차휴가'],
  ['9', '2026-03-17', '1일(종일)', 1, '연차휴가'],
  ['10', '2026-03-16', '1일(종일)', 1, '기타휴가'],
  ['11', '2026-01-12', '1일(종일)', 1, '연차휴가'],
];

const listPage = `<!doctype html><html lang="ko"><body>
<h1>2026년 나의 휴가</h1>
<a href="#">이전 해</a> <a href="#">다음 해</a>
<div>연차휴가 전체일수 18일 잔여일수 13일 만료일 2026-12-31</div>
<div>기타휴가 전체일수 1일 잔여일수 1일 만료일 2026-12-31</div>
<ul class="card_list">${LEAVES.map(([id, date, detail, days]) => `
  <li><a href="/Leave/Detail/${id}">상세</a>
    <div class="card_date"><span class="date">${date}</span></div>
    <div class="inout_area"><ul><li><span>${detail}</span></li><li><span>${days}일</span></li></ul></div>
  </li>`).join('')}</ul></body></html>`;

const detailPage = (date, type, detail) =>
  `<!doctype html><html lang="ko"><body><p>${date} (금) ${type} ${detail}</p></body></html>`;

// 로그인 폼(비밀번호 입력칸이 있으면 확장이 "로그인 필요"로 판정). /Leave/Index 로그아웃 시 이걸 준다.
const loginPage = `<!doctype html><html lang="ko"><body><h1>로그인</h1>
<form><input name="Email"><input type="password" name="Password"><button>로그인</button></form></body></html>`;
// openLoginAndWait가 여는 로그인 랜딩(/). 잠시 뒤 "로그인 성공"으로 스스로 이동 → 폴링이 완료를 감지.
const loginLanding = `<!doctype html><html lang="ko"><body><h1>로그인</h1>
<form><input type="password" name="Password"></form>
<script>setTimeout(function(){ location.href='/__done'; }, 700)</script></body></html>`;
let loggedIn = false; // 시작은 로그아웃 — 로그인 흐름을 검증한 뒤 목록/상세를 준다

// ── 초과근무용 가짜 페이지 ── (대상월 2026-06 가정)
// 근태 카드: "MM.DD (요일) ... IN hh:mm OUT hh:mm ... 인정시간 …" 형태를 흉내
const OT_CARDS = [
  ['06.01', '월', '09:02', '18:30', '9시간 00분'],  // 초과 없음
  ['06.02', '화', '09:00', '21:15', '9시간 00분'],  // 평일 초과 ~2.5h
  ['06.08', '월', '10:00', '20:00', '8시간 30분'],  // 초과 ~0.5h
  ['06.13', '토', '13:00', '17:00', '4시간 00분'],  // 휴일근무(토)
];
const historyPage = `<!doctype html><html lang="ko"><body>
<div>2026년 6월</div>
${OT_CARDS.map(([md, dow, i, o, rec], k) => `
  <div><a href="/InOutMng/InOutDetail/${k}">${md} (${dow}) IN ${i} OUT ${o} 인정 시간 ${rec} 출근 상태 정상 퇴근 상태 정상 비업무 -</a></div>`).join('')}
</body></html>`;
const tripListPage = `<!doctype html><html lang="ko"><body><ul></ul></body></html>`;  // 출장 없음
const approvalPage = `<!doctype html><html lang="ko"><body>결재함 (신청 없음)</body></html>`;

// 자체서명 인증서 (--ignore-certificate-errors와 함께 씀)
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
  '-subj', '/CN=user.timeinout.kr', '-keyout', join(workdir, 'k.pem'), '-out', join(workdir, 'c.pem')],
  { stdio: 'ignore' });

const server = createServer(
  { key: readFileSync(join(workdir, 'k.pem')), cert: readFileSync(join(workdir, 'c.pem')) },
  (req, res) => {
    // Flow API(api.flow.team) — JSON. 어느 날짜든 10:00~19:30 활동을 준다(제안 근거).
    if ((req.headers.host || '').includes('flow.team')) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ response: { success: true, data: { events: [
        { eventName: '오전 스크럼', allDayYn: 'N', eventStartDateTime: '20260604100000', eventFinishDateTime: '20260604103000' },
        { eventName: '개발', allDayYn: 'N', eventStartDateTime: '20260604140000', eventFinishDateTime: '20260604193000' },
      ] } } }));
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    const path = req.url.split('?')[0];
    if (path === '/') return res.end(loginLanding);          // openLoginAndWait가 연 로그인 창
    if (path === '/__done') { loggedIn = true; return res.end('<!doctype html><body>로그인 완료</body>'); } // 성공 → 비밀번호칸 없음
    if (!loggedIn) return res.end(loginPage);                 // 로그아웃 상태에서 데이터 요청 → 로그인 폼
    if (path === '/InOutMng/InOutHistory') return res.end(historyPage);
    if (path.startsWith('/InOutMng/InOutDetail')) return res.end('<!doctype html><body></body>'); // 스필오버 상세(없음)
    if (path === '/InOutMng/List') return res.end(tripListPage);
    if (path === '/ApprovalMng/Index') return res.end(approvalPage);
    const m = path.match(/^\/Leave\/Detail\/(\d+)/);
    const row = m && LEAVES.find((r) => r[0] === m[1]);
    res.end(row ? detailPage(row[1], row[4], row[2]) : listPage);
  });
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const ctx = await chromium.launchPersistentContext(join(workdir, 'profile'), {
  headless: false,
  ignoreHTTPSErrors: true,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    `--host-resolver-rules=MAP user.timeinout.kr 127.0.0.1:${PORT},MAP api.flow.team 127.0.0.1:${PORT}`,
    '--ignore-certificate-errors',
  ],
});

const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
const extId = new URL(sw.url()).host;
console.log('확장 로드됨 · id =', extId);

const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(`chrome-extension://${extId}/page/index.html`);

// 홈: 자동화 목록이 떠야 함
await page.waitForSelector('#view-home:not([hidden]) .auto', { timeout: 15000 });
const homeItems = await page.$$eval('#auto-list-wrap .auto', (els) => els.map((e) => ({
  label: e.querySelector('.lb').textContent, ready: !e.disabled })));
console.log('── 홈: 자동화 목록 ──');
for (const it of homeItems) console.log(`  ${it.ready ? '●' : '○'} ${it.label}${it.ready ? '' : ' (준비 중)'}`);

// '내 연차 현황' 실행 (로그아웃 상태이므로 먼저 로그인 필요가 떠야 함)
await page.click('.auto[data-id="leave-personal"]');
await page.waitForSelector('#view-run:not([hidden]) .step', { timeout: 5000 });
const stepLabels = await page.$$eval('#steps .step .tx', (els) => els.map((e) => e.textContent));
console.log('\n── 실행 중 단계 ──');
console.log('  ' + stepLabels.join(' → '));

// 로그인 필요 → "로그인하기" 버튼이 떠야 함
await page.waitForSelector('#run-actions:not([hidden])', { timeout: 30000 });
const retryLabel = await page.$eval('#run-retry', (e) => e.textContent);
const loginPrompt = /로그인하기/.test(retryLabel);
console.log('\n── 로그인 필요 감지 ──');
console.log('  버튼 문구:', retryLabel, loginPrompt ? '✓' : '✗');

// 로그인하기 클릭 → 백그라운드가 로그인 탭 열고 완료 폴링 → 자동 재실행 → 결과
await page.click('#run-retry');
await page.waitForSelector('#view-result:not([hidden])', { timeout: 30000 })
  .catch(async () => { throw new Error('로그인 후 자동 재실행 실패 — 오류창: ' + await page.$eval('#run-err', (e) => e.innerText).catch(() => '?')); });
await page.waitForTimeout(400);
console.log('  로그인 후 자동 재실행 → 결과 도달: ✓');

const allDone = await page.$$eval('#steps .step', (els) => els.every((e) => e.classList.contains('done')));
console.log('  모든 단계 완료 표시:', allDone ? '✓' : '✗');

const read = (sel, fn) => page.$eval(sel, fn).catch(() => '');
const kpis = await page.$$eval('.kpis .kpi', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
const filled = await page.$$eval('.yc-cell.used', (els) => els.map((e) => ({
  tip: e.title, op: e.querySelector('.yc-fill')?.style.opacity })));
const calSum = await read('#cal-sum', (e) => e.innerText);

console.log('\n── 렌더 결과 ──');
console.log('KPI       :', kpis.join(' || '));
console.log('페이스    :', (await read('#pace', (e) => e.innerText)).replace(/\n/g, ' / '));
console.log('합계      :', calSum);
console.log('월 카드   :', (await page.$$('.yc-month')).length, '개');
console.log('채운 날   :', filled.length, '개');
for (const f of filled) console.log('            ', f.tip, '→ opacity', f.op);
console.log('공휴일셀  :', (await page.$$('.yc-cell.hol')).length, '개');
console.log('근로자의날:', (await page.$$eval('.yc-cell.wday', (els) => els.map((e) => e.title))).join(', '));
console.log('범례      :', (await read('#legend', (e) => e.innerText)).replace(/\s+/g, ' '));
console.log('JS 오류   :', errors.length ? errors : '없음');

const expectDays = LEAVES.reduce((s, r) => s + r[3], 0);
const checks = [
  ['잔여 연차 13/18', kpis.some((k) => k.includes('13') && k.includes('18'))],
  ['기타휴가 카드', kpis.some((k) => k.includes('기타휴가'))],
  [`합계 ${expectDays}일`, Number(calSum.match(/([\d.]+)일/)?.[1]) === expectDays],
  [`채운 날 ${LEAVES.length}개`, filled.length === LEAVES.length],
  ['반반차 = opacity 0.25', filled.some((f) => f.op === '0.25')],
  ['반차 = opacity 0.5', filled.some((f) => f.op === '0.5')],
  ['기타휴가 색 구분', filled.some((f) => /기타휴가/.test(f.tip))],
  ['JS 오류 없음', errors.length === 0],
];
await page.screenshot({ path: '/tmp/ext-shot.png', fullPage: true });

// ── 초과근무 분석 실행 (목록으로 → 초과근무 클릭 → 결과) ──
await page.click('#back');
await page.waitForSelector('#view-home:not([hidden])');
await page.$eval('#month', (el) => { el.value = '2026-06'; }); // 근태 카드가 6월 기준
await page.click('.auto[data-id="overtime"]');
await page.waitForSelector('#view-result:not([hidden]) #ot-rows', { timeout: 30000 })
  .catch(async () => { throw new Error('초과근무 결과 실패 — 오류창: ' + await page.$eval('#run-err', (e) => e.innerText).catch(() => '?')); });
await page.waitForTimeout(300);
const otSummary = await page.$eval('.kpis', (e) => e.innerText.replace(/\s+/g, ' '));
const otRows = await page.$$eval('#ot-rows .ot-row', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
console.log('\n── 초과근무 결과 ──');
console.log('요약:', otSummary);
for (const r of otRows) console.log('  ', r);
// 52h 한도는 평일 초과근무에만 걸리고 휴일근무는 별도 집계다 — 요약이 그 구분을 보여줘야 한다.
const otHasData = /평일 초과근무/.test(otSummary) && /휴일 근무/.test(otSummary)
  && /한도와 별도 집계/.test(otSummary) && /주 평균 근로/.test(otSummary)
  && otRows.length >= 1 && !/오류|없어요 🎉$/.test(otRows[0] || '');
// 6/2(초과), 6/13(휴일) 이 표에 잡혀야 함
const otCatchesOvertime = otRows.some((r) => /\+\d+(:\d\d|분)/.test(r)); // 배지 예: +2:45 / +30분

await page.screenshot({ path: '/tmp/ext-overtime.png', fullPage: true });
await page.click('#back');
await page.waitForSelector('#view-home:not([hidden])');

// ── 출퇴근 정정: Flow 키 없음 → 키 프롬프트 → 저장 → 결과 ──
await page.$eval('#month', (el) => { el.value = '2026-06'; });
await page.click('.auto[data-id="correction"]');
await page.waitForSelector('#flow-key-input', { timeout: 30000 })
  .catch(async () => { throw new Error('Flow 키 프롬프트 안 뜸 — 오류창: ' + await page.$eval('#run-err', (e) => e.innerText).catch(() => '?')); });
const flowPrompt = true;
console.log('\n── 출퇴근 정정 ──');
console.log('  Flow 키 프롬프트: ✓');
await page.fill('#flow-key-input', 'test-flow-key-123');
await page.click('#run-retry');
await page.waitForSelector('#view-result:not([hidden]) #cr-rows', { timeout: 30000 })
  .catch(async () => { throw new Error('정정 결과 실패 — 오류창: ' + await page.$eval('#run-err', (e) => e.innerText).catch(() => '?')); });
await page.waitForTimeout(300);
const crRows = await page.$$eval('#cr-rows .cr-row', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
const crSummary = await page.$eval('.kpis', (e) => e.innerText.replace(/\s+/g, ' '));
console.log('  요약:', crSummary);
console.log('  대상:', crRows.length, '건');
for (const r of crRows.slice(0, 4)) console.log('    ', r);
const crHasSuggestion = crRows.some((r) => /→|~/.test(r)) && /신청 필요/.test(crSummary);
await page.screenshot({ path: '/tmp/ext-correction.png', fullPage: true });
await page.click('#back');
await page.waitForSelector('#view-home:not([hidden])');
// 다시 연차 결과로 돌아가 아래 패널 검증을 이어감
await page.click('.auto[data-id="leave-personal"]');
await page.waitForSelector('#view-result:not([hidden]) .yc-grid', { timeout: 30000 });
await page.waitForTimeout(300);

// 사이드 패널 폭(약 400px)에서도 같은 페이지가 성립하는지 — 1열 달력 + 크게보기 버튼
await page.setViewportSize({ width: 400, height: 900 });
await page.waitForTimeout(300);
const panel = await page.evaluate(() => {
  const grid = getComputedStyle(document.querySelector('.yc-grid')).gridTemplateColumns.split(' ').length;
  // 상단바가 한 줄인지 — 줄바꿈이 나면 "‹ 목록"과 제목이 두 동강 난다.
  // 높이로 재면 폰트·패딩이 바뀌어도 안 깨진다: 자식 중 가장 높은 것보다 크게 늘어났으면 줄바꿈.
  const bar = document.getElementById('topbar');
  const kids = [...bar.children].filter((el) => el.offsetParent !== null);
  const tallest = Math.max(...kids.map((el) => el.getBoundingClientRect().height));
  const barH = bar.getBoundingClientRect().height;
  const pad = parseFloat(getComputedStyle(bar).paddingTop) + parseFloat(getComputedStyle(bar).paddingBottom);
  return {
    columns: grid,
    topbarSingleLine: barH - pad <= tallest + 2,
    topbarTitle: document.getElementById('brand-name').textContent,
    bodyOverflows: document.body.scrollWidth > window.innerWidth + 1,
  };
});
console.log('\n── 사이드 패널 폭 400px ──');
console.log('달력 열 수     :', panel.columns);
console.log('상단바         :', panel.topbarSingleLine ? '한 줄' : '줄바꿈(문제)', `· 제목 "${panel.topbarTitle}"`);
console.log('가로 스크롤    :', panel.bodyOverflows ? '발생(문제)' : '없음');
checks.push(['패널에서 1열', panel.columns === 1],
  ['상단바 한 줄 유지', panel.topbarSingleLine],
  ['상단바 제목이 자동화 이름', panel.topbarTitle === '내 연차 현황'],
  ['패널 가로 스크롤 없음', !panel.bodyOverflows],
  ['자동화 목록 5개', homeItems.length === 5],
  ['활성 자동화 5개(전부)', homeItems.filter((i) => i.ready).length === 5],
  ['초과근무 결과 데이터', otHasData],
  ['초과근무 표에 초과일 집계', otCatchesOvertime],
  ['정정 Flow 키 프롬프트', flowPrompt],
  ['정정 결과·제안값', crHasSuggestion],
  ['실행 단계 표시', stepLabels.length >= 3],
  ['로그인 필요 감지·버튼', loginPrompt],
  ['로그인 후 자동 재실행', true], // 위 waitForSelector가 통과했으면 도달한 것
  ['모든 단계 완료', allDone]);
await page.screenshot({ path: '/tmp/ext-panel.png', fullPage: true });

// ── 컨텍스트 정렬: 타임인아웃 탭을 활성화하면 "지금 보고 있는" 섹션이 뜨고 관련 자동화가 위로 ──
await page.setViewportSize({ width: 400, height: 900 });
await page.click('#back');                                    // 홈으로
await page.waitForSelector('#view-home:not([hidden])');
const timeinoutTab = await ctx.newPage();                     // 새 탭 = 타임인아웃(활성화됨)
await timeinoutTab.goto('https://user.timeinout.kr/Leave/Index');
await page.waitForTimeout(1200);                              // onActivated → refreshContext → 재정렬
const hotHeader = await page.$eval('.home-hd.hot', (e) => e.textContent).catch(() => '');
const firstAuto = await page.$eval('#auto-list-wrap .auto .lb', (e) => e.textContent).catch(() => '');
console.log('\n── 컨텍스트 정렬 ──');
console.log('  상단 섹션:', hotHeader || '(없음)');
console.log('  첫 자동화:', firstAuto);
const ctxOk = /타임인아웃/.test(hotHeader) && /연차|초과근무/.test(firstAuto);
checks.push(['사이트 컨텍스트 정렬', ctxOk]);
await page.screenshot({ path: '/tmp/ext-context.png' });
await timeinoutTab.close();

// 자동화 5개 전부 상단바 제목이 제 이름으로 바뀌는지.
// 제목은 start()에서 실행 전에 세워지므로 수집이 성공할 필요가 없다 —
// 비즈플레이를 안 띄운 채로도 야근택시·야근식비까지 확인할 수 있다.
console.log('\n── 자동화별 상단바 제목 ──');
const titles = [];
for (const id of ['leave-personal', 'overtime', 'correction', 'yagun', 'yasik']) {
  await page.goto(`chrome-extension://${extId}/page/index.html`);                         // 직전 실행을 끊고 홈에서 다시 시작
  await page.waitForSelector(`.auto[data-id="${id}"]`);
  const label = await page.$eval(`.auto[data-id="${id}"] .lb`, (e) => e.textContent.trim());
  await page.click(`.auto[data-id="${id}"]`);
  await page.waitForFunction(() => !document.getElementById('view-run').hidden, { timeout: 8000 }).catch(() => {});
  const shown = await page.$eval('#brand-name', (e) => e.textContent.trim());
  const oneLine = await page.$eval('#topbar', (bar) => {
    const kids = [...bar.children].filter((el) => el.offsetParent !== null);
    const cs = getComputedStyle(bar);
    return bar.getBoundingClientRect().height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)
      <= Math.max(...kids.map((el) => el.getBoundingClientRect().height)) + 2;
  });
  titles.push({ id, label, shown, ok: shown === label && oneLine });
  console.log(`  ${shown === label && oneLine ? '✓' : '✗'} ${id} → "${shown}"${oneLine ? '' : ' (줄바꿈!)'}`);
}
checks.push(['자동화 5개 전부 제목·한 줄', titles.every((t) => t.ok)]);
await page.goto(`chrome-extension://${extId}/page/index.html`);

console.log('\n── 검증 ──');
for (const [label, pass] of checks) console.log(`${pass ? '✓' : '✗'} ${label}`);

console.log('\n스크린샷 → /tmp/ext-shot.png (탭) · /tmp/ext-panel.png (패널)');

await ctx.close();
server.close();
process.exit(checks.every(([, p]) => p) ? 0 : 1);
