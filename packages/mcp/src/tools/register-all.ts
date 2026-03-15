import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  type IDatabase,
  type IVaultReader,
  type VectorEntry,
  getVaultStats,
  searchEntities,
  getEntity,
  getAllEntities,
  getRelationships,
  queryFacts,
  findSimilarByFile,
  embed,
  searchVectors,
  hybridSearch,
  seedEntities,
  runExtraction,
  runEmbedIndex,
  indexFiles,
  deleteStaleFiles,
  searchConversations,
} from '@engram/core';
import { startWebServer, stopWebServer, isWebRunning, getWebUrl, type WebServerDeps } from '@engram/web';

export interface McpContext {
  db: IDatabase;
  vault: IVaultReader;
  vaultRoot: string;
  skipDirs: Set<string>;
  ollamaUrl: string;
  ollamaModel: string;
  peopleDir: string | null;
  vectors: VectorEntry[];
}

export function registerAllTools(server: McpServer, ctx: McpContext): void {
  // ─── Phase 1: FTS ───

  server.tool(
    'vault_search',
    'FTS5 키워드 검색 — 디렉토리/태그 필터 지원',
    {
      query: z.string().describe('검색 키워드'),
      directory: z.string().optional().describe('디렉토리 필터 (e.g. "3-업무")'),
      tag: z.string().optional().describe('태그 필터'),
      limit: z.number().optional().describe('결과 수 (기본 10)'),
    },
    async ({ query, directory, tag, limit }) => {
      const maxResults = limit ?? 10;
      let sql = `
        SELECT f.path, f.title, f.directory, f.tags,
               snippet(files_fts, 1, '>>>', '<<<', '...', 40) as snippet
        FROM files_fts fts
        JOIN files f ON f.id = fts.rowid
        WHERE files_fts MATCH ?
      `;
      const params: unknown[] = [query];
      if (directory) { sql += ' AND f.directory = ?'; params.push(directory); }
      if (tag) { sql += ' AND f.tags LIKE ?'; params.push(`%${tag}%`); }
      sql += ' ORDER BY rank LIMIT ?';
      params.push(maxResults);

      const rows = ctx.db.queryAll<any>(sql, params);
      const text = rows.length === 0
        ? `'${query}' 검색 결과 없음`
        : rows.map((r: any, i: number) =>
          `${i + 1}. **${r.title}** (${r.path})\n   ${r.snippet}`,
        ).join('\n\n');
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'vault_reindex',
    '볼트 재인덱싱 (증분 또는 전체)',
    {
      force: z.boolean().optional().describe('true면 전체 재인덱싱 (기본: 증분)'),
    },
    async ({ force }) => {
      const result = runFullIndex(ctx, force ?? false);
      const text = `인덱싱 완료: ${result.indexed} indexed, ${result.skipped} skipped, ${result.deleted} deleted (${result.durationMs}ms)`;
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'vault_backlinks',
    '특정 노트를 참조하는 백링크 목록',
    {
      title: z.string().describe('노트 제목 (wiki-link 대상)'),
    },
    async ({ title }) => {
      const rows = ctx.db.queryAll<{ path: string; title: string }>(
        `SELECT path, title FROM files WHERE wiki_links LIKE ?`,
        [`%${title}%`],
      );
      const text = rows.length === 0
        ? `'${title}'을 참조하는 노트 없음`
        : `**${title}** 백링크 (${rows.length}개):\n` +
          rows.map(r => `- ${r.title} (${r.path})`).join('\n');
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'vault_stats',
    '인덱스 통계 — 파일 수, 디렉토리 분포, 임베딩/엔티티 수',
    {},
    async () => {
      const stats = getVaultStats(ctx.db);
      const dirList = stats.directories.map(d => `  ${d.name || '(root)'}: ${d.count}`).join('\n');
      const text = [
        `**볼트 인덱스 통계**`,
        `총 파일: ${stats.files}`,
        `디렉토리 분포:\n${dirList}`,
        `임베딩: ${stats.embeddings}`,
        `엔티티: ${stats.entities}`,
        `관계: ${stats.relationships}`,
        `팩트: ${stats.facts}`,
      ].join('\n');
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  // ─── Phase 2: Semantic ───

  server.tool(
    'vault_embed',
    '임베딩 생성 (증분 또는 전체). Ollama bge-m3 필요.',
    {
      force: z.boolean().optional().describe('true면 전체 재생성 (기본: 증분)'),
    },
    async ({ force }) => {
      const { result, vectors } = await runEmbedIndex(
        ctx.db, ctx.ollamaUrl, ctx.ollamaModel, force ?? false,
      );
      ctx.vectors = vectors;
      const text = `임베딩 완료: ${result.embedded} embedded, ${result.skipped} skipped, ${result.errors} errors (${result.durationMs}ms)`;
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'vault_semantic_search',
    '의미 기반 유사도 검색 (Ollama bge-m3 임베딩)',
    {
      query: z.string().describe('검색 질의 (자연어)'),
      limit: z.number().optional().describe('결과 수 (기본 10)'),
    },
    async ({ query, limit }) => {
      const queryVec = await embed(query, ctx.ollamaUrl, ctx.ollamaModel);
      const results = searchVectors(ctx.vectors, queryVec, limit ?? 10);

      if (results.length === 0) {
        return { content: [{ type: 'text' as const, text: '시맨틱 검색 결과 없음. vault_embed을 먼저 실행하세요.' }] };
      }

      const lines = results.map((r, i) => {
        const file = ctx.db.queryOne<{ path: string; title: string }>(
          'SELECT path, title FROM files WHERE id = ?', [r.fileId],
        );
        if (!file) return null;
        const score = (r.score * 100).toFixed(1);
        const heading = r.heading ? ` > ${r.heading}` : '';
        const chunk = ctx.db.queryOne<{ chunk_text: string }>(
          'SELECT chunk_text FROM embeddings WHERE id = ?', [r.id],
        );
        const snippet = chunk?.chunk_text
          ? `\n   ${chunk.chunk_text.slice(0, 120).replace(/\n/g, ' ')}`
          : '';
        return `${i + 1}. **${file.title}**${heading} (${score}%) — ${file.path}${snippet}`;
      }).filter(Boolean);

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );

  server.tool(
    'vault_hybrid_search',
    'FTS5 + 시맨틱 검색을 RRF로 결합한 하이브리드 검색 (더 높은 정확도)',
    {
      query: z.string().describe('검색 질의'),
      limit: z.coerce.number().optional().describe('결과 수 (기본 10)'),
      directory: z.string().optional().describe('디렉토리 필터 (e.g. "3-업무")'),
      tag: z.string().optional().describe('태그 필터'),
      since: z.string().optional().describe('이후 수정된 파일만 (YYYY-MM-DD)'),
      until: z.string().optional().describe('이전 수정된 파일만 (YYYY-MM-DD)'),
    },
    async ({ query, limit, directory, tag, since, until }) => {
      if (ctx.vectors.length === 0) {
        return { content: [{ type: 'text' as const, text: '임베딩 없음. vault_embed 먼저 실행하세요.' }] };
      }
      const queryVec = await embed(query, ctx.ollamaUrl, ctx.ollamaModel);
      const filterOptions = {
        directory: directory || undefined,
        tag: tag || undefined,
        since: since ? new Date(since).getTime() : undefined,
        until: until ? new Date(until).getTime() : undefined,
      };
      const results = hybridSearch(ctx.db, ctx.vectors, queryVec, query, limit ?? 10, 60, filterOptions);

      if (results.length === 0) {
        return { content: [{ type: 'text' as const, text: `'${query}' 하이브리드 검색 결과 없음` }] };
      }

      const header = `| # | 제목 | FTS | Vec | RRF | 내용 | 경로 |\n|---|------|-----|-----|-----|------|------|`;
      const rows = results.map((r, i) => {
        const fts = r.ftsRank !== null ? `#${r.ftsRank}` : '—';
        const vec = r.vecRank !== null ? `#${r.vecRank}` : '—';
        const rrf = r.rrfScore.toFixed(4);
        const detail = (r.snippet ?? r.heading ?? '').replace(/\n/g, ' ').slice(0, 60);
        return `| ${i + 1} | **${r.title}** | ${fts} | ${vec} | ${rrf} | ${detail} | ${r.path} |`;
      });

      return { content: [{ type: 'text' as const, text: [header, ...rows].join('\n') }] };
    },
  );

  server.tool(
    'vault_find_similar',
    '특정 노트와 유사한 노트 찾기',
    {
      path: z.string().describe('노트 경로 (vault root 기준)'),
      limit: z.number().optional().describe('결과 수 (기본 10)'),
    },
    async ({ path: filePath, limit }) => {
      const results = findSimilarByFile(ctx.db, ctx.vectors, filePath, limit ?? 10);
      if (results.length === 0) {
        return { content: [{ type: 'text' as const, text: `'${filePath}' 유사 노트 없음` }] };
      }
      const lines = results.map((r, i) => {
        const score = (r.score * 100).toFixed(1);
        return `${i + 1}. **${r.title}** (${score}%) — ${r.path}`;
      });
      return { content: [{ type: 'text' as const, text: `**${filePath}** 유사 노트:\n${lines.join('\n')}` }] };
    },
  );

  // ─── Phase 3: Graph ───

  server.tool(
    'vault_entity_search',
    '엔티티 검색 — 이름/별명/ID로 검색',
    {
      query: z.string().describe('검색어 (이름, 별명, ID)'),
      type: z.string().optional().describe('엔티티 타입 필터 (person, project, concept 등)'),
    },
    async ({ query, type }) => {
      const results = searchEntities(ctx.db, query, type);
      if (results.length === 0) {
        const entity = getEntity(ctx.db, query);
        if (entity) {
          const aliases = entity.aliases.length > 0 ? ` (${entity.aliases.join(', ')})` : '';
          const text = `**${entity.name}**${aliases}\n- ID: ${entity.id}\n- Type: ${entity.type}\n- Source: ${entity.sourcePath ?? 'N/A'}`;
          return { content: [{ type: 'text' as const, text }] };
        }
        return { content: [{ type: 'text' as const, text: `'${query}' 엔티티 없음` }] };
      }
      const lines = results.map(e => {
        const aliases = e.aliases.length > 0 ? ` (${e.aliases.join(', ')})` : '';
        return `- **${e.name}**${aliases} [${e.type}] — ${e.id}`;
      });
      return { content: [{ type: 'text' as const, text: `엔티티 검색 '${query}':\n${lines.join('\n')}` }] };
    },
  );

  server.tool(
    'vault_relationships',
    '엔티티 관계 그래프 조회',
    {
      entityId: z.string().describe('엔티티 ID'),
      type: z.string().optional().describe('관계 타입 필터'),
    },
    async ({ entityId, type }) => {
      const entity = getEntity(ctx.db, entityId);
      if (!entity) {
        return { content: [{ type: 'text' as const, text: `엔티티 '${entityId}' 없음` }] };
      }
      const rels = getRelationships(ctx.db, entityId, type);
      if (rels.length === 0) {
        return { content: [{ type: 'text' as const, text: `**${entity.name}** 관계 없음` }] };
      }
      const lines = rels.map(r => {
        const otherId = r.sourceId === entityId ? r.targetId : r.sourceId;
        const other = getEntity(ctx.db, otherId);
        const otherName = other?.name ?? otherId;
        const direction = r.sourceId === entityId ? '→' : '←';
        const context = r.context ? ` (${r.context})` : '';
        return `- ${direction} **${otherName}** [${r.type}]${context}`;
      });
      return { content: [{ type: 'text' as const, text: `**${entity.name}** 관계 (${rels.length}개):\n${lines.join('\n')}` }] };
    },
  );

  server.tool(
    'vault_timeline',
    '시간축 팩트 조회 — 엔티티/기간/타입 필터',
    {
      entityId: z.string().optional().describe('엔티티 ID'),
      type: z.string().optional().describe('팩트 타입 필터'),
      since: z.string().optional().describe('시작일 (YYYY-MM-DD)'),
      until: z.string().optional().describe('종료일 (YYYY-MM-DD)'),
      limit: z.number().optional().describe('결과 수 (기본 50)'),
    },
    async ({ entityId, type, since, until, limit }) => {
      let entityName = entityId;
      if (entityId) {
        const entity = getEntity(ctx.db, entityId);
        if (entity) entityName = entity.name;
      }
      const facts = queryFacts(ctx.db, { entityId, type, since, until, limit: limit ?? 50 });
      if (facts.length === 0) {
        return { content: [{ type: 'text' as const, text: '타임라인 결과 없음' }] };
      }
      const lines = facts.map(f => {
        const date = f.recordedAt ?? '?';
        const entities = f.entityIds.join(', ');
        return `- [${date}] ${f.content} {${f.type}} — entities: ${entities}`;
      });
      const header = entityName ? `**${entityName}** 타임라인` : '타임라인';
      return { content: [{ type: 'text' as const, text: `${header} (${facts.length}개):\n${lines.join('\n')}` }] };
    },
  );

  server.tool(
    'vault_extract_entities',
    'Extract entities and relationships from vault — wiki-links, frontmatter, and co-mentions. seed=true to seed from people dir.',
    {
      seed: z.boolean().optional().describe('true = seed mode (default: false, extraction mode)'),
      force: z.boolean().optional().describe('Force re-extraction of all files (ignore incremental tracking)'),
      limit: z.coerce.number().optional().describe('Limit number of notes to process'),
    },
    async ({ seed, force, limit }) => {
      if (seed) {
        const result = await seedEntities(ctx.db, ctx.vault, ctx.peopleDir);
        const total = getAllEntities(ctx.db).length;
        const text = `Seeded ${result.peopleSeeded} people from people directory\n\nTotal entities: ${total}`;
        return { content: [{ type: 'text' as const, text }] };
      }

      const result = runExtraction(ctx.db, ctx.peopleDir, { force, limit });
      const totalEntities = getAllEntities(ctx.db).length;
      const totalRels = ctx.db.queryOne<{ c: number }>('SELECT COUNT(*) as c FROM relationships')?.c ?? 0;
      const totalFacts = ctx.db.queryOne<{ c: number }>('SELECT COUNT(*) as c FROM facts')?.c ?? 0;

      const text = [
        `Extraction complete (${result.durationMs}ms):`,
        `  Files processed: ${result.filesProcessed}`,
        `  Entities discovered: ${result.entitiesDiscovered}`,
        `  Relationships created: ${result.relationships}`,
        `  Facts created: ${result.facts}`,
        ``,
        `Totals: ${totalEntities} entities, ${totalRels} relationships, ${totalFacts} facts`,
      ].join('\n');
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  // ─── Conversations ───

  server.tool(
    'vault_conversation_search',
    '과거 대화 기록 검색 — FTS5 키워드 또는 최신순 조회',
    {
      query: z.string().optional().describe('검색 키워드 (생략 시 최신순)'),
      since: z.string().optional().describe('시작일 (YYYY-MM-DD)'),
      until: z.string().optional().describe('종료일 (YYYY-MM-DD)'),
      limit: z.coerce.number().optional().describe('결과 수 (기본 10)'),
    },
    async ({ query, since, until, limit }) => {
      const rows = searchConversations(ctx.db, { query, since, until, limit: limit ?? 10 });
      if (rows.length === 0) {
        return { content: [{ type: 'text' as const, text: '대화 기록 없음' }] };
      }
      const lines = rows.map((r, i) => {
        const topics = r.topics ? ` [${r.topics}]` : '';
        const outcome = r.outcome ? `\n   결과: ${r.outcome}` : '';
        const next = r.next_actions ? `\n   다음: ${r.next_actions}` : '';
        return `${i + 1}. **${r.date}**${topics}\n   ${r.summary}${outcome}${next}`;
      });
      const header = query ? `'${query}' 대화 검색 (${rows.length}건)` : `최근 대화 기록 (${rows.length}건)`;
      return { content: [{ type: 'text' as const, text: `${header}:\n\n${lines.join('\n\n')}` }] };
    },
  );

  // ─── Web UI ───

  server.tool(
    'vault_web',
    'Engram 모니터링 웹 UI 시작/정지 — 검색, 그래프, DB 탐색기',
    {
      action: z.enum(['start', 'stop', 'status']).describe('start: 웹 서버 시작, stop: 정지, status: 상태 확인'),
      port: z.coerce.number().optional().describe('포트 번호 (기본 3930)'),
    },
    async ({ action, port }) => {
      if (action === 'status') {
        const running = isWebRunning();
        const url = getWebUrl();
        const text = running ? `웹 UI 실행 중: ${url}` : '웹 UI 정지 상태';
        return { content: [{ type: 'text' as const, text }] };
      }

      const webDeps: WebServerDeps = {
        db: ctx.db,
        vectors: ctx.vectors,
        ollamaUrl: ctx.ollamaUrl,
        ollamaModel: ctx.ollamaModel,
      };

      if (action === 'start') {
        if (isWebRunning()) {
          return { content: [{ type: 'text' as const, text: `이미 실행 중: ${getWebUrl()}` }] };
        }
        try {
          const url = await startWebServer(webDeps, port);
          return { content: [{ type: 'text' as const, text: `웹 UI 시작: ${url}` }] };
        } catch (err: any) {
          if (err.code === 'EADDRINUSE') {
            return { content: [{ type: 'text' as const, text: `포트 ${port ?? 3930} 이미 사용 중.` }] };
          }
          return { content: [{ type: 'text' as const, text: `시작 실패: ${err.message}` }] };
        }
      }

      if (!isWebRunning()) {
        return { content: [{ type: 'text' as const, text: '웹 UI가 실행 중이 아닙니다.' }] };
      }
      await stopWebServer();
      return { content: [{ type: 'text' as const, text: '웹 UI 정지 완료' }] };
    },
  );
}

/**
 * Run full index: scan vault → read → parse → upsert → delete stale
 */
function runFullIndex(ctx: McpContext, force: boolean) {
  const start = Date.now();
  const scanned = ctx.vault.scanMarkdownFiles(ctx.skipDirs);
  const existingMap = new Map(
    ctx.db.queryAll<{ path: string; modified_at: number }>('SELECT path, modified_at FROM files')
      .map(f => [f.path, f.modified_at]),
  );

  const toIndex: Array<{
    path: string; title: string; directory: string;
    tags: string[]; frontmatter: Record<string, unknown>;
    wikiLinks: string[]; content: string; modifiedAt: number;
  }> = [];

  let skipped = 0;

  for (const file of scanned) {
    const existingMtime = existingMap.get(file.path);
    if (!force && existingMtime && Math.abs(existingMtime - file.modifiedAt) < 1000) {
      skipped++;
      continue;
    }
    try {
      // readFile is async in IVaultReader but NodeVaultReader reads sync
      const raw = require('fs').readFileSync(
        require('path').join(ctx.vaultRoot, file.path), 'utf-8',
      );
      const parsed = ctx.vault.parseMetadata(file.path, raw);
      const directory = file.path.split('/')[0] ?? '';
      toIndex.push({
        path: file.path,
        title: parsed.title,
        directory,
        tags: parsed.tags,
        frontmatter: parsed.frontmatter,
        wikiLinks: parsed.wikiLinks,
        content: parsed.content,
        modifiedAt: file.modifiedAt,
      });
    } catch {
      skipped++;
    }
  }

  const indexed = indexFiles(ctx.db, toIndex);
  const scannedPaths = new Set(scanned.map(f => f.path));
  const deleted = deleteStaleFiles(ctx.db, scannedPaths);

  return { indexed, skipped, deleted, durationMs: Date.now() - start };
}
