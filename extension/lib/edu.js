// 법정의무교육 수집·조작 계층 — KG에듀원 사이버연수원(ehrd.kgeduone.co.kr) + 강의실(class*.campus21.co.kr).
//
// 다른 서비스와 달리 세션을 빌리지 않고 사번으로 직접 로그인한다(사이트가 아이디=비밀번호=사번으로 열려 있어
// 사용자가 사번 하나만 넣으면 끝나게 하려고). 사번·비밀번호는 chrome.storage.local 에만 둔다.
//
// 진도는 서버가 "강의창이 열려 있던 실시간 초"로 센다. 여기서는 그 시간을 조작하지 않는다 —
// 강의창을 열어 두고, 끝난 편을 다음 편으로 넘기고, 진도를 읽어 보여줄 뿐이다.
import { openTab, goto, evaluate, evaluateMain, closeTab, listFrames, clickOpensTab } from './tab.js';

const HOST = 'https://ehrd.kgeduone.co.kr';
const LOGIN_URL = `${HOST}/`;
// 강의실 서버는 classroomcheck 리디렉션이 정한다. 지금까지 본 건 class35 하나 — 분량 계산용 cfg.js 만 여기서 읽고,
// 못 읽으면 분량 없이 진도만 보여준다.
const CLASS_HOSTS = ['https://class35.campus21.co.kr', 'http://class35.campus21.co.kr'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 사번 저장 ──
// chrome.storage.sync 에 둔다 — 확장을 지웠다 다시 깔거나(ID 가 바뀌어도) 다른 PC 의 같은 크롬 계정에서도 살아남는다.
// sync 를 못 쓰는 환경(계정 미로그인 등)을 위해 local 에도 같이 쓰고, 읽을 땐 sync → local 순.
const area = (name) => chrome.storage[name];
export async function getEduCreds() {
  for (const name of ['sync', 'local']) {
    const { eduCreds } = await area(name).get('eduCreds').catch(() => ({}));
    if (eduCreds && eduCreds.empNo) return eduCreds;
  }
  return null;
}
export async function setEduCreds(creds) {
  const empNo = String(creds?.empNo || '').trim();
  if (!empNo) throw new Error('사번이 필요합니다');
  const password = String(creds?.password || '').trim() || empNo; // 초기 비밀번호 = 사번
  const eduCreds = { empNo, password };
  await area('local').set({ eduCreds });
  await area('sync').set({ eduCreds }).catch(() => {});
  return eduCreds;
}
export async function clearEduCreds() {
  await area('local').remove('eduCreds');
  await area('sync').remove('eduCreds').catch(() => {});
}

function needCreds(message) {
  const e = new Error(message || '사이버연수원 사번이 필요합니다.');
  e.needsEduId = true;
  return e;
}

// ── 로그인 ──
const isLoginPage = (tabId) => evaluate(tabId, () => !!document.querySelector('#userid') && !!document.querySelector('#userpass'));

// 로그인 폼이 보이면 사번으로 채워 제출하고, 폼이 사라질 때까지 기다린다.
// 사이트가 연속 로그인에 종종 응답을 흘린다(같은 값으로 두 번에 한 번 꼴로 폼에 그대로 남거나 오류 페이지로 감) —
// 그래서 한 번에 안 되면 로그인 페이지를 다시 열어 최대 3번 시도한다. 실패 메시지는 alert 으로 오므로 메인 월드에서 가로챈다.
async function ensureLoggedIn(tabId, creds, onProgress = () => {}) {
  if (!(await isLoginPage(tabId))) return;
  for (let attempt = 1; attempt <= 3; attempt++) {
    onProgress('로그인 확인 중…', { try: `사이버연수원 로그인${attempt > 1 ? ` (${attempt}번째)` : ''}`, result: `사번 ${creds.empNo}` });
    await evaluateMain(tabId, () => {
      window.__wwAlert = '';
      window.alert = (m) => { window.__wwAlert = String(m ?? ''); };
    });
    await evaluate(tabId, (c) => {
      const id = document.querySelector('#userid'), pw = document.querySelector('#userpass');
      id.value = c.empNo; pw.value = c.password;
      id.dispatchEvent(new Event('input', { bubbles: true })); pw.dispatchEvent(new Event('input', { bubbles: true }));
      const btn = document.querySelector('#myfrm input[type="submit"], #myfrm .login_btn');
      if (btn) btn.click(); else document.querySelector('#myfrm')?.requestSubmit();
    }, creds);
    let alertMsg = '';
    for (let i = 0; i < 14; i++) {
      await sleep(700);
      const st = await evaluate(tabId, () => ({
        login: !!document.querySelector('#userid') && !!document.querySelector('#userpass'),
        href: location.href,
      })).catch(() => null);
      if (!st) continue;                               // 이동 중
      if (/ErrorPage/i.test(st.href)) break;           // "잘못된 경로…" 오류 페이지 — 다시 연다
      if (!st.login) return;                           // 폼이 사라짐 = 로그인 됨
      alertMsg = await evaluateMain(tabId, () => window.__wwAlert || '').catch(() => '');
      if (alertMsg) break;
    }
    if (alertMsg && !/불안정|다시\s*접속/.test(alertMsg)) throw needCreds(`로그인 실패: ${alertMsg}`);
    onProgress('로그인 확인 중…', { try: '로그인 응답', result: alertMsg || '폼이 그대로 남음 · 다시 시도' });
    await goto(tabId, LOGIN_URL);
    await sleep(500);
    if (!(await isLoginPage(tabId))) return;           // 이미 세션이 살아 있었다
  }
  throw needCreds('로그인이 확인되지 않았어요. 사번(과 바꾼 비밀번호)을 확인해주세요.');
}

// ── 수강 목록 ──
function parseGoClassRoom(onclick) {
  const m = String(onclick || '').match(/goClassRoom\('([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)'\)/);
  if (!m) return null;
  return { classKey: m[1], classCount: m[2], studyKey: m[3], groupCode: m[4], insertIs: m[5] };
}

const readCourseList = (tabId) => evaluate(tabId, () =>
  [...document.querySelectorAll('article.course')].map((a) => ({
    title: (a.querySelector('.course-title')?.innerText || '').trim(),
    date: (a.querySelector('.course-date')?.innerText || '').trim(),
    badge: (a.querySelector('.badge')?.innerText || '').trim(),
    progressText: (a.querySelector('.progress-val')?.innerText || '').trim(),
    onclick: a.querySelector('button.course_btn')?.getAttribute('onclick') || '',
  })));

// 강의실(Class_home) 안내문 — "최종평가 … 과제 …" 사이의 문장과 수료기준 줄. 같은 탭을 잠깐 옮겼다가 돌아온다.
async function readClassHome(tabId, k) {
  const url = `${HOST}/classroomcheck.asp?classkey=${k.classKey}&classcount=${k.classCount}&studykey=${k.studyKey}&GroupCode=${k.groupCode}&insert_is=${k.insertIs || '0'}`;
  await goto(tabId, url);
  await sleep(600);
  const text = await evaluate(tabId, () => (document.body.innerText || '').replace(/[ \t]+/g, ' '));
  const pick = (from, to) => {
    const i = text.indexOf(from); if (i < 0) return '';
    const j = to ? text.indexOf(to, i + from.length) : -1;
    return text.slice(i + from.length, j > 0 ? j : i + from.length + 120).replace(/\s+/g, ' ').trim();
  };
  const exam = pick('최종평가', '과제');
  const report = pick('과제', '토론');
  const criteria = (text.match(/수료기준\s*:\s*([^\n]+)/) || [])[1]?.trim() || '';
  const progress = Number((text.match(/나의 진도율\s*(\d+)%/) || [])[1]) || null;
  await goto(tabId, `${HOST}/main/`);
  return { exam, report, criteria, progress };
}

// cfg.js(euc-kr) → 편 목록·분량·플래그. 강의실 세션 없이도 읽힌다.
async function fetchCourseDetail(classKey) {
  for (const host of CLASS_HOSTS) {
    try {
      const res = await fetch(`${host}/cpclassroom/onlinestudy/${classKey}/js/cfg.js`, { cache: 'no-store' });
      if (!res.ok) continue;
      const text = new TextDecoder('euc-kr').decode(await res.arrayBuffer());
      return parseCfg(text);
    } catch { /* 다음 호스트 */ }
  }
  return null;
}

export function parseCfg(text) {
  const flags = {};
  for (const m of text.matchAll(/var glb_(\w+)\s*=\s*"([^"]*)"/g)) flags[m[1]] = m[2];
  const pages = [];
  for (const m of text.matchAll(/pageinfo\[(\d+)\]\[(\d+)\]\s*=\s*new Array\s*\(([^\n]*)\);/g)) {
    const f = [...m[3].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]);
    if (f.length < 9 || f[1] === 'sub_title') continue;
    pages.push({ chasi: Number(m[1]), idx: Number(m[2]), part: f[0], type: f[1], title: f[2], pageNo: f[3],
      page: (f[7] || '').replace(/\.htm$/i, ''), sec: Number(f[8]) || 0 });
  }
  const chasis = new Set(pages.map((p) => p.chasi)).size;
  const totalSec = pages.reduce((s, p) => s + p.sec, 0);
  return {
    lectureName: flags.lecture_name || '', speed: flags.speed || '', progressControl: flags.progresscontrol || '',
    progressBar: flags.progressbar || '', autoNext: flags.autonext || '', continueStudy: flags.continue_study || '',
    chasis, pages, totalSec,
  };
}

// 수강 목록 + 과정별 분량. 결과는 패널이 그대로 그린다.
export async function getEduStatus(onProgress = () => {}) {
  const creds = await getEduCreds();
  if (!creds) throw needCreds();
  onProgress('사이버연수원 여는 중…');
  const tabId = await openTab(`${HOST}/main/`);
  try {
    await ensureLoggedIn(tabId, creds, onProgress);
    if (await isLoginPage(tabId)) throw needCreds();
    onProgress('수강 목록 읽는 중…', { url: `${HOST}/main/` });
    let list = await readCourseList(tabId);
    if (!list.length) { await goto(tabId, `${HOST}/main/`); await ensureLoggedIn(tabId, creds, onProgress); list = await readCourseList(tabId); }
    onProgress(`과정별 분량 계산 중… (${list.length}과정)`, { try: '수강 목록', result: `${list.length}과정` });
    const courses = [];
    for (const row of list) {
      const keys = parseGoClassRoom(row.onclick);
      const progress = Number((row.progressText || '').replace(/[^0-9.]/g, '')) || 0;
      const [, start, end] = row.date.match(/(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2})/) || [];
      const detail = keys ? await fetchCourseDetail(keys.classKey) : null;
      // 강의실 첫 화면에서 최종평가·과제·수료기준을 읽는다(시험이 있는지, 몇 점이 기준인지).
      const room = keys && detail ? await readClassHome(tabId, keys).catch(() => null) : null;
      // 강의실 서버에 cfg.js 가 없으면 다른 LMS(안전보건교육의 wisehrd 등)로 넘어가는 과정이다 — 자동 진행 대상이 아니다.
      const external = !detail;
      const remainSec = detail ? Math.round(detail.totalSec * (1 - progress / 100)) : null;
      courses.push({
        title: row.title, badge: row.badge, start: start || '', end: end || '', progress, keys, external,
        chasis: detail?.chasis || 0, pages: detail?.pages.length || 0, totalSec: detail?.totalSec || 0, remainSec,
        flags: detail ? { speed: detail.speed, progressControl: detail.progressControl, autoNext: detail.autoNext } : null,
        pageList: detail?.pages || [],
        exam: room?.exam || '', report: room?.report || '', criteria: room?.criteria || '', roomProgress: room?.progress ?? null,
      });
      onProgress(`과정별 분량 계산 중… (${courses.length}/${list.length})`,
        { try: row.title, result: detail ? `${detail.pages.length}편 · ${Math.round(detail.totalSec / 60)}분 · 진도 ${progress}%` : `별도 LMS · 진도 ${progress}%` });
    }
    return { empNo: creds.empNo, fetchedAt: Date.now(), courses };
  } finally {
    await closeTab(tabId);
  }
}

// ── 강의창 열기 ──
// 사이트의 흐름(학습하기 → classroomcheck 팝업 → 강의실 → 학습시작 팝업)을 팝업 없이 탭 하나에서 같은 순서로 밟는다.
// 강의실 세션은 classroomcheck 리디렉션이 만들고, 강의창 주소는 강의실 페이지 자신의 fn_MoveStudy 에서 읽는다.
export async function openStudy(course, onProgress = () => {}) {
  const creds = await getEduCreds();
  if (!creds) throw needCreds();
  const k = course.keys;
  if (!k) throw new Error('이 과정은 강의실 정보를 읽지 못했어요.');
  const checkUrl = `${HOST}/classroomcheck.asp?classkey=${k.classKey}&classcount=${k.classCount}&studykey=${k.studyKey}&GroupCode=${k.groupCode}&insert_is=${k.insertIs || '0'}`;
  onProgress('강의실 여는 중…');
  let tabId = await openTab(checkUrl);
  try {
    if (await isLoginPage(tabId).catch(() => false)) {
      await ensureLoggedIn(tabId, creds, onProgress);
      await goto(tabId, checkUrl);
    }
    await sleep(800);
    let url = (await chrome.tabs.get(tabId)).url || '';
    // 주소 직접 열기가 안 받아주는 과정(별도 LMS 로 넘기는 안전보건 등은 "그룹 정보를 가져올 수 없습니다")이면
    // 사이트가 하는 그대로 — 수강 목록의 학습하기(goClassRoom)를 눌러 뜨는 창을 받는다.
    if (!/campus21\.co\.kr|wisehrd\.com/.test(url)) {
      const body = await evaluate(tabId, () => (document.body?.innerText || '').trim().slice(0, 80)).catch(() => '');
      onProgress('강의실 여는 중…', { try: '강의실 주소 직접 열기', result: body || '응답 없음 · 학습하기 버튼으로 다시' });
      await goto(tabId, `${HOST}/main/`);
      await ensureLoggedIn(tabId, creds, onProgress);
      const mainWin = (await chrome.tabs.get(tabId)).windowId;
      await evaluateMain(tabId, () => { window.alert = (m) => { window.__wwAlert = String(m ?? ''); }; });
      const popped = await clickOpensTab(tabId, (kk) => {
        window.goClassRoom(kk.classKey, kk.classCount, kk.studyKey, kk.groupCode, kk.insertIs || '0');
      }, k, { world: 'MAIN' });
      if (!popped) {
        const msg = await evaluateMain(tabId, () => window.__wwAlert || '').catch(() => '');
        throw new Error(msg ? `강의실을 열지 못했어요: ${msg}` : '강의실 창이 뜨지 않았어요');
      }
      await chrome.tabs.move(popped, { windowId: mainWin, index: -1 }).catch(() => {});
      await closeTab(tabId);
      tabId = popped;
      await sleep(800);
      url = (await chrome.tabs.get(tabId)).url || '';
      onProgress('강의실 여는 중…', { try: '학습하기 버튼', result: url.replace(/^https?:\/\//, '').slice(0, 60) });
    }
    if (!/campus21\.co\.kr/.test(url)) {
      // 다른 LMS 로 넘어갔다(안전보건교육 등) — 자동 진행은 없고 사람이 보게 앞으로 가져온다.
      await chrome.tabs.update(tabId, { active: true });
      return { tabId, external: true, url };
    }
    const origin = new URL(url).origin;
    const tail = await evaluateMain(tabId, () => {
      const src = String(window.fn_MoveStudy || '');
      const m = src.match(/contentview\.asp\?part="\s*\+\s*strPart\s*\+\s*"&page="\s*\+\s*strPage\s*\+\s*"([^"]*)"/);
      return m ? m[1] : '';
    }).catch(() => '');
    const query = tail || `&classkey=${k.classKey}&classcount=${k.classCount}&contentskey=${k.classKey}`;

    // 이미 끝낸 편은 다시 틀지 않는다 — 서버 마커(Finish)를 읽어 첫 미완료 편부터 연다.
    onProgress('어디까지 들었는지 확인 중…');
    const pages = (course.pageList || []).map((p) => ({ part: p.part, page: p.page }));
    const first = pages.length ? await evaluate(tabId, async (list) => {
      for (const p of list) {
        try {
          const body = new URLSearchParams({ part: p.part, page: p.page, returnType: 'json' });
          const res = await fetch('/cpclassroom/onlinestudy/public/asp/ProgressMarkerRead.asp', { method: 'POST', body, credentials: 'include' });
          const j = JSON.parse((await res.text()).trim() || '{}');
          if (j.Finish !== 'Y') return p;
        } catch { return p; }
      }
      return null;
    }, pages).catch(() => null) : null;
    if (pages.length && !first) return { tabId, external: false, done: true, url };
    const startAt = first || pages[0] || { part: '010101', page: '001' };
    const studyUrl = `${origin}/cpclassroom/onlinestudy/contentview.asp?part=${startAt.part}&page=${startAt.page}${query}`;
    onProgress('강의창 여는 중…', { try: '시작 편', result: `${startAt.part}/${startAt.page}` });
    // 페이지 스크립트로 이동해야 referer 가 붙는다(직접 주소 입력은 "잘못된 접근"으로 튕긴다).
    await evaluateMain(tabId, (u) => { location.href = u; }, studyUrl);
    for (let i = 0; i < 20; i++) {
      await sleep(700);
      const frames = await listFrames(tabId);
      if (frames.some((f) => /\/cpclassroom\/onlinestudy\/\d+\/\d+\/\d+\.htm/i.test(f.url))) break;
    }
    return { tabId, external: false, url: studyUrl, startAt };
  } catch (e) {
    await closeTab(tabId);
    throw e;
  }
}

// 강의창 상태 — 플레이어 도우미(content/edu-player.js)가 top 문서에 적어 둔 것을 읽는다.
export async function readStudy(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return { gone: true };
  const href = tab.url || '';
  if (!/campus21\.co\.kr/.test(href)) return { gone: false, left: true, href };
  const raw = await evaluate(tabId, () => ({
    href: location.href, data: document.documentElement.dataset.webwingEdu || '',
  })).catch(() => null);
  if (!raw) return { gone: false, href, info: null };
  let info = null;
  try { info = raw.data ? JSON.parse(raw.data) : null; } catch { info = null; }
  return { gone: false, href: raw.href, info };
}

export const closeStudy = (tabId) => closeTab(tabId);

// 별도 LMS(안전보건교육 · wisehrd) 강의실 구조 덤프 — 자동화 설계용. 프레임·스크립트·video·전역 함수 이름만 읽는다.
export async function dumpStudyTab(tabId) {
  const frames = await listFrames(tabId);
  const out = [];
  for (const f of frames) {
    const r = await evaluate(tabId, () => ({
      title: document.title,
      text: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 400),
      scripts: [...document.scripts].map((s) => s.src).filter(Boolean).map((u) => u.replace(/^https?:\/\/[^/]+/, '')).slice(0, 25),
      videos: [...document.querySelectorAll('video,audio')].map((v) => ({ src: (v.currentSrc || v.src || '').slice(0, 120), dur: v.duration, cur: v.currentTime, paused: v.paused, rate: v.playbackRate })),
      objects: [...document.querySelectorAll('iframe,object,embed')].map((o) => (o.getAttribute('src') || o.getAttribute('data') || '').slice(0, 120)),
      clicks: [...document.querySelectorAll('a,button,[onclick]')].map((e) => ({ t: (e.innerText || '').trim().slice(0, 24), o: (e.getAttribute('onclick') || e.getAttribute('href') || '').slice(0, 90) })).filter((x) => x.o && x.o !== '#').slice(0, 40),
    }), undefined, { frameId: f.frameId }).catch((e) => ({ err: e.message }));
    const fns = await evaluate(tabId, () => Object.keys(window).filter((k) => /play|next|prev|study|lesson|progress|chk|auth|open|move|save|time/i.test(k) && typeof window[k] === 'function').slice(0, 60),
      undefined, { frameId: f.frameId, world: 'MAIN' }).catch(() => []);
    out.push({ url: f.url, ...r, fns });
  }
  return out;
}

// ════════ 안전보건교육 (별도 LMS · kgeduone.wisehrd.com) ════════
// 앞 4과정과 달리 세션·구조가 완전히 다르다. 진도는 여기서도 실시간 초(팝업 열린 시간)로 쌓인다 — 조작하지 않는다.
// 흐름: ehrd 학습하기 → wisehrd my_lecture → (본인인증 세션) → classroom/index.jsp → 차시별 PlayContent 팝업.
const WISE = 'https://kgeduone.wisehrd.com';

// wisehrd 강의실까지 연다. 반환: { tabId, cuid } 또는 { tabId, needAuth:true } 또는 { tabId, notReady }.
export async function wiseOpen(course, onProgress = () => {}) {
  const creds = await getEduCreds();
  if (!creds) throw needCreds();
  onProgress('안전보건 강의실 여는 중…');
  // 이미 열려 있는 wisehrd 탭이 있으면 재사용
  const existing = (await chrome.tabs.query({ url: `${WISE}/*` }).catch(() => []))[0];
  let tabId = existing ? existing.id : null;
  if (!tabId) {
    const opened = await openStudy(course, onProgress).catch((e) => { throw e; });
    tabId = opened.tabId;
  }
  // my_lecture 로 이동해 강의실(crs_notice_read) 진입
  await goto(tabId, `${WISE}/myacademy/my_lecture.jsp?mid=my_lecture`).catch(() => {});
  await sleep(1200);
  // 강의실 버튼의 crs_notice_read 인자(cuid 등) 추출
  const call = await evaluate(tabId, () => {
    const el = [...document.querySelectorAll('[onclick]')].find((e) => /crs_notice_read/.test(e.getAttribute('onclick') || ''));
    const m = el && (el.getAttribute('onclick') || '').match(/crs_notice_read\(\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*\)/);
    return m ? { read: m[1], id: m[2], type: m[3], company: m[4] } : null;
  }).catch(() => null);
  if (!call) return { tabId, notReady: true };
  await evaluateMain(tabId, (c) => { window.crs_notice_read(c.read, c.id, c.type, c.company); }, call);
  await sleep(1500);
  const url = (await chrome.tabs.get(tabId)).url || '';
  if (/mychk_classroom/.test(url)) return { tabId, needAuth: true, cuid: call.id };
  // 목차 페이지로 맞춰 둔다(진도·PlayContent 를 여기서 읽는다)
  await goto(tabId, `${WISE}/classroom/curriculum.jsp?cuid=${call.id}`).catch(() => {});
  await sleep(1000);
  return { tabId, cuid: call.id };
}

// 목차 파싱 — 차시별 진도·수료·(열려 있으면) PlayContent 인자.
export async function wiseCurriculum(tabId, cuid, reload) {
  if (cuid) {
    // 팝업이 닫히면 opener 가 index.jsp 로 새로고침되는 경우가 있어 차시표가 사라진다 — 목차로 다시 맞춘다.
    // reload=true 면 시험 통과로 잠금이 풀렸는지 보려고 강제로 다시 읽는다.
    const url = (await chrome.tabs.get(tabId).catch(() => ({}))).url || '';
    if (reload || !/curriculum\.jsp/.test(url)) { await goto(tabId, `${WISE}/classroom/curriculum.jsp?cuid=${cuid}`).catch(() => {}); await sleep(900); }
  }
  return evaluate(tabId, () => {
    const url = location.href;
    if (/mychk_classroom/.test(url)) return { needAuth: true };
    const rows = [...document.querySelectorAll('table tr')].map((tr) => tr).filter((tr) => /^\s*\d{2}\s/.test((tr.innerText || '').trim()));
    const chasis = rows.map((tr) => {
      const t = (tr.innerText || '').replace(/\s+/g, ' ').trim();
      const idx = (t.match(/^(\d{2})/) || [])[1] || '';
      const pct = Number((t.match(/(\d+(?:\.\d+)?)%/) || [])[1]);
      const doneCell = [...tr.querySelectorAll('td')].map((td) => td.innerText.trim());
      const done = /\bY\b/.test(t) || doneCell.includes('Y') || pct >= 100;
      const play = [...tr.querySelectorAll('[onclick],a[href]')].map((e) => e.getAttribute('onclick') || e.getAttribute('href') || '')
        .find((o) => /PlayContent\(/.test(o));
      const m = play && play.match(/PlayContent\(\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*\)/);
      return { idx, title: t.replace(/^\d{2}\s*/, '').slice(0, 40), pct: pct || 0, done,
        play: m ? { cid: m[1], crsid: m[2], cuid: m[3], chapter: m[4] } : null };
    });
    const myPct = Number((document.body.innerText.match(/나의진도율\s*([\d.]+)%/) || [])[1]) || 0;
    return { chasis, myPct, url };
  }).catch((e) => ({ error: e.message }));
}

// 차시 영상 팝업 열기 — 강의실 탭의 MAIN 월드에서 PlayContent 호출(팝업 opener 가 살아 있어야 진도가 저장된다).
export async function wisePlay(tabId, play, speed = 1) {
  await evaluate(tabId, (sp) => { document.documentElement.dataset.webwingWiseSpeed = String(sp); }, speed).catch(() => {});
  await evaluateMain(tabId, (p) => { window.PlayContent(p.cid, p.crsid, p.cuid, p.chapter); }, play);
  await sleep(1500);
  const pop = (await chrome.tabs.query({ url: `${WISE}/course/player.jsp*` }).catch(() => []))[0];
  return { popupTabId: pop ? pop.id : null };
}

// 배속 변경을 강의실 문서에 적어 둔다 — 도우미가 매초 읽어 팝업 영상에 적용한다.
export async function wiseSetSpeed(tabId, speed) {
  await evaluate(tabId, (sp) => { document.documentElement.dataset.webwingWiseSpeed = String(sp); }, speed).catch(() => {});
  return true;
}

// 팝업 영상 상태 — 도우미(content/edu-wise.js)가 강의실 문서에 적어 둔 값 + 팝업 존재 여부.
export async function wiseReadPlayer(tabId) {
  const pop = (await chrome.tabs.query({ url: `${WISE}/course/player.jsp*` }).catch(() => []))[0];
  const raw = await evaluate(tabId, () => document.documentElement.dataset.webwingWise || '').catch(() => '');
  let info = null; try { info = raw ? JSON.parse(raw) : null; } catch { info = null; }
  return { popupOpen: !!pop, popupTabId: pop ? pop.id : null, info };
}
