import type { App } from 'obsidian';
import { BaseRenderer } from './base-renderer';
import { el, createSearchInput, createResultCard, createEmptyState, createLoadingSpinner } from './components';
import type { EngramEngine } from '../engine';

export class SemanticSearchRenderer extends BaseRenderer {
  private resultsContainer: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
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

    container.appendChild(createSearchInput('Semantic search...', q => this.doSearch(q)));

    this.resultsContainer = el('div', { class: 'engram-results' });
    this.resultsContainer.appendChild(createEmptyState('Enter a query for semantic similarity search'));
    container.appendChild(this.resultsContainer);
  }

  private async updateStatus(): Promise<void> {
    if (!this.statusEl) return;
    this.statusEl.empty();

    const vectorCount = this.engine.getVectorCount();
    const available = await this.engine.isOllamaAvailable();

    const statusText = available
      ? `Ollama connected | ${vectorCount} vectors loaded`
      : `Ollama not available | ${vectorCount} vectors loaded`;

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
      this.resultsContainer.appendChild(createEmptyState('Enter a query for semantic similarity search'));
      return;
    }

    this.resultsContainer.appendChild(createLoadingSpinner());

    try {
      const results = await this.engine.semanticSearch(query);

      this.resultsContainer.empty();

      if (results.length === 0) {
        this.resultsContainer.appendChild(createEmptyState(`No semantic results for "${query}"`));
        return;
      }

      for (const r of results) {
        this.resultsContainer.appendChild(
          createResultCard({
            title: r.title,
            path: r.path,
            snippet: r.chunkText,
            score: r.score,
            onClick: () => {
              this.app.workspace.openLinkText(r.path, '', false);
            },
          }),
        );
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
