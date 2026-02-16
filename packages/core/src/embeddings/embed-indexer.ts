import type { IDatabase } from '../db/interface.js';
import type { EmbedResult } from '../types.js';
import { embed, isOllamaRunning } from './ollama-client.js';
import { chunkMarkdown } from './chunker.js';
import { storeEmbedding, loadVectors, type VectorEntry } from './vector-store.js';

export async function runEmbedIndex(
  db: IDatabase,
  ollamaUrl: string,
  ollamaModel: string,
  force = false,
  onProgress?: (pct: number, msg: string) => void,
): Promise<{ result: EmbedResult; vectors: VectorEntry[] }> {
  const start = Date.now();

  if (!(await isOllamaRunning(ollamaUrl))) {
    throw new Error('Ollama is not running. Start with: brew services start ollama');
  }

  // Get files to embed
  let files: Array<{ id: number; path: string; content: string }>;
  if (force) {
    files = db.queryAll('SELECT id, path, content FROM files');
  } else {
    files = db.queryAll(
      `SELECT id, path, content FROM files
       WHERE embedded_at IS NULL OR indexed_at > embedded_at`,
    );
  }

  let embedded = 0;
  let skipped = 0;
  let errors = 0;
  const total = files.length;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    try {
      const chunks = chunkMarkdown(file.content);
      if (chunks.length === 0) {
        skipped++;
        continue;
      }

      if (force) {
        db.execute('DELETE FROM embeddings WHERE file_id = ?', [file.id]);
      }

      for (const chunk of chunks) {
        const vector = await embed(chunk.text, ollamaUrl, ollamaModel);
        storeEmbedding(db, file.id, chunk.index, chunk.text, chunk.heading, vector);
      }

      db.execute('UPDATE files SET embedded_at = ? WHERE id = ?', [Date.now(), file.id]);
      embedded++;

      const pct = Math.round(((i + 1) / total) * 100);
      onProgress?.(pct, `${i + 1}/${total} ${file.path}`);
    } catch (err) {
      errors++;
      onProgress?.(-1, `Error: ${file.path}: ${err}`);
    }
  }

  const vectors = loadVectors(db);

  return {
    result: { embedded, skipped, errors, durationMs: Date.now() - start },
    vectors,
  };
}
