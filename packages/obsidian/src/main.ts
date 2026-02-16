import { Notice, Plugin, TFile, TAbstractFile, debounce } from 'obsidian';
import { initSchema } from '@engram/core';
import { SqlJsAdapter } from './adapters/sqljs-adapter';
import { ObsidianVaultReader } from './adapters/obsidian-vault-reader';
import { EngramEngine, DEFAULT_SETTINGS } from './engine';
import type { EngramSettings } from './engine';
import { EngramView, VIEW_TYPE_ENGRAM } from './view';
import { EngramSettingTab } from './settings';
// @ts-ignore — sql.js-fts5 has same API as sql.js, uses its types
import initSqlJs from 'sql.js-fts5';

const DB_FILENAME = 'vault.db';

export default class EngramPlugin extends Plugin {
  settings: EngramSettings = DEFAULT_SETTINGS;
  engine: EngramEngine | null = null;
  private dbAdapter: SqlJsAdapter | null = null;

  private debouncedIndex = debounce(
    (file: TFile) => {
      if (this.engine) {
        this.engine.indexSingleFile(file.path, file.stat.mtime);
      }
    },
    300,
    true,
  );

  async onload(): Promise<void> {
    console.log('[Engram] Loading plugin...');

    await this.loadSettings();
    this.addSettingTab(new EngramSettingTab(this.app, this));

    this.registerView(VIEW_TYPE_ENGRAM, (leaf) => new EngramView(leaf, this));

    this.addRibbonIcon('database', 'Open Engram', () => {
      this.activateView();
    });

    this.addCommand({
      id: 'open-engram-view',
      name: 'Open Engram',
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: 'reindex-vault',
      name: 'Reindex Vault',
      callback: async () => {
        if (!this.engine) return;
        new Notice('Engram: Reindexing vault...');
        const result = await this.engine.fullIndex(true);
        new Notice(`Engram: Indexed ${result.indexed} files in ${result.durationMs}ms`);
        this.refreshViews();
      },
    });

    this.addCommand({
      id: 'engram-search',
      name: 'Search',
      callback: () => {
        this.activateView();
        const view = this.getView();
        if (view) {
          (view as any).switchTab('keyword');
        }
      },
    });

    this.addCommand({
      id: 'run-embedding',
      name: 'Run Embedding',
      callback: async () => {
        if (!this.engine) return;
        new Notice('Engram: Embedding started — check Dashboard for progress');
        try {
          const result = await this.engine.runEmbedding(false);
          new Notice(`Engram: Embedded ${result.embedded} files (${result.errors} errors) in ${Math.round(result.durationMs / 1000)}s`);
          this.refreshViews();
        } catch (e: any) {
          new Notice(`Engram: Embedding failed — ${e.message}`);
        }
      },
    });

    this.addCommand({
      id: 'extract-graph',
      name: 'Extract Graph',
      callback: () => {
        if (!this.engine) return;
        new Notice('Engram: Extracting graph...');
        const result = this.engine.runGraphExtraction();
        new Notice(`Engram: ${result.filesProcessed} files → ${result.entitiesDiscovered} entities, ${result.relationships} rels, ${result.facts} facts (${result.durationMs}ms)`);
        this.refreshViews();
      },
    });

    this.addCommand({
      id: 'load-vectors',
      name: 'Load Vectors',
      callback: () => {
        if (!this.engine) return;
        const count = this.engine.loadVectorCache();
        new Notice(`Engram: Loaded ${count} vectors`);
      },
    });

    this.app.workspace.onLayoutReady(async () => {
      await this.initializeDb();
    });
  }

  async onunload(): Promise<void> {
    console.log('[Engram] Unloading plugin...');
    if (this.dbAdapter) {
      await this.dbAdapter.close();
      this.dbAdapter = null;
    }
    this.engine = null;
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private async initializeDb(): Promise<void> {
    try {
      const wasmPath = `${this.manifest.dir}/sql-wasm.wasm`;
      const wasmBinary = await this.app.vault.adapter.readBinary(wasmPath);
      const SQL = await initSqlJs({ wasmBinary });

      const dbPath = this.getDbPath();
      let dbData: ArrayBuffer | null = null;

      if (await this.app.vault.adapter.exists(dbPath)) {
        dbData = await this.app.vault.adapter.readBinary(dbPath);
      }

      const rawDb = dbData
        ? new SQL.Database(new Uint8Array(dbData))
        : new SQL.Database();

      // Create adapter with save callback
      this.dbAdapter = new SqlJsAdapter(rawDb, async (data: Uint8Array) => {
        await this.app.vault.adapter.writeBinary(dbPath, data.buffer as ArrayBuffer);
      });

      // Run schema migrations
      initSchema(this.dbAdapter);

      // Create vault reader
      const vault = new ObsidianVaultReader(this.app);

      // Create engine
      this.engine = new EngramEngine(this.dbAdapter, vault, this.settings);

      // Auto-index on startup
      if (this.settings.autoIndexOnStartup) {
        const result = await this.engine.fullIndex();
        console.log(`[Engram] Startup index: ${result.indexed} new, ${result.skipped} skipped, ${result.deleted} deleted (${result.durationMs}ms)`);
      }

      // Load vector cache if embeddings enabled
      if (this.settings.embeddingEnabled) {
        const count = this.engine.loadVectorCache();
        console.log(`[Engram] Loaded ${count} vectors`);
      }

      // Register vault events for real-time indexing
      this.registerEvent(
        this.app.vault.on('modify', (file: TAbstractFile) => {
          if (file instanceof TFile && file.extension === 'md') {
            this.debouncedIndex(file);
          }
        }),
      );

      this.registerEvent(
        this.app.vault.on('delete', (file: TAbstractFile) => {
          if (file instanceof TFile && file.extension === 'md') {
            this.engine?.removeFromIndex(file.path);
          }
        }),
      );

      this.registerEvent(
        this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
          if (file instanceof TFile && file.extension === 'md') {
            this.engine?.renameInIndex(oldPath, file.path);
          }
        }),
      );

      console.log('[Engram] Plugin initialized successfully');
      this.refreshViews();
    } catch (err) {
      console.error('[Engram] Failed to initialize:', err);
      new Notice(`Engram: Failed to initialize database: ${err}`);
    }
  }

  private getDbPath(): string {
    return `${this.manifest.dir}/${DB_FILENAME}`;
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_ENGRAM)[0];
    if (!leaf) {
      const rightLeaf = workspace.getRightLeaf(false);
      if (rightLeaf) {
        leaf = rightLeaf;
        await leaf.setViewState({ type: VIEW_TYPE_ENGRAM, active: true });
      }
    }
    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }

  private getView(): EngramView | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_ENGRAM);
    if (leaves.length > 0) {
      return leaves[0].view as EngramView;
    }
    return null;
  }

  private refreshViews(): void {
    const view = this.getView();
    if (view) {
      view.refresh();
    }
  }
}
