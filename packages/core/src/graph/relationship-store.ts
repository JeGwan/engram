import type { IDatabase } from '../db/interface.js';
import type { Relationship } from '../types.js';

export function getRelationships(db: IDatabase, entityId: string, type?: string): Relationship[] {
  let sql = `SELECT * FROM relationships WHERE (source_id = ? OR target_id = ?)`;
  const params: unknown[] = [entityId, entityId];

  if (type) {
    sql += ' AND type = ?';
    params.push(type);
  }

  sql += ' ORDER BY id DESC';
  const rows = db.queryAll<any>(sql, params);
  return rows.map(deserializeRelationship);
}

export function getAllRelationships(db: IDatabase, type?: string): Relationship[] {
  let sql = 'SELECT * FROM relationships';
  const params: unknown[] = [];
  if (type) {
    sql += ' WHERE type = ?';
    params.push(type);
  }
  const rows = db.queryAll<any>(sql, params);
  return rows.map(deserializeRelationship);
}

export function addRelationship(
  db: IDatabase,
  rel: {
    sourceId: string;
    targetId: string;
    type: string;
    context?: string;
    validFrom?: string;
    validUntil?: string;
    sourceFile?: string;
  },
): number {
  // Validate entity IDs exist
  const sourceExists = db.queryOne('SELECT 1 FROM entities WHERE id = ?', [rel.sourceId]);
  const targetExists = db.queryOne('SELECT 1 FROM entities WHERE id = ?', [rel.targetId]);
  if (!sourceExists || !targetExists) {
    throw new Error(`Entity not found: ${!sourceExists ? rel.sourceId : rel.targetId}`);
  }

  // Check for duplicate
  const existing = db.queryOne<{ id: number }>(
    'SELECT id FROM relationships WHERE source_id = ? AND target_id = ? AND type = ?',
    [rel.sourceId, rel.targetId, rel.type],
  );
  if (existing) return existing.id;

  const result = db.execute(
    `INSERT INTO relationships (source_id, target_id, type, context, valid_from, valid_until, source_file)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      rel.sourceId,
      rel.targetId,
      rel.type,
      rel.context ?? null,
      rel.validFrom ?? null,
      rel.validUntil ?? null,
      rel.sourceFile ?? null,
    ],
  );

  return result.lastInsertRowid;
}

function deserializeRelationship(row: any): Relationship {
  return {
    id: row.id,
    sourceId: row.source_id,
    targetId: row.target_id,
    type: row.type,
    context: row.context,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    sourceFile: row.source_file,
  };
}
