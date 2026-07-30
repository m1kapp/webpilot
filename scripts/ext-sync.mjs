// src/core → extension/core 복사. 확장은 코어를 "그대로" 쓰고, 사본은 손대지 않는다.
// .mjs를 .js로 바꾸는 이유: 크롬 확장이 .mjs에 모듈 MIME 타입을 붙여주지 않아 import가 실패할 수 있다.
// 심볼릭 링크를 쓰지 않는 이유: zip 패키징에서 링크가 깨진다.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src', 'core');
const dest = join(root, 'extension', 'core');

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });

const files = readdirSync(src).filter((f) => f.endsWith('.mjs'));
for (const f of files) {
  const out = f.replace(/\.mjs$/, '.js');
  const code = readFileSync(join(src, f), 'utf8')
    .replace(/(from\s+['"]\.\/[^'"]+)\.mjs(['"])/g, '$1.js$2'); // 코어끼리의 상대 import도 함께 교정
  writeFileSync(join(dest, out), `// 자동 생성 — src/core/${f} 사본. 직접 수정하지 말고 원본을 고친 뒤 npm run ext:sync\n${code}`);
}
console.log(`✅ 코어 ${files.length}개 동기화 → extension/core (${files.map((f) => f.replace(/\.mjs$/, '.js')).join(', ')})`);
