import { embed, isOllamaRunning, searchVectors } from '@engram/core';
import type { RouteContext } from '../server.js';

export function handleSearch(ctx: RouteContext) {
  const q = ctx.url.searchParams.get('q');
  if (!q) return { error: 'Missing q parameter', results: [] };

  const directory = ctx.url.searchParams.get('directory');
  const tag = ctx.url.searchParams.get('tag');
  const limit = parseInt(ctx.url.searchParams.get('limit') ?? '20', 10);

  let sql = `
    SELECT f.path, f.title, f.directory, f.tags, f.modified_at as modifiedAt,
           snippet(files_fts, 1, '<mark>', '</mark>', '...', 40) as snippet
    FROM files_fts fts
    JOIN files f ON f.id = fts.rowid
    WHERE files_fts MATCH ?
  `;
  const params: unknown[] = [q];

  if (directory) {
    sql += ' AND f.directory = ?';
    params.push(directory);
  }
  if (tag) {
    sql += ' AND f.tags LIKE ?';
    params.push(`%${tag}%`);
  }

  sql += ' ORDER BY rank LIMIT ?';
  params.push(limit);

  const results = ctx.db.queryAll(sql, params);
  return { query: q, results };
}

export async function handleSemanticSearch(ctx: RouteContext) {
  const q = ctx.url.searchParams.get('q');
  if (!q) return { error: 'Missing q parameter', results: [] };

  const running = await isOllamaRunning(ctx.ollamaUrl);
  if (!running) {
    return { error: 'Ollama is not running. Start it with: ollama serve', results: [] };
  }

  const limit = parseInt(ctx.url.searchParams.get('limit') ?? '10', 10);

  const queryVec = await embed(q, ctx.ollamaUrl, ctx.ollamaModel);
  const vectorResults = searchVectors(ctx.vectors, queryVec, limit);

  const results = vectorResults.map(v => {
    const file = ctx.db.queryOne<{ path: string; title: string }>(
      'SELECT path, title FROM files WHERE id = ?',
      [v.fileId],
    );
    const chunk = ctx.db.queryOne<{ chunk_text: string }>(
      'SELECT chunk_text FROM embeddings WHERE id = ?',
      [v.id],
    );
    return {
      path: file?.path ?? '',
      title: file?.title ?? '',
      heading: v.heading,
      score: Math.round(v.score * 1000) / 1000,
      chunkText: chunk?.chunk_text ?? '',
    };
  });

  return { query: q, results };
}
