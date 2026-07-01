// 레시피: 타임인아웃 로그인 → 초과근무 현황 파악
// 실행: node src/recipes/timeinout.mjs        (headed, 화면 보임)
//       HEADLESS=1 node src/recipes/timeinout.mjs
import 'dotenv/config';
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const ACCOUNT = (process.env.TIMEINOUT_ACCOUNT || 'admin').toLowerCase(); // admin | user
const HOSTS = { admin: 'https://com.timeinout.kr/', user: 'https://user.timeinout.kr/' };
const LOGIN_URL = HOSTS[ACCOUNT];
const ID = process.env.TIMEINOUT_ID;
const PW = process.env.TIMEINOUT_PW;
const OUT = process.env.SCRATCH || '.';

if (!ID || !PW) {
  console.error('❌ .env 에 TIMEINOUT_ID / TIMEINOUT_PW 를 넣어주세요.');
  process.exit(1);
}
mkdirSync('.auth', { recursive: true });

const browser = await chromium.launch({ headless: !!process.env.HEADLESS, slowMo: 120 });
const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const page = await context.newPage();

console.log(`▶ [${ACCOUNT}] 로그인 시도: ${LOGIN_URL}`);
await page.goto(LOGIN_URL, { waitUntil: 'networkidle' });

// 팝업 닫기
for (const t of ['팝업 창 닫기', '닫기']) {
  await page.getByRole('button', { name: t }).first().click({ timeout: 800 }).catch(() => {});
}

await page.fill('input[name="Email"]', ID);
await page.fill('input[name="Password"]', PW);
await Promise.all([
  page.waitForLoadState('networkidle').catch(() => {}),
  page.getByRole('button', { name: '로그인' }).first().click(),
]);
await page.waitForTimeout(2500);

const url = page.url();
const stillLogin = /login/i.test(url) || await page.locator('input[name="Password"]').count() > 0;
await page.screenshot({ path: `${OUT}/after-login.png`, fullPage: true });

if (stillLogin) {
  const err = await page.locator('.field-validation-error, .validation-summary-errors, .alert').first().innerText().catch(() => '');
  console.error(`❌ 로그인 실패로 보임. 현재 URL: ${url}\n메시지: ${err}`);
  console.error('   스크린샷: after-login.png (비번 오류/비번변경 요구/추가인증 여부 확인)');
} else {
  await context.storageState({ path: `.auth/timeinout-${ACCOUNT}.json` });
  console.log(`✅ 로그인 성공. URL: ${url}`);
  console.log(`   세션 저장됨: .auth/timeinout-${ACCOUNT}.json`);
  console.log('   대시보드 스크린샷: after-login.png');
}

// 다음 단계(초과근무 네비게이션)는 대시보드 구조 확인 후 이어서 작성
await page.waitForTimeout(process.env.HEADLESS ? 0 : 4000);
await browser.close();
