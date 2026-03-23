import type { IDatabase } from '../db/interface.js';
import type { Relationship, RelationshipEvidence } from '../types.js';

export function getRelationships(db: IDatabase, entityId: string, type?: string): Relationship[] {
  let sql = `SELECT * FROM relationships WHERE (source_id = ? OR target_id = ?)`;
  const params: unknown[] = [entityId, entityId];

  if (type) {
    sql += ' AND type = ?';
    params.push(type);
  }

  sql += ' ORDER BY weight DESC, id DESC';
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
    confidence?: number;
    extractionMethod?: string;
  },
): number {
  // Validate entity IDs exist
  const sourceExists = db.queryOne('SELECT 1 FROM entities WHERE id = ?', [rel.sourceId]);
  const targetExists = db.queryOne('SELECT 1 FROM entities WHERE id = ?', [rel.targetId]);
  if (!sourceExists || !targetExists) {
    throw new Error(`Entity not found: ${!sourceExists ? rel.sourceId : rel.targetId}`);
  }

  const now = new Date().toISOString().slice(0, 10);
  const confidence = rel.confidence ?? 1.0;
  const method = rel.extractionMethod ?? 'rule';

  // Check for duplicate
  const existing = db.queryOne<{ id: number; seen_count: number }>(
    'SELECT id, seen_count FROM relationships WHERE source_id = ? AND target_id = ? AND type = ?',
    [rel.sourceId, rel.targetId, rel.type],
  );

  if (existing) {
    // Update existing: increment seen_count, update last_seen, recompute weight
    const newCount = existing.seen_count + 1;
    const newWeight = computeWeight(newCount, now, confidence);
    db.execute(
      `UPDATE relationships SET seen_count = ?, last_seen = ?, weight = ?, confidence = MAX(confidence, ?)
       WHERE id = ?`,
      [newCount, now, newWeight, confidence, existing.id],
    );

    // Add evidence
    if (rel.sourceFile) {
      addEvidence(db, existing.id, rel.sourceFile, rel.context, method);
    }

    return existing.id;
  }

  const weight = computeWeight(1, now, confidence);
  const result = db.execute(
    `INSERT INTO relationships (source_id, target_id, type, context, valid_from, valid_until, source_file,
       weight, confidence, extraction_method, last_seen, seen_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      rel.sourceId,
      rel.targetId,
      rel.type,
      rel.context ?? null,
      rel.validFrom ?? null,
      rel.validUntil ?? null,
      rel.sourceFile ?? null,
      weight,
      confidence,
      method,
      now,
      1,
    ],
  );

  const relId = result.lastInsertRowid;

  // Add first evidence
  if (rel.sourceFile) {
    addEvidence(db, relId, rel.sourceFile, rel.context, method);
  }

  return relId;
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

function addEvidence(
  db: IDatabase,
  relationshipId: number,
  sourceFile: string,
  context: string | undefined | null,
  extractionMethod: string,
): void {
  // Dedup evidence by relationship + source_file
  const existing = db.queryOne(
    'SELECT 1 FROM relationship_evidence WHERE relationship_id = ? AND source_file = ?',
    [relationshipId, sourceFile],
  );
  if (existing) return;

  db.execute(
    `INSERT INTO relationship_evidence (relationship_id, source_file, context, extracted_at, extraction_method)
     VALUES (?, ?, ?, ?, ?)`,
    [relationshipId, sourceFile, context ?? null, new Date().toISOString(), extractionMethod],
  );
}

export function getEvidence(db: IDatabase, relationshipId: number): RelationshipEvidence[] {
  const rows = db.queryAll<any>(
    'SELECT * FROM relationship_evidence WHERE relationship_id = ? ORDER BY extracted_at DESC',
    [relationshipId],
  );
  return rows.map(row => ({
    id: row.id,
    relationshipId: row.relationship_id,
    sourceFile: row.source_file,
    context: row.context,
    extractedAt: row.extracted_at,
    extractionMethod: row.extraction_method,
  }));
}

// ---------------------------------------------------------------------------
// Weight computation
// ---------------------------------------------------------------------------

/**
 * Compute relationship weight from frequency, recency, and confidence.
 * - recency: exponential decay with ~125-day half-life (lambda = 1/180)
 * - frequency: log2(seenCount + 1) for diminishing returns
 * - confidence: multiplier (0.0 - 1.0)
 */
export function computeWeight(seenCount: number, lastSeenDate: string, confidence: number): number {
  const now = Date.now();
  const lastSeen = new Date(lastSeenDate).getTime();
  const daysSince = Math.max(0, (now - lastSeen) / (1000 * 60 * 60 * 24));
  const recency = Math.exp(-daysSince / 180);
  const frequency = Math.log2(seenCount + 1);
  return confidence * recency * frequency;
}

/**
 * Recompute weights for all relationships (batch update).
 */
export function recomputeAllWeights(db: IDatabase): number {
  const rows = db.queryAll<{ id: number; seen_count: number; last_seen: string; confidence: number }>(
    'SELECT id, seen_count, last_seen, confidence FROM relationships WHERE last_seen IS NOT NULL',
  );
  let updated = 0;
  db.transaction(() => {
    for (const row of rows) {
      const weight = computeWeight(row.seen_count, row.last_seen, row.confidence);
      db.execute('UPDATE relationships SET weight = ? WHERE id = ?', [weight, row.id]);
      updated++;
    }
  });
  return updated;
}

// ---------------------------------------------------------------------------
// Deserialize
// ---------------------------------------------------------------------------

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
    weight: row.weight ?? 1.0,
    confidence: row.confidence ?? 1.0,
    extractionMethod: row.extraction_method ?? 'rule',
    lastSeen: row.last_seen ?? null,
    seenCount: row.seen_count ?? 1,
  };
}
