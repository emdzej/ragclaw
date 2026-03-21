# RagClaw Skill

Local-first RAG (Retrieval-Augmented Generation) for OpenClaw.

## Description

Index and search your documents, code, and web pages locally. Zero external APIs, offline embeddings, SQLite-based storage.

## Commands

### `/rag add <source>`
Index a file, directory, or URL.

**Examples:**
```
/rag add ./docs/
/rag add https://docs.example.com
/rag add ~/projects/my-app/src/
/rag add https://docs.example.com --crawl --crawl-max-depth 2
```

**Options:**
- `--db <name>` — Knowledge base name (default: "default")
- `--recursive` — Recurse into directories (default: true)
- `--embedder <preset>` — Embedder preset: nomic|bge|mxbai|minilm (default: nomic)
- `--include <pattern>` — Regex filter: include only matching filenames
- `--exclude <pattern>` — Regex filter: exclude matching filenames
- `--max-depth <n>` — Maximum directory recursion depth
- `--max-files <n>` — Maximum number of files to index
- `--crawl` — Follow links from a seed URL
- `--crawl-max-depth <n>` — Link traversal depth (default: 3)
- `--crawl-max-pages <n>` — Max pages to fetch (default: 100)
- `--crawl-same-origin` — Stay on the same domain (default: true)
- `--crawl-include <patterns>` — Comma-separated URL path prefixes to include
- `--crawl-exclude <patterns>` — Comma-separated URL path prefixes to exclude
- `--crawl-concurrency <n>` — Concurrent fetchers (default: 1)
- `--crawl-delay <ms>` — Delay between requests in ms (default: 1000)
- `--enforce-guards` — Enable path/URL security guards

### `/rag search <query>`
Search the knowledge base.

**Examples:**
```
/rag search how to configure authentication
/rag search async function error handling
/rag search "memory leak" --mode hybrid --limit 10
```

**Options:**
- `--db <name>` — Knowledge base name (default: "default")
- `--limit <n>` — Max results (default: 5)
- `--mode <mode>` — Search mode: vector|keyword|hybrid (default: hybrid)
- `--json` — Machine-readable JSON output

### `/rag reindex`
Re-process changed sources and keep vectors up to date.

**Options:**
- `--db <name>` — Knowledge base name (default: "default")
- `-f, --force` — Force full rebuild (ignore hashes)
- `-p, --prune` — Remove sources that no longer exist on disk
- `--embedder <preset>` — Switch embedder and rebuild all vectors

### `/rag merge <source.sqlite>`
Merge another knowledge base into the local one.

**Options:**
- `--db <name>` — Destination knowledge base (default: "default")
- `--strategy <strict|reindex>` — `strict` copies vectors verbatim (same embedder required); `reindex` re-embeds locally (default: strict)
- `--on-conflict <skip|prefer-local|prefer-remote>` — Conflict resolution (default: skip)
- `--dry-run` — Preview changes without writing
- `--include <paths>` — Comma-separated path prefixes to import
- `--exclude <paths>` — Comma-separated path prefixes to skip

### `/rag status`
Show knowledge base statistics (chunks, sources, vector backend, embedder).

**Options:**
- `--db <name>` — Knowledge base name (default: "default")

### `/rag list`
List indexed sources.

**Options:**
- `--db <name>` — Knowledge base name (default: "default")
- `-t <file|url>` — Filter by source type

### `/rag remove <source>`
Remove a source from the index.

**Options:**
- `--db <name>` — Knowledge base name (default: "default")
- `-y` — Skip confirmation prompt

### `/rag embedder list`
List all available embedder presets with RAM requirements and status.

### `/rag embedder download [preset]`
Pre-download a model for offline use.

**Options:**
- `--all` — Download all built-in presets

### `/rag doctor`
Check system health: Node.js version, RAM, sqlite-vec status, embedder compatibility, loaded plugins.

### `/rag plugin list`
List discovered plugins with enabled/disabled status.

### `/rag plugin enable <name>`
Enable a plugin (use `--all` for all discovered plugins).

### `/rag plugin disable <name>`
Disable a plugin.

### `/rag config list`
Show all configuration values and their source (env / config file / default).

### `/rag config get <key>`
Show a single config value.

### `/rag config set <key> <value>`
Persist a config value to `~/.config/ragclaw/config.yaml`.

## Supported Formats

| Type | Extensions |
|------|------------|
| Markdown | `.md`, `.mdx` |
| Text | `.txt` |
| PDF | `.pdf` (OCR for scanned pages) |
| Word | `.docx` |
| Code | `.ts`, `.js`, `.py`, `.go`, `.java` |
| Images | `.png`, `.jpg`, `.gif`, `.webp`, `.bmp`, `.tiff` (OCR) |
| Web | `http://`, `https://` |

## Embedder Presets

| Alias | Model | Language | Context | Dims | ~RAM | Strengths |
|-------|-------|----------|---------|-----:|-----:|-----------|
| `nomic` ⭐ | `nomic-ai/nomic-embed-text-v1.5` | English | 8 192 tok | 768 | ~600 MB | Long docs, balanced, default |
| `bge` | `BAAI/bge-m3` | 100+ languages | 8 192 tok | 1024 | ~2.3 GB | Multilingual |
| `mxbai` | `mixedbread-ai/mxbai-embed-large-v1` | English | 512 tok | 1024 | ~1.4 GB | Best English MTEB |
| `minilm` | `sentence-transformers/all-MiniLM-L6-v2` | English | 256 tok | 384 | ~90 MB | Minimal RAM |

Run `/rag doctor` to check which presets fit your available RAM.

## Storage

Knowledge bases are stored as SQLite files following XDG conventions:

- Default data dir: `~/.local/share/ragclaw/`
- Config file: `~/.config/ragclaw/config.yaml`
- Backwards compat: if `~/.openclaw/ragclaw/` exists it will be used automatically.

## How It Works

1. **Extract** — Pull text from documents (PDF, DOCX, HTML, code, images via OCR)
2. **Chunk** — Split into semantic units (paragraphs, functions, classes)
3. **Embed** — Generate vectors using a configurable local model (default: nomic-embed-text-v1.5, 768 dims)
4. **Store** — SQLite with FTS5 for keyword search; embedder info written to DB metadata
5. **Search** — Hybrid: 70% vector similarity + 30% BM25 keyword; embedder auto-detected from DB

All processing happens locally. No API keys required.
