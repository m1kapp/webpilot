// 출퇴근 정정(조회) 수집. src/lib/correction.mjs의 getCorrectionTargets에 대응.
// 타임인아웃 누락일을 뽑아 Flow 활동시간과 대조하고 출퇴근 제안값을 만든다.
// ※ 실제 "정정 신청"(HR 시스템 쓰기)은 실계정 검증 전까지 제외 — 여기선 조회·제안까지.
import { getOvertime } from './overtime.js';
import { getDayActivity } from './flow.js';
import { suggestCorrection } from '../core/correction.js';

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
    items.push({
      date: ds, dow: d.dow, status: caseLabel, submitted: false,
      curIn: d.inText || '', curOut: d.outText || '',
      flowEvents: act.events.map((e) => `${e.startText}~${e.endText} ${e.name}`),
      flowFirst: act.firstText, flowLast: act.lastText,
      suggestIn, suggestOut, hasEvidence: act.events.length > 0,
    });
  }
  const need = items.filter((i) => !i.submitted).length;
  return { month, items, summary: { total: items.length, need, submitted: items.length - need } };
}
