// 실행 이력: 완료된 자동화 결과를 로컬 JSON 파일로 저장 → "이력" 버튼에서 재조회 없이 다시 봄
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './paths.mjs';

const MAX_PER_KEY = 30; // 자동화(키)당 최대 보관 개수 — 오래된 것부터 버림
const safeName = (key) => String(key).replace(/[^a-zA-Z0-9_.-]/g, '_') || '_';
const historyDir = () => join(dataDir(), '.history');
const filePath = (key) => join(historyDir(), `${safeName(key)}.json`);

function atomicWrite(path, data) { const tmp = `${path}.tmp`; writeFileSync(tmp, data); renameSync(tmp, path); }

function readAll(key) {
  try { return JSON.parse(readFileSync(filePath(key), 'utf8')); } catch { return []; }
}

// data에서 snapshots(스크린샷 base64, 용량 큼) 제외한 사본을 저장
export function saveHistory(key, data) {
  if (!key || !data) return;
  const { snapshots, ...rest } = data;
  const entries = readAll(key);
  entries.unshift({ id: `${Date.now()}`, savedAt: new Date().toISOString(), month: data.month || '', data: rest });
  entries.length = Math.min(entries.length, MAX_PER_KEY);
  mkdirSync(historyDir(), { recursive: true });
  atomicWrite(filePath(key), JSON.stringify(entries));
}

// 목록만(요약) — 무거운 items/snapshots는 빼고 summary(대표 데이터 한 줄용)까지만
export function listHistory(key) {
  return readAll(key).map(({ id, savedAt, month, data }) => ({ id, savedAt, month, summary: data?.summary || null }));
}

export function getHistoryEntry(key, id) {
  return readAll(key).find((e) => e.id === id) || null;
}
