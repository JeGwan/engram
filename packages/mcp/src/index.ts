import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { initSchema, loadVectors, seedEntities, runExtraction } from '@engram/core';
import { getConfig } from './config.js';
import { BetterSqlite3Adapter } from './adapters/better-sqlite3-adapter.js';
import { NodeVaultReader } from './adapters/node-vault-reader.js';
import { registerAllTools, type McpContext } from './tools/register-all.js';

const config = getConfig();

const db = new BetterSqlite3Adapter(config.dbPath);
const vault = new NodeVaultReader(config.vaultRoot);

const server = new McpServer(
  { name: 'engram', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

const ctx: McpContext = {
  db,
  vault,
  vaultRoot: config.vaultRoot,
  skipDirs: config.skipDirs,
  ollamaUrl: config.ollamaUrl,
  ollamaModel: config.ollamaModel,
  peopleDir: config.peopleDir,
  vectors: [],
};

registerAllTools(server, ctx);

async function main() {
  // Initialize DB schema
  initSchema(db);

  // Startup incremental indexing
  console.error(`Indexing vault: ${config.vaultRoot}`);
  const { runFullIndex } = await import('./tools/register-all.js') as any;
  // Inline index logic since runFullIndex is not exported
  const scanned = vault.scanMarkdownFiles(config.skipDirs);
  const existingMap = new Map(
    db.queryAll<{ path: string; modified_at: number }>('SELECT path, modified_at FROM files')
      .map(f => [f.path, f.modified_at]),
  );
  const { indexFiles, deleteStaleFiles } = await import('@engram/core');
  const fs = await import('fs');
  const path = await import('path');

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
  console.error(`Index complete: ${indexed} indexed, ${skipped} skipped, ${deleted} deleted`);

  // Seed entities from people directory
  const seedResult = await seedEntities(db, vault, config.peopleDir);
  console.error(`Entities seeded: ${seedResult.peopleSeeded} people`);

  // Auto-extract relationships
  const extractResult = runExtraction(db, config.peopleDir);
  console.error(
    `Auto-extraction: ${extractResult.entitiesDiscovered} entities, ${extractResult.relationships} rels, ${extractResult.facts} facts, ${extractResult.filesProcessed} files (${extractResult.durationMs}ms)`,
  );

  // Load vector cache
  ctx.vectors = loadVectors(db);
  if (ctx.vectors.length > 0) {
    console.error(`Loaded ${ctx.vectors.length} vectors into memory`);
  }

  // Start MCP server
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('engram server running on stdio');
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
