import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const __dirname = dirname(fileURLToPath(import.meta.url)); // pkg 스냅샷/일반 실행 양쪽 정적경로
import { getOvertime, getOvertimeEmployee, closeBrowser } from './src/lib/timeinout.mjs';
import { getCardPending, submitExpenses, getYagunTaxi } from './src/lib/bizplay.mjs';
import { getCorrectionTargets, submitCorrections } from './src/lib/correction.mjs';

const app = express();
const PORT = process.env.PORT || 8181;
app.use(express.json({ limit: '2mb' }));
app.use(express.static(join(__dirname, 'public')));

const cache = new Map(); // key(월+이름+id) -> {t, data}, 5분

async function handle(req, res) {
  const src = req.method === 'POST' ? req.body : req.query;
  const month = src.month || '2026-06';
  const mode = src.mode === 'admin' ? 'admin' : 'employee'; // 기본 직원(본인)
  const name = src.name || process.env.TIMEINOUT_NAME || '유민호';
  const id = src.id || '';
  const pw = src.pw || '';
  const key = `${mode}:${month}:${mode === 'admin' ? name : ''}:${id}`; // 비번 제외
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < 5 * 60 * 1000) return res.json(hit.data);
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
  const { month = '2026-06', id = '', pw = '' } = req.body || {};
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const send = (obj) => { res.write(JSON.stringify(obj) + '\n'); res.flush?.(); };
  try {
    console.log(`▶ [stream] 본인 / ${month}`);
    const data = await getOvertimeEmployee({ month, id, pw, onSnapshot: (s) => send({ type: 'snap', snap: s }) });
    send({ type: 'result', data });
  } catch (e) {
    console.error('스트림 실패:', e.message);
    send({ type: 'error', error: e.message });
  }
  res.end();
});

// 비즈플레이 카드 미결의(대기) 스트리밍
app.post('/api/bizplay/stream', async (req, res) => {
  const { month = '2026-06', id = '', pw = '' } = req.body || {};
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const send = (obj) => { res.write(JSON.stringify(obj) + '\n'); res.flush?.(); };
  try {
    console.log(`▶ [bizplay] 미결의 / ${month}`);
    const data = await getCardPending({ month, id, pw, onSnapshot: (s) => send({ type: 'snap', snap: s }) });
    send({ type: 'result', data });
  } catch (e) {
    console.error('bizplay 실패:', e.message);
    send({ type: 'error', error: e.message });
  }
  res.end();
});

// 근태 정정: 타임인아웃 누락일 + Flow 활동시간 근거
app.post('/api/correction/stream', async (req, res) => {
  const { month = '2026-06', id = '', pw = '' } = req.body || {};
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const send = (obj) => { res.write(JSON.stringify(obj) + '\n'); res.flush?.(); };
  try {
    console.log(`▶ [correction] 근태 정정 대상 / ${month}`);
    const data = await getCorrectionTargets({ month, id, pw, onSnapshot: (s) => send({ type: 'snap', snap: s }) });
    send({ type: 'result', data });
  } catch (e) {
    console.error('correction 실패:', e.message);
    send({ type: 'error', error: e.message });
  }
  res.end();
});

// 근태 정정 '실제 상신': InOutModify 폼 제출 (출근/퇴근/사유 → 수정 요청)
app.post('/api/correction/submit/stream', async (req, res) => {
  const { rows = [], memo } = req.body || {};
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const send = (obj) => { res.write(JSON.stringify(obj) + '\n'); res.flush?.(); };
  try {
    console.log(`▶ [correction:submit] ${rows.length}건`);
    const data = await submitCorrections({ rows, memo, onSnapshot: (s) => send({ type: 'snap', snap: s }) });
    send({ type: 'result', data });
  } catch (e) {
    console.error('correction 상신 실패:', e.message);
    send({ type: 'error', error: e.message });
  }
  res.end();
});

// 야근택시 전용 조회 (심야택시 미결의 + 타임인아웃 야근 증빙 매칭)
app.post('/api/yagun/stream', async (req, res) => {
  const { month = '2026-06', id = '', pw = '' } = req.body || {};
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const send = (obj) => { res.write(JSON.stringify(obj) + '\n'); res.flush?.(); };
  try {
    console.log(`▶ [yagun] 야근택시 조회 / ${month}`);
    const data = await getYagunTaxi({ month, id, pw, onSnapshot: (s) => send({ type: 'snap', snap: s }) });
    send({ type: 'result', data });
  } catch (e) {
    console.error('yagun 실패:', e.message);
    send({ type: 'error', error: e.message });
  }
  res.end();
});

// 비즈플레이 규칙별 '실제 상신'(결의서 작성→용도→결재요청→결재선 확인) 스트리밍
app.post('/api/bizplay/submit/stream', async (req, res) => {
  const { month = '2026-06', id = '', pw = '', patternId, yagunMode } = req.body || {};
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const send = (obj) => { res.write(JSON.stringify(obj) + '\n'); res.flush?.(); };
  try {
    console.log(`▶ [bizplay:submit] ${patternId} / ${month}${yagunMode === 'pending' ? ' (정정 대기 미리결의)' : ''}`);
    const data = await submitExpenses({ month, id, pw, patternId, yagunMode, onSnapshot: (s) => send({ type: 'snap', snap: s }) });
    send({ type: 'result', data });
  } catch (e) {
    console.error('bizplay 상신 실패:', e.message);
    send({ type: 'error', error: e.message });
  }
  res.end();
});

// ── 계정관리: 자격증명을 로컬 암호화 파일(.auth/accounts.enc, AES-256-GCM)에만 저장 ──
const ENC_FILE = '.auth/accounts.enc';
const CRED_KEYS = ['TIMEINOUT_ID', 'TIMEINOUT_PW', 'TIMEINOUT_NAME', 'BIZPLAY_ID', 'BIZPLAY_PW', 'FLOW_API_KEY'];
const KEY = scryptSync('webpilot-local-vault-v1', 'wp-salt', 32);
const encrypt = (obj) => { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', KEY, iv); const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), data]).toString('base64'); };
const decrypt = (b64) => { const buf = Buffer.from(b64, 'base64'); const d = createDecipheriv('aes-256-gcm', KEY, buf.subarray(0, 12)); d.setAuthTag(buf.subarray(12, 28)); return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8')); };

let store = {};
// 원자적 쓰기: temp에 쓰고 rename (중단/동시쓰기 시 파일 손상 방지)
function atomicWrite(path, data) { const tmp = `${path}.tmp`; writeFileSync(tmp, data); renameSync(tmp, path); }
function persist() { mkdirSync('.auth', { recursive: true }); atomicWrite(ENC_FILE, encrypt(store)); }
function loadStore() {
  if (existsSync(ENC_FILE)) {
    try { store = decrypt(readFileSync(ENC_FILE, 'utf8')); }
    catch { // 손상/키불일치 — 조용히 비우면 다음 저장이 덮어써 복구불가 → 백업 보존 + 경고
      const bak = `${ENC_FILE}.corrupt-${Date.now()}`;
      try { renameSync(ENC_FILE, bak); } catch {}
      console.error(`⚠ accounts.enc 복호화 실패 — ${bak}로 백업 보존. 승객정보에서 재등록 필요.`);
      store = {};
    }
  } else { // 최초: .env 평문에서 암호화 스토어로 이관
    for (const k of CRED_KEYS) if (process.env[k]) store[k] = process.env[k];
    if (Object.keys(store).length) {
      persist();
      // 암호화 파일이 실제로 복호화되는지 검증한 뒤에만 .env 평문 정리 (검증 실패 시 .env 백업으로 유지)
      try { decrypt(readFileSync(ENC_FILE, 'utf8')); clearEnvPlaintext(); }
      catch { console.error('⚠ accounts.enc 검증 실패 — .env 평문을 복구용으로 유지합니다.'); }
    }
  }
  for (const k of CRED_KEYS) if (store[k]) process.env[k] = store[k]; // 런타임 반영
}
function clearEnvPlaintext() { // .env에서 자격증명 평문 라인 제거 (export/선행공백 형태 포함)
  if (!existsSync('.env')) return;
  const lines = readFileSync('.env', 'utf8').split('\n').filter((l) => { const m = l.match(/^\s*(?:export\s+)?([A-Z0-9_]+)=/); return !(m && CRED_KEYS.includes(m[1])); });
  atomicWrite('.env', lines.join('\n').replace(/\n+$/, '\n'));
}
function setCreds(updates) { for (const [k, v] of Object.entries(updates)) if (v != null && v !== '') { store[k] = v; process.env[k] = v; } persist(); }
loadStore();

// 프리필용으로 값도 반환 (로컬 전용 도구 — localhost)
app.get('/api/accounts', (req, res) => {
  res.json({
    timeinout: { id: process.env.TIMEINOUT_ID || '', pw: process.env.TIMEINOUT_PW || '', saved: !!(process.env.TIMEINOUT_ID && process.env.TIMEINOUT_PW) },
    bizplay: { id: process.env.BIZPLAY_ID || '', pw: process.env.BIZPLAY_PW || '', saved: !!(process.env.BIZPLAY_ID && process.env.BIZPLAY_PW) },
    flow: { key: process.env.FLOW_API_KEY || '', saved: !!process.env.FLOW_API_KEY },
  });
});
app.post('/api/accounts', (req, res) => {
  const { service, id, pw, key } = req.body || {};
  const up = {};
  if (service === 'timeinout') { if (id != null) up.TIMEINOUT_ID = id; if (pw) up.TIMEINOUT_PW = pw; }
  else if (service === 'bizplay') { if (id != null) up.BIZPLAY_ID = id; if (pw) up.BIZPLAY_PW = pw; }
  else if (service === 'flow') { if (key) up.FLOW_API_KEY = key; }
  else return res.status(400).json({ error: '알 수 없는 서비스' });
  try { setCreds(up); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// 127.0.0.1 바인딩: 평문 자격증명을 반환하는 /api/accounts가 LAN에 노출되지 않도록 localhost 전용
app.listen(PORT, '127.0.0.1', () => console.log(`\n✅ webpilot 실행: http://localhost:${PORT}\n`));

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await closeBrowser(); process.exit(0); });
