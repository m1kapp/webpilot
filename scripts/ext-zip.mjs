// 스토어 업로드용 zip 생성. 폴더째가 아니라 extension/ 내용물을 압축한다(manifest.json이 최상위여야 함).
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ext = join(root, 'extension');
const { version, name } = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));

execFileSync('node', [join(root, 'scripts', 'ext-sync.mjs')], { stdio: 'inherit' });

const outDir = join(root, 'dist');
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `webwing-extension-${version}.zip`);
rmSync(out, { force: true });

execFileSync('zip', ['-r', '-q', out, '.', '-x', '.DS_Store', '-x', '__MACOSX/*', '-x', 'README.md'], { cwd: ext });
console.log(`✅ ${name} ${version} → ${out}`);
