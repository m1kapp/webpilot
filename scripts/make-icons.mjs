// 확장 아이콘 생성. 예전 아이콘은 타임인아웃 서비스 로고를 그대로 쓰고 있었다 —
// 남의 상표라 스토어 심사에서 문제가 되고, 무엇보다 우리 물건으로 안 보인다.
//
// 16px에서도 뭉개지지 않아야 하므로 형태를 극단적으로 단순하게 잡는다:
// 위로 쓸려 올라가는 날개(Webwing) = 길이가 다른 세 획.
// SVG를 크롬으로 렌더해 크기별 PNG로 뽑는다(별도 이미지 라이브러리 없이).
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'icons');
const SIZES = [16, 32, 48, 128];

// 확장 UI와 같은 파랑(--blue #3b6fe0)에서 살짝 어둡게 내려 입체를 준다.
const svg = (px) => {
  const s = 128;                       // 좌표계는 128 고정, 출력만 px로 확대·축소
  const tiny = px <= 32;               // 아주 작을 땐 획을 굵게, 개수를 줄인다
  // 오른쪽 끝을 맞추고 위로 갈수록 길게 → 위로 쓸리는 날개. 왼쪽 정렬이면 목록 아이콘처럼 보인다.
  const right = 100;
  const h = tiny ? 16 : 13;
  const rows = tiny ? [[40, 74], [64, 46]] : [[34, 78], [56, 56], [78, 32]];   // [y, 길이]
  const bars = rows.map(([y, w]) => [right - w, y, w]);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${s} ${s}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#4a7bea"/><stop offset="1" stop-color="#2a54b4"/>
    </linearGradient>
  </defs>
  <rect width="${s}" height="${s}" rx="${tiny ? 26 : 30}" fill="url(#g)"/>
  <g fill="#fff" transform="rotate(-16 64 64)">
    ${bars.map(([x, y, w]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}"/>`).join('\n    ')}
  </g>
</svg>`;
};

const browser = await chromium.launch();
const page = await browser.newPage();
for (const px of SIZES) {
  await page.setViewportSize({ width: px, height: px });
  await page.setContent(
    `<body style="margin:0;background:transparent">${svg(px)}</body>`,
    { waitUntil: 'load' });
  const buf = await page.screenshot({ omitBackground: true });
  writeFileSync(join(OUT, `icon${px}.png`), buf);
  console.log(`✅ icon${px}.png`);
}
await browser.close();

// 미리보기 — 실제 크기로 나란히 확인할 수 있게
writeFileSync(join(OUT, '..', '..', 'dist', 'icon-preview.html'),
  `<body style="font-family:-apple-system,sans-serif;background:#f4f6fb;padding:28px">
<h2 style="margin:0 0 4px">Webwing 확장 아이콘</h2>
<p style="color:#8a93a6;margin:0 0 20px">실제 크기 · 툴바에 뜨는 건 16px</p>
<div style="display:flex;gap:26px;align-items:flex-end;background:#fff;padding:22px;border-radius:14px;width:max-content">
${SIZES.map((p) => `<div style="text-align:center"><img src="../extension/icons/icon${p}.png" width="${p}"><div style="font-size:11px;color:#8a93a6;margin-top:8px">${p}px</div></div>`).join('')}
</div></body>`);
console.log('미리보기 → dist/icon-preview.html');
