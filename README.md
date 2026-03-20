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
ragclaw plugin list        # List plugins with enabled/disabled status
ragclaw plugin enable <n>  # Enable a plugin (or --all)
ragclaw plugin disable <n> # Disable a plugin
ragclaw config list        # Show all config values and sources
ragclaw config get <key>   # Show a single config value
ragclaw config set <key> <value>  # Persist a config value
```

### Options

```bash
-d, --db <name>     # Knowledge base name (default: "default")
-l, --limit <n>     # Max search results
-m, --mode <mode>   # Search mode: vector|keyword|hybrid
-f, --force         # Reindex all (ignore hash)
-p, --prune         # Remove missing sources

# Security flags (for `add` and `reindex`)
--enforce-guards          # Enforce path/URL security guards (default: off)
--no-enforce-guards       # Skip security guards (default)
--allowed-paths <paths>   # Restrict to these paths (comma-separated)
--max-depth <n>           # Max directory recursion depth
--max-files <n>           # Max files per directory source
--allow-urls              # Allow URL sources
--no-allow-urls           # Disallow URL sources
--block-private-urls      # Block private/reserved IPs
--no-block-private-urls   # Allow private/reserved IPs
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

# Enabled plugins (managed via `ragclaw plugin enable/disable`)
plugins: ragclaw-plugin-github, ragclaw-plugin-obsidian

# Allow scanning global npm packages for plugins (default: false)
scanGlobalNpm: true

# Restrict indexing to specific paths (comma-separated, default: unrestricted)
# When set, only files under these paths can be indexed.
# The MCP server defaults to the working directory when no paths are configured.
allowedPaths: ~/projects, ~/docs

# Allow URL sources (default: true)
allowUrls: true

# Block fetches to private/reserved IP ranges (default: true)
blockPrivateUrls: true

# Maximum directory recursion depth (default: 10)
maxDepth: 10

# Maximum files collected from a single directory source (default: 1000)
maxFiles: 1000

# Enforce path/URL guards in the CLI (default: false)
# Enable when the CLI is invoked autonomously (e.g., by a script or AI agent)
# The MCP server always enforces guards regardless of this setting.
enforceGuards: false
```

You can also manage configuration from the CLI:

```bash
ragclaw config list                                  # show all values + sources
ragclaw config get maxDepth                          # show single key
ragclaw config set allowedPaths "~/projects, ~/docs" # persist to config.yaml
```

### Environment Variables

```bash
RAGCLAW_DATA_DIR          # Override data directory
RAGCLAW_PLUGINS_DIR       # Override plugins directory
RAGCLAW_CONFIG_DIR        # Override config directory
RAGCLAW_ALLOWED_PATHS     # Allowed indexing paths (comma-separated)
RAGCLAW_ALLOW_URLS        # Allow URL sources ("true"/"false")
RAGCLAW_BLOCK_PRIVATE_URLS # Block private IPs ("true"/"false")
RAGCLAW_MAX_DEPTH         # Max directory recursion depth
RAGCLAW_MAX_FILES         # Max files per directory source
RAGCLAW_ENFORCE_GUARDS    # Enforce CLI security guards ("true"/"false")
XDG_DATA_HOME             # XDG data home (default: ~/.local/share)
XDG_CONFIG_HOME           # XDG config home (default: ~/.config)
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

Plugins must be **explicitly enabled** before they are loaded. This is a security measure — no plugin runs code until you opt in.

```bash
# Install from npm
npm install -g ragclaw-plugin-youtube

# List installed plugins (shows enabled/disabled status)
ragclaw plugin list

# Enable a plugin
ragclaw plugin enable ragclaw-plugin-youtube

# Enable all discovered plugins at once
ragclaw plugin enable --all

# Now use custom schemes
ragclaw add youtube://dQw4w9WgXcQ
ragclaw add yt://dQw4w9WgXcQ

# Disable a plugin
ragclaw plugin disable ragclaw-plugin-youtube
```

Enabled plugins are stored in your config file (`~/.config/ragclaw/config.yaml`):

```yaml
plugins: ragclaw-plugin-youtube, ragclaw-plugin-github
```

You can also edit this file directly if you prefer.

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
- **Local:** `~/.local/share/ragclaw/plugins/`
- **npm global:** `ragclaw-plugin-*` packages (opt-in, requires `scanGlobalNpm: true` in config)

Override the local plugins directory with `RAGCLAW_PLUGINS_DIR` or the config file.

> **Note:** Global npm scanning is disabled by default to prevent typosquatting attacks. Enable it in `config.yaml` if needed:
> ```yaml
> scanGlobalNpm: true
> ```

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
