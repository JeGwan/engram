import type { App } from 'obsidian';
import { BaseRenderer } from './base-renderer';
import { el, createSearchInput, createResultCard, createEmptyState, createSelect } from './components';
import type { EngramEngine } from '../engine';

export class KeywordSearchRenderer extends BaseRenderer {
  private resultsContainer: HTMLElement | null = null;
  private currentDirectory = '';
  private app: App;

  constructor(engine: EngramEngine, app: App) {
    super(engine);
    this.app = app;
  }

  render(container: HTMLElement): void {
    this.container = container;
    container.empty();

    const controls = el('div', { class: 'engram-search-controls' });
    controls.appendChild(createSearchInput('Search vault (FTS5)...', q => this.doSearch(q)));

    const stats = this.engine.getStats();
    const dirs = ['', ...stats.directories.map(d => d.name)];
    const select = createSelect(dirs, dir => {
      this.currentDirectory = dir;
    });
    controls.appendChild(select);

    container.appendChild(controls);

    this.resultsContainer = el('div', { class: 'engram-results' });
    this.resultsContainer.appendChild(createEmptyState('Type a query to search...'));
    container.appendChild(this.resultsContainer);
  }

  private doSearch(query: string): void {
    if (!this.resultsContainer) return;
    this.resultsContainer.empty();

    if (!query) {
      this.resultsContainer.appendChild(createEmptyState('Type a query to search...'));
      return;
    }

    try {
      const results = this.engine.search(query, {
        directory: this.currentDirectory || undefined,
      });

      if (results.length === 0) {
        this.resultsContainer.appendChild(createEmptyState(`No results for "${query}"`));
        return;
      }

      for (const r of results) {
        this.resultsContainer.appendChild(
          createResultCard({
            title: r.title,
            path: r.path,
            snippet: r.snippet,
            tags: r.tags,
            onClick: () => {
              const file = this.app.vault.getAbstractFileByPath(r.path);
              if (file) {
                this.app.workspace.openLinkText(r.path, '', false);
              }
            },
          }),
        );
      }
    } catch (err: any) {
      this.resultsContainer.appendChild(createEmptyState(`Search error: ${err.message}`));
    }
  }

  destroy(): void {
    this.resultsContainer = null;
    super.destroy();
  }
}
