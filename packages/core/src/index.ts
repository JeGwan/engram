// ─── Types ───
export type {
  ParsedNote,
  ScannedFile,
  IndexResult,
  EmbedResult,
  ExtractionResult,
  Entity,
  Relationship,
  RelationshipEvidence,
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
  recordEntityMention,
} from './graph/entity-store.js';
export {
  getRelationships,
  getAllRelationships,
  addRelationship,
  getEvidence,
  computeWeight,
  recomputeAllWeights,
} from './graph/relationship-store.js';
export { queryFacts, addFact } from './graph/fact-store.js';
export {
  seedEntities,
  runExtraction,
  extractFromNotes,
} from './graph/extractor.js';

export { runLlmExtraction, type LlmExtractionResult } from './graph/llm-extractor.js';

// ─── Temporal Analysis ───
export {
  relationshipTimeline,
  entityActivity,
  detectTrends,
  type TimelineEntry,
  type ActivityEntry,
  type TrendResult,
} from './graph/temporal.js';

// ─── Graph Analysis ───
export {
  loadGraph,
  findPath,
  getNeighborhood,
  degreeCentrality,
  betweennessCentrality,
  detectCommunities,
  getCommunities,
  entityImportance,
  graphStats,
  suggestConnections,
  type GraphData,
  type PathResult,
  type SubgraphResult,
  type CentralityResult,
  type ImportanceResult,
  type CommunityInfo,
  type GraphStats,
  type SuggestResult,
} from './graph/analysis.js';

// ─── Conversations ───
export {
  addConversation,
  searchConversations,
  type ConversationRecord,
  type ConversationRow,
  type SearchConversationsOptions,
} from './conversations/conversation-store.js';

// ─── Hybrid Search ───
export type { HybridResult, HybridFilterOptions } from './search/hybrid.js';
export { hybridSearch } from './search/hybrid.js';

// ─── Stats ───
export { getVaultStats } from './stats.js';
