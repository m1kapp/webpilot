import 'dotenv/config';
import express from 'express';
import { getOvertime, getOvertimeEmployee, closeBrowser } from './src/lib/timeinout.mjs';

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

// 로컬 .env 프리필 (공개 저장소엔 자격증명 하드코딩 안 함)
app.get('/api/defaults', (req, res) => {
  res.json({ id: process.env.TIMEINOUT_ID || '', pw: process.env.TIMEINOUT_PW || '', name: process.env.TIMEINOUT_NAME || '' });
});

app.listen(PORT, () => console.log(`\n✅ webpilot 실행: http://localhost:${PORT}\n`));

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await closeBrowser(); process.exit(0); });
