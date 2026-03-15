import type { IDatabase } from './interface.js';

export function initSchema(db: IDatabase): void {
  const version = getSchemaVersion(db);

  if (version < 1) {
    db.execMulti(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY,
        path TEXT UNIQUE NOT NULL,
        title TEXT,
        directory TEXT,
        tags TEXT,
        frontmatter TEXT,
        wiki_links TEXT,
        content TEXT,
        modified_at INTEGER,
        indexed_at INTEGER
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
        title, content, tags,
        content=files, content_rowid=id
      );

      CREATE TRIGGER IF NOT EXISTS files_ai AFTER INSERT ON files BEGIN
        INSERT INTO files_fts(rowid, title, content, tags)
        VALUES (new.id, new.title, new.content, new.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS files_ad AFTER DELETE ON files BEGIN
        INSERT INTO files_fts(files_fts, rowid, title, content, tags)
        VALUES ('delete', old.id, old.title, old.content, old.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS files_au AFTER UPDATE ON files BEGIN
        INSERT INTO files_fts(files_fts, rowid, title, content, tags)
        VALUES ('delete', old.id, old.title, old.content, old.tags);
        INSERT INTO files_fts(rowid, title, content, tags)
        VALUES (new.id, new.title, new.content, new.tags);
      END;

      CREATE INDEX IF NOT EXISTS idx_files_directory ON files(directory);
      CREATE INDEX IF NOT EXISTS idx_files_modified_at ON files(modified_at);
    `);
    setSchemaVersion(db, 1);
  }

  if (version < 2) {
    db.execMulti(`
      CREATE TABLE IF NOT EXISTS embeddings (
        id INTEGER PRIMARY KEY,
        file_id INTEGER REFERENCES files(id) ON DELETE CASCADE,
        chunk_index INTEGER,
        chunk_text TEXT,
        heading TEXT,
        embedding BLOB,
        UNIQUE(file_id, chunk_index)
      );

      CREATE INDEX IF NOT EXISTS idx_embeddings_file_id ON embeddings(file_id);
    `);
    setSchemaVersion(db, 2);
  }

  if (version < 3) {
    db.execMulti(`
      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        aliases TEXT,
        metadata TEXT,
        source_path TEXT
      );

      CREATE TABLE IF NOT EXISTS relationships (
        id INTEGER PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES entities(id),
        target_id TEXT NOT NULL REFERENCES entities(id),
        type TEXT NOT NULL,
        context TEXT,
        valid_from TEXT,
        valid_until TEXT,
        source_file TEXT
      );

      CREATE TABLE IF NOT EXISTS facts (
        id INTEGER PRIMARY KEY,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        entity_ids TEXT,
        recorded_at TEXT,
        valid_until TEXT,
        source_file TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
      CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
      CREATE INDEX IF NOT EXISTS idx_relationships_source ON relationships(source_id);
      CREATE INDEX IF NOT EXISTS idx_relationships_target ON relationships(target_id);
      CREATE INDEX IF NOT EXISTS idx_relationships_type ON relationships(type);
      CREATE INDEX IF NOT EXISTS idx_facts_type ON facts(type);
      CREATE INDEX IF NOT EXISTS idx_facts_recorded ON facts(recorded_at);
    `);
    setSchemaVersion(db, 3);
  }

  if (version < 4) {
    db.execMulti(`ALTER TABLE files ADD COLUMN graph_extracted_at INTEGER`);
    setSchemaVersion(db, 4);
  }

  if (version < 5) {
    db.execMulti(`ALTER TABLE files ADD COLUMN embedded_at INTEGER`);
    db.execMulti(`
      UPDATE files SET embedded_at = indexed_at
      WHERE id IN (SELECT DISTINCT file_id FROM embeddings)
    `);
    setSchemaVersion(db, 5);
  }

  if (version < 6) {
    db.execMulti(`
      CREATE TABLE IF NOT EXISTS conversations (
        id           INTEGER PRIMARY KEY,
        session_id   TEXT UNIQUE NOT NULL,
        date         TEXT NOT NULL,
        summary      TEXT NOT NULL,
        topics       TEXT NOT NULL DEFAULT '',
        outcome      TEXT,
        next_actions TEXT,
        recorded_at  INTEGER NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS conversations_fts USING fts5(
        summary, topics, outcome, next_actions,
        content=conversations, content_rowid=id
      );

      CREATE TRIGGER IF NOT EXISTS conv_ai AFTER INSERT ON conversations BEGIN
        INSERT INTO conversations_fts(rowid, summary, topics, outcome, next_actions)
        VALUES (new.id, new.summary, new.topics, new.outcome, new.next_actions);
      END;

      CREATE TRIGGER IF NOT EXISTS conv_ad AFTER DELETE ON conversations BEGIN
        INSERT INTO conversations_fts(conversations_fts, rowid, summary, topics, outcome, next_actions)
        VALUES ('delete', old.id, old.summary, old.topics, old.outcome, old.next_actions);
      END;

      CREATE TRIGGER IF NOT EXISTS conv_au AFTER UPDATE ON conversations BEGIN
        INSERT INTO conversations_fts(conversations_fts, rowid, summary, topics, outcome, next_actions)
        VALUES ('delete', old.id, old.summary, old.topics, old.outcome, old.next_actions);
        INSERT INTO conversations_fts(rowid, summary, topics, outcome, next_actions)
        VALUES (new.id, new.summary, new.topics, new.outcome, new.next_actions);
      END;

      CREATE INDEX IF NOT EXISTS idx_conversations_date ON conversations(date);
    `);
    setSchemaVersion(db, 6);
  }
}

function getSchemaVersion(db: IDatabase): number {
  try {
    const row = db.queryOne<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'");
    return row ? parseInt(row.value, 10) : 0;
  } catch {
    return 0;
  }
}

function setSchemaVersion(db: IDatabase, version: number): void {
  db.execute(
    "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)",
    [String(version)]
  );
}
