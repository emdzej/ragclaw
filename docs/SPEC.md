# RagClaw Specification

## Overview

RagClaw is a local-first RAG (Retrieval-Augmented Generation) engine designed for OpenClaw. It indexes various content sources into a SQLite database with vector and full-text search capabilities.

## Design Principles

1. **Zero-Ops** — No external services, no Docker, no API keys required
2. **Local-First** — All data stays on the user's machine
3. **Graceful Degradation** — Works even if native extensions fail to load
4. **Extensible** — Pluggable extractors, chunkers, and embedding models

## Package Structure

```
@emdzej/ragclaw (monorepo)
├── @emdzej/ragclaw-core      # Extractors, chunkers, embedder, store
├── @emdzej/ragclaw-cli       # Standalone CLI tool
└── @emdzej/ragclaw-skill     # OpenClaw skill integration
```

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

**Semantic Chunker** (for documents):
- Split by paragraphs/sections
- Respect heading boundaries
- Target size: 512 tokens with 50 token overlap
- Preserve context (include parent heading)

**Code Chunker** (for source files):
- Parse AST with tree-sitter
- Chunk by: function, class, method, top-level block
- Include: signature, docstring, body
- Languages: TypeScript/JavaScript, Java, Go, Python

**Chunker Interface:**
```typescript
interface Chunker {
  canHandle(content: ExtractedContent): boolean;
  chunk(content: ExtractedContent): Promise<Chunk[]>;
}

interface Chunk {
  id: string;                    // UUID
  text: string;                  // Chunk content
  sourceId: string;              // Reference to source
  sourcePath: string;            // File path or URL
  startLine?: number;            // For files
  endLine?: number;
  metadata: {
    type: 'paragraph' | 'section' | 'function' | 'class' | 'method';
    heading?: string;            // Parent heading for docs
    name?: string;               // Function/class name for code
    language?: string;           // Programming language
    [key: string]: unknown;
  };
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

-- Store metadata (embedder tracking, schema versioning)
CREATE TABLE IF NOT EXISTS store_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Keys: embedder_name, embedder_model, embedder_dimensions

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

### `ragclaw init <name>`
Create a new knowledge base.

```bash
ragclaw init my-docs
# Creates ~/.openclaw/ragclaw/my-docs.sqlite
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

  // Search
  defaultLimit: number;         // Default: 10
  defaultMode: 'vector' | 'keyword' | 'hybrid';  // Default: 'hybrid'
  hybridWeights: {
    vector: number;             // Default: 0.7
    keyword: number;            // Default: 0.3
  };
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
- [x] **Upgraded transformers.js** — Migrated to `@huggingface/transformers` v3
- [x] **Embedder plugin system** — Multiple built-in presets (nomic/bge/mxbai/minilm), plugin-provided embedders, store metadata tracking, system requirements checker, `ragclaw doctor` command
