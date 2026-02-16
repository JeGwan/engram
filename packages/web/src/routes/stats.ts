import { getVaultStats } from '@engram/core';
import type { RouteContext } from '../server.js';

export function handleStats(ctx: RouteContext) {
  return getVaultStats(ctx.db);
}
