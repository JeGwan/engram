import type { App, TFile, TFolder, CachedMetadata } from 'obsidian';
import type { IVaultReader, ScannedFile, ParsedNote } from '@engram/core';

const WIKI_LINK_RE = /\[\[([^\]|#]+)(?:[|#][^\]]*)?]]/g;

/**
 * IVaultReader implementation using Obsidian's vault API + metadataCache.
 */
export class ObsidianVaultReader implements IVaultReader {
  constructor(private app: App) {}

  scanMarkdownFiles(skipDirs: Set<string>): ScannedFile[] {
    return this.app.vault.getMarkdownFiles()
      .filter(f => {
        const topDir = f.path.split('/')[0];
        return !skipDirs.has(topDir) && !f.path.startsWith('.');
      })
      .map(f => ({ path: f.path, modifiedAt: f.stat.mtime }));
  }

  async readFile(relativePath: string): Promise<string> {
    const file = this.app.vault.getAbstractFileByPath(relativePath);
    if (!file || !('extension' in file)) {
      throw new Error(`File not found: ${relativePath}`);
    }
    return this.app.vault.cachedRead(file as TFile);
  }

  parseMetadata(relativePath: string, rawContent: string): ParsedNote {
    const file = this.app.vault.getAbstractFileByPath(relativePath) as TFile | null;
    const cache: CachedMetadata | null = file
      ? this.app.metadataCache.getFileCache(file)
      : null;

    const title = relativePath.split('/').pop()?.replace(/\.md$/, '') ?? relativePath;

    // Frontmatter from cache
    const frontmatter: Record<string, unknown> = cache?.frontmatter
      ? { ...cache.frontmatter }
      : {};
    delete (frontmatter as any).position;

    // Tags: combine frontmatter tags + inline tags from cache
    const tagSet = new Set<string>();
    if (cache?.tags) {
      for (const t of cache.tags) {
        tagSet.add(t.tag.replace(/^#/, ''));
      }
    }
    if (cache?.frontmatter?.tags) {
      const fmTags = cache.frontmatter.tags;
      if (Array.isArray(fmTags)) {
        fmTags.forEach((t: string) => tagSet.add(String(t)));
      } else if (typeof fmTags === 'string') {
        fmTags.split(',').forEach((t: string) => tagSet.add(t.trim()));
      }
    }

    // Wiki links from cache + regex fallback
    const wikiLinkSet = new Set<string>();
    if (cache?.links) {
      for (const link of cache.links) {
        wikiLinkSet.add(link.link.split('#')[0].split('|')[0].trim());
      }
    }
    let match: RegExpExecArray | null;
    const re = new RegExp(WIKI_LINK_RE.source, 'g');
    while ((match = re.exec(rawContent)) !== null) {
      wikiLinkSet.add(match[1].trim());
    }

    // Strip frontmatter from content for FTS
    let content = rawContent;
    if (rawContent.startsWith('---')) {
      const endIdx = rawContent.indexOf('---', 3);
      if (endIdx !== -1) {
        content = rawContent.slice(endIdx + 3).trim();
      }
    }

    return {
      title,
      content,
      tags: [...tagSet],
      frontmatter,
      wikiLinks: [...wikiLinkSet],
    };
  }

  directoryExists(relativePath: string): boolean {
    const abstractFile = this.app.vault.getAbstractFileByPath(relativePath);
    return abstractFile !== null && !('extension' in abstractFile);
  }

  listSubdirectories(relativePath: string): string[] {
    const folder = this.app.vault.getAbstractFileByPath(relativePath);
    if (!folder || 'extension' in folder) return [];
    return ((folder as TFolder).children ?? [])
      .filter((c: any) => !('extension' in c))
      .map((c: any) => c.name);
  }

  async readFileIfExists(relativePath: string): Promise<string | null> {
    const file = this.app.vault.getAbstractFileByPath(relativePath);
    if (!file || !('extension' in file)) return null;
    return this.app.vault.cachedRead(file as TFile);
  }
}
