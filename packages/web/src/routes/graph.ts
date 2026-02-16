import { getAllEntities, searchEntities, getRelationships, getAllRelationships, queryFacts } from '@engram/core';
import type { RouteContext } from '../server.js';

export function handleGraphEntities(ctx: RouteContext) {
  const q = ctx.url.searchParams.get('q');
  const type = ctx.url.searchParams.get('type') ?? undefined;

  if (q) {
    return searchEntities(ctx.db, q, type);
  }

  const all = getAllEntities(ctx.db);
  if (type) {
    return all.filter(e => e.type === type);
  }
  return all;
}

export function handleGraphRelationships(ctx: RouteContext) {
  const entityId = ctx.url.searchParams.get('entityId');
  if (!entityId) return { error: 'Missing entityId parameter', results: [] };

  const type = ctx.url.searchParams.get('type') ?? undefined;
  return getRelationships(ctx.db, entityId, type);
}

export function handleGraphFull(ctx: RouteContext) {
  const typeFilter = ctx.url.searchParams.get('type') ?? undefined;
  const relTypeFilter = ctx.url.searchParams.get('relType') ?? undefined;

  const allEntities = getAllEntities(ctx.db);
  const entities = typeFilter ? allEntities.filter(e => e.type === typeFilter) : allEntities;

  const allRels = getAllRelationships(ctx.db, relTypeFilter);
  const entityMap = new Map(entities.map(e => [e.id, e]));
  const edges = allRels.filter(r => entityMap.has(r.sourceId) && entityMap.has(r.targetId));

  const connectedIds = new Set<string>();
  for (const e of edges) {
    connectedIds.add(e.sourceId);
    connectedIds.add(e.targetId);
  }

  const nodeList = typeFilter ? entities : entities.filter(e => connectedIds.has(e.id));

  const TYPE_COLORS: Record<string, string> = {
    person: '#3b82f6',
    organization: '#22c55e',
    project: '#f97316',
    team: '#a855f7',
    topic: '#eab308',
    event: '#ec4899',
  };

  const nodes = nodeList.map(e => ({
    id: e.id,
    label: e.name,
    group: e.type,
    color: TYPE_COLORS[e.type] ?? '#6b7280',
    title: `${e.name} (${e.type})`,
  }));

  const edgesOut = edges.map(r => ({
    from: r.sourceId,
    to: r.targetId,
    label: r.type,
    id: r.id,
  }));

  return { nodes, edges: edgesOut };
}

export function handleGraphFacts(ctx: RouteContext) {
  const entityId = ctx.url.searchParams.get('entityId') ?? undefined;
  const type = ctx.url.searchParams.get('type') ?? undefined;
  const since = ctx.url.searchParams.get('since') ?? undefined;
  const until = ctx.url.searchParams.get('until') ?? undefined;
  const limit = parseInt(ctx.url.searchParams.get('limit') ?? '50', 10);

  return queryFacts(ctx.db, { entityId, type, since, until, limit });
}
