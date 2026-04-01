# RagClaw Specification

## Overview

RagClaw is a local-first RAG (Retrieval-Augmented Generation) engine designed for OpenClaw. It indexes various content sources into a SQLite database with vector and full-text search capabilities.

## Design Principles

1. **Zero-Ops** — No external services, no API keys required (Docker image available but optional)
2. **Local-First** — All data stays on the user's machine
3. **Graceful Degradation** — Works even if native extensions fail to load
4. **Extensible** — Pluggable extractors, chunkers, and embedding models

## Package Structure

```
@emdzej/ragclaw (monorepo)
├── @emdzej/ragclaw-core      # Extractors, chunkers, embedder, store
├── @emdzej/ragclaw-cli       # Standalone CLI tool
├── @emdzej/ragclaw-mcp       # MCP server (stdio + HTTP transport)
├── @emdzej/ragclaw-skill     # OpenClaw skill integration
└── charts/ragclaw-mcp        # Helm chart for Kubernetes deployment
```

**Docker image:** `ghcr.io/emdzej/ragclaw-mcp` — pre-built MCP server image with all native dependencies and plugins. Published to GitHub Container Registry on each release.

**Helm chart:** `oci://ghcr.io/emdzej/charts/ragclaw-mcp` — Kubernetes Helm chart for deploying the MCP server. Published to GHCR OCI registry. Versioned independently from the application.

## Components

### 1. Extractors

Extract plain text from various sources.

| Source | Library | Output |
|--------|---------|--------|
| Markdown | built-in | text + metadata |
| Plain Text | built-in | text |
| PDF | `pdfjs-dist` | text per page |
| DOCX | `mammoth` | text + structure |
| Web | `cheerio` | text + title + metadata |
| Code | `tree-sitter` | AST + text |

**Extractor Interface:**
```typescript
interface Extractor {
  canHandle(source: Source): boolean;
  extract(source: Source): Promise<ExtractedContent>;
}

interface ExtractedContent {
  text: string;
  metadata: Record<string, unknown>;
  sourceType: 'markdown' | 'text' | 'pdf' | 'docx' | 'web' | 'code';
  mimeType?: string;
}

type Source = 
  | { type: 'file'; path: string }
  | { type: 'url'; url: string }
  | { type: 'text'; content: string; name?: string };
```

### 2. Chunkers

Split extracted content into indexable chunks.

#### Built-in Chunkers

| Name | `handles` | Description |
|------|-----------|-------------|
| `semantic` | `markdown`, `text` | Paragraph/heading-aware semantic splitting |
| `code` | `code` | AST-based splitting via tree-sitter |
| `sentence` | `markdown`, `text` | `Intl.Segmenter`-based sentence splitting, zero extra deps |
| `fixed` | `["*"]` (universal) | Fixed-size word-count splitting, always applicable fallback |

**Semantic Chunker** (for documents):
- Split by paragraphs and headings
- Target size: 512 tokens with 50 token overlap
- Preserve context (include parent heading)

**Code Chunker** (for source files):
- Parse AST with tree-sitter
- Chunk by: function, class, method, top-level block
- Include: signature, docstring, body
- Languages: TypeScript/JavaScript, Java, Go, Python

**Sentence Chunker** (for documents):
- Uses `Intl.Segmenter` — no extra dependencies
- Groups sentences into target-size batches (~512 tokens, ~50 token overlap)

**Fixed Chunker** (universal fallback):
- Splits by word count, configurable `chunkSize` and `overlap`
- `canHandle()` always returns `true`

**Chunker Interface:**
```typescript
interface Chunker {
  readonly name: string;          // e.g. "semantic", "code", "sentence", "fixed"
  readonly description: string;   // Human-readable description
  readonly handles: string[];     // ContentType keys this chunker targets, or ["*"] for any
  canHandle(content: ExtractedContent): boolean;
  chunk(content: ExtractedContent, sourceId: string, sourcePath: string): Promise<Chunk[]>;
}

interface Chunk {
  id: string;                    // UUID
  text: string;                  // Chunk content
  sourceId: string;              // Reference to source
  sourcePath: string;            // File path or URL
  startLine?: number;            // For files
  endLine?: number;
  metadata: {
    type: 'paragraph' | 'section' | 'function' | 'class' | 'method' | 'block';
    heading?: string;            // Parent heading for docs
    name?: string;               // Function/class name for code
    language?: string;           // Programming language
    [key: string]: unknown;
  };
}
```

#### Chunker Resolution Priority

When indexing a source, RagClaw resolves the chunker in this order (highest → lowest):

1. **CLI `--chunker <name>` flag** (or `IndexSourceOptions.chunker`)
2. **Config `chunking.overrides[]`** — first glob pattern match against the source path
3. **Plugin chunkers** (`extraChunkers`) — `canHandle()` checked in registration order
4. **Built-in auto**: `CodeChunker → SemanticChunker → SentenceChunker → FixedChunker`

If an unknown chunker name is supplied, RagClaw **fails hard** with a suggestion:
```
Unknown chunker "sentense". Did you mean "sentence"? Available: semantic, code, sentence, fixed
```

#### `IndexingServiceConfig` additions

```typescript
interface IndexingServiceConfig {
  extraChunkers?: Chunker[];           // plugin-provided chunkers
  chunkerStrategy?: string;            // override name for all sources
  chunkerDefaults?: { chunkSize?: number; overlap?: number };
  chunkerOverrides?: ChunkingOverride[];
}

interface ChunkingOverride {
  pattern?: string;   // picomatch glob against source path (omit to match any path)
  mimeType?: string;  // MIME prefix match against content mimeType (omit to match any MIME)
  chunker: string;    // chunker name to use when conditions match
  chunkSize?: number;
  overlap?: number;
}
// At least one of pattern or mimeType must be provided.
// When both are present, both must match (AND logic).
```

#### `RagclawConfig` — `chunking` field

```yaml
# config.yaml
chunking:
  strategy: sentence          # optional: set a global default chunker
  defaults:
    chunkSize: 512
    overlap: 50
  overrides:
    - pattern: "**/*.ts"
      chunker: code
    - pattern: "docs/**"
      chunker: semantic
      chunkSize: 400
    - mimeType: "text/html"   # mimeType-only: force sentence for all HTML content
      chunker: sentence
    - pattern: "https://docs.example.com/**"
      mimeType: "text/html"   # both: path AND MIME must match (AND logic)
      chunker: semantic
```

#### `ChunkerInfo` (returned by `IndexingService.listChunkers()`)

```typescript
interface ChunkerInfo {
  name: string;
  description: string;
  handles: string[];
  source: "built-in" | "plugin";
}
```

### 3. Embedder

Generate vector embeddings for chunks.

**Preset Models:**

| Alias | Model | Dimensions | ~RAM |
|-------|-------|------------|------|
| `nomic` (default) | `nomic-ai/nomic-embed-text-v1.5` | 768 | ~600 MB |
| `bge` | `BAAI/bge-m3` | 1024 | ~2.3 GB |
| `mxbai` | `mixedbread-ai/mxbai-embed-large-v1` | 1024 | ~1.4 GB |
| `minilm` | `sentence-transformers/all-MiniLM-L6-v2` | 384 | ~90 MB |

All models run via `@huggingface/transformers` (ONNX runtime, fully local).

**`EmbedderPlugin` Interface:**
```typescript
interface EmbedderPlugin {
  embed(text: string): Promise<Float32Array>;
  embedQuery(text: string): Promise<Float32Array>;
  readonly dimensions: number;
  readonly modelName: string;
}
```

**`EmbedderPreset` Interface:**
```typescript
interface EmbedderPreset {
  model: string;          // HuggingFace model ID
  dim?: number;           // Expected output dimensions (0 = auto-detect)
  docPrefix?: string;     // Prefix for document embeddings
  queryPrefix?: string;   // Prefix for query embeddings
  pooling: "mean" | "cls";
  normalize: boolean;
  estimatedRAM?: number;  // Bytes needed at runtime
}
```

**Factory:**
```typescript
// createEmbedder() — single entry point
createEmbedder(config?: EmbedderResolvedConfig): EmbedderPlugin

interface EmbedderResolvedConfig {
  alias?: string;           // Preset alias ("nomic", "bge", ...)
  model?: string;           // Arbitrary HF model ID
  dimensions?: number;      // Override dims
  pluginEmbedder?: EmbedderPlugin;  // Plugin-provided (highest priority)
  onProgress?: (p: number) => void;
}
```

**Caching:**
- Model downloaded on first use to `~/.cache/huggingface/`
- Progress indicator during download

### 4. Store

SQLite database with vector and full-text search.

**Schema:**
```sql
-- Source files/URLs tracking
CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,       -- File path or URL
  type TEXT NOT NULL,              -- 'file' | 'url' | 'text'
  content_hash TEXT,               -- SHA-256 of content
  mtime INTEGER,                   -- File modification time
  indexed_at INTEGER NOT NULL,
  metadata TEXT                    -- JSON
);

-- Indexed chunks
CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  start_line INTEGER,
  end_line INTEGER,
  metadata TEXT,                   -- JSON
  embedding BLOB,                  -- Float32Array as binary (fallback)
  created_at INTEGER NOT NULL
);

-- Vector search (sqlite-vec extension, dimension-aware)
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
  id TEXT PRIMARY KEY,
  embedding FLOAT[N]               -- N = embedder dimensions (e.g. 768)
);

-- Full-text search (FTS5)
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  id,
  text,
  content=chunks,
  content_rowid=rowid
);

-- Store metadata (embedder tracking, schema versioning, user-set info)
CREATE TABLE IF NOT EXISTS store_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Keys: embedder_name, embedder_model, embedder_dimensions, db_description, db_keywords

-- Merge history
CREATE TABLE IF NOT EXISTS merge_history (
  id TEXT PRIMARY KEY,
  source_path TEXT NOT NULL,   -- path to the source DB that was merged
  merged_at INTEGER NOT NULL,  -- Unix epoch ms
  strategy TEXT NOT NULL,      -- 'strict' | 'reindex'
  sources_added INTEGER NOT NULL DEFAULT 0,
  sources_updated INTEGER NOT NULL DEFAULT 0,
  sources_skipped INTEGER NOT NULL DEFAULT 0
);

-- Indexes
CREATE INDEX idx_chunks_source ON chunks(source_id);
CREATE INDEX idx_sources_path ON sources(path);
CREATE INDEX idx_sources_indexed_at ON sources(indexed_at);
```

**Store Interface:**
```typescript
interface Store {
  // Lifecycle
  open(path: string): Promise<void>;
  close(): Promise<void>;
  
  // Sources
  addSource(source: SourceRecord): Promise<string>;
  getSource(path: string): Promise<SourceRecord | null>;
  removeSource(id: string): Promise<void>;
  
  // Chunks
  addChunks(chunks: ChunkRecord[]): Promise<void>;
  removeChunksBySource(sourceId: string): Promise<void>;
  
  // Search
  search(query: SearchQuery): Promise<SearchResult[]>;
  
  // Stats
  getStats(): Promise<StoreStats>;
}

interface SearchQuery {
  text: string;
  embedding?: Float32Array;
  limit?: number;                  // Default: 10
  mode?: 'vector' | 'keyword' | 'hybrid';  // Default: 'hybrid'
  filter?: {
    sourceType?: string;
    sourcePath?: string;
  };
}

interface SearchResult {
  chunk: ChunkRecord;
  score: number;
  scoreVector?: number;
  scoreKeyword?: number;
}
```

**Hybrid Search Scoring:**
```
score = (w_vec × score_vec) + (w_fts × score_fts)

Default weights:
- w_vec = 0.7
- w_fts = 0.3
```

**Graceful Degradation:**
1. Try `sqlite-vec` for vector search
2. If unavailable, fall back to brute-force JS cosine similarity
3. FTS5 is standard SQLite, always available

## CLI Commands

### `ragclaw init <name>` _(deprecated)_
> **Deprecated.** Use `ragclaw db init` instead. This alias still works but prints a deprecation warning to stderr.

```bash
ragclaw init my-docs    # works, but prints deprecation warning
```

### `ragclaw add <source> [options]`
Add content to the knowledge base.

```bash
ragclaw add ./docs/                    # Directory (recursive)
ragclaw add ./paper.pdf                # Single file
ragclaw add https://example.com/page   # Web page
ragclaw add ./src/ --type code         # Code files

# Web crawling — follow links from a seed URL
ragclaw add https://docs.example.com --crawl
ragclaw add https://docs.example.com --crawl --crawl-max-depth 2 --crawl-max-pages 50
ragclaw add https://example.com --crawl --crawl-include /docs,/api --crawl-exclude /blog

Options:
  --db <name>              Knowledge base name (default: "default")
  --type <type>            Force source type: auto|text|code|web
  --recursive              Recurse into directories (default: true)
  --include <glob>         Include pattern (e.g., "*.md")
  --exclude <glob>         Exclude pattern (e.g., "node_modules")

  # Chunker options
  --chunker <name>         Force a specific chunker: semantic|code|sentence|fixed (or plugin name)
  --chunk-size <n>         Target chunk size in tokens (default: 512)
  --overlap <n>            Chunk overlap in tokens (default: 50)

  # Crawl options (require a URL source + --crawl)
  --crawl                  Enable crawling — follow links from the seed URL
  --crawl-max-depth <n>    Max link depth from start URL (default: 3)
  --crawl-max-pages <n>    Max pages to crawl (default: 100)
  --crawl-same-origin      Stay on same domain (default: true)
  --no-crawl-same-origin   Allow following links to other domains
  --crawl-include <paths>  Comma-separated path prefixes to include
  --crawl-exclude <paths>  Comma-separated path prefixes to exclude
  --crawl-concurrency <n>  Concurrent fetch requests (default: 1)
  --crawl-delay <ms>       Delay between requests in ms (default: 1000)
  --ignore-robots          Ignore robots.txt (use responsibly)
```

### `ragclaw chunkers list [options]`
List all available chunkers (built-in and plugin-provided).

```bash
ragclaw chunkers list
ragclaw chunkers list --json

Options:
  --json    Output as JSON array
```

Default output:
```
Available chunkers (4):

  semantic [built-in]
    Paragraph and heading-aware semantic splitting
    handles: markdown, text

  code [built-in]
    AST-based splitting via tree-sitter
    handles: code

  sentence [built-in]
    Sentence-level splitting using Intl.Segmenter (zero deps)
    handles: markdown, text

  fixed [built-in]
    Fixed word-count splitting, universal fallback
    handles: all content types
```

`--json` output:
```json
[
  { "name": "semantic", "description": "...", "handles": ["markdown", "text"], "source": "built-in" },
  ...
]
```

### `ragclaw search <query> [options]`
Search the knowledge base.

```bash
ragclaw search "OAuth2 configuration"
ragclaw search "rate limiting" --limit 5 --mode hybrid

Options:
  --db <name>       Knowledge base name (default: "default")
  --limit <n>       Max results (default: 10)
  --mode <mode>     Search mode: vector|keyword|hybrid (default: hybrid)
  --json            Output as JSON
```

### `ragclaw read <source> [options]`
Read the full indexed content of a source from the knowledge base. Returns all
chunks in document order, concatenated. Use the source path exactly as shown in
`ragclaw search` or `ragclaw list` output.

```bash
ragclaw read /path/to/file.md
ragclaw read https://docs.example.com/page
ragclaw read /path/to/file.md --json

Options:
  --db <name>       Knowledge base name (default: "default")
  --json            Output as JSON
```

### `ragclaw status [options]`
Show knowledge base statistics.

```bash
ragclaw status
ragclaw status --db my-docs

Output:
  Database: my-docs.sqlite
  Sources: 42 files, 3 URLs
  Chunks: 1,247
  Size: 15.2 MB
  Last updated: 2026-03-19 15:30
```

### `ragclaw remove <source> [options]`
Remove a source from the index.

```bash
ragclaw remove ./old-docs/
ragclaw remove https://example.com/page
```

### `ragclaw list [options]`
List indexed sources.

```bash
ragclaw list
ragclaw list --db my-docs --type code
```

### `ragclaw reindex [options]`
Re-process changed sources and keep vectors up to date.

```bash
ragclaw reindex                        # incremental: only re-embeds changed sources
ragclaw reindex --force                # full rebuild, ignores content hash
ragclaw reindex --prune                # remove sources that no longer exist on disk

Options:
  --db <name>              Knowledge base name (default: "default")
  -f, --force              Reindex all sources regardless of content hash
  -p, --prune              Remove sources that no longer exist on disk
  --embedder <name>        Switch embedder preset (rebuilds all vectors)
  --chunker <name>         Force a specific chunker: semantic|code|sentence|fixed
  --chunk-size <n>         Target chunk size in tokens
  --overlap <n>            Chunk overlap in tokens
```

### `ragclaw merge <source-db> [options]` _(deprecated)_
> **Deprecated.** Use `ragclaw db merge` instead. This alias still works but prints a deprecation warning to stderr.

```bash
ragclaw merge ~/backup/project-a.sqlite   # works, prints deprecation warning
```

### `ragclaw db` — Knowledge base management

All database lifecycle operations live under the `db` subcommand group.

#### `ragclaw db list [options]`
List all available knowledge bases. Opens each `.sqlite` briefly to read metadata.

```bash
ragclaw db list
ragclaw db list --json

Options:
  --json    Output as a JSON array of objects
```

Output (default):
```
Knowledge bases:

  default — Project X API docs  [api, auth, endpoints]
  research
  work — Internal tooling notes  [cli, build]
```

Output (`--json`):
```json
[
  { "name": "default", "description": "Project X API docs", "keywords": ["api", "auth", "endpoints"] },
  { "name": "research", "description": null, "keywords": [] },
  { "name": "work", "description": "Internal tooling notes", "keywords": ["cli", "build"] }
]
```

#### `ragclaw db init [name] [options]`
Create a new knowledge base. Safe to run if it already exists.

```bash
ragclaw db init                                          # creates "default"
ragclaw db init my-docs                                  # creates "my-docs"
ragclaw db init my-docs --description "Project X docs"  # with description
ragclaw db init my-docs --keywords "api, auth"          # with keywords

Options:
  --description <text>   Human-readable description of this knowledge base
  --keywords <list>      Comma-separated keywords (e.g. 'api, auth, endpoints')
```

#### `ragclaw db info set [options]`
Set or update the description and keywords for an existing knowledge base.

```bash
ragclaw db info set --description "Project X API docs" --keywords "api, auth"
ragclaw db info set --db my-docs --description "Redesigned docs"
ragclaw db info set --keywords ""                        # clear keywords

Options:
  -d, --db <name>        Knowledge base name (default: 'default')
  --description <text>   Human-readable description of this knowledge base
  --keywords <list>      Comma-separated keywords (e.g. 'api, auth, endpoints')
```

#### `ragclaw db info get [options]`
Read the description and keywords stored on a knowledge base.

```bash
ragclaw db info get
ragclaw db info get --db my-docs
ragclaw db info get --db my-docs --json

Options:
  -d, --db <name>   Knowledge base name (default: 'default')
  --json            Output as JSON
```

Output (default):
```
Knowledge base: my-docs
Description:    Project X API docs
Keywords:       api, auth, endpoints
```

Output when no metadata is set:
```
Knowledge base: my-docs
Description:    (not set)
Keywords:       (not set)
```

Output (`--json`):
```json
{ "name": "my-docs", "description": "Project X API docs", "keywords": ["api", "auth", "endpoints"] }
```

#### `ragclaw db delete <name> [options]`
Delete a knowledge base and its `.sqlite` file permanently. Prompts for confirmation unless `--yes` is passed.

```bash
ragclaw db delete old-kb        # prompts: "Delete knowledge base 'old-kb'? [y/N]"
ragclaw db delete old-kb --yes  # skips prompt

Options:
  -y, --yes    Skip confirmation prompt
```

#### `ragclaw db rename <old-name> <new-name>`
Rename a knowledge base. Errors if the new name already exists.

```bash
ragclaw db rename old-kb new-kb
```

#### `ragclaw db merge <source-db> [options]`
Merge another knowledge base (a `.sqlite` file) into the local one.
The source database is never modified — all writes go to the destination.

```bash
# Merge using strict strategy (same embedder required — embeddings copied verbatim)
ragclaw db merge ~/backup/project-a.sqlite

# Preview what would change without writing (dry-run)
ragclaw db merge ~/backup/project-a.sqlite --dry-run

# Merge across different embedders (re-embeds text with the local model)
ragclaw db merge ~/backup/other.sqlite --strategy reindex --embedder bge

# Only import sources whose path starts with /docs/
ragclaw db merge ~/backup/other.sqlite --include /docs/

# Skip sources whose path starts with /tmp/
ragclaw db merge ~/backup/other.sqlite --exclude /tmp/

# Overwrite local conflicting sources with remote versions
ragclaw db merge ~/backup/other.sqlite --on-conflict prefer-remote

# Merge into a named knowledge base
ragclaw db merge ~/backup/other.sqlite --db my-kb

Options:
  --db <name>              Destination knowledge base (default: "default")
  --strategy <s>           strict (default) | reindex
  --on-conflict <r>        skip (default) | prefer-local | prefer-remote
  --dry-run                Preview diff, write nothing
  --include <paths>        Comma-separated path prefixes to import
  --exclude <paths>        Comma-separated path prefixes to skip
  --embedder <n>           Embedder for reindex strategy (preset or model)
```

**Strategies:**

| Strategy | When to use | How it works |
|----------|-------------|--------------|
| `strict` (default) | Both DBs use the same embedder | Copies chunk embeddings verbatim — fast, no re-embedding |
| `reindex` | Different embedders | Copies chunk text, re-embeds with local model — works across any embedders |

**Conflict resolution** applies when the same source path exists in both DBs but with a different content hash:

| Resolution | Behaviour |
|------------|-----------|
| `skip` (default) | Keep the local version, ignore the remote one |
| `prefer-local` | Same as `skip` |
| `prefer-remote` | Overwrite local chunks with remote chunks |

## MCP Server

`@emdzej/ragclaw-mcp` exposes all RagClaw tools to AI agents via the
[Model Context Protocol](https://modelcontextprotocol.io/).

### Transports

| Transport | Flag | Description |
|-----------|------|-------------|
| **stdio** (default) | `--transport stdio` | One-client, launched per-process by MCP hosts (Codex, Claude Code, Cursor, etc.) |
| **HTTP** | `--transport http` | Streamable HTTP on `/mcp`. Stateful sessions — each client gets its own `McpServer` instance. Shared resource caches across sessions. |

### CLI Flags

```
ragclaw-mcp [options]

Options:
  --transport <type>   Transport type: "stdio" or "http"    (default: "stdio")
  --port <number>      Port for HTTP transport               (default: "3000")
  --host <host>        Host/IP for HTTP transport            (default: "127.0.0.1")
  --log-level <level>  Log level: debug, info, warn, error   (default: "info")
  -V, --version        Output the version number
  -h, --help           Display help for command
```

### Tools (14)

All tool names use `snake_case` with a `kb_` prefix.

| Tool | Description |
|------|-------------|
| `kb_search` | Hybrid/vector/keyword search with query decomposition and RRF |
| `kb_read_source` | Retrieve full indexed content of a source |
| `kb_add` | Index file, directory, or URL (with optional crawl) |
| `kb_status` | Knowledge base statistics |
| `kb_remove` | Remove a source from the index |
| `kb_reindex` | Re-process changed sources |
| `kb_db_merge` | Merge another `.db` file |
| `kb_list_chunkers` | List available chunkers (built-in + plugin) |
| `kb_list_databases` | List all knowledge bases with metadata |
| `kb_db_init` | Create a new knowledge base |
| `kb_db_info` | Set description and keywords |
| `kb_db_info_get` | Read description and keywords |
| `kb_db_delete` | Delete a knowledge base (requires `confirm: true`) |
| `kb_db_rename` | Rename a knowledge base (requires `confirm: true`) |

### HTTP Transport Details

- **Endpoints:** `POST /mcp` (JSON-RPC), `GET /mcp` (SSE notifications), `DELETE /mcp` (session termination), `GET /healthz` (liveness/readiness probe — returns `{"status":"ok"}`)
- **Session model:** Stateful — session IDs assigned via `mcp-session-id` header.
- **Authentication:** None (localhost-only by default). A warning is logged when binding to `0.0.0.0`.
- **Graceful shutdown:** SIGINT/SIGTERM close all active transports and cached SQLite stores before exit.
- **DNS rebinding protection:** Provided by `createMcpExpressApp()` from the MCP SDK.

### Logging

Pino to stderr in both transports. Pretty-printed in development, JSON in production
(`NODE_ENV=production`). Controlled via `--log-level`.

## OpenClaw Skill Integration

### Commands

```
/rag add <url|path>     — Index a source
/rag search <query>     — Search knowledge base
/rag status             — Show stats
/rag remove <source>    — Remove from index
```

### Auto-Context

When enabled, RagClaw automatically:
1. Queries the knowledge base for relevant context
2. Injects top-K results into the system prompt
3. Cites sources in responses

### Skill Configuration

```yaml
# In OpenClaw config
skills:
  ragclaw:
    enabled: true
    database: default
    autoContext:
      enabled: true
      topK: 5
      minScore: 0.7
```

## File Support Matrix

| Extension | Extractor | Chunker |
|-----------|-----------|---------|
| `.md` | Markdown | Semantic |
| `.txt` | Text | Semantic |
| `.pdf` | PDF | Semantic |
| `.docx` | DOCX | Semantic |
| `.ts`, `.tsx` | Code | Code (tree-sitter) |
| `.js`, `.jsx` | Code | Code (tree-sitter) |
| `.java` | Code | Code (tree-sitter) |
| `.go` | Code | Code (tree-sitter) |
| `.py` | Code | Code (tree-sitter) |
| URL | Web | Semantic |

## Dependencies

### Runtime Requirements
- **Node.js 22.x** (LTS) — Node 23+ not supported due to native module compatibility (tree-sitter, better-sqlite3)

### Core (required)
- `better-sqlite3` — SQLite binding
- `@huggingface/transformers` — ONNX runtime for embeddings

### Extractors (optional, loaded on demand)
- `pdfjs-dist` — PDF extraction
- `mammoth` — DOCX extraction
- `cheerio` — HTML parsing

### Code Parsing (optional)
- `tree-sitter` — AST parsing
- `tree-sitter-typescript`
- `tree-sitter-java`
- `tree-sitter-go`
- `tree-sitter-python`

### Extensions (optional, native)
- `sqlite-vec` — Fast vector search

## Configuration

```typescript
interface RagClawConfig {
  // Storage
  dataDir: string;              // Default: ~/.local/share/ragclaw
  database: string;             // Default: "default"

  // Embedder — string alias ("nomic", "bge") or object config
  embedder?: string | EmbedderConfigBlock;

  // Chunking
  chunkSize: number;            // Default: 512 tokens
  chunkOverlap: number;         // Default: 50 tokens

  // Pluggable chunker config (new)
  chunking?: ChunkingConfig;

  // Search
  defaultLimit: number;         // Default: 10
  defaultMode: 'vector' | 'keyword' | 'hybrid';  // Default: 'hybrid'
  hybridWeights: {
    vector: number;             // Default: 0.7
    keyword: number;            // Default: 0.3
  };
}

interface ChunkingConfig {
  strategy?: string;             // Global default chunker name (e.g. "sentence")
  defaults?: {
    chunkSize?: number;
    overlap?: number;
  };
  overrides?: ChunkingOverride[]; // First-match glob rules
}

interface ChunkingOverride {
  pattern: string;               // picomatch glob against source path
  chunker: string;               // chunker name to use when pattern matches
  chunkSize?: number;
  overlap?: number;
}

interface EmbedderConfigBlock {
  plugin?: string;      // Plugin name (for plugin-provided embedders)
  model?: string;       // HuggingFace model ID
  dimensions?: number;  // Override dimensions
  baseUrl?: string;     // API base URL (Ollama, OpenAI-compatible)
}
```

## Performance Considerations

- **Model Loading:** ~2-3 seconds on first query (cached in memory after)
- **Embedding:** ~50ms per chunk (batched for efficiency)
- **Vector Search:** <10ms with sqlite-vec, ~100ms fallback for 10K chunks
- **Index Size:** ~1KB per chunk (text + embedding + metadata)

## Future Enhancements

- [x] **Database merge** — `ragclaw db merge <source.db>` copies sources+chunks from one SQLite KB into another; supports `strict` (same embedder, copy embeddings) and `reindex` (re-embed text with local model) strategies; conflict resolution (`skip` / `prefer-local` / `prefer-remote`); `--dry-run` diff preview; `--include`/`--exclude` path filters; `kb_db_merge` MCP tool; `ragclaw merge` kept as deprecated alias
- [ ] Incremental re-indexing (watch mode)
- [ ] Audio transcription
- [ ] Multi-database queries
- [ ] Remote/shared databases

## Completed Enhancements

- [x] **Image OCR extraction** — Using `tesseract.js` for images and scanned PDFs
- [x] **Plugin system** — Extensible architecture for custom extractors (`ragclaw-plugin-*`)
- [x] **YouTube plugin** — Index video transcripts via `youtube://` scheme
- [x] **GitHub plugin** — Index repos, issues, PRs via `github://` scheme
- [x] **Obsidian plugin** — Index vaults and notes via `obsidian://` scheme
- [x] **XDG Base Directory** — Proper paths (`~/.local/share/ragclaw/`, `~/.config/ragclaw/`)
- [x] **MCP server** — Integration with Codex, Claude Code, OpenCode
- [x] **`ragclaw db list` / `kb_list_databases`** — List all available knowledge bases; opens each `.sqlite` to read `db_description` and `db_keywords` metadata; default output shows description + keywords inline; `--json` returns object array `[{ name, description, keywords }]`; `kb_list_databases` MCP tool returns the same object array
- [x] **`ragclaw db init/delete/rename/merge`** — Full database lifecycle management under `db` subcommand group; `ragclaw init` and `ragclaw merge` kept as deprecated top-level aliases; MCP tools: `kb_db_init`, `kb_db_delete` (requires `confirm: true`), `kb_db_rename` (requires `confirm: true`), `kb_db_merge`
- [x] **`ragclaw db info set` / `kb_db_info`** — Set `db_description` and `db_keywords` metadata on an existing knowledge base; metadata stored as `store_meta` keys; surfaces in `db list`, `db list --json`, `status`, and MCP `kb_list_databases`; `ragclaw db init` also accepts `--description`/`--keywords` at creation time
- [x] **`ragclaw db info get` / `kb_db_info_get`** — Read `db_description` and `db_keywords` from a knowledge base; plain output shows `(not set)` for absent fields; `--json` returns `{ name, description, keywords }`; MCP `kb_db_info_get` tool returns the same JSON object
- [x] **Removed `kb_list` MCP tool** — Agents must retrieve content via `kb_search` rather than enumerating and reading individual sources; use `kb_status` or `kb_list_databases` for overview information
- [x] **Upgraded transformers.js** — Migrated to `@huggingface/transformers` v3
- [x] **Embedder plugin system** — Multiple built-in presets (nomic/bge/mxbai/minilm), plugin-provided embedders, store metadata tracking, system requirements checker, `ragclaw doctor` command
- [x] **Pluggable chunker system** — Four built-in chunkers (`semantic`, `code`, `sentence`, `fixed`); `Chunker` interface now exposes `name`/`description`/`handles`; priority-based `resolveChunker()` (CLI flag → config overrides → plugin chunkers → built-in auto); `--chunker`/`--chunk-size`/`--overlap` flags on `ragclaw add` and `ragclaw reindex`; `ragclaw chunkers list [--json]`; `chunking:` config block with `strategy`/`defaults`/`overrides[]`; MCP: `chunker`/`chunkSize`/`overlap` params on `kb_add`/`kb_reindex`, `kb_list_chunkers` tool; unknown chunker name → hard fail with typo suggestion
- [x] **`ragclaw read` / `kb_read_source`** — Retrieve the full indexed content of a source from the knowledge base; returns all chunks in document order, concatenated; agents should use this instead of reading original files when they need more context than a single search chunk provides; CLI: `ragclaw read <source> [--db <name>] [--json]`; MCP: `kb_read_source` tool with `source` and optional `db` params; search results now return full chunk text (no truncation) so agents have complete content without needing to go to source files
