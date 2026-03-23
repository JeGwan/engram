import type { App } from 'obsidian';
import { BaseRenderer } from './base-renderer';
import { el, createSearchInput, createResultCard, createEmptyState, createLoadingSpinner, createSelect } from './components';
import type { EngramEngine } from '../engine';

export class HybridSearchRenderer extends BaseRenderer {
  private resultsContainer: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private currentDirectory = '';
  private app: App;

  constructor(engine: EngramEngine, app: App) {
    super(engine);
    this.app = app;
  }

  render(container: HTMLElement): void {
    this.container = container;
    container.empty();

    this.statusEl = el('div', { class: 'engram-semantic-status' });
    this.updateStatus();
    container.appendChild(this.statusEl);

    const controls = el('div', { class: 'engram-search-controls' });
    controls.appendChild(createSearchInput('Hybrid search (FTS5 + Semantic)...', q => this.doSearch(q)));

    const stats = this.engine.getStats();
    const dirs = ['', ...stats.directories.map(d => d.name)];
    const select = createSelect(dirs, dir => {
      this.currentDirectory = dir;
    });
    controls.appendChild(select);

    container.appendChild(controls);

    this.resultsContainer = el('div', { class: 'engram-results' });
    this.resultsContainer.appendChild(createEmptyState('Combines keyword + semantic search with RRF ranking'));
    container.appendChild(this.resultsContainer);
  }

  private async updateStatus(): Promise<void> {
    if (!this.statusEl) return;
    this.statusEl.empty();

    const vectorCount = this.engine.getVectorCount();
    const available = await this.engine.isOllamaAvailable();

    const statusText = available
      ? `Ollama connected | ${vectorCount} vectors`
      : `Ollama not available | ${vectorCount} vectors`;

    const dot = el('span', {
      class: available ? 'engram-status-dot engram-status-online' : 'engram-status-dot engram-status-offline',
    });
    this.statusEl.appendChild(dot);
    this.statusEl.appendText(` ${statusText}`);
  }

  private async doSearch(query: string): Promise<void> {
    if (!this.resultsContainer) return;
    this.resultsContainer.empty();

    if (!query) {
      this.resultsContainer.appendChild(createEmptyState('Combines keyword + semantic search with RRF ranking'));
      return;
    }

    this.resultsContainer.appendChild(createLoadingSpinner());

    try {
      const results = await this.engine.hybridSearch(query, 20, {
        directory: this.currentDirectory || undefined,
      });

      this.resultsContainer.empty();

      if (results.length === 0) {
        this.resultsContainer.appendChild(createEmptyState(`No results for "${query}"`));
        return;
      }

      for (const r of results) {
        const card = createResultCard({
          title: r.title,
          path: r.path,
          snippet: r.snippet ?? r.heading ?? undefined,
          score: r.rrfScore,
          onClick: () => {
            this.app.workspace.openLinkText(r.path, '', false);
          },
        });

        // Add source badge
        const badge = el('span', {
          class: `engram-source-badge engram-source-${r.sources}`,
          text: r.sources.toUpperCase(),
        });
        const header = card.querySelector('.engram-result-header');
        if (header) header.appendChild(badge);

        this.resultsContainer!.appendChild(card);
      }
    } catch (err: any) {
      this.resultsContainer.empty();
      this.resultsContainer.appendChild(createEmptyState(`Error: ${err.message}`));
    }
  }

  destroy(): void {
    this.resultsContainer = null;
    this.statusEl = null;
    super.destroy();
  }
}
