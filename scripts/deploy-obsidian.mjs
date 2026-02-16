#!/usr/bin/env node
/**
 * Deploy @engram/obsidian plugin to the Obsidian vault.
 *
 * Usage:
 *   node scripts/deploy-obsidian.mjs [vault-path]
 *
 * Default vault: /Users/user/Projects/Naver
 */

import { copyFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const root = join(__dirname, '..');
const obsidianPkg = join(root, 'packages', 'obsidian');

const vaultPath = process.argv[2] || '/Users/user/Projects/Naver';
const pluginDir = join(vaultPath, '.obsidian', 'plugins', 'obsidian-engram');

if (!existsSync(join(vaultPath, '.obsidian'))) {
  console.error(`Not an Obsidian vault: ${vaultPath}`);
  process.exit(1);
}

mkdirSync(pluginDir, { recursive: true });

const files = ['main.js', 'manifest.json', 'styles.css', 'sql-wasm.wasm'];
for (const f of files) {
  const src = join(obsidianPkg, f);
  if (!existsSync(src)) {
    console.warn(`  SKIP ${f} (not found)`);
    continue;
  }
  copyFileSync(src, join(pluginDir, f));
  console.log(`  ${f} → ${pluginDir}/`);
}

console.log('\nDeploy complete. Reload Obsidian to pick up changes.');
