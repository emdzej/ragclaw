# RagClaw User Guide

Table of contents
- [1. Introduction](#1-introduction)
- [2. Installation](#2-installation)
- [3. First steps (quickstart)](#3-first-steps-quickstart)
- [4. Managing knowledge bases](#4-managing-knowledge-bases)
- [5. Indexing content](#5-indexing-content)
  - [5.1 Files and directories](#51-files-and-directories)
  - [5.2 Web pages and crawling](#52-web-pages-and-crawling)
  - [5.3 Custom schemes and plugins](#53-custom-schemes-and-plugins)
- [6. Searching](#6-searching)
- [7. Keeping the index fresh](#7-keeping-the-index-fresh)
- [8. Merging databases](#8-merging-databases)
- [9. Choosing an embedder](#9-choosing-an-embedder)
- [10. Choosing a chunker](#10-choosing-a-chunker)
- [11. Configuration](#11-configuration)
- [12. Portability and backups](#12-portability-and-backups)
- [13. MCP server and tools](#13-mcp-server-and-tools)
- [14. Docker](#14-docker)
- [15. Kubernetes (Helm)](#15-kubernetes-helm)
- [16. OpenClaw skill setup](#16-openclaw-skill-setup)
- [17. Plugins](#17-plugins)
- [18. Troubleshooting](#18-troubleshooting)
- [Appendix A — Supported formats](#appendix-a---supported-formats)
- [Appendix B — Environment variables](#appendix-b---environment-variables)

## 1. Introduction

RagClaw is a local-first RAG (Retrieval-Augmented Generation) engine. It indexes documents, source code, and web pages into a lightweight, portable SQLite database and provides hybrid vector + keyword search. RagClaw intentionally prioritizes local control, portability, and auditability:

- Local-first: your data and vectors live on disk in a .sqlite file, no hidden cloud backend.
- Portable: knowledge bases (KBs) are ordinary SQLite files you can rsync, copy, or include in a project.
- Hybrid search: vector, keyword, and hybrid modes for flexible retrieval.
- MCP server: run a small Model Context Protocol server to expose RagClaw tools to AI clients and tool-using LLMs.

This guide is a feature-complete reference for the RagClaw CLI. It is scenario-driven and focused on reproducible commands.

## 2. Installation

Install from npm (recommended) or run from source.

Install the CLI globally via npm:

```bash
npm install -g @emdzej/ragclaw-cli
```

Install the MCP server globally via npm:

```bash
npm install -g @emdzej/ragclaw-mcp
```

From source (requires Node.js 22+):

```bash
git clone https://github.com/emdzej/ragclaw.git
cd ragclaw
pnpm install
pnpm run build
```

Verify your installation and environment with the doctor command (recommended):

```bash
ragclaw doctor
```

The `doctor` command prints Node.js version, available RAM, sqlite-vec status (native vs JS fallback), embedder RAM compatibility, current embedder config, and loaded plugins.

## 3. First steps (quickstart)

Goal: create a KB, add a folder of docs, and run a search in under five minutes.

1. Create a named KB (this only creates an empty DB file):

```bash
ragclaw init my-kb
```

2. Add a directory of markdown and PDFs recursively:

```bash
ragclaw add ~/projects/my-docs --recursive -d my-kb
```

3. Search for a phrase:

```bash
ragclaw search "connection pooling" -d my-kb
```

4. If something looks off, inspect status:

```bash
ragclaw status -d my-kb
```

## 4. Managing knowledge bases

RagClaw stores KBs as SQLite files under the data directory. By default the data directory follows XDG conventions (~/.local/share/ragclaw). The `-d`/`--db` flag accepts either a KB name (e.g. `my-kb`) or an absolute path to a `.sqlite` file.

- Named KB: `my-kb` → `~/.local/share/ragclaw/my-kb.sqlite`
- Absolute path: `/path/to/backup.sqlite`

Create an empty KB:

```bash
ragclaw db init knowledge-base-name
```

Create a KB with a description and keywords (used by AI agents to choose the right KB):

```bash
ragclaw db init api-docs --description "Project X REST API documentation" --keywords "api, rest, auth, endpoints"
```

List all knowledge bases (shows name, description, and keywords):

```bash
ragclaw db list
```

Machine-readable output (returns a JSON array of objects with `name`, `description`, and `keywords` fields):

```bash
ragclaw db list --json
```

Set or update description and keywords on an existing KB:

```bash
ragclaw db info set --db knowledge-base-name --description "Project X API docs"
ragclaw db info set --db knowledge-base-name --keywords "api, auth, endpoints"
ragclaw db info set --db knowledge-base-name --description "Updated desc" --keywords "new, tags"
```

Read the description and keywords currently stored on a KB:

```bash
ragclaw db info get --db knowledge-base-name
ragclaw db info get --db knowledge-base-name --json
```

Check KB health and stats (chunks, sources, vector backend, description, keywords):

```bash
ragclaw status -d knowledge-base-name
```

List indexed sources (files and/or URLs):

```bash
ragclaw list -d knowledge-base-name
ragclaw list -d knowledge-base-name -t file   # only files
ragclaw list -d knowledge-base-name -t url    # only URLs
```

Remove a source from the KB (skips the confirmation with `-y`):

```bash
ragclaw remove path/to/file.md -d knowledge-base-name -y
```

Delete a KB entirely:

```bash
ragclaw db delete knowledge-base-name --yes
```

Rename a KB:

```bash
ragclaw db rename old-name new-name
```

Storage paths and backwards compatibility:

- Default data dir: ~/.local/share/ragclaw/
- Config: ~/.config/ragclaw/config.yaml
- Backwards compat: if ~/.openclaw/ragclaw/ exists it will be used automatically.

### Agent routing with description and keywords

When using the MCP server, AI agents can call `kb_list_databases` to see all available KBs along with their descriptions and keywords. This allows agents to automatically choose the most relevant KB for a given query — without the user having to specify `--db` every time.

Example workflow:

1. Create KBs with meaningful metadata:
```bash
ragclaw db init api-docs  --description "REST API and auth endpoints" --keywords "api, rest, oauth, jwt"
ragclaw db init infra     --description "Infrastructure and DevOps runbooks" --keywords "k8s, terraform, ci"
ragclaw db init research  --description "Academic papers on ML and RAG" --keywords "ml, rag, embeddings"
```

2. The MCP agent calls `kb_list_databases` and receives:
```json
[
  { "name": "api-docs",  "description": "REST API and auth endpoints",         "keywords": ["api","rest","oauth","jwt"] },
  { "name": "infra",     "description": "Infrastructure and DevOps runbooks",  "keywords": ["k8s","terraform","ci"] },
  { "name": "research",  "description": "Academic papers on ML and RAG",       "keywords": ["ml","rag","embeddings"] }
]
```

3. For a query like "how does the OAuth flow work?", the agent selects `api-docs` and calls `kb_search` with `db: "api-docs"`.

You can update metadata at any time without re-indexing:

```bash
ragclaw db info set --db api-docs --description "REST API, auth, and webhook docs" --keywords "api, rest, oauth, jwt, webhooks"
```

## 5. Indexing content

RagClaw supports local files, directories, and web pages. The `ragclaw add` command handles ingestion, splitting, embedding, and storing metadata.

Common pattern:

```bash
ragclaw add <source> -d <kb-name> [flags]
```

### 5.1 Files and directories

Add a single file:

```bash
ragclaw add README.md -d docs-kb
```

Add a directory recursively (skips hidden files, node_modules, and unsupported extensions by default):

```bash
ragclaw add ~/projects/website --recursive -d website-kb
```

Force a specific chunker for this indexing run:

```bash
# Use sentence chunker instead of the default auto-selection
ragclaw add ~/projects/docs --chunker sentence -d docs-kb

# Use fixed chunker with custom size and overlap
ragclaw add ./data.txt --chunker fixed --chunk-size 256 --overlap 30 -d data-kb
```

Filtering by filename (regex applied to filenames, not path prefixes):

```bash
# include only files with 'guide' in the filename
ragclaw add ~/projects/docs --recursive --include "guide" -d docs-kb

# exclude tests and examples
ragclaw add . --recursive --exclude "test|example" -d my-kb
```

Depth and limits (CLI flags and config keys):

- `--max-depth <n>` — maximum directory recursion depth (also configurable in config.yaml)
- `--max-files <n>` — maximum number of files to index

Security guards (CLI opts; off by default):

- `--enforce-guards` / `--no-enforce-guards` — when on, RagClaw will restrict indexing to allowed paths and follow other guard checks. CLI default: off (enforceGuards: false). Use guards when running non-interactively or in automation.
- `--allowed-paths <paths>` — comma-separated list of allowed path prefixes

Notes on auto-skips: hidden files (dot-prefixed), node_modules, and unsupported file extensions are skipped automatically.

### 5.2 Web pages and crawling

You can add single URLs or enable crawling to discover linked pages.

Add a single URL:

```bash
ragclaw add https://example.com/article -d web-kb
```

Start a crawl from a seed URL with basic crawl settings:

```bash
ragclaw add https://example.com --crawl --crawl-max-depth 2 --crawl-max-pages 50 -d web-kb
```

Crawl flags and explanations:

- `--crawl` — enable crawling from the provided seed URL(s)
- `--crawl-max-depth <n>` — depth of link traversal (default 3)
- `--crawl-max-pages <n>` — maximum total pages to fetch for this crawl (default 100)
- `--crawl-same-origin` / `--no-crawl-same-origin` — restrict discovery to the same origin (default true)
- `--crawl-include <patterns>` / `--crawl-exclude <patterns>` — comma-separated patterns to include/exclude in crawled URLs
- `--crawl-concurrency <n>` — how many concurrent fetchers (default 1)
- `--crawl-delay <ms>` — delay between page fetches in milliseconds (default 1000)

Security and URL flags:

- `--allow-urls` / `--no-allow-urls` — allow indexing of URLs (configurable; defaults can be set in config.yaml)
- `--block-private-urls` / `--no-block-private-urls` — block RFC1918/private IP addresses when fetching (default controlled by config)

Notes: RagClaw respects guard settings and the CLI's security flags. Use `--enforce-guards` for stricter, automated runs.

### 5.3 Custom schemes and plugins

Plugins can add new source schemes (examples: `github://`, `obsidian://`, `youtube://`). To add plugin-provided sources you must install and enable the plugin.

Install a plugin (manual npm install, then enable):

```bash
# install plugin manually (required)
npm install -g ragclaw-plugin-obsidian

# enable it in RagClaw
ragclaw plugin enable ragclaw-plugin-obsidian
```

Create a plugin scaffold:

```bash
ragclaw plugin create my-plugin-name
```

Note: `plugin add` and `plugin remove` are currently stubs — install plugins via npm and enable/disable via the CLI.

## 6. Searching

Basic search example:

```bash
ragclaw search "dependency injection" -d my-kb
```

Search modes:

- `--mode vector` — pure vector similarity search
- `--mode keyword` — traditional keyword matching
- `--mode hybrid` — combines both signals (default)

Additional flags:

- `-l, --limit <n>` — number of results to return
- `--json` — machine-readable output for piping to scripts

Embedder detection: the search command auto-detects the embedder used by a KB from DB metadata (`store_meta`). There is no `--embedder` flag on search; embedder selection is only relevant to indexing/reindexing.

Example (JSON output):

```bash
ragclaw search "async hooks" -d dev-kb --mode hybrid --limit 10 --json
```

Scripting example (bash + jq):

```bash
ragclaw search "memory leak" -d monitoring-kb --json | jq '.results[0]'
```

## 7. Keeping the index fresh

RagClaw reprocesses changed sources and keeps vectors up to date with the `reindex` command.

Incremental reindex (default): RagClaw detects file hash changes and re-embeds only changed sources.

```bash
ragclaw reindex -d my-kb
```

Force a full rebuild (ignore hashes):

```bash
ragclaw reindex -d my-kb -f
```

Remove sources from the DB that no longer exist on disk:

```bash
ragclaw reindex -d my-kb -p   # --prune
```

Force a specific chunker during reindex:

```bash
# Re-chunk all sources using the sentence chunker
ragclaw reindex -d my-kb --chunker sentence --force

# Re-chunk with custom chunk size
ragclaw reindex -d my-kb --chunker fixed --chunk-size 300 --overlap 40 --force
```

Switching embedders mid-project: rebuild all vectors using a different preset with `--embedder`.

```bash
# re-embed every chunk with the 'mxbai' preset
ragclaw reindex -d research-kb -e mxbai --force
```

Important: All vectors in a KB must use the same embedder. Re-embedding rewrites every vector. Reindexing with a different embedder is the supported way to switch.

## 8. Merging databases

Use merging to consolidate KBs from different machines or collaborators.

Basic merge:

```bash
ragclaw merge /path/to/other.sqlite -d my-kb
```

Key merge flags:

- `--strategy <strict|reindex>` — `strict` (default) copies vectors verbatim and requires the same embedder; `reindex` imports sources but re-embeds locally using your configured embedder.
- `--on-conflict <skip|prefer-local|prefer-remote>` — how to resolve per-source conflicts (default `skip`).
- `--dry-run` — preview what will change: shows embedder match status, per-source diff with `+` (new) / `~` (changed) indicators, and warnings if embedders differ with `strict` strategy.
- `--include <paths>` / `--exclude <paths>` — comma-separated path prefixes to selectively include or skip during import.

Example dry-run:

```bash
ragclaw merge /tmp/colleague.sqlite -d my-kb --dry-run
```

If a strict merge fails because embedders differ, rerun with `--strategy reindex` to import sources and rebuild vectors locally.

## 9. Choosing an embedder

Embedders are model presets that convert text into vectors. RagClaw ships with several presets and supports plugin-provided embedders.

Resolution order (how RagClaw picks an embedder):

1. CLI `--embedder` flag (when present on add/reindex/merge)
2. `embedder:` value in config.yaml
3. plugin-provided embedder (if configured)
4. default `nomic`

All vectors in a KB must use the same embedder. To change an embedder for an existing KB, run `ragclaw reindex -e <preset>` to rebuild every vector in-place.

Embedder presets reference

| Alias | Model | Language | Context | Dims | ~RAM | Strengths |
|-------|-------|----------|---------|------:|------:|-----------|
| `nomic` ⭐ | `nomic-ai/nomic-embed-text-v1.5` | English | 8 192 tok | 768 | ~600 MB | Long docs, balanced, Matryoshka dims |
| `bge` | `BAAI/bge-m3` | 100+ languages | 8 192 tok | 1024 | ~2.3 GB | Multilingual |
| `mxbai` | `mixedbread-ai/mxbai-embed-large-v1` | English | 512 tok | 1024 | ~1.4 GB | Best English MTEB |
| `minilm` | `sentence-transformers/all-MiniLM-L6-v2` | English | 256 tok | 384 | ~90 MB | Minimal RAM |

Quick-pick guidance:

- Small RAM footprint and quick: `minilm` (useful for laptops and quick experiments)
- Balanced, long-context: `nomic` (default)
- Multilingual: `bge`
- Highest English MTEB performance: `mxbai`

List available embedder presets and status:

```bash
ragclaw embedder list
```

The embedder list shows alias, model, dims, estimated RAM, status badge (✓/⚠/✗), and marks the currently configured one with `*`.

Custom embedder IDs (e.g. Hugging Face or custom plugin) can be provided by plugins or set in config.yaml. When in doubt, run `ragclaw doctor` to see RAM compatibility before selecting a large preset.

### 9.1 Pre-downloading models for offline use

By default RagClaw downloads models on first use. If you need to work offline—or want to avoid a slow download at an inconvenient time—you can pre-fetch models with `ragclaw embedder download`.

```bash
# Download a single built-in preset
ragclaw embedder download nomic

# Download any of the four built-in presets
ragclaw embedder download bge
ragclaw embedder download mxbai
ragclaw embedder download minilm

# Download a raw Hugging Face model ID
ragclaw embedder download org/model-name

# Download all four built-in presets in one go
ragclaw embedder download --all

# Same: no name argument also downloads everything
ragclaw embedder download
```

Models are stored under `~/.cache/ragclaw/models/` (configurable via `cacheDir` in config.yaml). Models that are already present in the cache are silently skipped. The command prints a summary at the end:

```
Downloaded: 3
Already cached: 1
  ✓ nomic
```

If any model fails to download the command exits with code 1 and lists the failures, making it safe to use in scripts or CI pipelines.

**Tip:** Run `ragclaw embedder download --all` in your Dockerfile or CI setup step so that all workers have models available before any indexing job starts.

## 10. Choosing a chunker

RagClaw ships four built-in chunkers and supports plugin-provided ones. The right chunker determines how well search results map back to meaningful units of your content.

List all available chunkers:

```bash
ragclaw chunkers list
ragclaw chunkers list --json   # machine-readable
```

### Built-in chunkers

| Name | Good for | How it splits |
|------|----------|--------------|
| `semantic` | Markdown, prose | Paragraph/heading boundaries, ~512 tokens |
| `code` | Source files | AST nodes (functions, classes, methods) via tree-sitter |
| `sentence` | Markdown, prose | `Intl.Segmenter` sentences grouped into ~512-token batches |
| `fixed` | Anything | Fixed word count — the universal fallback |

### How RagClaw picks a chunker (priority order)

1. **CLI flag** `--chunker <name>` — highest priority, applies to this run only
2. **Config `chunking.overrides[]`** — glob rules in `config.yaml`, matched against source path
3. **Plugin chunkers** — `canHandle()` is checked in registration order
4. **Built-in auto** — `code → semantic → sentence → fixed`

### Forcing a chunker via config

Add to `~/.config/ragclaw/config.yaml`:

```yaml
chunking:
  strategy: sentence          # global default (overridden by overrides below)
  defaults:
    chunkSize: 512
    overlap: 50
  overrides:
    - pattern: "**/*.ts"
      chunker: code
    - pattern: "docs/**"
      chunker: semantic
      chunkSize: 400
```

**Tip:** Use `sentence` when you want paragraph-level chunks that respect sentence boundaries rather than character positions. Use `fixed` for structured data files where semantic splitting doesn't apply.

## 11. Configuration

Primary config location: `~/.config/ragclaw/config.yaml`. RagClaw adheres to XDG: use XDG_DATA_HOME and XDG_CONFIG_HOME for custom locations. If you prefer env vars, RagClaw respects them (see Appendix B).

Example full config reference (all settable keys):

```yaml
dataDir: ~/my-ragclaw-data
pluginsDir: ~/my-ragclaw-plugins
embedder: nomic
plugins: ragclaw-plugin-github, ragclaw-plugin-obsidian
scanGlobalNpm: false
allowedPaths: ~/projects, ~/docs
allowUrls: true
blockPrivateUrls: true
maxDepth: 10
maxFiles: 1000
enforceGuards: false
```

Config CLI helpers:

```bash
ragclaw config list    # shows values and their source (env vs config vs default)
ragclaw config get key
ragclaw config set key value
```

Config precedence: CLI flag > environment variable > config.yaml > built-in default.

Settable keys are restricted to a small allowlist (`SETTABLE_KEYS`) — use `config list` to see what can be changed at runtime. Some values such as internal runtime paths are read-only.

## 12. Portability and backups

KB files are ordinary SQLite files. Recommended workflows:

- Backup: copy the .sqlite file to a safe location or S3.
- Sync between machines: rsync the .sqlite file, or export/import via `merge` on the receiving machine.
- Use absolute path for cross-machine storage: `ragclaw -d /media/drive/my-kb.sqlite`.

When syncing between machines with different embedders or resources, prefer `merge --strategy reindex` on import so vectors are rebuilt locally.

## 13. MCP server and tools

RagClaw ships a standalone MCP server package (`@emdzej/ragclaw-mcp`) that exposes RagClaw tools to AI clients. The MCP server **always enforces guards**, regardless of the CLI `enforceGuards` setting.

### Transports

The MCP server supports two transports:

| Transport | When to use |
|-----------|-------------|
| **stdio** (default) | Standard single-client mode — each MCP host launches its own `ragclaw-mcp` process. |
| **HTTP** | Multi-client mode — a single long-running `ragclaw-mcp` process serves multiple clients over HTTP. |

**stdio** is the default and what all MCP hosts (Codex, Claude Code, Cursor, OpenCode, Windsurf) expect when they manage the process lifecycle themselves.

**HTTP** is useful when you want a shared, long-running server — for example, serving a team or multiple local tools at once.

```bash
# Default (stdio)
ragclaw-mcp

# HTTP on localhost:3000
ragclaw-mcp --transport http

# HTTP on a custom port with debug logging
ragclaw-mcp --transport http --port 8080 --log-level debug
```

> **Security warning:** the HTTP transport has no built-in authentication.
> By default it binds to `127.0.0.1` (localhost only). If you bind to
> `0.0.0.0`, the server will be accessible from the network — it has
> filesystem access scoped by your `allowedPaths` config, so use caution.

### CLI flags

```
ragclaw-mcp [options]

Options:
  --transport <type>   "stdio" or "http"                     (default: "stdio")
  --port <number>      Port for HTTP transport               (default: "3000")
  --host <host>        Host/IP for HTTP transport            (default: "127.0.0.1")
  --log-level <level>  debug | info | warn | error           (default: "info")
  -V, --version        Output the version number
  -h, --help           Display help for command
```

### Install the MCP server

Option 1 — global install:

```bash
npm install -g @emdzej/ragclaw-mcp
```

Option 2 — no install (npx):

Use `npx @emdzej/ragclaw-mcp` as the command in client configs below.

### Client configuration

**Codex CLI** — add to `~/.codex/config.yaml`:

```yaml
mcpServers:
  ragclaw:
    command: ragclaw-mcp
    # or: command: npx @emdzej/ragclaw-mcp
```

**Claude Code** — add to Claude Code MCP settings:

```json
{
  "mcpServers": {
    "ragclaw": {
      "command": "ragclaw-mcp"
    }
  }
}
```

**OpenCode** — add to `~/.opencode/config.json`:

```json
{
  "mcp": {
    "ragclaw": {
      "command": "ragclaw-mcp"
    }
  }
}
```

**Cursor** — add to Cursor settings (Settings → MCP):

```json
{
  "ragclaw": {
    "command": "ragclaw-mcp"
  }
}
```

**Windsurf** — add to `~/.windsurf/mcp.json`:

```json
{
  "servers": {
    "ragclaw": {
      "command": "ragclaw-mcp"
    }
  }
}
```

### Available MCP tools

| Tool | Description |
|------|-------------|
| `kb_search` | Search a knowledge base (query, mode, limit) |
| `kb_read_source` | Retrieve the full indexed content of a source by path — use when you need more than the matching chunk |
| `kb_add` | Index a file/directory/URL (`chunker`, `chunkSize`, `overlap` params supported) |
| `kb_reindex` | Re-process changed sources (`chunker`, `chunkSize`, `overlap` params supported) |
| `kb_db_merge` | Merge another `.db` file |
| `kb_status` | Get KB statistics |
| `kb_remove` | Remove source from index |
| `kb_list_chunkers` | List all available chunkers (built-in + plugin) |
| `kb_list_databases` | List all KBs with name, description, and keywords — used by agents for KB routing |
| `kb_db_init` | Create a new KB (optional `description` and `keywords`) |
| `kb_db_info` | Set or update description and keywords on an existing KB |
| `kb_db_info_get` | Read description and keywords from an existing KB |
| `kb_db_delete` | Delete a KB permanently (requires `confirm: true`) |
| `kb_db_rename` | Rename a KB (requires `confirm: true`) |

### Example prompts

```
Index the ./src directory into ragclaw
Search ragclaw for "error handling patterns"
Reindex ragclaw with force=true
Crawl https://docs.example.com and index it into ragclaw
```

**Security note:** the MCP server always enforces guards. Configure `allowedPaths` and other guard settings in `~/.config/ragclaw/config.yaml` before exposing RagClaw to external clients.

## 14. Docker

The RagClaw MCP server is available as a pre-built Docker image on GitHub Container Registry. The image includes all native dependencies (sqlite-vec, canvas, tree-sitter, tesseract.js) and all four plugins (GitHub, Obsidian, YouTube, Ollama).

**Image:** `ghcr.io/emdzej/ragclaw-mcp`

### Pull the image

```bash
docker pull ghcr.io/emdzej/ragclaw-mcp:latest
```

### Run with HTTP transport (default)

```bash
docker run -d \
  --name ragclaw-mcp \
  -p 3000:3000 \
  -v ./config:/etc/ragclaw:ro \
  -v ragclaw-data:/data/ragclaw \
  --cap-drop=ALL \
  --no-new-privileges \
  --read-only \
  --tmpfs /tmp:noexec,nosuid,size=64m \
  ghcr.io/emdzej/ragclaw-mcp:latest
```

The server listens on `0.0.0.0:3000` inside the container.

### Run with stdio transport

For MCP clients that manage the process lifecycle (e.g., Claude Desktop):

```bash
docker run -i --rm \
  -v ./config:/etc/ragclaw:ro \
  -v ragclaw-data:/data/ragclaw \
  --cap-drop=ALL \
  --no-new-privileges \
  ghcr.io/emdzej/ragclaw-mcp:latest --transport stdio
```

### Volumes

| Mount point | Purpose | Recommended flags |
|-------------|---------|-------------------|
| `/etc/ragclaw` | Configuration (`config.yaml`) | `:ro` (read-only) |
| `/data/ragclaw` | Knowledge base SQLite files | rw (default) |

### Extending allowed paths

By default the container restricts filesystem access to `/data/ragclaw`. To mount additional directories for indexing, override `RAGCLAW_ALLOWED_PATHS`:

```bash
docker run -d \
  -p 3000:3000 \
  -v ./config:/etc/ragclaw:ro \
  -v ragclaw-data:/data/ragclaw \
  -v /home/user/projects:/workspace:ro \
  -e RAGCLAW_ALLOWED_PATHS="/data/ragclaw,/workspace" \
  --cap-drop=ALL \
  --no-new-privileges \
  ghcr.io/emdzej/ragclaw-mcp:latest
```

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `RAGCLAW_CONFIG_DIR` | `/etc/ragclaw` | Config directory |
| `RAGCLAW_DATA_DIR` | `/data/ragclaw` | Data directory |
| `RAGCLAW_PLUGINS_DIR` | `/app/plugins` | Plugins directory |
| `RAGCLAW_ALLOWED_PATHS` | `/data/ragclaw` | Comma-separated allowed path prefixes |
| `RAGCLAW_BLOCK_PRIVATE_URLS` | `true` | Block RFC1918/private IP fetches |

### Security hardening

The image runs as a non-root user (UID 10001). For maximum security, combine with these `docker run` flags:

- `--cap-drop=ALL` — drop all Linux capabilities
- `--no-new-privileges` — prevent privilege escalation
- `--read-only` — read-only root filesystem (use `--tmpfs /tmp:noexec,nosuid,size=64m` for temp files)

### Docker Compose example

```yaml
services:
  ragclaw-mcp:
    image: ghcr.io/emdzej/ragclaw-mcp:latest
    ports:
      - "3000:3000"
    volumes:
      - ./config:/etc/ragclaw:ro
      - ragclaw-data:/data/ragclaw
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    read_only: true
    tmpfs:
      - /tmp:noexec,nosuid,size=64m
    restart: unless-stopped

volumes:
  ragclaw-data:
```

### Health checks

The HTTP transport exposes a `GET /healthz` endpoint that returns `{"status":"ok"}` with a 200 status code. Use this for orchestrator health probes.

**Docker Compose:**
```yaml
healthcheck:
  test: ["CMD", "node", "-e", "fetch('http://localhost:3000/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
  interval: 30s
  timeout: 5s
  retries: 3
```

**Kubernetes:**
```yaml
livenessProbe:
  httpGet:
    path: /healthz
    port: 3000
  initialDelaySeconds: 10
  periodSeconds: 30
readinessProbe:
  httpGet:
    path: /healthz
    port: 3000
  initialDelaySeconds: 5
  periodSeconds: 10
```

### Plugins in Docker

All four plugins are included in the image. To activate a plugin, list it in your `config.yaml`:

```yaml
# /etc/ragclaw/config.yaml (mounted at /etc/ragclaw)
plugins: ragclaw-plugin-github, ragclaw-plugin-youtube
pluginsDir: /app/plugins
```

### SQLite and network filesystems

The entrypoint warns if the data volume is on a network filesystem (NFS, CIFS, etc.). SQLite WAL mode can corrupt data on network-attached storage. Always use a local bind mount or Docker named volume for `/data/ragclaw`.

## 15. Kubernetes (Helm)

The RagClaw MCP server can be deployed to Kubernetes using the official Helm chart. The chart creates a Deployment, Service, and optional PersistentVolumeClaim and ConfigMap.

**Chart:** `oci://ghcr.io/emdzej/charts/ragclaw-mcp`

### Install the chart

```bash
helm install ragclaw oci://ghcr.io/emdzej/charts/ragclaw-mcp
```

Install a specific version:

```bash
helm install ragclaw oci://ghcr.io/emdzej/charts/ragclaw-mcp --version 0.1.0
```

### Configuration overview

| Value | Default | Description |
|-------|---------|-------------|
| `replicaCount` | `1` | Number of replicas (keep at 1 — SQLite limitation) |
| `image.registry` | `ghcr.io` | Container image registry |
| `image.repository` | `emdzej/ragclaw-mcp` | Container image repository |
| `image.tag` | `""` (appVersion) | Image tag |
| `service.type` | `ClusterIP` | Kubernetes Service type |
| `service.port` | `3000` | Service port |
| `persistence.enabled` | `true` | Enable PVC for data |
| `persistence.existingClaim` | `""` | Use an existing PVC |
| `persistence.storageClass` | `""` | Storage class (cluster default) |
| `persistence.size` | `2Gi` | PVC size |
| `config.existingConfigMap` | `""` | Use an existing ConfigMap |
| `config.content` | `""` | Inline config.yaml content |

### Providing configuration

**Option 1 — inline config in values:**

```yaml
# values.yaml
config:
  content: |
    embedder: nomic
    allowedPaths:
      - /data/ragclaw
    allowUrls: true
    blockPrivateUrls: true
```

```bash
helm install ragclaw oci://ghcr.io/emdzej/charts/ragclaw-mcp -f values.yaml
```

**Option 2 — existing ConfigMap:**

Create a ConfigMap with a `config.yaml` key, then reference it:

```bash
kubectl create configmap ragclaw-config --from-file=config.yaml=./my-config.yaml
helm install ragclaw oci://ghcr.io/emdzej/charts/ragclaw-mcp \
  --set config.existingConfigMap=ragclaw-config
```

### Data persistence

By default the chart creates a 2Gi PVC with `ReadWriteOnce` access mode. To use an existing PVC:

```bash
helm install ragclaw oci://ghcr.io/emdzej/charts/ragclaw-mcp \
  --set persistence.existingClaim=my-existing-pvc
```

To customise storage class and size:

```bash
helm install ragclaw oci://ghcr.io/emdzej/charts/ragclaw-mcp \
  --set persistence.storageClass=gp3 \
  --set persistence.size=10Gi
```

### Environment variables

The chart exposes generic `env` and `envFrom` fields for passing environment variables to the container. No RagClaw-specific env vars are templated — use these fields for any overrides:

```yaml
# values.yaml
env:
  - name: RAGCLAW_EMBEDDER
    value: "ollama"
  - name: RAGCLAW_ALLOW_URLS
    value: "false"

envFrom:
  - secretRef:
      name: ragclaw-secrets
```

### Security

The chart sets a hardened security context by default:

- Runs as non-root (UID 10001)
- Read-only root filesystem
- All capabilities dropped
- No privilege escalation
- A tmpfs is mounted at `/tmp`

### Important SQLite limitations

- **Single writer only.** SQLite does not support concurrent writers from multiple pods. Keep `replicaCount: 1`.
- **No network filesystems.** Do NOT use NFS, CIFS, or other network-attached storage for the data volume. SQLite WAL mode can corrupt data. Use block storage (e.g., `gp3`, `pd-ssd`).

### Upgrading

```bash
helm upgrade ragclaw oci://ghcr.io/emdzej/charts/ragclaw-mcp
```

### Uninstalling

```bash
helm uninstall ragclaw
```

Note: the PVC is **not** deleted on uninstall. Delete it manually if you want to remove the data:

```bash
kubectl delete pvc ragclaw-ragclaw-mcp
```

## 16. OpenClaw skill setup

The `skill/` directory in the RagClaw repository bundles a ready-to-use OpenClaw skill. It exposes all RagClaw commands as `/rag` slash commands directly inside the OpenClaw chat interface — no MCP server required.

### Install the skill

Copy the `skill/` directory into your OpenClaw skills folder:

```bash
cp -r skill/ ~/.openclaw/workspace/skills/ragclaw/
```

OpenClaw discovers skills automatically on startup. After copying, restart OpenClaw (or reload skills if your version supports hot-reload).

### Usage

Once installed, the `/rag` command is available in chat:

```
/rag add ./docs/
/rag add https://docs.example.com --crawl
/rag search "authentication flow"
/rag reindex --force
/rag status
/rag embedder list
/rag doctor
```

All commands and flags are identical to the CLI — the skill is a thin wrapper around the `ragclaw` binary. Run `/rag help` inside OpenClaw to see the full command reference.

### Prerequisites

The skill requires the RagClaw CLI to be installed and available on your `PATH`:

```bash
npm install -g @emdzej/ragclaw-cli
```

Verify with:

```bash
ragclaw doctor
```

### Configuration

The skill respects all standard RagClaw configuration. Set defaults in `~/.config/ragclaw/config.yaml`:

```yaml
embedder: nomic       # default embedder preset
enforceGuards: false  # set to true for automated/non-interactive use
```

### Storage

Knowledge bases created via the skill are stored in the same location as the CLI:

- Default: `~/.local/share/ragclaw/<name>.sqlite`
- Backwards compat: `~/.openclaw/ragclaw/` (used automatically if it exists)

## 17. Plugins

Plugin discovery and locations:

- Local directory: `~/.local/share/ragclaw/plugins/` (discovered by default)
- Global npm packages: packages with the `ragclaw-plugin-*` prefix (only scanned if `scanGlobalNpm: true` to avoid typosquatting)

Plugin source labels in the UI: `npm`, `local`, `workspace`.

Security model: plugins must be explicitly enabled. Global npm scanning is off by default. Always review plugin code before enabling when possible.

Plugin management commands:

```bash
ragclaw plugin list
ragclaw plugin enable <name>
ragclaw plugin disable <name>
ragclaw plugin create <name>   # scaffold a plugin template
```

Notes:

- `plugin add` and `plugin remove` are currently stubs; install plugins via npm (global or local) and use `plugin enable` to activate them in RagClaw.
- Plugins can provide embedder presets, source handlers (custom schemes), and other integrations.

Plugin example workflow:

```bash
# install plugin package via npm
npm install -g ragclaw-plugin-github

# enable it
ragclaw plugin enable ragclaw-plugin-github

# now you can add github://owner/repo paths (plugin-specific)
ragclaw add github://myorg/myrepo -d code-kb
```

## 18. Troubleshooting

Problem: sqlite-vec native extension missing → fallback to JS vectors is slow above ~5k chunks

Fixes:

- Run `ragclaw doctor` to see sqlite-vec status and recommended install steps
- Install system sqlite-vec package or use the platform-provided binary if available

Problem: embedder requires more RAM than available

Fixes:

- Run `ragclaw doctor` to view per-preset RAM compatibility
- Use a smaller embedder (e.g., `minilm`) or reindex with a smaller preset

Problem: search behaves as if a different embedder is configured

Reason: search auto-detects the KB embedder from DB metadata (`store_meta`). If you re-embedded with a different preset, that new embedder is used automatically.

Problem: merging fails with `--strategy strict` because embedders differ

Fix: use `--strategy reindex` to import sources and rebuild vectors locally.

Problem: guards block files during automated runs

Fixes:

- When running non-interactively, enable guards explicitly: `--enforce-guards` or set `enforceGuards: true` in config.yaml
- Adjust `allowedPaths` and `maxFiles` / `maxDepth` as appropriate

Compatibility and environment reminders:

- Node.js 22.x is required
- If you see truncated embeddings for very long documents, pick a preset with a larger context window (see the embedder table)

## Appendix A — Supported formats

| Type | Extensions |
|------|------------|
| Markdown | `.md`, `.mdx` |
| Text | `.txt` |
| PDF | `.pdf` (OCR for scanned pages) |
| Word | `.docx` |
| Code | `.ts`, `.js`, `.py`, `.go`, `.java` |
| Images | `.png`, `.jpg`, `.gif`, `.webp`, `.bmp`, `.tiff` (OCR) |
| Web | `http://`, `https://` |

## Appendix B — Environment variables

RagClaw honors these environment variables (useful for CI / automation):

```
RAGCLAW_DATA_DIR, RAGCLAW_PLUGINS_DIR, RAGCLAW_CONFIG_DIR
RAGCLAW_EMBEDDER
RAGCLAW_ALLOWED_PATHS, RAGCLAW_ALLOW_URLS, RAGCLAW_BLOCK_PRIVATE_URLS
RAGCLAW_MAX_DEPTH, RAGCLAW_MAX_FILES, RAGCLAW_ENFORCE_GUARDS
XDG_DATA_HOME, XDG_CONFIG_HOME
```

## Use case examples

1. CI pipeline indexes a docs site, small embedder, and exports JSON results

```bash
# CI runner: force guards on, small embedder via env var, machine-readable output
export RAGCLAW_EMBEDDER=minilm
ragclaw add ./docs --recursive -d ci-docs --enforce-guards
ragclaw reindex -d ci-docs -f
ragclaw search "installation" -d ci-docs --json > artifacts/search-installation.json
```

2. Syncing a KB from a laptop to a server with different RAM capabilities

```bash
# on laptop: copy the sqlite file
scp ~/.local/share/ragclaw/research.sqlite server:/tmp/research.sqlite

# on server: dry-run merge to inspect embedder compatibility
ragclaw merge /tmp/research.sqlite -d research-server --dry-run

# if embedders differ, use reindex strategy
ragclaw merge /tmp/research.sqlite -d research-server --strategy reindex
```

3. Expose RagClaw to an LLM client via MCP (local only)

```bash
# The MCP server is a separate binary — start it directly
ragclaw-mcp
# or via npx:
npx @emdzej/ragclaw-mcp
```

Closing notes

This user guide is intended as the reference for the RagClaw CLI. For tutorials, API-level MCP examples, or developer guides (plugin interface and tests), see the repository's docs/ and the plugin template scaffolded by `ragclaw plugin create`.
