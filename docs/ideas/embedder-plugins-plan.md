# Embedder Plugin System — Implementation Plan

> Companion to [embedder-plugins.md](./embedder-plugins.md) (issue [#48](https://github.com/emdzej/ragclaw/issues/48))

## Design Decisions

These were decided up-front and inform every phase below:

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Config format | Add `yaml` npm package | Enables nested `embedder:` blocks; flat dotted keys are too awkward for multi-field embedder config |
| Plugin model | Extend `RagClawPlugin` with `embedder?` | Single plugin system, single discovery mechanism; a plugin can provide extractors + chunker + embedder |
| Legacy DB migration | Assume `nomic` / 768 dims | Write metadata on first open; zero-breakage for existing users |
| Vec table on dim change | DROP + recreate `chunks_vec` | Simplest approach; `chunks.embedding` BLOB keeps raw data for rebuild |
| Arbitrary HF models | Auto-detect dimensions | Run a single test embed on first use, cache the result |
| Scope | Full proposal, phased delivery | All phases below, merged incrementally |

---

## Phase 1 — Core Abstraction & Interface

> Foundation: define the types, refactor the embedder, create presets.

### 1.1 `EmbedderPlugin` interface

**File:** `packages/core/src/types.ts`

Add:

```typescript
export interface EmbedderPlugin {
  /** Human-readable name (e.g. "nomic", "ollama"). */
  name: string;

  /** Output vector dimensions (e.g. 768, 1024). */
  dimensions: number;

  /** Embed a document text. */
  embed(text: string): Promise<Float32Array>;

  /** Embed a search query (may use a different prefix). */
  embedQuery(text: string): Promise<Float32Array>;

  /** Batch-embed multiple document texts. */
  embedBatch(texts: string[]): Promise<Float32Array[]>;

  /** Optional one-time setup (model download, connection check). */
  init?(): Promise<void>;

  /** Optional teardown. */
  dispose?(): Promise<void>;
}

export interface EmbedderPreset {
  /** HuggingFace model ID. */
  model: string;
  /** Output dimensions. */
  dim: number;
  /** Prefix prepended to document texts (e.g. "search_document:"). */
  docPrefix?: string;
  /** Prefix prepended to query texts (e.g. "search_query:"). */
  queryPrefix?: string;
  /** Approximate RAM required in bytes (for system checks). */
  estimatedRAM?: number;
  /** Pooling strategy (default: "mean"). */
  pooling?: string;
  /** Whether to L2-normalize output (default: true). */
  normalize?: boolean;
}
```

### 1.2 Extend `RagClawPlugin`

**File:** `packages/core/src/plugin.ts`

```diff
 export interface RagClawPlugin {
   name: string;
   version: string;
   extractors?: Extractor[];
   chunkers?: Chunker[];
+  /** Optional embedder provided by this plugin. */
+  embedder?: EmbedderPlugin;
   schemes?: string[];
   extensions?: string[];
   // ...rest unchanged
 }
```

### 1.3 Preset registry

**New file:** `packages/core/src/embedder/presets.ts`

```typescript
export const EMBEDDER_PRESETS: Record<string, EmbedderPreset> = {
  nomic: {
    model: "nomic-ai/nomic-embed-text-v1.5",
    dim: 768,
    docPrefix: "search_document: ",
    queryPrefix: "search_query: ",
    estimatedRAM: 600 * 1024 * 1024,
  },
  bge: {
    model: "BAAI/bge-m3",
    dim: 1024,
    estimatedRAM: 2.3 * 1024 * 1024 * 1024,
  },
  mxbai: {
    model: "mixedbread-ai/mxbai-embed-large-v1",
    dim: 1024,
    queryPrefix: "Represent this sentence: ",
    estimatedRAM: 1.4 * 1024 * 1024 * 1024,
  },
  minilm: {
    model: "sentence-transformers/all-MiniLM-L6-v2",
    dim: 384,
    estimatedRAM: 90 * 1024 * 1024,
  },
};

export function resolvePreset(alias: string): EmbedderPreset | undefined;
export function isKnownPreset(alias: string): boolean;
```

### 1.4 Refactor `Embedder` → `HuggingFaceEmbedder`

**File:** `packages/core/src/embedder/index.ts`

- Class renamed to `HuggingFaceEmbedder implements EmbedderPlugin`
- Constructor accepts `EmbedderPreset` (or partial overrides)
- `dimensions` becomes a mutable property, set from preset or auto-detected on first embed
- Prefixes (`docPrefix`, `queryPrefix`) come from preset config
- `pooling` and `normalize` come from preset config (defaults: `"mean"`, `true`)
- Keep backward-compat export: `export { HuggingFaceEmbedder as Embedder }`

Auto-detection flow for arbitrary HF models:

```
1. constructor receives { model: "some/model" } with no dim
2. dimensions = 0 (unknown)
3. first call to embed()/embedBatch() triggers getPipeline()
4. after pipeline is ready, run a single test: pipe("test", { pooling, normalize })
5. read output.dims[1] → set this.dimensions
6. proceed with actual embedding
```

### 1.5 Embedder factory

**New file:** `packages/core/src/embedder/factory.ts`

Resolves a user-facing embedder config to an `EmbedderPlugin` instance:

```typescript
export interface EmbedderResolvedConfig {
  /** Preset alias ("nomic", "bge", ...) */
  alias?: string;
  /** Arbitrary HuggingFace model ID */
  model?: string;
  /** Override dimensions (skips auto-detect). */
  dimensions?: number;
  /** Plugin-provided embedder (takes priority). */
  pluginEmbedder?: EmbedderPlugin;
  /** Progress callback for model downloads. */
  onProgress?: (progress: number) => void;
  /** Custom cache directory. */
  cacheDir?: string;
}

export function createEmbedder(config: EmbedderResolvedConfig): EmbedderPlugin;
```

Resolution order:
1. `pluginEmbedder` → return as-is
2. `alias` → look up in `EMBEDDER_PRESETS` → `new HuggingFaceEmbedder(preset)`
3. `model` → `new HuggingFaceEmbedder({ model, dim: config.dimensions ?? 0 })`
4. No config → default to `nomic` preset

### 1.6 Update exports

**File:** `packages/core/src/index.ts`

- Export `HuggingFaceEmbedder`, keep `Embedder` as alias
- Export `EmbedderPlugin`, `EmbedderPreset` types
- Export `EMBEDDER_PRESETS`, `resolvePreset`, `createEmbedder`

### 1.7 Tests

- Rename/update `embedder/index.test.ts` for `HuggingFaceEmbedder`, test preset-driven config
- New `embedder/presets.test.ts` — preset resolution, unknown aliases
- New `embedder/factory.test.ts` — factory resolution order

---

## Phase 2 — Store Metadata & Dimension-Aware Storage

> The database learns which embedder was used, and adapts.

### 2.1 `store_meta` table

**File:** `packages/core/src/store/index.ts`

Add to `SCHEMA`:

```sql
CREATE TABLE IF NOT EXISTS store_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

New methods on `Store`:

```typescript
async getMeta(key: string): Promise<string | null>;
async setMeta(key: string, value: string): Promise<void>;
async getAllMeta(): Promise<Record<string, string>>;
```

Because the table uses `CREATE TABLE IF NOT EXISTS`, existing databases get it
automatically on next `open()` — no migration needed.

### 2.2 Additional SQLite indexes

The current schema has two explicit indexes:

```sql
CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source_id);   -- chunk lookups by source
CREATE INDEX IF NOT EXISTS idx_sources_path ON sources(path);         -- source lookups by path
```

Plus implicit indexes from `PRIMARY KEY` on both tables and `UNIQUE` on
`sources.path`.

Query pattern analysis reveals these are missing:

| Query pattern | Current index | Issue |
|---------------|---------------|-------|
| `SELECT * FROM sources ORDER BY indexed_at DESC` (listSources) | None | Full table scan + filesort on every `list` / `status` call |
| `DELETE FROM chunks_vec WHERE id IN (SELECT id FROM chunks WHERE source_id = ?)` | `idx_chunks_source` covers the subquery | OK |
| `SELECT MAX(indexed_at) FROM sources` (getStats) | None | Full scan; same index as above covers it |
| `store_meta` lookups by key | `PRIMARY KEY` | OK |

**Add:**

```sql
-- Speeds up listSources() ORDER BY and getStats() MAX()
CREATE INDEX IF NOT EXISTS idx_sources_indexed_at ON sources(indexed_at);
```

This is a small table so the impact is modest, but it's free to add and
becomes relevant when the number of sources grows (e.g. an Obsidian vault
with 1000+ notes).

**Considered and deferred:**

- Index on `chunks.created_at` — no queries currently sort/filter by this.
- Composite index on `chunks(source_id, id)` — the existing `idx_chunks_source`
  is sufficient; the subquery `SELECT id FROM chunks WHERE source_id = ?`
  returns ids which are then used against `chunks_vec`'s PK.

### 2.3 Embedder metadata tracking

On **indexing** (in `IndexingService` or at the `Store` level):

```
store.setMeta("embedder_name", embedder.name);        // e.g. "bge"
store.setMeta("embedder_model", preset.model);         // e.g. "BAAI/bge-m3"
store.setMeta("embedder_dimensions", String(dims));    // e.g. "1024"
store.setMeta("created_at", new Date().toISOString());
```

On **open** (for legacy databases):

```
if getMeta("embedder_name") === null:
  setMeta("embedder_name", "nomic")
  setMeta("embedder_model", "nomic-ai/nomic-embed-text-v1.5")
  setMeta("embedder_dimensions", "768")
```

### 2.4 Dynamic `chunks_vec` dimensions

`tryLoadVec()` currently hardcodes `FLOAT[768]`. Change to:

```typescript
private tryLoadVec(): boolean {
  const dim = this.getMetaSync("embedder_dimensions") ?? "768";
  this.db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
      id TEXT PRIMARY KEY,
      embedding FLOAT[${parseInt(dim, 10)}]
    );
  `);
}
```

### 2.5 Dimension mismatch guard

Before indexing or searching, compare:

```typescript
const storedDim = await store.getMeta("embedder_dimensions");
if (storedDim && parseInt(storedDim) !== embedder.dimensions) {
  throw new Error(
    `Embedder dimension mismatch: store has ${storedDim}-dim embeddings ` +
    `but current embedder "${embedder.name}" produces ${embedder.dimensions}-dim vectors.\n` +
    `Run: ragclaw reindex --embedder ${embedder.name} -d <db>`
  );
}
```

### 2.6 Tests

- `store/index.test.ts` — add `store_meta` CRUD tests
- Test legacy DB migration (open without metadata → defaults written)
- Test dimension mismatch detection
- Test the new `idx_sources_indexed_at` index exists (query `sqlite_master`)

---

## Phase 3 — Config System Upgrade

> Replace the hand-rolled YAML parser with `yaml`, support nested embedder config.

### 3.1 Add `yaml` dependency

**File:** `packages/core/package.json`

```diff
 "dependencies": {
+  "yaml": "^2.7.0",
   "@huggingface/transformers": "^3.8.0",
```

### 3.2 Replace `parseSimpleYaml()`

**File:** `packages/core/src/config.ts`

```diff
-function parseSimpleYaml(content: string): Record<string, string> {
-  // ... 15-line hand-rolled parser
-}
+import YAML from "yaml";
+
+function parseConfigYaml(content: string): Record<string, unknown> {
+  return YAML.parse(content) ?? {};
+}
```

Update all callers that currently expect `Record<string, string>` to handle
the richer types that the `yaml` package produces (numbers, booleans, nested
objects).

### 3.3 Add embedder to `RagclawConfig`

```typescript
export interface EmbedderConfigBlock {
  /** Plugin name (for plugin-provided embedders). */
  plugin?: string;
  /** HuggingFace model ID. */
  model?: string;
  /** Override dimensions. */
  dimensions?: number;
  /** API base URL (for Ollama, OpenAI, etc.). */
  baseUrl?: string;
}

export interface RagclawConfig {
  // ... existing fields ...

  /** Embedder configuration.
   *  - `string` = preset alias (e.g. "bge")
   *  - `object` = full config block
   *  - `undefined` = default ("nomic") */
  embedder?: string | EmbedderConfigBlock;
}
```

Config file examples that all work:

```yaml
# Alias shorthand
embedder: bge

# Full config with HF model
embedder:
  model: BAAI/bge-m3

# Plugin-provided embedder (e.g. Ollama)
embedder:
  plugin: ollama
  model: nomic-embed-text
  baseUrl: http://localhost:11434
```

### 3.4 Env var + settable key

- `RAGCLAW_EMBEDDER` env var — accepts alias string only (nested config requires the file)
- Add to `SETTABLE_KEYS`:
  ```typescript
  { yamlKey: "embedder", envVar: "RAGCLAW_EMBEDDER", type: "string", configKey: "embedder",
    description: "Embedder preset alias or model (e.g. bge, nomic, BAAI/bge-m3)" }
  ```

### 3.5 Tests

- Update `config.test.ts` for new YAML parsing (nested objects, edge cases)
- Test `embedder` field parsing: alias string, object, missing
- Test `RAGCLAW_EMBEDDER` env var override
- Test backward compat: existing flat config files still parse correctly

---

## Phase 4 — CLI & MCP Integration

> Wire everything together so users can actually pick an embedder.

### 4.1 `--embedder` flag on `ragclaw add`

**File:** `packages/cli/src/commands/add.ts`

```diff
 interface AddOptions {
   db: string;
+  embedder?: string;  // alias or HF model ID
   type: string;
   // ...
 }
```

**File:** `packages/cli/src/cli.ts`

```diff
 program
   .command("add")
+  .option("-e, --embedder <name>", "Embedder preset or model (e.g. bge, nomic)")
```

Flow:
1. Resolve embedder: CLI flag > config file > store metadata > default (nomic)
2. Dimension mismatch check against store metadata
3. Pass resolved `EmbedderPlugin` to `IndexingService`
4. After successful indexing, write/update `store_meta`

### 4.2 Update `IndexingService`

**File:** `packages/core/src/indexing.ts`

```diff
 export interface IndexingServiceConfig {
   extraExtractors?: Extractor[];
   extractorLimits?: Partial<ExtractorLimits>;
   onModelProgress?: (progress: number) => void;
+  /** Pre-configured embedder. If not provided, defaults to nomic. */
+  embedder?: EmbedderPlugin;
 }
```

Constructor:
```typescript
this.embedder = cfg.embedder ?? createEmbedder({ alias: "nomic", onProgress: cfg.onModelProgress });
```

### 4.3 Auto-load embedder on search

**File:** `packages/cli/src/commands/search.ts`

```diff
-const embedder = new Embedder();
+// Read embedder info from store metadata
+const embedderName = await store.getMeta("embedder_name") ?? "nomic";
+const embedder = createEmbedder({ alias: embedderName });
```

No `--embedder` flag on search — it's always inferred from the database.

### 4.4 `--embedder` flag on `ragclaw reindex`

**File:** `packages/cli/src/commands/reindex.ts`

```diff
+  .option("-e, --embedder <name>", "Re-embed with a different model (rebuilds all vectors)")
```

When `--embedder` is provided and differs from stored metadata:
1. Warn: `"This will re-embed all N chunks with <new>. Continue? [y/N]"`
2. Drop `chunks_vec` table
3. Update `store_meta` with new embedder info
4. Recreate `chunks_vec` with new dimensions
5. Re-extract, re-chunk, re-embed all sources

### 4.5 Update `ragclaw status`

**File:** `packages/cli/src/commands/status.ts`

Show embedder info:
```
Knowledge Base: default
Embedder: bge (BAAI/bge-m3, 1024 dims)
Sources: 42
Chunks: 1,337
...
```

### 4.6 Update MCP server

**File:** `packages/mcp/src/index.ts`

- `getEmbedder()` → read store metadata, use `createEmbedder()`
- `getIndexingService()` → pass resolved embedder
- `rag_status` → include embedder info in output
- Embedder is cached per DB name (different DBs may use different embedders)

### 4.7 Tests

- CLI integration tests (if any exist) updated
- MCP handler tests updated for embedder metadata flow

---

## Phase 5 — System Requirements & Doctor Command

> Help users pick the right model for their hardware.

### 5.1 System requirements checker

**New file:** `packages/core/src/embedder/system-check.ts`

```typescript
export interface SystemCheck {
  canRun: boolean;
  warnings: string[];
  errors: string[];
}

export function checkSystemRequirements(preset: EmbedderPreset): SystemCheck;
```

Logic:
- `os.freemem()` < `estimatedRAM * 1.2` → error (insufficient RAM)
- `os.freemem()` < `estimatedRAM * 2.0` → warning (may be slow)
- Otherwise → OK
- Unknown preset (no `estimatedRAM`) → skip check, return OK

### 5.2 CLI integration

**File:** `packages/cli/src/commands/add.ts` (and `reindex.ts`)

Before loading the model:
```
const check = checkSystemRequirements(preset);
if (check.errors.length > 0) {
  console.error(check.errors[0]);
  process.exit(1);
}
if (check.warnings.length > 0) {
  console.warn(check.warnings[0]);
  const ok = await confirm("Continue?");
  if (!ok) process.exit(0);
}
```

### 5.3 `ragclaw doctor` command

**New file:** `packages/cli/src/commands/doctor.ts`

**File:** `packages/cli/src/cli.ts`

```diff
+import { doctorCommand } from "./commands/doctor.js";
+
+program
+  .command("doctor")
+  .description("Check system compatibility and embedder requirements")
+  .action(doctorCommand);
```

Output:
```
$ ragclaw doctor

System Check:
  RAM: 8GB total, 5.2GB available       OK
  Disk: 120GB free                       OK
  Node: v22.0.0                          OK

Embedder Compatibility:
  minilm  (~90MB)   sentence-transformers/all-MiniLM-L6-v2    384 dim   OK
  nomic   (~600MB)  nomic-ai/nomic-embed-text-v1.5            768 dim   OK
  mxbai   (~1.4GB)  mixedbread-ai/mxbai-embed-large-v1       1024 dim  OK
  bge     (~2.3GB)  BAAI/bge-m3                               1024 dim  WARNING may be slow

Current Config:
  embedder: nomic (default)

Plugins:
  ragclaw-plugin-github   v0.1.0   (no embedder)
  ragclaw-plugin-youtube  v0.1.0   (no embedder)
```

### 5.4 Tests

- `embedder/system-check.test.ts` — mock `os.freemem()`, test all thresholds
- `commands/doctor.test.ts` — snapshot test of output format

---

## Phase 6 — Plugin Embedder Discovery

> Let plugins provide their own embedder (e.g. Ollama, OpenAI).

### 6.1 `PluginLoader.getEmbedder()`

**File:** `packages/cli/src/plugins/loader.ts`

```typescript
/** Returns the first embedder from loaded plugins, or null. */
getEmbedder(): EmbedderPlugin | null {
  for (const { plugin } of this.loadedPlugins) {
    if (plugin.embedder) return plugin.embedder;
  }
  return null;
}
```

### 6.2 Embedder resolution order

The final resolution order (used in CLI `add`, `reindex`, and MCP `rag_add`):

```
1. --embedder CLI flag (alias or HF model)
2. Config file `embedder:` field
3. RAGCLAW_EMBEDDER env var
4. Plugin-provided embedder (first one wins)
5. Store metadata (existing DB's embedder)
6. Default: "nomic"
```

For **search**, it's simpler — always from store metadata:

```
1. Store metadata embedder_name
2. Default: "nomic" (legacy DB)
```

### 6.3 Update MCP for plugin embedders

The MCP server currently doesn't load plugins. This phase adds optional
plugin loading to MCP (gated behind config), primarily for embedder support.

### 6.4 Tests

- Test plugin-provided embedder takes priority over default
- Test resolution order with various combinations

---

## File Change Summary

| File | Change | Phase |
|------|--------|-------|
| `packages/core/src/types.ts` | Add `EmbedderPlugin`, `EmbedderPreset` | 1 |
| `packages/core/src/plugin.ts` | Add `embedder?` to `RagClawPlugin` | 1 |
| `packages/core/src/embedder/presets.ts` | **NEW** — preset registry | 1 |
| `packages/core/src/embedder/index.ts` | Refactor → `HuggingFaceEmbedder` | 1 |
| `packages/core/src/embedder/factory.ts` | **NEW** — embedder factory | 1 |
| `packages/core/src/embedder/system-check.ts` | **NEW** — RAM checks | 5 |
| `packages/core/src/store/index.ts` | `store_meta` table, dynamic dims, new index | 2 |
| `packages/core/src/config.ts` | YAML parser, embedder config | 3 |
| `packages/core/src/indexing.ts` | Accept embedder, store metadata | 4 |
| `packages/core/src/index.ts` | New exports | 1 |
| `packages/core/package.json` | Add `yaml` dep | 3 |
| `packages/cli/src/cli.ts` | `--embedder` flags, `doctor` cmd | 4, 5 |
| `packages/cli/src/commands/add.ts` | Embedder resolution, system check | 4, 5 |
| `packages/cli/src/commands/search.ts` | Auto-load from store meta | 4 |
| `packages/cli/src/commands/reindex.ts` | `--embedder`, vec table rebuild | 4 |
| `packages/cli/src/commands/status.ts` | Show embedder info | 4 |
| `packages/cli/src/commands/doctor.ts` | **NEW** — doctor command | 5 |
| `packages/cli/src/plugins/loader.ts` | `getEmbedder()` method | 6 |
| `packages/mcp/src/index.ts` | Factory, metadata, embedder cache | 4 |
| Tests (multiple) | Updates + new test files | 1–6 |
| `README.md` | Features, quick start, config, CLI ref, plugin dev | 7 |
| `packages/core/README.md` | Features, presets table, API docs | 7 |
| `packages/cli/README.md` | Usage examples, embedder selection, doctor | 7 |
| `packages/mcp/README.md` | Tools table, auto-detect note | 7 |
| `docs/HOW_IT_WORKS.md` | Embeddings section, store_meta, doctor | 7 |
| `docs/SPEC.md` | Interfaces, store schema, config | 7 |

## Phase 7 — Documentation Updates

> After all feature work is complete, update every README and doc file to
> reflect the new embedder system. **Do not merge Phase 6 without this.**

### 7.1 Root `README.md`

The root README is the public-facing landing page. Update these sections:

- **Features list** — add embedder choice bullet:
  `🧠 **Multiple embedders** — nomic, bge, mxbai, minilm, or bring your own`
- **Quick Start** — add `--embedder` example to the `ragclaw add` snippet
- **Configuration** section — document `embedder:` in `config.yaml` with
  alias shorthand and full object examples
- **Environment Variables** table — add `RAGCLAW_EMBEDDER`
- **CLI Reference** table — add `ragclaw doctor` command, add `--embedder`
  flag to `add` and `reindex` entries
- **MCP Tools** table — update `rag_status` description to mention embedder info
- **Plugin Development** section — document the new `embedder?` field on
  `RagClawPlugin` interface

### 7.2 `packages/core/README.md`

- **Features** — change `Embedder — Local embeddings with nomic-embed-text-v1.5`
  to `Embedder — Configurable local embeddings (nomic, bge, mxbai, minilm, custom HF models)`
- Add **Embedder Presets** section with the 4-row alias table (alias, model, dim, RAM)
- Document the `EmbedderPlugin` interface for consumers using core as a library
- Document `createEmbedder()` factory usage

### 7.3 `packages/cli/README.md`

- **Usage** — add `--embedder` examples:
  ```bash
  ragclaw add --embedder bge ./docs/
  ragclaw reindex --embedder minilm
  ragclaw doctor
  ```
- Add **Embedder Selection** section explaining resolution order
- Add **System Requirements** section referencing `ragclaw doctor`

### 7.4 `packages/mcp/README.md`

- **Tools** table — add `rag_reindex` tool if newly exposed, update
  `rag_status` description to include embedder info
- Add note that the MCP server auto-detects the embedder from store metadata

### 7.5 `docs/HOW_IT_WORKS.md`

This is the detailed explainer. Update:

- **Step 3: Embeddings** section — currently describes only nomic-embed-text-v1.5.
  Rewrite to explain the preset system, how different models produce different
  dimensions, and how the store tracks which embedder was used.
- Add a note about `ragclaw doctor` for checking model compatibility.
- Update the "What's in the Database" section to include `store_meta` table.

### 7.6 `docs/SPEC.md`

The technical specification. Update:

- **Components → Embedder** section — replace single-model description with
  `EmbedderPlugin` interface, preset table, and factory pattern.
- **Components → Store** section — add `store_meta` table schema.
- **Configuration → `RagclawConfig`** — add `embedder` field.
- **Interfaces** section — add `EmbedderPlugin`, `EmbedderPreset` interfaces.

### 7.7 Plugin READMEs (informational)

No changes required to existing plugin READMEs (`ragclaw-plugin-github`,
`ragclaw-plugin-youtube`, `ragclaw-plugin-obsidian`) unless they start
providing custom embedders. Add a brief note to the plugin development
guide (in root README) showing how a plugin can export an embedder.

### 7.8 Checklist

Use this checklist before closing the feature:

- [ ] `README.md` — features, quick start, config, env vars, CLI ref, plugin dev
- [ ] `packages/core/README.md` — features, presets table, API docs
- [ ] `packages/cli/README.md` — usage examples, embedder selection, doctor
- [ ] `packages/mcp/README.md` — tools table, auto-detect note
- [ ] `docs/HOW_IT_WORKS.md` — embeddings section, store_meta, doctor
- [ ] `docs/SPEC.md` — interfaces, store schema, config
- [ ] All code examples in docs compile / are consistent with final API

---

## Backward Compatibility

- Default embedder stays `nomic` (768 dims) — zero-config upgrade
- `new Embedder()` still works (re-exported alias)
- Existing databases get `store_meta` on next `open()`; assumed nomic/768
- No breaking changes to public API (only additions)
- Existing config files parse identically under the `yaml` package (superset of the old flat parser)

## Risks & Mitigation

| Risk | Mitigation |
|------|-----------|
| Auto-detect dims adds latency on first embed | Single test embed; result cached for instance lifetime |
| `yaml` package adds 60KB to bundle | Acceptable for CLI/MCP tool |
| Store migration fails on readonly DBs | Check write access; skip gracefully |
| Different HF models may need different `pooling`/`normalize` | Configurable per preset |
| Plugin embedder conflicts (two plugins provide embedders) | First-wins with a warning logged |
| User indexes with embedder A, searches expecting embedder B | Dimension mismatch guard blocks it with clear error message |
