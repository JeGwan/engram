import type { IDatabase } from '../db/interface.js';
import { searchVectors, type VectorEntry } from '../embeddings/vector-store.js';

export interface HybridResult {
  path: string;
  title: string;
  snippet: string | null;
  heading: string | null;
  rrfScore: number;
  sources: 'fts' | 'vec' | 'both';
  ftsRank: number | null;
  vecRank: number | null;
}

export interface HybridFilterOptions {
  /** 디렉토리 필터 (e.g. "3-업무") */
  directory?: string;
  /** 태그 필터 */
  tag?: string;
  /** 이후 수정된 파일만 (Unix timestamp ms) */
  since?: number;
  /** 이전 수정된 파일만 (Unix timestamp ms) */
  until?: number;
}

/**
 * Reciprocal Rank Fusion (RRF) hybrid search.
 * Combines FTS5 keyword results and vector semantic results.
 *
 * rrf_score(doc) = Σ( 1 / (k + rank_in_list) )
 * + title exact-match boost: +1/k (≈ rank-0 contribution)
 */
export function hybridSearch(
  db: IDatabase,
  vectors: VectorEntry[],
  queryEmbedding: number[],
  query: string,
  limit = 10,
  k = 60,
  options: HybridFilterOptions = {},
): HybridResult[] {
  const candidate = limit * 3;
  const { directory, tag, since, until } = options;

  // ── FTS5 search ──
  let ftsSql = `
    SELECT f.path, f.title,
           snippet(files_fts, 1, '>>>', '<<<', '...', 40) as snippet
     FROM files_fts fts
     JOIN files f ON f.id = fts.rowid
     WHERE files_fts MATCH ?
  `;
  const ftsParams: unknown[] = [query];
  if (directory) { ftsSql += ' AND f.directory = ?'; ftsParams.push(directory); }
  if (tag) { ftsSql += ' AND f.tags LIKE ?'; ftsParams.push(`%${tag}%`); }
  if (since != null) { ftsSql += ' AND f.modified_at >= ?'; ftsParams.push(since); }
  if (until != null) { ftsSql += ' AND f.modified_at <= ?'; ftsParams.push(until); }
  ftsSql += ' ORDER BY rank LIMIT ?';
  ftsParams.push(candidate);

  const ftsRows = db.queryAll<{ path: string; title: string; snippet: string }>(ftsSql, ftsParams);

  // ── Vector search ──
  const vecResults = searchVectors(vectors, queryEmbedding, candidate);

  // Deduplicate vector results to file level (keep best score chunk per file)
  const bestVecByFile = new Map<number, { heading: string; score: number }>();
  for (const r of vecResults) {
    const existing = bestVecByFile.get(r.fileId);
    if (!existing || r.score > existing.score) {
      bestVecByFile.set(r.fileId, { heading: r.heading, score: r.score });
    }
  }

  // Resolve fileId → path/title (with filter support)
  interface FileInfo { path: string; title: string; directory: string; tags: string; modified_at: number }
  const vecFiles: Array<{ fileId: number; path: string; title: string; heading: string }> = [];
  for (const [fileId, { heading }] of bestVecByFile) {
    const file = db.queryOne<FileInfo>(
      'SELECT path, title, directory, tags, modified_at FROM files WHERE id = ?',
      [fileId],
    );
    if (!file) continue;
    if (directory && file.directory !== directory) continue;
    if (tag && !(file.tags ?? '').includes(tag)) continue;
    if (since != null && file.modified_at < since) continue;
    if (until != null && file.modified_at > until) continue;
    vecFiles.push({ fileId, path: file.path, title: file.title, heading });
  }

  // ── RRF accumulation ──
  interface Acc {
    path: string;
    title: string;
    snippet: string | null;
    heading: string | null;
    rrfScore: number;
    ftsRank: number | null;
    vecRank: number | null;
  }
  const acc = new Map<string, Acc>();

  ftsRows.forEach((row, idx) => {
    const rank = idx + 1;
    const score = 1 / (k + rank);
    const existing = acc.get(row.path);
    if (existing) {
      existing.rrfScore += score;
      existing.ftsRank = rank;
      if (!existing.snippet) existing.snippet = row.snippet ?? null;
    } else {
      acc.set(row.path, {
        path: row.path,
        title: row.title,
        snippet: row.snippet ?? null,
        heading: null,
        rrfScore: score,
        ftsRank: rank,
        vecRank: null,
      });
    }
  });

  vecFiles.forEach((row, idx) => {
    const rank = idx + 1;
    const score = 1 / (k + rank);
    const existing = acc.get(row.path);
    if (existing) {
      existing.rrfScore += score;
      existing.vecRank = rank;
      if (!existing.heading) existing.heading = row.heading || null;
    } else {
      acc.set(row.path, {
        path: row.path,
        title: row.title,
        snippet: null,
        heading: row.heading || null,
        rrfScore: score,
        ftsRank: null,
        vecRank: rank,
      });
    }
  });

  // ── Title exact-match boost ──
  const queryLower = query.toLowerCase();
  for (const entry of acc.values()) {
    if (entry.title.toLowerCase() === queryLower) {
      entry.rrfScore += 1 / k; // ≈ rank-0 contribution
    }
  }

  // ── Sort by RRF score, return top limit ──
  return Array.from(acc.values())
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, limit)
    .map(({ path, title, snippet, heading, rrfScore, ftsRank, vecRank }) => ({
      path,
      title,
      snippet,
      heading,
      rrfScore,
      ftsRank,
      vecRank,
      sources: (ftsRank !== null && vecRank !== null) ? 'both' : ftsRank !== null ? 'fts' : 'vec',
    })) as HybridResult[];
}
