import type { IDatabase } from '../db/interface.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TimelineEntry {
  date: string;
  sourceFile: string;
  context: string | null;
  extractionMethod: string;
}

export interface ActivityEntry {
  period: string;
  mentionCount: number;
  newRelationships: number;
  factsRecorded: number;
}

export interface TrendResult {
  emerging: { entityId: string; name: string; type: string; recentActivity: number; previousActivity: number; acceleration: number }[];
  fading: { entityId: string; name: string; type: string; recentActivity: number; previousActivity: number; deceleration: number }[];
  stable: { entityId: string; name: string; type: string; activity: number }[];
}

// ---------------------------------------------------------------------------
// Relationship timeline
// ---------------------------------------------------------------------------

/**
 * Get the timeline of evidence for a specific relationship between two entities.
 */
export function relationshipTimeline(
  db: IDatabase,
  sourceId: string,
  targetId: string,
): TimelineEntry[] {
  // Find the relationship(s) between these two entities
  const rels = db.queryAll<{ id: number }>(
    `SELECT id FROM relationships
     WHERE (source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?)`,
    [sourceId, targetId, targetId, sourceId],
  );

  if (rels.length === 0) return [];

  const relIds = rels.map(r => r.id);
  const placeholders = relIds.map(() => '?').join(',');

  const rows = db.queryAll<{
    source_file: string;
    context: string | null;
    extracted_at: string;
    extraction_method: string;
  }>(
    `SELECT source_file, context, extracted_at, extraction_method
     FROM relationship_evidence
     WHERE relationship_id IN (${placeholders})
     ORDER BY extracted_at ASC`,
    relIds,
  );

  return rows.map(r => ({
    date: r.extracted_at?.slice(0, 10) ?? '',
    sourceFile: r.source_file,
    context: r.context,
    extractionMethod: r.extraction_method,
  }));
}

// ---------------------------------------------------------------------------
// Entity activity over time
// ---------------------------------------------------------------------------

/**
 * Get activity timeline for a specific entity, grouped by period.
 */
export function entityActivity(
  db: IDatabase,
  entityId: string,
  granularity: 'day' | 'week' | 'month' = 'month',
): ActivityEntry[] {
  // Mentions from facts
  const dateFormat = granularity === 'day'
    ? "substr(recorded_at, 1, 10)"
    : granularity === 'week'
      ? "substr(recorded_at, 1, 4) || '-W' || printf('%02d', cast((julianday(recorded_at) - julianday(substr(recorded_at, 1, 4) || '-01-01')) / 7 + 1 as integer))"
      : "substr(recorded_at, 1, 7)";

  const mentionRows = db.queryAll<{ period: string; cnt: number }>(
    `SELECT ${dateFormat} as period, COUNT(*) as cnt
     FROM facts
     WHERE entity_ids LIKE ? AND recorded_at IS NOT NULL
     GROUP BY period
     ORDER BY period ASC`,
    [`%${entityId}%`],
  );

  // Relationships created (from evidence)
  const relDateFormat = granularity === 'day'
    ? "substr(extracted_at, 1, 10)"
    : granularity === 'week'
      ? "substr(extracted_at, 1, 4) || '-W' || printf('%02d', cast((julianday(extracted_at) - julianday(substr(extracted_at, 1, 4) || '-01-01')) / 7 + 1 as integer))"
      : "substr(extracted_at, 1, 7)";

  const relRows = db.queryAll<{ period: string; cnt: number }>(
    `SELECT ${relDateFormat} as period, COUNT(*) as cnt
     FROM relationship_evidence re
     JOIN relationships r ON re.relationship_id = r.id
     WHERE (r.source_id = ? OR r.target_id = ?) AND re.extracted_at IS NOT NULL
     GROUP BY period
     ORDER BY period ASC`,
    [entityId, entityId],
  );

  // Merge into activity entries
  const periodMap = new Map<string, ActivityEntry>();
  for (const row of mentionRows) {
    if (!row.period) continue;
    periodMap.set(row.period, {
      period: row.period,
      mentionCount: row.cnt,
      newRelationships: 0,
      factsRecorded: row.cnt,
    });
  }
  for (const row of relRows) {
    if (!row.period) continue;
    const existing = periodMap.get(row.period);
    if (existing) {
      existing.newRelationships = row.cnt;
    } else {
      periodMap.set(row.period, {
        period: row.period,
        mentionCount: 0,
        newRelationships: row.cnt,
        factsRecorded: 0,
      });
    }
  }

  return [...periodMap.values()].sort((a, b) => a.period.localeCompare(b.period));
}

// ---------------------------------------------------------------------------
// Trend detection
// ---------------------------------------------------------------------------

/**
 * Detect emerging, fading, and stable entities by comparing recent vs previous activity.
 */
export function detectTrends(
  db: IDatabase,
  windowDays: number = 30,
): TrendResult {
  // Count facts per entity in recent window vs previous window
  const recentFacts = db.queryAll<{ entity_id: string; cnt: number }>(
    `SELECT value as entity_id, COUNT(*) as cnt
     FROM facts, json_each(facts.entity_ids)
     WHERE recorded_at >= date('now', '-' || ? || ' days')
     GROUP BY value`,
    [windowDays],
  );

  const previousFacts = db.queryAll<{ entity_id: string; cnt: number }>(
    `SELECT value as entity_id, COUNT(*) as cnt
     FROM facts, json_each(facts.entity_ids)
     WHERE recorded_at >= date('now', '-' || ? || ' days')
       AND recorded_at < date('now', '-' || ? || ' days')
     GROUP BY value`,
    [windowDays * 2, windowDays],
  );

  const recentMap = new Map(recentFacts.map(r => [r.entity_id, r.cnt]));
  const previousMap = new Map(previousFacts.map(r => [r.entity_id, r.cnt]));

  // Get all entity info
  const entities = db.queryAll<{ id: string; name: string; type: string }>(
    'SELECT id, name, type FROM entities',
  );
  const entityMap = new Map(entities.map(e => [e.id, e]));

  const emerging: TrendResult['emerging'] = [];
  const fading: TrendResult['fading'] = [];
  const stable: TrendResult['stable'] = [];

  // All entity IDs with any activity
  const allIds = new Set([...recentMap.keys(), ...previousMap.keys()]);

  for (const id of allIds) {
    const entity = entityMap.get(id);
    if (!entity) continue;

    const recent = recentMap.get(id) ?? 0;
    const previous = previousMap.get(id) ?? 0;

    if (recent > 0 && previous === 0) {
      // Brand new or re-emerged
      emerging.push({
        entityId: id, name: entity.name, type: entity.type,
        recentActivity: recent, previousActivity: previous,
        acceleration: recent,
      });
    } else if (recent > previous * 1.5 && recent >= 3) {
      // Significantly more active
      emerging.push({
        entityId: id, name: entity.name, type: entity.type,
        recentActivity: recent, previousActivity: previous,
        acceleration: previous > 0 ? recent / previous : recent,
      });
    } else if (previous > 0 && recent < previous * 0.5) {
      // Significantly less active
      fading.push({
        entityId: id, name: entity.name, type: entity.type,
        recentActivity: recent, previousActivity: previous,
        deceleration: recent > 0 ? previous / recent : previous,
      });
    } else if (recent > 0 || previous > 0) {
      stable.push({
        entityId: id, name: entity.name, type: entity.type,
        activity: recent + previous,
      });
    }
  }

  // Sort by significance
  emerging.sort((a, b) => b.acceleration - a.acceleration);
  fading.sort((a, b) => b.deceleration - a.deceleration);
  stable.sort((a, b) => b.activity - a.activity);

  return { emerging, fading, stable };
}
