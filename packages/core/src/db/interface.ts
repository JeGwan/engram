/**
 * Unified database interface — abstracts better-sqlite3 and sql.js.
 * All methods are synchronous (both drivers are sync).
 */
export interface IDatabase {
  queryAll<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
  queryOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | null;
  execute(sql: string, params?: unknown[]): ExecuteResult;
  execMulti(sql: string): void;
  transaction<T>(fn: () => T): T;
  pragma<T = unknown>(statement: string): T;
}

export interface ExecuteResult {
  lastInsertRowid: number;
  changes: number;
}

/**
 * Lifecycle hooks for DB persistence.
 * sql.js: markDirty() triggers debounced save. flush() forces save. close() exports + cleanup.
 * better-sqlite3: markDirty() is no-op. flush() is no-op. close() closes connection.
 */
export interface IDatabaseLifecycle {
  markDirty(): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Vault filesystem abstraction — adapts Node.js fs or Obsidian vault API.
 */
export interface IVaultReader {
  scanMarkdownFiles(skipDirs: Set<string>): import('../types.js').ScannedFile[];
  readFile(relativePath: string): Promise<string>;
  parseMetadata(relativePath: string, rawContent: string): import('../types.js').ParsedNote;
  directoryExists(relativePath: string): boolean;
  listSubdirectories(relativePath: string): string[];
  readFileIfExists(relativePath: string): Promise<string | null>;
}
