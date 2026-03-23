#!/usr/bin/env node
/**
 * 대화 기록 저장 CLI — session-end 훅에서 호출
 *
 * Usage:
 *   echo '{"session_id":"...","date":"2026-02-22 09:00","summary":"...","topics":"클립홈 배포","outcome":"...","next_actions":"..."}' \
 *     | node scripts/add-conversation.mjs
 *
 * (npm run build 먼저 실행 필요)
 */
import { createInterface } from 'readline';
import { initSchema, addConversation } from '../packages/core/build/index.js';

const { getConfig } = await import('../packages/mcp/build/config.js');
const { BetterSqlite3Adapter } = await import('../packages/mcp/build/adapters/better-sqlite3-adapter.js');

// stdin에서 JSON 읽기
const rl = createInterface({ input: process.stdin, terminal: false });
const lines = [];
for await (const line of rl) {
  lines.push(line);
}
const raw = lines.join('\n').trim();

if (!raw) {
  process.stderr.write('add-conversation: stdin이 비어있음, 스킵\n');
  process.exit(0);
}

let data;
try {
  // JSON 코드블록으로 감싸진 경우 처리
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  data = JSON.parse(cleaned);
} catch {
  process.stderr.write(`add-conversation: JSON 파싱 실패\n${raw.slice(0, 200)}\n`);
  process.exit(0);
}

const { session_id, date, summary, topics, outcome, next_actions } = data;

if (!session_id || !date || !summary) {
  process.stderr.write('add-conversation: 필수 필드 누락 (session_id, date, summary)\n');
  process.exit(0);
}

const config = getConfig();
const db = new BetterSqlite3Adapter(config.dbPath);
initSchema(db);

addConversation(db, {
  session_id,
  date,
  summary,
  topics: topics ?? '',
  outcome: outcome ?? undefined,
  next_actions: next_actions ?? undefined,
});

await db.close();
process.stderr.write(`add-conversation: 저장 완료 [${date}] ${summary.slice(0, 60)}\n`);
