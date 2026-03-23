import type { IDatabase } from '../db/interface.js';

// ---------------------------------------------------------------------------
// Graph data structures
// ---------------------------------------------------------------------------

export interface GraphData {
  nodes: Map<string, { type: string; name: string; mentionCount: number }>;
  /** Adjacency: nodeId → Map<neighborId, { weight, types[] }> */
  adj: Map<string, Map<string, { weight: number; types: string[] }>>;
}

export interface PathResult {
  path: string[];
  edges: { from: string; to: string; types: string[]; weight: number }[];
  totalWeight: number;
  hops: number;
}

export interface SubgraphResult {
  nodes: { id: string; name: string; type: string; distance: number }[];
  edges: { from: string; to: string; types: string[]; weight: number }[];
}

export interface CentralityResult {
  degree: number;
  inDegree: number;
  outDegree: number;
  weightedDegree: number;
}

export interface ImportanceResult {
  score: number;
  rank: number;
  components: {
    degree: number;
    betweenness: number;
    mentions: number;
    recency: number;
  };
}

export interface CommunityInfo {
  id: number;
  members: { entityId: string; name: string; type: string }[];
  size: number;
}

export interface GraphStats {
  nodeCount: number;
  edgeCount: number;
  density: number;
  avgDegree: number;
  componentCount: number;
  topByDegree: { id: string; name: string; degree: number }[];
}

// ---------------------------------------------------------------------------
// Load graph from SQLite into adjacency list
// ---------------------------------------------------------------------------

export function loadGraph(
  db: IDatabase,
  opts?: { minWeight?: number; entityTypes?: string[]; relTypes?: string[] },
): GraphData {
  const nodes = new Map<string, { type: string; name: string; mentionCount: number }>();
  const adj = new Map<string, Map<string, { weight: number; types: string[] }>>();

  // Load entities
  let entitySql = 'SELECT id, type, name, mention_count FROM entities';
  const entityParams: unknown[] = [];
  if (opts?.entityTypes?.length) {
    entitySql += ` WHERE type IN (${opts.entityTypes.map(() => '?').join(',')})`;
    entityParams.push(...opts.entityTypes);
  }
  const entities = db.queryAll<any>(entitySql, entityParams);
  for (const e of entities) {
    nodes.set(e.id, { type: e.type, name: e.name, mentionCount: e.mention_count ?? 0 });
    adj.set(e.id, new Map());
  }

  // Load relationships
  let relSql = 'SELECT source_id, target_id, type, weight FROM relationships';
  const relConditions: string[] = [];
  const relParams: unknown[] = [];
  if (opts?.minWeight != null) {
    relConditions.push('weight >= ?');
    relParams.push(opts.minWeight);
  }
  if (opts?.relTypes?.length) {
    relConditions.push(`type IN (${opts.relTypes.map(() => '?').join(',')})`);
    relParams.push(...opts.relTypes);
  }
  if (relConditions.length) {
    relSql += ' WHERE ' + relConditions.join(' AND ');
  }
  const rels = db.queryAll<any>(relSql, relParams);

  for (const r of rels) {
    if (!nodes.has(r.source_id) || !nodes.has(r.target_id)) continue;
    const w = r.weight ?? 1.0;

    // Source → Target
    const srcAdj = adj.get(r.source_id)!;
    const existing = srcAdj.get(r.target_id);
    if (existing) {
      existing.weight = Math.max(existing.weight, w);
      if (!existing.types.includes(r.type)) existing.types.push(r.type);
    } else {
      srcAdj.set(r.target_id, { weight: w, types: [r.type] });
    }

    // Target → Source (undirected for analysis)
    const tgtAdj = adj.get(r.target_id)!;
    const existing2 = tgtAdj.get(r.source_id);
    if (existing2) {
      existing2.weight = Math.max(existing2.weight, w);
      if (!existing2.types.includes(r.type)) existing2.types.push(r.type);
    } else {
      tgtAdj.set(r.source_id, { weight: w, types: [r.type] });
    }
  }

  return { nodes, adj };
}

// ---------------------------------------------------------------------------
// BFS / Dijkstra shortest path
// ---------------------------------------------------------------------------

export function findPath(
  graph: GraphData,
  from: string,
  to: string,
  maxHops: number = 6,
): PathResult | null {
  if (from === to) return { path: [from], edges: [], totalWeight: 0, hops: 0 };
  if (!graph.adj.has(from) || !graph.adj.has(to)) return null;

  // Dijkstra with cost = 1/weight (stronger = shorter distance)
  const dist = new Map<string, number>();
  const prev = new Map<string, string | null>();
  const hops = new Map<string, number>();
  const visited = new Set<string>();

  // Priority queue as sorted array (fine for <1000 nodes)
  const queue: { id: string; cost: number }[] = [];

  dist.set(from, 0);
  hops.set(from, 0);
  prev.set(from, null);
  queue.push({ id: from, cost: 0 });

  while (queue.length > 0) {
    queue.sort((a, b) => a.cost - b.cost);
    const current = queue.shift()!;

    if (visited.has(current.id)) continue;
    visited.add(current.id);

    if (current.id === to) break;

    const currentHops = hops.get(current.id) ?? 0;
    if (currentHops >= maxHops) continue;

    const neighbors = graph.adj.get(current.id);
    if (!neighbors) continue;

    for (const [neighbor, edge] of neighbors) {
      if (visited.has(neighbor)) continue;
      const cost = current.cost + (1 / Math.max(edge.weight, 0.01));
      const prevDist = dist.get(neighbor) ?? Infinity;
      if (cost < prevDist) {
        dist.set(neighbor, cost);
        prev.set(neighbor, current.id);
        hops.set(neighbor, currentHops + 1);
        queue.push({ id: neighbor, cost });
      }
    }
  }

  if (!prev.has(to)) return null;

  // Reconstruct path
  const path: string[] = [];
  let node: string | null = to;
  while (node !== null) {
    path.unshift(node);
    node = prev.get(node) ?? null;
  }

  // Build edges
  const edges: PathResult['edges'] = [];
  let totalWeight = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const edgeData = graph.adj.get(path[i])?.get(path[i + 1]);
    if (edgeData) {
      edges.push({ from: path[i], to: path[i + 1], types: edgeData.types, weight: edgeData.weight });
      totalWeight += edgeData.weight;
    }
  }

  return { path, edges, totalWeight, hops: path.length - 1 };
}

// ---------------------------------------------------------------------------
// N-hop neighborhood (BFS)
// ---------------------------------------------------------------------------

export function getNeighborhood(
  graph: GraphData,
  entityId: string,
  maxHops: number = 2,
  minWeight: number = 0,
): SubgraphResult {
  const nodeDistances = new Map<string, number>();
  const edgeSet = new Map<string, { from: string; to: string; types: string[]; weight: number }>();

  nodeDistances.set(entityId, 0);
  const queue: { id: string; depth: number }[] = [{ id: entityId, depth: 0 }];

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    if (depth >= maxHops) continue;

    const neighbors = graph.adj.get(id);
    if (!neighbors) continue;

    for (const [neighbor, edge] of neighbors) {
      if (edge.weight < minWeight) continue;

      // Record edge (deduplicate by sorted key)
      const edgeKey = [id, neighbor].sort().join('::');
      if (!edgeSet.has(edgeKey)) {
        edgeSet.set(edgeKey, { from: id, to: neighbor, types: edge.types, weight: edge.weight });
      }

      if (!nodeDistances.has(neighbor)) {
        nodeDistances.set(neighbor, depth + 1);
        queue.push({ id: neighbor, depth: depth + 1 });
      }
    }
  }

  const nodes: SubgraphResult['nodes'] = [];
  for (const [id, distance] of nodeDistances) {
    const nodeInfo = graph.nodes.get(id);
    if (nodeInfo) {
      nodes.push({ id, name: nodeInfo.name, type: nodeInfo.type, distance });
    }
  }

  return { nodes, edges: [...edgeSet.values()] };
}

// ---------------------------------------------------------------------------
// Degree centrality
// ---------------------------------------------------------------------------

export function degreeCentrality(graph: GraphData): Map<string, CentralityResult> {
  const result = new Map<string, CentralityResult>();

  // Count directed edges
  const inDeg = new Map<string, number>();
  const outDeg = new Map<string, number>();
  const wDeg = new Map<string, number>();

  for (const [nodeId] of graph.nodes) {
    inDeg.set(nodeId, 0);
    outDeg.set(nodeId, 0);
    wDeg.set(nodeId, 0);
  }

  // We treat adj as undirected, but count both sides
  for (const [nodeId, neighbors] of graph.adj) {
    for (const [, edge] of neighbors) {
      outDeg.set(nodeId, (outDeg.get(nodeId) ?? 0) + 1);
      wDeg.set(nodeId, (wDeg.get(nodeId) ?? 0) + edge.weight);
    }
  }

  // Since graph is undirected in adj, inDegree == outDegree
  for (const [nodeId] of graph.nodes) {
    const degree = outDeg.get(nodeId) ?? 0;
    result.set(nodeId, {
      degree,
      inDegree: degree,
      outDegree: degree,
      weightedDegree: wDeg.get(nodeId) ?? 0,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Betweenness centrality (Brandes' algorithm)
// ---------------------------------------------------------------------------

export function betweennessCentrality(
  graph: GraphData,
  sampleSize?: number,
): Map<string, number> {
  const bc = new Map<string, number>();
  for (const [id] of graph.nodes) bc.set(id, 0);

  let sources = [...graph.nodes.keys()];
  if (sampleSize && sampleSize < sources.length) {
    // Random sample for large graphs
    sources = shuffle(sources).slice(0, sampleSize);
  }

  for (const s of sources) {
    const stack: string[] = [];
    const predecessors = new Map<string, string[]>();
    const sigma = new Map<string, number>(); // number of shortest paths
    const dist = new Map<string, number>();
    const delta = new Map<string, number>();

    for (const [id] of graph.nodes) {
      predecessors.set(id, []);
      sigma.set(id, 0);
      dist.set(id, -1);
      delta.set(id, 0);
    }

    sigma.set(s, 1);
    dist.set(s, 0);
    const queue: string[] = [s];

    // BFS
    while (queue.length > 0) {
      const v = queue.shift()!;
      stack.push(v);
      const neighbors = graph.adj.get(v);
      if (!neighbors) continue;

      for (const [w] of neighbors) {
        if (dist.get(w)! < 0) {
          queue.push(w);
          dist.set(w, dist.get(v)! + 1);
        }
        if (dist.get(w) === dist.get(v)! + 1) {
          sigma.set(w, sigma.get(w)! + sigma.get(v)!);
          predecessors.get(w)!.push(v);
        }
      }
    }

    // Back-propagation
    while (stack.length > 0) {
      const w = stack.pop()!;
      for (const v of predecessors.get(w)!) {
        const fraction = (sigma.get(v)! / sigma.get(w)!) * (1 + delta.get(w)!);
        delta.set(v, delta.get(v)! + fraction);
      }
      if (w !== s) {
        bc.set(w, bc.get(w)! + delta.get(w)!);
      }
    }
  }

  // Normalize (undirected: divide by 2)
  const n = graph.nodes.size;
  const normFactor = sampleSize ? (sources.length > 0 ? n / sources.length : 1) : 1;
  if (n > 2) {
    for (const [id, val] of bc) {
      bc.set(id, (val * normFactor) / ((n - 1) * (n - 2)));
    }
  }

  return bc;
}

// ---------------------------------------------------------------------------
// Community detection (Label Propagation)
// ---------------------------------------------------------------------------

export function detectCommunities(graph: GraphData): Map<string, number> {
  const labels = new Map<string, number>();
  let labelCounter = 0;

  // Initialize: each node is its own community
  for (const [id] of graph.nodes) {
    labels.set(id, labelCounter++);
  }

  const nodeIds = [...graph.nodes.keys()];
  const maxIterations = 100;
  let changed = true;

  for (let iter = 0; iter < maxIterations && changed; iter++) {
    changed = false;
    const shuffled = shuffle(nodeIds);

    for (const nodeId of shuffled) {
      const neighbors = graph.adj.get(nodeId);
      if (!neighbors || neighbors.size === 0) continue;

      // Count weighted labels among neighbors
      const labelWeights = new Map<number, number>();
      for (const [neighbor, edge] of neighbors) {
        const nLabel = labels.get(neighbor)!;
        labelWeights.set(nLabel, (labelWeights.get(nLabel) ?? 0) + edge.weight);
      }

      // Pick the label with highest total weight
      let bestLabel = labels.get(nodeId)!;
      let bestWeight = -1;
      for (const [label, weight] of labelWeights) {
        if (weight > bestWeight) {
          bestWeight = weight;
          bestLabel = label;
        }
      }

      if (bestLabel !== labels.get(nodeId)) {
        labels.set(nodeId, bestLabel);
        changed = true;
      }
    }
  }

  // Normalize community IDs to sequential 0, 1, 2, ...
  const labelMap = new Map<number, number>();
  let nextId = 0;
  const result = new Map<string, number>();
  for (const [nodeId, label] of labels) {
    if (!labelMap.has(label)) labelMap.set(label, nextId++);
    result.set(nodeId, labelMap.get(label)!);
  }

  return result;
}

/**
 * Get communities as a list of CommunityInfo objects, sorted by size descending.
 */
export function getCommunities(graph: GraphData): CommunityInfo[] {
  const labels = detectCommunities(graph);
  const communities = new Map<number, CommunityInfo>();

  for (const [nodeId, communityId] of labels) {
    const nodeInfo = graph.nodes.get(nodeId);
    if (!nodeInfo) continue;

    if (!communities.has(communityId)) {
      communities.set(communityId, { id: communityId, members: [], size: 0 });
    }
    const c = communities.get(communityId)!;
    c.members.push({ entityId: nodeId, name: nodeInfo.name, type: nodeInfo.type });
    c.size++;
  }

  return [...communities.values()]
    .filter(c => c.size > 1)
    .sort((a, b) => b.size - a.size);
}

// ---------------------------------------------------------------------------
// Entity importance (composite score)
// ---------------------------------------------------------------------------

export function entityImportance(
  db: IDatabase,
  graph: GraphData,
): Map<string, ImportanceResult> {
  const degree = degreeCentrality(graph);
  const between = betweennessCentrality(graph);

  // Normalize values
  const maxDegree = Math.max(1, ...([...degree.values()].map(d => d.degree)));
  const maxBetween = Math.max(1e-10, ...([...between.values()]));
  const maxMentions = Math.max(1, ...([...graph.nodes.values()].map(n => n.mentionCount)));

  const scores = new Map<string, ImportanceResult>();
  const rawScores: { id: string; score: number }[] = [];

  for (const [nodeId, nodeInfo] of graph.nodes) {
    const d = (degree.get(nodeId)?.degree ?? 0) / maxDegree;
    const b = (between.get(nodeId) ?? 0) / maxBetween;
    const m = nodeInfo.mentionCount / maxMentions;

    // Recency factor: query last_seen from DB
    let recency = 0;
    const entity = db.queryOne<{ last_seen: string | null }>('SELECT last_seen FROM entities WHERE id = ?', [nodeId]);
    if (entity?.last_seen) {
      const daysSince = (Date.now() - new Date(entity.last_seen).getTime()) / (1000 * 60 * 60 * 24);
      recency = Math.exp(-daysSince / 90); // 90-day half-life
    }

    // Weighted composite: degree 30%, betweenness 25%, mentions 25%, recency 20%
    const score = 0.30 * d + 0.25 * b + 0.25 * m + 0.20 * recency;
    rawScores.push({ id: nodeId, score });
    scores.set(nodeId, {
      score,
      rank: 0,
      components: { degree: d, betweenness: b, mentions: m, recency },
    });
  }

  // Assign ranks
  rawScores.sort((a, b) => b.score - a.score);
  for (let i = 0; i < rawScores.length; i++) {
    scores.get(rawScores[i].id)!.rank = i + 1;
  }

  return scores;
}

// ---------------------------------------------------------------------------
// Graph stats
// ---------------------------------------------------------------------------

export function graphStats(graph: GraphData): GraphStats {
  const n = graph.nodes.size;
  let edgeCount = 0;
  for (const [, neighbors] of graph.adj) edgeCount += neighbors.size;
  edgeCount = edgeCount / 2; // undirected

  const density = n > 1 ? (2 * edgeCount) / (n * (n - 1)) : 0;
  const avgDegree = n > 0 ? (2 * edgeCount) / n : 0;

  // Connected components (BFS)
  const visited = new Set<string>();
  let componentCount = 0;
  for (const [nodeId] of graph.nodes) {
    if (visited.has(nodeId)) continue;
    componentCount++;
    const queue = [nodeId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      const neighbors = graph.adj.get(current);
      if (neighbors) {
        for (const [neighbor] of neighbors) {
          if (!visited.has(neighbor)) queue.push(neighbor);
        }
      }
    }
  }

  // Top by degree
  const degrees = degreeCentrality(graph);
  const topByDegree = [...degrees.entries()]
    .sort((a, b) => b[1].degree - a[1].degree)
    .slice(0, 10)
    .map(([id, d]) => ({
      id,
      name: graph.nodes.get(id)?.name ?? id,
      degree: d.degree,
    }));

  return { nodeCount: n, edgeCount, density, avgDegree, componentCount, topByDegree };
}

// ---------------------------------------------------------------------------
// Suggestion engine
// ---------------------------------------------------------------------------

export interface SuggestResult {
  missing: { entityA: string; entityB: string; nameA: string; nameB: string; commonNeighbors: number }[];
  fading: { sourceId: string; targetId: string; sourceName: string; targetName: string; weight: number; lastSeen: string }[];
  emerging: { sourceId: string; targetId: string; sourceName: string; targetName: string; seenCount: number; lastSeen: string }[];
}

export function suggestConnections(
  db: IDatabase,
  graph: GraphData,
  opts?: { entityId?: string; type?: 'missing' | 'fading' | 'emerging'; limit?: number },
): SuggestResult {
  const limit = opts?.limit ?? 10;
  const result: SuggestResult = { missing: [], fading: [], emerging: [] };

  const shouldInclude = (t: string) => !opts?.type || opts.type === t;

  // Missing connections: entities sharing many neighbors but no direct edge
  if (shouldInclude('missing')) {
    const targetNodes = opts?.entityId
      ? [opts.entityId]
      : [...graph.nodes.keys()];

    const candidates: SuggestResult['missing'] = [];
    for (const nodeA of targetNodes) {
      const neighborsA = graph.adj.get(nodeA);
      if (!neighborsA) continue;
      const neighborSetA = new Set(neighborsA.keys());

      for (const nodeB of graph.nodes.keys()) {
        if (nodeB <= nodeA) continue; // avoid duplicates
        if (neighborSetA.has(nodeB)) continue; // already connected

        const neighborsB = graph.adj.get(nodeB);
        if (!neighborsB) continue;

        let common = 0;
        for (const n of neighborsB.keys()) {
          if (neighborSetA.has(n)) common++;
        }

        if (common >= 2) {
          candidates.push({
            entityA: nodeA,
            entityB: nodeB,
            nameA: graph.nodes.get(nodeA)?.name ?? nodeA,
            nameB: graph.nodes.get(nodeB)?.name ?? nodeB,
            commonNeighbors: common,
          });
        }
      }
    }

    result.missing = candidates.sort((a, b) => b.commonNeighbors - a.commonNeighbors).slice(0, limit);
  }

  // Fading: high seen_count but old last_seen
  if (shouldInclude('fading')) {
    let sql = `SELECT r.source_id, r.target_id, r.weight, r.last_seen, r.seen_count
               FROM relationships r
               WHERE r.seen_count >= 3 AND r.last_seen IS NOT NULL
               ORDER BY julianday('now') - julianday(r.last_seen) DESC
               LIMIT ?`;
    const params: unknown[] = [limit];
    if (opts?.entityId) {
      sql = `SELECT r.source_id, r.target_id, r.weight, r.last_seen, r.seen_count
             FROM relationships r
             WHERE (r.source_id = ? OR r.target_id = ?) AND r.seen_count >= 3 AND r.last_seen IS NOT NULL
             ORDER BY julianday('now') - julianday(r.last_seen) DESC
             LIMIT ?`;
      params.unshift(opts.entityId, opts.entityId);
    }
    const rows = db.queryAll<any>(sql, params);
    result.fading = rows.map(r => ({
      sourceId: r.source_id,
      targetId: r.target_id,
      sourceName: graph.nodes.get(r.source_id)?.name ?? r.source_id,
      targetName: graph.nodes.get(r.target_id)?.name ?? r.target_id,
      weight: r.weight,
      lastSeen: r.last_seen,
    }));
  }

  // Emerging: recently created with rapidly increasing seen_count
  if (shouldInclude('emerging')) {
    let sql = `SELECT r.source_id, r.target_id, r.seen_count, r.last_seen
               FROM relationships r
               WHERE r.last_seen IS NOT NULL AND r.last_seen >= date('now', '-30 days')
               ORDER BY r.seen_count DESC
               LIMIT ?`;
    const params: unknown[] = [limit];
    if (opts?.entityId) {
      sql = `SELECT r.source_id, r.target_id, r.seen_count, r.last_seen
             FROM relationships r
             WHERE (r.source_id = ? OR r.target_id = ?) AND r.last_seen IS NOT NULL AND r.last_seen >= date('now', '-30 days')
             ORDER BY r.seen_count DESC
             LIMIT ?`;
      params.unshift(opts.entityId, opts.entityId);
    }
    const rows = db.queryAll<any>(sql, params);
    result.emerging = rows.map(r => ({
      sourceId: r.source_id,
      targetId: r.target_id,
      sourceName: graph.nodes.get(r.source_id)?.name ?? r.source_id,
      targetName: graph.nodes.get(r.target_id)?.name ?? r.target_id,
      seenCount: r.seen_count,
      lastSeen: r.last_seen,
    }));
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
