// Webwing · 안전보건교육(와이즈리더센터, kgeduone.wisehrd.com) 강의창 도우미.
// 이 LMS 는 앞 4과정(campus21)과 구조가 다르다:
//   - 차시별 영상이 window.open 팝업(player.jsp)으로 뜨고, 그 안 iframe(data/content/…/NNN.html)에 jPlayer video 가 있다.
//   - 진도 = 팝업이 열려 있던 실시간 초. 팝업이 닫힐 때 opener(강의실)가 progress_check.jsp 로 보낸다.
//   - 영상이 ended 되면 그 차시 수료가 커밋된다 → 팝업을 닫으면 opener 가 저장하고 목차를 새로고침한다.
// 그래서 이 도우미가 하는 일은 둘뿐:
//   ① 팝업 영상이 멈춰 있으면 다시 재생(1배속 그대로 — 배속·시간 조작 안 함).
//   ② 영상이 ended 되면 팝업 창을 닫아 opener 가 진도를 저장하게 한다.
// 상태는 opener(강의실 탭) 문서에 적어 사이드 패널이 읽게 한다.
(() => {
  // 팝업 안 콘텐츠 프레임에서만 동작(강의실/목차 페이지는 건드리지 않는다 — 거기 진도 타이머가 산다).
  const isContent = /\/data\/content\/[^/]+\/resources\/\d+\/\d+\.html?$/i.test(location.pathname);
  if (!isContent || window.__webwingWise) return;
  window.__webwingWise = true;

  let endedHandled = false, playTries = 0, lastT = -1, stalledSince = 0, lastUserAct = 0;
  ['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, () => { lastUserAct = Date.now(); }, true));

  // opener 체인: 콘텐츠프레임(this) → player.jsp 팝업(window.top) → 강의실(top.opener). 모두 같은 출처라 접근된다.
  function classroomDoc() {
    try { return window.top.opener ? window.top.opener.document : null; } catch { return null; }
  }
  function publish(extra) {
    const doc = classroomDoc();
    if (!doc) return;
    const v = document.querySelector('video');
    try {
      doc.documentElement.dataset.webwingWise = JSON.stringify({
        at: Date.now(),
        cur: v ? Math.floor(v.currentTime || 0) : 0,
        dur: v ? Math.floor(v.duration || 0) : 0,
        paused: v ? v.paused : true,
        ended: v ? v.ended : false,
        muted: v ? v.muted : false,
        ...extra,
      });
    } catch { /* 다른 출처면 조용히 */ }
  }

  function closePopup() {
    // player.jsp 팝업 창을 닫는다 → opener 의 setInterval 이 qResult.closed 를 보고 progress_check(type=2) 를 보낸다.
    try { window.top.close(); } catch { /* 무시 */ }
    try { window.close(); } catch { /* 무시 */ }
  }

  function onEnded() {
    if (endedHandled) return;
    endedHandled = true;
    publish({ phase: 'ended' });
    // 플랫폼의 ended 핸들러(parent.endTimeSave)가 끝 시각을 저장할 틈을 준 뒤 창을 닫는다.
    setTimeout(closePopup, 2500);
  }

  function nudge(v) {
    playTries += 1;
    Promise.resolve().then(() => v.play()).catch(() => {
      if (playTries < 2) return;
      v.muted = true; publish({ note: '음소거 재생' });
      Promise.resolve().then(() => v.play()).catch(() => {});
    });
  }

  let bound = false;
  function tick() {
    const v = document.querySelector('video');
    if (!v) { publish({ phase: 'loading' }); return; }
    if (!bound) { bound = true; v.addEventListener('ended', onEnded); }
    if (v.ended) { onEnded(); publish({ phase: 'ended' }); return; }
    const t = v.currentTime || 0;
    if (!v.paused && t !== lastT) { lastT = t; stalledSince = 0; }
    else {
      if (!stalledSince) stalledSince = Date.now();
      const userPaused = Date.now() - lastUserAct < 30000;
      if (!userPaused && Date.now() - stalledSince >= 4000 && playTries < 30) { stalledSince = Date.now(); nudge(v); }
    }
    publish({ phase: v.paused ? 'paused' : 'playing' });
  }
  setTimeout(() => { tick(); setInterval(tick, 1000); }, 1000);
})();
