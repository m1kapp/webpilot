// 백그라운드 서비스 워커 — server.mjs의 라우트 자리를 대신한다.
// 서비스 워커는 놀면 종료되므로 전역 변수에 상태를 담지 않는다(필요하면 chrome.storage).
import { getLeaveStatus } from './lib/timeinout.js';
import { getOvertime } from './lib/overtime.js';
import { getCorrectionTargets } from './lib/correction.js';
import { getYagunTaxi, getYasik } from './lib/bizplay.js';
import { getFlowKey, setFlowKey, verifyFlowKey } from './lib/flow.js';
import { openLoginAndWait } from './lib/tab.js';

// 자동화 레지스트리 — 메시지 타입 → 실행 함수. 새 자동화는 여기 한 줄.
const RUNNERS = {
  'leave-personal': (msg, progress) => getLeaveStatus(msg.year, progress),
  'overtime': (msg, progress) => getOvertime(msg.month, progress),
  'correction': (msg, progress) => getCorrectionTargets(msg.month, progress),
  'yagun': (msg, progress) => getYagunTaxi(msg.month, progress),
  'yasik': (msg, progress) => getYasik(msg.month, progress),
};

// 툴바 아이콘 → 사이드 패널. 팝업과 달리 다른 곳을 클릭해도 닫히지 않아
// 조회가 끝날 때까지 살아 있고, 탭을 옮겨 다녀도 열린 채로 따라온다.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  // 막혀서 뜬 "로그인하기" — 로그인 페이지를 열고 완료될 때까지 기다렸다가 알린다.
  // 패널은 이 응답을 받으면 곧바로 자동화를 재실행한다.
  if (msg?.type === 'login') {
    openLoginAndWait(msg.loginUrl)
      .then((ok) => reply({ ok }))
      .catch(() => reply({ ok: false }));
    return true;
  }

  // Flow API 키 — 설정 화면에서 읽기/저장/검증
  if (msg?.type === 'flow-key-get') { getFlowKey().then((key) => reply({ ok: true, hasKey: !!key })); return true; }
  if (msg?.type === 'flow-key-save') {
    verifyFlowKey(msg.key).then(() => setFlowKey(msg.key)).then(() => reply({ ok: true }))
      .catch((e) => reply({ ok: false, error: e.message }));
    return true;
  }

  // 자동화 실행
  const run = RUNNERS[msg?.type];
  if (!run) return;
  const progress = (text) => chrome.runtime.sendMessage({ type: 'progress', text }).catch(() => {});
  run(msg, progress)
    .then((data) => reply({ ok: true, data }))
    .catch((e) => reply({ ok: false, error: e.message || String(e),
      needsLogin: e.needsLogin || null, needsFlowKey: e.needsFlowKey || null,
      detail: e.detail || (e.stack ? String(e.stack).split('\n').slice(0, 3).join('\n') : '') }));
  return true; // 비동기 응답
});
