// 스토어 업로드용 zip 생성. 폴더째가 아니라 extension/ 내용물을 압축한다(manifest.json이 최상위여야 함).
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ext = join(root, 'extension');
const { version, version_name: versionName, name } = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));

// manifest의 version_name과 수집부 BUILD가 어긋나면 사용자가 화면에서 읽는 버전이 거짓이 된다.
// 진단이 "어느 빌드냐"에 걸려 있으므로 여기서 막는다.
const build = (readFileSync(join(ext, 'lib', 'bizplay.js'), 'utf8').match(/const BUILD = '([^']+)'/) || [])[1];
if (build && versionName && !versionName.includes(build)) {
  console.error(`✗ 버전 불일치 — manifest version_name "${versionName}" vs BUILD "${build}"`);
  console.error('  extension/manifest.json 의 version_name 을 맞춘 뒤 다시 실행하세요.');
  process.exit(1);
}

execFileSync('node', [join(root, 'scripts', 'ext-sync.mjs')], { stdio: 'inherit' });

const outDir = join(root, 'dist');
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `webwing-extension-${version}.zip`);
rmSync(out, { force: true });

execFileSync('zip', ['-r', '-q', out, '.', '-x', '.DS_Store', '-x', '__MACOSX/*', '-x', 'README.md'], { cwd: ext });
console.log(`✅ ${name} ${version} → ${out}`);
