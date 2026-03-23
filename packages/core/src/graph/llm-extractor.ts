import type { IDatabase } from '../db/interface.js';
import type { Entity } from '../types.js';
import { getAllEntities, findEntityByName, upsertEntity } from './entity-store.js';
import { addRelationship } from './relationship-store.js';
import { addFact } from './fact-store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LlmExtractionResult {
  filesProcessed: number;
  relationshipsCreated: number;
  entitiesDiscovered: number;
  factsCreated: number;
  errors: number;
  durationMs: number;
}

interface LlmRelationship {
  source: string;
  target: string;
  type: string;
  confidence: number;
  context: string;
}

interface LlmEntity {
  name: string;
  type: string;
}

interface LlmResponse {
  relationships: LlmRelationship[];
  newEntities: LlmEntity[];
}

interface FileRow {
  path: string;
  title: string;
  content: string;
  wiki_links: string | null;
  modified_at: number;
  graph_extracted_at: number | null;
  llm_extracted_at: number | null;
}

// Valid LLM-extracted relationship types
const LLM_RELATIONSHIP_TYPES = new Set([
  'influences', 'caused', 'decided', 'depends-on', 'opposes',
  'supports', 'manages', 'mentors', 'collaborates', 'questions',
  // Also allow existing types
  'co-mentioned', 'belongs-to', 'related-to', 'attended',
]);

// Valid LLM-discovered entity types
const LLM_ENTITY_TYPES = new Set([
  'concept', 'technology', 'tool', 'decision',
  // Also allow existing types
  'person', 'organization', 'project', 'team', 'topic', 'event',
]);

// ---------------------------------------------------------------------------
// Ollama generate
// ---------------------------------------------------------------------------

async function ollamaGenerate(
  prompt: string,
  ollamaUrl: string,
  model: string,
): Promise<string> {
  const res = await fetch(`${ollamaUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      options: { temperature: 0.1, num_predict: 2048 },
    }),
  });

  if (!res.ok) {
    throw new Error(`Ollama generate failed: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as { response: string };
  return data.response;
}

// ---------------------------------------------------------------------------
// Build extraction prompt
// ---------------------------------------------------------------------------

function buildPrompt(content: string, knownEntities: Entity[]): string {
  const entityList = knownEntities
    .map(e => `- ${e.name} [${e.type}]`)
    .join('\n');

  return `You are analyzing a note from a personal knowledge vault. Extract relationships between entities.

## Known entities mentioned in this note:
${entityList}

## Note content:
${content.slice(0, 3000)}

## Instructions:
1. Find relationships between the known entities listed above.
2. For each relationship, identify:
   - source: entity name (must match exactly from the list above or be a new entity)
   - target: entity name
   - type: one of [influences, caused, decided, depends-on, opposes, supports, manages, mentors, collaborates, questions]
   - confidence: 0.0 to 1.0 (how certain you are)
   - context: one sentence explaining the relationship
3. Also identify NEW entities (concepts, technologies, tools, decisions) mentioned but NOT in the known list.
   - Only include entities that are specific and meaningful (not generic words).
   - type: one of [concept, technology, tool, decision]

## Output format (JSON only, no markdown):
{"relationships":[{"source":"Name","target":"Name","type":"type","confidence":0.8,"context":"explanation"}],"newEntities":[{"name":"Name","type":"type"}]}

If no relationships or entities found, return: {"relationships":[],"newEntities":[]}
JSON output only:`;
}

// ---------------------------------------------------------------------------
// Parse LLM response
// ---------------------------------------------------------------------------

function parseLlmResponse(raw: string): LlmResponse {
  // Try to extract JSON from the response
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { relationships: [], newEntities: [] };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const relationships: LlmRelationship[] = [];
    const newEntities: LlmEntity[] = [];

    if (Array.isArray(parsed.relationships)) {
      for (const r of parsed.relationships) {
        if (
          typeof r.source === 'string' &&
          typeof r.target === 'string' &&
          typeof r.type === 'string' &&
          LLM_RELATIONSHIP_TYPES.has(r.type)
        ) {
          relationships.push({
            source: r.source,
            target: r.target,
            type: r.type,
            confidence: typeof r.confidence === 'number' ? Math.min(1, Math.max(0, r.confidence)) : 0.5,
            context: typeof r.context === 'string' ? r.context.slice(0, 200) : '',
          });
        }
      }
    }

    if (Array.isArray(parsed.newEntities)) {
      for (const e of parsed.newEntities) {
        if (
          typeof e.name === 'string' &&
          typeof e.type === 'string' &&
          LLM_ENTITY_TYPES.has(e.type) &&
          e.name.length >= 2
        ) {
          newEntities.push({ name: e.name, type: e.type });
        }
      }
    }

    return { relationships, newEntities };
  } catch {
    return { relationships: [], newEntities: [] };
  }
}

// ---------------------------------------------------------------------------
// Main LLM extraction pipeline
// ---------------------------------------------------------------------------

export async function runLlmExtraction(
  db: IDatabase,
  ollamaUrl: string,
  model: string,
  opts?: { force?: boolean; limit?: number },
): Promise<LlmExtractionResult> {
  const start = Date.now();

  // Only process files that already have graph extraction done (have entities)
  const query = opts?.force
    ? `SELECT path, title, content, wiki_links, modified_at, graph_extracted_at, llm_extracted_at
       FROM files WHERE graph_extracted_at IS NOT NULL`
    : `SELECT path, title, content, wiki_links, modified_at, graph_extracted_at, llm_extracted_at
       FROM files WHERE graph_extracted_at IS NOT NULL
       AND (llm_extracted_at IS NULL OR llm_extracted_at < modified_at)`;

  let files = db.queryAll<FileRow>(query);
  if (opts?.limit) files = files.slice(0, opts.limit);

  if (files.length === 0) {
    return { filesProcessed: 0, relationshipsCreated: 0, entitiesDiscovered: 0, factsCreated: 0, errors: 0, durationMs: Date.now() - start };
  }

  let relationshipsCreated = 0;
  let entitiesDiscovered = 0;
  let factsCreated = 0;
  let errors = 0;

  // Build entity lookup
  const allEntities = getAllEntities(db);
  const entityByName = new Map<string, Entity>();
  for (const e of allEntities) {
    entityByName.set(e.name.toLowerCase(), e);
    for (const alias of e.aliases) {
      entityByName.set(alias.toLowerCase(), e);
    }
  }

  for (const file of files) {
    try {
      // Find which entities are mentioned in this file
      const contentLower = file.content.toLowerCase();
      const mentionedEntities: Entity[] = [];
      for (const [name, entity] of entityByName) {
        if (contentLower.includes(name) && !mentionedEntities.some(e => e.id === entity.id)) {
          mentionedEntities.push(entity);
        }
      }

      // Skip files with too few entities (not interesting for LLM)
      if (mentionedEntities.length < 2) {
        db.execute('UPDATE files SET llm_extracted_at = ? WHERE path = ?', [Date.now(), file.path]);
        continue;
      }

      // Call LLM
      const prompt = buildPrompt(file.content, mentionedEntities);
      const raw = await ollamaGenerate(prompt, ollamaUrl, model);
      const result = parseLlmResponse(raw);

      // Create new entities
      for (const newEntity of result.newEntities) {
        const existing = findEntityByName(db, newEntity.name);
        if (!existing) {
          upsertEntity(db, {
            id: newEntity.name,
            type: newEntity.type,
            name: newEntity.name,
            sourcePath: file.path,
          });
          entitiesDiscovered++;
        }
      }

      // Create relationships
      for (const rel of result.relationships) {
        const sourceEntity = findEntityByName(db, rel.source);
        const targetEntity = findEntityByName(db, rel.target);
        if (!sourceEntity || !targetEntity) continue;
        if (sourceEntity.id === targetEntity.id) continue;

        try {
          addRelationship(db, {
            sourceId: sourceEntity.id,
            targetId: targetEntity.id,
            type: rel.type,
            context: rel.context,
            sourceFile: file.path,
            confidence: rel.confidence,
            extractionMethod: 'llm',
          });
          relationshipsCreated++;
        } catch { /* entity not found or other error */ }
      }

      // Create a fact for LLM extraction event
      if (result.relationships.length > 0) {
        const recordedAt = extractDate(file.path, file.modified_at);
        addFact(db, {
          type: 'llm-extraction',
          content: `LLM extracted ${result.relationships.length} relationships from ${basename(file.path)}`,
          entityIds: [...new Set(result.relationships.flatMap(r => {
            const s = findEntityByName(db, r.source);
            const t = findEntityByName(db, r.target);
            return [s?.id, t?.id].filter(Boolean) as string[];
          }))],
          recordedAt,
          sourceFile: file.path,
        });
        factsCreated++;
      }

      // Mark file as LLM-extracted
      db.execute('UPDATE files SET llm_extracted_at = ? WHERE path = ?', [Date.now(), file.path]);

    } catch (err) {
      errors++;
      // Mark as extracted anyway to avoid retrying on transient errors
      db.execute('UPDATE files SET llm_extracted_at = ? WHERE path = ?', [Date.now(), file.path]);
    }
  }

  return {
    filesProcessed: files.length,
    relationshipsCreated,
    entitiesDiscovered,
    factsCreated,
    errors,
    durationMs: Date.now() - start,
  };
}

// ---------------------------------------------------------------------------
// Helpers (duplicated from extractor to avoid circular deps)
// ---------------------------------------------------------------------------

function extractDate(filePath: string, modifiedAt: number): string {
  const isoMatch = filePath.match(/(\d{4}-\d{2}-\d{2})/);
  const dotMatch = filePath.match(/(\d{2})\.(\d{2})\.(\d{2})/);
  if (isoMatch) return isoMatch[1];
  if (dotMatch) {
    const yy = parseInt(dotMatch[1], 10);
    const century = yy >= 90 ? '19' : '20';
    return `${century}${dotMatch[1]}-${dotMatch[2]}-${dotMatch[3]}`;
  }
  return new Date(modifiedAt).toISOString().slice(0, 10);
}

function basename(filePath: string): string {
  const parts = filePath.split('/');
  const file = parts[parts.length - 1] ?? filePath;
  return file.replace(/\.md$/, '');
}
