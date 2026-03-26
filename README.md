# RagClaw 🦞

[![npm version](https://img.shields.io/npm/v/@emdzej/ragclaw-cli.svg)](https://www.npmjs.com/package/@emdzej/ragclaw-cli)
[![CI](https://github.com/emdzej/ragclaw/actions/workflows/ci.yaml/badge.svg)](https://github.com/emdzej/ragclaw/actions/workflows/ci.yaml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org/)

Local-first RAG engine for OpenClaw. Index and search your documents, code, and web pages — fully offline, no API keys required.

> ⚠️ **Pre-1.0 Warning:** Until version 1.0.0, any release may contain breaking changes. Pin your versions in production.

## Features

- **📄 Multi-format** — Markdown, PDF, DOCX, code, web pages, images (OCR)
- **🔍 Hybrid search** — Vector similarity + BM25 keyword search
- **🌳 Code-aware** — Tree-sitter AST parsing for semantic code chunks
- **🧠 Multiple embedders** — nomic (default), bge (multilingual), mxbai (best English quality), minilm (low RAM) — or bring your own via plugins
- **📱 Portable** — SQLite database, copy anywhere
- **🔌 MCP server** — Works with Codex, Claude Code, OpenCode
- **🧩 Extensible** — Plugin system for custom extractors and embedders
- **⚡ Incremental** — Only re-indexes changed files

📖 **[How It Works](docs/HOW_IT_WORKS.md)** — Learn about extraction, chunking, embeddings, and search
📋 **[User Guide](docs/USER_GUIDE.md)** — Full feature reference: all commands, flags, configuration, MCP setup, and plugins

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

# Index a web page
ragclaw add https://example.com/page

# Crawl an entire docs site
ragclaw add https://docs.example.com --crawl

# Index with a specific embedder
ragclaw add --embedder bge ./docs/

# Search
ragclaw search "how to configure auth"

# Check system and embedder compatibility
ragclaw doctor

# List all available embedders (built-in presets + plugin-provided)
ragclaw embedder list
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
ragclaw add <source>           # Index file, directory, or URL
ragclaw search <query>         # Search knowledge base
ragclaw reindex                # Re-process changed files
ragclaw merge <source.db>      # Merge another knowledge base into this one
ragclaw status                 # Show KB statistics (incl. embedder info, description, keywords)
ragclaw list                   # List indexed sources
ragclaw remove <source>        # Remove from index
ragclaw doctor                 # Check system & embedder compatibility
ragclaw embedder list          # List all available embedders (presets + plugins)
ragclaw embedder download [n]  # Pre-download a model for offline use (or --all)
ragclaw plugin list            # List plugins with enabled/disabled status
ragclaw plugin enable <n>      # Enable a plugin (or --all)
ragclaw plugin disable <n>     # Disable a plugin
ragclaw config list            # Show all config values and sources
ragclaw config get <key>       # Show a single config value
ragclaw config set <key> <value>  # Persist a config value

# Knowledge base management
ragclaw db list                         # List all KBs with description and keywords
ragclaw db list --json                  # JSON array: [{name, description, keywords}]
ragclaw db init <name>                  # Create a KB
ragclaw db init <name> --description "…" --keywords "tag1, tag2"  # Create with metadata
ragclaw db info set --db <name> --description "…" --keywords "…"  # Update metadata
ragclaw db info get --db <name>         # Read description and keywords
ragclaw db info get --db <name> --json  # Read metadata as JSON
ragclaw db delete <name> --yes          # Delete a KB
ragclaw db rename <old> <new>           # Rename a KB
```

### Options

```bash
-d, --db <name>     # Knowledge base name (default: "default")
-l, --limit <n>     # Max search results
-m, --mode <mode>   # Search mode: vector|keyword|hybrid
-e, --embedder <n>  # Embedder preset or model (add/reindex/merge only)
-f, --force         # Reindex all (ignore hash)
-p, --prune         # Remove missing sources
-a, --all           # Download all models (embedder download only)

# Merge flags (for `merge`)
--strategy <s>      # strict (same embedder, default) | reindex (re-embed with local model)
--on-conflict <r>   # skip (default) | prefer-local | prefer-remote
--dry-run           # Preview diff without writing anything
--include <paths>   # Comma-separated path prefixes to import
--exclude <paths>   # Comma-separated path prefixes to skip

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

# Web crawl flags (for `add` with a URL source)
--crawl                        # Follow links and index the whole site section
--crawl-max-depth <n>          # Max link depth from start URL (default: 3)
--crawl-max-pages <n>          # Max pages to crawl (default: 100)
--crawl-same-origin            # Stay on same domain (default: true)
--no-crawl-same-origin         # Allow following links to other domains
--crawl-include <patterns>     # Comma-separated path prefixes to include
--crawl-exclude <patterns>     # Comma-separated path prefixes to exclude
--crawl-concurrency <n>        # Concurrent fetch requests (default: 1)
--crawl-delay <ms>             # Delay between requests in ms (default: 1000)
--ignore-robots                # Ignore robots.txt (use responsibly)
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

# Embedder selection (default: nomic)
# Preset aliases: nomic | bge | mxbai | minilm
# See "Choosing an Embedder" section for a comparison of language support,
# context length, RAM requirements, and quality tradeoffs.
embedder: nomic

# Or specify any HuggingFace model ID directly:
# embedder: sentence-transformers/paraphrase-multilingual-mpnet-base-v2

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
RAGCLAW_EMBEDDER          # Embedder preset alias or model (e.g. "bge")
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

### Merging Databases

Copy a database from another machine and merge it into your local one:

```bash
# Merge a remote DB into default (same embedder — embeddings copied verbatim)
ragclaw merge ~/backup/project-a.sqlite

# Preview what would change before writing
ragclaw merge ~/backup/project-a.sqlite --dry-run

# Merge across different embedders (re-embeds text locally)
ragclaw merge ~/backup/other.sqlite --strategy reindex

# Only import docs/, overwrite conflicts with remote version
ragclaw merge ~/backup/other.sqlite --include /docs/ --on-conflict prefer-remote

# Merge into a named knowledge base
ragclaw merge ~/backup/other.sqlite -d my-kb
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
| `rag_add` | Index file/directory/URL — pass `crawl: true` to follow links |
| `rag_reindex` | Re-process changed sources |
| `rag_merge` | Merge another `.db` file into a local knowledge base |
| `rag_status` | Get KB statistics (includes embedder info) |
| `rag_list` | List indexed sources — prefixed with description/keywords header for agent context |
| `rag_remove` | Remove source from index |
| `rag_list_databases` | List all KBs with name, description, and keywords — used for automatic KB routing |
| `rag_db_init` | Create a new KB (supports `description` and `keywords` params) |
| `rag_db_info` | Set or update description and keywords on an existing KB |
| `rag_db_info_get` | Read description and keywords from an existing KB |

**Example prompts:**
```
Index the ./src directory into ragclaw
Search ragclaw for "error handling patterns"
Reindex ragclaw with force=true
Crawl https://docs.example.com and index it into ragclaw
```

---

## Choosing an Embedder

RagClaw ships four built-in presets. Pick one based on your content language, document length, and available RAM:

| Alias | Model | Language | Context | Dims | ~RAM | Strengths |
|-------|-------|----------|---------|------|------|-----------|
| `nomic` ⭐ | `nomic-ai/nomic-embed-text-v1.5` | English | 8 192 tok | 768 | ~600 MB | Long docs, balanced quality/size, Matryoshka dims |
| `bge` | `BAAI/bge-m3` | **100+ languages** | 8 192 tok | 1024 | ~2.3 GB | Best for non-English or mixed-language content |
| `mxbai` | `mixedbread-ai/mxbai-embed-large-v1` | English | 512 tok | 1024 | ~1.4 GB | Highest English retrieval quality (MTEB 64.68) |
| `minilm` | `sentence-transformers/all-MiniLM-L6-v2` | English | 256 tok | 384 | ~90 MB | Minimal RAM, fastest — short texts/notes only |

> ⭐ Default preset. Run `ragclaw doctor` to see which presets fit your available RAM.

**Quick-pick guide:**

- **Default / general use** → `nomic` — good English quality, long context, moderate RAM
- **Non-English or multilingual content** → `bge` — the only multilingual preset; needs ~2.3 GB RAM
- **Best English quality** → `mxbai` — tops MTEB English benchmarks; keep documents under ~400 tokens
- **Low RAM / fast batch indexing** → `minilm` — fits in ~90 MB; best for short notes or sentences
- **Custom model / Ollama / OpenAI-compatible** → use a [plugin](#plugins) that provides an `EmbedderPlugin`

**Important limitations to be aware of:**

- `mxbai` has a **512-token context window** — longer chunks are silently truncated
- `minilm` has a **256-token context window** — only suitable for short text
- `bge` requires **~2.3 GB RAM** to load; `ragclaw doctor` will warn if available RAM is low

```bash
# Use a preset
ragclaw add --embedder bge ./docs/

# Use any HuggingFace model directly
ragclaw add --embedder "sentence-transformers/paraphrase-multilingual-mpnet-base-v2" ./docs/

# Set a default in config
ragclaw config set embedder bge
```

---

## How It Works

1. **Extract** — Pull text from documents (PDF, DOCX, HTML, code, images via OCR)
2. **Chunk** — Split into semantic units (paragraphs, functions, classes)
3. **Embed** — Generate vectors using a configurable local model (default: `nomic-embed-text-v1.5`, 768 dims)
4. **Store** — SQLite with FTS5 for keyword search; embedder info written to `store_meta`
5. **Search** — Hybrid scoring via Reciprocal Rank Fusion (vector + BM25 keyword); embedder auto-detected from DB metadata

All processing happens locally. No external APIs.

---

## Vector Search Performance

RagClaw uses [sqlite-vec](https://alexgarcia.xyz/sqlite-vec/) for fast native vector search. If it is not available, a pure-JS fallback is used — functionally correct but noticeably slower above ~5 000 chunks.

### Auto-bundled (CLI and MCP)

The CLI and MCP packages declare `sqlite-vec` as an optional dependency. Installing them globally will automatically install the prebuilt binary for your platform:

```bash
npm install -g @emdzej/ragclaw-cli   # sqlite-vec is bundled
```

### Programmatic use (core only)

If you use `@emdzej/ragclaw-core` directly, install `sqlite-vec` alongside it:

```bash
npm install sqlite-vec
```

### Check status

```bash
ragclaw doctor
```

The doctor command shows whether sqlite-vec is loaded and where it came from (npm package or system-installed extension).

---

## Benchmarks

The `@emdzej/ragclaw-core` package includes a search benchmark suite built on [Vitest bench](https://vitest.dev/guide/features.html#benchmarking). It measures keyword, vector, and hybrid search latency against a synthetic 480-chunk corpus (8 topics, ~60 chunks each).

### Running benchmarks

```bash
# From the repo root
pnpm --filter @emdzej/ragclaw-core bench
```

Results are printed to the terminal and written as JSON to `packages/core/benchmarks/results/latest.json` (gitignored).

### What's measured

| Category | Cases | Notes |
|----------|-------|-------|
| **Keyword** | Single term, two terms, compound, broad, no matches, limit=50 | FTS5 exact + trigram |
| **Vector** | Close match, mid-range, limit=50 | JS fallback (no `sqlite-vec` in test env) |
| **Hybrid** | Single topic, two terms, compound, broad, limit=50, no keyword hits | Deferred hydration + RRF |

### Comparing results

Save a baseline before making changes, then diff after:

```bash
# Save baseline
pnpm --filter @emdzej/ragclaw-core bench
cp packages/core/benchmarks/results/latest.json packages/core/benchmarks/results/baseline.json

# Make changes, then re-run
pnpm --filter @emdzej/ragclaw-core bench

# Compare (e.g. with jq)
jq -r '.files[].groups[].benchmarks[] | "\(.name)\t\(.hz | round) ops/s\t\(.mean | .*1000 | round / 1000) ms"' \
  packages/core/benchmarks/results/latest.json
```

Historical results are recorded in [`docs/benchmarks/`](docs/benchmarks/).

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
import type { RagClawPlugin, Extractor, EmbedderPlugin } from "@emdzej/ragclaw-core";

const plugin: RagClawPlugin = {
  name: "ragclaw-plugin-notion",
  version: "0.1.0",
  extractors: [new MyExtractor()],
  schemes: ["notion"],      // URL schemes to handle
  extensions: [".notion"],  // File extensions to handle

  // Optional: provide a custom embedder (Ollama, OpenAI-compatible, etc.)
  // When set, this takes priority over preset/config selection.
  embedder: myCustomEmbedder,
};

export default plugin;
```

**`EmbedderPlugin` interface:**
```typescript
interface EmbedderPlugin {
  embed(text: string): Promise<Float32Array>;
  embedQuery(text: string): Promise<Float32Array>;
  readonly dimensions: number;
  readonly modelName: string;
}
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
