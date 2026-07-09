// 패키징 후 앱 리소스는 읽기전용 → 쓰기 가능한 데이터 폴더를 별도로 둔다.
// Tauri가 사이드카 스폰 시 WEBPILOT_DATA_DIR을 주입(맥: ~/Library/Application Support/webpilot, 윈도우: %APPDATA%\webpilot).
// 개발 모드(직접 node server.mjs 실행)는 지금까지처럼 프로젝트 루트(CWD)를 그대로 씀 — 동작 변화 없음.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const dataDir = () => process.env.WEBPILOT_DATA_DIR || process.cwd();
export const authDir = () => join(dataDir(), '.auth');
export const authPath = (name) => join(authDir(), name);
export function ensureAuthDir() { mkdirSync(authDir(), { recursive: true }); }
