import type { IDatabase } from '../db/interface.js';

export interface ConversationRecord {
  session_id: string;
  date: string;          // 'YYYY-MM-DD HH:MM'
  summary: string;
  topics: string;        // 공백 구분: "클립홈 배포 Engram"
  outcome?: string;
  next_actions?: string;
}

export interface ConversationRow extends ConversationRecord {
  id: number;
  recorded_at: number;
}

export interface SearchConversationsOptions {
  query?: string;
  since?: string;  // 'YYYY-MM-DD'
  until?: string;  // 'YYYY-MM-DD'
  limit?: number;
}

export function addConversation(db: IDatabase, data: ConversationRecord): void {
  db.execute(
    `INSERT OR IGNORE INTO conversations
       (session_id, date, summary, topics, outcome, next_actions, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      data.session_id,
      data.date,
      data.summary,
      data.topics,
      data.outcome ?? null,
      data.next_actions ?? null,
      Date.now(),
    ],
  );
}

export function searchConversations(
  db: IDatabase,
  opts: SearchConversationsOptions,
): ConversationRow[] {
  const { query, since, until, limit = 10 } = opts;
  const params: unknown[] = [];

  if (query) {
    let sql = `
      SELECT c.id, c.session_id, c.date, c.summary, c.topics, c.outcome, c.next_actions, c.recorded_at
      FROM conversations_fts fts
      JOIN conversations c ON c.id = fts.rowid
      WHERE conversations_fts MATCH ?
    `;
    params.push(query);
    if (since) { sql += ' AND c.date >= ?'; params.push(since); }
    if (until) { sql += ' AND c.date <= ?'; params.push(until + ' 99:99'); }
    sql += ' ORDER BY rank LIMIT ?';
    params.push(limit);
    return db.queryAll<ConversationRow>(sql, params);
  } else {
    let sql = `
      SELECT id, session_id, date, summary, topics, outcome, next_actions, recorded_at
      FROM conversations
      WHERE 1=1
    `;
    if (since) { sql += ' AND date >= ?'; params.push(since); }
    if (until) { sql += ' AND date <= ?'; params.push(until + ' 99:99'); }
    sql += ' ORDER BY date DESC LIMIT ?';
    params.push(limit);
    return db.queryAll<ConversationRow>(sql, params);
  }
}
