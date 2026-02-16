import type { IDatabase } from '../db/interface.js';
import type { Fact } from '../types.js';

export function queryFacts(
  db: IDatabase,
  opts: {
    entityId?: string;
    type?: string;
    since?: string;
    until?: string;
    limit?: number;
  },
): Fact[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts.entityId) {
    conditions.push('entity_ids LIKE ?');
    params.push(`%${opts.entityId}%`);
  }
  if (opts.type) {
    conditions.push('type = ?');
    params.push(opts.type);
  }
  if (opts.since) {
    conditions.push('recorded_at >= ?');
    params.push(opts.since);
  }
  if (opts.until) {
    conditions.push('recorded_at <= ?');
    params.push(opts.until);
  }

  let sql = 'SELECT * FROM facts';
  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }
  sql += ' ORDER BY recorded_at DESC';
  sql += ` LIMIT ${opts.limit ?? 50}`;

  const rows = db.queryAll<any>(sql, params);
  return rows.map(deserializeFact);
}

export function addFact(
  db: IDatabase,
  fact: {
    type: string;
    content: string;
    entityIds?: string[];
    recordedAt?: string;
    validUntil?: string;
    sourceFile?: string;
  },
): number {
  // Dedup
  const existing = db.queryOne<{ id: number }>(
    'SELECT id FROM facts WHERE type = ? AND content = ? AND source_file = ?',
    [fact.type, fact.content, fact.sourceFile ?? null],
  );
  if (existing) return existing.id;

  const result = db.execute(
    `INSERT INTO facts (type, content, entity_ids, recorded_at, valid_until, source_file)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      fact.type,
      fact.content,
      JSON.stringify(fact.entityIds ?? []),
      fact.recordedAt ?? new Date().toISOString().slice(0, 10),
      fact.validUntil ?? null,
      fact.sourceFile ?? null,
    ],
  );
  return result.lastInsertRowid;
}

function deserializeFact(row: any): Fact {
  return {
    id: row.id,
    type: row.type,
    content: row.content,
    entityIds: safeJsonParse(row.entity_ids, []),
    recordedAt: row.recorded_at,
    validUntil: row.valid_until,
    sourceFile: row.source_file,
  };
}

function safeJsonParse<T>(str: string | null, fallback: T): T {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}
