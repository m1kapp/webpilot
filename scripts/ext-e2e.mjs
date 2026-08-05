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
// 확장은 Playwright의 headless:true에서 서비스 워커가 안 뜬다 —
// 크롬의 새 헤드리스 모드를 인자로 켜야 확장이 정상 로드된다. HEADLESS=0 이면 창을 띄운다.
const HEADLESS = process.env.HEADLESS !== '0';
const HEADLESS_ARGS = HEADLESS ? ['--headless=new'] : [];

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
let rcardMainRequests = 0; // 열린 앱 탭 재사용 시 새 rcard_main GET이 나가면 안 된다
let correctionSubmitRequests = 0;
let expenseSubmitRequests = 0;
let expenseUploadRequests = 0;

const correctionModifyPage = `<!doctype html><html lang="ko"><body>
<input name="InOutData[0].inTimeApproval"><input name="InOutData[0].OutTimeApproval">
<textarea name="RequestInOutMemo"></textarea><button id="submit">수정 요청</button>
<script>document.getElementById('submit').onclick = async function () {
  await fetch('/__correction_submit', { method:'POST' }); alert('등록되었습니다.');
};<\/script></body></html>`;

// ── 초과근무용 가짜 페이지 ── (대상월 2026-06 가정)
// 근태 카드: "MM.DD (요일) ... IN hh:mm OUT hh:mm ... 인정시간 …" 형태를 흉내
const OT_CARDS = [
  ['06.01', '월', '09:02', '18:30', '9시간 00분'],  // 초과 없음
  ['06.02', '화', '09:00', '21:15', '9시간 00분'],  // 평일 초과 ~2.75h
  ['06.08', '월', '10:00', '20:00', '8시간 30분'],  // 초과 ~0.5h
  ['06.13', '토', '13:00', '17:00', '4시간 00분'],  // 휴일근무(토)
  ['06.15', '월', '07:30', '19:00', '8시간 00분'],  // 이른 출근 — 야근식비 조식 인정 분기용
];
const historyPage = `<!doctype html><html lang="ko"><body>
<div>2026년 6월</div>
${OT_CARDS.map(([md, dow, i, o, rec], k) => `
  <div><a href="/InOutMng/InOutDetail/${k}">${md} (${dow}) IN ${i} OUT ${o} 인정 시간 ${rec} 출근 상태 정상 퇴근 상태 정상 비업무 -</a></div>`).join('')}
</body></html>`;
const tripListPage = `<!doctype html><html lang="ko"><body><ul></ul></body></html>`;  // 출장 없음
const approvalPage = `<!doctype html><html lang="ko"><body>결재함 (신청 없음)</body></html>`;

// ── 가짜 비즈플레이 (카드영수증) ──
// 실제 구조를 흉내낸다: 런처의 앱 아이콘이 window.open으로 앱을 열고,
// 앱 안의 eusr_9001 iframe에 '대기' 목록 표가 있다.
//
// 미결의 행 — 각 줄이 어느 판정으로 떨어지는지 주석에 적어 두었다.
// (근태: 06.01 초과0 · 06.02 초과 2:45 · 06.08 10시 출근/초과 0:30 · 06.13 토 휴일 4h · 06.15 07:30 출근)
const BZ_ROWS = [
  // 야근택시: 택시 + 심야(23~03시)
  ['법인카드', '2026-06-03 01:30', '카카오T 택시', 18000],   // 야근일=06-02(초과 있음) → 증빙 O
  ['법인카드', '2026-06-05 23:40', '온다 택시', 21000],      // 야근일=06-05(근태 없음)   → 증빙 X
  ['법인카드', '2026-06-14 00:20', '카카오T 택시', 15000],   // 야근일=06-13(토 휴일근무) → 증빙 O
  ['법인카드', '2026-06-10 19:00', 'SKT 택시', 12000],       // 심야 아님(19시)          → 후보에서 제외
  // 야근식비: 13,000원 이하 · 택시 아님 · 저녁(17~22) 또는 조식(05~09)
  ['법인카드', '2026-06-02 19:30', '김밥천국', 8000],        // 저녁 + 그날 야근          → 인정
  ['법인카드', '2026-06-15 07:00', '파리바게뜨', 6000],      // 조식 + 07:30 출근         → 인정
  ['법인카드', '2026-06-01 18:30', 'CU편의점', 6500],        // 저녁이나 그날 야근 0      → 제외
  ['법인카드', '2026-06-08 07:20', '스타벅스', 5000],        // 조식이나 10시 출근        → 제외
  ['법인카드', '2026-06-09 07:10', '메가커피', 4500],        // 조식이나 근태 없음        → 제외
  ['법인카드', '2026-06-11 12:30', '한솥도시락', 9000],      // 점심시간대                → 후보에서 제외
  ['법인카드', '2026-06-12 19:00', '삼겹살집', 45000],       // 저녁이나 13,000원 초과    → 후보에서 제외
];
// 페이지 크기 확대 루프(30행 넘을 때까지 재시도)를 첫 판에 통과시키려고 채우는 무관한 행들.
// 금액이 크고 택시도 식사 시간대도 아니라 양쪽 필터에서 모두 걸러진다.
const BZ_FILLER = Array.from({ length: 28 }, (_, i) =>
  ['법인카드', `2026-06-${String((i % 28) + 1).padStart(2, '0')} 12:00`, '사무용품 구매', 50000]);
// 대상월(2026-06) 밖의 행 — 화면 조회기간이 넓게 걸려 있으면 이런 게 섞여 온다.
// 조건만 보면 후보로 잡히지만 달이 달라 빠져야 한다.
const BZ_OTHER_MONTH = [
  ['법인카드', '2026-07-02 01:10', '카카오T 택시', 19000],   // 심야 택시지만 7월
  ['법인카드', '2026-07-03 19:20', '김밥천국', 7000],        // 저녁 식대지만 7월
];

// 실제 런처는 포털이라 앱 목록이 iframe 안에 있고, 최상위 문서에는 '카드영수증' 글자가
// 아예 없다(실물 진단으로 확인). 아이콘 라벨도 이미지 alt에만 있는 경우를 함께 흉내낸다.
const bzLauncher = `<!doctype html><html lang="ko"><body style="font-family:sans-serif;margin:0">
<h1>비즈플레이</h1>
<iframe src="/apps_frame.act" style="width:100%;height:400px;border:0"></iframe>
</body></html>`;

const bzApps = `<!doctype html><html lang="ko"><body style="font-family:sans-serif">
<!-- 실물 그대로: 타일 a에 href도 onclick도 없고 라벨은 img alt에만 있다(alt="카드 영수증", 띄어쓰기).
     클릭하면 새 탭도 window.open도 아니고 같은 페이지의 about:blank iframe이 채워진다.
     주소가 그대로라 예전 코드에는 "아무 일도 안 일어난" 것으로 보였다. -->
<ul style="display:flex;gap:16px;list-style:none;padding:12px">
  <li style="width:110px"><a class="s3-sme-item" data-screen-label="카드 영수증">
    <img class="s3-sme-ico" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
         alt="카드 영수증" style="width:64px;height:64px;background:#dde">
    <span class="s3-sme-label">카드 영수증</span></a></li>
  <li style="width:110px"><a class="s3-sme-item" data-screen-label="경비청구">경비청구</a></li>
</ul>
<iframe src="about:blank" style="width:100%;height:200px;border:0"></iframe>
<script src="/portal.js"><\/script></body></html>`;

// 앱 주소가 DOM에 전혀 없고 스크립트 안에만 있는 구조(실물이 이랬다).
// 게다가 리스너는 isTrusted를 확인해서 합성 클릭으로는 절대 안 열린다 —
// 이럴 때 스크립트에서 주소를 찾아 직접 여는 경로만이 답이다.
const bzPortalJs = `
  var SCREENS = { '카드 영수증': 'https://webank.appplay.co.kr/rcard_main.act', '경비청구': '/expense_0001.act' };
  document.querySelectorAll('.s3-sme-item').forEach(function (el) {
    el.addEventListener('click', function (ev) {
      if (!ev.isTrusted) return;                 // 합성 이벤트는 무시
      location.href = SCREENS[el.dataset.screenLabel];
    });
  });`;

const bzApp = `<!doctype html><html lang="ko"><body style="margin:0">
<iframe src="/eusr_9001.act" style="width:100%;height:700px;border:0"></iframe>
</body></html>`;

// 실계정에서 잡힌 실패 형태: 주소창의 rcard_main은 먼저 로드되지만 데이터 프레임은
// 1.5초보다 늦게 생기고 URL에도 eusr_9001이 없다. 예전 코드는 이걸 만료 주소로 오판했다.
const bzDelayedApp = `<!doctype html><html lang="ko"><body style="margin:0"><div>카드영수증 준비 중</div>
<script>setTimeout(function () {
  var f = document.createElement('iframe'); f.src = '/receipt_shell.act';
  f.style = 'width:100%;height:700px;border:0'; document.body.appendChild(f);
}, 2200);<\/script></body></html>`;

const bzFrame = `<!doctype html><html lang="ko"><body style="font-family:sans-serif">
<div>
  조회기간
  <input id="START_DT"><input id="SHOW_START_DT"><input id="BASE_START_DT">
  <input id="END_DT"><input id="SHOW_END_DT"><input id="BASE_END_DT">
</div>
<!-- 실물 그대로: 조회기간이 대상월 밖까지 걸려 있고, 표에는 id가 없다. -->
<div>조회기간 2026-06-01 ~ 2026-07-31</div>
<div>결의상태 전체(${BZ_ROWS.length + BZ_FILLER.length + 2}) | <span id="tab-wait" style="cursor:pointer">대기(${BZ_ROWS.length + BZ_FILLER.length})</span> | 진행(2) | 완료(0)</div>
<div id="paging_size"><span class="btn_combo_down">▾</span><ul><li><a href="#">100</a></li><li><a href="#">200</a></li></ul></div>
<button id="make-approval">결의서 작성</button>
<table><tbody id="rows"></tbody></table>
<script>
  var ROWS = ${JSON.stringify([...BZ_ROWS, ...BZ_OTHER_MONTH, ...BZ_FILLER])};
  // 실제 화면처럼 '대기' 탭을 눌러야 목록이 채워진다.
  document.getElementById('tab-wait').addEventListener('click', function () {
    document.getElementById('rows').innerHTML = ROWS.map(function (r, i) {
      var amt = r[3].toLocaleString('en-US');
      return '<tr><td><input type="checkbox"></td><td>' + (i + 1) + '</td><td>' + r[0] + '</td><td>' + r[1] +
             '</td><td>' + r[2] + '</td><td>승인</td><td>-</td><td>' + amt + '</td></tr>';
    }).join('');
  });
  document.getElementById('make-approval').addEventListener('click', function () {
    var f = document.createElement('iframe'); f.src = '/eapr_1001.act'; f.style='width:100%;height:500px'; document.body.appendChild(f);
  });
<\/script></body></html>`;

const bzApprovalModal = `<!doctype html><html lang="ko"><body>
${[0, 1].map((i) => `<div class="purpose_combo" id="TRAN_KIND_CD${i}">
  <input placeholder="선택"><a class="bt_purpose_cbList">목록보기</a>
  <a class="cb_item">야근교통비 (81200)</a><a class="cb_item">야근식비 (81300)</a></div>`).join('')}
<button id="attach">파일첨부</button><button id="request">결재요청</button>
<script>
document.getElementById('attach').onclick=function(){window.open('/upload.act')};
document.getElementById('request').onclick=function(){window.open('/approval_line.act')};
document.querySelectorAll('.cb_item').forEach(function(a){a.onclick=function(){a.parentElement.querySelector('input').value=a.textContent}});
<\/script></body></html>`;
const bzUpload = `<!doctype html><html><body><input type="file"><button id="upload">업로드</button>
<script>document.getElementById('upload').onclick=async function(){await fetch('/__expense_upload',{method:'POST'});window.close()}<\/script></body></html>`;
const bzApprovalLine = `<!doctype html><html><body><select id="APPRLINE_NM"><option>선택</option><option value="corp">법인카드 지출결의서</option></select>
<button id="ok">확인</button><script>document.getElementById('ok').onclick=async function(){await fetch('/__expense_submit',{method:'POST'});window.close()}<\/script></body></html>`;

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
    const path = req.url.split('?')[0];
    // 스크립트는 MIME이 맞아야 크롬이 실행한다 — writeHead 전에 처리한다.
    if (path === '/portal.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      return res.end(bzPortalJs);
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });

    // 카드영수증 앱은 회사별 하위 도메인(appplay.co.kr)에서 돈다 — 실물이 그랬다.
    if ((req.headers.host || '').includes('appplay')) {
      if (path === '/rcard_main.act') { rcardMainRequests++; return res.end(bzDelayedApp); }
      if (path === '/receipt_shell.act') return res.end(bzFrame);
      if (path === '/eapr_1001.act') return res.end(bzApprovalModal);
      if (path === '/upload.act') return res.end(bzUpload);
      if (path === '/approval_line.act') return res.end(bzApprovalLine);
      if (path === '/__expense_upload') { expenseUploadRequests++; return res.end('ok'); }
      if (path === '/__expense_submit') { expenseSubmitRequests++; return res.end('ok'); }
      return res.end('<!doctype html><body>appplay</body>');
    }

    // 비즈플레이 — 런처 → 앱 → 데이터 프레임
    if ((req.headers.host || '').includes('bizplay')) {
      if (path === '/main_0003_01.act') return res.end(bzLauncher);
      if (path === '/apps_frame.act') return res.end(bzApps);
      if (path === '/portal.js') return res.end(bzPortalJs);   // MIME는 위 writeHead에서 정해진 대로 두면 크롬이 안 먹으므로 아래 분기 참고
      if (path === '/eusr_app.act') return res.end(bzApp);
      if (path === '/eusr_9001.act') return res.end(bzFrame);
      return res.end('<!doctype html><body>비즈플레이</body>');
    }

    if (path === '/') return res.end(loginLanding);          // openLoginAndWait가 연 로그인 창
    if (path === '/__done') { loggedIn = true; return res.end('<!doctype html><body>로그인 완료</body>'); } // 성공 → 비밀번호칸 없음
    if (!loggedIn) return res.end(loginPage);                 // 로그아웃 상태에서 데이터 요청 → 로그인 폼
    if (path === '/__correction_submit') { correctionSubmitRequests++; return res.end('ok'); }
    if (path === '/InOutMng/InOutModify') return res.end(correctionModifyPage);
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
        ...HEADLESS_ARGS,
`--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    `--host-resolver-rules=MAP user.timeinout.kr 127.0.0.1:${PORT},MAP api.flow.team 127.0.0.1:${PORT},MAP www.bizplay.co.kr 127.0.0.1:${PORT},MAP webank.appplay.co.kr 127.0.0.1:${PORT}`,
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
// 실행 기록 — 스크린샷 대신 "무엇을 봤는지"가 단계별로 쌓여야 한다.
const traceInfo = await page.evaluate(() => {
  const d = document.querySelector('details.trace');
  if (!d) return null;
  d.open = true;
  return {
    steps: [...d.querySelectorAll('.tr-step .tr-hd')].map((e) => e.textContent.replace(/\s+/g, ' ').trim()),
    text: d.innerText.replace(/\s+/g, ' '),
  };
});
console.log('\n── 실행 기록 ──');
if (traceInfo) { for (const st of traceInfo.steps) console.log('  ' + st); }
else console.log('  (없음)');
checks.push(
  ['실행 기록 표시', !!traceInfo && traceInfo.steps.length >= 3],
  ['실행 기록에 읽은 주소', !!traceInfo && /user\.timeinout\.kr/.test(traceInfo.text)],
  ['실행 기록에 화면의 월', !!traceInfo && /2026년 6월/.test(traceInfo.text)],
  ['실행 기록에 제외 사유', !!traceInfo && /합계에서 제외/.test(traceInfo.text)]);

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
// 결과를 보는 것만으로는 쓰지 않고, 확인 버튼 두 번 뒤에만 실제 수정 요청이 나가야 한다.
await page.click('#correction-submit-open');
const correctionConfirmVisible = await page.$eval('#correction-submit-confirm', (e) => !e.hidden);
const noCorrectionBeforeConfirm = correctionSubmitRequests === 0;
await page.click('#correction-submit-go');
await page.waitForSelector('#view-result:not([hidden])', { timeout: 60000 });
const correctionSubmitText = await page.$eval('#view-result', (e) => e.innerText.replace(/\s+/g, ' '));
const correctionSubmitOk = /정정 신청 결과/.test(correctionSubmitText)
  && correctionSubmitRequests === crRows.length && /실패 0건/.test(correctionSubmitText);
console.log('  확인 전 쓰기 없음:', noCorrectionBeforeConfirm ? '✓' : '✗', '· 확인 UI:', correctionConfirmVisible ? '✓' : '✗',
  '· 실제 신청:', correctionSubmitRequests, '건');
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
  ['정정 확인 전 쓰기 없음', noCorrectionBeforeConfirm && correctionConfirmVisible],
  ['정정 확인 후 실제 신청', correctionSubmitOk],
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

// ── 야근택시·야근식비 (가짜 비즈플레이) ──
// 런처 → window.open 가로채기 → eusr_9001 프레임 → '대기' 목록 → 근태 대조까지 전 구간.
async function runExpense(id, month = '2026-06') {
  await page.goto(`chrome-extension://${extId}/page/index.html`);
  await page.waitForSelector(`.auto[data-id="${id}"]`);
  await page.$eval('#month', (el) => { el.value = '2026-06'; });
  await page.click(`.auto[data-id="${id}"]`);
  await page.waitForSelector('#view-result:not([hidden])', { timeout: 90000 })
    .catch(async () => { throw new Error(`${id} 실패 — 오류창: ` + await page.$eval('#run-err', (e) => e.innerText).catch(() => '?')); });
  await page.waitForTimeout(300);
  return {
    kpis: await page.$eval('.kpis', (e) => e.innerText.replace(/\s+/g, ' ')),
    rows: await page.$$eval('#ex-rows .cr-row', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim())),
  };
}

console.log('\n── 야근택시 조회 ──');
const yagun = await runExpense('yagun');
const noExpenseBeforeTaxiConfirm = expenseSubmitRequests === 0;
await page.click('#expense-submit-open');
const taxiConfirmVisible = await page.$eval('#expense-submit-confirm', (e) => !e.hidden);
await page.click('#expense-submit-go');
await page.waitForFunction(() => /상신 완료/.test(document.getElementById('view-result')?.innerText || ''), { timeout: 90000 });
const taxiSubmitOk = expenseSubmitRequests === 1 && expenseUploadRequests === 1;
// 실행 중 "무엇을 시도했는지"가 실시간으로 쌓였는지 — 오래 걸리는 단계에서 멈춘 건지
// 도는 건지 사용자가 구분할 수 있어야 한다. (결과로 넘어가면 사라지므로 다시 한 번 관찰)
await page.goto(`chrome-extension://${extId}/page/index.html`);
await page.waitForSelector('.auto');
await page.$eval('#month', (el) => { el.value = '2026-06'; });
await page.click('.auto[data-id="yagun"]');
await page.waitForFunction(() => {
  const b = document.getElementById('run-live');
  return b && !b.hidden && b.children.length > 0;
}, { timeout: 20000 }).catch(() => {});
const liveLines = await page.$$eval('#run-live div', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
console.log('\n── 실행 중 시도 로그 ──');
for (const l of liveLines.slice(0, 6)) console.log('  ' + l);
checks.push(['실행 중 시도 로그 표시', liveLines.length > 0]);
await page.waitForSelector('#view-result:not([hidden])', { timeout: 90000 }).catch(() => {});
console.log('요약:', yagun.kpis);
for (const r of yagun.rows) console.log('  ', r);
// 택시 4건 중 심야 3건만 후보. 그중 06-02(초과 있음)·06-13(휴일근무) 2건이 증빙 O.
const yagunOk = /증빙 있음/.test(yagun.kpis) && yagun.rows.length === 3
  && yagun.rows.filter((r) => r.endsWith('✓')).length === 2   // '그날 야근 기록 없음'도 '야근'을 포함하므로 배지로 센다
  && !yagun.rows.some((r) => /SKT/.test(r));            // 19시 택시는 후보에서 빠져야 한다

console.log('\n── 야근식비 조회 ──');
const yasik = await runExpense('yasik');
console.log('요약:', yasik.kpis);
for (const r of yasik.rows) console.log('  ', r);
const beforeMealSubmit = expenseSubmitRequests;
await page.click('#expense-submit-open');
const mealConfirmVisible = await page.$eval('#expense-submit-confirm', (e) => !e.hidden);
await page.click('#expense-submit-go');
await page.waitForFunction(() => /상신 완료/.test(document.getElementById('view-result')?.innerText || ''), { timeout: 90000 });
const mealSubmitOk = expenseSubmitRequests === beforeMealSubmit + 1 && expenseUploadRequests === 1;
// 5건 후보(점심·고액 제외). 저녁+야근 1건, 조식+이른출근 1건 = 인정 2건.
const yasikOk = /인정/.test(yasik.kpis) && yasik.rows.length === 5
  && yasik.rows.filter((r) => r.endsWith('✓')).length === 2
  && !yasik.rows.some((r) => /한솥|삼겹살/.test(r))     // 점심시간·13,000원 초과는 후보에서 제외
  && /파리바게뜨/.test(yasik.rows.join(' '))            // 조식 인정 분기가 실제로 돈다
  && /김밥천국/.test(yasik.rows.join(' '));             // 저녁 인정 분기가 실제로 돈다

checks.push(['야근택시 수집·증빙 판정', yagunOk], ['야근식비 수집·인정 판정', yasikOk],
  ['야근택시 확인 전 쓰기 없음', noExpenseBeforeTaxiConfirm && taxiConfirmVisible],
  ['야근택시 증빙 첨부·결재 상신', taxiSubmitOk],
  ['야근식비 상신 확인 UI', mealConfirmVisible],
  ['야근식비 결재 상신', mealSubmitOk]);

// 앱 주소를 기억해 두는지 — 이 타일은 확장이 못 누르므로(진짜 클릭만 받음)
// 한 번 연 주소를 저장해 다음부터 바로 여는 게 유일한 길이다.
const savedAppUrl = await page.evaluate(() => new Promise((r) => {
  chrome.storage.local.get('bizplayCardAppUrl', (v) => r(v.bizplayCardAppUrl || ''));
}));
console.log('\n── 기억한 카드영수증 앱 주소 ──');
console.log('  ' + (savedAppUrl || '(없음)'));
checks.push(['앱 주소 기억(다른 도메인)', /webank\.appplay\.co\.kr\/rcard_main/.test(savedAppUrl)]);

// 기억한 주소로 다시 돌리면 클릭 경로를 아예 건너뛰고 열려야 한다.
const again = await runExpense('yagun');
const reusedTrace = await page.evaluate(() => {
  const d = document.querySelector('details.trace');
  if (!d) return '';
  d.open = true;
  return d.innerText.replace(/\s+/g, ' ');
});
console.log('  재실행 결과:', again.kpis);
checks.push(['기억한 주소로 재실행', again.rows.length === 3],
  ['재실행이 기억해 둔 주소를 씀', /기억해 둔 주소/.test(reusedTrace)]);
// 사람이 앱을 열어 두고 버튼을 눌렀을 때 주소를 잡는지.
// 이 감시는 패널에서 돈다 — 서비스 워커에 두면 몇 분 폴링 도중 종료돼 응답이 안 온다.
await page.evaluate(() => new Promise((r) => chrome.storage.local.remove('bizplayCardAppUrl', r)));
const appTab = await ctx.newPage();
await appTab.goto('https://webank.appplay.co.kr/rcard_main.act').catch(() => {});
await appTab.waitForTimeout(2800);
const grabbed = await page.evaluate(async () => {
  const isReceiptListPage = () => {
    const t = document.body ? document.body.innerText || '' : '';
    if (/대기\s*\(\d+\)/.test(t) || /결의상태/.test(t)) return true;
    return [...document.querySelectorAll('table tr')].some((tr) =>
      tr.querySelectorAll('td').length >= 8 && /\d{4}-\d{2}-\d{2}/.test(tr.innerText || ''));
  };
  const tabs = await chrome.tabs.query({ url: ['https://www.bizplay.co.kr/*', 'https://*.appplay.co.kr/*'] });
  for (const t of tabs) {
    if (!t.url || /main_0003|bizpr_main/.test(t.url)) continue;
    const hits = await chrome.scripting.executeScript({ target: { tabId: t.id, allFrames: true }, func: isReceiptListPage }).catch(() => []);
    if ((hits || []).some((h) => h.result)) return t.url;
  }
  return '';
});
console.log('\n── 열려 있는 앱에서 주소 잡기 ──');
console.log('  ' + (grabbed || '(못 잡음)'));
checks.push(['열려 있는 앱 주소 인식', /rcard_main/.test(grabbed)]);

// 이미 정상 목록이 열린 탭이 있으면 새 GET 탭을 만들지 말고 그 문맥을 사용해야 한다.
// 사용자 탭이므로 수집 뒤에도 닫히면 안 된다.
await page.evaluate((url) => new Promise((r) => chrome.storage.local.set({ bizplayCardAppUrl: url }, r)), grabbed);
const rcardRequestsBeforeOpenTabRun = rcardMainRequests;
const openTabRun = await runExpense('yagun');
const userAppTabKept = !appTab.isClosed();
const noNewRcardRequest = rcardMainRequests === rcardRequestsBeforeOpenTabRun;
console.log('  열린 탭으로 조회:', /증빙 있음/.test(openTabRun.kpis) ? '✓' : '✗',
  '· 새 GET 없음:', noNewRcardRequest ? '✓' : '✗', '· 사용자 탭 유지:', userAppTabKept ? '✓' : '✗');
checks.push(['이미 열린 카드영수증 탭으로 조회', noNewRcardRequest && /증빙 있음/.test(openTabRun.kpis)],
  ['조회 뒤 사용자 카드영수증 탭 유지', userAppTabKept]);
await appTab.close();


// 자동화 5개 전부 상단바 제목이 제 이름으로 바뀌는지.
// 제목은 start()에서 실행 전에 세워지므로 수집이 성공할 필요가 없다 —
// 비즈플레이를 안 띄운 채로도 야근택시·야근식비까지 확인할 수 있다.
// 버전이 홈 푸터에 보이는지 — 화면 캡처만으로 빌드를 판별할 수 있어야 한다.
await page.goto(`chrome-extension://${extId}/page/index.html`);
await page.waitForSelector('.auto');
const shownVer = await page.$eval('#app-ver', (e) => e.textContent.trim()).catch(() => '');
console.log('\n── 상단바 버전 ──');
console.log('  ' + (shownVer || '(없음)'));
checks.push(['상단바에 버전 표시', /^v\d+\.\d+\.\d+/.test(shownVer)]);

// 자동화 카드의 이름과 설명이 각자 줄을 갖는지. span에 display를 안 주면 한 줄로 붙어 흐른다.
const cardLines = await page.$$eval('#auto-list-wrap .auto', (els) => els.map((e) => {
  const lb = e.querySelector('.lb').getBoundingClientRect();
  const sb = e.querySelector('.sb').getBoundingClientRect();
  return { label: e.querySelector('.lb').textContent.trim(), stacked: sb.top >= lb.bottom - 1 };
}));
console.log('\n── 자동화 카드 조판 ──');
for (const c of cardLines) console.log(`  ${c.stacked ? '✓' : '✗'} ${c.label}`);
checks.push(['카드 이름·설명이 두 줄로', cardLines.every((c) => c.stacked)]);

// 늦게 끝난 실행이 지금 보고 있는 화면을 덮으면 안 된다.
// 야근택시를 띄워 두고 목록으로 나간 뒤, 그 실행이 끝나도 홈이 그대로여야 한다.
await page.click('.auto[data-id="yagun"]');
await page.waitForSelector('#view-run:not([hidden])');
await page.click('#back');
await page.waitForSelector('#view-home:not([hidden])');
await page.waitForTimeout(6000);
const stillHome = await page.evaluate(() => ({
  home: !document.getElementById('view-home').hidden,
  title: document.getElementById('brand-name').textContent.trim(),
}));
console.log('\n── 늦게 끝난 실행이 화면을 덮는가 ──');
console.log(`  홈 유지: ${stillHome.home} · 제목: ${stillHome.title}`);
checks.push(['늦게 끝난 실행이 화면을 안 덮음', stillHome.home && stillHome.title === 'Webwing']);

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
