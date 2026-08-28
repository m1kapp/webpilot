// wisehrd 영상 자동 진행 실검: 확장 로드 → 법정의무교육 → 사번 → 안전보건 "영상 자동 진행" → 팝업/재생/차시 상태 관측.
// 본인인증 필요하면 그 지점에서 멈춰 report. (headful=new 로 팝업 window.open 이 동작하는지도 본다)
import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
const EXT = join(process.cwd(), 'extension');
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'wp-wise-')), { headless: false, args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
const extId = new URL(sw.url()).host;
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('[console]', m.text()); });
await page.goto(`chrome-extension://${extId}/page/index.html`);
await page.waitForSelector('.auto[data-id="edu"]', { timeout: 10000 });
await page.click('.auto[data-id="edu"]');
await page.waitForSelector('#edu-id-input', { timeout: 20000 });
await page.fill('#edu-id-input', (process.env.EDU_EMPNO || (()=>{throw new Error('EDU_EMPNO 환경변수에 사번을 넣어주세요')})()));
await page.click('#run-retry');
await page.waitForSelector('#view-result:not([hidden]) .edu-row', { timeout: 120000 });
console.log('courses loaded');
await page.click('[data-wise]');
const t0 = Date.now(); let last = '';
while (Date.now() - t0 < 70000) {
  await page.waitForTimeout(3000);
  const txt = await page.$eval('#edu-watch', (b) => b.innerText.replace(/\n/g, ' | ')).catch(() => '');
  if (txt !== last) { console.log(`[${Math.round((Date.now()-t0)/1000)}s]`, txt); last = txt; }
  const tabs = (await ctx.pages()).map((p) => p.url());
  if (tabs.some((u) => /course\/player\.jsp/.test(u))) { console.log('PLAYER POPUP OPEN', tabs.find((u)=>/player\.jsp/.test(u)).slice(0,90)); }
  if (/본인인증|시험은 직접|완료|열지 못|열리지/.test(txt)) break;
}
console.log('tabs:', (await ctx.pages()).map((p) => p.url().slice(0, 80)));
await ctx.close();
