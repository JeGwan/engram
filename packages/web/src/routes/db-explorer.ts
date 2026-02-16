import type { RouteContext } from '../server.js';

export function handleTables(ctx: RouteContext) {
  const tables = ctx.db.queryAll<{ name: string; sql: string }>(
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );

  return tables.map(t => {
    const columns = ctx.db.pragma<Array<{
      cid: number; name: string; type: string; notnull: number; pk: number;
    }>>(`table_info(${t.name})`);
    const rowCount = ctx.db.queryOne<{ c: number }>(`SELECT COUNT(*) as c FROM "${t.name}"`)?.c ?? 0;
    return {
      name: t.name,
      sql: t.sql,
      columns: (columns as any[]).map((c: any) => ({
        name: c.name,
        type: c.type,
        notnull: !!c.notnull,
        pk: !!c.pk,
      })),
      rowCount,
    };
  });
}

export function handleTableRows(ctx: RouteContext) {
  const tableName = ctx.params.name;

  // Whitelist
  const validTables = ctx.db.queryAll<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  );
  const tableNames = new Set(validTables.map(t => t.name));
  if (!tableNames.has(tableName)) {
    return { error: `Table '${tableName}' not found`, columns: [] as string[], rows: [], total: 0 };
  }

  const columns = (ctx.db.pragma<Array<{ name: string }>>(`table_info(${tableName})`) as any[]).map(
    (c: any) => c.name as string,
  );

  const limit = Math.min(parseInt(ctx.url.searchParams.get('limit') ?? '50', 10), 500);
  const offset = parseInt(ctx.url.searchParams.get('offset') ?? '0', 10);
  const sort = ctx.url.searchParams.get('sort') ?? '';
  const order = ctx.url.searchParams.get('order') === 'desc' ? 'DESC' : 'ASC';

  const total = ctx.db.queryOne<{ c: number }>(`SELECT COUNT(*) as c FROM "${tableName}"`)?.c ?? 0;

  let sql = `SELECT * FROM "${tableName}"`;
  if (sort && columns.includes(sort)) {
    sql += ` ORDER BY "${sort}" ${order}`;
  }
  sql += ` LIMIT ${limit} OFFSET ${offset}`;

  const rows = ctx.db.queryAll<Record<string, unknown>>(sql);

  const truncatedRows = rows.map(row => {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(row)) {
      if (typeof val === 'string' && val.length > 500) {
        out[key] = val.slice(0, 500) + '...';
      } else if (val instanceof Uint8Array) {
        out[key] = `[BLOB ${val.length} bytes]`;
      } else {
        out[key] = val;
      }
    }
    return out;
  });

  return { columns, rows: truncatedRows, total, limit, offset };
}
