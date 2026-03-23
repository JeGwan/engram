# Engram

A powerful search and knowledge graph plugin for [Obsidian](https://obsidian.md). Index your vault with SQLite FTS5 for instant full-text search, connect to [Ollama](https://ollama.com) for semantic search, and visualize your knowledge as an interactive graph.

## Features

### Full-Text Search (FTS5)
- Instant keyword search powered by SQLite FTS5 running entirely in your browser via WebAssembly
- Highlighted snippets with matched terms
- Filter by directory or tag
- Real-time incremental indexing — edits are reflected immediately

### Semantic Search (Ollama)
- Find notes by meaning, not just keywords
- Uses local Ollama embeddings (bge-m3 by default) — your data never leaves your machine
- Cosine similarity ranking with percentage scores
- **Optional** — works without Ollama; enable when you want deeper search

### Knowledge Graph
- Automatically extract entities (people, projects, organizations) and relationships from your notes
- Interactive network visualization with drag, zoom, and click-to-explore
- Filter by entity type or relationship type
- Detail panel with entity facts and connections

### Dashboard
- Vault statistics at a glance: file count, word count, directory distribution
- Ollama connection status
- One-click actions: reindex, embed, extract graph

### DB Explorer
- Browse the underlying SQLite database directly
- Inspect tables, columns, and rows
- Useful for debugging and advanced queries

## Installation

### From Community Plugins (Recommended)
1. Open Obsidian Settings → Community Plugins
2. Search for **Engram**
3. Click Install, then Enable

### Manual Installation
1. Download `main.js`, `manifest.json`, `styles.css`, and `sql-wasm.wasm` from the [latest release](https://github.com/JeGwan/obsidian-engram/releases/latest)
2. Create a folder `<vault>/.obsidian/plugins/obsidian-engram/`
3. Copy the downloaded files into that folder
4. Restart Obsidian and enable the plugin in Settings → Community Plugins

## Setting Up Semantic Search (Optional)

Semantic search requires [Ollama](https://ollama.com) running locally. This is **entirely optional** — the plugin works great with just keyword search and the knowledge graph.

1. Install Ollama: `brew install ollama` (macOS) or visit [ollama.com](https://ollama.com)
2. Start the server: `ollama serve`
3. Pull the embedding model: `ollama pull bge-m3`
4. In Engram settings, enable "Semantic Search" and click "Run Embedding"

The default model is `bge-m3` (multilingual, 1024-dim). You can change this in settings.

## Commands

| Command | Description |
|---------|-------------|
| Open Engram | Open the Engram panel |
| Reindex Vault | Re-scan all markdown files |
| Search | Jump to keyword search |
| Run Embedding | Generate embeddings for semantic search |
| Extract Graph | Extract entities and relationships |
| Load Vectors | Load embedding vectors into memory |

Access commands via the Command Palette (`Cmd/Ctrl + P`) or use `Cmd/Ctrl + K` inside the Engram panel.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Auto-index on startup | On | Incrementally index changed files when Obsidian starts |
| Skip directories | `node_modules, .git` | Directories to exclude from indexing |
| Enable semantic search | Off | Connect to Ollama for embedding-based search |
| Ollama URL | `http://localhost:11434` | Ollama server address |
| Ollama model | `bge-m3` | Embedding model name |
| People directory | (empty) | Path to your people notes (e.g., `People/`) for graph extraction |

## How It Works

- **Database**: SQLite compiled to WebAssembly via [sql.js-fts5](https://github.com/nicholasgasior/sql.js-fts5), stored in the plugin folder as `vault.db`
- **Indexing**: Parses markdown files, extracts frontmatter/tags/wiki-links, and inserts into FTS5 virtual tables
- **Semantic search**: Calls Ollama's `/api/embeddings` endpoint locally, stores vectors in the database, and performs cosine similarity search in memory
- **Graph extraction**: Rule-based entity and relationship extraction from wiki-links, frontmatter, and heading patterns
- **Real-time updates**: Listens to Obsidian vault events (modify, delete, rename) for incremental indexing

## Mobile Support

The plugin works on mobile devices for keyword search and knowledge graph features. Semantic search requires Ollama, which is a desktop-only service, so it is unavailable on mobile.

## License

[MIT](LICENSE)
