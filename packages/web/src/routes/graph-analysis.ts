import {
  loadGraph, findPath, getNeighborhood,
  degreeCentrality, betweennessCentrality,
  getCommunities, entityImportance, graphStats,
  suggestConnections,
  entityActivity, detectTrends, relationshipTimeline,
} from '@engram/core';
import type { RouteContext } from '../server.js';

const TYPE_COLORS: Record<string, string> = {
  person: '#3b82f6',
  organization: '#22c55e',
  project: '#f97316',
  team: '#a855f7',
  topic: '#eab308',
  event: '#ec4899',
  concept: '#06b6d4',
  technology: '#14b8a6',
  tool: '#f43f5e',
  decision: '#8b5cf6',
};

export function handleGraphPath(ctx: RouteContext) {
  const from = ctx.url.searchParams.get('from');
  const to = ctx.url.searchParams.get('to');
  const maxHops = parseInt(ctx.url.searchParams.get('maxHops') ?? '6', 10);

  if (!from || !to) return { error: 'Missing from/to parameters' };

  const graph = loadGraph(ctx.db);
  const result = findPath(graph, from, to, maxHops);

  if (!result) return { found: false, from, to };

  return {
    found: true,
    path: result.path.map(id => ({
      id,
      name: graph.nodes.get(id)?.name ?? id,
      type: graph.nodes.get(id)?.type ?? 'unknown',
    })),
    edges: result.edges.map(e => ({
      ...e,
      fromName: graph.nodes.get(e.from)?.name ?? e.from,
      toName: graph.nodes.get(e.to)?.name ?? e.to,
    })),
    hops: result.hops,
    totalWeight: result.totalWeight,
  };
}

export function handleGraphNeighborhood(ctx: RouteContext) {
  const entityId = ctx.url.searchParams.get('entityId');
  const hops = parseInt(ctx.url.searchParams.get('hops') ?? '2', 10);
  const minWeight = parseFloat(ctx.url.searchParams.get('minWeight') ?? '0');

  if (!entityId) return { error: 'Missing entityId parameter' };

  const graph = loadGraph(ctx.db);
  const result = getNeighborhood(graph, entityId, hops, minWeight);

  // Format for vis-network
  const nodes = result.nodes.map(n => ({
    id: n.id,
    label: n.name,
    group: n.type,
    color: TYPE_COLORS[n.type] ?? '#6b7280',
    title: `${n.name} (${n.type}, ${n.distance}홉)`,
    level: n.distance,
    size: n.id === entityId ? 20 : Math.max(8, 16 - n.distance * 4),
  }));

  const edges = result.edges.map(e => ({
    from: e.from,
    to: e.to,
    label: e.types.join(', '),
    value: e.weight,
    title: `weight: ${e.weight.toFixed(2)}`,
  }));

  return { nodes, edges, center: entityId };
}

export function handleGraphAnalysis(ctx: RouteContext) {
  const analysisType = ctx.url.searchParams.get('type') ?? 'stats';
  const entityType = ctx.url.searchParams.get('entityType') ?? undefined;
  const limit = parseInt(ctx.url.searchParams.get('limit') ?? '20', 10);

  const opts = entityType ? { entityTypes: [entityType] } : undefined;
  const graph = loadGraph(ctx.db, opts);

  if (analysisType === 'stats') {
    return graphStats(graph);
  }

  if (analysisType === 'communities') {
    return getCommunities(graph).slice(0, limit);
  }

  if (analysisType === 'importance') {
    const importance = entityImportance(ctx.db, graph);
    return [...importance.entries()]
      .sort((a, b) => a[1].rank - b[1].rank)
      .slice(0, limit)
      .map(([id, imp]) => ({
        id,
        name: graph.nodes.get(id)?.name ?? id,
        type: graph.nodes.get(id)?.type ?? 'unknown',
        ...imp,
      }));
  }

  if (analysisType === 'centrality') {
    const deg = degreeCentrality(graph);
    const bet = betweennessCentrality(graph);
    return [...deg.entries()]
      .map(([id, d]) => ({
        id,
        name: graph.nodes.get(id)?.name ?? id,
        type: graph.nodes.get(id)?.type ?? 'unknown',
        ...d,
        betweenness: bet.get(id) ?? 0,
      }))
      .sort((a, b) => b.degree - a.degree)
      .slice(0, limit);
  }

  if (analysisType === 'suggest') {
    return suggestConnections(ctx.db, graph, { limit });
  }

  return { error: 'Unknown analysis type' };
}

export function handleGraphTemporal(ctx: RouteContext) {
  const temporalType = ctx.url.searchParams.get('type') ?? 'trends';
  const entityId = ctx.url.searchParams.get('entityId') ?? undefined;
  const targetId = ctx.url.searchParams.get('targetId') ?? undefined;
  const granularity = (ctx.url.searchParams.get('granularity') as 'day' | 'week' | 'month') ?? 'month';
  const windowDays = parseInt(ctx.url.searchParams.get('windowDays') ?? '30', 10);

  if (temporalType === 'relationship' && entityId && targetId) {
    return relationshipTimeline(ctx.db, entityId, targetId);
  }

  if (temporalType === 'activity' && entityId) {
    return entityActivity(ctx.db, entityId, granularity);
  }

  if (temporalType === 'trends') {
    return detectTrends(ctx.db, windowDays);
  }

  return { error: 'Missing required parameters for temporal analysis' };
}
