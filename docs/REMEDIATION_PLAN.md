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
- **File(s):** `packages/mcp/src/index.ts`, `packages/core/src/extractors/web.ts`
- **Problem:** The MCP `rag_add` tool accepts arbitrary local filesystem paths, recursive directories, and remote URLs with no scope restrictions. Sensitive files can be indexed and later retrieved via `rag_search` excerpts.
- **Status:** `pending`

---

### TASK-04 — Add timeouts and size limits to network fetches and heavy extractors

- **Finding:** F-04 (Medium)
- **File(s):** `packages/core/src/extractors/web.ts`, `packages/core/src/extractors/pdf.ts`, `packages/core/src/extractors/image.ts`
- **Problem:** Remote fetches have no timeout or response body size cap. PDF processing loads the full file into memory with no page budget. OCR runs without any time or resource limit.
- **Status:** `pending`

---

## Phase 1 — Near Term (Hardening & Performance)

### TASK-05 — Sanitise knowledge base names and enforce path containment

- **Finding:** F-05 (Medium)
- **File(s):** `packages/cli/src/config.ts`, `packages/mcp/src/index.ts`
- **Problem:** Knowledge base names are interpolated directly into filesystem paths with no character validation. A crafted name could result in a DB file outside the intended data directory.
- **Status:** `pending`

---

### TASK-06 — Replace full-file hashing with streaming SHA-256

- **Finding:** F-10 (Medium)
- **File(s):** `packages/cli/src/commands/add.ts`, `packages/cli/src/commands/reindex.ts`, `packages/mcp/src/index.ts`
- **Problem:** Change detection reads entire files into memory before hashing. For large files this wastes memory and adds latency.
- **Status:** `pending`

---

### TASK-07 — Fix embedding batch to use true batched inference

- **Finding:** F-09 (Medium)
- **File(s):** `packages/core/src/embedder/index.ts`
- **Problem:** `embedBatch()` groups texts into slices of 32 but still invokes the embedding model individually per item inside the batch. This negates the batching benefit and slows all indexing operations.
- **Status:** `pending`

---

### TASK-08 — Pin GitHub Actions to immutable commit SHAs

- **Finding:** F-07 (Medium)
- **File(s):** `.github/workflows/ci.yaml`, `.github/workflows/publish.yaml`
- **Problem:** All `uses:` references are pinned to mutable version tags (e.g. `actions/checkout@v4`) rather than immutable commit SHAs, exposing the pipeline to upstream tag mutation.
- **Status:** `pending`

---

### TASK-09 — Add automated security scanning to CI

- **Finding:** F-07 (Medium)
- **File(s):** `.github/workflows/ci.yaml`
- **Problem:** The CI workflow runs lint, build, and tests but has no dependency audit (`pnpm audit`), SCA, SAST (e.g. CodeQL), or secret scanning steps.
- **Status:** `pending`

---

## Phase 2 — Medium Term (Architecture & Scalability)

### TASK-10 — Fix search result source-path attribution

- **Finding:** F-12 (Low/Medium)
- **File(s):** `packages/core/src/store/index.ts`, `packages/cli/src/commands/search.ts`, `packages/mcp/src/index.ts`
- **Problem:** `rowToChunk()` sets `sourcePath: ""`. Downstream display code in the CLI and MCP server uses `chunk.sourcePath` directly, so search results show empty or missing source paths.
- **Status:** `pending`

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
