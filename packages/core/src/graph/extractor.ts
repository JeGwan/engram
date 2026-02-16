import type { IDatabase, IVaultReader } from '../db/interface.js';
import type { Entity, ExtractionResult } from '../types.js';
import { upsertEntity, getAllEntities, findEntityByName } from './entity-store.js';
import { addRelationship } from './relationship-store.js';
import { addFact } from './fact-store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FileRow {
  path: string;
  title: string;
  content: string;
  wiki_links: string | null;
  frontmatter: string | null;
  modified_at: number;
  graph_extracted_at: number | null;
}

interface FrontmatterMapping {
  property: string;
  relationshipType: string;
  targetEntityType: string;
  isArray: boolean;
}

const FRONTMATTER_MAPPINGS: FrontmatterMapping[] = [
  { property: '소속', relationshipType: 'belongs-to', targetEntityType: 'organization', isArray: false },
  { property: 'organization', relationshipType: 'belongs-to', targetEntityType: 'organization', isArray: false },
  { property: 'team', relationshipType: 'belongs-to', targetEntityType: 'organization', isArray: false },
  { property: 'project', relationshipType: 'related-to', targetEntityType: 'project', isArray: false },
  { property: 'attendees', relationshipType: 'attended', targetEntityType: 'person', isArray: true },
];

const EXCLUDE_NAMES = new Set(['나', 'user', 'i', 'me']);

// ---------------------------------------------------------------------------
// Phase A: Folder-based seeding
// ---------------------------------------------------------------------------

export async function seedEntities(
  db: IDatabase,
  vault: IVaultReader,
  peopleDir: string | null,
): Promise<{ peopleSeeded: number }> {
  let peopleSeeded = 0;
  if (peopleDir) {
    peopleSeeded = await seedFromPeopleDir(db, vault, peopleDir);
  }
  return { peopleSeeded };
}

async function seedFromPeopleDir(
  db: IDatabase,
  vault: IVaultReader,
  relativePeopleDir: string,
): Promise<number> {
  if (!vault.directoryExists(relativePeopleDir)) return 0;

  const existingEntities = getAllEntities(db);
  const existingNames = new Set(existingEntities.map(e => e.name));
  const existingIds = new Set(existingEntities.map(e => e.id));

  let seeded = 0;
  const subdirs = vault.listSubdirectories(relativePeopleDir);

  for (const name of subdirs) {
    const id = name;
    if (existingIds.has(id) || existingNames.has(name)) continue;

    const summaryPath = `${relativePeopleDir}/${name}/요약.md`;
    let metadata: Record<string, unknown> = {};
    const raw = await vault.readFileIfExists(summaryPath);
    if (raw) {
      const parsed = vault.parseMetadata(summaryPath, raw);
      metadata = parsed.frontmatter;
    }

    upsertEntity(db, {
      id,
      type: 'person',
      name,
      aliases: [],
      metadata,
      sourcePath: `${relativePeopleDir}/${name}/요약.md`,
    });
    seeded++;
  }

  return seeded;
}

// ---------------------------------------------------------------------------
// Main extraction pipeline
// ---------------------------------------------------------------------------

export function runExtraction(
  db: IDatabase,
  peopleDir: string | null,
  opts?: { force?: boolean; limit?: number },
): ExtractionResult {
  const start = Date.now();

  const query = opts?.force
    ? 'SELECT path, title, content, wiki_links, frontmatter, modified_at, graph_extracted_at FROM files'
    : 'SELECT path, title, content, wiki_links, frontmatter, modified_at, graph_extracted_at FROM files WHERE graph_extracted_at IS NULL OR graph_extracted_at < modified_at';

  let files = db.queryAll<FileRow>(query);
  if (opts?.limit) files = files.slice(0, opts.limit);
  if (files.length === 0) {
    return { entitiesDiscovered: 0, relationships: 0, facts: 0, filesProcessed: 0, durationMs: Date.now() - start };
  }

  let entitiesDiscovered = 0;
  let relationships = 0;
  let facts = 0;

  // Phase C-1: Create organization entities from person metadata
  const orgResult = extractOrgsFromPersonMetadata(db);
  entitiesDiscovered += orgResult.entities;
  relationships += orgResult.relationships;

  // Build entity name map for co-mention fallback
  const entityNames = buildEntityNameMap(db);

  // Per-file extraction
  for (const file of files) {
    const fileEntities = new Map<string, Entity>();

    // Phase B: Resolve wiki-links to entities
    const wikiLinks: string[] = safeJsonParse(file.wiki_links, []);
    for (const link of wikiLinks) {
      const entity = resolveWikiLink(db, link);
      if (entity && !EXCLUDE_NAMES.has(entity.name.toLowerCase())) {
        fileEntities.set(entity.id, entity);
      }
    }

    // Co-mention fallback
    const contentLower = file.content.toLowerCase();
    for (const [name, entity] of entityNames) {
      if (EXCLUDE_NAMES.has(name)) continue;
      if (fileEntities.has(entity.id)) continue;
      if (contentLower.includes(name)) {
        fileEntities.set(entity.id, entity);
      }
    }

    const unique = [...fileEntities.values()];

    // Create co-mentioned relationships
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        try {
          addRelationship(db, {
            sourceId: unique[i].id,
            targetId: unique[j].id,
            type: 'co-mentioned',
            context: file.path,
            sourceFile: file.path,
          });
          relationships++;
        } catch { /* duplicate */ }
      }
    }

    // Create mention fact
    if (unique.length > 0) {
      const recordedAt = extractDate(file.path, file.modified_at);
      const title = basename(file.path);
      addFact(db, {
        type: 'mention',
        content: title,
        entityIds: unique.map(e => e.id),
        recordedAt,
        sourceFile: file.path,
      });
      facts++;
    }

    // Phase C-2: Frontmatter relationships
    const fmResult = extractFileFrontmatter(db, file, peopleDir);
    entitiesDiscovered += fmResult.entities;
    relationships += fmResult.relationships;
    facts += fmResult.facts;
  }

  // Mark files as extracted
  const now = Date.now();
  db.transaction(() => {
    for (const f of files) {
      db.execute('UPDATE files SET graph_extracted_at = ? WHERE path = ?', [now, f.path]);
    }
  });

  return {
    entitiesDiscovered,
    relationships,
    facts,
    filesProcessed: files.length,
    durationMs: Date.now() - start,
  };
}

// ---------------------------------------------------------------------------
// Phase B helpers
// ---------------------------------------------------------------------------

function resolveWikiLink(db: IDatabase, link: string): Entity | null {
  const entity = findEntityByName(db, link);
  if (entity) return entity;

  const segments = link.split('/');
  if (segments.length > 1) {
    for (let i = segments.length - 1; i >= 0; i--) {
      const found = findEntityByName(db, segments[i]);
      if (found) return found;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Phase C-1: Organization entities from person metadata
// ---------------------------------------------------------------------------

function extractOrgsFromPersonMetadata(db: IDatabase): { entities: number; relationships: number } {
  let entities = 0;
  let rels = 0;

  const orgMappings = FRONTMATTER_MAPPINGS.filter(m => m.targetEntityType === 'organization');
  const personEntities = getAllEntities(db).filter(e => e.type === 'person');

  for (const person of personEntities) {
    for (const mapping of orgMappings) {
      const value = person.metadata[mapping.property];
      if (!value || typeof value !== 'string') continue;
      const orgName = value.trim();
      if (!orgName) continue;

      let orgEntity = findEntityByName(db, orgName);
      if (!orgEntity) {
        upsertEntity(db, {
          id: orgName,
          type: 'organization',
          name: orgName,
          aliases: [],
        });
        orgEntity = findEntityByName(db, orgName);
        if (orgEntity) entities++;
      }

      if (orgEntity) {
        try {
          addRelationship(db, {
            sourceId: person.id,
            targetId: orgEntity.id,
            type: mapping.relationshipType,
            sourceFile: person.sourcePath ?? undefined,
          });
          rels++;
        } catch { /* duplicate */ }
      }
    }
  }

  return { entities, relationships: rels };
}

// ---------------------------------------------------------------------------
// Phase C-2: Per-file frontmatter relationships
// ---------------------------------------------------------------------------

function extractFileFrontmatter(
  db: IDatabase,
  file: FileRow,
  peopleDir: string | null,
): { entities: number; relationships: number; facts: number } {
  let entities = 0;
  let rels = 0;
  let facts = 0;

  const fm: Record<string, unknown> = safeJsonParse(file.frontmatter, {});
  if (!fm || Object.keys(fm).length === 0) return { entities: 0, relationships: 0, facts: 0 };

  for (const mapping of FRONTMATTER_MAPPINGS) {
    const raw = fm[mapping.property];
    if (raw == null) continue;

    const values: string[] = mapping.isArray
      ? (Array.isArray(raw) ? raw.map(String) : [String(raw)])
      : [String(raw)];

    const resolvedEntities: Entity[] = [];

    for (const val of values) {
      const name = val.trim();
      if (!name || EXCLUDE_NAMES.has(name.toLowerCase())) continue;

      let targetEntity = findEntityByName(db, name);

      if (!targetEntity && mapping.targetEntityType !== 'person') {
        upsertEntity(db, {
          id: name,
          type: mapping.targetEntityType,
          name,
          aliases: [],
        });
        targetEntity = findEntityByName(db, name);
        if (targetEntity) entities++;
      }

      if (targetEntity) resolvedEntities.push(targetEntity);
    }

    if (resolvedEntities.length === 0) continue;

    if (mapping.relationshipType === 'attended') {
      const recordedAt = extractDate(file.path, file.modified_at);
      addFact(db, {
        type: 'attended',
        content: basename(file.path),
        entityIds: resolvedEntities.map(e => e.id),
        recordedAt,
        sourceFile: file.path,
      });
      facts++;
    } else {
      const ownerEntity = findFileOwnerEntity(db, file.path, peopleDir);
      if (ownerEntity) {
        for (const target of resolvedEntities) {
          if (ownerEntity.id === target.id) continue;
          try {
            addRelationship(db, {
              sourceId: ownerEntity.id,
              targetId: target.id,
              type: mapping.relationshipType,
              sourceFile: file.path,
            });
            rels++;
          } catch { /* duplicate */ }
        }
      }
    }
  }

  return { entities, relationships: rels, facts };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildEntityNameMap(db: IDatabase): Map<string, Entity> {
  const entities = getAllEntities(db);
  const map = new Map<string, Entity>();
  for (const e of entities) {
    map.set(e.name.toLowerCase(), e);
    for (const alias of e.aliases) {
      map.set(alias.toLowerCase(), e);
    }
  }
  return map;
}

function findFileOwnerEntity(db: IDatabase, filePath: string, peopleDir: string | null): Entity | null {
  if (!peopleDir || !filePath.startsWith(peopleDir + '/')) return null;
  const relative = filePath.slice(peopleDir.length + 1);
  const personName = relative.split('/')[0];
  if (!personName) return null;
  return findEntityByName(db, personName);
}

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

/** Extract filename without extension from a path (no path module dependency). */
function basename(filePath: string): string {
  const parts = filePath.split('/');
  const file = parts[parts.length - 1] ?? filePath;
  return file.replace(/\.md$/, '');
}

function safeJsonParse<T>(str: string | null, fallback: T): T {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

// Backward compatibility
export function extractFromNotes(db: IDatabase, peopleDir: string | null, limit?: number) {
  return runExtraction(db, peopleDir, { limit });
}
