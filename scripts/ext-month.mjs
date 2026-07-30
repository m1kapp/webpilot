// 월 이동 회귀 테스트.
// 예전 버그: 월 이동에 실패해도 조용히 현재 화면을 긁어 "요청한 달"로 내놨다.
// 6월을 요청했는데 7월 펀치가 6월 달력(토·일·현충일)에 얹혀 휴일근무 136시간이 나왔다.
// 그래서 두 가지를 본다 — 화살표가 먹는 화면에서는 제대로 옮겨가고,
// 안 먹는 화면에서는 틀린 숫자 대신 에러를 낸다.
import { chromium } from 'playwright';
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const wd = mkdtempSync(join(tmpdir(), 'o-')), PORT = 18457;

// 달마다 다른 펀치. 어느 달을 읽었는지 숫자만 보고 알 수 있게 출근 시각을 다르게 둔다.
const MONTHS = {
  6: [['06.01', '월', '09:00:00', '19:00:00'], ['06.02', '화', '09:00:00', '19:00:00']],
  7: [['07.01', '수', '11:00:00', '23:00:00'], ['07.02', '목', '11:00:00', '23:00:00']],
};
const cardsHTML = (mo) => MONTHS[mo].map(([md, dw, i, o], k) =>
  `<div><a href="/InOutMng/InOutDetail/${k}">${md} (${dw}) IN ${i} OUT ${o} 인정 시간 9시간 00분 출근 상태 정상 퇴근 상태 정상 비업무 -</a></div>`).join('');

// frozen=true면 화살표를 눌러도 아무 일도 안 일어난다(실제로 겪은 상황).
const page = (frozen) => `<!doctype html><body style="font-family:sans-serif">
<div style="display:flex;gap:12px;align-items:center">
  <span id="prev" style="cursor:pointer">◀</span>
  <span id="lbl">2026년 7월</span>
  <span id="next" style="cursor:pointer">▶</span>
</div>
<div id="cards">${cardsHTML(7)}</div>
<script>
  var mo = 7;
  var DATA = ${JSON.stringify(Object.fromEntries(Object.entries(MONTHS).map(([k]) => [k, cardsHTML(+k)])))};
  function go(step) {
    ${frozen ? 'return;' : ''}
    var next = mo + step;
    if (!DATA[next]) return;
    mo = next;
    document.getElementById('lbl').textContent = '2026년 ' + mo + '월';
    document.getElementById('cards').innerHTML = DATA[mo];
  }
  document.getElementById('prev').addEventListener('click', function () { go(-1); });
  document.getElementById('next').addEventListener('click', function () { go(1); });
<\/script></body>`;

let frozen = false;
execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=user.timeinout.kr','-keyout',join(wd,'k'),'-out',join(wd,'c')], { stdio: 'ignore' });
const srv = createServer({ key: readFileSync(join(wd,'k')), cert: readFileSync(join(wd,'c')) }, (rq, rs) => {
  rs.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  const p = rq.url.split('?')[0];
  if (p === '/InOutMng/InOutHistory') return rs.end(page(frozen));
  if (p === '/InOutMng/List') return rs.end('<body><ul></ul></body>');
  if (p === '/ApprovalMng/Index') return rs.end('<body></body>');
  if (p.startsWith('/Leave')) return rs.end('<body><ul class="card_list"></ul></body>');
  rs.end('<body></body>');
});
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));

const ctx = await chromium.launchPersistentContext(join(wd,'p'), {
  headless: false, ignoreHTTPSErrors: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
         `--host-resolver-rules=MAP user.timeinout.kr 127.0.0.1:${PORT}`, '--ignore-certificate-errors'],
});
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
const pg = await ctx.newPage();
await pg.goto(`chrome-extension://${new URL(sw.url()).host}/page/index.html`);
const ask = (month) => pg.evaluate((mo) => new Promise((resolve) => {
  chrome.runtime.sendMessage({ type: 'overtime', month: mo }, (r) => resolve(r));
}), month);

const fails = [];
const check = (name, ok, got) => { console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${got}`}`); if (!ok) fails.push(name); };

// ── 화살표가 정상인 화면 ──
console.log('\n── 월 이동 가능한 화면 ──');
const jul = await ask('2026-07');
check('7월(기본 화면) 조회', jul?.ok && jul.data.summary.wdOtText === '5시간 00분',
  jul?.ok ? jul.data.summary.wdOtText : jul?.error);

const jun = await ask('2026-06');
check('6월로 이동해 6월 데이터 반환', jun?.ok && jun.data.summary.wdOtText === '1시간 00분',
  jun?.ok ? `평일초과 ${jun.data.summary.wdOtText}` : jun?.error);
check('6월 펀치가 09:00~19:00', jun?.ok && jun.data.days[0]?.inText === '09:00',
  jun?.ok ? jun.data.days[0]?.inText : jun?.error);

// ── 화살표가 죽은 화면 ──
console.log('\n── 월 이동이 막힌 화면 ──');
frozen = true;
const stuck = await ask('2026-06');
check('틀린 달 결과 대신 에러', !stuck?.ok, stuck?.ok ? `조용히 통과함: 평일초과 ${stuck.data.summary.wdOtText}` : '');
check('에러에 목표월 명시', !stuck?.ok && /6월/.test(stuck?.error || ''), stuck?.error);
check('원인 설명 있음', !stuck?.ok && /7월/.test(stuck?.detail || ''), stuck?.detail?.slice(0, 60));
// 고치려면 실제 마크업이 필요하다. 에러에 그게 실려 오는지 본다.
check('월 라벨 요소 정보 포함', /월 라벨:/.test(stuck?.detail || ''), '(없음)');
check('라벨 좌우에 뭐가 있는지 포함', /라벨 좌우 좌표/.test(stuck?.detail || ''), '(없음)');
check('주변 클릭 후보 포함', /클릭 후보|prev|next/.test(stuck?.detail || ''), '(없음)');
console.log('\n── 에러에 실린 진단 ──');
console.log((stuck?.detail || '').split('\n').map((l) => '  ' + l).join('\n'));

await ctx.close(); srv.close();
console.log(fails.length ? `\n실패 ${fails.length}건: ${fails.join(', ')}` : '\n전부 통과');
process.exit(fails.length ? 1 : 0);
