#!/usr/bin/env node
/**
 * 임베딩 생성 스크립트 — 터미널에서 직접 실행하여 진행률 확인
 *
 * Usage:
 *   ENGRAM_VAULT_ROOT=/path/to/vault node scripts/run-embed.mjs [--force]
 *
 * (npm run build 먼저 실행 필요)
 */
import { initSchema, runEmbedIndex, loadVectors } from '../packages/core/build/index.js';

// Dynamically import MCP adapters (they depend on better-sqlite3)
const { getConfig } = await import('../packages/mcp/build/config.js');
const { BetterSqlite3Adapter } = await import('../packages/mcp/build/adapters/better-sqlite3-adapter.js');

const config = getConfig();
const db = new BetterSqlite3Adapter(config.dbPath);
initSchema(db);

const force = process.argv.includes('--force');
console.error(`임베딩 ${force ? '전체 재생성' : '증분'} 시작...\n`);
console.error(`Vault: ${config.vaultRoot}`);
console.error(`DB: ${config.dbPath}\n`);

const { result } = await runEmbedIndex(
  db,
  config.ollamaUrl,
  config.ollamaModel,
  force,
  (progress) => {
    process.stderr.write(`\r  [${progress.current}/${progress.total}] ${progress.currentFile ?? ''}`);
  },
);

const allVectors = loadVectors(db);

console.error(`\n\n완료: ${result.embedded} embedded, ${result.skipped} skipped, ${result.errors} errors (${result.durationMs}ms)`);
console.error(`메모리 로드: ${allVectors.length} vectors`);

db.close();
