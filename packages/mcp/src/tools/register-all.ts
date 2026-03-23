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
  loadGraph,
  findPath,
  getNeighborhood,
  entityImportance,
  getCommunities,
  graphStats,
  suggestConnections,
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
    'Extract entities and relationships from vault. method=rule (default): wiki-links, frontmatter, co-mentions. method=llm: Ollama LLM deep extraction. seed=true: seed from people dir.',
    {
      seed: z.boolean().optional().describe('true = seed mode (default: false, extraction mode)'),
      force: z.boolean().optional().describe('Force re-extraction of all files (ignore incremental tracking)'),
      limit: z.coerce.number().optional().describe('Limit number of notes to process'),
      method: z.enum(['rule', 'llm']).optional().describe('Extraction method: rule (default) or llm (Ollama)'),
      model: z.string().optional().describe('Ollama model for LLM extraction (default: llama3.2)'),
    },
    async ({ seed, force, limit, method, model }) => {
      if (seed) {
        const result = await seedEntities(ctx.db, ctx.vault, ctx.peopleDir);
        const total = getAllEntities(ctx.db).length;
        const text = `Seeded ${result.peopleSeeded} people from people directory\n\nTotal entities: ${total}`;
        return { content: [{ type: 'text' as const, text }] };
      }

      if (method === 'llm') {
        const { runLlmExtraction } = await import('@engram/core');
        const llmModel = model ?? 'llama3.2';
        const result = await runLlmExtraction(ctx.db, ctx.ollamaUrl, llmModel, { force, limit });
        const totalEntities = getAllEntities(ctx.db).length;
        const totalRels = ctx.db.queryOne<{ c: number }>('SELECT COUNT(*) as c FROM relationships')?.c ?? 0;

        const text = [
          `LLM Extraction complete (${result.durationMs}ms):`,
          `  Model: ${llmModel}`,
          `  Files processed: ${result.filesProcessed}`,
          `  Entities discovered: ${result.entitiesDiscovered}`,
          `  Relationships created: ${result.relationshipsCreated}`,
          `  Facts created: ${result.factsCreated}`,
          `  Errors: ${result.errors}`,
          ``,
          `Totals: ${totalEntities} entities, ${totalRels} relationships`,
        ].join('\n');
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

  // ─── Graph Analysis ───

  server.tool(
    'vault_graph_path',
    '두 엔티티 사이의 연결 경로 탐색 — "A와 B는 어떻게 연결돼 있나?"',
    {
      from: z.string().describe('출발 엔티티 ID'),
      to: z.string().describe('도착 엔티티 ID'),
      maxHops: z.coerce.number().optional().describe('최대 홉 수 (기본 6)'),
    },
    async ({ from, to, maxHops }) => {
      const graph = loadGraph(ctx.db);
      const result = findPath(graph, from, to, maxHops ?? 6);
      if (!result) {
        const fromName = graph.nodes.get(from)?.name ?? from;
        const toName = graph.nodes.get(to)?.name ?? to;
        return { content: [{ type: 'text' as const, text: `**${fromName}** ↔ **${toName}** 사이에 연결 경로 없음 (최대 ${maxHops ?? 6}홉)` }] };
      }

      const pathNames = result.path.map(id => graph.nodes.get(id)?.name ?? id);
      const lines: string[] = [`**경로** (${result.hops}홉, 총 weight ${result.totalWeight.toFixed(2)}):\n`];
      for (let i = 0; i < result.edges.length; i++) {
        const e = result.edges[i];
        const fromName = graph.nodes.get(e.from)?.name ?? e.from;
        const toName = graph.nodes.get(e.to)?.name ?? e.to;
        lines.push(`${i + 1}. **${fromName}** → **${toName}** [${e.types.join(', ')}] (weight: ${e.weight.toFixed(2)})`);
      }
      lines.push(`\n경로: ${pathNames.join(' → ')}`);
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );

  server.tool(
    'vault_graph_neighborhood',
    '엔티티 중심 N-hop 이웃 서브그래프 조회',
    {
      entityId: z.string().describe('중심 엔티티 ID'),
      hops: z.coerce.number().optional().describe('탐색 깊이 (기본 2)'),
      minWeight: z.coerce.number().optional().describe('최소 관계 가중치 필터'),
    },
    async ({ entityId, hops, minWeight }) => {
      const graph = loadGraph(ctx.db);
      const centerName = graph.nodes.get(entityId)?.name ?? entityId;
      const result = getNeighborhood(graph, entityId, hops ?? 2, minWeight ?? 0);

      if (result.nodes.length <= 1) {
        return { content: [{ type: 'text' as const, text: `**${centerName}** 주변에 연결된 엔티티 없음` }] };
      }

      const byDist = new Map<number, typeof result.nodes>();
      for (const n of result.nodes) {
        if (n.id === entityId) continue;
        const arr = byDist.get(n.distance) ?? [];
        arr.push(n);
        byDist.set(n.distance, arr);
      }

      const lines: string[] = [`**${centerName}** 이웃 (${result.nodes.length - 1}개, ${hops ?? 2}홉 이내):\n`];
      for (const [dist, nodes] of [...byDist.entries()].sort((a, b) => a[0] - b[0])) {
        lines.push(`**${dist}홉:**`);
        for (const n of nodes) {
          lines.push(`  - ${n.name} [${n.type}]`);
        }
      }
      lines.push(`\n엣지: ${result.edges.length}개`);
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );

  server.tool(
    'vault_graph_analysis',
    '그래프 분석 — 중심성, 커뮤니티, 중요도 랭킹, 통계',
    {
      type: z.enum(['centrality', 'communities', 'importance', 'stats']).describe('분석 종류'),
      entityType: z.string().optional().describe('엔티티 타입 필터'),
      limit: z.coerce.number().optional().describe('결과 수 (기본 15)'),
    },
    async ({ type: analysisType, entityType, limit }) => {
      const max = limit ?? 15;
      const opts = entityType ? { entityTypes: [entityType] } : undefined;
      const graph = loadGraph(ctx.db, opts);

      if (analysisType === 'stats') {
        const s = graphStats(graph);
        const topList = s.topByDegree.map((t, i) => `  ${i + 1}. ${t.name} (${t.degree})`).join('\n');
        const text = [
          `**그래프 통계**`,
          `노드: ${s.nodeCount}`,
          `엣지: ${s.edgeCount}`,
          `밀도: ${(s.density * 100).toFixed(2)}%`,
          `평균 차수: ${s.avgDegree.toFixed(1)}`,
          `연결 컴포넌트: ${s.componentCount}`,
          `\nTop-10 (차수 기준):\n${topList}`,
        ].join('\n');
        return { content: [{ type: 'text' as const, text }] };
      }

      if (analysisType === 'communities') {
        const communities = getCommunities(graph);
        if (communities.length === 0) {
          return { content: [{ type: 'text' as const, text: '커뮤니티 없음 (고립 노드만 존재)' }] };
        }
        const lines = communities.slice(0, max).map(c => {
          const members = c.members.map(m => `${m.name}[${m.type}]`).join(', ');
          return `**커뮤니티 ${c.id}** (${c.size}명): ${members}`;
        });
        return { content: [{ type: 'text' as const, text: `**커뮤니티 탐지** (${communities.length}개):\n\n${lines.join('\n\n')}` }] };
      }

      if (analysisType === 'importance') {
        const importance = entityImportance(ctx.db, graph);
        const sorted = [...importance.entries()]
          .sort((a, b) => a[1].rank - b[1].rank)
          .slice(0, max);
        const lines = sorted.map(([id, imp]) => {
          const name = graph.nodes.get(id)?.name ?? id;
          const type = graph.nodes.get(id)?.type ?? '?';
          const c = imp.components;
          return `${imp.rank}. **${name}** [${type}] — score: ${imp.score.toFixed(3)} (D:${c.degree.toFixed(2)} B:${c.betweenness.toFixed(2)} M:${c.mentions.toFixed(2)} R:${c.recency.toFixed(2)})`;
        });
        return { content: [{ type: 'text' as const, text: `**중요도 랭킹**:\n${lines.join('\n')}` }] };
      }

      // centrality (imported at top level from @engram/core)
      const { degreeCentrality: _degCentrality, betweennessCentrality: _betCentrality } = await import('@engram/core');
      const deg = _degCentrality(graph);
      const bet = _betCentrality(graph);
      const sorted = [...deg.entries()]
        .map(([id, d]) => ({ id, name: graph.nodes.get(id)?.name ?? id, degree: d.degree, wDeg: d.weightedDegree, between: bet.get(id) ?? 0 }))
        .sort((a, b) => b.degree - a.degree)
        .slice(0, max);
      const lines = sorted.map((s, i) =>
        `${i + 1}. **${s.name}** — 차수: ${s.degree}, 가중 차수: ${s.wDeg.toFixed(2)}, betweenness: ${s.between.toFixed(4)}`,
      );
      return { content: [{ type: 'text' as const, text: `**중심성 분석**:\n${lines.join('\n')}` }] };
    },
  );

  server.tool(
    'vault_graph_suggest',
    '그래프 기반 추천 — 누락 연결, 약해지는 관계, 떠오르는 관계',
    {
      entityId: z.string().optional().describe('특정 엔티티 기준 (생략 시 전체)'),
      type: z.enum(['missing', 'fading', 'emerging']).optional().describe('추천 유형 (생략 시 전체)'),
      limit: z.coerce.number().optional().describe('결과 수 (기본 10)'),
    },
    async ({ entityId, type: suggestType, limit }) => {
      const graph = loadGraph(ctx.db);
      const result = suggestConnections(ctx.db, graph, {
        entityId,
        type: suggestType,
        limit: limit ?? 10,
      });

      const sections: string[] = [];

      if (result.missing.length > 0) {
        const lines = result.missing.map(m =>
          `- **${m.nameA}** ↔ **${m.nameB}** (공통 이웃 ${m.commonNeighbors}개)`,
        );
        sections.push(`**🔗 누락된 연결 (Missing Links)**:\n${lines.join('\n')}`);
      }

      if (result.fading.length > 0) {
        const lines = result.fading.map(f =>
          `- **${f.sourceName}** ↔ **${f.targetName}** (weight: ${f.weight.toFixed(2)}, 마지막: ${f.lastSeen})`,
        );
        sections.push(`**📉 약해지는 관계 (Fading)**:\n${lines.join('\n')}`);
      }

      if (result.emerging.length > 0) {
        const lines = result.emerging.map(e =>
          `- **${e.sourceName}** ↔ **${e.targetName}** (출현 ${e.seenCount}회, 최근: ${e.lastSeen})`,
        );
        sections.push(`**📈 떠오르는 관계 (Emerging)**:\n${lines.join('\n')}`);
      }

      if (sections.length === 0) {
        return { content: [{ type: 'text' as const, text: '추천할 항목 없음' }] };
      }

      return { content: [{ type: 'text' as const, text: sections.join('\n\n') }] };
    },
  );

  // ─── Temporal Analysis ───

  server.tool(
    'vault_graph_temporal',
    '시간축 분석 — 관계 타임라인, 엔티티 활동 추이, 트렌드 탐지',
    {
      type: z.enum(['relationship', 'activity', 'trends']).describe('분석 종류'),
      entityId: z.string().optional().describe('엔티티 ID (relationship/activity에 필수)'),
      targetId: z.string().optional().describe('대상 엔티티 ID (relationship에 필수)'),
      granularity: z.enum(['day', 'week', 'month']).optional().describe('활동 집계 단위 (activity, 기본: month)'),
      windowDays: z.coerce.number().optional().describe('트렌드 분석 윈도우 (기본 30일)'),
    },
    async ({ type: analysisType, entityId, targetId, granularity, windowDays }) => {
      const { relationshipTimeline, entityActivity, detectTrends } = await import('@engram/core');

      if (analysisType === 'relationship') {
        if (!entityId || !targetId) {
          return { content: [{ type: 'text' as const, text: 'relationship 분석에는 entityId와 targetId가 필요합니다.' }] };
        }
        const timeline = relationshipTimeline(ctx.db, entityId, targetId);
        if (timeline.length === 0) {
          return { content: [{ type: 'text' as const, text: `${entityId} ↔ ${targetId} 관계 타임라인 없음` }] };
        }
        const lines = timeline.map(t =>
          `- [${t.date}] ${t.sourceFile}${t.context ? ` — ${t.context}` : ''} (${t.extractionMethod})`,
        );
        return { content: [{ type: 'text' as const, text: `**관계 타임라인** ${entityId} ↔ ${targetId} (${timeline.length}건):\n${lines.join('\n')}` }] };
      }

      if (analysisType === 'activity') {
        if (!entityId) {
          return { content: [{ type: 'text' as const, text: 'activity 분석에는 entityId가 필요합니다.' }] };
        }
        const entity = getEntity(ctx.db, entityId);
        const name = entity?.name ?? entityId;
        const activity = entityActivity(ctx.db, entityId, granularity ?? 'month');
        if (activity.length === 0) {
          return { content: [{ type: 'text' as const, text: `**${name}** 활동 기록 없음` }] };
        }
        const lines = activity.map(a =>
          `- ${a.period}: 언급 ${a.mentionCount}회, 새 관계 ${a.newRelationships}개, 팩트 ${a.factsRecorded}건`,
        );
        return { content: [{ type: 'text' as const, text: `**${name}** 활동 추이:\n${lines.join('\n')}` }] };
      }

      // trends
      const trends = detectTrends(ctx.db, windowDays ?? 30);
      const sections: string[] = [];

      if (trends.emerging.length > 0) {
        const lines = trends.emerging.slice(0, 15).map(e =>
          `- **${e.name}** [${e.type}] — 최근 ${e.recentActivity}회 vs 이전 ${e.previousActivity}회 (×${e.acceleration.toFixed(1)})`,
        );
        sections.push(`**📈 떠오르는 엔티티**:\n${lines.join('\n')}`);
      }

      if (trends.fading.length > 0) {
        const lines = trends.fading.slice(0, 15).map(f =>
          `- **${f.name}** [${f.type}] — 최근 ${f.recentActivity}회 vs 이전 ${f.previousActivity}회`,
        );
        sections.push(`**📉 사라지는 엔티티**:\n${lines.join('\n')}`);
      }

      if (sections.length === 0) {
        sections.push('활동 변화가 감지되지 않았습니다.');
      }

      return { content: [{ type: 'text' as const, text: sections.join('\n\n') }] };
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
