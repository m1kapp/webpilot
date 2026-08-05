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
    ready: true, msg: 'overtime', hasMonth: true, services: ['timeinout'],
    steps: ['타임인아웃 여는 중', '근태 카드 조회', '경계일 보정', '휴가·출장 반영', '초과근무 계산'],
    render: renderOvertime,
  },
  {
    id: 'correction', label: '출퇴근 정정', sub: '누락일 Flow 대조 → 출퇴근 제안',
    ready: true, msg: 'correction', hasMonth: true, services: ['timeinout', 'flow'],
    steps: ['타임인아웃 여는 중', '근태 카드 조회', '누락일 추리는 중', 'Flow 활동 대조'],
    render: renderCorrection,
  },
  {
    id: 'yagun', label: '야근택시 조회', sub: '심야 택시 → 근태로 증빙 판정',
    ready: true, msg: 'yagun', hasMonth: true, services: ['bizplay', 'timeinout'],
    steps: ['비즈플레이 여는 중', '카드영수증 앱 여는 중', '미결의 조회', '타임인아웃 근태 매칭'],
    render: (d) => renderExpense(d, 'yagun'),
  },
  {
    id: 'yasik', label: '야근식비 조회', sub: '혼자 식대 → 야근·조식 인정',
    ready: true, msg: 'yasik', hasMonth: true, services: ['bizplay', 'timeinout'],
    steps: ['비즈플레이 여는 중', '카드영수증 앱 여는 중', '미결의 조회', '타임인아웃 근태 매칭'],
    render: (d) => renderExpense(d, 'yasik'),
  },
];

// 서비스 로고 — 자동화 아이콘은 이모지 대신 관련 서비스 로고 배지(데스크톱과 동일). 파란 점=타임인아웃/Webwing.
const SVC_ICON = { timeinout: '../icons/svc-timeinout.png', bizplay: '../icons/svc-bizplay.png', flow: '../icons/svc-flow.png' };
// 자동화 아이콘 HTML: 관련 서비스 로고를 '+'로 이어 붙인다.
const autoIcon = (a) => (a.services || []).map((s, i) =>
  `${i ? '<span class="plus">+</span>' : ''}<img src="${SVC_ICON[s]}" alt="">`).join('');

// 호스트 → 서비스. 지금 탭이 어느 서비스인지 판별해 관련 자동화를 위로 올린다.
const SERVICE_OF_HOST = (host) => {
  if (/timeinout\.kr$/.test(host)) return 'timeinout';
  if (/bizplay\.co\.kr$/.test(host)) return 'bizplay';
  if (/flow\.team$/.test(host)) return 'flow';
  return null;
};
const SERVICE_NAME = { timeinout: '타임인아웃', bizplay: '비즈플레이', flow: 'Flow' };
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
      <span class="ic">${autoIcon(a)}</span>
      <span class="tx"><span class="lb">${esc(a.label)}</span><span class="sb">${esc(a.sub)}</span></span>
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
    btn.addEventListener('click', () => start(AUTOMATIONS.find((a) => a.id === btn.dataset.id)));
  });
}

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
  $('month').hidden = !(view === 'result' && current?.hasMonth);
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
      e.detail = res?.detail || '';
      throw e;
    }
    markAllDone();
    await sleep(280); // 마지막 체크가 잠깐 보이도록
    auto.render(res.data);
    appendTrace();     // 렌더가 view-result를 통째로 갈아치우므로 그 뒤에 붙인다
    show('result');
  } catch (e) {
    if (e.needsFlowKey) return promptFlowKey();
    failCurrentStep(e.message, e.needsLogin, e.detail, e.needsAppUrl);
  }
}

// Flow API 키 입력 → 검증·저장 → 자동 재실행
function promptFlowKey() {
  const active = stepEls.find((el) => el.classList.contains('active')) || stepEls[stepEls.length - 1];
  active?.classList.remove('active'); active?.classList.add('err');
  $('run-err').hidden = false;
  $('run-err').innerHTML = `
    <div style="color:var(--ink);font-weight:700;margin-bottom:3px">Flow API 키가 필요해요</div>
    <div style="font-size:12.5px;color:var(--muted);margin-bottom:9px">Flow → 설정 → 오픈 API에서 발급한 키를 붙여넣으세요. 이 기기에만 저장됩니다.</div>
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

// 로그인하기 → 로그인 페이지 열고 완료 대기 → 그 자동화 자동 재실행
// 앱을 사람이 여는 동안 지켜보다가 주소를 잡으면 자동으로 이어서 실행한다.
async function captureAppUrlThenRetry(needsAppUrl) {
  $('run-actions').hidden = true;
  $('run-err').innerHTML = `<div style="font-size:13px;color:var(--ink)">
    <b>${esc(needsAppUrl.service)}</b> 창을 열었어요 · <b>${esc(needsAppUrl.app)}</b>을 눌러 열면 자동으로 이어서 실행합니다</div>`;
  const res = await chrome.runtime.sendMessage({ type: 'capture-app-url' });
  if (!res?.ok) {
    $('run-actions').hidden = false;
    $('run-err').innerHTML = `<div style="font-size:13px;color:var(--ink)">앱 주소를 잡지 못했어요. 다시 시도해주세요.</div>`;
    return;
  }
  buildSteps(current);
  await execute(current);
}

async function loginThenRetry(needsLogin) {
  $('run-err').innerHTML = `<div style="display:flex;align-items:center;gap:9px;color:#5a6172;font-size:13px">
    <span class="dot" style="width:16px;height:16px;border:2px solid var(--blue);border-top-color:transparent;border-radius:50%;animation:spin .7s linear infinite"></span>
    <b>${esc(needsLogin.service)}</b> 로그인 창을 열었어요 · 로그인하면 자동으로 이어서 실행합니다</div>`;
  $('run-actions').hidden = true;
  const res = await chrome.runtime.sendMessage({ type: 'login', loginUrl: needsLogin.loginUrl });
  if (res?.ok && current) return start(current);         // 로그인 완료 → 재실행
  // 시간 초과·취소
  $('run-err').innerHTML = `<div style="color:var(--red);font-weight:600">로그인이 확인되지 않았어요</div>
    <div style="font-size:12.5px;color:var(--muted);margin-top:2px">로그인을 마친 뒤 다시 시도해주세요.</div>`;
  $('run-actions').hidden = false;
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
  if (msg.evidence) trace.push({ step: msg.text || '', at: Date.now(), data: msg.evidence });
});

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

// 야근택시·야근식비(조회) 공용 — 미결의 후보 + 근태 증빙 판정. 상신은 아직 수동.
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
      <p style="color:var(--muted);font-size:12px;margin:12px 0 0">타임인아웃 근태로 ${isTaxi ? '심야택시=그날 야근 여부' : '저녁=야근 / 조식=이른출근'}를 판정. 상신은 준비 중.</p>
    </div>
    <div class="card">
      <h2>후보 목록 <span class="side">전체 ${s.count ?? 0}건</span></h2>
      <div class="cr-list" id="ex-rows"></div>
      <p class="foot">미결의(대기)에서 ${isTaxi ? '심야택시(23~03시)' : '1인 식대(13,000 이내·저녁/조식)'}만.</p>
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
}

// 출퇴근 정정(조회) 결과 — 누락일별 현재기록·Flow활동·제안 출퇴근. 신청은 아직 수동.
function renderCorrection(d) {
  const s = d.summary || {};
  $('view-result').innerHTML = `
    <div class="card">
      <h2>정정 대상<span class="side">${esc(d.month)}</span></h2>
      <div class="kpis">
        <div class="kpi"><div class="l">신청 필요</div><div class="v" style="color:${s.need ? 'var(--blue)' : 'var(--ok)'}">${s.need ?? 0}<span style="font-size:14px;color:var(--muted);font-weight:600">건</span></div></div>
        <div class="kpi"><div class="l">이미 신청됨</div><div class="v" style="font-size:19px">${s.submitted ?? 0}건</div></div>
      </div>
      <p style="color:var(--muted);font-size:12px;margin:12px 0 0">Flow 캘린더 활동으로 실제 근무시간대를 추정해 <b>제안</b>합니다. 신청은 타임인아웃에서 직접(자동 신청은 준비 중).</p>
    </div>
    <div class="card">
      <h2>누락일별 제안</h2>
      <div class="cr-list" id="cr-rows"></div>
      <p class="foot">제안 = Flow 첫·마지막 활동 기준(출근 최대 10:30 · 퇴근 최소 18:00 · 9시간 보장).</p>
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
    return `<div class="cr-row">
      <div class="cr-day">${day}<span>${esc(x.dow)}</span></div>
      <div class="cr-mid">
        <div class="cr-case">${esc(x.status || '')}</div>
        <div class="cr-detail">현재 ${esc(x.curIn || '–')}~${esc(x.curOut || '–')} · ${flow}</div>
      </div>
      <div class="cr-sug">${esc(x.suggestIn || '')}<span class="ar">→</span>${esc(x.suggestOut || '')}</div>
    </div>`;
  }).join('') || `<div style="padding:18px;text-align:center;color:var(--muted)">정정할 누락일이 없어요 🎉</div>`;
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
