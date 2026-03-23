import type { App } from 'obsidian';
import { BaseRenderer } from './base-renderer';
import { el, createSearchInput, createResultCard, createEmptyState, createLoadingSpinner, createSelect } from './components';
import type { EngramEngine } from '../engine';

type SearchMode = 'hybrid' | 'keyword' | 'semantic';

export class SearchRenderer extends BaseRenderer {
  private resultsContainer: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private currentMode: SearchMode = 'hybrid';
  private currentDirectory = '';
  private lastQuery = '';
  private app: App;

  constructor(engine: EngramEngine, app: App) {
    super(engine);
    this.app = app;
  }

  render(container: HTMLElement): void {
    this.container = container;
    container.empty();

    // Status bar
    this.statusEl = el('div', { class: 'engram-semantic-status' });
    this.updateStatus();
    container.appendChild(this.statusEl);

    // Mode switcher
    const modeBar = el('div', { class: 'engram-mode-bar' });
    const modes: { id: SearchMode; label: string; icon: string }[] = [
      { id: 'hybrid', label: 'Hybrid', icon: '⚡' },
      { id: 'keyword', label: 'Keyword', icon: '🔍' },
      { id: 'semantic', label: 'Semantic', icon: '🧠' },
    ];
    for (const mode of modes) {
      const btn = el('button', {
        class: `engram-mode-btn ${mode.id === this.currentMode ? 'engram-mode-active' : ''}`,
      });
      btn.dataset.mode = mode.id;
      btn.appendChild(el('span', { text: mode.icon }));
      btn.appendChild(el('span', { text: ` ${mode.label}` }));
      btn.addEventListener('click', () => this.switchMode(mode.id));
      modeBar.appendChild(btn);
    }
    container.appendChild(modeBar);

    // Search controls
    const controls = el('div', { class: 'engram-search-controls' });
    controls.appendChild(createSearchInput(this.getPlaceholder(), q => this.doSearch(q)));

    const stats = this.engine.getStats();
    const dirs = ['', ...stats.directories.map(d => d.name)];
    controls.appendChild(createSelect(dirs, dir => { this.currentDirectory = dir; }));

    container.appendChild(controls);

    // Results
    this.resultsContainer = el('div', { class: 'engram-results' });
    this.resultsContainer.appendChild(createEmptyState(this.getEmptyMessage()));
    container.appendChild(this.resultsContainer);
  }

  private switchMode(mode: SearchMode): void {
    if (mode === this.currentMode) return;
    this.currentMode = mode;

    // Update active button
    const bar = this.container?.querySelector('.engram-mode-bar');
    if (bar) {
      bar.querySelectorAll('.engram-mode-btn').forEach(btn => {
        const el = btn as HTMLElement;
        if (el.dataset.mode === mode) {
          el.addClass('engram-mode-active');
        } else {
          el.removeClass('engram-mode-active');
        }
      });
    }

    // Update placeholder
    const input = this.container?.querySelector('.engram-search-input') as HTMLInputElement | null;
    if (input) input.placeholder = this.getPlaceholder();

    // Re-search if there's a query
    if (this.lastQuery) {
      this.doSearch(this.lastQuery);
    } else if (this.resultsContainer) {
      this.resultsContainer.empty();
      this.resultsContainer.appendChild(createEmptyState(this.getEmptyMessage()));
    }
  }

  private getPlaceholder(): string {
    switch (this.currentMode) {
      case 'hybrid': return 'Hybrid search (FTS5 + Semantic)...';
      case 'keyword': return 'Keyword search (FTS5)...';
      case 'semantic': return 'Semantic search (Ollama)...';
    }
  }

  private getEmptyMessage(): string {
    switch (this.currentMode) {
      case 'hybrid': return 'Combines keyword + semantic with RRF ranking';
      case 'keyword': return 'Full-text search powered by SQLite FTS5';
      case 'semantic': return 'Meaning-based search via Ollama embeddings';
    }
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
    this.lastQuery = query;
    if (!this.resultsContainer) return;
    this.resultsContainer.empty();

    if (!query) {
      this.resultsContainer.appendChild(createEmptyState(this.getEmptyMessage()));
      return;
    }

    this.resultsContainer.appendChild(createLoadingSpinner());

    try {
      switch (this.currentMode) {
        case 'hybrid':
          await this.searchHybrid(query);
          break;
        case 'keyword':
          this.searchKeyword(query);
          break;
        case 'semantic':
          await this.searchSemantic(query);
          break;
      }
    } catch (err: any) {
      this.resultsContainer.empty();
      this.resultsContainer.appendChild(createEmptyState(`Error: ${err.message}`));
    }
  }

  private async searchHybrid(query: string): Promise<void> {
    const results = await this.engine.hybridSearch(query, 20, {
      directory: this.currentDirectory || undefined,
    });

    this.resultsContainer!.empty();

    if (results.length === 0) {
      this.resultsContainer!.appendChild(createEmptyState(`No results for "${query}"`));
      return;
    }

    for (const r of results) {
      const card = createResultCard({
        title: r.title,
        path: r.path,
        snippet: r.snippet ?? r.heading ?? undefined,
        onClick: () => this.app.workspace.openLinkText(r.path, '', false),
      });

      // Score + source badge group (right side of header)
      const header = card.querySelector('.engram-result-header');
      if (header) {
        const badges = el('span', { class: 'engram-result-badges' });
        badges.appendChild(el('span', {
          class: 'engram-result-score',
          text: r.rrfScore.toFixed(3),
        }));
        badges.appendChild(el('span', {
          class: `engram-source-badge engram-source-${r.sources}`,
          text: r.sources.toUpperCase(),
        }));
        header.appendChild(badges);
      }

      this.resultsContainer!.appendChild(card);
    }
  }

  private searchKeyword(query: string): void {
    const results = this.engine.search(query, {
      directory: this.currentDirectory || undefined,
    });

    this.resultsContainer!.empty();

    if (results.length === 0) {
      this.resultsContainer!.appendChild(createEmptyState(`No results for "${query}"`));
      return;
    }

    for (const r of results) {
      this.resultsContainer!.appendChild(
        createResultCard({
          title: r.title,
          path: r.path,
          snippet: r.snippet,
          tags: r.tags,
          onClick: () => this.app.workspace.openLinkText(r.path, '', false),
        }),
      );
    }
  }

  private async searchSemantic(query: string): Promise<void> {
    const results = await this.engine.semanticSearch(query);

    this.resultsContainer!.empty();

    if (results.length === 0) {
      this.resultsContainer!.appendChild(createEmptyState(`No semantic results for "${query}"`));
      return;
    }

    for (const r of results) {
      this.resultsContainer!.appendChild(
        createResultCard({
          title: r.title,
          path: r.path,
          snippet: r.chunkText,
          score: r.score,
          onClick: () => this.app.workspace.openLinkText(r.path, '', false),
        }),
      );
    }
  }

  destroy(): void {
    this.resultsContainer = null;
    this.statusEl = null;
    super.destroy();
  }
}
