import { ItemView, Notice, WorkspaceLeaf } from 'obsidian';
import type EngramPlugin from './main';
import { DashboardRenderer } from './ui/dashboard';
import { SearchRenderer } from './ui/search';
import { GraphViewRenderer } from './ui/graph-view';
import { CommandPalette } from './ui/command-palette';
import { el } from './ui/components';
import type { BaseRenderer } from './ui/base-renderer';

export const VIEW_TYPE_ENGRAM = 'engram-view';

type TabId = 'dashboard' | 'search' | 'graph';

interface TabDef {
  id: TabId;
  label: string;
  icon: string;
}

const TABS: TabDef[] = [
  { id: 'dashboard', label: 'Dashboard', icon: '📊' },
  { id: 'search', label: 'Search', icon: '🔍' },
  { id: 'graph', label: 'Graph', icon: '🕸' },
];

export class EngramView extends ItemView {
  private plugin: EngramPlugin;
  private activeTab: TabId = 'dashboard';
  private currentRenderer: BaseRenderer | null = null;
  private contentContainer: HTMLElement | null = null;
  private palette: CommandPalette;

  constructor(leaf: WorkspaceLeaf, plugin: EngramPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.palette = new CommandPalette();
  }

  getViewType(): string {
    return VIEW_TYPE_ENGRAM;
  }

  getDisplayText(): string {
    return 'Engram';
  }

  getIcon(): string {
    return 'database';
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('engram-view-root');

    const nav = el('div', { class: 'engram-nav' });
    for (const tab of TABS) {
      const btn = el('button', {
        class: `engram-nav-btn ${tab.id === this.activeTab ? 'engram-nav-active' : ''}`,
      });
      btn.dataset.tabId = tab.id;
      btn.appendChild(el('span', { class: 'engram-nav-icon', text: tab.icon }));
      btn.appendChild(el('span', { class: 'engram-nav-label', text: tab.label }));
      btn.addEventListener('click', () => this.switchTab(tab.id));
      nav.appendChild(btn);
    }
    container.appendChild(nav);

    this.contentContainer = el('div', { class: 'engram-content' });
    container.appendChild(this.contentContainer);

    this.renderActiveTab();

    this.registerDomEvent(container, 'keydown', (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        this.openPalette();
      }
    });
  }

  async onClose(): Promise<void> {
    this.currentRenderer?.destroy();
    this.currentRenderer = null;
    this.palette.close();
  }

  switchTab(tabId: TabId): void {
    if (tabId === this.activeTab) return;

    this.activeTab = tabId;

    const nav = this.containerEl.querySelector('.engram-nav');
    if (nav) {
      nav.querySelectorAll('.engram-nav-btn').forEach(btn => {
        const el = btn as HTMLElement;
        if (el.dataset.tabId === tabId) {
          el.addClass('engram-nav-active');
        } else {
          el.removeClass('engram-nav-active');
        }
      });
    }

    this.renderActiveTab();
  }

  private renderActiveTab(): void {
    if (!this.contentContainer) return;

    this.currentRenderer?.destroy();
    this.currentRenderer = null;
    this.contentContainer.empty();

    const engine = this.plugin.engine;
    if (!engine) {
      this.contentContainer.setText('Engram engine not initialized');
      return;
    }

    switch (this.activeTab) {
      case 'dashboard':
        this.currentRenderer = new DashboardRenderer(engine, () => this.renderActiveTab());
        break;
      case 'search':
        this.currentRenderer = new SearchRenderer(engine, this.app);
        break;
      case 'graph':
        this.currentRenderer = new GraphViewRenderer(engine);
        break;
    }

    if (this.currentRenderer) {
      this.currentRenderer.render(this.contentContainer);
    }
  }

  private openPalette(): void {
    if (this.palette.isOpen()) {
      this.palette.close();
      return;
    }

    const engine = this.plugin.engine;
    if (!engine) return;

    this.palette.setCommands([
      { id: 'dashboard', name: 'Go to Dashboard', icon: '📊', callback: () => this.switchTab('dashboard') },
      { id: 'search', name: 'Search', icon: '🔍', callback: () => this.switchTab('search') },
      { id: 'graph', name: 'Knowledge Graph', icon: '🕸', callback: () => this.switchTab('graph') },
      {
        id: 'reindex', name: 'Reindex Vault', icon: '🔄',
        callback: async () => {
          const result = await engine.fullIndex(true);
          new Notice(`Engram: Reindexed ${result.indexed} files (${result.durationMs}ms)`);
          this.renderActiveTab();
        },
      },
      {
        id: 'embed', name: 'Run Embedding', icon: '🧠',
        callback: async () => {
          try {
            const result = await engine.runEmbedding();
            new Notice(`Engram: Embedded ${result.embedded} files (${result.errors} errors)`);
            this.renderActiveTab();
          } catch (e: any) {
            new Notice(`Engram: Embedding failed — ${e.message}`);
          }
        },
      },
      {
        id: 'extract', name: 'Extract Graph', icon: '🕸',
        callback: () => {
          const result = engine.runGraphExtraction();
          new Notice(`Engram: ${result.entitiesDiscovered} entities, ${result.relationships} rels`);
          this.renderActiveTab();
        },
      },
    ]);

    const container = this.containerEl.children[1] as HTMLElement;
    this.palette.open(container);
  }

  refresh(): void {
    this.renderActiveTab();
  }
}
