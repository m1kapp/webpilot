import 'dotenv/config';
import express from 'express';
import { getOvertime, getOvertimeEmployee, closeBrowser } from './src/lib/timeinout.mjs';
import { getCardPending, submitExpenses, getYagunTaxi } from './src/lib/bizplay.mjs';

const app = express();
const PORT = process.env.PORT || 8181;
app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

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
  const { month = '2026-06', id = '', pw = '', patternId } = req.body || {};
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const send = (obj) => { res.write(JSON.stringify(obj) + '\n'); res.flush?.(); };
  try {
    console.log(`▶ [bizplay:submit] ${patternId} / ${month}`);
    const data = await submitExpenses({ month, id, pw, patternId, onSnapshot: (s) => send({ type: 'snap', snap: s }) });
    send({ type: 'result', data });
  } catch (e) {
    console.error('bizplay 상신 실패:', e.message);
    send({ type: 'error', error: e.message });
  }
  res.end();
});

// 로컬 .env 프리필 (공개 저장소엔 자격증명 하드코딩 안 함) — 레시피별
app.get('/api/defaults', (req, res) => {
  res.json({
    timeinout: { id: process.env.TIMEINOUT_ID || '', pw: process.env.TIMEINOUT_PW || '', name: process.env.TIMEINOUT_NAME || '' },
    bizplay: { id: process.env.BIZPLAY_ID || '', pw: process.env.BIZPLAY_PW || '' },
  });
});

app.listen(PORT, () => console.log(`\n✅ webpilot 실행: http://localhost:${PORT}\n`));

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await closeBrowser(); process.exit(0); });
