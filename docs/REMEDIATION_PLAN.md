# RagClaw Remediation Plan

Derived from `AUDIT_REPORT.md`. Each task is a discrete, independently implementable unit of work. Tasks are grouped by phase and ordered by priority within each phase.

Implementation details are decided task-by-task before work begins.

---

## Phase 0 — Immediate (Security-Critical)

### TASK-01 — Fix command injection in GitHub plugin

- **Finding:** F-01 (High)
- **File(s):** `plugins/ragclaw-plugin-github/src/index.ts`
- **Problem:** Shell commands are constructed by interpolating user-derived strings (owner, repo, number parsed from `github://` URIs) into a template string passed to `execSync`. This allows command injection.
- **Status:** `done`
- **Resolution:** Replaced `execSync` (shell string) with `execFileSync` (args array) — eliminates shell interpretation entirely. Added `SAFE_SLUG` regex validation for owner/repo and `Number.isInteger` + positive check for issue/PR numbers as defence in depth.

---

### TASK-02 — Restrict automatic plugin discovery and loading

- **Finding:** F-02 (High)
- **File(s):** `packages/cli/src/plugins/loader.ts`, `packages/cli/src/commands/add.ts`, `packages/cli/src/commands/plugin.ts`, `packages/cli/src/config.ts`, `packages/cli/src/cli.ts`, `packages/core/src/plugin.ts`
- **Problem:** Plugins are auto-discovered from global npm packages and local directories, then dynamically imported and executed without any user consent or allowlist. Any package matching the naming convention runs code automatically.
- **Status:** `done`
- **Resolution:** Plugins are now opt-in. Added `enabledPlugins` allowlist and `scanGlobalNpm` flag (default `false`) to `PluginLoaderOptions`. The `loadAll()` method filters discovered plugins against the allowlist — unlisted plugins are never imported or executed. Config is stored as a `plugins:` line in `config.yaml`. New CLI commands: `ragclaw plugin enable <name>`, `ragclaw plugin enable --all`, `ragclaw plugin disable <name>`. `plugin list` now shows enabled/disabled status per plugin.

---

### TASK-03 — Restrict MCP `rag_add` to scoped paths and URLs

- **Finding:** F-03 (High)
- **File(s):** `packages/mcp/src/index.ts`, `packages/core/src/extractors/web.ts`, `packages/core/src/config.ts` (new), `packages/cli/src/config.ts`, `packages/cli/src/cli.ts`
- **Problem:** The MCP `rag_add` tool accepts arbitrary local filesystem paths, recursive directories, and remote URLs with no scope restrictions. Sensitive files can be indexed and later retrieved via `rag_search` excerpts. Additionally, config logic is duplicated between CLI and MCP, making it hard to share settings.
- **Status:** `done`

This task is broken into sub-tasks due to scope:

#### TASK-03a — Move config module into `@emdzej/ragclaw-core`

Move the config logic (`getConfig`, `getDbPath`, config file parsing, etc.) from `packages/cli/src/config.ts` into `packages/core/src/config.ts` so both CLI and MCP can import from the same source. Re-export from CLI for backwards compatibility. Add a `overrides?: Partial<RagclawConfig>` parameter so CLI flags and env vars can override config file values.

- **Status:** `done`
- **Resolution:** Created `packages/core/src/config.ts` with all config logic, `RagclawConfig` interface, and `overrides?: Partial<RagclawConfig>` parameter on `getConfig()`. Exported `resetConfigCache()` for use by `setEnabledPlugins()` and tests. CLI's `config.ts` is now a re-export barrel — all 9 consumer files unchanged. MCP's duplicated config block (lines 31–53) replaced with `import { getConfig, getDbPath } from "@emdzej/ragclaw-core"`. All three packages type-check clean.

#### TASK-03b — Add security-scoping config keys with three-layer resolution

Add new config keys with built-in defaults, configurable via config file, env vars, and CLI flags. Resolution order: CLI flag > env var > config file > built-in default.

| Key | Config file | Env var | CLI flag | Default |
|-----|-------------|---------|----------|---------|
| `allowedPaths` | `allowedPaths:` | `RAGCLAW_ALLOWED_PATHS` | `--allowed-paths` | `""` (MCP: cwd only) |
| `allowUrls` | `allowUrls:` | `RAGCLAW_ALLOW_URLS` | `--allow-urls` / `--no-allow-urls` | `true` |
| `blockPrivateUrls` | `blockPrivateUrls:` | `RAGCLAW_BLOCK_PRIVATE_URLS` | `--block-private-urls` / `--no-block-private-urls` | `true` |
| `maxDepth` | `maxDepth:` | `RAGCLAW_MAX_DEPTH` | `--max-depth` | `10` |
| `maxFiles` | `maxFiles:` | `RAGCLAW_MAX_FILES` | `--max-files` | `1000` |

- **Status:** `done`
- **Resolution:** Extended `RagclawConfig` interface with 5 new fields. `getConfig()` parses all from config file (comma-separated paths → `resolve(expandHome())`; `"true"/"false"` → boolean; `parseInt` with `>0` validation for numbers) and env vars. Overrides parameter applies last. CLI flag wiring is deferred to TASK-03e; enforcement to TASK-03d.

#### TASK-03c — Add `ragclaw config get/set/list` CLI commands

Generic config management commands so users can persistently configure settings without manually editing YAML:

```bash
ragclaw config list                                          # show all values + source
ragclaw config get allowedPaths                              # show single key
ragclaw config set allowedPaths "/Users/me/projects, /docs"  # persist to config.yaml
```

- **Status:** `done`
- **Resolution:** Added `setConfigValue(yamlKey, rawValue)` to core — generic write to config.yaml with validation against `SETTABLE_KEYS` metadata array. Refactored `setEnabledPlugins()` to delegate to `setConfigValue("plugins", ...)`. Created `packages/cli/src/commands/config.ts` with `configList`, `configGet`, `configSet`. Wired `ragclaw config list|get|set` subcommands into `cli.ts`. `config list` shows all keys with resolved values and source (`[env]` / `[default]`). `config set` validates types before writing (positive int for numbers, `"true"/"false"` for booleans).

#### TASK-03d — Enforce path/URL restrictions in MCP server

Replace MCP's duplicated config code with shared config import. Add `isPathAllowed()` (checks resolved path against `allowedPaths`, defaults to cwd), `isUrlAllowed()` (blocks private/reserved IP ranges when `blockPrivateUrls` is true), and recursion limits (`maxDepth`, `maxFiles`) in `collectSources` / `collectFilesRecursive`. Return clear error messages explaining why a path/URL was blocked and how to adjust.

- **Status:** `done`
- **Resolution:** Created `packages/core/src/guards.ts` with `isPathAllowed()` and `isUrlAllowed()`. `isPathAllowed` resolves the target and checks it starts with one of the `allowedPaths` entries (or `fallbackCwd` when the list is empty — used by MCP to default to cwd). `isUrlAllowed` performs DNS resolution and rejects private/reserved IP ranges (127.x, 10.x, 172.16–31.x, 192.168.x, 169.254.x, 100.64–127.x, 198.18–19.x, ::1, fe80::, fc/fd ULA, IPv4-mapped). Exported from `@emdzej/ragclaw-core`. MCP `collectSources()` calls both guards before processing; `collectFilesRecursive()` enforces `maxDepth` and `maxFiles` from config.

#### TASK-03e — Pass CLI flag overrides through to `add` and `reindex` commands

Wire `--allowed-paths`, `--max-depth`, `--max-files`, `--allow-urls`, `--block-private-urls` / `--no-block-private-urls`, and `--enforce-guards` / `--no-enforce-guards` flags into `ragclaw add` and `ragclaw reindex` so per-invocation overrides work for the CLI as well.

- **Status:** `done`
- **Resolution:** Added `enforceGuards` boolean to `RagclawConfig` (default `false`), with config-file, env-var (`RAGCLAW_ENFORCE_GUARDS`), and CLI-flag resolution. When `enforceGuards` is false (default), CLI skips all path/URL guards — the user is trusted. When true, CLI enforces the same guards as MCP: `isPathAllowed()`, `isUrlAllowed()`, `maxDepth`, `maxFiles`. Both `add` and `reindex` commands accept all security flags and build a `Partial<RagclawConfig>` that's passed to `getConfig(overrides)`. The `reindex` summary now includes a "Blocked" count when guards reject sources.

---

### TASK-04 — Add timeouts and size limits to network fetches and heavy extractors

- **Finding:** F-04 (Medium)
- **File(s):** `packages/core/src/extractors/web.ts`, `packages/core/src/extractors/pdf.ts`, `packages/core/src/extractors/image.ts`, `packages/core/src/config.ts`, `packages/core/src/plugin.ts`, `packages/core/src/index.ts`, `packages/cli/src/config.ts`, `packages/cli/src/commands/add.ts`, `packages/cli/src/commands/reindex.ts`, `packages/cli/src/commands/config.ts`, `packages/mcp/src/index.ts`, `plugins/ragclaw-plugin-github/src/index.ts`, `plugins/ragclaw-plugin-obsidian/src/index.ts`, `plugins/ragclaw-plugin-youtube/src/index.ts`
- **Problem:** Remote fetches have no timeout or response body size cap. PDF processing loads the full file into memory with no page budget. OCR runs without any time or resource limit. Plugin configuration has no mechanism.
- **Status:** `done`
- **Resolution:** Three-layer implementation:
  1. **`ExtractorLimits`** — Added `fetchTimeoutMs` (30s), `maxResponseSizeBytes` (50MB), `maxPdfPages` (200), `ocrTimeoutMs` (60s) to `RagclawConfig`. Configurable via `extractor.<key>` in config.yaml, env vars (`RAGCLAW_FETCH_TIMEOUT_MS`, etc.), and `ragclaw config set`. `WebExtractor` uses `AbortController` timeout + streaming body size cap. `PdfExtractor` caps page loop to `maxPdfPages` + wraps OCR in `Promise.race` timeout. `ImageExtractor` wraps `Tesseract.recognize` in `Promise.race` timeout. `ocrFromBuffer` accepts optional timeout.
  2. **`pluginConfig`** — Added `Record<string, Record<string, unknown>>` to `RagclawConfig`, parsed from `plugin.<name>.<key>` lines in config.yaml. Passed through `PluginLoader` → `plugin.init(config)`.
  3. **`configSchema`** on `RagClawPlugin` — Optional `PluginConfigKey[]` array for documenting plugin-accepted keys. All three built-in plugins now declare schemas and consume config via `init()`: GitHub (`maxIssues`, `maxPRs`, `maxBuffer`), Obsidian (`maxNotes`, `maxNoteSize`), YouTube (`fetchTimeoutMs`). `parseSimpleYaml()` extended to handle dotted keys (`[\w]+(?:\.[\w]+)*`).

---

## Phase 1 — Near Term (Hardening & Performance)

### TASK-05 — Sanitise knowledge base names and enforce path containment

- **Finding:** F-05 (Medium)
- **File(s):** `packages/core/src/config.ts`, `packages/core/src/index.ts`, `packages/cli/src/config.ts`
- **Problem:** Knowledge base names are interpolated directly into filesystem paths with no character validation. A crafted name could result in a DB file outside the intended data directory.
- **Status:** `done`
- **Resolution:** Added `sanitizeDbName()` that validates names against `[a-zA-Z0-9_-]{1,64}` regex — rejects path separators, `..`, empty strings, and any unsafe characters. Called inside `getDbPath()` so all 24 call sites (CLI + MCP) are protected automatically. Defence-in-depth path containment check verifies the resolved path stays within `dataDir` after `join()`. Exported from `@emdzej/ragclaw-core` and CLI barrel.

---

### TASK-06 — Replace full-file hashing with streaming SHA-256

- **Finding:** F-10 (Medium)
- **File(s):** `packages/core/src/utils/hash.ts` (new), `packages/core/src/index.ts`, `packages/cli/src/commands/add.ts`, `packages/cli/src/commands/reindex.ts`, `packages/mcp/src/index.ts`
- **Problem:** Change detection reads entire files into memory before hashing. For large files this wastes memory and adds latency.
- **Status:** `done`
- **Resolution:** Created `hashFile(filePath)` in `packages/core/src/utils/hash.ts` — uses `createReadStream` piped through `crypto.createHash("sha256")`, so the file is read in ~64 KB stream chunks and never held fully in memory. Replaced all 4 `readFile` + `createHash().update(content)` call sites (CLI add, CLI reindex, MCP add, MCP reindex) with `await hashFile(path)`. URL sources still use inline `createHash` with a timestamp string (no file to stream). Note: hashes now operate on raw bytes rather than UTF-8/base64 text, so the first `reindex` after upgrade will re-index all files once (one-time, no data loss).

---

### TASK-07 — Fix embedding batch to use true batched inference

- **Finding:** F-09 (Medium)
- **File(s):** `packages/core/src/embedder/index.ts`
- **Problem:** `embedBatch()` groups texts into slices of 32 but still invokes the embedding model individually per item inside the batch. This negates the batching benefit and slows all indexing operations.
- **Status:** `done`
- **Resolution:** Changed the inner loop to pass the full batch array to the `@huggingface/transformers` pipeline in a single call. The pipeline tokenises all texts and runs one forward pass per batch, returning a `Tensor` of shape `[N, 768]`. The flat backing `Float32Array` is sliced into per-text embeddings. Batch size remains 32 to bound memory. This is a pure performance improvement — no API or data format changes.

---

### TASK-08 — Pin GitHub Actions to immutable commit SHAs

- **Finding:** F-07 (Medium)
- **File(s):** `.github/workflows/ci.yaml`, `.github/workflows/publish.yaml`
- **Problem:** All `uses:` references are pinned to mutable version tags (e.g. `actions/checkout@v4`) rather than immutable commit SHAs, exposing the pipeline to upstream tag mutation.
- **Status:** `done`
- **Resolution:** Pinned all 6 `uses:` references (3 in ci.yaml, 3 in publish.yaml) to full commit SHAs with version comments for readability: `actions/checkout@34e1148…` (v4), `actions/setup-node@49933ea…` (v4.4.0), `pnpm/action-setup@fc06bc1…` (v4.4.0). Tags can no longer be silently mutated upstream.

---

### TASK-09 — Add automated security scanning to CI

- **Finding:** F-07 (Medium)
- **File(s):** `.github/workflows/ci.yaml`
- **Problem:** The CI workflow runs lint, build, and tests but has no dependency audit (`pnpm audit`), SCA, SAST (e.g. CodeQL), or secret scanning steps.
- **Status:** `done`
- **Resolution:** Added a `security` job to `ci.yaml` with two steps: (1) `pnpm audit --audit-level=high` for dependency vulnerability scanning, and (2) GitHub CodeQL `init` + `analyze` for JavaScript/TypeScript SAST. The job has `permissions: security-events: write` so CodeQL results upload to the Security tab. All action references are SHA-pinned consistent with TASK-08.

---

## Phase 2 — Medium Term (Architecture & Scalability)

### TASK-10 — Fix search result source-path attribution

- **Finding:** F-12 (Low/Medium)
- **File(s):** `packages/core/src/store/index.ts`
- **Problem:** `rowToChunk()` sets `sourcePath: ""`. Downstream display code in the CLI and MCP server uses `chunk.sourcePath` directly, so search results show empty or missing source paths.
- **Status:** `done`
- **Resolution:** Added `JOIN sources s ON s.id = c.source_id` and `SELECT s.path AS source_path` to all three search query paths: `vectorSearchNative()`, `vectorSearchFallback()`, and `keywordSearch()`. Updated `rowToChunk()` to read `source_path` from the joined row (with `?? ""` fallback). No schema migration needed — the path is resolved at query time from the existing `sources` table. CLI and MCP display code required no changes.

---

### TASK-11 — Convert Obsidian plugin to async, note-level indexing

- **Finding:** F-11 (Medium)
- **File(s):** `plugins/ragclaw-plugin-obsidian/src/index.ts`
- **Problem:** The plugin uses `readdirSync` and `readFileSync` throughout, blocking the event loop. Vault-level indexing concatenates all notes into a single string, causing memory pressure and coarse chunking with no per-note source tracking.
- **Status:** `pending`

---

### TASK-12 — Document and improve JS fallback vector search scaling

- **Finding:** F-08 (Medium)
- **File(s):** `packages/core/src/store/index.ts`
- **Problem:** The JS fallback loads all embeddings from the database and computes cosine similarity in-process, O(N) over chunk count. Degrades badly beyond a few thousand chunks.
- **Status:** `pending`

---

### TASK-13 — Extract shared indexing/reindexing logic into a core service

- **Finding:** Architecture (no direct finding ID)
- **File(s):** `packages/cli/src/commands/add.ts`, `packages/cli/src/commands/reindex.ts`, `packages/mcp/src/index.ts`, `packages/core/src/`
- **Problem:** Indexing and reindexing orchestration is duplicated between the CLI and MCP server. Bugs and improvements must be applied in multiple places.
- **Status:** `pending`

---

### TASK-14 — Add optional at-rest protection controls for sensitive knowledge bases

- **Finding:** F-06 (Medium)
- **File(s):** `packages/core/src/store/index.ts`, `packages/cli/src/config.ts`, `packages/mcp/src/index.ts`
- **Problem:** Indexed content (which may include private code, documents, vault notes, or GitHub content) is stored in plaintext SQLite files. No filesystem permission hardening or optional encryption is in place.
- **Status:** `pending`

---

## Status Legend

| Status | Meaning |
|--------|---------|
| `pending` | Not yet started |
| `in_progress` | Currently being implemented |
| `review` | Implementation done, awaiting review |
| `done` | Completed and merged |
| `deferred` | Postponed to a later date |
| `cancelled` | No longer needed |
