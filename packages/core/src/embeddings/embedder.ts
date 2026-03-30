/**
 * Embedder interface — abstracts embedding provider (Ollama, node-llama-cpp, etc.)
 */
export interface IEmbedder {
  /** Generate embedding vector for a text chunk */
  embed(text: string): Promise<number[]>;
  /** Check if the embedding backend is ready */
  isReady(): Promise<boolean>;
}
