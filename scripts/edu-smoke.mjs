// 법정의무교육 실사이트 스모크(가짜 서버 없음 — 실제 사이버연수원에 사번으로 로그인한다).
// 확장 로드 → 법정의무교육 실행 → 사번 입력 → 과정 목록 → 자동 학습 시작 → 한 편이 끝나 다음 편으로 넘어가는지 관측 → 중지.
// 실제 진도가 1~2분 쌓이고, 같은 사번으로 열려 있던 다른 브라우저 세션은 끊긴다("동일 아이디 접속").
//   EDU_EMPNO=M00000000 npm run ext:edu-smoke
import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const EXT = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const workdir = mkdtempSync(join(tmpdir(), 'wp-edu-'));
const ctx = await chromium.launchPersistentContext(join(workdir, 'profile'), {
  headless: false,
  args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
const extId = new URL(sw.url()).host;
sw.on('console', (m) => console.log('[sw]', m.text()));
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('[console]', m.text()); });
await page.goto(`chrome-extension://${extId}/page/index.html`);
await page.waitForSelector('#view-home:not([hidden]) .auto', { timeout: 15000 });
console.log('home cards:', await page.$$eval('.auto', (a) => a.map((b) => b.dataset.id)));
await page.click('.auto[data-id="edu"]');
await page.waitForSelector('#edu-id-input', { timeout: 20000 });
console.log('prompt shown');
const EMPNO = process.env.EDU_EMPNO || '';
if (!EMPNO) { console.error('EDU_EMPNO 환경변수에 사번을 넣어주세요'); await ctx.close(); process.exit(2); }
await page.fill('#edu-id-input', EMPNO);
await page.click('#run-retry');
{
  const t0 = Date.now(); let last = '';
  while (Date.now() - t0 < 90000) {
    await page.waitForTimeout(4000);
    if (await page.isVisible('#view-result:not([hidden]) .edu-row').catch(() => false)) break;
    const txt = await page.evaluate(() => ['steps', 'run-live', 'run-err'].map((id) => document.getElementById(id)?.innerText || '').join(' || ').replace(/\n/g, ' | '));
    if (txt !== last) { console.log(`[run ${Math.round((Date.now() - t0) / 1000)}s]`, txt); last = txt; }
    if (await page.isVisible('#run-err:not([hidden])').catch(() => false) && /막혔|실패|필요/.test(txt)) break;
  }
  console.log('bg tabs:', (await ctx.pages()).map((p) => p.url().slice(0, 100)));
  if (!(await page.isVisible('#view-result:not([hidden]) .edu-row').catch(() => false))) { await ctx.close(); process.exit(1); }
}
const rows = await page.$$eval('.edu-row', (rs) => rs.map((r) => r.innerText.replace(/\n/g, ' | ')));
console.log('ROWS\n' + rows.join('\n'));
console.log('KPI', await page.$eval('.kpis', (k) => k.innerText.replace(/\n/g, ' | ')));
// 자동 학습 시작
await page.click('#edu-run-all');
const t0 = Date.now();
let last = '', firstPage = '', m = null;
while (Date.now() - t0 < 100000) {
  await page.waitForTimeout(3000);
  const txt = await page.$eval('#edu-watch', (b) => b.innerText.replace(/\n/g, ' | ')).catch(() => '');
  if (txt !== last) { console.log(`[${Math.round((Date.now() - t0) / 1000)}s]`, txt); last = txt; }
  if (!firstPage && (m = txt.match(/(\d+)\/(\d+)편/))) firstPage = m[1];
  else if (firstPage && (m = txt.match(/(\d+)\/(\d+)편/)) && m[1] !== firstPage) { console.log(`ADVANCED ${firstPage} → ${m[1]}`); break; }
  if (/멈춤|응답하지|열지 못/.test(txt)) break;
}
console.log('tabs:', (await ctx.pages()).map((p) => p.url().slice(0, 90)));
await page.click('#ew-stop').catch(() => {});
await page.waitForTimeout(1500);
console.log('after stop:', await page.$eval('#edu-watch', (b) => b.innerText.replace(/\n/g, ' | ')).catch(() => ''));
console.log('tabs after stop:', (await ctx.pages()).map((p) => p.url().slice(0, 60)));
await ctx.close();
