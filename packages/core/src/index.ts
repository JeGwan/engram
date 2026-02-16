// ─── Types ───
export type {
  ParsedNote,
  ScannedFile,
  IndexResult,
  EmbedResult,
  ExtractionResult,
  Entity,
  Relationship,
  Fact,
  Chunk,
  VaultStats,
  SearchResult,
  SemanticResult,
} from './types.js';

// ─── DB Interface ───
export type {
  IDatabase,
  ExecuteResult,
  IDatabaseLifecycle,
  IVaultReader,
} from './db/interface.js';

// ─── DB Schema ───
export { initSchema } from './db/schema.js';

// ─── Indexer ───
export { indexFiles, removeFile, renameFile, deleteStaleFiles } from './indexer/indexer.js';

// ─── Embeddings ───
export { chunkMarkdown } from './embeddings/chunker.js';
export { embed, isOllamaRunning } from './embeddings/ollama-client.js';
export {
  loadVectors,
  searchVectors,
  findSimilarByFile,
  storeEmbedding,
  blobToFloat64Array,
  type VectorEntry,
} from './embeddings/vector-store.js';
export { runEmbedIndex } from './embeddings/embed-indexer.js';

// ─── Graph ───
export {
  getEntity,
  getAllEntities,
  searchEntities,
  upsertEntity,
  findEntityByName,
} from './graph/entity-store.js';
export {
  getRelationships,
  getAllRelationships,
  addRelationship,
} from './graph/relationship-store.js';
export { queryFacts, addFact } from './graph/fact-store.js';
export {
  seedEntities,
  runExtraction,
  extractFromNotes,
} from './graph/extractor.js';

// ─── Stats ───
export { getVaultStats } from './stats.js';
