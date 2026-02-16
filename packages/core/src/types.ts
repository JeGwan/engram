// ─── Shared types ───

export interface ParsedNote {
  title: string;
  content: string;
  tags: string[];
  frontmatter: Record<string, unknown>;
  wikiLinks: string[];
}

export interface ScannedFile {
  path: string;         // relative path from vault root
  modifiedAt: number;   // mtime in ms
}

export interface IndexResult {
  indexed: number;
  skipped: number;
  deleted: number;
  durationMs: number;
}

export interface EmbedResult {
  embedded: number;
  skipped: number;
  errors: number;
  durationMs: number;
}

export interface ExtractionResult {
  entitiesDiscovered: number;
  relationships: number;
  facts: number;
  filesProcessed: number;
  durationMs: number;
}

export interface Entity {
  id: string;
  type: string;
  name: string;
  aliases: string[];
  metadata: Record<string, unknown>;
  sourcePath: string | null;
}

export interface Relationship {
  id: number;
  sourceId: string;
  targetId: string;
  type: string;
  context: string | null;
  validFrom: string | null;
  validUntil: string | null;
  sourceFile: string | null;
}

export interface Fact {
  id: number;
  type: string;
  content: string;
  entityIds: string[];
  recordedAt: string | null;
  validUntil: string | null;
  sourceFile: string | null;
}

export interface Chunk {
  index: number;
  text: string;
  heading: string;
}

export interface VaultStats {
  files: number;
  embeddings: number;
  entities: number;
  relationships: number;
  facts: number;
  directories: { name: string; count: number }[];
  entityTypes: { type: string; count: number }[];
}

export interface SearchResult {
  path: string;
  title: string;
  directory: string;
  tags: string;
  modifiedAt: number;
  snippet: string;
}

export interface SemanticResult {
  path: string;
  title: string;
  heading: string;
  score: number;
  chunkText: string;
}
