// Playwright의 page 조작을 대신하는 얇은 어댑터.
// page.goto → openTab/goto, page.evaluate → evaluate, page.close → closeTab.
// 수집 코드가 이 세 개만 쓰도록 유지하면 데스크톱(Playwright) 쪽과 모양이 맞는다.

function waitComplete(tabId) {
  return new Promise((resolve) => {
    const onUpdated = (id, info) => {
      if (id !== tabId || info.status !== 'complete') return;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

// 수집 탭은 비활성(active:false)으로 현재 창 뒤에 연다 — 보던 화면을 절대 덮지 않는다.
// (별도 팝업 창은 macOS에서 최소화가 깔끔히 안 돼 화면을 덮어버려 폐기함.)
// 현재 탭 목록에 잠깐 항목이 생기지만 수집이 끝나면 closeTab이 지운다. 보통 몇 초.
export async function openTab(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  if (tab.status !== 'complete') await waitComplete(tab.id);
  return tab.id;
}

export async function goto(tabId, url) {
  await chrome.tabs.update(tabId, { url });
  await waitComplete(tabId);
}

// page.evaluate(fn, arg)와 같은 자리.
// 주의: func는 문자열로 직렬화돼 페이지로 건너간다 — 바깥 변수·import를 데려갈 수 없다.
// 페이지에서는 "원문만 꺼내고", 해석은 백그라운드에서 코어(src/core)로 한다.
export async function evaluate(tabId, func, args, { world } = {}) {
  // args를 넘기지 않은 호출에서 [undefined]가 되면 "Value is unserializable"로 실패한다 → 있을 때만 붙인다
  const injection = { target: { tabId }, func };
  if (args !== undefined) injection.args = [args];
  if (world) injection.world = world;
  const [res] = await chrome.scripting.executeScript(injection);
  return res?.result;
}

// 페이지 자신의 전역(window.open 등)을 건드려야 할 때. 기본 격리 월드에서 window.open을
// 바꿔 봐야 페이지의 onclick이 부르는 건 메인 월드 쪽이라 아무 효과가 없다.
// ⚠ 메인 월드는 페이지 스크립트와 같은 공간이다 — 읽고 되돌리는 짧은 조작에만 쓴다.
export const evaluateMain = (tabId, func, args) => evaluate(tabId, func, args, { world: 'MAIN' });

export async function closeTab(tabId) {
  await chrome.tabs.remove(tabId).catch(() => {});
}

// ── iframe 안(비즈플레이 카드영수증 앱 등)을 다루기 위한 헬퍼들 ──

// 클릭이 "새 탭"을 여는 경우(런처의 앱 클릭 등): 클릭 전 onCreated를 걸고, 뜬 탭이 로드 완료되면 그 id를 준다.
export async function clickOpensTab(tabId, clickFunc, args) {
  const created = new Promise((resolve) => {
    const onCreated = (tab) => { chrome.tabs.onCreated.removeListener(onCreated); resolve(tab.id); };
    chrome.tabs.onCreated.addListener(onCreated);
    // 안전장치: 12초 내 새 탭 없으면 null
    setTimeout(() => { chrome.tabs.onCreated.removeListener(onCreated); resolve(null); }, 12000);
  });
  await evaluate(tabId, clickFunc, args);
  const newId = await created;
  if (newId != null) await waitComplete(newId).catch(() => {});
  return newId;
}

// tabId 안의 프레임 중 url에 needle이 든 프레임의 frameId(없으면 로드될 때까지 재시도).
export async function findFrame(tabId, needle, { tries = 20, gap = 600 } = {}) {
  for (let i = 0; i < tries; i++) {
    const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => []);
    const f = (frames || []).find((fr) => (fr.url || '').includes(needle));
    if (f) return f.frameId;
    await new Promise((r) => setTimeout(r, gap));
  }
  return null;
}

// page.evaluate의 프레임 버전 — 특정 frameId 안에서 함수 실행.
export async function evaluateFrame(tabId, frameId, func, args) {
  const injection = { target: { tabId, frameIds: [frameId] }, func };
  if (args !== undefined) injection.args = [args];
  const [res] = await chrome.scripting.executeScript(injection);
  return res?.result;
}

// 로그인 여부 판정 — 세션을 빌려 쓰므로 매 수집의 첫 단계.
// URL만 보면 안 된다: 타임인아웃은 주소를 그대로 둔 채 로그인 폼을 렌더하는 경우가 있어
// 그때 "빈 결과"가 정상처럼 흘러가 버린다. 비밀번호 입력칸 유무가 가장 확실한 신호.
async function isLoginScreen(tabId) {
  const state = await evaluate(tabId, () => ({
    href: location.href,
    hasPasswordField: !!document.querySelector('input[type="password"]'),
  }));
  return /login/i.test(state?.href || '') || !!state?.hasPasswordField;
}

// 로그인 필요 상황을 구조화된 에러로 던진다 — 배경에서 잡아 "로그인하기" 흐름으로 잇는다.
export async function assertLoggedIn(tabId, serviceName, loginUrl) {
  if (await isLoginScreen(tabId)) {
    const err = new Error(`${serviceName}에 로그인되어 있지 않습니다. 로그인한 뒤 다시 실행해주세요.`);
    err.needsLogin = { service: serviceName, loginUrl };
    throw err;
  }
}

// 로그인 페이지를 (보이는) 탭으로 열고, 사용자가 로그인 완료(비밀번호칸 사라짐)할 때까지 폴링.
// 완료되면 그 탭을 닫는다. timeout(기본 3분) 넘으면 false.
export async function openLoginAndWait(loginUrl, { timeoutMs = 180000, pollMs = 1500 } = {}) {
  const tab = await chrome.tabs.create({ url: loginUrl, active: true });
  const deadline = Date.now() + timeoutMs;
  try {
    // 첫 로드 대기
    await new Promise((r) => setTimeout(r, 1200));
    while (Date.now() < deadline) {
      // 탭이 닫혔으면(사용자가 직접 닫음) 중단
      const live = await chrome.tabs.get(tab.id).catch(() => null);
      if (!live) return false;
      if (!(await isLoginScreen(tab.id).catch(() => true))) {
        await closeTab(tab.id);
        return true;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return false;
  } catch {
    return false;
  }
}
