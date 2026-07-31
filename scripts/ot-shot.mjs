// 초과근무 차트 밀도 확인용. 한 달 꽉 채운 가짜 타임인아웃을 띄우고
// 사이드 패널 폭(400)과 새 탭 폭(1100) 둘 다 찍는다.
import { chromium } from 'playwright';
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const wd = mkdtempSync(join(tmpdir(), 'o-')), PORT = 18456;

// 2026-07 한 달(31일). 라벨이 가장 빽빽한 경우라 겹침 검사에 좋다.
const pad = (n) => String(n).padStart(2, '0');
const DOW = ['월','화','수','목','금','토','일'];
const CARDS = [];
for (let d = 1; d <= 31; d++) {
  const dow = DOW[(d + 1) % 7];            // 2026-07-01 = 수
  const weekend = dow === '토' || dow === '일';
  if (d === 4 || d === 17) continue;        // 기록 누락 이틀
  if (weekend && d % 3 !== 0) continue;     // 주말은 가끔만 출근
  const inH = 9 + (d % 3) * 0.5;
  const outH = weekend ? inH + 6 : 18 + (d % 7) * 1.4;   // 어떤 날은 24시 넘김
  const t = (h) => `${pad(Math.floor(h) % 24)}:${pad(Math.round((h % 1) * 60))}:00`;
  const recog = Math.max(0, outH - inH - 1.5);
  CARDS.push([`07.${pad(d)}`, dow, t(inH), t(outH), `${Math.floor(recog)}시간 ${pad(Math.round((recog % 1) * 60))}분`]);
}
const hist = `<!doctype html><body><div>2026년 7월</div>${CARDS.map(([md, dw, i, o, r], k) =>
  `<div><a href="/InOutMng/InOutDetail/${k}">${md} (${dw}) IN ${i} OUT ${o} 인정 시간 ${r} 출근 상태 정상 퇴근 상태 정상 비업무 -</a></div>`).join('')}</body>`;

execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=user.timeinout.kr','-keyout',join(wd,'k'),'-out',join(wd,'c')], { stdio: 'ignore' });
const srv = createServer({ key: readFileSync(join(wd,'k')), cert: readFileSync(join(wd,'c')) }, (rq, rs) => {
  rs.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  const p = rq.url.split('?')[0];
  if (p === '/InOutMng/InOutHistory') return rs.end(hist);
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
const id = new URL(sw.url()).host;
const pg = await ctx.newPage();
const errs = [];
pg.on('pageerror', (e) => errs.push(String(e)));
pg.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

await pg.setViewportSize({ width: 400, height: 1400 });
await pg.goto(`chrome-extension://${id}/page/index.html`);
await pg.waitForSelector('.auto');
await pg.$eval('#month', (e) => { e.value = '2026-07'; });
await pg.click('.auto[data-id="overtime"]');
await pg.waitForSelector('#view-result:not([hidden]) #clock', { timeout: 30000 });
await pg.waitForTimeout(700);
await pg.screenshot({ path: '/tmp/ot-narrow.png', fullPage: true });
// 실행 기록은 결과 맨 아래에 접혀 있다. 펼쳐서 그 요소만 따로 찍는다
// (.body 안쪽이 스크롤 컨테이너라 fullPage로는 아래가 안 잡힌다).
await pg.evaluate(() => {
  const d = document.querySelector('details.trace');
  if (d) { d.open = true; d.scrollIntoView({ block: 'start' }); }
});
await pg.waitForTimeout(300);
await pg.locator('details.trace').screenshot({ path: '/tmp/ot-trace.png' }).catch(() => {});

// 캔버스가 실제로 뭔가 그렸는지(전부 투명이면 실패)
const painted = await pg.$eval('#clock', (c) => {
  const x = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0; for (let i = 3; i < x.length; i += 4) if (x[i] > 0) n++;
  return { w: c.width, h: c.height, filledPct: +(n / (x.length / 4) * 100).toFixed(1) };
});
const legend = await pg.$eval('#clock-legend', (e) => e.textContent.trim());
const scrollX = await pg.evaluate(() => document.querySelector('.body').scrollWidth > document.querySelector('.body').clientWidth);

// 툴팁 한 번 띄워보기
await pg.hover('#clock');
await pg.waitForTimeout(200);
const tipShown = await pg.$eval('#clock-tip', (e) => !e.hidden && e.textContent.trim());

// 날짜 라벨 겹침 — 폭에 따라 stride가 달라지므로 사이드 패널부터 넓은 탭까지 훑는다.
// 예전에는 말일을 무조건 그려서 폭이 특정 구간일 때 30·31이 "3031"로 뭉갰다.
const overlaps = [];
for (let w = 360; w <= 1100; w += 20) {
  await pg.setViewportSize({ width: w, height: 1000 });
  await pg.waitForTimeout(120);
  const bad = await pg.$eval('#clock', (c) => {
    const L = (c.__geom && c.__geom.labels) || [];
    const hit = [];
    for (let i = 1; i < L.length; i++) if (L[i].left < L[i - 1].right) hit.push(`${L[i - 1].day}·${L[i].day}`);
    return { hit, days: L.map((x) => x.day) };
  });
  if (bad.hit.length) overlaps.push({ 폭: w, 겹침: bad.hit, 라벨: bad.days.join(',') });
}

await pg.setViewportSize({ width: 1100, height: 1000 });
await pg.waitForTimeout(600);
await pg.screenshot({ path: '/tmp/ot-wide.png', fullPage: true });
const wideCanvas = await pg.$eval('#clock', (c) => ({ w: c.width, h: c.height }));

console.log(JSON.stringify({ 캔버스_좁음: painted, 캔버스_넓음: wideCanvas, 범례: legend, 툴팁: tipShown,
  가로스크롤: scrollX, 라벨겹침: overlaps.length ? overlaps : '없음(360~1100px)', 오류: errs }, null, 2));
if (overlaps.length || errs.length) process.exitCode = 1;
await ctx.close(); srv.close();
