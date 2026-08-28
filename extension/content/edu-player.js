// Webwing · 법정의무교육 강의창 도우미 — KG에듀원 사이버연수원(class*.campus21.co.kr)의
// 플레이어 프레임(/cpclassroom/onlinestudy/{과정}/{차시}/{페이지}.htm) 안에서만 돈다.
// manifest에서 world:MAIN 으로 주입한다 — 페이지의 player·nextpage·glb_* 전역을 직접 봐야 해서다.
//
// 하는 일
//   ① "이전 학습정보가 있습니다. 이어서 학습하시겠습니까?" confirm → 자동 수락(이어보기)
//   ② 한 편이 끝나면(video ended) 플랫폼 자체 nextpage() 를 불러 다음 편으로.
//      플랫폼은 서버 진도 마커(Finish=Y)를 확인한 뒤에만 넘겨준다 — 그 절차를 그대로 탄다.
//   ③ 뒤쪽 탭이라 자동재생이 막히면 음소거로라도 재생.
//   ④ 지금 상태를 top 문서의 dataset.webwingEdu 에 적어 사이드 패널이 읽게 한다.
//
// 하지 않는 일 — 배속·탐색바·진도 전송 조작. 서버 진도는 강의창이 열린 실시간 초로 쌓인다.
// 그걸 건드리면 이수 위조라 이 파일에 넣지 않는다.
(() => {
  if (window.__webwingEdu) return;
  window.__webwingEdu = true;
  if (!/\/cpclassroom\/onlinestudy\/\d+\/\d+\/\d+\.htm/i.test(location.pathname)) return; // 부모 .asp 는 손대지 않는다(진도 타이머가 거기 산다)

  const state = { phase: 'loading', note: '', nextTries: 0, playTries: 0, acted: false };

  const publish = (extra) => {
    try {
      const v = document.querySelector('video');
      const info = {
        at: Date.now(), phase: state.phase, note: state.note,
        lecture: typeof glb_lecture_name === 'string' ? glb_lecture_name : '',
        chasi: typeof glb_chasi !== 'undefined' ? Number(glb_chasi) : 0,
        chasis: typeof pageinfo !== 'undefined' ? pageinfo.length - 1 : 0,
        page: typeof cur_num !== 'undefined' ? Number(cur_num) : 0,
        pages: typeof arr_page !== 'undefined' ? arr_page.length - 1 : 0,
        pageTitle: (typeof pageinfo !== 'undefined' && typeof glb_chasi !== 'undefined' && typeof glb_partnum !== 'undefined')
          ? ((pageinfo[glb_chasi] || []).find((p) => p && p[0] === glb_partnum) || [])[2] || '' : '',
        cur: v ? Math.floor(v.currentTime || 0) : 0, dur: v ? Math.floor(v.duration || 0) : 0,
        paused: v ? v.paused : true, ended: v ? v.ended : false, muted: v ? v.muted : false,
        ...extra,
      };
      top.document.documentElement.dataset.webwingEdu = JSON.stringify(info);
    } catch { /* top 이 다른 출처면 조용히 */ }
  };

  // ① 대화상자 — 사람이 눌러야 넘어가는 confirm/alert 을 대신 받는다. 모르는 메시지는 원래대로 띄운다.
  const nativeConfirm = window.confirm.bind(window);
  const nativeAlert = window.alert.bind(window);
  window.confirm = (m) => {
    if (/이어서\s*학습/.test(String(m))) { state.note = '이어보기'; return true; }
    return nativeConfirm(m);
  };
  window.alert = (m) => {
    const s = String(m ?? '');
    if (/모든 과정을 마치셨습니다/.test(s)) { state.phase = 'course-done'; state.note = s; publish(); return; }
    if (/페이지가 완료되지 않았습니다/.test(s)) { state.note = '진도 마커 대기'; scheduleNext(3000); return; }
    if (/다음 차시로 진행|마지막 페이지/.test(s)) { state.note = s; return; }
    return nativeAlert(m);
  };

  // ② 다음 편 — 플랫폼의 nextpage(c,p) 가 마커 확인 → 같은 차시 다음 편 / 다음 차시 첫 편 / 완료 알림을 모두 처리한다.
  let nextTimer = 0;
  function scheduleNext(ms) {
    if (state.phase === 'course-done') return;
    if (state.nextTries >= 12) { state.phase = 'stuck'; state.note = '다음 편으로 넘어가지 못함'; publish(); return; }
    clearTimeout(nextTimer);
    nextTimer = setTimeout(() => {
      state.nextTries += 1;
      try { window.nextpage(window.glb_chasi, window.cur_num); } catch (e) { state.note = `nextpage 실패: ${e.message}`; }
      publish();
    }, ms);
  }
  function onEnded() {
    if (state.acted) return;
    state.acted = true;
    state.phase = 'ended';
    publish();
    // 플랫폼이 ended 에서 마커(Finish=Y)를 POST 한다 — 그게 서버에 닿을 시간을 준 뒤 넘긴다.
    scheduleNext(2500);
  }

  // ③ 재생 보정 — 뒤쪽 탭에서 자동재생이 막히거나 이어보기(currentTime 이동) 뒤 play 가 거부되면 멈춘 채로 남는다.
  //    사람이 직접 멈춘 경우(최근 클릭·키 입력)만 빼고, 4초 넘게 멈춰 있으면 다시 play. 두 번 거부되면 음소거로.
  let lastUserAct = 0, stalledSince = 0, lastTime = -1;
  ['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, () => { lastUserAct = Date.now(); }, true));
  function nudgePlay(v) {
    state.playTries += 1;
    const p = window.player;
    // 소스가 빠진 채(NaN) 멈춘 경우 — 페이지가 아는 영상 주소를 다시 물린다.
    if (!v.currentSrc && typeof window.movie_name === 'string' && window.movie_name && p && typeof p.src === 'function') {
      try { p.src(window.movie_name); state.note = '영상 다시 로드'; } catch { /* 무시 */ }
    }
    const tryPlay = () => (p && typeof p.play === 'function' ? p.play() : v.play());
    Promise.resolve().then(tryPlay).catch(() => {
      if (state.playTries < 2) return;
      try { if (p && typeof p.muted === 'function') p.muted(true); else v.muted = true; } catch { v.muted = true; }
      state.note = '음소거 재생';
      Promise.resolve().then(tryPlay).catch(() => {});
    });
  }
  function watchStall(v) {
    if (v.ended || state.phase === 'course-done') return;
    const t = v.currentTime || 0;
    if (!v.paused && t !== lastTime) { lastTime = t; stalledSince = 0; return; }
    if (!stalledSince) stalledSince = Date.now();
    const userPaused = Date.now() - lastUserAct < 30000;
    if (userPaused || Date.now() - stalledSince < 4000 || state.playTries >= 30) return;
    stalledSince = Date.now();
    nudgePlay(v);
  }

  let bound = false;
  function tick() {
    const v = document.querySelector('video');
    if (!v || typeof window.nextpage !== 'function') { publish(); return; }
    if (!bound) {
      bound = true;
      v.addEventListener('ended', onEnded);
      state.phase = 'playing';
    }
    if (v.ended) onEnded();
    else watchStall(v);
    publish();
  }
  const start = () => { tick(); setInterval(tick, 1000); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(start, 800));
  else setTimeout(start, 800);
})();
