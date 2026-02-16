import type { IDatabase } from './db/interface.js';
import type { VaultStats } from './types.js';

export function getVaultStats(db: IDatabase): VaultStats {
  const files = db.queryOne<{ c: number }>('SELECT COUNT(*) as c FROM files')?.c ?? 0;
  const embeddings = db.queryOne<{ c: number }>('SELECT COUNT(*) as c FROM embeddings')?.c ?? 0;
  const entities = db.queryOne<{ c: number }>('SELECT COUNT(*) as c FROM entities')?.c ?? 0;
  const relationships = db.queryOne<{ c: number }>('SELECT COUNT(*) as c FROM relationships')?.c ?? 0;
  const facts = db.queryOne<{ c: number }>('SELECT COUNT(*) as c FROM facts')?.c ?? 0;

  const directories = db.queryAll<{ name: string; count: number }>(
    'SELECT directory as name, COUNT(*) as count FROM files GROUP BY directory ORDER BY count DESC',
  );
  const entityTypes = db.queryAll<{ type: string; count: number }>(
    'SELECT type, COUNT(*) as count FROM entities GROUP BY type ORDER BY count DESC',
  );

  return { files, embeddings, entities, relationships, facts, directories, entityTypes };
}
