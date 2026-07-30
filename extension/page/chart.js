// 출퇴근 시각 분포 — 캔버스 직접 그리기.
// Chart.js를 안 쓰는 이유: MV3는 CDN 스크립트를 막고, 사이드 패널 폭(≈340px)에서는
// 눈금·라벨 밀도를 직접 정하는 편이 훨씬 잘 들어간다. 계산은 core/clockchart.js 공유.
import { CLOCK_STACK, segmentDays, describeDay, usedLegend } from '../core/clockchart.js';

const AXIS_W = 34;      // 왼쪽 시각 눈금 자리
const PAD_R = 6;
const PAD_T = 8;
const XLAB_H = 26;      // 아래 날짜 라벨 자리
const GRID = '#f1f3f8';
const GUIDE = '#e6e9f1';
const TICK_TX = '#9aa1b5';

const hhmm = (v) => `${String(Math.floor(v)).padStart(2, '0')}:${String(Math.round((v % 1) * 60)).padStart(2, '0')}`;
const tickText = (v) => (v >= 24 ? `익 ${String(Math.floor(v - 24)).padStart(2, '0')}` : String(Math.floor(v)).padStart(2, '0'));

// 진행중(아직 퇴근 전)인 날은 확정이 아니라서 살짝 투명하게 뺀다.
function fade(color, mult) {
  const hex = /^#([0-9a-f]{6})$/i.exec(color);
  if (hex) { const n = parseInt(hex[1], 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${mult})`; }
  const m = /^rgba\(([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)\)$/.exec(color);
  if (m) return `rgba(${m[1]},${m[2]},${m[3]},${(+m[4] * mult).toFixed(3)})`;
  return color;
}

// 캔버스를 CSS 픽셀이 아니라 실제 화면 픽셀로 맞춘다(레티나에서 안 뭉개지게).
function fitCanvas(cv, cssH) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = cv.clientWidth || cv.parentElement.clientWidth;
  cv.style.height = `${cssH}px`;
  cv.width = Math.round(cssW * dpr);
  cv.height = Math.round(cssH * dpr);
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: cssW, h: cssH };
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
  ctx.fill();
}

// 좁을수록 날짜 라벨을 솎아낸다. 1일·5의 배수·말일은 남기고, 더 좁으면 간격을 벌린다.
function labelStride(slot) {
  if (slot >= 22) return 1;
  if (slot >= 14) return 2;
  if (slot >= 10) return 5;
  return 7;
}

export function drawClockChart(canvas, days, opts = {}) {
  if (!canvas || !days || !days.length) return null;
  const { segs, yMin, yMax } = segmentDays(days, opts);
  const wide = (canvas.parentElement?.clientWidth || 0) >= 560;
  const cssH = wide ? 320 : 240;
  const { ctx, w, h } = fitCanvas(canvas, cssH);
  if (!w) return null;

  const plotX = AXIS_W;
  const plotW = Math.max(10, w - AXIS_W - PAD_R);
  const plotY = PAD_T;
  const plotH = Math.max(10, h - PAD_T - XLAB_H);
  const yOf = (v) => plotY + ((v - yMin) / (yMax - yMin)) * plotH;   // 위가 이른 시각
  const slot = plotW / segs.length;
  const barW = Math.max(3, Math.min(wide ? 18 : 9, slot * 0.62));

  ctx.clearRect(0, 0, w, h);
  ctx.textBaseline = 'middle';

  // 주말·공휴일 열은 옅은 배경으로 깔아 평일과 구분한다.
  segs.forEach((g, i) => {
    if (!g.day.holiday) return;
    ctx.fillStyle = '#fafbfd';
    ctx.fillRect(plotX + i * slot, plotY, slot, plotH);
  });

  // 가로 눈금 — 좁으면 3시간, 넓으면 2시간 간격
  const step = wide ? 2 : 3;
  ctx.lineWidth = 1;
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'right';
  for (let v = Math.ceil(yMin / step) * step; v <= yMax; v += step) {
    const y = Math.round(yOf(v)) + 0.5;
    ctx.strokeStyle = GRID;
    ctx.beginPath(); ctx.moveTo(plotX, y); ctx.lineTo(plotX + plotW, y); ctx.stroke();
    ctx.fillStyle = TICK_TX;
    ctx.fillText(tickText(v), AXIS_W - 6, y);
  }

  // 기준선: 09시·18시(정규 근무 경계)는 회색 점선, 24시(익일 퇴근)는 빨강
  const guide = (v, color, dash) => {
    if (v < yMin || v > yMax) return;
    const y = Math.round(yOf(v)) + 0.5;
    ctx.save(); ctx.setLineDash(dash); ctx.strokeStyle = color;
    ctx.beginPath(); ctx.moveTo(plotX, y); ctx.lineTo(plotX + plotW, y); ctx.stroke(); ctx.restore();
  };
  guide(9, GUIDE, [4, 4]);
  guide(18, GUIDE, [4, 4]);
  guide(24, '#e5544c', [2, 3]);

  // 막대 — base(투명 오프셋)에서 시작해 아래로 쌓는다
  segs.forEach((g, i) => {
    const x = plotX + i * slot + (slot - barW) / 2;
    let cursor = g.base;
    for (const s of CLOCK_STACK) {
      const len = g[s.key] || 0;
      if (len <= 0.001) continue;
      const y0 = yOf(cursor), y1 = yOf(cursor + len);
      ctx.fillStyle = g.projected ? fade(s.color, 0.8) : s.color;
      roundRect(ctx, x, y0, barW, Math.max(1.5, y1 - y0), 2);
      cursor += len;
    }
  });

  // 날짜 라벨 — 주말은 빨강으로
  const stride = labelStride(slot);
  ctx.textAlign = 'center';
  segs.forEach((g, i) => {
    const d = g.day.day;
    const keep = stride === 1 || d === 1 || d === segs.length || d % stride === 0;
    if (!keep) return;
    const cx = plotX + i * slot + slot / 2;
    ctx.fillStyle = g.day.holiday ? '#c98a8a' : TICK_TX;
    ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillText(String(d), cx, plotY + plotH + 9);
    if (wide) {
      ctx.font = '9px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillText(g.day.dow, cx, plotY + plotH + 20);
    }
  });

  return { segs, plotX, slot, plotW };
}

// 캔버스 위 좌표 → 몇 번째 날인지
function hitIndex(geom, offsetX) {
  if (!geom) return -1;
  const i = Math.floor((offsetX - geom.plotX) / geom.slot);
  return i >= 0 && i < geom.segs.length ? i : -1;
}

// 그리기 + 툴팁 + 리사이즈(사이드 패널 ↔ 새 탭)까지 한 묶음으로 붙인다.
export function mountClockChart(canvas, tip, days, opts = {}) {
  let geom = null;
  const redraw = () => { geom = drawClockChart(canvas, days, opts); };
  redraw();

  const show = (ev) => {
    const r = canvas.getBoundingClientRect();
    const i = hitIndex(geom, ev.clientX - r.left);
    if (i < 0) return hide();
    const x = geom.segs[i].day;
    tip.innerHTML = `<b>${x.day}일 (${x.dow})</b><span>${describeDay(x)}</span>`
      + (x.otMin > 0 ? `<span class="ot">야근 +${Math.floor(x.otMin / 60)}:${String(x.otMin % 60).padStart(2, '0')}</span>` : '')
      + (x.holMin > 0 ? `<span class="ot">휴일근무 ${Math.floor(x.holMin / 60)}:${String(x.holMin % 60).padStart(2, '0')}</span>` : '');
    tip.hidden = false;
    // 툴팁이 오른쪽 벽을 넘지 않게 접어 넣는다
    const tw = tip.offsetWidth;
    const cx = geom.plotX + i * geom.slot + geom.slot / 2;
    tip.style.left = `${Math.max(4, Math.min(cx - tw / 2, canvas.clientWidth - tw - 4))}px`;
    tip.style.top = `${Math.max(0, ev.clientY - r.top - tip.offsetHeight - 12)}px`;
  };
  const hide = () => { tip.hidden = true; };

  canvas.addEventListener('pointermove', show);
  canvas.addEventListener('pointerdown', show);
  canvas.addEventListener('pointerleave', hide);

  // ResizeObserver: 새 탭으로 크게 열거나 패널 폭을 끌어당길 때 다시 그린다.
  const ro = new ResizeObserver(() => { hide(); redraw(); });
  ro.observe(canvas.parentElement);
  return { redraw, destroy: () => ro.disconnect() };
}

export function legendHTML(days, opts = {}) {
  const { segs } = segmentDays(days, opts);
  return usedLegend(segs).map((s) => `<span><i style="background:${s.color}"></i>${s.label}</span>`).join('');
}
