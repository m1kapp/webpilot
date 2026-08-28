// 출퇴근 정정(조회) 수집. src/lib/correction.mjs의 getCorrectionTargets에 대응.
// 타임인아웃 누락일을 뽑아 Flow 활동시간과 대조하고 출퇴근 제안값을 만든다.
// 조회 뒤 사용자가 명시적으로 확인하면 실제 "정정 신청"까지 이어진다.
// 조회와 쓰기를 분리해 결과 화면을 보는 것만으로는 절대 신청되지 않게 한다.
import { getOvertime } from './overtime.js';
import { getDayActivity } from './flow.js';
import { suggestCorrection } from '../core/correction.js';
import { openTab, evaluate, closeTab } from './tab.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function getCorrectionTargets(month, onProgress = () => {}) {
  // 근태 수집(초과근무와 동일). days[].missing/suspect + 이미 신청된 정정(corrections) 포함.
  const ot = await getOvertime(month, (t) => onProgress(t));
  onProgress('누락일 추리는 중');

  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const p2 = (n) => String(n).padStart(2, '0');

  const targets = (ot.days || []).filter((d) => {
    const ds = `${month}-${p2(d.day)}`;
    if (ds > today) return false;                       // 미래 제외
    if (d.weekend || d.holiday || d.isLeave) return false;
    return !d.inText || !d.outText || d.missing || d.suspect;
  });

  onProgress(`Flow 활동 대조 중 (${targets.length}건)`);
  const items = [];
  for (const d of targets) {
    const ds = `${month}-${p2(d.day)}`;
    const sub = ot.corrections?.[d.day];               // 이미 정정 신청된 날
    if (sub) {
      items.push({ date: ds, dow: d.dow, status: '신청됨', submitted: true, subStatus: sub.status,
        reqIn: sub.reqIn, reqOut: sub.reqOut, curIn: d.inText || '', curOut: d.outText || '',
        flowEvents: [], suggestIn: '', suggestOut: '' });
      continue;
    }
    let act = { events: [], firstText: '', lastText: '' };
    try { act = await getDayActivity(ds); }
    catch (e) { if (e.needsFlowKey) throw e; /* 개별 Flow 실패는 스킵 */ }
    const { caseLabel, suggestIn, suggestOut } = suggestCorrection(d, act.firstText, act.lastText);
    // 양쪽 기록도 Flow 활동도 없는 날은 휴가 수집 이상일 가능성을 배제할 수 없다.
    // 기본 10:30~19:30을 만들어 실제 신청 가능하게 두지 않고, 사람이 확인할 제외행으로 남긴다.
    const noEvidence = !d.inText && !d.outText && act.events.length === 0;
    items.push({
      date: ds, dow: d.dow, status: caseLabel, submitted: false,
      curIn: d.inText || '', curOut: d.outText || '',
      flowEvents: act.events.map((e) => `${e.startText}~${e.endText} ${e.name}`),
      flowFirst: act.firstText, flowLast: act.lastText,
      suggestIn: noEvidence ? '' : suggestIn, suggestOut: noEvidence ? '' : suggestOut,
      hasEvidence: act.events.length > 0, excluded: noEvidence,
    });
  }
  const need = items.filter((i) => !i.submitted && i.suggestIn && i.suggestOut).length;
  const submitted = items.filter((i) => i.submitted).length;
  return { month, items, summary: { total: items.length, need, submitted, excluded: items.length - need - submitted } };
}

// 타임인아웃 정정 실제 신청. rows: [{ date, in, out }]
// 네이티브 alert/confirm은 자동화 탭을 영원히 막을 수 있어 MAIN world에서 잠깐 기록형으로 바꾼다.
export async function submitCorrections(rows = [], memo = '', onProgress = () => {}) {
  const valid = rows.filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date || '')
    && /^\d{1,2}:\d{2}$/.test(r.in || '') && /^\d{1,2}:\d{2}$/.test(r.out || ''));
  if (!valid.length) throw new Error('신청할 정정 제안이 없어요');
  const results = [];
  for (let i = 0; i < valid.length; i++) {
    const row = valid[i];
    onProgress(`정정 신청 입력 중 (${i + 1}/${valid.length})`, { try: `${row.date} ${row.in}~${row.out}` });
    const tab = await openTab(`https://user.timeinout.kr/InOutMng/InOutModify?CheckDay=${encodeURIComponent(row.date)}`);
    try {
      const login = await evaluate(tab, () => /login/i.test(location.href)
        || !!document.querySelector('input[type=password]')).catch(() => true);
      if (login) {
        const e = new Error('타임인아웃 로그인이 필요해요');
        e.needsLogin = { service: '타임인아웃', loginUrl: 'https://user.timeinout.kr/' };
        throw e;
      }
      let ready = false;
      for (let n = 0; n < 14 && !ready; n++) {
        ready = await evaluate(tab, () => !!document.querySelector('input[name="InOutData[0].inTimeApproval"]')).catch(() => false);
        if (!ready) await sleep(500);
      }
      if (!ready) throw new Error(`${row.date} 정정 입력 화면을 못 찾았어요`);

      // 페이지 이벤트 핸들러와 같은 MAIN world의 alert/confirm을 가로채야 실제 제출 클릭이 안 멈춘다.
      await evaluate(tab, () => {
        if (window.__webwingDialogRestore) return;
        const alert = window.alert, confirm = window.confirm;
        window.__webwingDialogs = [];
        window.alert = (m) => { window.__webwingDialogs.push(String(m || '')); };
        window.confirm = (m) => { window.__webwingDialogs.push(String(m || '')); return true; };
        window.__webwingDialogRestore = () => { window.alert = alert; window.confirm = confirm; delete window.__webwingDialogRestore; };
      }, undefined, { world: 'MAIN' });

      const filled = await evaluate(tab, (v) => {
        const set = (name, value) => {
          const el = document.querySelector(`input[name="${name}"]`); if (!el) return false;
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          if (setter) setter.call(el, value); else el.value = value;
          for (const type of ['input', 'change', 'keyup', 'blur']) el.dispatchEvent(new Event(type, { bubbles: true }));
          return true;
        };
        const inV = `${v.in.padStart(5, '0')}:00`, outV = `${v.out.padStart(5, '0')}:00`;
        const a = set('InOutData[0].inTimeApproval', inV);
        const b = set('InOutData[0].OutTimeApproval', outV);
        const ta = document.querySelector('textarea[name="RequestInOutMemo"]');
        if (ta) { ta.value = v.memo; ta.dispatchEvent(new Event('input', { bubbles: true })); ta.dispatchEvent(new Event('change', { bubbles: true })); }
        return a && b && !!ta;
      }, { in: row.in, out: row.out, memo: memo || '실제 근무시간으로 정정 요청 (Webwing)' }, { world: 'MAIN' });
      if (!filled) throw new Error(`${row.date} 정정 입력칸 구조가 바뀌었어요`);

      onProgress(`정정 신청 제출 중 (${i + 1}/${valid.length})`, { try: `${row.date} 수정 요청 버튼` });
      const beforeHref = await evaluate(tab, () => location.href).catch(() => '');
      const clicked = await evaluate(tab, () => {
        const els = [...document.querySelectorAll('button,input[type=button],input[type=submit],a')];
        const btn = els.find((e) => /수정\s*요청/.test((e.textContent || e.value || '').trim()) && e.offsetParent !== null);
        if (!btn) return false; btn.click(); return true;
      }, undefined, { world: 'MAIN' });
      if (!clicked) throw new Error(`${row.date} 수정 요청 버튼을 못 찾았어요`);
      // 성공 알림·페이지 이동·커스텀 확인 중 하나가 나타날 때까지만 기다린다.
      for (let n = 0; n < 14; n++) {
        const settled = await evaluate(tab, (oldHref) => (window.__webwingDialogs || []).length > 0
          || location.href !== oldHref
          || [...document.querySelectorAll('button,a')].some((e) => /^확인$/.test((e.textContent || '').trim()) && e.offsetParent !== null),
        beforeHref, { world: 'MAIN' }).catch(() => true);
        if (settled) break;
        await sleep(250);
      }
      // 사이트가 커스텀 확인 모달을 쓰는 경우 마지막 확인까지 누른다.
      await evaluate(tab, () => {
        const btn = [...document.querySelectorAll('button,a')].find((e) => /^확인$/.test((e.textContent || '').trim()) && e.offsetParent !== null);
        btn?.click();
      }, undefined, { world: 'MAIN' }).catch(() => {});
      await sleep(500);
      const state = await evaluate(tab, () => {
        const dialogs = window.__webwingDialogs || [];
        window.__webwingDialogRestore?.();
        return { dialogs, text: (document.body?.innerText || '').slice(0, 2000), href: location.href };
      }, undefined, { world: 'MAIN' }).catch(() => ({ dialogs: [], text: '', href: '' }));
      const failed = /오류|실패|입력해|필수/.test(state.dialogs.join(' ') || '');
      results.push({ date: row.date, in: row.in, out: row.out, ok: !failed,
        message: state.dialogs.join(' · ') || (!failed ? '수정 요청을 제출했어요' : '제출 실패') });
      onProgress(`정정 신청 제출 중 (${i + 1}/${valid.length})`, {
        try: row.date, result: failed ? '실패' : '제출 완료', 안내: state.dialogs.join(' · ') || undefined,
      });
    } catch (e) {
      if (e.needsLogin) throw e;
      results.push({ date: row.date, in: row.in, out: row.out, ok: false, message: e.message });
      onProgress(`정정 신청 제출 중 (${i + 1}/${valid.length})`, { try: row.date, result: `실패: ${e.message}` });
    } finally { await closeTab(tab); }
  }
  return { recipe: 'correction-submit', results,
    summary: { total: results.length, ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length } };
}
