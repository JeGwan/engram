import type { IDatabase } from '../db/interface.js';
import type { Entity } from '../types.js';

export function getEntity(db: IDatabase, id: string): Entity | null {
  const row = db.queryOne<any>('SELECT * FROM entities WHERE id = ?', [id]);
  if (!row) return null;
  return deserializeEntity(row);
}

export function getAllEntities(db: IDatabase): Entity[] {
  const rows = db.queryAll<any>('SELECT * FROM entities');
  return rows.map(deserializeEntity);
}

export function searchEntities(db: IDatabase, query: string, type?: string): Entity[] {
  const likeQuery = `%${query}%`;
  let sql = `SELECT * FROM entities WHERE (name LIKE ? OR aliases LIKE ? OR id LIKE ?)`;
  const params: unknown[] = [likeQuery, likeQuery, likeQuery];

  if (type) {
    sql += ' AND type = ?';
    params.push(type);
  }

  sql += ' LIMIT 20';
  const rows = db.queryAll<any>(sql, params);
  return rows.map(deserializeEntity);
}

export function upsertEntity(
  db: IDatabase,
  entity: {
    id: string;
    type: string;
    name: string;
    aliases?: string[];
    metadata?: Record<string, unknown>;
    sourcePath?: string;
  },
): void {
  const now = new Date().toISOString().slice(0, 10);
  db.execute(
    `INSERT INTO entities (id, type, name, aliases, metadata, source_path, first_seen, last_seen, mention_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(id) DO UPDATE SET
       type = excluded.type,
       name = excluded.name,
       aliases = excluded.aliases,
       metadata = excluded.metadata,
       source_path = excluded.source_path`,
    [
      entity.id,
      entity.type,
      entity.name,
      JSON.stringify(entity.aliases ?? []),
      JSON.stringify(entity.metadata ?? {}),
      entity.sourcePath ?? null,
      now,
      now,
    ],
  );
}

/**
 * Record a mention of an entity: increment mention_count, update last_seen.
 */
export function recordEntityMention(db: IDatabase, entityId: string, date?: string): void {
  const d = date ?? new Date().toISOString().slice(0, 10);
  db.execute(
    `UPDATE entities SET
       mention_count = mention_count + 1,
       last_seen = CASE WHEN last_seen IS NULL OR last_seen < ? THEN ? ELSE last_seen END
     WHERE id = ?`,
    [d, d, entityId],
  );
}

export function findEntityByName(db: IDatabase, name: string): Entity | null {
  // Exact name match (case-insensitive)
  const row = db.queryOne<any>('SELECT * FROM entities WHERE name = ? COLLATE NOCASE', [name]);
  if (row) return deserializeEntity(row);

  // Alias match
  const rows = db.queryAll<any>('SELECT * FROM entities WHERE aliases LIKE ?', [
    `%${JSON.stringify(name).slice(1, -1)}%`,
  ]);
  for (const r of rows) {
    const entity = deserializeEntity(r);
    if (entity.aliases.some(a => a.toLowerCase() === name.toLowerCase())) return entity;
  }

  return null;
}

function deserializeEntity(row: any): Entity {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    aliases: safeJsonParse(row.aliases, []),
    metadata: safeJsonParse(row.metadata, {}),
    sourcePath: row.source_path,
    firstSeen: row.first_seen ?? null,
    lastSeen: row.last_seen ?? null,
    mentionCount: row.mention_count ?? 0,
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
