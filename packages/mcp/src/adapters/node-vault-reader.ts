import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';
import type { IVaultReader, ScannedFile, ParsedNote } from '@engram/core';

const SKIP_PREFIXES = ['.'];
const WIKI_LINK_RE = /\[\[([^\]|#]+)(?:[|#][^\]]*)?]]/g;

export class NodeVaultReader implements IVaultReader {
  constructor(private vaultRoot: string) {}

  scanMarkdownFiles(skipDirs: Set<string>): ScannedFile[] {
    const results: ScannedFile[] = [];
    this.walkDir(this.vaultRoot, skipDirs, results);
    return results;
  }

  async readFile(relativePath: string): Promise<string> {
    const fullPath = path.join(this.vaultRoot, relativePath);
    return fs.readFileSync(fullPath, 'utf-8');
  }

  parseMetadata(relativePath: string, rawContent: string): ParsedNote {
    const { data: frontmatter, content } = matter(rawContent);

    const fileName = relativePath.split('/').pop() ?? relativePath;
    const title = fileName.replace(/\.md$/, '');

    let tags: string[] = [];
    if (Array.isArray(frontmatter.tags)) {
      tags = frontmatter.tags.map(String);
    } else if (typeof frontmatter.tags === 'string') {
      tags = frontmatter.tags.split(',').map((t: string) => t.trim());
    }

    const inlineTags = content.match(/#[\w가-힣-]+/g) ?? [];
    tags = [...new Set([...tags, ...inlineTags.map(t => t.replace(/^#/, ''))])];

    const wikiLinks: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = WIKI_LINK_RE.exec(content)) !== null) {
      wikiLinks.push(match[1].trim());
    }

    return { title, content, tags, frontmatter, wikiLinks: [...new Set(wikiLinks)] };
  }

  directoryExists(relativePath: string): boolean {
    const fullPath = path.join(this.vaultRoot, relativePath);
    try {
      return fs.statSync(fullPath).isDirectory();
    } catch {
      return false;
    }
  }

  listSubdirectories(relativePath: string): string[] {
    const fullPath = path.join(this.vaultRoot, relativePath);
    try {
      return fs.readdirSync(fullPath, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name);
    } catch {
      return [];
    }
  }

  async readFileIfExists(relativePath: string): Promise<string | null> {
    const fullPath = path.join(this.vaultRoot, relativePath);
    try {
      return fs.readFileSync(fullPath, 'utf-8');
    } catch {
      return null;
    }
  }

  private walkDir(dir: string, skipDirs: Set<string>, results: ScannedFile[]): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (SKIP_PREFIXES.some(p => entry.name.startsWith(p))) continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        this.walkDir(fullPath, skipDirs, results);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const stat = fs.statSync(fullPath);
        const relativePath = path.relative(this.vaultRoot, fullPath);
        results.push({
          path: relativePath,
          modifiedAt: stat.mtimeMs,
        });
      }
    }
  }
}
