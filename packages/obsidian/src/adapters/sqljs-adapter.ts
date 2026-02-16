import type { Database as SqlJsDatabase } from 'sql.js';
import type { IDatabase, ExecuteResult, IDatabaseLifecycle } from '@engram/core';

/**
 * IDatabase implementation backed by sql.js-fts5 (WASM).
 * Debounced persistence to Obsidian vault adapter.
 */
export class SqlJsAdapter implements IDatabase, IDatabaseLifecycle {
  private db: SqlJsDatabase;
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private onSave: ((data: Uint8Array) => Promise<void>) | null = null;

  constructor(db: SqlJsDatabase, saveFn?: (data: Uint8Array) => Promise<void>) {
    this.db = db;
    this.onSave = saveFn ?? null;
    db.run('PRAGMA journal_mode = WAL');
    db.run('PRAGMA foreign_keys = ON');
  }

  queryAll<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    const stmt = this.db.prepare(sql);
    if (params.length > 0) stmt.bind(params as any);

    const rows: T[] = [];
    while (stmt.step()) {
      const colNames = stmt.getColumnNames();
      const vals = stmt.get();
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < colNames.length; i++) {
        obj[colNames[i]] = vals[i];
      }
      rows.push(obj as T);
    }
    stmt.free();
    return rows;
  }

  queryOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T | null {
    const results = this.queryAll<T>(sql, params);
    return results.length > 0 ? results[0] : null;
  }

  execute(sql: string, params: unknown[] = []): ExecuteResult {
    if (params.length === 0) {
      this.db.run(sql);
    } else {
      this.db.run(sql, params as any);
    }
    const changes = this.db.getRowsModified();
    const lastRow = this.queryOne<{ id: number }>('SELECT last_insert_rowid() as id');
    return {
      changes,
      lastInsertRowid: lastRow?.id ?? 0,
    };
  }

  execMulti(sql: string): void {
    this.db.exec(sql);
  }

  transaction<T>(fn: () => T): T {
    this.db.run('BEGIN');
    try {
      const result = fn();
      this.db.run('COMMIT');
      return result;
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }
  }

  pragma<T = unknown>(statement: string): T {
    return this.queryAll(`PRAGMA ${statement}`) as T;
  }

  markDirty(): void {
    this.dirty = true;
    this.debounceSave();
  }

  private debounceSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.flush();
    }, 30000);
  }

  async flush(): Promise<void> {
    if (!this.dirty || !this.onSave) return;
    try {
      const data = this.db.export();
      await this.onSave(new Uint8Array(data));
      this.dirty = false;
    } catch (e) {
      console.error('[Engram] Failed to save DB:', e);
    }
  }

  async close(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.flush();
    this.db.close();
  }
}
