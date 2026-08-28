// Webwing 사이드 패널 — 홈(자동화 목록) → 실행 중(단계 로그) → 결과.
// 실행 중에는 목록 위를 스크림이 덮고 백그라운드 수집이 도는 동안 단계가 올라간다.
import { mountClockChart, legendHTML } from './chart.js';
import { summarizeDays } from '../core/attendance.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CAL_DOW = ['일', '월', '화', '수', '목', '금', '토'];
const WORKERS_DAY = '근로자의 날';
const LEAVE_COLORS = ['#3b6fe0', '#12a150', '#8b5cf6', '#e08b1a', '#0ea5b7', '#d9488a'];
const shortLeaveType = (t) => (t === '연차휴가' ? '연차' : t);
const kstNow = () => new Date(Date.now() + 9 * 3600 * 1000);
const thisYear = kstNow().getUTCFullYear();

// ── 자동화 레지스트리 ──
// 새 자동화는 여기에 한 줄 추가하고 render 함수만 붙이면 목록·실행·결과 흐름을 그대로 탄다.
// services: 이 자동화가 다루는 서비스. 지금 보고 있는 사이트와 맞으면 목록 상단으로 올라온다.
const AUTOMATIONS = [
  {
    id: 'leave-personal', label: '내 연차 현황', sub: '잔여·사용이력을 연간 달력으로',
    ready: true, msg: 'leave-personal', hasYear: true, services: ['timeinout'],
    steps: ['타임인아웃 여는 중', '잔여 연차 읽는 중', '휴가 종류 확인', '달력 그리는 중'],
    render: renderLeave,
  },
  {
    id: 'overtime', label: '초과근무 분석', sub: '찐 출퇴근으로 초과근무 집계',
    ready: true, msg: 'overtime', hasMonth: true, askMonth: true, services: ['timeinout'],
    steps: ['타임인아웃 여는 중', '근태 카드 조회', '경계일 보정', '휴가·출장 반영', '초과근무 계산'],
    render: renderOvertime,
  },
  {
    id: 'correction', label: '출퇴근 정정', sub: '누락일 Flow 대조 → 출퇴근 제안',
    ready: true, msg: 'correction', hasMonth: true, askMonth: true, services: ['timeinout', 'flow'],
    steps: ['타임인아웃 여는 중', '근태 카드 조회', '누락일 추리는 중', 'Flow 활동 대조'],
    render: renderCorrection,
  },
  {
    id: 'yagun', label: '야근택시 조회', sub: '심야 택시 → 근태로 증빙 판정',
    ready: true, msg: 'yagun', hasMonth: true, askMonth: true, services: ['bizplay', 'timeinout'],
    steps: ['비즈플레이 여는 중', '카드영수증 앱 여는 중', '미결의 조회', '타임인아웃 근태 매칭'],
    render: (d) => renderExpense(d, 'yagun'),
  },
  {
    id: 'yasik', label: '야근식비 조회', sub: '혼자 식대 → 야근·조식 인정',
    ready: true, msg: 'yasik', hasMonth: true, services: ['bizplay', 'timeinout'],
    steps: ['비즈플레이 여는 중', '카드영수증 앱 여는 중', '미결의 조회', '타임인아웃 근태 매칭'],
    render: (d) => renderExpense(d, 'yasik'),
  },
  {
    id: 'edu', label: '법정의무교육', sub: '진도 관제 · 끝난 편은 다음 편으로',
    ready: true, msg: 'edu', services: ['ehrd'],
    steps: ['사이버연수원 여는 중', '로그인 확인', '수강 목록 읽는 중', '과정별 분량 계산'],
    render: renderEdu,
  },
];

// 서비스 로고 — 자동화 아이콘은 이모지 대신 관련 서비스 로고 배지(데스크톱과 동일). 파란 점=타임인아웃/Webwing.
const SVC_ICON = { timeinout: '../icons/svc-timeinout.png', bizplay: '../icons/svc-bizplay.png', flow: '../icons/svc-flow.png', ehrd: '../icons/svc-ehrd.png' };
const SVC_LABEL = { timeinout: '타임인아웃', bizplay: '비즈플레이', flow: 'Flow', ehrd: '사이버연수원' };
// 자동화 아이콘 HTML: 관련 서비스 로고를 '+'로 이어 붙인다.
const autoIcon = (a) => (a.services || []).map((s, i) =>
  `${i ? '<span class="plus">+</span>' : ''}<img src="${SVC_ICON[s]}" alt="">`).join('');
// 홈 카드에서는 서비스 로고를 제목 아래의 작은 흰색 칩으로 보여준다.
const serviceChips = (a) => `<span class="svc-chips">${(a.services || []).map((s) =>
  `<span class="svc-chip"><img src="${SVC_ICON[s]}" alt=""><span>${esc(SVC_LABEL[s] || s)}</span></span>`).join('')}</span>`;

// 호스트 → 서비스. 지금 탭이 어느 서비스인지 판별해 관련 자동화를 위로 올린다.
const SERVICE_OF_HOST = (host) => {
  if (/timeinout\.kr$/.test(host)) return 'timeinout';
  if (/bizplay\.co\.kr$/.test(host)) return 'bizplay';
  if (/flow\.team$/.test(host)) return 'flow';
  if (/kgeduone\.co\.kr$|campus21\.co\.kr$/.test(host)) return 'ehrd';
  return null;
};
const SERVICE_NAME = { timeinout: '타임인아웃', bizplay: '비즈플레이', flow: 'Flow', ehrd: '사이버연수원' };
let currentService = null; // 지금 보고 있는 사이트의 서비스

let current = null; // 실행 중인 자동화

// ── 홈 렌더 ── 지금 보고 있는 사이트에 맞는 자동화를 위로 올리고 "지금 이 사이트" 섹션으로 묶는다.
function renderHome() {
  const svc = currentService;
  const matched = svc ? AUTOMATIONS.filter((a) => a.services?.includes(svc)) : [];
  const rest = AUTOMATIONS.filter((a) => !matched.includes(a));
  // 매칭 그룹 안에서도 실행 가능한 것 먼저
  const byReady = (arr) => [...arr].sort((a, b) => (b.ready ? 1 : 0) - (a.ready ? 1 : 0));

  const card = (a) => `
    <button class="auto" data-id="${a.id}" ${a.ready ? '' : 'disabled'}>
      <span class="tx"><span class="lb">${esc(a.label)}</span><span class="sb">${esc(a.sub)}</span>${serviceChips(a)}</span>
      ${a.ready ? '<span class="chev">›</span>' : '<span class="badge">준비 중</span>'}
    </button>`;

  let html = '';
  if (matched.length) {
    html += `<div class="home-hd hot">지금 보고 있는 · ${esc(SERVICE_NAME[svc])}</div>
      <div class="list">${byReady(matched).map(card).join('')}</div>`;
    html += `<div class="home-hd" style="margin-top:18px">그 밖의 자동화</div>
      <div class="list">${byReady(rest).map(card).join('')}</div>`;
  } else {
    html += `<div class="home-hd">자동화</div><div class="list">${byReady(AUTOMATIONS).map(card).join('')}</div>`;
  }
  $('auto-list-wrap').innerHTML = html;
  $('auto-list-wrap').querySelectorAll('.auto[data-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const auto = AUTOMATIONS.find((a) => a.id === btn.dataset.id);
      if (auto.askMonth) openMonthDialog(auto); else start(auto);
    });
  });
}

// 월 단위 자동화 중 사용자가 지정한 세 기능은 실행 전에 월을 명시적으로 고른다.
let monthDialogAuto = null, monthDialogYear = new Date().getFullYear(), monthDialogValue = '';
function renderMonthOptions() {
  $('month-dialog-year').textContent = `${monthDialogYear}년`;
  $('month-dialog-options').innerHTML = Array.from({ length: 12 }, (_, i) => {
    const value = `${monthDialogYear}-${String(i + 1).padStart(2, '0')}`;
    return `<button type="button" class="month-option${value === monthDialogValue ? ' selected' : ''}"
      data-value="${value}" aria-pressed="${value === monthDialogValue}">${i + 1}월</button>`;
  }).join('');
}
function openMonthDialog(auto) {
  monthDialogAuto = auto;
  $('month-dialog-title').textContent = `${auto.label} 기간 선택`;
  $('month-dialog-desc').textContent = '조회할 월을 선택해주세요.';
  monthDialogValue = $('month').value;
  monthDialogYear = Number(monthDialogValue.slice(0, 4)) || new Date().getFullYear();
  renderMonthOptions();
  $('month-dialog').hidden = false;
  setTimeout(() => $('month-dialog-options').querySelector('.selected')?.focus(), 30);
}
function closeMonthDialog() { $('month-dialog').hidden = true; monthDialogAuto = null; }
$('month-dialog-cancel').addEventListener('click', closeMonthDialog);
$('month-dialog-prev').addEventListener('click', () => { monthDialogYear--; renderMonthOptions(); });
$('month-dialog-next').addEventListener('click', () => { monthDialogYear++; renderMonthOptions(); });
$('month-dialog-options').addEventListener('click', (e) => {
  const btn = e.target.closest('.month-option');
  if (!btn) return;
  monthDialogValue = btn.dataset.value;
  renderMonthOptions();
  $('month-dialog-options').querySelector(`[data-value="${monthDialogValue}"]`)?.focus();
});
$('month-display').addEventListener('click', () => { if (current?.hasMonth) openMonthDialog(current); });
$('month-dialog-go').addEventListener('click', () => {
  const auto = monthDialogAuto, value = monthDialogValue;
  if (!auto || !/^\d{4}-\d{2}$/.test(value)) return;
  $('month').value = value;
  $('month-display').textContent = `${monthLabel(value)} ▾`;
  closeMonthDialog();
  start(auto);
});
$('month-dialog').addEventListener('click', (e) => { if (e.target === $('month-dialog')) closeMonthDialog(); });

// 지금 활성 탭의 서비스를 읽어 홈이 열려 있으면 재정렬
async function refreshContext() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const host = tab?.url ? new URL(tab.url).host : '';
    const svc = SERVICE_OF_HOST(host);
    if (svc === currentService) return;
    currentService = svc;
    if (!$('view-home').hidden) renderHome();
  } catch { /* about: 등 URL 접근 불가 탭 — 무시 */ }
}
// 탭을 바꾸거나 주소가 바뀌면 컨텍스트 갱신(패널은 탭 따라다니므로 실시간 반영)
chrome.tabs.onActivated.addListener(refreshContext);
chrome.tabs.onUpdated.addListener((_id, info) => { if (info.url) refreshContext(); });

// ── 뷰 전환 ──
let clockChart = null;   // 결과 화면을 떠날 때 ResizeObserver를 끊어야 해서 붙잡아 둔다
function show(view) {
  if (view !== 'result') { clockChart?.destroy(); clockChart = null; }
  for (const v of ['home', 'run', 'result']) $(`view-${v}`).hidden = v !== view;
  $('back').style.display = view === 'home' ? 'none' : 'inline-flex';
  $('year').hidden = !(view === 'result' && current?.hasYear);
  $('month').hidden = true; // 상태 보관용일 뿐, 브라우저 기본 월 셀렉터는 화면에 내지 않는다.
  $('month-display').hidden = !(view === 'result' && current?.hasMonth);
  if (!$('month-display').hidden) $('month-display').textContent = `${monthLabel($('month').value)} ▾`;
  // 자동화 안에서는 그 화면 이름이 제목이다. 브랜드는 왼쪽 아이콘으로만 남긴다 —
  // 브라우저 패널 헤더에 이미 "Webwing"이 떠 있어서 두 번 쓸 자리가 없다.
  $('topbar').classList.toggle('sub', view !== 'home');
  $('brand-name').textContent = view === 'home' ? 'Webwing' : (current?.label || 'Webwing');
  // 패널 상단 브라우저 바 타이틀도 현재 화면 반영
  document.title = view === 'home' ? 'Webwing' : `Webwing · ${current?.label || ''}`;
}

function goHome() {
  current = null;
  show('home');
}

// ── 실행 ──
let trace = [];          // 이번 실행에서 "무엇을 봤는지" — 결과 화면의 실행 기록으로 쓴다
let traceStart = 0;

async function start(auto) {
  current = auto;
  trace = [];
  traceStart = Date.now();
  buildSteps(auto);
  $('run-ic').innerHTML = autoIcon(auto);
  $('run-lb').textContent = auto.label;
  $('run-sb').textContent = auto.hasYear ? `${$('year').value}년` : auto.hasMonth ? monthLabel($('month').value) : '';
  $('run-err').hidden = true;
  $('run-actions').hidden = true;
  $('run-live').hidden = true;
  $('run-live').innerHTML = '';
  show('run');
  await execute(auto);
}

async function execute(auto) {
  try {
    const payload = { type: auto.msg };
    if (auto.hasYear) payload.year = Number($('year').value);
    if (auto.hasMonth) payload.month = $('month').value;
    const res = await chrome.runtime.sendMessage(payload);
    if (res === undefined) { // 서비스워커 무응답(크래시/미로드) — 재로드 안내
      const e = new Error('확장이 응답하지 않았어요');
      e.detail = '서비스 워커가 뜨지 않았어요. chrome://extensions 에서 Webwing을 새로고침(↻)한 뒤 다시 시도해주세요.';
      throw e;
    }
    if (!res?.ok) {
      const e = new Error(res?.error || '가져오지 못했습니다');
      e.needsLogin = res?.needsLogin || null;
      e.needsFlowKey = res?.needsFlowKey || null;
      e.needsAppUrl = res?.needsAppUrl || null;
      e.needsEduId = res?.needsEduId || null;
      e.detail = res?.detail || '';
      throw e;
    }
    // 늦게 끝난 실행이 지금 보고 있는 화면을 밀어내면 안 된다.
    // (로그인·앱주소 대기처럼 몇 분씩 걸리는 흐름이 있어서 그 사이 다른 자동화로 옮겨갈 수 있다)
    if (current !== auto) return;
    markAllDone();
    await sleep(280); // 마지막 체크가 잠깐 보이도록
    auto.render(res.data);
    appendTrace();     // 렌더가 view-result를 통째로 갈아치우므로 그 뒤에 붙인다
    show('result');
  } catch (e) {
    if (current !== auto) return;
    if (e.needsFlowKey) return promptFlowKey();
    if (e.needsEduId) return promptEduId(e.message);
    failCurrentStep(e.message, e.needsLogin, e.detail, e.needsAppUrl);
  }
}

// 실제 시스템 쓰기는 조회와 분리한다. 결과 화면의 버튼 → 경고 확인 버튼을 거친 뒤에만 이 함수가 호출된다.
async function runWriteAction({ payload, steps, label, render, subtitle = '실제 제출' }) {
  const owner = current;
  trace = [];
  traceStart = Date.now();
  buildSteps({ steps });
  $('run-ic').innerHTML = autoIcon(owner || {});
  $('run-lb').textContent = label;
  $('run-sb').textContent = subtitle;
  $('run-err').hidden = true;
  $('run-actions').hidden = true;
  $('run-live').hidden = true;
  $('run-live').innerHTML = '';
  show('run');
  try {
    const res = await chrome.runtime.sendMessage(payload);
    if (!res?.ok) {
      const e = new Error(res?.error || '제출하지 못했습니다');
      e.needsLogin = res?.needsLogin || null; e.detail = res?.detail || '';
      throw e;
    }
    if (current !== owner) return;
    markAllDone();
    await sleep(250);
    render(res.data);
    appendTrace();
    show('result');
  } catch (e) {
    if (current !== owner) return;
    failCurrentStep(e.message, e.needsLogin, e.detail, null);
  }
}

// Flow API 키 입력 → 검증·저장 → 자동 재실행
const FLOW_API_KEY_URL = 'https://api.flow.team/signin?redirectTo=/account/api-keys&message=LOGIN_REQUIRED';
function promptFlowKey() {
  const active = stepEls.find((el) => el.classList.contains('active')) || stepEls[stepEls.length - 1];
  active?.classList.remove('active'); active?.classList.add('err');
  $('run-err').hidden = false;
  $('run-err').innerHTML = `
    <div style="color:var(--ink);font-weight:700;margin-bottom:3px">Flow API 키가 필요해요</div>
    <div style="font-size:12.5px;color:var(--muted);margin-bottom:9px">아래 페이지에서 로그인한 뒤 설정 → 오픈 API에서 키를 발급하세요. 키는 이 기기에만 저장됩니다.</div>
    <a id="flow-key-link" class="flow-key-link" href="${FLOW_API_KEY_URL}" target="_blank" rel="noopener noreferrer">
      <span>Flow API 키 발급 페이지 열기</span><span aria-hidden="true">↗</span>
    </a>
    <input id="flow-key-input" type="password" placeholder="x-flow-api-key" autocomplete="off"
      style="width:100%;padding:9px 11px;border:1px solid #d9dcec;border-radius:9px;font:inherit;margin-bottom:8px" />
    <div id="flow-key-msg" style="color:var(--red);font-size:12px;min-height:16px;margin-bottom:6px"></div>`;
  $('run-actions').hidden = false;
  $('run-retry').textContent = '저장하고 계속';
  $('run-retry').onclick = saveFlowKey;
  setTimeout(() => $('flow-key-input')?.focus(), 50);
}
async function saveFlowKey() {
  const key = $('flow-key-input')?.value.trim();
  if (!key) { $('flow-key-msg').textContent = '키를 입력하세요'; return; }
  $('run-retry').disabled = true;
  $('flow-key-msg').style.color = 'var(--muted)';
  $('flow-key-msg').textContent = '확인 중…';
  const res = await chrome.runtime.sendMessage({ type: 'flow-key-save', key });
  $('run-retry').disabled = false;
  if (!res?.ok) { $('flow-key-msg').style.color = 'var(--red)'; $('flow-key-msg').textContent = res?.error || '키 확인 실패'; return; }
  if (current) start(current); // 저장 성공 → 재실행
}

// 사이버연수원 사번 입력 → 저장 → 자동 재실행. 아이디·초기 비밀번호가 모두 사번이라 사번 하나면 된다.
// 비밀번호를 바꾼 사람만 함께 넣는다. 둘 다 이 기기의 chrome.storage.local 에만 남는다.
function promptEduId(message) {
  const active = stepEls.find((el) => el.classList.contains('active')) || stepEls[stepEls.length - 1];
  active?.classList.remove('active'); active?.classList.add('err');
  const why = message && !/사번이 필요/.test(message) ? `<div style="color:var(--red);font-size:12px;margin-bottom:6px">${esc(message)}</div>` : '';
  $('run-err').hidden = false;
  $('run-err').innerHTML = `
    <div style="color:var(--ink);font-weight:700;margin-bottom:3px">사이버연수원 사번이 필요해요</div>
    <div style="font-size:12.5px;color:var(--muted);margin-bottom:9px">아이디와 초기 비밀번호가 모두 <b>사번</b>이에요. 비밀번호를 바꿨다면 함께 넣어주세요. 이 기기에만 저장됩니다.</div>
    ${why}
    <input id="edu-id-input" placeholder="사번 (예: M18112601)" autocomplete="off" spellcheck="false"
      style="width:100%;padding:9px 11px;border:1px solid #d9dcec;border-radius:9px;font:inherit;margin-bottom:8px" />
    <input id="edu-pw-input" type="password" placeholder="비밀번호 (비우면 사번과 같음)" autocomplete="off"
      style="width:100%;padding:9px 11px;border:1px solid #d9dcec;border-radius:9px;font:inherit;margin-bottom:8px" />
    <div id="edu-id-msg" style="color:var(--red);font-size:12px;min-height:16px;margin-bottom:6px"></div>`;
  $('run-actions').hidden = false;
  $('run-retry').textContent = '저장하고 계속';
  $('run-retry').onclick = saveEduCreds;
  chrome.runtime.sendMessage({ type: 'edu-creds-get' }).then((r) => { if (r?.empNo && $('edu-id-input')) $('edu-id-input').value = r.empNo; }).catch(() => {});
  setTimeout(() => $('edu-id-input')?.focus(), 50);
  $('edu-pw-input')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveEduCreds(); });
}
async function saveEduCreds() {
  const empNo = ($('edu-id-input')?.value || '').trim();
  const password = ($('edu-pw-input')?.value || '').trim();
  if (!empNo) { $('edu-id-msg').textContent = '사번을 입력하세요'; return; }
  $('run-retry').disabled = true;
  const res = await chrome.runtime.sendMessage({ type: 'edu-creds-save', empNo, password });
  $('run-retry').disabled = false;
  if (!res?.ok) { $('edu-id-msg').textContent = res?.error || '저장 실패'; return; }
  if (current) start(current);
}

// 로그인하기 → 로그인 페이지 열고 완료 대기 → 그 자동화 자동 재실행
// 앱을 사람이 여는 동안 지켜보다가 주소를 잡으면 자동으로 이어서 실행한다.
//
// ⚠ 이 감시는 반드시 패널에서 돈다. 백그라운드(서비스 워커)에 두면 안 된다 —
//    MV3 서비스 워커는 잠깐 놀면 크롬이 죽여서 몇 분짜리 폴링이 중간에 끊기고,
//    패널은 응답을 영영 못 받은 채 "창을 열었어요"에 멈춰 있게 된다.
//    사이드 패널은 열려 있는 동안 살아 있고 확장 페이지라 tabs·scripting을 직접 쓴다.
const APP_TAB_PATTERNS = ['https://www.bizplay.co.kr/*', 'https://*.appplay.co.kr/*'];
const CAPTURE_MS = 180000;

// 미결의 목록 화면인지 — id가 없는 실물 화면도 통과하도록 내용으로 본다.
function isReceiptListPage() {
  const t = document.body ? document.body.innerText || '' : '';
  if (/대기\s*\(\d+\)/.test(t) || /결의상태/.test(t)) return true;
  return [...document.querySelectorAll('table tr')].some((tr) =>
    tr.querySelectorAll('td').length >= 8 && /\d{4}-\d{2}-\d{2}/.test(tr.innerText || ''));
}

// 무엇을 봤는지 함께 돌려준다. 실패 이유를 삼키면 "못 찾았다"만 남아 손을 못 댄다.
async function findOpenAppUrl() {
  const notes = [];
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: APP_TAB_PATTERNS });
  } catch (e) { return { url: '', notes: [`탭 목록을 못 읽음: ${e.message}`] }; }
  if (!tabs.length) notes.push('비즈플레이·appplay 탭이 열려 있지 않아요');
  for (const t of tabs) {
    if (!t.url) { notes.push('(주소를 읽을 수 없는 탭)'); continue; }
    const short = t.url.replace(/^https?:\/\//, '').slice(0, 60);
    if (/main_0003|bizpr_main/.test(t.url)) { notes.push(`${short} → 런처 화면(건너뜀)`); continue; }
    try {
      const hits = await chrome.scripting.executeScript({
        target: { tabId: t.id, allFrames: true }, func: isReceiptListPage,
      });
      if ((hits || []).some((h) => h.result)) return { url: t.url, notes };
      notes.push(`${short} → 미결의 목록이 아님`);
    } catch (e) {
      notes.push(`${short} → 읽지 못함: ${e.message}`);
    }
  }
  return { url: '', notes };
}

async function captureAppUrlThenRetry(needsAppUrl) {
  const mine = current;            // 이 대기가 끝날 때까지 화면 주인이 그대로인지 확인용
  $('run-actions').hidden = true;
  const say = (msg) => { $('run-err').innerHTML = `<div style="font-size:13px;color:var(--ink);line-height:1.6">${msg}</div>`; };

  // 이미 열려 있으면 굳이 새로 열지 않는다(지금 화면에 띄워 둔 경우가 많다).
  let { url, notes } = await findOpenAppUrl();
  if (!url) {
    await chrome.tabs.create({ url: 'https://www.bizplay.co.kr/main_0003_01.act', active: true });
    say(`<b>${esc(needsAppUrl.service)}</b> 창을 열었어요 · <b>${esc(needsAppUrl.app)}</b>을 눌러 열면 자동으로 이어서 실행합니다`);
  }
  const deadline = Date.now() + CAPTURE_MS;
  while (!url && Date.now() < deadline) {
    await sleep(1200);
    ({ url, notes } = await findOpenAppUrl());
    const left = Math.ceil((deadline - Date.now()) / 1000);
    if (!url) say(`<b>${esc(needsAppUrl.app)}</b>을 여는 중인지 지켜보고 있어요 · ${left}초 남음`
      + `<div class="cap-notes">${(notes || []).map((n) => esc(n)).join('<br>')}</div>`);
  }
  if (!url) {
    // 자동으로 못 잡았으면 손으로 넣게 한다. 주소창을 복사해 붙이면 끝난다.
    say(`<b>${esc(needsAppUrl.app)}</b> 주소를 자동으로 잡지 못했어요.`
      + `<div class="cap-notes">${(notes || []).map((n) => esc(n)).join('<br>')}</div>`
      + `<div style="margin-top:9px">카드영수증 화면의 <b>주소창을 복사해</b> 붙여넣어 주세요.</div>`
      + `<input id="cap-url" placeholder="https://…/rcard_main.act" style="width:100%;margin-top:7px;padding:8px 10px;border:1px solid #d9dcec;border-radius:9px;font:inherit;font-size:12.5px">`);
    $('run-actions').hidden = false;
    $('run-retry').textContent = '이 주소로 계속';
    $('run-retry').onclick = async () => {
      const v = ($('cap-url')?.value || '').trim();
      if (!/^https?:\/\//.test(v)) { $('cap-url')?.focus(); return; }
      await chrome.storage.local.set({ bizplayCardAppUrl: v });
      $('run-actions').hidden = true;
      if (current !== mine) return;
      buildSteps(mine);
      await execute(mine);
    };
    return;
  }
  await chrome.storage.local.set({ bizplayCardAppUrl: url });
  say(`앱 주소를 기억했어요 · <span style="color:var(--muted)">${esc(url)}</span><br>이어서 실행합니다…`);
  await sleep(400);
  if (current !== mine) return;   // 기다리는 동안 다른 자동화로 옮겨갔으면 조용히 물러난다
  buildSteps(mine);
  await execute(mine);
}

async function loginThenRetry(needsLogin) {
  const mine = current;   // 로그인은 몇 분이 걸릴 수 있다 — 그 사이 화면이 바뀌면 물러난다
  $('run-err').innerHTML = `<div style="display:flex;align-items:center;gap:9px;color:#5a6172;font-size:13px">
    <span class="dot" style="width:16px;height:16px;border:2px solid var(--blue);border-top-color:transparent;border-radius:50%;animation:spin .7s linear infinite"></span>
    <b>${esc(needsLogin.service)}</b> 로그인 창을 열었어요 · 로그인하면 자동으로 이어서 실행합니다</div>`;
  $('run-actions').hidden = true;
  const res = await chrome.runtime.sendMessage({ type: 'login', loginUrl: needsLogin.loginUrl });
  if (res?.ok && current === mine) return start(mine);   // 로그인 완료 → 재실행
  if (current !== mine) return;                          // 그 사이 다른 화면으로 옮겨갔으면 조용히
  // 시간 초과·취소
  $('run-err').innerHTML = `<div style="color:var(--red);font-weight:600">로그인이 확인되지 않았어요</div>
    <div style="font-size:12.5px;color:var(--muted);margin-top:2px">로그인을 마친 뒤 다시 시도해주세요.</div>`;
  $('run-actions').hidden = false;
}

// 실행 중 "무엇을 시도하고 어떻게 됐는지"를 한 줄씩 쌓는다.
// 오래 걸리는 단계(앱 열기 등)에서 멈춘 건지 계속 도는 건지 눈으로 구분되게.
function liveLog(what, result) {
  const box = $('run-live');
  if (!box) return;
  box.hidden = false;
  const row = document.createElement('div');
  const cls = result == null ? '' : /못|실패|없음|아님/.test(String(result)) ? 'no' : 'ok';
  row.innerHTML = `<b>${esc(what)}</b>${result ? ` <span class="${cls}">→ ${esc(result)}</span>` : ' …'}`;
  box.appendChild(row);
  box.scrollTop = box.scrollHeight;
}

// ── 단계 로그 ──
let stepEls = [];
function buildSteps(auto) {
  stepEls = [];
  $('steps').innerHTML = (auto.steps || ['처리 중']).map((label, i) =>
    `<div class="step ${i === 0 ? 'active' : 'wait'}" data-i="${i}">
       <span class="dot"></span><span class="tx">${esc(label)}</span></div>`).join('');
  stepEls = [...$('steps').children];
}
// 진행 메시지 텍스트로 해당 단계를 찾아 활성화(그 앞 단계는 완료 처리)
function advanceTo(text) {
  const idx = stepEls.findIndex((el) => el.classList.contains('active'));
  // 메시지에 포함된 키워드로 매칭, 없으면 다음 단계로 한 칸
  let target = stepEls.findIndex((el) => {
    const label = el.querySelector('.tx').textContent;
    return text.includes(label.slice(0, 4));
  });
  if (target < 0) target = Math.min(idx + 1, stepEls.length - 1);
  stepEls.forEach((el, i) => {
    el.classList.remove('active', 'wait', 'done');
    el.classList.add(i < target ? 'done' : i === target ? 'active' : 'wait');
  });
}
function markAllDone() {
  stepEls.forEach((el) => { el.classList.remove('active', 'wait', 'err'); el.classList.add('done'); });
}
function failCurrentStep(message, needsLogin, detail, needsAppUrl) {
  const active = stepEls.find((el) => el.classList.contains('active')) || stepEls[stepEls.length - 1];
  active?.classList.remove('active');
  active?.classList.add('err');
  $('run-err').hidden = false;

  if (needsLogin) {
    // 로그인만 하면 되는 상황 — 원클릭으로 로그인 → 자동 재실행
    $('run-err').innerHTML = `<div style="color:var(--ink);font-weight:600;margin-bottom:3px">${esc(needsLogin.service)} 로그인이 필요해요</div>
      <div style="font-size:12.5px;color:var(--muted)">로그인하면 <b>이 자동화를 자동으로 이어서</b> 실행합니다.</div>`;
    $('run-actions').hidden = false;
    $('run-retry').textContent = `${needsLogin.service} 로그인하기`;
    $('run-retry').onclick = () => loginThenRetry(needsLogin);
    return;
  }

  if (needsAppUrl) {
    // 이 앱 타일은 확장이 눌러도 반응하지 않는다(브라우저가 만든 진짜 클릭만 받는다).
    // 사람이 한 번만 직접 열면 주소를 기억해 다음부터는 바로 조회한다.
    $('run-err').innerHTML = `<div style="color:var(--ink);font-weight:600;margin-bottom:3px">${esc(needsAppUrl.app)} 앱을 한 번만 직접 열어주세요</div>
      <div style="font-size:12.5px;color:var(--muted)">이 앱 아이콘은 <b>사람이 누른 클릭만</b> 받아서 확장이 대신 못 눌러요.
        한 번 열어 두면 주소를 기억해 <b>다음부터는 바로</b> 조회합니다.</div>`;
    $('run-actions').hidden = false;
    $('run-retry').textContent = `${esc(needsAppUrl.app)} 열기`;
    $('run-retry').onclick = () => captureAppUrlThenRetry(needsAppUrl);
    return;
  }

  // 어느 단계에서 멈췄는지 + 원인 + (있으면) 다음 할 일/기술 상세
  const stepLabel = active?.querySelector('.tx')?.textContent || '';
  const hasDetail = detail && detail !== message;
  $('run-err').innerHTML = `
    <div style="display:flex;align-items:baseline;gap:6px;margin-bottom:5px">
      ${stepLabel ? `<span style="flex:none;font-size:11px;font-weight:700;color:#fff;background:var(--red);border-radius:6px;padding:2px 7px">${esc(stepLabel)}</span>` : ''}
      <span style="color:var(--red);font-weight:700">에서 막혔어요</span>
    </div>
    <div style="font-size:13px;color:var(--ink);margin-bottom:6px">${esc(message)}</div>
    ${hasDetail ? `<button id="err-more" style="font-size:12px;color:var(--muted);background:none;border:0;padding:0;cursor:pointer;text-decoration:underline">왜 그런지 자세히</button>
      <div id="err-detail" hidden style="font-size:12px;color:var(--muted);line-height:1.6;margin-top:6px;padding:9px 11px;background:var(--soft);border-radius:8px;white-space:pre-wrap">${esc(detail)}</div>` : ''}`;
  $('run-actions').hidden = false;
  $('run-retry').textContent = '다시 시도';
  $('run-retry').onclick = () => current && start(current);
  const more = $('err-more');
  if (more) more.onclick = () => { const d = $('err-detail'); d.hidden = !d.hidden; more.textContent = d.hidden ? '왜 그런지 자세히' : '접기'; };
}

// 백그라운드 진행 메시지. evidence가 붙어 오면 실행 기록으로 쌓는다 —
// 수집 탭이 뒤에서 돌아 스크린샷을 못 찍는 대신, 어느 주소에서 무엇을 읽었는지 남긴다.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'progress' || !current) return;
  advanceTo(msg.text || '');
  if (msg.evidence) {
    trace.push({ step: msg.text || '', at: Date.now(), data: msg.evidence });
    if (msg.evidence.try) liveLog(msg.evidence.try, msg.evidence.result);   // 진행 중 한 줄짜리 시도 기록
  }
});

// 버전 표시 — 사용자가 화면을 캡처해 보낼 때 어느 빌드인지 바로 드러나야 한다.
// version_name에 빌드 표식이 들어 있고(예: "0.1.0 (2026-08-05b)") 없으면 version으로 떨어진다.
{
  const mf = chrome.runtime.getManifest();
  const el = $('app-ver');
  if (el) el.textContent = `v${mf.version_name || mf.version}`;
}

// ── 상단바 · 연도 ──
for (const y of [thisYear, thisYear - 1]) {
  const o = document.createElement('option');
  o.value = String(y); o.textContent = `${y}년`;
  $('year').appendChild(o);
}
$('month').value = `${thisYear}-${String(kstNow().getUTCMonth() + 1).padStart(2, '0')}`; // 기본: 이번 달
$('back').addEventListener('click', goHome);
$('run-home').addEventListener('click', goHome);
// run-retry의 동작은 failCurrentStep에서 상황에 맞게 onclick으로 지정한다(재시도 / 로그인하기)
// 결과 화면에서 연도·월 바꾸면 즉시 재실행
$('year').addEventListener('change', () => current && start(current));
$('month').addEventListener('change', () => current && start(current));
const monthLabel = (v) => { const [y, m] = (v || '').split('-'); return y ? `${y}년 ${+m}월` : ''; };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

renderHome();
goHome();
refreshContext(); // 지금 보고 있는 사이트 반영

// ════════ 자동화별 결과 렌더 ════════

function renderLeave(d) {
  const bal = d.leaveBalance || [];
  const kpis = bal.length ? bal.map((b) => `
    <div class="kpi"><div class="l">${esc(shortLeaveType(b.type))} · 남은 연차</div>
      <div class="v">${b.remaining}<span style="font-size:14px;color:var(--muted);font-weight:600"> / ${b.total}일</span></div>
      <div class="l">만료 ${esc(b.expire)}</div></div>`).join('')
    : '<div class="kpi"><div class="l">잔여 정보 없음</div><div class="v">-</div></div>';

  const pace = bal.filter((b) => b.remaining > 0).map((b) => {
    const months = monthsUntil(b.expire);
    return `⏳ ${esc(shortLeaveType(b.type))} 만료까지 ${months}개월 · 월 <b>${(b.remaining / months).toFixed(1)}일</b>씩 쓰면 소진`;
  }).join('<br>');

  $('view-result').innerHTML = `
    <div class="card">
      <h2>얼마나 남았는지</h2>
      <div class="kpis">${kpis}</div>
      ${pace ? `<p style="color:#c07d13;font-size:12.5px;margin:12px 0 0;font-weight:600">${pace}</p>` : ''}
    </div>
    <div class="card">
      <h2><span id="cal-title">연간 달력</span><span class="side" id="cal-sum"></span></h2>
      <div class="yc-legend" id="legend" style="margin:0 0 16px"></div>
      <div class="yc-grid" id="cal"></div>
      <p class="foot">타임인아웃 내 페이지 기준(본인 것만) · 이 해에 쓴 휴가 전체.</p>
    </div>`;
  renderYearCalendar(String(d.year), d.leaveHistory || [], d.holidays || {});
}

// 초과근무 분석 결과 — 합계 KPI + 차트 + 일자별 표.
// 합계는 코어 summarizeDays로 다시 뽑는다(누락·의심일 제외, 정정일은 토글).
// 웹 대시보드와 같은 규칙이어야 같은 숫자가 나온다.
function renderOvertime(d) {
  const days = d.days || [];
  const s = days.length ? summarizeDays(days, { throughDay: d.summary?.spanDays || 0 }) : (d.summary || {});
  const over = s.overLimit;
  const dayList = (arr) => (arr || []).map((n) => `${n}일`).join(', ');
  $('view-result').innerHTML = `
    <div class="card">
      <h2>초과근무 요약<span class="side">${esc(d.month)}</span></h2>
      <div class="kpis">
        <div class="kpi wide"><div class="l">평일 초과근무 · 한도 52h</div>
          <div class="v" style="color:${over ? 'var(--red)' : 'var(--ink)'}">${esc(s.wdOtText || '-')}</div>
          ${gaugeHTML(s)}
          <div class="l">${over
            ? `한도 ${fmtHours(s.limitOverMin)} 초과 ⚠`
            : `한도까지 ${fmtHours(s.limitRemainMin)} 남음`} · 정정·누락일 제외</div></div>
        <div class="kpi"><div class="l">휴일 근무</div><div class="v">${esc(s.holText || '-')}</div>
          <div class="l">52h 한도와 별도 집계</div></div>
        <div class="kpi"><div class="l">주 평균 근로</div><div class="v">${esc(s.weeklyAvgText || '-')}</div>
          <div class="l">${s.spanDays || 0}일 ÷ ${s.weeks || 0}주 · 정정 포함</div></div>
        <div class="kpi wide"><div class="l">평균 출퇴근 <span style="color:var(--faint)">평일 ${s.avgOutDays || 0}일 기준</span></div>
          <div class="avg-inout">
            <span><b>${esc(s.avgInText || '-')}</b><i>출근</i></span>
            <em>→</em>
            <span><b>${esc(s.avgOutText || '-')}</b><i>퇴근</i></span>
            ${s.avgStayText ? `<span class="stay"><b>${esc(s.avgStayText)}</b><i>체류</i></span>` : ''}
          </div></div>
        <div class="kpi wide"><div class="l">총 근로 <span style="color:var(--faint)">(정정 포함)</span></div>
          <div class="v" style="font-size:20px">${esc(s.totalAllText || '-')}
            <span style="font-size:13px;font-weight:600;color:var(--muted)">= 8시간 기준 ${s.fullDays ?? '-'}일치</span></div>
          <div class="l">회사 인정 ${esc(s.recogText || '-')}</div></div>
      </div>
      <p class="ot-excl-note">${[
        (s.correctedDays || []).length ? `정정 ${s.correctedDays.length}일 [${esc(dayList(s.correctedDays))}] → 초과근무에서 제외 · 총 근로엔 포함` : '',
        (s.missingDays || []).length ? `기록 누락 ${s.missingDays.length}일 [${esc(dayList(s.missingDays))}] → 전부 제외` : '',
        (s.suspectDays || []).length ? `미체크아웃 의심 ${s.suspectDays.length}일 [${esc(dayList(s.suspectDays))}] → 전부 제외` : '',
      ].filter(Boolean).join(' · ') || '제외된 날 없음'}</p>
    </div>
    <div class="card">
      <h2>출퇴근 시각 분포</h2>
      <div class="chart-wrap">
        <canvas id="clock"></canvas>
        <div class="chart-tip" id="clock-tip" hidden></div>
      </div>
      <div class="chart-legend" id="clock-legend"></div>
      <p class="foot">막대 = 그날 출근~퇴근. 위가 이른 시각이고 <b>아래로 길수록 야근</b>이다.
        24시 빨간 선 아래는 익일 퇴근. 막대를 누르면 그날 상세가 나온다.</p>
    </div>
    <div class="card">
      <h2>일자별 <span class="side">초과·휴일근무·누락만</span></h2>
      <div class="ot-list" id="ot-rows"></div>
      <p class="foot">찐 출퇴근(펀치) 기준 · 초과 없는 평범한 날은 생략.</p>
    </div>`;

  if (days.length) {
    $('clock-legend').innerHTML = legendHTML(days);
    clockChart?.destroy();
    clockChart = mountClockChart($('clock'), $('clock-tip'), days);
  }

  const rows = (d.days || []).filter((x) => x.otMin > 0 || x.holMin > 0 || x.missing || x.suspect);
  $('ot-rows').innerHTML = rows.map((x) => {
    const otM = x.otMin || x.holMin;
    const kind = x.missing ? 'miss' : x.holMin ? 'hol' : otM ? 'ot' : '';
    const times = (x.inText || x.outText)
      ? `${esc(x.inText || '–')} <span class="ar">→</span> ${esc(x.outText || '–')}${x.projected ? ' <span class="pj">진행중</span>' : ''}`
      : '<span class="none">기록 없음</span>';
    const note = x.missing ? esc(x.status || '기록 누락')
      : x.holiday ? '휴일근무' : x.corrected ? `정정 ${esc(x.correctStatus || '')}` : esc(x.status || '');
    return `<div class="ot-row ${kind}">
      <div class="ot-day">${x.day}<span>${esc(x.dow)}</span></div>
      <div class="ot-mid"><div class="ot-time">${times}</div>${note ? `<div class="ot-note">${note}</div>` : ''}</div>
      <div class="ot-badge">${otM ? '+' + fmtMinShort(otM) : '–'}</div>
    </div>`;
  }).join('') || `<div style="padding:18px;text-align:center;color:var(--muted)">초과근무·누락이 없어요 🎉</div>`;
}

// 52h 한도 게이지. 한도의 대상은 '평일 초과근무'다 — 휴일근무는 여기 안 들어간다.
// 30h 지점에 수당 발생선을 세우고, 넘긴 달은 트랙을 꽉 채워 초과량을 옆에 적는다.
const LIMIT_H = 52, PAY_H = 30;
const fmtHours = (min) => `${(Math.max(0, min || 0) / 60).toFixed(1)}h`;
function gaugeHTML(s) {
  const h = (s.wdOtMin || 0) / 60;
  const pct = Math.max(0, Math.min(100, (h / LIMIT_H) * 100));
  const over = h > LIMIT_H;
  return `<div class="gauge" role="img" aria-label="평일 초과근무 ${h.toFixed(1)}시간 / 한도 ${LIMIT_H}시간">
    <div class="gauge-fill" style="width:${pct}%;background:${over ? 'var(--red)' : h >= PAY_H ? '#e08b1a' : 'var(--blue)'}"></div>
    <div class="gauge-mark" style="left:${(PAY_H / LIMIT_H) * 100}%" title="${PAY_H}시간부터 수당 발생"></div>
  </div>`;
}

// ── 실행 기록 ──
// 수집 탭은 뒤에서(active:false) 돌아 captureVisibleTab 대상이 아니라 화면을 못 찍는다.
// 대신 단계마다 "어느 주소에서 무엇을 읽었는지"를 남긴다. 숫자가 이상할 때
// 어디서 어긋났는지 여기서 짚을 수 있다.
function appendTrace() {
  if (!trace.length) return;
  const secs = (t) => `${((t - traceStart) / 1000).toFixed(1)}초`;
  const row = ([k, v]) => {
    const val = Array.isArray(v)
      ? `<ul class="tr-list">${v.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`
      : `<span class="tr-v${/^https?:/.test(String(v)) ? ' url' : ''}">${esc(v)}</span>`;
    return `<div class="tr-kv"><span class="tr-k">${esc(k)}</span>${val}</div>`;
  };
  const html = `
    <details class="card trace">
      <summary><b>실행 기록</b><span>${trace.length}단계 · ${secs(trace[trace.length - 1].at)}</span></summary>
      <div class="tr-body">
        ${trace.map((t) => `
          <div class="tr-step">
            <div class="tr-hd">${esc(t.step)}<em>${secs(t.at)}</em></div>
            ${Object.entries(t.data).filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && !v.length)).map(row).join('')}
          </div>`).join('')}
      </div>
      <p class="foot">화면을 그대로 찍지는 않는다 — 수집 탭이 뒤에서 돌아 캡처 대상이 아니다.
        대신 어느 주소에서 무엇을 읽었는지 남긴다.</p>
    </details>`;
  $('view-result').insertAdjacentHTML('beforeend', html);
}

const fmtMin = (m) => `${Math.floor(m / 60)}시간 ${String(Math.round(m % 60)).padStart(2, '0')}분`;
const fmtMinShort = (m) => { const h = Math.floor(m / 60), mm = Math.round(m % 60); return h ? `${h}:${String(mm).padStart(2, '0')}` : `${mm}분`; };

// 야근택시·야근식비 공용 — 후보 판정 뒤 인정 건을 결재 1건으로 묶어 실제 상신할 수 있다.
function renderExpense(d, kind) {
  const s = d.summary || {};
  const isTaxi = kind === 'yagun';
  const okLabel = isTaxi ? '증빙 있음' : '인정';
  const okCount = isTaxi ? s.withProof : s.eligible;
  const noCount = isTaxi ? s.noProof : s.excluded;
  $('view-result').innerHTML = `
    <div class="card">
      <h2>${isTaxi ? '야근택시' : '야근식비'} 미결의<span class="side">${esc(d.month)}</span></h2>
      <div class="kpis">
        <div class="kpi"><div class="l">${okLabel}</div><div class="v" style="color:var(--ok)">${okCount ?? 0}<span style="font-size:14px;color:var(--muted);font-weight:600">건</span></div>
          <div class="l">${esc(s.amountText || '0원')}</div></div>
        <div class="kpi"><div class="l">제외</div><div class="v" style="font-size:19px">${noCount ?? 0}건</div></div>
      </div>
      <p style="color:var(--muted);font-size:12px;margin:12px 0 0">타임인아웃 근태로 ${isTaxi ? '심야택시=그날 야근 여부' : '저녁=야근 / 조식=이른출근'}를 판정합니다. 인정 건만 아래에서 결재로 올릴 수 있어요.</p>
    </div>
    <div class="card">
      <h2>후보 목록 <span class="side">전체 ${s.count ?? 0}건</span></h2>
      <div class="cr-list" id="ex-rows"></div>
      <p class="foot">미결의(대기)에서 ${isTaxi ? '심야택시(23~03시)' : '1인 식대(13,000 이내·저녁/조식)'}만.</p>
    </div>
    ${isTaxi && d.proofFile?.base64 ? `<div class="card evidence-preview" id="taxi-proof-preview">
      <h2>상신할 근태 증빙 <span class="side">클릭하면 크게 보기 ↗</span></h2>
      <p class="evidence-desc">위 인정 건을 타임인아웃 실제 출퇴근 기록과 묶은 이미지입니다. 실제 상신 때 아래 파일 그대로 첨부합니다.</p>
      <button class="evidence-open" id="taxi-proof-open" type="button" title="근태 증빙 크게 보기">
        <img src="data:${esc(d.proofFile.type || 'image/png')};base64,${d.proofFile.base64}" alt="${esc(d.month)} 야근택시 타임인아웃 근태 증빙">
      </button>
    </div>` : ''}
    <div class="card write-card" id="expense-write">
      <div class="write-title">${isTaxi ? '야근교통비 결의서 준비하기' : '야근식비 결재 올리기'}</div>
      <div class="write-desc">인정 건을 모두 선택해 <b>결재 1건</b>으로 묶습니다.${isTaxi
        ? ' 용도 입력과 증빙 PNG 생성까지 자동으로 하고, 파일첨부·결재요청은 열린 Bizplay 화면에서 직접 마무리합니다.' : ''}</div>
      <button class="btn btn-primary" id="expense-submit-open">상신 대상 확인</button>
      <div class="write-confirm" id="expense-submit-confirm" hidden>
        <b id="expense-submit-warning"></b>
        <p>${isTaxi ? '결의서와 용도만 준비하며 자동 상신하지 않습니다. 열린 Bizplay 화면에서 증빙을 첨부한 뒤 직접 결재요청하세요.'
          : '이 작업은 비즈플레이에서 결의서를 만들고 결재선 ‘법인카드 지출결의서’로 실제 상신합니다.'}</p>
        <div class="write-buttons"><button class="btn ${isTaxi ? 'btn-primary' : 'btn-danger'}" id="expense-submit-go">${isTaxi ? '결의서 준비하고 화면 열기' : '확인하고 실제 상신'}</button>
          <button class="btn btn-ghost" id="expense-submit-cancel">취소</button></div>
      </div>
    </div>`;

  const rows = d.items || [];
  $('ex-rows').innerHTML = rows.map((x) => {
    const ok = isTaxi ? x.hasProof : x.eligible;
    const date = (x.yagunDate || x.mealDate || x.date || '').slice(5); // MM-DD
    const proof = isTaxi
      ? (ok ? `야근 ${esc(x.otText || '')}${x.isHoliday ? ' (휴일)' : ''}` : '그날 야근 기록 없음')
      : (esc(x.why || ''));
    return `<div class="cr-row ${ok ? 'done' : 'miss'}">
      <div class="cr-day" style="width:46px;font-size:12px">${esc(date)}<span>${esc(x.dow || '')}</span></div>
      <div class="cr-mid">
        <div class="cr-case" style="color:${ok ? 'var(--ok)' : 'var(--muted)'}">${esc(x.merchant || '')}</div>
        <div class="cr-detail">${x.amount ? x.amount.toLocaleString('en-US') + '원' : ''} · ${proof}</div>
      </div>
      <div class="cr-badge ${ok ? 'ok' : ''}" style="${ok ? '' : 'color:#c1c8d6'}">${ok ? '✓' : '–'}</div>
    </div>`;
  }).join('') || `<div style="padding:18px;text-align:center;color:var(--muted)">후보가 없어요 🎉</div>`;

  const proofOpen = $('taxi-proof-open');
  if (proofOpen) proofOpen.onclick = async () => {
    await chrome.storage.session.set({ webwingEvidencePreview: d.proofFile });
    await chrome.tabs.create({ url: chrome.runtime.getURL('page/evidence.html') });
  };

  const targets = rows.filter((x) => isTaxi ? x.hasProof : x.eligible);
  const amount = targets.reduce((sum, x) => sum + Number(x.amount || 0), 0);
  const open = $('expense-submit-open');
  if (!targets.length) {
    open.disabled = true; open.textContent = '상신할 인정 건 없음'; open.style.opacity = '.55';
  } else {
    open.textContent = `${targets.length}건 · ${amount.toLocaleString('en-US')}원 대상 확인`;
    open.onclick = () => {
      $('expense-submit-warning').textContent = isTaxi
        ? `${targets.length}건 · ${amount.toLocaleString('en-US')}원 결의서를 준비하고 수동 마무리 화면을 엽니다`
        : `${targets.length}건 · ${amount.toLocaleString('en-US')}원을 결재 1건으로 실제 상신합니다`;
      $('expense-submit-confirm').hidden = false; open.hidden = true;
    };
    $('expense-submit-cancel').onclick = () => { $('expense-submit-confirm').hidden = true; open.hidden = false; };
    $('expense-submit-go').onclick = () => runWriteAction({
      payload: { type: 'expense-submit', kind, month: d.month, items: targets, proofFile: isTaxi ? d.proofFile : null },
      label: isTaxi ? '야근교통비 결의서 준비' : '야근식비 상신',
      subtitle: isTaxi ? '수동 마무리 준비' : '실제 제출',
      steps: isTaxi ? ['상신 대상 다시 확인', '결의서 작성', '용도 입력', '수동 마무리 화면 열기']
        : ['상신 대상 다시 확인', '결의서 작성', '용도 입력', '결재선 선택', '상신 완료 확인'],
      render: renderExpenseSubmit,
    });
  }
}

function renderExpenseSubmit(d) {
  const s = d.summary || {}, isTaxi = d.kind === 'yagun';
  if (d.recipe === 'expense-manual-finish') {
    const file = d.proofFile || {};
    $('view-result').innerHTML = `<div class="card">
      <h2>결의서 준비 완료<span class="side">${esc(d.month || '')}</span></h2>
      <div class="kpis"><div class="kpi"><div class="l">준비한 영수증</div><div class="v" style="color:var(--ok)">${s.prepared ?? 0}건</div>
        <div class="l">${Number(s.amount || 0).toLocaleString('en-US')}원</div></div>
        <div class="kpi"><div class="l">자동 상신</div><div class="v" style="font-size:19px;color:var(--muted)">안 함</div></div></div>
      <p style="color:var(--muted);font-size:12px;margin:12px 0 0">Bizplay 결의서에 ${s.prepared ?? 0}건과 용도 ‘야근교통비’를 입력해 두었습니다. 실제 상신은 아직 하지 않았어요.</p>
    </div><div class="card write-card">
      <div class="write-title">마지막 두 단계만 직접 해주세요</div>
      <div class="write-desc">① 증빙 PNG 다운로드 → ② 열린 카드영수증 결의서에서 파일첨부 → ③ 결재요청</div>
      <div class="write-buttons">
        <a class="btn btn-primary" id="manual-proof-download" href="data:${esc(file.type || 'image/png')};base64,${file.base64 || ''}" download="${esc(file.name || 'webwing-yagun-evidence.png')}">증빙 PNG 다운로드</a>
        <button class="btn btn-ghost" id="manual-open-bizplay" type="button">카드영수증 결의서 열기</button>
      </div>
    </div>`;
    $('manual-open-bizplay').onclick = () => chrome.tabs.update(Number(d.appTabId), { active: true }).catch(() => {});
    return;
  }
  $('view-result').innerHTML = `<div class="card">
    <h2>${isTaxi ? '야근교통비' : '야근식비'} 상신 완료<span class="side">${esc(d.month || '')}</span></h2>
    <div class="kpis"><div class="kpi"><div class="l">상신한 영수증</div><div class="v" style="color:var(--ok)">${s.submitted ?? 0}건</div>
      <div class="l">${Number(s.amount || 0).toLocaleString('en-US')}원</div></div>
      <div class="kpi"><div class="l">생성된 결재</div><div class="v">${s.approvals ?? 0}건</div></div></div>
    <p style="color:var(--muted);font-size:12px;margin:12px 0 0">${isTaxi ? '타임인아웃 근태 증빙을 첨부해 ' : ''}결재선 ‘법인카드 지출결의서’로 요청했습니다.</p>
  </div><div class="card"><h2>상신 항목</h2><div class="cr-list">${(d.submitted || []).map((x) => `
    <div class="cr-row done"><div class="cr-day" style="width:52px;font-size:11px">${esc((x.date || '').slice(5, 10))}</div>
      <div class="cr-mid"><div class="cr-case">${esc(x.merchant || '')}</div><div class="cr-detail">${Number(x.amount || 0).toLocaleString('en-US')}원</div></div>
      <div class="cr-badge ok">✓</div></div>`).join('')}</div></div>`;
}

// 출퇴근 정정 결과 — 누락일별 제안을 확인한 뒤 실제 수정 요청까지 이어진다.
function renderCorrection(d) {
  const s = d.summary || {};
  $('view-result').innerHTML = `
    <div class="card">
      <h2>정정 대상<span class="side">${esc(d.month)}</span></h2>
      <div class="kpis">
        <div class="kpi"><div class="l">신청 필요</div><div class="v" style="color:${s.need ? 'var(--blue)' : 'var(--ok)'}">${s.need ?? 0}<span style="font-size:14px;color:var(--muted);font-weight:600">건</span></div></div>
        <div class="kpi"><div class="l">이미 신청됨</div><div class="v" style="font-size:19px">${s.submitted ?? 0}건</div></div>
        ${s.excluded ? `<div class="kpi"><div class="l">근거 부족 제외</div><div class="v" style="font-size:19px;color:var(--muted)">${s.excluded}건</div></div>` : ''}
      </div>
      <p style="color:var(--muted);font-size:12px;margin:12px 0 0">Flow 캘린더 활동으로 실제 근무시간대를 추정합니다. 아래 제안을 확인한 뒤 타임인아웃 수정 요청으로 제출할 수 있어요.</p>
    </div>
    <div class="card">
      <h2>누락일별 제안</h2>
      <div class="cr-list" id="cr-rows"></div>
      <p class="foot">제안 = Flow 첫·마지막 활동 기준(출근 최대 10:30 · 퇴근 최소 18:00 · 9시간 보장). 양쪽 기록과 Flow 활동이 모두 없으면 자동 신청에서 제외합니다.</p>
    </div>
    <div class="card write-card" id="correction-write">
      <div class="write-title">타임인아웃에 정정 신청</div>
      <div class="write-desc">제안 시각이 있는 미신청 건만 날짜별로 <b>수정 요청</b>합니다. 이미 신청된 날짜는 건드리지 않아요.</div>
      <button class="btn btn-primary" id="correction-submit-open">신청 대상 확인</button>
      <div class="write-confirm" id="correction-submit-confirm" hidden>
        <b id="correction-submit-warning"></b>
        <p>이 작업은 실제 인사 시스템에 정정 요청을 제출합니다. 날짜와 시각을 다시 확인해주세요.</p>
        <textarea id="correction-submit-memo">실제 근무시간으로 정정 요청 (Webwing)</textarea>
        <div class="write-buttons"><button class="btn btn-danger" id="correction-submit-go">확인하고 실제 신청</button>
          <button class="btn btn-ghost" id="correction-submit-cancel">취소</button></div>
      </div>
    </div>`;

  const rows = d.items || [];
  $('cr-rows').innerHTML = rows.map((x) => {
    const day = +x.date.slice(8, 10);
    if (x.submitted) {
      return `<div class="cr-row done">
        <div class="cr-day">${day}<span>${esc(x.dow)}</span></div>
        <div class="cr-mid"><div class="cr-case">신청됨 · ${esc(x.subStatus || '')}</div>
          <div class="cr-detail">신청 ${esc(x.reqIn || '')}~${esc(x.reqOut || '')}</div></div>
        <div class="cr-badge ok">✓</div></div>`;
    }
    const flow = x.hasEvidence ? `Flow ${esc(x.flowFirst || '?')}~${esc(x.flowLast || '?')}` : 'Flow 활동 없음';
    const actionable = !!(x.suggestIn && x.suggestOut);
    return `<div class="cr-row" data-actionable="${actionable}">
      <div class="cr-day">${day}<span>${esc(x.dow)}</span></div>
      <div class="cr-mid">
        <div class="cr-case">${esc(x.status || '')}</div>
        <div class="cr-detail">현재 ${esc(x.curIn || '–')}~${esc(x.curOut || '–')} · ${flow}${actionable ? '' : ' · 자동 제안 제외'}</div>
      </div>
      <div class="cr-sug">${actionable ? `${esc(x.suggestIn)}<span class="ar">→</span>${esc(x.suggestOut)}` : '제외'}</div>
    </div>`;
  }).join('') || `<div style="padding:18px;text-align:center;color:var(--muted)">정정할 누락일이 없어요 🎉</div>`;

  const targets = rows.filter((x) => !x.submitted && x.suggestIn && x.suggestOut)
    .map((x) => ({ date: x.date, in: x.suggestIn, out: x.suggestOut }));
  const open = $('correction-submit-open');
  if (!targets.length) {
    open.disabled = true; open.textContent = '신청할 제안 없음'; open.style.opacity = '.55';
  } else {
    open.textContent = `${targets.length}건 신청 대상 확인`;
    open.onclick = () => {
      $('correction-submit-warning').textContent = `${targets.length}건을 실제 정정 신청합니다`;
      $('correction-submit-confirm').hidden = false;
      open.hidden = true;
    };
    $('correction-submit-cancel').onclick = () => { $('correction-submit-confirm').hidden = true; open.hidden = false; };
    $('correction-submit-go').onclick = () => runWriteAction({
      payload: { type: 'correction-submit', rows: targets, memo: $('correction-submit-memo').value.trim() },
      label: '출퇴근 정정 신청',
      steps: ['정정 신청 입력 중', '정정 신청 제출 중', '신청 결과 확인'],
      render: renderCorrectionSubmit,
    });
  }
}

function renderCorrectionSubmit(d) {
  const s = d.summary || {};
  $('view-result').innerHTML = `<div class="card">
    <h2>정정 신청 결과<span class="side">총 ${s.total ?? 0}건</span></h2>
    <div class="kpis"><div class="kpi"><div class="l">제출 완료</div><div class="v" style="color:var(--ok)">${s.ok ?? 0}건</div></div>
      <div class="kpi"><div class="l">실패</div><div class="v" style="color:${s.failed ? 'var(--red)' : 'var(--muted)'}">${s.failed ?? 0}건</div></div></div>
  </div><div class="card"><h2>날짜별 결과</h2><div class="cr-list">${(d.results || []).map((r) => `
    <div class="cr-row ${r.ok ? 'done' : 'miss'}"><div class="cr-day">${esc((r.date || '').slice(8))}</div>
      <div class="cr-mid"><div class="cr-case">${r.ok ? '신청 완료' : '실패'}</div><div class="cr-detail">${esc(r.in || '')}~${esc(r.out || '')} · ${esc(r.message || '')}</div></div>
      <div class="cr-badge ${r.ok ? 'ok' : ''}">${r.ok ? '✓' : '!'}</div></div>`).join('')}</div></div>`;
}

function monthsUntil(expireDate) {
  const now = kstNow();
  const exp = new Date(expireDate + 'T00:00:00Z');
  const months = (exp.getUTCFullYear() - now.getUTCFullYear()) * 12 + (exp.getUTCMonth() - now.getUTCMonth()) + 1;
  return Math.max(1, months);
}

function leaveColorMap(hist) {
  const map = { '연차휴가': '#3b6fe0' };
  let i = 1;
  for (const h of hist) if (!map[h.type]) map[h.type] = LEAVE_COLORS[i++ % LEAVE_COLORS.length];
  return map;
}

function renderYearCalendar(year, hist, holidays) {
  const colors = leaveColorMap(hist);
  const byDate = {};
  for (const h of hist) {
    const c = (byDate[h.date] = byDate[h.date] || { days: 0, parts: [] });
    c.days = +((c.days + h.days).toFixed(2));
    c.parts.push(h);
  }
  const now = kstNow();
  const todayStr = now.toISOString().slice(0, 10);
  const curMonth = +year === now.getUTCFullYear() ? now.getUTCMonth() + 1 : 0; // 조회연도가 올해면 이번 달 강조·스크롤
  const total = +(hist.reduce((s, h) => s + h.days, 0).toFixed(2));
  $('cal-title').textContent = `${year}년 달력`;
  $('cal-sum').textContent = `총 ${total}일 사용`;

  $('cal').innerHTML = Array.from({ length: 12 }, (_, k) => k + 1).map((m) => {
    const mo = `${year}-${String(m).padStart(2, '0')}`;
    const daysInMonth = new Date(Date.UTC(+year, m, 0)).getUTCDate();
    const firstDow = new Date(Date.UTC(+year, m - 1, 1)).getUTCDay();
    let sum = 0;
    const cells = [];
    for (let i = 0; i < firstDow; i++) cells.push('<div class="yc-cell pad"></div>');
    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${mo}-${String(day).padStart(2, '0')}`;
      const dow = new Date(Date.UTC(+year, m - 1, day)).getUTCDay();
      const hol = holidays[dateStr];
      const use = byDate[dateStr];
      if (use) sum = +((sum + use.days).toFixed(2));
      const isWorkersDay = hol === WORKERS_DAY;
      const cls = ['yc-cell'];
      if (dow === 0) cls.push('sun'); else if (dow === 6) cls.push('sat');
      if (isWorkersDay) cls.push('wday'); else if (hol || dow === 0) cls.push('hol');
      if (use) { cls.push('used'); if (use.days >= 1) cls.push('full'); }
      if (dateStr === todayStr) cls.push('today');
      let fill = '';
      if (use) {
        const op = Math.min(1, use.days);
        const color = colors[use.parts[0].type] || LEAVE_COLORS[0];
        fill = `<span class="yc-fill" style="background:${color};opacity:${op}"></span>`;
      }
      const tip = [`${dateStr}(${CAL_DOW[dow]})`, hol || '',
        use ? use.parts.map((p) => `${shortLeaveType(p.type)} ${p.detail} ${p.days}일`).join(' / ') : '']
        .filter(Boolean).join(' · ');
      cells.push(`<div class="${cls.join(' ')}" title="${esc(tip)}">${fill}<span class="n">${day}</span></div>`);
    }
    const holList = Object.entries(holidays).filter(([dt]) => dt.startsWith(mo))
      .map(([dt, name]) => `<div class="${name === WORKERS_DAY ? 'w' : ''}"><b>${+dt.slice(8)}일</b>${esc(name)}${name === WORKERS_DAY ? ' (유급휴일)' : ''}</div>`).join('');
    const isCur = m === curMonth;
    return `<div class="yc-month${isCur ? ' current' : ''}"${isCur ? ' data-current="1"' : ''}>
      <div class="yc-month-head"><span class="yc-month-name">${m}월${isCur ? '<span class="now">이번 달</span>' : ''}</span>
        <span class="yc-month-sum${sum ? '' : ' zero'}">${sum ? sum + '일' : '-'}</span></div>
      <div class="yc-days">
        ${CAL_DOW.map((n, i) => `<div class="yc-dow${i === 0 ? ' sun' : ''}">${n}</div>`).join('')}
        ${cells.join('')}
      </div>
      <div class="yc-hols">${holList}</div>
    </div>`;
  }).join('');

  const used = [...new Set(hist.map((h) => h.type))];
  const base = colors[used[0]] || LEAVE_COLORS[0];
  $('legend').innerHTML =
    [[1, '연차 (종일)'], [0.5, '반차'], [0.25, '반반차']].map(([op, label]) =>
      `<span><i style="background:${base};opacity:${op}"></i>${label}</span>`).join('')
    + (used.length > 1 ? '<span class="sep"></span>' + used.slice(1).map((t) =>
      `<span><i style="background:${colors[t]}"></i>${esc(shortLeaveType(t))}</span>`).join('') : '')
    + '<span class="sep"></span>'
    + '<span><i style="background:#fdeeee;box-shadow:inset 0 0 0 1px #f2d0d0"></i>공휴일 · 일요일</span>'
    + `<span><i style="background:#fdf5e6;box-shadow:inset 0 0 0 1px #ecd9ae"></i>${WORKERS_DAY}(유급휴일)</span>`;

  // 이번 달을 가로 스크롤 필름스트립의 맨 앞으로.
  // 렌더 시점엔 결과 뷰가 아직 display:none이라 offset이 0 → show('result') 이후 다음 틱에 실행.
  scrollCalToCurrent();
}
function scrollCalToCurrent() {
  requestAnimationFrame(() => {
    const cal = $('cal'); if (!cal) return;
    const cur = cal.querySelector('[data-current="1"]');
    if (cur) cal.scrollLeft = Math.max(0, cur.offsetLeft - cal.offsetLeft - 2);
  });
}

// ════════ 법정의무교육 ════════
// 1배속 실시간. 강의창 탭을 뒤에 열어 두고, 플레이어 도우미(content/edu-player.js)가 끝난 편을 다음 편으로 넘긴다.
// 과정 하나가 끝나면 여기서 탭을 닫고 다음 과정을 연다 — 이 전환 루프는 패널이 살아 있는 동안만 돈다.
const fmtDur = (sec) => {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}시간 ${m}분` : m ? `${m}분${s ? ` ${s}초` : ''}` : `${s}초`;
};
const fmtClock = (sec) => { sec = Math.max(0, Math.floor(Number(sec) || 0)); return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`; };
const fmtEta = (sec) => {
  const t = new Date(Date.now() + Math.max(0, Number(sec) || 0) * 1000);
  const today = new Date();
  const hm = `${t.getHours() < 12 ? '오전' : '오후'} ${t.getHours() % 12 || 12}:${String(t.getMinutes()).padStart(2, '0')}`;
  return t.toDateString() === today.toDateString() ? hm : `${t.getMonth() + 1}/${t.getDate()} ${hm}`;
};
// 지금 편의 남은 초 + 같은 과정의 뒤 편들 + 대기 과정들
function eduRemainSec(w) {
  let sec = 0;
  const info = w.lastInfo, c = w.course;
  if (info && c?.pageList?.length) {
    sec += Math.max(0, (info.dur || 0) - (info.cur || 0));
    for (const p of c.pageList) if (p.chasi > info.chasi || (p.chasi === info.chasi && Number(p.pageNo) > info.page)) sec += p.sec;
  } else if (c) sec += c.remainSec || 0;
  for (const q of w.queue) sec += q.remainSec || 0;
  return sec;
}
// 총량 게이지 — 자동 진행 4과정의 영상 초 합계 대비, 지금까지 본 초. 감시 중엔 매초 현재 편 위치까지 반영.
function eduTotals() {
  const cs = (eduData?.courses || []).filter((c) => !c.external);
  const total = cs.reduce((s, c) => s + (c.totalSec || 0), 0);
  let done = 0;
  const w = eduWatch, info = w?.lastInfo, cur = w?.course;
  for (const c of cs) {
    if (w && cur && c.title === cur.title && info && c.pageList?.length && !w.finished) {
      let before = 0;
      for (const p of c.pageList) if (p.chasi < info.chasi || (p.chasi === info.chasi && Number(p.pageNo) < info.page)) before += p.sec;
      done += Math.min(c.totalSec, before + Math.min(info.cur || 0, info.dur || 0));
    } else done += (c.totalSec || 0) * Math.min(100, c.progress || 0) / 100;
  }
  return { total, done: Math.min(done, total) };
}
function renderEduGauge() {
  const el = $('edu-gauge'); if (!el) return;
  const { total, done } = eduTotals();
  const pct = total ? Math.min(100, done / total * 100) : 0;
  el.querySelector('i').style.width = `${pct.toFixed(2)}%`;
  el.querySelector('.g-l').textContent = `들은 ${fmtDur(done)} · 전체 ${fmtDur(total)}`;
  el.querySelector('.g-r').textContent = `남은 ${fmtDur(total - done)} · ${pct.toFixed(1)}%`;
  renderEduLiveRow();
}
// 지금 돌고 있는 과정의 카드 — 진도바가 매초 차오르고 줄무늬가 흐른다.
function renderEduLiveRow() {
  const w = eduWatch, info = w?.lastInfo, c = w?.course;
  document.querySelectorAll('.edu-row.live').forEach((r) => { if (!w || w.finished || w.stop || !c || r.dataset.title !== c.title) r.classList.remove('live'); });
  if (!w || w.finished || w.stop || w.error || !c || !info) return;
  const row = [...document.querySelectorAll('.edu-row')].find((r) => r.dataset.title === c.title);
  if (!row) return;
  row.classList.add('live');
  const moving = w.lastMoveAt && (Date.now() - w.lastMoveAt) / 1000 < 6;
  row.classList.toggle('moving', !!moving);
  if (c.pageList?.length && c.totalSec) {
    let before = 0;
    for (const p of c.pageList) if (p.chasi < info.chasi || (p.chasi === info.chasi && Number(p.pageNo) < info.page)) before += p.sec;
    const done = Math.min(c.totalSec, before + Math.min(info.cur || 0, info.dur || 0));
    const pct = done / c.totalSec * 100;
    row.querySelector('.edu-bar i').style.width = `${pct.toFixed(2)}%`;
    row.querySelector('.edu-meta span:first-child').textContent = `${pct.toFixed(1)}%`;
    row.querySelector('.edu-meta span:nth-child(2)').textContent = `${c.chasis}차시 ${c.pages}편 · 들은 ${fmtDur(done)} · 남은 ${fmtDur(c.totalSec - done)}`;
  }
}
let eduData = null;
let eduWatch = null; // { stop, queue, course, tabId, lastInfo, note, error, done:[], startedAt }

function renderEdu(d) {
  eduData = d;
  const cs = d.courses || [];
  const auto = cs.filter((c) => !c.external);
  const avg = cs.length ? Math.round(cs.reduce((s, c) => s + (c.progress || 0), 0) / cs.length) : 0;
  const remain = auto.reduce((s, c) => s + (c.remainSec || 0), 0);
  const total = auto.reduce((s, c) => s + (c.totalSec || 0), 0);
  const end = cs.map((c) => c.end).filter(Boolean).sort()[0] || '';
  const dday = end ? Math.ceil((new Date(`${end}T23:59:59+09:00`) - Date.now()) / 86400000) : null;
  const pending = auto.filter((c) => c.progress < 100);
  const external = cs.filter((c) => c.external);
  $('view-result').innerHTML = `
    <div class="card edu-top" id="edu-top">
      <div class="edu-gauge" id="edu-gauge">
        <div class="edu-gauge-hd"><span class="l">전체 진도 · 자동 진행 ${auto.length}과정</span><span class="g-r"></span></div>
        <div class="edu-gauge-bar"><i style="width:0%"></i></div>
        <div class="edu-gauge-lb"><span class="g-l"></span><span class="g-eta">${pending.length ? `지금 시작하면 ${fmtEta(remain)} 끝` : ''}</span></div>
      </div>
      <div id="edu-watch" hidden></div>
      <div class="edu-actions" id="edu-top-actions">
        <button class="btn btn-primary" id="edu-run-all" ${pending.length ? '' : 'disabled'}>${pending.length ? `자동 학습 시작 · ${pending.length}과정` : '자동 진행분 모두 완료'}</button>
      </div>
    </div>
    <div class="kpis" style="margin-bottom:14px">
      <div class="kpi"><div class="l">평균 진도</div><div class="v">${avg}%</div></div>
      <div class="kpi"><div class="l">남은 강의</div><div class="v" style="font-size:19px">${fmtDur(remain)}</div><div class="l">전체 ${fmtDur(total)}</div></div>
      <div class="kpi"><div class="l">기한</div><div class="v">${dday == null ? '-' : dday < 0 ? '지남' : dday === 0 ? 'D-day' : `D-${dday}`}</div><div class="l">${esc(end)}</div></div>
    </div>
    <div class="card">
      <h2>과정 <span class="side">${cs.length}개 · 사번 ${esc(d.empNo)} <button id="edu-change-id" class="edu-link">변경</button></span></h2>
      <div class="edu-list">${cs.map((c, i) => eduRow(c, i)).join('')}</div>
      <p class="foot">1배속 실시간 재생이에요. 강의창 탭이 뒤에서 열리고, 한 편이 끝나면 다음 편으로 넘깁니다.
        ${external.length ? `<b>${esc(external.map((c) => c.title.replace(/\s*\(.*$/, '')).join(', '))}</b>은 별도 LMS라 직접 수강해야 해요. ` : ''}
        이 패널을 닫으면 과정 간 전환이 멈춥니다(편 넘김은 강의창이 열려 있는 한 계속).</p>
    </div>`;
  $('edu-run-all').onclick = () => eduStart(pending);
  $('edu-change-id').onclick = () => { buildSteps(current || {}); $('run-err').hidden = true; $('run-live').hidden = true; show('run'); promptEduId(''); };
  $('view-result').querySelectorAll('[data-run]').forEach((b) => {
    b.onclick = () => { const i = Number(b.dataset.run); eduStart(auto.filter((c) => c.progress < 100 && cs.indexOf(c) >= i)); };
  });
  $('view-result').querySelectorAll('[data-dump]').forEach((b) => {
    b.onclick = async () => {
      const tabs = await chrome.tabs.query({ url: ['*://kgeduone.wisehrd.com/*', '*://*.campus21.co.kr/*'] }).catch(() => []);
      const row = b.closest('.edu-row');
      let pre = row.querySelector('pre.edu-dump');
      if (!pre) { pre = document.createElement('pre'); pre.className = 'edu-dump'; row.appendChild(pre); }
      if (!tabs.length) { pre.textContent = '강의실 탭이 열려 있지 않아요. 강의실 열기 → 본인인증 → 강의 화면까지 간 뒤 눌러주세요.'; return; }
      pre.textContent = '읽는 중…';
      const parts = [];
      for (const t of tabs) {
        const res = await chrome.runtime.sendMessage({ type: 'edu-dump', tabId: t.id });
        parts.push(`# tab ${t.id} ${t.url}\n` + (res?.ok ? JSON.stringify(res.data, null, 1) : `오류: ${res?.error}`));
      }
      pre.textContent = parts.join('\n\n');
    };
  });
  $('view-result').querySelectorAll('[data-open]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true; b.textContent = '여는 중…';
      const res = await chrome.runtime.sendMessage({ type: 'edu-open-study', course: cs[Number(b.dataset.open)] });
      b.disabled = false; b.textContent = '강의실 열기';
      if (res?.ok && res.data?.tabId) chrome.tabs.update(res.data.tabId, { active: true });
    };
  });
  $('view-result').querySelectorAll('[data-wise]').forEach((b) => {
    b.onclick = () => wiseStart(cs[Number(b.dataset.wise)]);
  });
  renderEduGauge();
  if (eduWatch) renderEduWatch(); else eduAdopt(cs);
}

// 패널을 새로고침했거나 닫았다 열었을 때 — 이미 열려 있는 강의창이 있으면 그걸 이어서 감시한다(새로 열지 않는다).
async function eduAdopt(cs) {
  const tabs = await chrome.tabs.query({ url: '*://*.campus21.co.kr/cpclassroom/onlinestudy/*' }).catch(() => []);
  const tab = tabs[0];
  if (!tab || eduWatch) return;
  const r = await chrome.runtime.sendMessage({ type: 'edu-read-study', tabId: tab.id }).catch(() => null);
  const info = r?.data?.info;
  const course = cs.find((c) => info?.lecture && (c.title.includes(info.lecture) || info.lecture.includes(c.title.replace(/\.\.\.$/, ''))))
    || cs.find((c) => !c.external && c.progress < 100);
  if (!course) return;
  const rest = cs.filter((c) => !c.external && c.progress < 100 && c !== course && cs.indexOf(c) > cs.indexOf(course));
  eduStart(rest, { adopt: { tabId: tab.id, course } });
}

function eduRow(c, i) {
  const pct = Math.min(100, Math.max(0, Math.round(c.progress || 0)));
  const meta = c.external ? '별도 LMS · 직접 수강'
    : `${c.chasis}차시 ${c.pages}편 · ${fmtDur(c.totalSec)}${pct < 100 ? ` · 남은 ${fmtDur(c.remainSec)}` : ''}`;
  const chip = pct >= 100 ? '<span class="edu-chip done">완료</span>' : pct > 0 ? '<span class="edu-chip">진행 중</span>' : '<span class="edu-chip idle">미시작</span>';
  const btn = c.external ? `<button class="edu-btn" data-wise="${i}">영상 자동 진행</button><button class="edu-btn ghost" data-open="${i}">강의실 열기</button>`
    : pct >= 100 ? '' : `<button class="edu-btn" data-run="${i}">여기부터</button>`;
  const examChip = c.external ? '<span class="edu-chip warn">차수별 시험</span>'
    : /응시하지 않습니다/.test(c.exam || '') ? '<span class="edu-chip idle">시험 없음</span>'
    : c.exam ? '<span class="edu-chip warn">시험 있음</span>' : '';
  const sub = [c.criteria ? `수료기준 ${c.criteria}` : '', c.exam && !/응시하지 않습니다/.test(c.exam) ? c.exam : ''].filter(Boolean).join(' · ');
  return `<div class="edu-row" data-title="${esc(c.title)}">
    <div class="edu-row-hd"><div class="edu-title">${esc(c.title)}</div><span class="edu-chips">${examChip}${chip}</span></div>
    <div class="edu-bar"><i style="width:${pct}%"></i></div>
    <div class="edu-meta"><span>${pct}%</span><span>${esc(meta)}</span>${btn}</div>
    ${sub ? `<div class="edu-sub">${esc(sub)}</div>` : ''}</div>`;
}

function renderEduWatch() {
  renderEduGauge();
  const box = $('edu-watch');
  const w = eduWatch;
  if (!box || !w) return;
  const info = w.lastInfo;
  const live = !w.stop && !w.finished && !w.error;
  const sinceMove = w.lastMoveAt ? (Date.now() - w.lastMoveAt) / 1000 : null;
  const moving = live && sinceMove != null && sinceMove < 6;
  const stalled = live && sinceMove != null && sinceMove >= 6;
  $('edu-top')?.classList.toggle('live', live);
  $('edu-top')?.classList.toggle('moving', moving);
  $('edu-top')?.classList.toggle('stall', stalled);
  box.hidden = false;
  const title = w.course ? w.course.title : '';
  const elapsed = w.startedAt ? fmtDur((Date.now() - w.startedAt) / 1000) : '';
  const left = live ? eduRemainSec(w) : 0;
  let state = '';
  if (live) state = moving ? '재생 중' : stalled ? `${Math.round(sinceMove)}초째 멈춤 · 재생 보정 중` : (w.note || '신호 기다리는 중');
  else if (w.error) state = w.error;
  else if (w.finished) state = `${w.done.length ? `${w.done.length}과정 완료` : '끝'} · ${elapsed}`;
  else state = '멈춤';
  let where = '';
  if (info) {
    where = `${info.chasi}차시 ${info.page}/${info.pages}편${info.pageTitle ? ` · ${info.pageTitle}` : ''}`
      + (info.dur ? ` · <span class="ew-clock">${fmtClock(info.cur)} / ${fmtClock(info.dur)}</span>` : '')
      + (info.muted ? ' · 음소거' : '');
  } else if (w.note && live) where = w.note;
  box.innerHTML = `
    <div class="ew-hd"><span class="ew-dot${live ? (moving ? ' on' : stalled ? ' stall' : '') : ' off'}"></span>
      <span class="ew-state">${esc(state)}</span>
      <span class="ew-side">${live && elapsed ? `경과 ${elapsed}` : ''}${live && w.queue.length ? ` · 대기 ${w.queue.length}` : ''}</span></div>
    ${title ? `<div class="ew-title">${esc(title)}</div>` : ''}
    ${where ? `<div class="ew-line">${where}</div>` : ''}
    ${live && w.course ? `<div class="ew-line">남은 ${fmtDur(left)} · 예상 종료 <b class="ew-clock">${fmtEta(left)}</b></div>` : ''}`;
  const actions = $('edu-top-actions');
  if (actions) {
    actions.innerHTML = live
      ? `<button class="btn btn-danger" id="ew-stop">중지 · 강의창 닫기</button>${w.tabId ? '<button class="btn btn-ghost" id="ew-show">강의창 보기</button>' : ''}`
      : `<button class="btn btn-primary" id="ew-restart">자동 학습 다시 시작</button><button class="btn btn-ghost" id="ew-refresh">진도 새로고침</button>`;
    $('ew-stop')?.addEventListener('click', eduStop);
    $('ew-show')?.addEventListener('click', () => chrome.tabs.update(w.tabId, { active: true }).catch(() => {}));
    $('ew-refresh')?.addEventListener('click', () => { eduWatch = null; if (current) start(current); });
    $('ew-restart')?.addEventListener('click', () => {
      const cs = eduData?.courses || [];
      eduWatch = null;
      eduStart(cs.filter((c) => !c.external && c.progress < 100));
    });
  }
}

async function eduStop() {
  const w = eduWatch;
  if (!w) return;
  w.stop = true;
  if (w.tabId) await chrome.runtime.sendMessage({ type: 'edu-close-study', tabId: w.tabId }).catch(() => {});
  w.tabId = null;
  renderEduWatch();
}

// 진도 목록만 조용히 다시 읽어 그린다(감시 상자는 유지).
async function eduRefresh() {
  const res = await chrome.runtime.sendMessage({ type: 'edu' }).catch(() => null);
  if (res?.ok && current?.id === 'edu') renderEdu(res.data);
}

async function eduStart(queue, { adopt } = {}) {
  if (!queue?.length && !adopt) return;
  if (eduWatch && !eduWatch.stop && !eduWatch.finished) await eduStop();
  const w = eduWatch = { stop: false, finished: false, queue: [...(queue || [])], course: null, tabId: null, lastInfo: null, note: '', error: '', done: [], startedAt: Date.now() };
  if (adopt) w.queue.unshift(adopt.course);
  renderEduWatch();
  const ticker = setInterval(() => { if (eduWatch === w && !w.finished) renderEduWatch(); }, 1000);
  try {
    while (!w.stop && w.queue.length) {
      const course = w.course = w.queue.shift();
      w.tabId = null; w.lastInfo = null; w.note = '강의실 여는 중…';
      renderEduWatch();
      let res;
      if (adopt && course === adopt.course) { res = { ok: true, data: { tabId: adopt.tabId } }; w.note = '열려 있던 강의창 이어서 감시'; }
      else res = await chrome.runtime.sendMessage({ type: 'edu-open-study', course }).catch((e) => ({ ok: false, error: e.message }));
      if (w.stop) break;
      if (!res?.ok) { w.error = res?.error || '강의창을 열지 못했어요'; break; }
      if (res.data?.external) { w.note = '별도 LMS — 직접 수강해야 해요'; continue; }
      if (res.data?.done) { w.note = '이미 모든 편을 마친 과정'; w.done.push(course.title); continue; }
      w.tabId = res.data.tabId; if (!adopt || course !== adopt.course) w.note = '강의창 준비 중…';
      let silent = 0;
      while (!w.stop) {
        await sleep(3000);
        const r = await chrome.runtime.sendMessage({ type: 'edu-read-study', tabId: w.tabId }).catch(() => null);
        const st = r?.data;
        if (!st || st.gone) { w.note = '강의창이 닫혔어요'; w.tabId = null; break; }
        if (st.left) { w.note = '강의창이 다른 페이지로 이동했어요'; break; }
        if (st.info) {
          // 영상 시각이 실제로 움직였는지 — "돌고 있다"는 신호는 이것 하나다. 3초 넘게 안 움직이면 상자가 노랗게 바뀐다.
          if (st.info.cur !== w.lastCur) { w.lastCur = st.info.cur; w.lastMoveAt = Date.now(); }
          w.lastInfo = st.info; w.note = ''; silent = 0;
          if (st.info.phase === 'course-done') { w.done.push(course.title); break; }
          if (st.info.phase === 'stuck') { w.error = `${course.title}: ${st.info.note || '다음 편으로 넘어가지 못했어요'}`; break; }
        } else if (++silent > 30) { w.error = '강의창이 응답하지 않아요 (플레이어를 찾지 못함)'; break; }
        renderEduWatch();
      }
      if (w.tabId && !w.error) { await chrome.runtime.sendMessage({ type: 'edu-close-study', tabId: w.tabId }).catch(() => {}); w.tabId = null; }
      if (w.error || w.stop) break;
      await eduRefresh();
    }
  } finally {
    clearInterval(ticker);
    if (eduWatch === w) { w.finished = !w.stop; renderEduWatch(); if (!w.stop && !w.error) eduRefresh(); }
  }
}

// ── 안전보건교육(별도 LMS) 영상 자동 진행 ──
// 차시별 팝업(화면 위에 뜬다)을 순서대로 재생하고, 영상이 끝나면 도우미가 팝업을 닫아 다음 차시로 넘어간다.
// 시험은 자동화하지 않는다 — 차시별 시험은 사람이 직접 응시해야 수료된다.
let wiseWatch = null;
function renderWiseWatch() {
  const box = $('edu-watch'); const w = wiseWatch;
  if (!box || !w) return;
  renderEduGauge();
  const live = !w.stop && !w.finished && !w.error;
  const sinceMove = w.lastMoveAt ? (Date.now() - w.lastMoveAt) / 1000 : null;
  const moving = live && sinceMove != null && sinceMove < 6;
  const stalled = live && w.popupOpen && sinceMove != null && sinceMove >= 6;
  $('edu-top')?.classList.toggle('live', live);
  $('edu-top')?.classList.toggle('moving', moving);
  $('edu-top')?.classList.toggle('stall', stalled);
  box.hidden = false;
  const doneN = w.chasis.filter((c) => c.done).length;
  let state;
  if (w.error) state = w.error;
  else if (w.finished) state = `영상 ${doneN}/${w.chasis.length}차시 완료 · 시험은 직접 응시`;
  else if (w.needAuth) state = '본인인증이 필요해요 — 강의실에서 휴대폰 인증 후 다시';
  else if (moving) state = '재생 중';
  else if (stalled) state = `${Math.round(sinceMove)}초째 멈춤 · 재생 보정 중`;
  else state = w.note || '차시 여는 중…';
  const cur = w.cur;
  box.innerHTML = `
    <div class="ew-hd"><span class="ew-dot${live ? (moving ? ' on' : stalled ? ' stall' : '') : ' off'}"></span>
      <span class="ew-state">${esc(state)}</span>
      <span class="ew-side">${live ? `${doneN}/${w.chasis.length}차시` : ''}</span></div>
    <div class="ew-title">안전보건교육 (별도 LMS · 팝업)</div>
    ${cur ? `<div class="ew-line">${esc(cur.idx)}차시 ${esc(cur.title)}${w.player?.info?.dur ? ` · <span class="ew-clock">${fmtClock(w.player.info.cur)} / ${fmtClock(w.player.info.dur)}</span>` : ''}</div>` : ''}
    <div class="ew-line" style="color:#b7791f">시험 6차시는 사람이 직접 응시해야 수료돼요.</div>`;
  const actions = $('edu-top-actions');
  if (actions) {
    actions.innerHTML = live
      ? `<button class="btn btn-danger" id="ew-stop">중지</button><button class="btn btn-ghost" id="ew-show">강의실 보기</button>`
      : `<button class="btn btn-primary" id="ew-refresh">진도 새로고침</button>`;
    $('ew-stop')?.addEventListener('click', () => { if (wiseWatch) wiseWatch.stop = true; });
    $('ew-show')?.addEventListener('click', () => w.tabId && chrome.tabs.update(w.tabId, { active: true }).catch(() => {}));
    $('ew-refresh')?.addEventListener('click', () => { wiseWatch = null; if (current) start(current); });
  }
}

async function wiseStart(course) {
  if (eduWatch && !eduWatch.stop && !eduWatch.finished) await eduStop();
  const w = wiseWatch = { stop: false, finished: false, error: '', needAuth: false, note: '강의실 여는 중…',
    tabId: null, chasis: [], cur: null, player: null, popupOpen: false, lastMoveAt: 0, lastCur: -1, startedAt: Date.now() };
  renderWiseWatch();
  const ticker = setInterval(() => { if (wiseWatch === w && !w.finished) renderWiseWatch(); }, 1000);
  try {
    const open = await chrome.runtime.sendMessage({ type: 'edu-wise-open', course }).catch((e) => ({ ok: false, error: e.message }));
    if (!open?.ok) { w.error = open?.error || '강의실을 열지 못했어요'; return; }
    w.tabId = open.data.tabId;
    if (open.data.needAuth) { w.needAuth = true; w.note = '본인인증 필요'; await chrome.tabs.update(w.tabId, { active: true }).catch(() => {}); return; }
    let idle = 0;
    while (!w.stop) {
      const cr = await chrome.runtime.sendMessage({ type: 'edu-wise-curriculum', tabId: w.tabId }).catch(() => null);
      const data = cr?.data;
      if (data?.needAuth) { w.needAuth = true; w.note = '본인인증 필요'; await chrome.tabs.update(w.tabId, { active: true }).catch(() => {}); break; }
      if (data?.chasis) w.chasis = data.chasis;
      const next = w.chasis.find((c) => !c.done);
      if (!next) { w.finished = true; break; }        // 영상 전 차시 완료
      w.cur = next;
      // 팝업 상태 확인
      const rp = await chrome.runtime.sendMessage({ type: 'edu-wise-read', tabId: w.tabId }).catch(() => null);
      w.player = rp?.data || null;
      w.popupOpen = !!rp?.data?.popupOpen;
      if (w.popupOpen) {
        const c = rp.data.info?.cur ?? -1;
        if (c !== w.lastCur) { w.lastCur = c; w.lastMoveAt = Date.now(); }
        idle = 0;
      } else if (next.play) {
        // 팝업이 없고 이 차시가 열려 있으면(학습하기 노출) 재생 시작
        w.note = `${next.idx}차시 여는 중…`;
        await chrome.runtime.sendMessage({ type: 'edu-wise-play', tabId: w.tabId, play: next.play }).catch(() => {});
        w.lastMoveAt = Date.now(); w.lastCur = -1; idle = 0;
        await sleep(2500);
      } else {
        // 잠긴 차시 — 앞 차시 커밋 대기(팝업 닫힘 후 목차 새로고침). 목차를 다시 읽어 갱신.
        w.note = '앞 차시 진도 반영 대기…';
        if (++idle > 40) { w.error = '다음 차시가 열리지 않아요 — 강의실에서 직접 확인해주세요'; break; }
        await chrome.runtime.sendMessage({ type: 'edu-wise-curriculum', tabId: w.tabId }).catch(() => {});
      }
      renderWiseWatch();
      await sleep(3000);
    }
  } finally {
    clearInterval(ticker);
    if (wiseWatch === w) { if (!w.stop && !w.error && !w.needAuth) w.finished = true; renderWiseWatch(); }
  }
}
