import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { IDatabase } from '@engram/core';
import { handleStats } from './routes/stats.js';
import { handleSearch, handleSemanticSearch } from './routes/search.js';
import { handleTables, handleTableRows } from './routes/db-explorer.js';
import { handleGraphEntities, handleGraphRelationships, handleGraphFull, handleGraphFacts } from './routes/graph.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface RouteContext {
  url: URL;
  params: Record<string, string>;
  db: IDatabase;
  vectors: import('@engram/core').VectorEntry[];
  ollamaUrl: string;
  ollamaModel: string;
}

type RouteHandler = (ctx: RouteContext) => unknown | Promise<unknown>;

interface Route {
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

const routes: Route[] = [];

function addRoute(pathPattern: string, handler: RouteHandler): void {
  const paramNames: string[] = [];
  const regexStr = pathPattern.replace(/:(\w+)/g, (_match, name) => {
    paramNames.push(name);
    return '([^/]+)';
  });
  routes.push({
    pattern: new RegExp(`^${regexStr}$`),
    paramNames,
    handler,
  });
}

function matchRoute(pathname: string): { handler: RouteHandler; params: Record<string, string> } | null {
  for (const route of routes) {
    const match = pathname.match(route.pattern);
    if (match) {
      const params: Record<string, string> = {};
      route.paramNames.forEach((name, i) => {
        params[name] = decodeURIComponent(match[i + 1]);
      });
      return { handler: route.handler, params };
    }
  }
  return null;
}

// Register API routes
addRoute('/api/stats', handleStats);
addRoute('/api/search', handleSearch);
addRoute('/api/semantic-search', handleSemanticSearch);
addRoute('/api/tables', handleTables);
addRoute('/api/tables/:name/rows', handleTableRows);
addRoute('/api/graph/entities', handleGraphEntities);
addRoute('/api/graph/relationships', handleGraphRelationships);
addRoute('/api/graph/full', handleGraphFull);
addRoute('/api/graph/facts', handleGraphFacts);

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function serveStatic(res: http.ServerResponse, filePath: string): void {
  const ext = path.extname(filePath);
  const mime = MIME_TYPES[ext] ?? 'application/octet-stream';

  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mime });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
}

function sendJson(res: http.ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

export interface WebServerDeps {
  db: IDatabase;
  vectors: import('@engram/core').VectorEntry[];
  ollamaUrl: string;
  ollamaModel: string;
}

function createHttpServer(deps: WebServerDeps): http.Server {
  return http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    if (req.method !== 'GET') {
      sendJson(res, { error: 'Method not allowed' }, 405);
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;

    if (pathname.startsWith('/api/')) {
      const matched = matchRoute(pathname);
      if (matched) {
        try {
          const result = await matched.handler({
            url,
            params: matched.params,
            db: deps.db,
            vectors: deps.vectors,
            ollamaUrl: deps.ollamaUrl,
            ollamaModel: deps.ollamaModel,
          });
          sendJson(res, result);
        } catch (err) {
          console.error(`API error [${pathname}]:`, err);
          sendJson(res, { error: String(err) }, 500);
        }
        return;
      }
      sendJson(res, { error: 'Not found' }, 404);
      return;
    }

    // Static files
    const publicDir = path.resolve(__dirname, '../../public');
    if (pathname === '/' || pathname === '/index.html') {
      serveStatic(res, path.join(publicDir, 'index.html'));
    } else {
      const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
      serveStatic(res, path.join(publicDir, safePath));
    }
  });
}

// --- Shared server state ---

let httpServer: http.Server | null = null;
let activePort: number | null = null;

export function isWebRunning(): boolean {
  return httpServer !== null && httpServer.listening;
}

export function getWebUrl(): string | null {
  return activePort !== null && isWebRunning() ? `http://localhost:${activePort}` : null;
}

export function startWebServer(deps: WebServerDeps, port?: number): Promise<string> {
  if (isWebRunning()) {
    return Promise.resolve(`http://localhost:${activePort}`);
  }

  const p = port ?? parseInt(process.env.ENGRAM_WEB_PORT ?? '3930', 10);
  httpServer = createHttpServer(deps);

  return new Promise((resolve, reject) => {
    httpServer!.once('error', (err: NodeJS.ErrnoException) => {
      httpServer = null;
      activePort = null;
      reject(err);
    });
    httpServer!.listen(p, () => {
      activePort = p;
      const url = `http://localhost:${p}`;
      console.error(`Engram Web UI: ${url}`);
      resolve(url);
    });
  });
}

export function stopWebServer(): Promise<void> {
  if (!httpServer) return Promise.resolve();

  return new Promise((resolve) => {
    httpServer!.close(() => {
      httpServer = null;
      activePort = null;
      console.error('Engram Web UI stopped');
      resolve();
    });
  });
}
