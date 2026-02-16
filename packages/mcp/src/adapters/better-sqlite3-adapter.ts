import Database from 'better-sqlite3';
import type { IDatabase, ExecuteResult, IDatabaseLifecycle } from '@engram/core';

export class BetterSqlite3Adapter implements IDatabase, IDatabaseLifecycle {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
  }

  queryAll<T>(sql: string, params: unknown[] = []): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  queryOne<T>(sql: string, params: unknown[] = []): T | null {
    return (this.db.prepare(sql).get(...params) as T) ?? null;
  }

  execute(sql: string, params: unknown[] = []): ExecuteResult {
    const result = this.db.prepare(sql).run(...params);
    return {
      lastInsertRowid: Number(result.lastInsertRowid),
      changes: result.changes,
    };
  }

  execMulti(sql: string): void {
    this.db.exec(sql);
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  pragma<T>(statement: string): T {
    return this.db.pragma(statement) as T;
  }

  // IDatabaseLifecycle — better-sqlite3 auto-persists via WAL
  markDirty(): void { /* no-op */ }
  async flush(): Promise<void> { /* no-op */ }
  async close(): Promise<void> {
    this.db.close();
  }
}
