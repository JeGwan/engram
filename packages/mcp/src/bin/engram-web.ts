#!/usr/bin/env node
import { initSchema, loadVectors, seedEntities, runExtraction, indexFiles, deleteStaleFiles } from '@engram/core';
import { startWebServer, type WebServerDeps } from '@engram/web';
import { getConfig } from '../config.js';
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter.js';
import { NodeVaultReader } from '../adapters/node-vault-reader.js';
import fs from 'fs';
import path from 'path';

async function main() {
  const config = getConfig();
  const port = parseInt(process.env.ENGRAM_WEB_PORT ?? '3930', 10);

  console.log(`Engram Web UI starting...`);
  console.log(`Vault: ${config.vaultRoot}`);

  const db = new BetterSqlite3Adapter(config.dbPath);
  const vault = new NodeVaultReader(config.vaultRoot);

  initSchema(db);

  // Index
  const scanned = vault.scanMarkdownFiles(config.skipDirs);
  const existingMap = new Map(
    db.queryAll<{ path: string; modified_at: number }>('SELECT path, modified_at FROM files')
      .map(f => [f.path, f.modified_at]),
  );
  const toIndex: Array<{
    path: string; title: string; directory: string;
    tags: string[]; frontmatter: Record<string, unknown>;
    wikiLinks: string[]; content: string; modifiedAt: number;
  }> = [];
  let skipped = 0;
  for (const file of scanned) {
    const existingMtime = existingMap.get(file.path);
    if (existingMtime && Math.abs(existingMtime - file.modifiedAt) < 1000) {
      skipped++;
      continue;
    }
    try {
      const raw = fs.readFileSync(path.join(config.vaultRoot, file.path), 'utf-8');
      const parsed = vault.parseMetadata(file.path, raw);
      const directory = file.path.split('/')[0] ?? '';
      toIndex.push({
        path: file.path, title: parsed.title, directory,
        tags: parsed.tags, frontmatter: parsed.frontmatter,
        wikiLinks: parsed.wikiLinks, content: parsed.content,
        modifiedAt: file.modifiedAt,
      });
    } catch { skipped++; }
  }
  const indexed = indexFiles(db, toIndex);
  const scannedPaths = new Set(scanned.map(f => f.path));
  const deleted = deleteStaleFiles(db, scannedPaths);
  console.log(`Index: ${indexed} indexed, ${skipped} skipped, ${deleted} deleted`);

  const seedResult = await seedEntities(db, vault, config.peopleDir);
  console.log(`Seeded: ${seedResult.peopleSeeded} people`);

  const extractResult = runExtraction(db, config.peopleDir);
  console.log(`Extraction: ${extractResult.entitiesDiscovered} entities, ${extractResult.relationships} rels, ${extractResult.facts} facts (${extractResult.durationMs}ms)`);

  const vectors = loadVectors(db);
  if (vectors.length > 0) {
    console.log(`Vectors: ${vectors.length} loaded`);
  }

  const deps: WebServerDeps = { db, vectors, ollamaUrl: config.ollamaUrl, ollamaModel: config.ollamaModel };
  const url = await startWebServer(deps, port);
  console.log(`\n${url}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
