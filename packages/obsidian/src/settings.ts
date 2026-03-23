import { App, PluginSettingTab, Setting } from 'obsidian';
import type EngramPlugin from './main';

export class EngramSettingTab extends PluginSettingTab {
  plugin: EngramPlugin;

  constructor(app: App, plugin: EngramPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Engram Settings' });

    // ── Indexing ──
    containerEl.createEl('h3', { text: 'Indexing' });

    new Setting(containerEl)
      .setName('Auto-index on startup')
      .setDesc('Automatically index vault files when Obsidian starts')
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.autoIndexOnStartup)
          .onChange(async (value) => {
            this.plugin.settings.autoIndexOnStartup = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Skip directories')
      .setDesc('Comma-separated list of top-level directories to skip during indexing')
      .addText(text =>
        text
          .setPlaceholder('node_modules, .git')
          .setValue(this.plugin.settings.skipDirectories.join(', '))
          .onChange(async (value) => {
            this.plugin.settings.skipDirectories = value.split(',').map(s => s.trim()).filter(Boolean);
            await this.plugin.saveSettings();
          })
      );

    // ── Ollama / Embeddings ──
    containerEl.createEl('h3', { text: 'Semantic Search (Ollama)' });

    new Setting(containerEl)
      .setName('Enable embeddings')
      .setDesc('Enable semantic search using Ollama embeddings. Requires Ollama to be running locally.')
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.embeddingEnabled)
          .onChange(async (value) => {
            this.plugin.settings.embeddingEnabled = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Ollama URL')
      .setDesc('URL of the Ollama server')
      .addText(text =>
        text
          .setPlaceholder('http://localhost:11434')
          .setValue(this.plugin.settings.ollamaUrl)
          .onChange(async (value) => {
            this.plugin.settings.ollamaUrl = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Embedding model')
      .setDesc('Ollama model to use for embeddings')
      .addText(text =>
        text
          .setPlaceholder('bge-m3')
          .setValue(this.plugin.settings.ollamaModel)
          .onChange(async (value) => {
            this.plugin.settings.ollamaModel = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Vector loading mode')
      .setDesc('Controls when embedding vectors are loaded into memory at startup')
      .addDropdown(dropdown =>
        dropdown
          .addOption('auto', 'Auto (threshold-based)')
          .addOption('always', 'Always load')
          .addOption('never', 'Manual only')
          .setValue(this.plugin.settings.vectorLoadMode)
          .onChange(async (value) => {
            this.plugin.settings.vectorLoadMode = value as 'auto' | 'always' | 'never';
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Auto-load threshold (MB)')
      .setDesc('In auto mode, vectors are loaded at startup only if total size is below this threshold')
      .addText(text =>
        text
          .setPlaceholder('100')
          .setValue(String(this.plugin.settings.vectorAutoLoadThresholdMB))
          .onChange(async (value) => {
            const num = parseInt(value, 10);
            if (!isNaN(num) && num > 0) {
              this.plugin.settings.vectorAutoLoadThresholdMB = num;
              await this.plugin.saveSettings();
            }
          })
      );

    // ── Graph ──
    containerEl.createEl('h3', { text: 'Knowledge Graph' });

    new Setting(containerEl)
      .setName('Enable graph extraction')
      .setDesc('Enable automatic entity/relationship extraction from vault files')
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.graphExtractionEnabled)
          .onChange(async (value) => {
            this.plugin.settings.graphExtractionEnabled = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('People directory')
      .setDesc('Relative path to the people directory (e.g., "5-사람")')
      .addText(text =>
        text
          .setPlaceholder('5-사람')
          .setValue(this.plugin.settings.peopleDir)
          .onChange(async (value) => {
            this.plugin.settings.peopleDir = value;
            await this.plugin.saveSettings();
          })
      );

    // ── Actions ──
    containerEl.createEl('h3', { text: 'Actions' });

    new Setting(containerEl)
      .setName('Reindex vault')
      .setDesc('Force a full reindex of all vault files')
      .addButton(button =>
        button
          .setButtonText('Reindex')
          .setCta()
          .onClick(async () => {
            button.setDisabled(true);
            button.setButtonText('Indexing...');
            try {
              const result = await this.plugin.engine?.fullIndex(true);
              if (result) {
                button.setButtonText(`Done (${result.indexed} files)`);
              }
            } catch (e: any) {
              button.setButtonText(`Error: ${e.message}`);
            }
            setTimeout(() => {
              button.setDisabled(false);
              button.setButtonText('Reindex');
            }, 3000);
          })
      );

    new Setting(containerEl)
      .setName('Run embedding')
      .setDesc('Generate embeddings for all unprocessed files')
      .addButton(button =>
        button
          .setButtonText('Embed')
          .onClick(async () => {
            button.setDisabled(true);
            button.setButtonText('Embedding...');
            try {
              const result = await this.plugin.engine?.runEmbedding();
              if (result) {
                button.setButtonText(`Done (${result.embedded} files)`);
              }
            } catch (e: any) {
              button.setButtonText(`Error: ${e.message}`);
            }
            setTimeout(() => {
              button.setDisabled(false);
              button.setButtonText('Embed');
            }, 3000);
          })
      );

    new Setting(containerEl)
      .setName('Extract graph')
      .setDesc('Run entity/relationship extraction from indexed files')
      .addButton(button =>
        button
          .setButtonText('Extract')
          .onClick(async () => {
            button.setDisabled(true);
            button.setButtonText('Extracting...');
            try {
              const result = this.plugin.engine?.runGraphExtraction();
              if (result) {
                button.setButtonText(`Done (${result.filesProcessed} files)`);
              }
            } catch (e: any) {
              button.setButtonText(`Error: ${e.message}`);
            }
            setTimeout(() => {
              button.setDisabled(false);
              button.setButtonText('Extract');
            }, 3000);
          })
      );
  }
}
