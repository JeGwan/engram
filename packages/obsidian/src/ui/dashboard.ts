import { BaseRenderer } from './base-renderer';
import { el, createStatCard, animateCounters, createDistributionBar } from './components';
import type { EngramEngine } from '../engine';

export class DashboardRenderer extends BaseRenderer {
  private refreshCallback: (() => void) | null = null;

  constructor(engine: EngramEngine, onRefresh?: () => void) {
    super(engine);
    this.refreshCallback = onRefresh ?? null;
  }

  render(container: HTMLElement): void {
    this.container = container;
    container.empty();

    const stats = this.engine.getStats();

    // Stats grid
    const grid = el('div', { class: 'engram-stats-grid' });
    grid.appendChild(createStatCard('Files', stats.files, '📄'));
    grid.appendChild(createStatCard('Embeddings', stats.embeddings, '🧠'));
    grid.appendChild(createStatCard('Entities', stats.entities, '🔗'));
    grid.appendChild(createStatCard('Relationships', stats.relationships, '↔'));
    grid.appendChild(createStatCard('Facts', stats.facts, '💡'));
    container.appendChild(grid);

    requestAnimationFrame(() => animateCounters(grid));

    // ── Actions ──
    container.appendChild(el('h3', { class: 'engram-section-title', text: 'Actions' }));
    const actions = el('div', { class: 'engram-actions' });

    actions.appendChild(this.createActionCard({
      icon: '🔄',
      title: 'Reindex Vault',
      description: 'Full-text index all markdown files',
      buttonText: 'Reindex',
      onClick: async (btn, progress, status) => {
        btn.disabled = true;
        btn.textContent = 'Indexing...';
        status.textContent = 'Scanning vault...';
        progress.style.display = 'block';
        this.setProgress(progress, -1);
        try {
          const result = await this.engine.fullIndex(true);
          status.textContent = `Done — ${result.indexed} indexed, ${result.skipped} skipped, ${result.deleted} deleted (${result.durationMs}ms)`;
          this.setProgress(progress, 100);
          this.refreshAfterDelay();
        } catch (e: any) {
          status.textContent = `Error: ${e.message}`;
        }
        btn.disabled = false;
        btn.textContent = 'Reindex';
      },
    }));

    actions.appendChild(this.createActionCard({
      icon: '🧠',
      title: 'Run Embedding',
      description: `Generate semantic vectors via Ollama (${stats.embeddings} existing)`,
      buttonText: 'Embed',
      onClick: async (btn, progress, status) => {
        btn.disabled = true;
        btn.textContent = 'Embedding...';
        progress.style.display = 'block';
        this.setProgress(progress, 0);

        const ollamaOk = await this.engine.isOllamaAvailable();
        if (!ollamaOk) {
          status.textContent = 'Ollama not running. Start with: ollama serve';
          btn.disabled = false;
          btn.textContent = 'Embed';
          progress.style.display = 'none';
          return;
        }

        status.textContent = 'Starting...';
        try {
          const result = await this.engine.runEmbedding(false, (pct, path) => {
            this.setProgress(progress, pct);
            const filename = path.split('/').pop() ?? path;
            status.textContent = `${pct}% — ${filename}`;
          });
          this.setProgress(progress, 100);
          status.textContent = `Done — ${result.embedded} embedded, ${result.skipped} skipped, ${result.errors} errors (${Math.round(result.durationMs / 1000)}s)`;
          this.refreshAfterDelay();
        } catch (e: any) {
          status.textContent = `Error: ${e.message}`;
        }
        btn.disabled = false;
        btn.textContent = 'Embed';
      },
    }));

    actions.appendChild(this.createActionCard({
      icon: '🕸',
      title: 'Extract Graph',
      description: `Build entity/relationship graph from notes (${stats.entities} entities, ${stats.relationships} rels)`,
      buttonText: 'Extract',
      onClick: async (btn, progress, status) => {
        btn.disabled = true;
        btn.textContent = 'Extracting...';
        progress.style.display = 'block';
        this.setProgress(progress, -1);
        status.textContent = 'Processing files...';
        try {
          await new Promise(r => setTimeout(r, 50));
          const result = this.engine.runGraphExtraction();
          this.setProgress(progress, 100);
          status.textContent = `Done — ${result.filesProcessed} files → ${result.entitiesDiscovered} entities, ${result.relationships} rels, ${result.facts} facts (${result.durationMs}ms)`;
          this.refreshAfterDelay();
        } catch (e: any) {
          status.textContent = `Error: ${e.message}`;
        }
        btn.disabled = false;
        btn.textContent = 'Extract';
      },
    }));

    actions.appendChild(this.createActionCard({
      icon: '📡',
      title: 'Load Vectors',
      description: `Load embeddings into memory for semantic search (${this.engine.getVectorCount()} loaded)`,
      buttonText: 'Load',
      onClick: async (btn, _progress, status) => {
        btn.disabled = true;
        btn.textContent = 'Loading...';
        try {
          const count = this.engine.loadVectorCache();
          status.textContent = `Done — ${count} vectors loaded`;
        } catch (e: any) {
          status.textContent = `Error: ${e.message}`;
        }
        btn.disabled = false;
        btn.textContent = 'Load';
      },
    }));

    container.appendChild(actions);

    // ── Distributions ──
    if (stats.directories.length > 0) {
      container.appendChild(el('h3', { class: 'engram-section-title', text: 'File Distribution' }));
      container.appendChild(createDistributionBar(stats.directories, stats.files));
    }

    if (stats.entityTypes.length > 0) {
      container.appendChild(el('h3', { class: 'engram-section-title', text: 'Entity Types' }));
      container.appendChild(createDistributionBar(
        stats.entityTypes.map(t => ({ name: t.type, count: t.count })),
        stats.entities,
      ));
    }
  }

  private createActionCard(opts: {
    icon: string;
    title: string;
    description: string;
    buttonText: string;
    onClick: (btn: HTMLButtonElement, progress: HTMLElement, status: HTMLElement) => Promise<void>;
  }): HTMLElement {
    const card = el('div', { class: 'engram-action-card' });

    const header = el('div', { class: 'engram-action-header' });
    header.appendChild(el('span', { class: 'engram-action-icon', text: opts.icon }));
    const titleArea = el('div', { class: 'engram-action-title-area' });
    titleArea.appendChild(el('div', { class: 'engram-action-title', text: opts.title }));
    titleArea.appendChild(el('div', { class: 'engram-action-desc', text: opts.description }));
    header.appendChild(titleArea);

    const btn = document.createElement('button');
    btn.className = 'engram-btn';
    btn.textContent = opts.buttonText;
    header.appendChild(btn);

    card.appendChild(header);

    const progressWrapper = el('div', { class: 'engram-progress-wrapper' });
    progressWrapper.style.display = 'none';
    const progressBar = el('div', { class: 'engram-progress-bar' });
    progressWrapper.appendChild(progressBar);
    card.appendChild(progressWrapper);

    const status = el('div', { class: 'engram-action-status' });
    card.appendChild(status);

    btn.addEventListener('click', () => opts.onClick(btn, progressWrapper, status));

    return card;
  }

  private setProgress(wrapper: HTMLElement, pct: number): void {
    const bar = wrapper.querySelector('.engram-progress-bar') as HTMLElement;
    if (!bar) return;

    if (pct < 0) {
      bar.style.width = '100%';
      bar.classList.add('engram-progress-indeterminate');
    } else {
      bar.classList.remove('engram-progress-indeterminate');
      bar.style.width = `${Math.min(pct, 100)}%`;
    }
  }

  private refreshAfterDelay(): void {
    setTimeout(() => {
      if (this.container && this.refreshCallback) {
        this.refreshCallback();
      }
    }, 1500);
  }
}
