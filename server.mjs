import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const __dirname = dirname(fileURLToPath(import.meta.url)); // pkg 스냅샷/일반 실행 양쪽 정적경로
import { getOvertime, getOvertimeEmployee, getCompanyLeaves, getEmployeeLeaveStatus, verifyUserLogin, closeBrowser } from './src/lib/timeinout.mjs';
import { getCardPending, submitExpenses, getYagunTaxi, getYasik, getRulePending, readUserRules, writeUserRules, verifyBizplayLogin, yagunDateOf, yagunProofRowFromRec, renderYagunTableImage } from './src/lib/bizplay.mjs';
import { getCorrectionTargets, submitCorrections } from './src/lib/correction.mjs';
import { verifyFlowKey } from './src/lib/flow.mjs';
import { dataDir, authPath, ensureAuthDir } from './src/lib/paths.mjs';
import { saveHistory, listHistory, getHistoryEntry } from './src/lib/history.mjs';

const app = express();
const BASE_PORT = +(process.env.PORT || 18181);   // 파일럿 포트(팰린드롬). 막히면 자동 폴백.
app.use(express.json({ limit: '2mb' }));
app.use(express.static(join(__dirname, 'public'), {
  etag: true, lastModified: true,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'), // 매번 재검증 → 편집 즉시 반영(스테일 방지)
}));

const cache = new Map(); // key(월+이름+id) -> {t, data}, 5분

async function handle(req, res) {
  const src = req.method === 'POST' ? req.body : req.query;
  const month = src.month || '2026-06';
  const mode = src.mode === 'admin' ? 'admin' : 'employee'; // 기본 직원(본인)
  const name = src.name || process.env.TIMEINOUT_NAME || '유민호';
  const id = src.id || '';
  const pw = src.pw || '';
  const company = src.company || DEFAULT_COMPANY;
  const key = `${company}:${mode}:${month}:${mode === 'admin' ? name : ''}:${id}`; // 비번 제외
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < 5 * 60 * 1000) return res.json(hit.data);
  applyCompanyEnv(company);
  try {
    console.log(`▶ [${mode}] 조회: ${mode === 'admin' ? name : '본인'} / ${month}`);
    const data = mode === 'employee'
      ? await getOvertimeEmployee({ month, id, pw })
      : await getOvertime({ month, name, id, pw });
    cache.set(key, { t: Date.now(), data });
    res.json(data);
  } catch (e) {
    console.error('조회 실패:', e.message);
    res.status(500).json({ error: e.message });
  }
}

app.post('/api/overtime', handle);
app.get('/api/overtime', handle); // .env 기반(하위호환)

// 스트리밍: 스냅샷을 캡처 즉시 흘려보냄 (NDJSON)
app.post('/api/overtime/stream', async (req, res) => {
  const { month = '2026-06', id = '', pw = '', company = DEFAULT_COMPANY, historyKey = 'timeinout' } = req.body || {};
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const send = (obj) => { res.write(JSON.stringify(obj) + '\n'); res.flush?.(); };
  const t0 = Date.now(); // 이력에 소요시간 같이 저장(몇 초 걸렸는지 보여주기용)
  applyCompanyEnv(company);
  try {
    console.log(`▶ [stream] 본인 / ${month}`);
    const data = await getOvertimeEmployee({ month, id, pw, onSnapshot: (s) => send({ type: 'snap', snap: s }) });
    saveHistory(historyKey, data, Date.now() - t0);
    console.log('✅ 완료 — 결과 전송');
    send({ type: 'result', data });
  } catch (e) {
    console.error('스트림 실패:', e.message);
    send({ type: 'error', error: e.message });
  }
  res.end();
});

// 비즈플레이 카드 미결의(대기) 스트리밍
app.post('/api/bizplay/stream', async (req, res) => {
  const { month = '2026-06', id = '', pw = '', company = DEFAULT_COMPANY, historyKey = 'bizplay' } = req.body || {};
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const send = (obj) => { res.write(JSON.stringify(obj) + '\n'); res.flush?.(); };
  const t0 = Date.now(); // 이력에 소요시간 같이 저장(몇 초 걸렸는지 보여주기용)
  applyCompanyEnv(company);
  try {
    console.log(`▶ [bizplay] 미결의 / ${month}`);
    const data = await getCardPending({ month, id, pw, onSnapshot: (s) => send({ type: 'snap', snap: s }) });
    saveHistory(historyKey, data, Date.now() - t0);
    console.log('✅ 완료 — 결과 전송');
    send({ type: 'result', data });
  } catch (e) {
    console.error('bizplay 실패:', e.message);
    send({ type: 'error', error: e.message });
  }
  res.end();
});

// 근태 정정: 타임인아웃 누락일 + Flow 활동시간 근거
app.post('/api/correction/stream', async (req, res) => {
  const { month = '2026-06', id = '', pw = '', company = DEFAULT_COMPANY, historyKey = 'correction' } = req.body || {};
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const send = (obj) => { res.write(JSON.stringify(obj) + '\n'); res.flush?.(); };
  const t0 = Date.now(); // 이력에 소요시간 같이 저장(몇 초 걸렸는지 보여주기용)
  applyCompanyEnv(company);
  try {
    console.log(`▶ [correction] 근태 정정 대상 / ${month}`);
    const data = await getCorrectionTargets({ month, id, pw, onSnapshot: (s) => send({ type: 'snap', snap: s }) });
    saveHistory(historyKey, data, Date.now() - t0);
    console.log('✅ 완료 — 결과 전송');
    send({ type: 'result', data });
  } catch (e) {
    console.error('correction 실패:', e.message);
    send({ type: 'error', error: e.message });
  }
  res.end();
});

// 근태 정정 '실제 상신': InOutModify 폼 제출 (출근/퇴근/사유 → 수정 요청)
app.post('/api/correction/submit/stream', async (req, res) => {
  const { rows = [], memo, company = DEFAULT_COMPANY, historyKey = 'correction-submit' } = req.body || {};
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const send = (obj) => { res.write(JSON.stringify(obj) + '\n'); res.flush?.(); };
  const t0 = Date.now(); // 이력에 소요시간 같이 저장(몇 초 걸렸는지 보여주기용)
  applyCompanyEnv(company);
  try {
    console.log(`▶ [correction:submit] ${rows.length}건`);
    const data = await submitCorrections({ rows, memo, onSnapshot: (s) => send({ type: 'snap', snap: s }) });
    saveHistory(historyKey, data, Date.now() - t0);
    console.log('✅ 완료 — 결과 전송');
    send({ type: 'result', data });
  } catch (e) {
    console.error('correction 상신 실패:', e.message);
    send({ type: 'error', error: e.message });
  }
  res.end();
});

// 연차 현황 (관리자 계정 필요): 관리자가 조회 가능한 범위(소속 부서 등)의 연차 사용 내역, 연간
app.post('/api/leaves/company/stream', async (req, res) => {
  const { month = '2026-06', id = '', pw = '', company = DEFAULT_COMPANY, historyKey = 'company-leaves' } = req.body || {};
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const send = (obj) => { res.write(JSON.stringify(obj) + '\n'); res.flush?.(); };
  const t0 = Date.now(); // 이력에 소요시간 같이 저장(몇 초 걸렸는지 보여주기용)
  applyCompanyEnv(company);
  try {
    console.log(`▶ [company-leaves] 연차 현황 / ${month}`);
    const data = await getCompanyLeaves({ month, id, pw, onSnapshot: (s) => send({ type: 'snap', snap: s }) });
    saveHistory(historyKey, data, Date.now() - t0);
    console.log('✅ 완료 — 결과 전송');
    send({ type: 'result', data });
  } catch (e) {
    console.error('company-leaves 실패:', e.message);
    send({ type: 'error', error: e.message });
  }
  res.end();
});

// 연차 현황 (개인용): 본인 로그인만으로 잔여/전체/만료일 + 연간 사용이력 — admin 불필요, 초과근무 분석과 분리된 가벼운 조회
app.post('/api/leaves/mine/stream', async (req, res) => {
  const { month = '2026-06', id = '', pw = '', company = DEFAULT_COMPANY, historyKey = 'leave-personal' } = req.body || {};
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const send = (obj) => { res.write(JSON.stringify(obj) + '\n'); res.flush?.(); };
  const t0 = Date.now(); // 이력에 소요시간 같이 저장(몇 초 걸렸는지 보여주기용)
  applyCompanyEnv(company);
  try {
    console.log(`▶ [leave-personal] 연차 현황(개인) / ${month}`);
    const data = await getEmployeeLeaveStatus({ month, id, pw, onSnapshot: (s) => send({ type: 'snap', snap: s }) });
    saveHistory(historyKey, data, Date.now() - t0);
    console.log('✅ 완료 — 결과 전송');
    send({ type: 'result', data });
  } catch (e) {
    console.error('leave-personal 실패:', e.message);
    send({ type: 'error', error: e.message });
  }
  res.end();
});

// 야근택시 전용 조회 (심야택시 미결의 + 타임인아웃 야근 증빙 매칭)
app.post('/api/yagun/stream', async (req, res) => {
  const { month = '2026-06', id = '', pw = '', company = DEFAULT_COMPANY, historyKey = 'yagun' } = req.body || {};
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const send = (obj) => { res.write(JSON.stringify(obj) + '\n'); res.flush?.(); };
  const t0 = Date.now(); // 이력에 소요시간 같이 저장(몇 초 걸렸는지 보여주기용)
  applyCompanyEnv(company);
  try {
    console.log(`▶ [yagun] 야근택시 조회 / ${month}`);
    const data = await getYagunTaxi({ month, id, pw, onSnapshot: (s) => send({ type: 'snap', snap: s }) });
    saveHistory(historyKey, data, Date.now() - t0);
    console.log('✅ 완료 — 결과 전송');
    send({ type: 'result', data });
  } catch (e) {
    console.error('yagun 실패:', e.message);
    send({ type: 'error', error: e.message });
  }
  res.end();
});

// 야근·휴일근무 택시비 증빙 이미지 직접 만들기: 미결의 스캔 없이 날짜/시간/금액을 직접 입력해서 증빙 표 1장 생성
// (비즈플레이 미결의에서 이미 빠진 건, 수기로 올릴 건 등을 위해 — 타임인아웃 계정만 있으면 됨)
app.post('/api/yagun-evidence', async (req, res) => {
  const { items = [], company = DEFAULT_COMPANY } = req.body || {};
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: '항목을 1개 이상 입력하세요' });
  applyCompanyEnv(company);
  try {
    const taxis = items.map((it) => ({ taxiAt: `${it.date} ${it.time || '00:00'}:00`, amount: Math.round(+it.amount) || 0 }));
    const monthsNeeded = [...new Set(taxis.map((t) => yagunDateOf(t.taxiAt).slice(0, 7)))];
    const dayMaps = {};
    for (const mo of monthsNeeded) {
      const data = await getOvertimeEmployee({ month: mo });
      dayMaps[mo] = Object.fromEntries(data.days.map((d) => [d.day, d]));
    }
    const rows = [], skipped = [];
    for (const it of items) {
      const t = taxis[items.indexOf(it)];
      const yd = yagunDateOf(t.taxiAt);
      const rec = dayMaps[yd.slice(0, 7)]?.[+yd.slice(8, 10)];
      const isHol = rec && (rec.weekend || rec.holiday);
      const otMin = rec ? (isHol ? rec.holMin : rec.otMin) : 0;
      const hasRecord = !!(rec && !rec.missing && otMin > 0);
      if (!hasRecord) { skipped.push({ date: it.date, time: it.time, amount: t.amount, reason: '야근/휴일 기록 없음 — 증빙 불가' }); continue; }
      rows.push(yagunProofRowFromRec(rec, yd, isHol, { date: t.taxiAt, amount: t.amount }));
    }
    if (!rows.length) return res.status(400).json({ error: '증빙 가능한 항목이 없어요 (매칭되는 야근/휴일 기록 없음)', skipped });
    const months = [...new Set(rows.map((r) => r.date.slice(0, 7)))].sort();
    const label = months.length > 1 ? `${months[0]}~${months[months.length - 1]}` : months[0];
    const imgPath = await renderYagunTableImage(rows, 'record', label);
    const image = 'data:image/png;base64,' + readFileSync(imgPath).toString('base64');
    console.log(`✅ [yagun-evidence] ${rows.length}건 매칭 · ${skipped.length}건 스킵`);
    res.json({ ok: true, image, matched: rows.length, skipped });
  } catch (e) {
    console.error('yagun-evidence 실패:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// 야근식비 전용 조회 (혼자 먹은 1인 식대 + 타임인아웃 근태로 저녁/조식 인정 판정)
app.post('/api/yasik/stream', async (req, res) => {
  const { month = '2026-06', id = '', pw = '', company = DEFAULT_COMPANY, historyKey = 'yasik' } = req.body || {};
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const send = (obj) => { res.write(JSON.stringify(obj) + '\n'); res.flush?.(); };
  const t0 = Date.now(); // 이력에 소요시간 같이 저장(몇 초 걸렸는지 보여주기용)
  applyCompanyEnv(company);
  try {
    console.log(`▶ [yasik] 야근식비 조회 / ${month}`);
    const data = await getYasik({ month, id, pw, onSnapshot: (s) => send({ type: 'snap', snap: s }) });
    saveHistory(historyKey, data, Date.now() - t0);
    console.log('✅ 완료 — 결과 전송');
    send({ type: 'result', data });
  } catch (e) {
    console.error('yasik 실패:', e.message);
    send({ type: 'error', error: e.message });
  }
  res.end();
});

// 등록된 목적지(사용자 규칙) 미리보기 스캔
app.post('/api/pattern/stream', async (req, res) => {
  const { month = '2026-06', id = '', pw = '', patternId, company = DEFAULT_COMPANY, historyKey = `pattern-${patternId}` } = req.body || {};
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const send = (obj) => { res.write(JSON.stringify(obj) + '\n'); res.flush?.(); };
  const t0 = Date.now(); // 이력에 소요시간 같이 저장(몇 초 걸렸는지 보여주기용)
  applyCompanyEnv(company);
  try {
    console.log(`▶ [pattern] ${patternId} 조회 / ${month}`);
    const data = await getRulePending({ month, id, pw, patternId, onSnapshot: (s) => send({ type: 'snap', snap: s }) });
    saveHistory(historyKey, data, Date.now() - t0);
    console.log('✅ 완료 — 결과 전송');
    send({ type: 'result', data });
  } catch (e) {
    console.error('pattern 실패:', e.message);
    send({ type: 'error', error: e.message });
  }
  res.end();
});

// ── 실행 이력: 자동화별 완료 결과를 로컬 JSON으로 저장(스냅샷 제외) → "이력" 버튼에서 재조회 없이 다시 보기 ──
app.get('/api/history/:key', (req, res) => { res.json({ items: listHistory(req.params.key) }); });
app.get('/api/history/:key/:id', (req, res) => {
  const entry = getHistoryEntry(req.params.key, req.params.id);
  if (!entry) return res.status(404).json({ error: '이력을 찾을 수 없습니다' });
  res.json(entry);
});

// ── 사용자 규칙(패턴→목적지 등록) CRUD ──
app.get('/api/rules', (req, res) => { res.json({ rules: readUserRules() }); });
app.post('/api/rules', (req, res) => {
  const { keyword, keywords, use, label, by, budget } = req.body || {};
  const kws = (Array.isArray(keywords) ? keywords : [keyword]).map((k) => String(k || '').trim()).filter(Boolean);
  if (!kws.length || !use) return res.status(400).json({ error: '사용처(keyword)와 용도(use)는 필수' });
  const rules = readUserRules();
  const id = 'u' + (rules.reduce((mx, r) => Math.max(mx, +String(r.id).replace(/\D/g, '') || 0), 0) + 1);
  const rule = { id, keywords: kws, use: String(use).trim(), submitUse: String(use).trim(), label: (label || `${kws[0]} 자동결의`).trim(), by: (by || '').trim(), budget: (budget || '').trim() };
  rules.push(rule);
  writeUserRules(rules);
  res.json({ ok: true, rule });
});
app.delete('/api/rules/:id', (req, res) => {
  const rules = readUserRules().filter((r) => r.id !== req.params.id);
  writeUserRules(rules);
  res.json({ ok: true });
});

// 비즈플레이 규칙별 '실제 상신'(결의서 작성→용도→결재요청→결재선 확인) 스트리밍
app.post('/api/bizplay/submit/stream', async (req, res) => {
  const { month = '2026-06', id = '', pw = '', patternId, yagunMode, company = DEFAULT_COMPANY, historyKey = `bizplay-submit-${patternId}` } = req.body || {};
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const send = (obj) => { res.write(JSON.stringify(obj) + '\n'); res.flush?.(); };
  const t0 = Date.now(); // 이력에 소요시간 같이 저장(몇 초 걸렸는지 보여주기용)
  applyCompanyEnv(company);
  try {
    console.log(`▶ [bizplay:submit] ${patternId} / ${month}${yagunMode === 'pending' ? ' (정정 대기 미리결의)' : ''}`);
    const data = await submitExpenses({ month, id, pw, patternId, yagunMode, onSnapshot: (s) => send({ type: 'snap', snap: s }) });
    saveHistory(historyKey, data, Date.now() - t0);
    console.log('✅ 완료 — 결과 전송');
    send({ type: 'result', data });
  } catch (e) {
    console.error('bizplay 상신 실패:', e.message);
    send({ type: 'error', error: e.message });
  }
  res.end();
});

// ── 계정관리: 회사(테넌트)별 자격증명을 로컬 암호화 파일(.auth/accounts.enc, AES-256-GCM)에 저장 ──
// store 구조: { [companyId]: { TIMEINOUT_ID, TIMEINOUT_PW, TIMEINOUT_NAME, BIZPLAY_ID, BIZPLAY_PW, FLOW_API_KEY } }
const ENC_FILE = authPath('accounts.enc');
const CRED_KEYS = ['TIMEINOUT_ID', 'TIMEINOUT_PW', 'TIMEINOUT_NAME', 'BIZPLAY_ID', 'BIZPLAY_PW', 'FLOW_API_KEY'];
const DEFAULT_COMPANY = 'madrascheck';
const KEY = scryptSync('webpilot-local-vault-v1', 'wp-salt', 32);
const encrypt = (obj) => { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', KEY, iv); const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), data]).toString('base64'); };
const decrypt = (b64) => { const buf = Buffer.from(b64, 'base64'); const d = createDecipheriv('aes-256-gcm', KEY, buf.subarray(0, 12)); d.setAuthTag(buf.subarray(12, 28)); return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8')); };

let store = {};
// 원자적 쓰기: temp에 쓰고 rename (중단/동시쓰기 시 파일 손상 방지)
function atomicWrite(path, data) { const tmp = `${path}.tmp`; writeFileSync(tmp, data); renameSync(tmp, path); }
function persist() { ensureAuthDir(); atomicWrite(ENC_FILE, encrypt(store)); }
function loadStore() {
  if (existsSync(ENC_FILE)) {
    try { store = decrypt(readFileSync(ENC_FILE, 'utf8')); }
    catch { // 손상/키불일치 — 조용히 비우면 다음 저장이 덮어써 복구불가 → 백업 보존 + 경고
      const bak = `${ENC_FILE}.corrupt-${Date.now()}`;
      try { renameSync(ENC_FILE, bak); } catch {}
      console.error(`⚠ accounts.enc 복호화 실패 — ${bak}로 백업 보존. 계정 연결에서 재등록 필요.`);
      store = {};
    }
  } else { // 최초: .env 평문에서 암호화 스토어로 이관 (기본회사로)
    const legacy = {};
    for (const k of CRED_KEYS) if (process.env[k]) legacy[k] = process.env[k];
    if (Object.keys(legacy).length) {
      store[DEFAULT_COMPANY] = legacy;
      persist();
      // 암호화 파일이 실제로 복호화되는지 검증한 뒤에만 .env 평문 정리 (검증 실패 시 .env 백업으로 유지)
      try { decrypt(readFileSync(ENC_FILE, 'utf8')); clearEnvPlaintext(); }
      catch { console.error('⚠ accounts.enc 검증 실패 — .env 평문을 복구용으로 유지합니다.'); }
    }
  }
  // 구버전(회사 구분 도입 전) 마이그레이션: 최상위에 자격증명이 바로 있으면 기본회사로 이관
  if (CRED_KEYS.some((k) => store[k] != null)) {
    const legacy = {};
    for (const k of CRED_KEYS) if (store[k] != null) { legacy[k] = store[k]; delete store[k]; }
    store[DEFAULT_COMPANY] = { ...legacy, ...(store[DEFAULT_COMPANY] || {}) };
    persist();
    console.error(`⚠ 기존 계정 정보를 "${DEFAULT_COMPANY}" 회사로 이관했습니다.`);
  }
}
function clearEnvPlaintext() { // .env에서 자격증명 평문 라인 제거 (export/선행공백 형태 포함)
  if (!existsSync('.env')) return;
  const lines = readFileSync('.env', 'utf8').split('\n').filter((l) => { const m = l.match(/^\s*(?:export\s+)?([A-Z0-9_]+)=/); return !(m && CRED_KEYS.includes(m[1])); });
  atomicWrite('.env', lines.join('\n').replace(/\n+$/, '\n'));
}
// 자동화 실행 직전에 호출 — 해당 회사의 저장된 자격증명을 런타임(process.env)에 반영 (레시피 라이브러리들이 env로 읽음)
function applyCompanyEnv(company) {
  const c = store[company] || {};
  for (const k of CRED_KEYS) process.env[k] = c[k] || '';
}
function setCompanyCreds(company, updates) {
  const c = store[company] || {};
  for (const [k, v] of Object.entries(updates)) if (v != null && v !== '') c[k] = v;
  store[company] = c;
  persist();
}
loadStore();

// 프리필용으로 값도 반환 (로컬 전용 도구 — localhost)
app.get('/api/accounts', (req, res) => {
  const c = store[req.query.company || DEFAULT_COMPANY] || {};
  res.json({
    timeinout: { id: c.TIMEINOUT_ID || '', pw: c.TIMEINOUT_PW || '', saved: !!(c.TIMEINOUT_ID && c.TIMEINOUT_PW) },
    bizplay: { id: c.BIZPLAY_ID || '', pw: c.BIZPLAY_PW || '', saved: !!(c.BIZPLAY_ID && c.BIZPLAY_PW) },
    flow: { key: c.FLOW_API_KEY || '', saved: !!c.FLOW_API_KEY },
  });
});
app.post('/api/accounts', async (req, res) => {
  const { company = DEFAULT_COMPANY, service, id, pw, key } = req.body || {};
  const c = store[company] || {};
  try {
    if (service === 'timeinout') {
      const effId = id || c.TIMEINOUT_ID, effPw = pw || c.TIMEINOUT_PW;
      if (!effId || !effPw) return res.status(400).json({ error: '아이디/비번을 입력하세요' });
      await verifyUserLogin({ id: effId, pw: effPw });         // 저장 전에 실제 로그인해서 확인
      setCompanyCreds(company, { TIMEINOUT_ID: effId, TIMEINOUT_PW: effPw });
    } else if (service === 'bizplay') {
      const effId = id || c.BIZPLAY_ID, effPw = pw || c.BIZPLAY_PW;
      if (!effId || !effPw) return res.status(400).json({ error: '아이디/비번을 입력하세요' });
      await verifyBizplayLogin({ id: effId, pw: effPw });
      setCompanyCreds(company, { BIZPLAY_ID: effId, BIZPLAY_PW: effPw });
    } else if (service === 'flow') {
      const effKey = key || c.FLOW_API_KEY;
      if (!effKey) return res.status(400).json({ error: 'API 키를 입력하세요' });
      await verifyFlowKey(effKey);
      setCompanyCreds(company, { FLOW_API_KEY: effKey });
    } else return res.status(400).json({ error: '알 수 없는 서비스' });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 127.0.0.1 바인딩: 평문 자격증명을 반환하는 /api/accounts가 LAN에 노출되지 않도록 localhost 전용
// 포트 자동 폴백: BASE_PORT 막혀 있으면 +1씩 최대 20개 시도. 실제 포트는 데이터폴더/.tmp/webwing.port 에 기록(Tauri 셸이 읽음).
function listen(port, tries) {
  const srv = app.listen(port, '127.0.0.1', () => {
    try { const tmp = join(dataDir(), '.tmp'); mkdirSync(tmp, { recursive: true }); writeFileSync(join(tmp, 'webwing.port'), String(port)); } catch {}
    console.log(`\n✅ webwing 실행: http://127.0.0.1:${port}\n`);
  });
  srv.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && tries > 0) { console.error(`⚠ 포트 ${port} 사용 중 → ${port + 1} 시도`); listen(port + 1, tries - 1); }
    else { console.error('서버 시작 실패:', e.message); process.exit(1); }
  });
}
listen(BASE_PORT, 20);

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await closeBrowser(); process.exit(0); });
