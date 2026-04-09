# Bun Migration Plan

> **Status:** Analysis complete · No code changes made yet  
> **Motivation:** Eliminate native dependency rebuild pain (`better-sqlite3`, `tree-sitter`), improve cold-start performance, enable zero-dependency standalone binary distribution via `bun build --compile`.  
> **Created:** 2026-04-09  

---

## Table of Contents

- [Why Bun?](#why-bun)
- [Native Dependency Compatibility](#native-dependency-compatibility)
- [SQLite Migration: better-sqlite3 → bun:sqlite](#sqlite-migration-better-sqlite3--bunsqlite)
- [Distribution Strategy](#distribution-strategy)
- [Migration Phases](#migration-phases)
- [Risk Register](#risk-register)
- [Files to Modify](#files-to-modify)

---

## Why Bun?

| Problem (Node.js 22) | Solution (Bun) |
|---|---|
| `better-sqlite3` requires native rebuild on every install; breaks across Node versions | `bun:sqlite` is built-in — zero native compilation, 3-6x faster |
| `tree-sitter` N-API bindings fragile across platforms | Bun supports N-API (including `napi_type_tag_object`) since v1.1.34 |
| No standalone binary story — users need Node.js installed | `bun build --compile` produces single-file executables with SQLite included |
| Cross-platform distribution requires users to rebuild native addons | Platform-specific pre-compiled npm packages (esbuild pattern) |

---

## Native Dependency Compatibility

### ✅ Confirmed Working

| Dependency | How it works with Bun | Notes |
|---|---|---|
| **`better-sqlite3`** | **Replaced** by `bun:sqlite` (built-in) | API inspired by better-sqlite3; nearly identical. 3-6x faster. |
| **`sqlite-vec`** | **Officially supports Bun** via `sqliteVec.load(db)` | Documented at https://alexgarcia.xyz/sqlite-vec/js.html#bun. macOS requires `Database.setCustomSQLite()` for extension loading. |
| **`tree-sitter` + grammars** | **Works** since Bun 1.1.34 | Added `napi_type_tag_object` / `napi_check_object_type_tag` support. |
| **`@huggingface/transformers`** | **Officially supports Bun** | Auto-detects runtime for ONNX backend. Bun examples in upstream repo. |
| **`pdfjs-dist`** | Pure JS — zero risk | Works unchanged. |
| **`cheerio`** | Pure JS — zero risk | Works unchanged. |
| **`mammoth`** | Pure JS — zero risk | Works unchanged. |
| **`yaml`** | Pure JS — zero risk | Works unchanged. |
| **`picomatch`** | Pure JS — zero risk | Works unchanged. |

### ⚠️ Needs Empirical Testing

| Dependency | Risk | Concern |
|---|---|---|
| **`canvas`** | Medium | N-API + native Cairo binding. May need platform-specific pre-built binaries. |
| **`tesseract.js`** | Medium | Worker-based architecture — Bun's Worker compat has improved but edge cases exist. |

### Key Callout: `sqlite-vec` on macOS

On macOS, Bun's built-in SQLite is statically linked, which prevents extension loading by default. The workaround is documented upstream:

```typescript
import { Database } from "bun:sqlite";
import { createRequire } from "node:module";

// macOS: point Bun at the Homebrew dynamic libsqlite3
Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");

const require = createRequire(import.meta.url);
const sqliteVec = require("sqlite-vec");

const db = new Database(":memory:");
sqliteVec.load(db);
```

This only applies to macOS development. Linux builds with `bun build --compile` can embed the extension differently (see [Distribution Strategy](#distribution-strategy)).

---

## SQLite Migration: better-sqlite3 → bun:sqlite

### Scope

The migration is **concentrated in a single file**: `packages/core/src/store/index.ts` (~60 call sites across 1327 lines). Two test files also directly import `better-sqlite3`.

### API Differences

| Operation | `better-sqlite3` | `bun:sqlite` | Call Sites |
|---|---|---|---|
| Import | `import Database from "better-sqlite3"` | `import { Database } from "bun:sqlite"` | 1 |
| Pragma (exec) | `db.pragma("journal_mode = WAL")` | `db.exec("PRAGMA journal_mode = WAL")` | 2 |
| Pragma (query) | `db.pragma("table_info(x)")` | `db.query("PRAGMA table_info(x)").all()` | 2 |
| Prepare | `db.prepare(sql)` | `db.prepare(sql)` | **Identical** |
| `stmt.run()` | ✅ | ✅ | **Identical** |
| `stmt.get()` | ✅ | ✅ | **Identical** |
| `stmt.all()` | ✅ | ✅ | **Identical** |
| `db.exec()` | ✅ | ✅ | **Identical** |
| `db.transaction()` | ✅ | ✅ | **Identical** |
| `db.close()` | ✅ | ✅ | **Identical** |
| BLOB return type | `Buffer` | `Uint8Array` | ~5 (embedding BLOBs) |

### BLOB Handling

`better-sqlite3` returns BLOBs as `Buffer`, while `bun:sqlite` returns `Uint8Array`. This affects embedding storage/retrieval:

```typescript
// Current (better-sqlite3) — store/index.ts:503
Buffer.from(chunk.embedding.buffer)

// After (bun:sqlite) — Uint8Array is already the right type
// May need: new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength)
```

Review all sites where embeddings are read from the database and converted to `Float32Array` for cosine similarity.

### Type Changes

- Remove `@types/better-sqlite3` from devDependencies
- Add `bun-types` to devDependencies (provides `bun:sqlite` type declarations)
- Update `tsconfig.json` to include Bun types

---

## Distribution Strategy

### Dual Distribution: npm + Standalone Binaries

Users get two installation paths:

1. **npm install** (requires Bun runtime on target machine, or uses platform-specific pre-compiled package)
2. **GitHub Releases** (standalone binary, zero dependencies)

### Phase 3: npm with Bun Shebang

```
npm install -g @emdzej/ragclaw-cli
# Works if user has Bun installed
# Shebang: #!/usr/bin/env bun
```

### Phase 4: Standalone Compiled Binaries

```bash
bun build --compile packages/cli/src/cli.ts \
  --outfile ragclaw \
  --minify \
  --target bun-darwin-arm64
```

Published to **GitHub Releases** with a CI build matrix:

| Target | Filename |
|---|---|
| `bun-darwin-arm64` | `ragclaw-darwin-arm64` |
| `bun-darwin-x64` | `ragclaw-darwin-x64` |
| `bun-linux-x64` | `ragclaw-linux-x64` |
| `bun-linux-arm64` | `ragclaw-linux-arm64` |
| `bun-linux-x64-musl` | `ragclaw-linux-x64-musl` (Alpine) |
| `bun-windows-x64` | `ragclaw-windows-x64.exe` |

### Phase 5: Platform-Specific npm Packages (esbuild Pattern)

Inspired by how esbuild distributes pre-compiled binaries via npm:

```
@emdzej/ragclaw-cli          ← thin wrapper with optionalDependencies
├── @emdzej/ragclaw-darwin-arm64   ← pre-compiled binary for macOS ARM
├── @emdzej/ragclaw-darwin-x64     ← pre-compiled binary for macOS Intel
├── @emdzej/ragclaw-linux-x64      ← pre-compiled binary for Linux x64
├── @emdzej/ragclaw-linux-arm64    ← pre-compiled binary for Linux ARM
└── @emdzej/ragclaw-win32-x64      ← pre-compiled binary for Windows
```

The main `@emdzej/ragclaw-cli` package includes a small JS stub that detects the platform and executes the correct pre-compiled binary from the optional dependency. Users run:

```bash
npm install -g @emdzej/ragclaw-cli
ragclaw search "how does auth work"
# No Node.js or Bun runtime needed — runs the compiled binary directly
```

### sqlite-vec in Compiled Binaries

`sqlite-vec` is a SQLite extension (`.so`/`.dylib`), not an N-API addon, so it can't be directly embedded by `bun build --compile`. Strategy:

1. Embed the platform-specific `.so`/`.dylib` via `import with { type: "file" }`
2. At runtime, extract to a temp directory
3. Call `db.loadExtension()` on the extracted file
4. Fall back to JS cosine similarity if extraction fails (maintains graceful degradation)

ML model weights (~300MB–2GB) are **not embedded** — they're downloaded on first use via `@huggingface/transformers`, which already handles this.

---

## Migration Phases

### Phase 1: Validate — Run Existing Tests Under Bun

**Goal:** Confirm the existing codebase runs under Bun without modifications.

**Steps:**
1. Install Bun globally (if not present): `curl -fsSL https://bun.sh/install | bash`
2. Run the existing test suite: `bun test` (Bun has built-in Vitest-compatible test runner)
3. Alternatively, run via `bunx vitest` to use the existing Vitest config
4. Document which tests pass and which fail
5. Identify failures caused by Bun incompatibilities vs. pre-existing issues

**Success criteria:** All tests pass, or failures are limited to known `better-sqlite3` / `bun:sqlite` differences (addressed in Phase 2).

**Risk:** Low. This is a read-only validation step.

---

### Phase 2: Switch SQLite — Replace `better-sqlite3` with `bun:sqlite`

**Goal:** Migrate the SQLite layer to Bun's built-in implementation.

**Steps:**

1. **Update imports** in `packages/core/src/store/index.ts`:
   ```typescript
   // Before
   import Database from "better-sqlite3";
   // After
   import { Database } from "bun:sqlite";
   ```

2. **Fix pragma calls** (4 call sites):
   ```typescript
   // Before
   db.pragma("journal_mode = WAL");
   db.pragma("table_info(chunks)");
   // After
   db.exec("PRAGMA journal_mode = WAL");
   db.query("PRAGMA table_info(chunks)").all();
   ```

3. **Fix BLOB handling** (~5 call sites):
   - Review `Float32Array` ↔ `Buffer`/`Uint8Array` conversions for embedding storage and retrieval
   - Replace `Buffer.from(...)` with direct `Uint8Array` usage where applicable

4. **Update `sqlite-vec` loading** in `tryLoadVec()`:
   - Add macOS `Database.setCustomSQLite()` call
   - Keep the existing graceful fallback when `sqlite-vec` is unavailable

5. **Update test files**:
   - `packages/core/src/store/index.test.ts` (line 535) — remove direct `better-sqlite3` import
   - `packages/core/src/merge.test.ts` (line 343) — remove `better-sqlite3` Database type reference

6. **Update dependencies**:
   - Remove `better-sqlite3` from `packages/core/package.json` dependencies
   - Remove `@types/better-sqlite3` from devDependencies
   - Add `bun-types` to devDependencies
   - Update `tsconfig.json` to include Bun type declarations

7. **Run full test suite** and fix any remaining issues

**Success criteria:** All existing tests pass with `bun:sqlite`. No regressions in search quality or store behavior.

**Risk:** Medium. The BLOB handling differences could cause subtle embedding comparison bugs. Test thoroughly with real indexed data.

---

### Phase 3: npm + Bun — Publish to npm with Bun Shebang

**Goal:** Ship to npm so existing users can upgrade. Requires Bun on the target machine.

**Steps:**

1. **Update CLI shebang**:
   ```typescript
   // packages/cli/src/cli.ts
   #!/usr/bin/env bun
   ```

2. **Update `engines` field** in all `package.json` files:
   ```json
   {
     "engines": {
       "bun": ">=1.2.0"
     }
   }
   ```

3. **Update `AGENTS.md`** and all relevant docs to reference Bun instead of Node.js 22

4. **Update CI workflows** to use Bun instead of Node.js:
   - `oven-sh/setup-bun@v2` action
   - Replace `pnpm` commands with `bun` equivalents (or keep pnpm — Bun supports it)

5. **Update README** installation instructions

6. **Publish to npm** and verify `npm install -g @emdzej/ragclaw-cli && ragclaw --version` works on a machine with Bun installed

**Success criteria:** `npm install -g @emdzej/ragclaw-cli` works and all CLI commands function correctly.

**Risk:** Low. This is a packaging change, not a runtime change (runtime changed in Phase 2).

---

### Phase 4: Compiled Binaries — `bun build --compile` to GitHub Releases

**Goal:** Produce standalone executables that require zero runtime installation.

**Steps:**

1. **Create build script** (e.g., `scripts/build-binaries.ts`):
   ```bash
   #!/usr/bin/env bun
   const targets = [
     "bun-darwin-arm64",
     "bun-darwin-x64",
     "bun-linux-x64",
     "bun-linux-arm64",
     "bun-linux-x64-musl",
     "bun-windows-x64",
   ];
   
   for (const target of targets) {
     await $`bun build --compile packages/cli/src/cli.ts \
       --outfile dist/ragclaw-${target.replace("bun-", "")} \
       --minify \
       --target ${target}`;
   }
   ```

2. **Handle N-API addons** (`tree-sitter`, ONNX runtime):
   - Bun embeds `.node` files since v1.0.23
   - Verify all tree-sitter grammar `.node` files are included

3. **Handle `sqlite-vec` extension**:
   - Embed platform-specific `.so`/`.dylib` via `import with { type: "file" }`
   - Extract to tmpdir at runtime, load via `db.loadExtension()`

4. **Add GitHub Actions workflow** for release builds:
   ```yaml
   # .github/workflows/release-binaries.yaml
   on:
     release:
       types: [published]
   jobs:
     build:
       strategy:
         matrix:
           include:
             - os: macos-latest
               target: bun-darwin-arm64
               artifact: ragclaw-darwin-arm64
             - os: macos-13
               target: bun-darwin-x64
               artifact: ragclaw-darwin-x64
             - os: ubuntu-latest
               target: bun-linux-x64
               artifact: ragclaw-linux-x64
             - os: ubuntu-latest
               target: bun-linux-arm64
               artifact: ragclaw-linux-arm64
             - os: windows-latest
               target: bun-windows-x64
               artifact: ragclaw-windows-x64.exe
   ```

5. **Upload artifacts** to GitHub Releases

6. **Test on clean machines** (Docker containers, fresh VMs) to verify standalone operation

**Success criteria:** Downloaded binary runs on a machine with no Node.js, no Bun, no npm. `./ragclaw search "query"` works.

**Risk:** Medium-High. N-API addon embedding and `sqlite-vec` extension loading need careful testing per platform. Cross-compilation (e.g., ARM on x64 CI runner) may have edge cases.

---

### Phase 5: Platform Packages — esbuild-Style `optionalDependencies`

**Goal:** `npm install -g @emdzej/ragclaw-cli` downloads a pre-compiled binary — no runtime needed.

**Steps:**

1. **Create platform-specific packages**:
   ```
   packages/
   ├── ragclaw-darwin-arm64/
   │   ├── package.json    # { "name": "@emdzej/ragclaw-darwin-arm64", "os": ["darwin"], "cpu": ["arm64"] }
   │   └── bin/ragclaw     # compiled binary
   ├── ragclaw-darwin-x64/
   ├── ragclaw-linux-x64/
   ├── ragclaw-linux-arm64/
   └── ragclaw-win32-x64/
   ```

2. **Update `@emdzej/ragclaw-cli`** to include a thin JS stub:
   ```json
   {
     "name": "@emdzej/ragclaw-cli",
     "bin": { "ragclaw": "bin/ragclaw" },
     "optionalDependencies": {
       "@emdzej/ragclaw-darwin-arm64": "0.x.x",
       "@emdzej/ragclaw-darwin-x64": "0.x.x",
       "@emdzej/ragclaw-linux-x64": "0.x.x",
       "@emdzej/ragclaw-linux-arm64": "0.x.x",
       "@emdzej/ragclaw-win32-x64": "0.x.x"
     }
   }
   ```

3. **Write the stub** (`bin/ragclaw`):
   - Detect `process.platform` + `process.arch`
   - Resolve the correct optional dependency
   - `execFileSync` the compiled binary, forwarding args and stdio

4. **Update CI** to:
   - Build all platform binaries (from Phase 4)
   - Copy each into the corresponding platform package
   - Publish all platform packages + the main CLI package in one release

5. **Test the full flow**: `npm install -g @emdzej/ragclaw-cli` on macOS, Linux, Windows

**Success criteria:** `npm install -g @emdzej/ragclaw-cli && ragclaw --version` works on all platforms without any runtime installed.

**Risk:** Medium. npm `optionalDependencies` + `os`/`cpu` fields are well-established (esbuild, SWC, Turbopack all use this pattern), but CI complexity is non-trivial.

---

## Risk Register

| Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|
| `canvas` N-API incompatibility with Bun | Medium | Medium | Test early in Phase 1. Fallback: use pure-JS image processing or make OCR optional. |
| `tesseract.js` Worker issues in Bun | Medium | Low | Test in Phase 1. Fallback: use Bun's `worker_threads` compat or shell out to `tesseract` CLI. |
| BLOB `Uint8Array` vs `Buffer` subtle bugs | High | Medium | Add explicit unit tests for embedding round-trip (store → retrieve → cosine similarity). |
| `sqlite-vec` extension loading on macOS | Medium | Medium | Document `setCustomSQLite()` workaround. Fall back to JS cosine similarity (already implemented). |
| `bun build --compile` doesn't embed tree-sitter grammars | Medium | Low | Verified: N-API `.node` files supported since Bun 1.0.23. Test all 6 grammars. |
| Cross-compilation edge cases in CI | Medium | Medium | Use native runners per platform where possible. Bun cross-compile is still maturing. |
| Breaking existing npm users | High | Low | Phase 3 is additive (shebang change). Phase 5 keeps the same `npm install` command. |
| Bun API instability between versions | Low | Low | Pin `bun >= 1.2.0` in `engines`. Bun has been stable since 1.0 GA (Sept 2023). |

---

## Files to Modify

### Phase 2 (SQLite Migration)

| File | Change |
|---|---|
| `packages/core/src/store/index.ts` | Replace `better-sqlite3` → `bun:sqlite` (~60 call sites) |
| `packages/core/src/store/index.test.ts` | Remove direct `better-sqlite3` import (line 535) |
| `packages/core/src/merge.test.ts` | Remove `better-sqlite3` Database type (line 343) |
| `packages/core/package.json` | Remove `better-sqlite3`, `@types/better-sqlite3`; add `bun-types` |
| `packages/core/tsconfig.json` | Add Bun type declarations |

### Phase 3 (npm + Bun)

| File | Change |
|---|---|
| `packages/cli/src/cli.ts` | Update shebang to `#!/usr/bin/env bun` |
| `packages/cli/package.json` | Update `engines` to `bun >= 1.2.0` |
| `packages/mcp/package.json` | Update `engines` to `bun >= 1.2.0` |
| `package.json` (root) | Remove `better-sqlite3` from hoisted deps (line 23) |
| `AGENTS.md` | Update Node.js 22 references → Bun |
| `README.md` | Update installation instructions |
| `docs/SPEC.md` | Update Dependencies section |
| `.github/workflows/*.yaml` | Switch from `actions/setup-node` to `oven-sh/setup-bun` |

### Phase 4 (Compiled Binaries)

| File | Change |
|---|---|
| `scripts/build-binaries.ts` | **New** — build script for all platform targets |
| `.github/workflows/release-binaries.yaml` | **New** — CI workflow for building and uploading binaries |

### Phase 5 (Platform Packages)

| File | Change |
|---|---|
| `packages/ragclaw-darwin-arm64/package.json` | **New** — platform package |
| `packages/ragclaw-darwin-x64/package.json` | **New** — platform package |
| `packages/ragclaw-linux-x64/package.json` | **New** — platform package |
| `packages/ragclaw-linux-arm64/package.json` | **New** — platform package |
| `packages/ragclaw-win32-x64/package.json` | **New** — platform package |
| `packages/cli/package.json` | Add `optionalDependencies` for platform packages |
| `packages/cli/bin/ragclaw` | **New** — thin stub that delegates to platform binary |
| `.github/workflows/publish.yaml` | Add publish steps for platform packages |
| `pnpm-workspace.yaml` | Add platform packages to workspace |

---

## References

- [Bun SQLite documentation](https://bun.sh/docs/api/sqlite)
- [sqlite-vec Bun integration](https://alexgarcia.xyz/sqlite-vec/js.html#bun)
- [Bun single-file executable](https://bun.sh/docs/bundler/executables)
- [esbuild platform-specific npm packages pattern](https://esbuild.github.io/getting-started/#install-esbuild)
- [tree-sitter Bun compatibility (Bun 1.1.34)](https://bun.sh/blog/bun-v1.1.34)
- [@huggingface/transformers Bun support](https://huggingface.co/docs/transformers.js)
