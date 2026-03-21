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
- [10. Configuration](#10-configuration)
- [11. Portability and backups](#11-portability-and-backups)
- [12. MCP server and tools](#12-mcp-server-and-tools)
- [13. Plugins](#13-plugins)
- [14. Troubleshooting](#14-troubleshooting)
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

Install globally via npm:

```bash
npm install -g ragclaw
```

From source (requires Node.js 22+):

```bash
git clone https://github.com/yourorg/ragclaw.git
cd ragclaw
npm install
npm run build
npm link    # optional: symlink into global PATH
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
ragclaw init knowledge-base-name
```

Check KB health and stats (chunks, sources, vector backend):

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

Storage paths and backwards compatibility:

- Default data dir: ~/.local/share/ragclaw/
- Config: ~/.config/ragclaw/config.yaml
- Backwards compat: if ~/.openclaw/ragclaw/ exists it will be used automatically.

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

## 11. Portability and backups

KB files are ordinary SQLite files. Recommended workflows:

- Backup: copy the .sqlite file to a safe location or S3.
- Sync between machines: rsync the .sqlite file, or export/import via `merge` on the receiving machine.
- Use absolute path for cross-machine storage: `ragclaw -d /media/drive/my-kb.sqlite`.

When syncing between machines with different embedders or resources, prefer `merge --strategy reindex` on import so vectors are rebuilt locally.

## 12. MCP server and tools

RagClaw ships a standalone MCP server package (`@emdzej/ragclaw-mcp`) that exposes RagClaw tools to AI clients. The MCP server **always enforces guards**, regardless of the CLI `enforceGuards` setting.

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
| `rag_search` | Search a knowledge base (query, mode, limit) |
| `rag_add` | Index a file/directory/URL (supports `crawl: true`) |
| `rag_reindex` | Re-process changed sources |
| `rag_merge` | Merge another `.db` file |
| `rag_status` | Get KB statistics |
| `rag_list` | List indexed sources |
| `rag_remove` | Remove source from index |

### Example prompts

```
Index the ./src directory into ragclaw
Search ragclaw for "error handling patterns"
Reindex ragclaw with force=true
Crawl https://docs.example.com and index it into ragclaw
```

**Security note:** the MCP server always enforces guards. Configure `allowedPaths` and other guard settings in `~/.config/ragclaw/config.yaml` before exposing RagClaw to external clients.

## 13. Plugins

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

## 14. Troubleshooting

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
