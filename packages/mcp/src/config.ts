import path from 'path';
import fs from 'fs';

export interface EngramConfig {
  vaultRoot: string;
  dbPath: string;
  skipDirs: Set<string>;
  embedModelPath: string;
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

  // Model path: defaults to ~/.engram/models/bge-m3-Q8_0.gguf
  const defaultModelPath = path.join(
    process.env.HOME ?? '/tmp',
    '.engram', 'models', 'bge-m3-Q8_0.gguf',
  );
  const embedModelPath = process.env.ENGRAM_EMBED_MODEL ?? defaultModelPath;

  const peopleDir = process.env.ENGRAM_PEOPLE_DIR ?? null;

  config = { vaultRoot, dbPath, skipDirs, embedModelPath, peopleDir };
  return config;
}
