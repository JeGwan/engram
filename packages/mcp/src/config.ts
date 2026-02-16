import path from 'path';
import fs from 'fs';

export interface EngramConfig {
  vaultRoot: string;
  dbPath: string;
  skipDirs: Set<string>;
  ollamaUrl: string;
  ollamaModel: string;
  peopleDir: string | null;
}

let config: EngramConfig | null = null;

export function getConfig(): EngramConfig {
  if (config) return config;

  const vaultRoot = process.env.ENGRAM_VAULT_ROOT;
  if (!vaultRoot) {
    console.error(
      'ERROR: ENGRAM_VAULT_ROOT is not set.\n' +
      'Please set it to the absolute path of your Obsidian vault.\n\n' +
      'Example:\n' +
      '  export ENGRAM_VAULT_ROOT=/path/to/your/vault\n\n' +
      'Or in your MCP config:\n' +
      '  "env": { "ENGRAM_VAULT_ROOT": "/path/to/your/vault" }',
    );
    process.exit(1);
  }

  const dbPath = path.join(vaultRoot, '.engram', 'vault.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const skipDirsRaw = process.env.ENGRAM_SKIP_DIRS ?? 'node_modules,.git,.obsidian,.trash';
  const skipDirs = new Set(skipDirsRaw.split(',').map(s => s.trim()).filter(Boolean));

  const ollamaUrl = process.env.ENGRAM_OLLAMA_URL ?? 'http://localhost:11434';
  const ollamaModel = process.env.ENGRAM_OLLAMA_MODEL ?? 'bge-m3';
  const peopleDir = process.env.ENGRAM_PEOPLE_DIR ?? null;

  config = { vaultRoot, dbPath, skipDirs, ollamaUrl, ollamaModel, peopleDir };
  return config;
}
