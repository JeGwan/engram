import type {
  IDatabase,
  IDatabaseLifecycle,
  IVaultReader,
  VaultStats,
  SearchResult,
  SemanticResult,
  IndexResult,
  EmbedResult,
  ExtractionResult,
  VectorEntry,
} from '@engram/core';
import {
  indexFiles,
  removeFile,
  renameFile,
  deleteStaleFiles,
  embed,
  isOllamaRunning,
  searchVectors,
  loadVectors,
  findSimilarByFile,
  runEmbedIndex,
  getAllEntities,
  searchEntities as searchEntitiesCore,
  getRelationships as getRelationshipsCore,
  getAllRelationships,
  queryFacts,
  runExtraction,
  getVaultStats,
} from '@engram/core';

export interface EngramSettings {
  ollamaUrl: string;
  ollamaModel: string;
  autoIndexOnStartup: boolean;
  embeddingEnabled: boolean;
  graphExtractionEnabled: boolean;
  skipDirectories: string[];
  peopleDir: string;
}

export const DEFAULT_SETTINGS: EngramSettings = {
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'bge-m3',
  autoIndexOnStartup: true,
  embeddingEnabled: false,
  graphExtractionEnabled: false,
  skipDirectories: ['node_modules', '.git'],
  peopleDir: '',
};

/**
 * EngramEngine — facade that delegates all operations to @engram/core functions
 * with injected IDatabase + IVaultReader.
 */
export class EngramEngine {
  private vectors: VectorEntry[] = [];

  constructor(
    private db: IDatabase & IDatabaseLifecycle,
    private vault: IVaultReader,
    private settings: EngramSettings,
  ) {}

  // ───── Indexing ─────

  async fullIndex(force = false): Promise<IndexResult> {
    const start = Date.now();
    const skipSet = new Set(this.settings.skipDirectories);
    const scanned = this.vault.scanMarkdownFiles(skipSet);
    const scannedPaths = new Set(scanned.map(f => f.path));

    // Get existing indexed files for mtime comparison
    const existing = this.db.queryAll<{ path: string; modified_at: number }>(
      'SELECT path, modified_at FROM files',
    );
    const existingMap = new Map(existing.map(f => [f.path, f.modified_at]));

    let indexed = 0;
    let skipped = 0;

    // Batch files to index
    const batch: Parameters<typeof indexFiles>[1] = [];

    for (const file of scanned) {
      const existingMtime = existingMap.get(file.path);
      if (!force && existingMtime && Math.abs(existingMtime - file.modifiedAt) < 1000) {
        skipped++;
        continue;
      }

      try {
        const raw = await this.vault.readFile(file.path);
        const parsed = this.vault.parseMetadata(file.path, raw);
        const directory = file.path.split('/')[0] || '';

        batch.push({
          path: file.path,
          title: parsed.title,
          directory,
          tags: parsed.tags,
          frontmatter: parsed.frontmatter,
          wikiLinks: parsed.wikiLinks,
          content: parsed.content,
          modifiedAt: file.modifiedAt,
        });
      } catch (err) {
        console.error(`[Engram] Failed to read ${file.path}:`, err);
        skipped++;
      }

      // Yield to main thread every 50 files
      if (batch.length % 50 === 0 && batch.length > 0) {
        indexed += indexFiles(this.db, batch.splice(0));
        await sleep(0);
      }
    }

    // Flush remaining batch
    if (batch.length > 0) {
      indexed += indexFiles(this.db, batch);
    }

    // Delete stale files
    const deleted = deleteStaleFiles(this.db, scannedPaths);

    this.db.markDirty();
    return { indexed, skipped, deleted, durationMs: Date.now() - start };
  }

  async indexSingleFile(filePath: string, modifiedAt: number): Promise<void> {
    try {
      const raw = await this.vault.readFile(filePath);
      const parsed = this.vault.parseMetadata(filePath, raw);
      const directory = filePath.split('/')[0] || '';

      indexFiles(this.db, [{
        path: filePath,
        title: parsed.title,
        directory,
        tags: parsed.tags,
        frontmatter: parsed.frontmatter,
        wikiLinks: parsed.wikiLinks,
        content: parsed.content,
        modifiedAt,
      }]);
      this.db.markDirty();
    } catch (err) {
      console.error(`[Engram] Failed to index ${filePath}:`, err);
    }
  }

  removeFromIndex(path: string): void {
    removeFile(this.db, path);
    this.db.markDirty();
  }

  renameInIndex(oldPath: string, newPath: string): void {
    renameFile(this.db, oldPath, newPath);
    this.db.markDirty();
  }

  // ───── FTS Search ─────

  search(query: string, opts?: { directory?: string; tag?: string; limit?: number }): SearchResult[] {
    const limit = opts?.limit ?? 20;
    let sql = `
      SELECT f.path, f.title, f.directory, f.tags, f.modified_at as modifiedAt,
             snippet(files_fts, 1, '<mark>', '</mark>', '...', 40) as snippet
      FROM files_fts fts
      JOIN files f ON f.id = fts.rowid
      WHERE files_fts MATCH ?
    `;
    const params: unknown[] = [query];

    if (opts?.directory) {
      sql += ' AND f.directory = ?';
      params.push(opts.directory);
    }
    if (opts?.tag) {
      sql += ' AND f.tags LIKE ?';
      params.push(`%${opts.tag}%`);
    }
    sql += ' ORDER BY rank LIMIT ?';
    params.push(limit);

    return this.db.queryAll<SearchResult>(sql, params);
  }

  // ───── Semantic Search ─────

  async semanticSearch(query: string, topK = 10): Promise<SemanticResult[]> {
    if (!await this.isOllamaAvailable()) {
      throw new Error('Ollama is not running. Start Ollama to use semantic search.');
    }
    const queryVec = await embed(query, this.settings.ollamaUrl, this.settings.ollamaModel);
    const vectorResults = searchVectors(this.vectors, queryVec, topK);

    return vectorResults.map(v => {
      const file = this.db.queryOne<{ path: string; title: string }>(
        'SELECT path, title FROM files WHERE id = ?', [v.fileId],
      );
      const chunk = this.db.queryOne<{ chunk_text: string }>(
        'SELECT chunk_text FROM embeddings WHERE id = ?', [v.id],
      );
      return {
        path: file?.path ?? '',
        title: file?.title ?? '',
        heading: v.heading,
        score: Math.round(v.score * 1000) / 1000,
        chunkText: chunk?.chunk_text ?? '',
      };
    });
  }

  async isOllamaAvailable(): Promise<boolean> {
    return isOllamaRunning(this.settings.ollamaUrl);
  }

  loadVectorCache(): number {
    this.vectors = loadVectors(this.db);
    return this.vectors.length;
  }

  getVectorCount(): number {
    return this.vectors.length;
  }

  async runEmbedding(force = false, onProgress?: (pct: number, msg: string) => void): Promise<EmbedResult> {
    const { result, vectors } = await runEmbedIndex(
      this.db,
      this.settings.ollamaUrl,
      this.settings.ollamaModel,
      force,
      onProgress,
    );
    this.vectors = vectors;
    this.db.markDirty();
    return result;
  }

  findSimilar(filePath: string, topK = 10) {
    return findSimilarByFile(this.db, this.vectors, filePath, topK);
  }

  // ───── Graph ─────

  runGraphExtraction(opts?: { force?: boolean; limit?: number }): ExtractionResult {
    const result = runExtraction(this.db, this.settings.peopleDir || null, opts);
    this.db.markDirty();
    return result;
  }

  getGraphData(typeFilter?: string, relTypeFilter?: string) {
    const allEntities = getAllEntities(this.db);
    const entities = typeFilter ? allEntities.filter(e => e.type === typeFilter) : allEntities;

    const allRels = getAllRelationships(this.db, relTypeFilter);
    const entityMap = new Map(entities.map(e => [e.id, e]));
    const edges = allRels.filter(r => entityMap.has(r.sourceId) && entityMap.has(r.targetId));

    const connectedIds = new Set<string>();
    for (const e of edges) {
      connectedIds.add(e.sourceId);
      connectedIds.add(e.targetId);
    }

    const nodeList = typeFilter ? entities : entities.filter(e => connectedIds.has(e.id));

    const TYPE_COLORS: Record<string, string> = {
      person: '#3b82f6',
      organization: '#22c55e',
      project: '#f97316',
      team: '#a855f7',
      topic: '#eab308',
      event: '#ec4899',
    };

    const nodes = nodeList.map(e => ({
      id: e.id,
      label: e.name,
      group: e.type,
      color: TYPE_COLORS[e.type] ?? '#6b7280',
      title: `${e.name} (${e.type})`,
    }));

    const edgesOut = edges.map(r => ({
      from: r.sourceId,
      to: r.targetId,
      label: r.type,
      id: r.id,
    }));

    return { nodes, edges: edgesOut };
  }

  searchEntities(query: string, type?: string) {
    return searchEntitiesCore(this.db, query, type);
  }

  getEntityRelationships(entityId: string, type?: string) {
    return getRelationshipsCore(this.db, entityId, type);
  }

  getEntityFacts(entityId: string, type?: string) {
    return queryFacts(this.db, { entityId, type });
  }

  // ───── Stats ─────

  getStats(): VaultStats {
    return getVaultStats(this.db);
  }

  // ───── DB Explorer ─────

  getTables() {
    const tables = this.db.queryAll<{ name: string; sql: string }>(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );

    return tables.map(t => {
      const columns = this.db.queryAll<{ cid: number; name: string; type: string; notnull: number; pk: number }>(
        `PRAGMA table_info("${t.name}")`,
      );
      const rowCount = this.db.queryOne<{ c: number }>(`SELECT COUNT(*) as c FROM "${t.name}"`)?.c ?? 0;
      return {
        name: t.name,
        sql: t.sql,
        columns: columns.map(c => ({
          name: c.name,
          type: c.type,
          notnull: !!c.notnull,
          pk: !!c.pk,
        })),
        rowCount,
      };
    });
  }

  getTableRows(tableName: string, opts?: { limit?: number; offset?: number; sort?: string; order?: string }) {
    const validTables = this.db.queryAll<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    );
    const tableNames = new Set(validTables.map(t => t.name));
    if (!tableNames.has(tableName)) {
      return { columns: [] as string[], rows: [] as Record<string, unknown>[], total: 0, limit: 0, offset: 0 };
    }

    const columns = this.db.queryAll<{ name: string }>(`PRAGMA table_info("${tableName}")`).map(c => c.name);
    const limit = Math.min(opts?.limit ?? 50, 500);
    const offset = opts?.offset ?? 0;
    const sort = opts?.sort ?? '';
    const order = opts?.order === 'desc' ? 'DESC' : 'ASC';

    const total = this.db.queryOne<{ c: number }>(`SELECT COUNT(*) as c FROM "${tableName}"`)?.c ?? 0;

    let sql = `SELECT * FROM "${tableName}"`;
    if (sort && columns.includes(sort)) {
      sql += ` ORDER BY "${sort}" ${order}`;
    }
    sql += ` LIMIT ${limit} OFFSET ${offset}`;

    const rows = this.db.queryAll<Record<string, unknown>>(sql);

    const truncatedRows = rows.map(row => {
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(row)) {
        if (typeof val === 'string' && val.length > 500) {
          out[key] = val.slice(0, 500) + '...';
        } else if (val instanceof Uint8Array) {
          out[key] = `[BLOB ${val.length} bytes]`;
        } else {
          out[key] = val;
        }
      }
      return out;
    });

    return { columns, rows: truncatedRows, total, limit, offset };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
