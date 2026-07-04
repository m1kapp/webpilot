// 공용: 크롬 인스턴스 재사용 + 스냅샷 캡처 (레시피들이 공유)
import { chromium } from 'playwright';

let _browser = null;
export async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;
  // 시스템 크롬 우선 사용(배포 시 Playwright 크로미움 ~150MB 번들 불필요).
  // 크롬 미설치 환경은 번들 크로미움으로 fallback.
  try {
    _browser = await chromium.launch({ channel: 'chrome', headless: true });
  } catch (e) {
    console.error('[browser] 시스템 크롬 없음 → 번들 크로미움 사용:', e.message.split('\n')[0]);
    _browser = await chromium.launch({ headless: true });
  }
  return _browser;
}
export async function closeBrowser() { if (_browser) { await _browser.close().catch(() => {}); _browser = null; } }

// 전체 페이지 캡처 → base64. arr.onSnap 있으면 캡처 즉시 스트리밍 콜백
export async function snap(page, label, arr) {
  if (!arr) return;
  try {
    const buf = await page.screenshot({ type: 'jpeg', quality: 52, fullPage: true });
    const s = { label, url: page.url(), img: 'data:image/jpeg;base64,' + buf.toString('base64') };
    arr.push(s);
    if (arr.onSnap) arr.onSnap(s);
  } catch {}
}
