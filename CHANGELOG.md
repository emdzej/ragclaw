# Changelog

## [0.6.0] — 2026-03-23

### New features

#### `ragclaw-plugin-ollama` — local embeddings via Ollama

A new official plugin that delegates embedding to a locally-running [Ollama](https://ollama.com) server instead of bundling an ONNX model. Any model served by Ollama can be used as the embedder for a knowledge base.

Key characteristics:
- `OllamaEmbedder` implements the `EmbedderPlugin` interface — zero changes needed in core or CLI
- Dimensions are pre-wired for popular models (`nomic-embed-text` → 768, `mxbai-embed-large` → 1024, `all-minilm` → 384, `snowflake-arctic-embed` → 1024, BGE variants); unknown models auto-detect on first call
- `embedBatch()` falls back to sequential calls (Ollama has no batch API)
- `init()` performs a live health-check embed to verify the server and model are reachable before indexing starts
- Configurable via `model` and `baseUrl` plugin config keys (default base URL: `http://localhost:11434`)

```yaml
# ~/.config/ragclaw/config.yaml
embedder:
  plugin: ragclaw-plugin-ollama
  model: nomic-embed-text
  baseUrl: http://localhost:11434
```

#### Pluggable chunker system

Four built-in chunkers are now available and selectable per-source:

| Chunker | Best for |
|---------|----------|
| `semantic` | Markdown/prose — splits on headings and blank lines |
| `sentence` | Natural language — uses `Intl.Segmenter`, zero extra deps |
| `fixed` | Universal word-count fallback — `canHandle` is always true |
| `code` | Source code — AST-aware via tree-sitter |

**Chunker resolution priority** (highest → lowest):
1. CLI `--chunker` flag
2. `chunking.overrides[]` in config (first-match glob or MIME prefix)
3. Plugin-provided chunkers
4. Built-in auto-selection (code files → `code`, everything else → `semantic`)
5. Hard fail with typo suggestion if an explicit name is unknown

New CLI flags on `ragclaw add` and `ragclaw reindex`:
```bash
--chunker <name>      # select chunker by name
--chunk-size <n>      # override token target (default: 512)
--overlap <n>         # override overlap tokens (default: 50)
```

New command:
```bash
ragclaw chunkers list          # show all available chunkers
ragclaw chunkers list --json   # machine-readable
```

New MCP tools: `rag_list_chunkers`; `rag_add` and `rag_reindex` now accept `chunker`, `chunkSize`, and `overlap` params.

Config overrides also support a `mimeType` field (prefix-matched) that can be used alone or combined with a glob `pattern` (AND logic):

```yaml
chunking:
  overrides:
    - pattern: "src/**"
      chunker: code
    - mimeType: "text/html"
      chunker: sentence
```

#### `ragclaw db` subcommand group — full KB lifecycle management

All database management commands are now grouped under `ragclaw db`. The old top-level `ragclaw init` and `ragclaw merge` are kept as deprecated aliases that print a warning to stderr.

```bash
ragclaw db init <name>                   # create a KB (idempotent)
ragclaw db delete <name> [--yes]         # delete a KB (prompts unless --yes)
ragclaw db rename <old> <new>            # rename a KB
ragclaw db merge <source.db> [options]   # merge another KB (replaces top-level ragclaw merge)
```

Corresponding MCP tools: `rag_db_init`, `rag_db_delete` (requires `confirm: true`), `rag_db_rename` (requires `confirm: true`), `rag_db_merge`.

#### `ragclaw db list` / `rag_list_databases` — enumerate knowledge bases

List all knowledge bases in the data directory:

```bash
ragclaw db list           # names with description and keywords inline
ragclaw db list --json    # [{ name, description, keywords }]
```

`rag_list_databases` MCP tool returns the same object array, enabling agents to enumerate and pick the right KB automatically.

#### KB description and keywords metadata

Knowledge bases can carry a human-readable description and a keyword list. These fields are stored as `store_meta` entries (`db_description`, `db_keywords`) — no schema migration required.

```bash
# Set at creation time
ragclaw db init api-docs --description "REST API documentation" --keywords "api, auth, rest"

# Update on an existing KB
ragclaw db info set --db api-docs --description "Updated description" --keywords "api, v2"
```

Metadata surfaces in `db list`, `db list --json`, `ragclaw status`, and `rag_list_databases`. AI agents use it to route queries to the most relevant KB without user intervention.

MCP tool: `rag_db_info` (set/update metadata).

#### `ragclaw db info get` / `rag_db_info_get` — read KB metadata

Read-side companion to `db info set`:

```bash
ragclaw db info get --db my-docs          # plain output
ragclaw db info get --db my-docs --json   # { name, description, keywords }
```

Plain output shows `(not set)` for absent fields. The `rag_db_info_get` MCP tool returns the same JSON object.

#### `rag_list` — KB metadata header

The `rag_list` MCP tool now prepends a description/keywords header before the sources list, so agents receive KB context alongside the indexed paths in a single call.

---

## [0.5.0] — 2026-03-21

### New features

#### MCP server — migrated to `McpServer` with Zod schemas

The MCP server now uses the modern `McpServer` API from the `@modelcontextprotocol/sdk` instead of the deprecated low-level `Server` class. All tool input schemas are defined with Zod, giving full runtime validation and accurate JSON Schema generation for every MCP tool exposed to AI assistants.

#### Dynamic version reporting in MCP server and all plugins

The MCP server and all three official plugins (`ragclaw-plugin-obsidian`, `ragclaw-plugin-github`, `ragclaw-plugin-youtube`) now read their version at runtime from their own `package.json` via `createRequire`. This mirrors the existing pattern in the CLI and ensures the reported version is always correct after any package bump.

#### E2E test suite

A new end-to-end test suite covering the full CLI surface (20 tests) was added under `e2e/`. A dedicated CI lint job was also introduced to enforce Biome rules on every pull request.

---

## [0.4.0] — 2026-03-21

### New features

#### Web crawler (`ragclaw add --crawl`)

You can now crawl an entire website and index every reachable page in one command:

```bash
ragclaw add --crawl https://example.com/docs
```

New flags on `ragclaw add` (and the `rag_add` MCP tool):

| Flag | Default | Description |
|------|---------|-------------|
| `--crawl` | — | Enable BFS crawling from the given URL |
| `--crawl-max-depth <n>` | `3` | Maximum link-follow depth |
| `--crawl-max-pages <n>` | `100` | Hard cap on pages indexed |
| `--crawl-same-origin` | `true` | Stay on the same hostname |
| `--crawl-include <patterns>` | — | Comma-separated URL path prefixes to allow |
| `--crawl-exclude <patterns>` | — | Comma-separated URL path prefixes to skip |
| `--crawl-concurrency <n>` | `3` | Parallel in-flight requests |
| `--crawl-delay <ms>` | `200` | Polite delay between requests |
| `--ignore-robots` | `false` | Ignore `robots.txt` rules |

The crawler respects `robots.txt` by default, normalises URLs to avoid duplicates, and filters to same-origin links unless `--crawl-same-origin false` is passed.

#### Knowledge base merge (`ragclaw merge`)

Merge one SQLite knowledge base into another without re-indexing from scratch:

```bash
# Merge remote.db into the default KB (strict — embeddings copied verbatim)
ragclaw merge remote.db

# Re-embed all imported text with the local model
ragclaw merge remote.db --strategy reindex

# Preview what would change without writing anything
ragclaw merge remote.db --dry-run

# Conflict resolution
ragclaw merge remote.db --on-conflict prefer-remote

# Selective import
ragclaw merge remote.db --include docs/,wiki/
ragclaw merge remote.db --exclude tmp/
```

| Flag | Default | Description |
|------|---------|-------------|
| `--strategy <s>` | `strict` | `strict` (copy embeddings) or `reindex` (re-embed locally) |
| `--on-conflict <r>` | `skip` | `skip`, `prefer-local`, or `prefer-remote` |
| `--dry-run` | — | Show a diff without writing anything |
| `--include <paths>` | — | Comma-separated source path prefixes to import |
| `--exclude <paths>` | — | Comma-separated source path prefixes to skip |

Each merge is recorded in a `merge_history` table inside the target database. The `rag_merge` MCP tool exposes the same functionality to AI assistants.

#### Offline model pre-download (`ragclaw embedder download`)

Pre-fetch embedding model files before going offline or before a CI/CD pipeline runs:

```bash
ragclaw embedder download nomic
ragclaw embedder download --all
```

Models already present in the local cache are silently skipped. The command exits with code `1` if any download fails, making it safe to use in scripts.

### Bug fixes

- **CLI version flag** — `ragclaw --version` now reads the version from `package.json` at runtime instead of a hardcoded string.

---

## [0.3.0] — 2026-03-20

### New features

#### Embedder plugin system

The core engine now supports a full embedder plugin abstraction. Embedders are loaded as external npm packages (`@emdzej/ragclaw-embedder-*`) and configured via `.ragclawrc.yaml`. Built-in presets (`nomic`, `minilm`, `bge-small`, `bge-base`) are supported out of the box.

- Store metadata records which embedder produced the vectors, and the system warns (or errors) when a mismatch is detected at query time.
- Dimension-aware storage ensures vector column widths adapt to the chosen model.
- `ragclaw embedder list` shows all installed presets with their status.

#### System requirements checker (`ragclaw doctor`)

`ragclaw doctor` inspects the runtime environment and reports:

- Node.js version compatibility
- Available system RAM vs. embedder requirements
- `sqlite-vec` native extension availability
- Plugin load status

RAM detection uses available RAM (free + reclaimable cache) on Linux, giving accurate readings inside containers.

#### Auto-loading `sqlite-vec`

The `sqlite-vec` native extension is now auto-loaded from the `sqlite-vec` npm optional dependency when present, with a clear warning if it is absent rather than a cryptic crash.

#### Configuration system

A YAML-based configuration file (`.ragclawrc.yaml`) supports:

- Custom data directory paths
- Embedder preset selection per knowledge base
- Plugin enable/disable
- Config guards and CLI `ragclaw config get/set/list` subcommands

#### Security and robustness hardening

- Database names are sanitised to prevent path traversal.
- SHA hashing uses a streaming implementation to handle large files without loading them fully into memory.
- Plugin-level size limits prevent runaway indexing of oversized sources.

---

## [0.2.0] — 2026-03-20

### New features

#### Test suite (tier 1–3)

Comprehensive Vitest test coverage was introduced across all packages:

- **Tier 1** — unit tests for core utilities (chunkers, extractors, hashing)
- **Tier 2–3** — integration tests for the store, embedder, plugins, and loader

#### Streamable SHA hashing

Internal content hashing was refactored to use a streaming pipeline, enabling efficient change-detection on large files.

#### Initial plugin infrastructure

Foundational plugin loading and the `ragclaw plugin list/enable/disable` commands were introduced, along with the three official plugins:

- **`ragclaw-plugin-obsidian`** — indexes Obsidian vaults via `obsidian://` and `vault://` schemes
- **`ragclaw-plugin-github`** — indexes GitHub repositories, issues, PRs, and discussions via `github://` and `gh://` schemes
- **`ragclaw-plugin-youtube`** — indexes YouTube video transcripts via `youtube://` and `yt://` schemes

---

## [0.1.0] — 2026-03-20

Initial release.

- Local-first RAG engine backed by SQLite + `sqlite-vec`
- `ragclaw add` — index files, directories, and URLs
- `ragclaw search` — hybrid vector + keyword search
- `ragclaw reindex` — incremental re-indexing of changed sources
- `ragclaw status` / `ragclaw list` / `ragclaw remove`
- `ragclaw init` — create a named knowledge base
- MCP server (`ragclaw-mcp`) exposing all operations as MCP tools
- Support for Markdown, PDF, DOCX, code files, and web pages
- OpenCode skill (`/rag`) for direct use inside AI coding sessions
