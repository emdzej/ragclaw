# RagClaw 🦞

Local-first RAG engine for OpenClaw. Index and search your documents, code, and web pages — fully offline, no API keys required.

## Features

- **📄 Multi-format** — Markdown, PDF, DOCX, code, web pages, images (OCR)
- **🔍 Hybrid search** — Vector similarity + BM25 keyword search
- **🌳 Code-aware** — Tree-sitter AST parsing for semantic code chunks
- **📱 Portable** — SQLite database, copy anywhere
- **🔌 MCP server** — Works with Codex, Claude Code, OpenCode
- **🧩 Extensible** — Plugin system for custom extractors
- **⚡ Incremental** — Only re-indexes changed files

📖 **[How It Works](docs/HOW_IT_WORKS.md)** — Learn about extraction, chunking, embeddings, and search

## Requirements

- **Node.js 22.x** (LTS) — Node 23+ is not supported due to native module compatibility

## Quick Start

### Install from npm

```bash
npm install -g @emdzej/ragclaw-cli
```

### Install from source

```bash
# Clone
git clone https://github.com/emdzej/ragclaw.git
cd ragclaw

# Ensure Node 22 (required for native modules)
node --version  # Should be v22.x

# Install dependencies
pnpm install

# Build
pnpm build

# Link CLI globally
cd packages/cli && npm link
```

### Usage

```bash
# Index some docs
ragclaw add ./docs/
ragclaw add https://docs.example.com

# Search
ragclaw search "how to configure auth"
```

## Supported Formats

| Type | Extensions |
|------|------------|
| Markdown | `.md`, `.mdx` |
| Text | `.txt` |
| PDF | `.pdf` (with OCR for scanned pages) |
| Word | `.docx` |
| Code | `.ts`, `.js`, `.py`, `.go`, `.java` |
| Images | `.png`, `.jpg`, `.gif`, `.webp`, `.bmp`, `.tiff` (OCR) |
| Web | `http://`, `https://` |

## CLI Commands

```bash
ragclaw add <source>       # Index file, directory, or URL
ragclaw search <query>     # Search knowledge base
ragclaw reindex            # Re-process changed files
ragclaw status             # Show KB statistics
ragclaw list               # List indexed sources
ragclaw remove <source>    # Remove from index
```

### Options

```bash
-d, --db <name>     # Knowledge base name (default: "default")
-l, --limit <n>     # Max search results
-m, --mode <mode>   # Search mode: vector|keyword|hybrid
-f, --force         # Reindex all (ignore hash)
-p, --prune         # Remove missing sources
```

## Storage & Portability

Knowledge bases are stored as SQLite files following XDG Base Directory spec:

```
~/.local/share/ragclaw/       # Data directory (XDG_DATA_HOME)
├── default.sqlite            # Default KB
├── project-a.sqlite          # Named KB
└── plugins/                  # Local plugins

~/.config/ragclaw/            # Config directory (XDG_CONFIG_HOME)
└── config.yaml               # Optional configuration
```

### Configuration

Create `~/.config/ragclaw/config.yaml` to customize paths:

```yaml
# Override data directory
dataDir: ~/my-ragclaw-data

# Override plugins directory
pluginsDir: ~/my-ragclaw-plugins
```

### Environment Variables

```bash
RAGCLAW_DATA_DIR      # Override data directory
RAGCLAW_PLUGINS_DIR   # Override plugins directory
RAGCLAW_CONFIG_DIR    # Override config directory
XDG_DATA_HOME         # XDG data home (default: ~/.local/share)
XDG_CONFIG_HOME       # XDG config home (default: ~/.config)
```

### Backwards Compatibility

If `~/.openclaw/ragclaw/` exists, RagClaw will use it automatically (for existing OpenClaw users).

### Copy/Sync Databases

```bash
# Backup
cp ~/.local/share/ragclaw/default.sqlite ~/backup/

# Sync between machines
rsync -av ~/.local/share/ragclaw/ user@server:~/.local/share/ragclaw/

# Use from different location
ragclaw search "query" -d /path/to/backup.sqlite
```

---

## Integration Setup

### OpenClaw Skill

Copy the `skill/` directory to your OpenClaw workspace:

```bash
cp -r skill/ ~/.openclaw/workspace/skills/ragclaw/
```

Then use `/rag` commands in chat:
```
/rag add ./docs/
/rag search "authentication flow"
```

### MCP Server (Codex / Claude Code / OpenCode)

#### Option 1: Global install

```bash
npm install -g @emdzej/ragclaw-mcp
```

#### Option 2: npx (no install)

Use `npx @emdzej/ragclaw-mcp` as command.

---

### Codex CLI

Add to `~/.codex/config.yaml`:

```yaml
mcpServers:
  ragclaw:
    command: ragclaw-mcp
    # or: command: npx @emdzej/ragclaw-mcp
```

### Claude Code

Add to Claude Code MCP settings:

```json
{
  "mcpServers": {
    "ragclaw": {
      "command": "ragclaw-mcp"
    }
  }
}
```

### OpenCode

Add to `~/.opencode/config.json`:

```json
{
  "mcp": {
    "ragclaw": {
      "command": "ragclaw-mcp"
    }
  }
}
```

### Cursor

Add to Cursor settings (Settings → MCP):

```json
{
  "ragclaw": {
    "command": "ragclaw-mcp"
  }
}
```

### Windsurf

Add to `~/.windsurf/mcp.json`:

```json
{
  "servers": {
    "ragclaw": {
      "command": "ragclaw-mcp"
    }
  }
}
```

---

## MCP Tools

Once configured, these tools are available to AI agents:

| Tool | Description |
|------|-------------|
| `rag_search` | Search knowledge base |
| `rag_add` | Index file/directory/URL |
| `rag_reindex` | Re-process changed sources |
| `rag_status` | Get KB statistics |
| `rag_list` | List indexed sources |
| `rag_remove` | Remove source from index |

**Example prompts:**
```
Index the ./src directory into ragclaw
Search ragclaw for "error handling patterns"
Reindex ragclaw with force=true
```

---

## How It Works

1. **Extract** — Pull text from documents (PDF, DOCX, HTML, code, images via OCR)
2. **Chunk** — Split into semantic units (paragraphs, functions, classes)
3. **Embed** — Generate 768-dim vectors using `nomic-embed-text-v1.5`
4. **Store** — SQLite with FTS5 for keyword search
5. **Search** — Hybrid scoring: 70% vector + 30% BM25

All processing happens locally. No external APIs.

---

## Plugins

Extend RagClaw with custom extractors for additional data sources.

### Using Plugins

```bash
# Install from npm
npm install -g ragclaw-plugin-youtube

# Use custom schemes
ragclaw add youtube://dQw4w9WgXcQ
ragclaw add yt://dQw4w9WgXcQ

# List installed plugins
ragclaw plugin list
```

### Available Plugins

| Plugin | Source | Schemes |
|--------|--------|---------|
| `ragclaw-plugin-github` | GitHub repos, issues, PRs | `github://`, `gh://` |
| `ragclaw-plugin-obsidian` | Obsidian vaults | `obsidian://`, `vault://` |
| `ragclaw-plugin-youtube` | YouTube transcripts | `youtube://`, `yt://` |

### Creating Plugins

```bash
# Scaffold a new plugin
ragclaw plugin create notion

# Creates ragclaw-plugin-notion/ with:
#   package.json
#   tsconfig.json
#   src/index.ts (example extractor)
#   README.md
```

### Plugin Interface

```typescript
import type { RagClawPlugin, Extractor } from "@emdzej/ragclaw-core";

const plugin: RagClawPlugin = {
  name: "ragclaw-plugin-notion",
  version: "0.1.0",
  extractors: [new MyExtractor()],
  schemes: ["notion"],      // URL schemes to handle
  extensions: [".notion"],  // File extensions to handle
};

export default plugin;
```

### Plugin Discovery

Plugins are discovered from:
- **npm global:** `ragclaw-plugin-*` packages
- **Local:** `~/.local/share/ragclaw/plugins/`

Override with `RAGCLAW_PLUGINS_DIR` or config file.

---

## Packages

| Package | Description |
|---------|-------------|
| `@emdzej/ragclaw-core` | Extractors, chunkers, embedder, store |
| `@emdzej/ragclaw-cli` | Command-line interface |
| `@emdzej/ragclaw-mcp` | MCP server for AI tools |

---

## License

MIT
