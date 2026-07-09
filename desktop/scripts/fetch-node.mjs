// Tauri 사이드카용 node 런타임을 nodejs.org에서 받아 target-triple 이름으로 배치.
// 사용: node scripts/fetch-node.mjs [target-triple ...]  (인자 없으면 현재 플랫폼만)
import { mkdirSync, createWriteStream, chmodSync, existsSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NODE_VERSION = 'v24.18.0'; // LTS 고정 — 올릴 때 여기만 바꾸면 됨
const DEST = join(__dirname, '..', 'src-tauri', 'binaries');

const TARGETS = {
  'aarch64-apple-darwin': { archive: 'darwin-arm64.tar.gz', bin: 'bin/node', exe: false },
  'x86_64-apple-darwin': { archive: 'darwin-x64.tar.gz', bin: 'bin/node', exe: false },
  'x86_64-pc-windows-msvc': { archive: 'win-x64.zip', bin: 'node.exe', exe: true },
};

const requested = process.argv.slice(2);
const list = requested.length ? requested : [hostTriple()];

function hostTriple() {
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  if (process.platform === 'win32') return 'x86_64-pc-windows-msvc';
  throw new Error(`이 스크립트는 mac/윈도우 빌드용입니다: ${process.platform}`);
}

async function fetchOne(triple) {
  const t = TARGETS[triple];
  if (!t) throw new Error(`알 수 없는 target triple: ${triple}`);
  const destName = `node-${triple}${t.exe ? '.exe' : ''}`;
  const destPath = join(DEST, destName);
  if (existsSync(destPath)) { console.log(`skip (있음): ${destName}`); return; }

  mkdirSync(DEST, { recursive: true });
  const url = `https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-${t.archive}`;
  const archivePath = join(tmpdir(), `node-fetch-${triple}-${Date.now()}${t.archive.endsWith('.zip') ? '.zip' : '.tar.gz'}`);
  console.log(`받는 중: ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`다운로드 실패 ${res.status}: ${url}`);
  await pipeline(res.body, createWriteStream(archivePath));

  const extractDir = join(tmpdir(), `node-extract-${triple}-${Date.now()}`);
  mkdirSync(extractDir, { recursive: true });
  if (t.archive.endsWith('.zip')) execFileSync('unzip', ['-q', archivePath, '-d', extractDir]);
  else execFileSync('tar', ['xzf', archivePath, '-C', extractDir]);

  const innerDir = `node-${NODE_VERSION}-${t.archive.replace(/\.(tar\.gz|zip)$/, '')}`;
  const src = join(extractDir, innerDir, t.bin);
  execFileSync('cp', [src, destPath]);
  if (!t.exe) chmodSync(destPath, 0o755);
  console.log(`완료: ${destName}`);
}

for (const triple of list) await fetchOne(triple);
