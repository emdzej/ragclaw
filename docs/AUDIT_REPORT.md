# RagClaw Codebase Audit Report

**Repository:** `ragclaw`  
**Audit Date:** 2026-03-20  
**Audit Type:** Static repository audit (architecture, dependency posture, security, performance, maintainability)  
**Scope:** `packages/core`, `packages/cli`, `packages/mcp`, `plugins/*`, CI workflows, manifests

---

## Executive Summary

RagClaw is a well-structured local-first TypeScript monorepo with clear package boundaries and a pragmatic architecture for local retrieval-augmented indexing and search. The project demonstrates good foundational design decisions, particularly around package separation, SQLite-based storage, and graceful degradation when optional capabilities are unavailable.

However, the audit identified several material risks that should be addressed before broader adoption or exposure to less-trusted inputs. The most significant issues are related to **trust boundaries**, especially around shell execution, plugin loading, and unrestricted filesystem/URL ingestion through the MCP interface.

### Overall Assessment

| Area | Assessment |
|------|------------|
| Architecture | Good MVP architecture; trust boundaries need tightening |
| Security | Significant hardening required |
| Performance | Acceptable at small scale; several scaling bottlenecks |
| Dependency Hygiene | No obvious active crisis, but multiple direct dependencies are outdated |
| Production Readiness | Limited without security and scaling improvements |

### Headline Findings

1. **High:** Command injection risk in GitHub plugin via shell command construction
2. **High:** Auto-loading of untrusted plugins enables arbitrary code execution
3. **High:** MCP server allows broad file indexing and remote URL ingestion with weak constraints
4. **Medium:** Multiple unbounded resource-consumption paths (large files, PDFs, OCR, remote fetches)
5. **Medium:** JS fallback vector search does not scale
6. **Medium:** Embedding pipeline batching is inefficient, increasing indexing cost
7. **Medium:** Supply-chain hardening in CI/CD can be improved

---

## Scope and Methodology

This audit was performed as a **read-only static analysis** of the repository.

### Reviewed Areas

- Dependency manifests:
  - `package.json`
  - `packages/core/package.json`
  - `packages/cli/package.json`
  - `packages/mcp/package.json`
  - `plugins/*/package.json`
- Core implementation paths:
  - extractors
  - chunkers
  - embedder
  - storage/search
  - CLI commands
  - MCP server
  - plugin loading
- CI/CD workflows:
  - `.github/workflows/ci.yaml`
  - `.github/workflows/publish.yaml`

### Limitations

- This was a static audit; no runtime fuzzing or penetration testing was performed.
- Dependency advisories are time-sensitive; findings here reflect audit-time posture only.
- Some dependency currency observations are based on repository manifests and prior audit tooling output captured during inspection.

---

## System Overview

### Primary Components

| Component | Purpose |
|----------|---------|
| `packages/core` | Extractors, chunkers, embedder, SQLite-backed store |
| `packages/cli` | End-user CLI for indexing, search, management |
| `packages/mcp` | MCP server exposing indexing and search tools |
| `plugins/*` | Extensible source handlers (GitHub, Obsidian, YouTube) |

### Positive Observations

- Clear monorepo structure with package separation
- Pragmatic local-first design
- Mostly parameterized SQLite queries
- Good use of FTS5 and optional vector acceleration
- Thoughtful graceful-degradation approach when native modules are unavailable
- No obvious hardcoded secrets found in reviewed files

---

## Findings Summary

| ID | Severity | Title |
|----|----------|-------|
| F-01 | High | Command injection in GitHub plugin |
| F-02 | High | Untrusted plugin auto-loading and execution |
| F-03 | High | MCP exposes broad filesystem and remote-ingestion surface |
| F-04 | Medium | Unbounded resource-consumption and denial-of-service paths |
| F-05 | Medium | Database name/path is insufficiently constrained |
| F-06 | Medium | Plaintext storage of potentially sensitive indexed content |
| F-07 | Medium | Supply-chain hardening gaps in CI/CD |
| F-08 | Medium | JS fallback vector search does not scale |
| F-09 | Medium | Embedding batch implementation is inefficient |
| F-10 | Medium | Full-file hashing causes unnecessary memory pressure |
| F-11 | Medium | Obsidian plugin blocks event loop and creates large in-memory blobs |
| F-12 | Low/Medium | Search result source-path handling appears incomplete |

---

## Detailed Findings

### F-01 — High — Command injection in GitHub plugin

**Affected files:**
- `plugins/ragclaw-plugin-github/src/index.ts:26-40`
- `plugins/ragclaw-plugin-github/src/index.ts:58-60`
- `plugins/ragclaw-plugin-github/src/index.ts:71`
- `plugins/ragclaw-plugin-github/src/index.ts:103`
- `plugins/ragclaw-plugin-github/src/index.ts:135`
- `plugins/ragclaw-plugin-github/src/index.ts:172`
- `plugins/ragclaw-plugin-github/src/index.ts:204`
- `plugins/ragclaw-plugin-github/src/index.ts:253`

**Description**  
The GitHub plugin constructs shell commands with interpolated arguments and executes them via `execSync`. Repository owner, repo name, and numeric identifiers are parsed from user-provided `github://` or `gh://` sources and then embedded into the command string without sanitisation.

**Evidence**

```ts
// plugins/ragclaw-plugin-github/src/index.ts:60
return execSync(`gh ${args}`, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
```

**Risk**  
If attacker-controlled input reaches this code path, it may permit local command execution.

**Impact**
- Local code execution
- Elevated risk when used via agents or MCP workflows that may process untrusted URIs

**Recommendation**
- Replace shell string construction with `execFile`/`spawn` argument arrays
- Prefer GitHub API/SDK integration over shelling out to `gh`
- Validate `owner`, `repo`, and `number` with strict allowlist regexes before use

---

### F-02 — High — Untrusted plugin auto-loading and execution

**Affected files:**
- `packages/cli/src/commands/add.ts:47-50`
- `packages/cli/src/plugins/loader.ts:55-71`
- `packages/cli/src/plugins/loader.ts:170-199`
- `packages/cli/src/plugins/loader.ts:201-267`

**Description**  
The CLI discovers plugins from global npm packages and local directories, dynamically imports them, and runs `plugin.init()` if present — all automatically on each CLI invocation.

**Evidence**

```ts
// packages/cli/src/plugins/loader.ts:59
const module = await import(entryPath);
// ...
await plugin.init(config);
```

**Risk**  
This creates an arbitrary code execution surface through discovery alone.

**Impact**
- Malicious or typosquatted plugin execution
- Compromised local plugin directory leads to code execution on normal CLI use

**Recommendation**
- Make plugin enablement explicit and opt-in via a config file or explicit flag
- Disable global npm plugin discovery by default
- Add a trust registry or allowlist
- Consider isolated plugin execution in subprocesses with narrow message-passing interfaces

---

### F-03 — High — MCP exposes broad filesystem and remote-ingestion surface

**Affected files:**
- `packages/mcp/src/index.ts:88-109`
- `packages/mcp/src/index.ts:244-367`
- `packages/mcp/src/index.ts:587-637`
- `packages/core/src/extractors/web.ts:17-29`

**Description**  
The MCP `rag_add` tool accepts arbitrary local paths, directories, and URLs for indexing with no constraints. Indexed content can later be queried and excerpts returned via `rag_search`.

**Evidence**

```ts
// packages/mcp/src/index.ts:93-96
source: {
  type: "string",
  description: "File path, directory path, or URL to index",
},
```

**Risk**
- Sensitive local file ingestion and exfiltration via search excerpts
- Remote fetches to attacker-controlled or internal-network endpoints (SSRF-adjacent)
- Content poisoning via arbitrary attacker-controlled URLs

**Impact**
- Files outside intended project scope may be indexed and later read back
- Remote fetch capability expands the attack surface when MCP is exposed to agents or semi-trusted clients

**Recommendation**
- Restrict indexing to approved directories by default
- Add allowlists/denylists for local path access
- Add URL allowlists or require explicit opt-in for network fetching
- Introduce confirmation or policy gates for non-project paths and remote URLs

---

### F-04 — Medium — Unbounded resource-consumption and denial-of-service paths

**Affected files:**
- `packages/core/src/extractors/web.ts:17-29`
- `packages/core/src/extractors/pdf.ts:28-33`
- `packages/core/src/extractors/pdf.ts:40-69`
- `packages/core/src/extractors/pdf.ts:101-125`
- `packages/core/src/extractors/image.ts:25-27`
- `packages/core/src/extractors/image.ts:75-77`
- `packages/cli/src/commands/add.ts:108-111`
- `packages/cli/src/commands/reindex.ts:108-111`
- `packages/mcp/src/index.ts:294-297`
- `packages/mcp/src/index.ts:512-515`

**Description**  
Several processing paths read entire files into memory, fetch remote content without timeouts or size limits, or run expensive OCR operations without any resource budgets.

**Evidence**

```ts
// packages/core/src/extractors/web.ts:17 — no timeout, no size cap
const response = await fetch(source.url, { headers: { ... } });

// packages/core/src/extractors/pdf.ts:30 — full PDF loaded to memory
const buffer = await readFile(source.path);
```

**Impact**
- Memory spikes on large files
- CPU exhaustion on OCR-heavy inputs
- Long-hanging or never-resolving network requests
- Poor resilience under malformed or oversized content

**Recommendation**
- Add `AbortController`-based fetch timeouts and abort handling
- Enforce content-length caps and body-size limits before reading responses
- Add page count and OCR budgets for PDFs and images
- Bound concurrency for expensive extraction tasks
- Use streaming SHA-256 hashing instead of loading full file contents for change detection

---

### F-05 — Medium — Database name/path is insufficiently constrained

**Affected files:**
- `packages/cli/src/config.ts:103-105`
- `packages/mcp/src/index.ts:51-52`

**Description**  
Knowledge base names are directly incorporated into filesystem paths without strong normalisation or validation.

**Evidence**

```ts
// packages/cli/src/config.ts:104-105
export function getDbPath(name: string): string {
  return join(dataDir, `${name}.sqlite`);
}
```

**Impact**
- Unexpected DB file locations via crafted names
- Reduced clarity around filesystem boundary enforcement

**Recommendation**
- Restrict DB names to a safe character set such as `[A-Za-z0-9._-]+`
- Resolve and assert that the final path remains within the configured data directory

---

### F-06 — Medium — Plaintext storage of potentially sensitive indexed content

**Affected files:**
- `packages/core/src/store/index.ts:77-84`
- `packages/cli/src/config.ts:103-105`
- `packages/mcp/src/index.ts:51-52`

**Description**  
Indexed content is stored in an unencrypted SQLite database in a local data directory. This may include private code, documents, GitHub content, or Obsidian vault contents.

**Impact**
- Sensitive content may be readable by other local users or processes depending on host configuration
- Users may inadvertently persist private materials without understanding the storage implications

**Recommendation**
- Document data sensitivity clearly in user-facing documentation
- Ensure restrictive directory/file permissions on the data directory and database files
- Consider optional at-rest encryption for sensitive deployments

---

### F-07 — Medium — Supply-chain hardening gaps in CI/CD

**Affected files:**
- `.github/workflows/ci.yaml:14-23`
- `.github/workflows/ci.yaml:43-52`
- `.github/workflows/publish.yaml:15-27`

**Description**  
GitHub Actions are pinned to major version tags rather than immutable commit SHAs. The reviewed workflows do not include automated security scanning.

**Evidence**

```yaml
# .github/workflows/ci.yaml
- uses: actions/checkout@v4          # tag, not SHA
- uses: actions/setup-node@v4        # tag, not SHA
- uses: pnpm/action-setup@v4         # tag, not SHA
```

**Impact**
- Greater exposure to upstream action compromise or unexpected behaviour changes
- Reduced automated assurance around dependency, code, and secret scanning

**Recommendation**
- Pin GitHub Actions to immutable commit SHAs
- Add dependency-review, OSV/SCA, CodeQL, and secret scanning to CI
- Consider SBOM generation and release provenance for published packages

---

### F-08 — Medium — JS fallback vector search does not scale

**Affected files:**
- `packages/core/src/store/index.ts:347-366`

**Description**  
When the native `sqlite-vec` extension is unavailable, vector search loads all chunk embeddings from the database and computes cosine similarity in JavaScript, then sorts the full result set.

**Evidence**

```ts
// packages/core/src/store/index.ts:350
const rows = this.db.prepare("SELECT * FROM chunks WHERE embedding IS NOT NULL").all();
// ... compute cosine similarity for every row in JS
results.sort((a, b) => b.score - a.score);
return results.slice(0, limit);
```

**Impact**
- Search latency grows linearly with chunk count
- Increased CPU and memory pressure as the knowledge base grows
- Poor user experience for knowledge bases with more than a few thousand chunks

**Recommendation**
- Treat native vector acceleration (`sqlite-vec`) as strongly recommended for serious use, and surface this clearly to users
- Add a prefilter step or approximate nearest-neighbour strategy if a JS fallback is required
- Document known performance limits clearly

---

### F-09 — Medium — Embedding batch implementation is inefficient

**Affected files:**
- `packages/core/src/embedder/index.ts:84-105`

**Description**  
`embedBatch()` groups texts into slices of 32, but then still invokes the embedding pipeline individually for each item within the batch.

**Evidence**

```ts
// packages/core/src/embedder/index.ts:95-101
for (const text of prefixed) {
  const output = await pipe(text, { pooling: "mean", normalize: true });
  results.push(new Float32Array(output.data));
}
```

**Impact**
- Slower indexing throughput than necessary
- Increased model invocation overhead
- Indexing of large document sets takes significantly longer than it should

**Recommendation**
- Pass the full batch to the embedding pipeline at once if supported by the library
- Otherwise introduce controlled parallelism with bounded concurrency

---

### F-10 — Medium — Full-file hashing causes unnecessary memory pressure

**Affected files:**
- `packages/cli/src/commands/add.ts:108-111`
- `packages/cli/src/commands/reindex.ts:108-111`
- `packages/mcp/src/index.ts:294-297`
- `packages/mcp/src/index.ts:512-515`

**Description**  
The change-detection implementation reads entire files into memory in order to compute a SHA-256 hash.

**Evidence**

```ts
// packages/cli/src/commands/add.ts:108-111
const content = await readFile(src.path!, "utf-8").catch(() =>
  readFile(src.path!).then(b => b.toString("base64"))
);
contentHash = createHash("sha256").update(content).digest("hex");
```

**Impact**
- Memory waste proportional to file size
- Avoidable latency during indexing and reindexing of large files

**Recommendation**
- Replace with streaming SHA-256 hashing using `fs.createReadStream` piped through `crypto.createHash`

---

### F-11 — Medium — Obsidian plugin blocks event loop and creates large in-memory blobs

**Affected files:**
- `plugins/ragclaw-plugin-obsidian/src/index.ts:62-80`
- `plugins/ragclaw-plugin-obsidian/src/index.ts:216-249`
- `plugins/ragclaw-plugin-obsidian/src/index.ts:252-292`

**Description**  
The Obsidian plugin uses synchronous filesystem APIs throughout, and for vault-level indexing concatenates all notes into a single large string before returning.

**Evidence**

```ts
// plugins/ragclaw-plugin-obsidian/src/index.ts:63
const entries = readdirSync(dir, { withFileTypes: true });
// ...
const raw = readFileSync(file, "utf-8");  // for every file in the vault
```

**Impact**
- Event-loop blocking during file traversal and reading
- Very poor responsiveness on large vaults
- Memory pressure proportional to total vault size
- Coarse chunking granularity because individual notes are not tracked as separate sources

**Recommendation**
- Replace synchronous filesystem APIs with async equivalents
- Index notes individually rather than concatenating vault content into a single extraction result
- Track per-note source records to support incremental reindexing

---

### F-12 — Low/Medium — Search result source-path handling appears incomplete

**Affected files:**
- `packages/core/src/store/index.ts:428-439`
- `packages/cli/src/commands/search.ts:62-76`
- `packages/mcp/src/index.ts:230-236`

**Description**  
`rowToChunk()` sets `sourcePath` to an empty string. Downstream display code in both the CLI and MCP server references `chunk.sourcePath` directly for result output.

**Evidence**

```ts
// packages/core/src/store/index.ts:432
sourcePath: "", // Will be filled from join if needed
```

**Impact**
- Search results may display empty or incorrect source paths
- Reduced result traceability and debugging capability

**Recommendation**
- Join chunks to their source record during search queries
- Or explicitly populate `sourcePath` consistently during chunk materialisation

---

## Dependency Review

### Observations

Direct dependencies and tooling appear generally modern, but several are reported as outdated relative to more recent releases at the time of the audit.

### Notable Packages to Review and Update

| Package | Category |
|---------|----------|
| `better-sqlite3` | Runtime — native, critical |
| `@modelcontextprotocol/sdk` | Runtime — integration, rapidly evolving |
| `@huggingface/transformers` | Runtime — ML core |
| `pdfjs-dist` | Runtime — document processing |
| `tesseract.js` | Runtime — OCR |
| `tree-sitter*` | Runtime — native, code parsing |
| `commander` | Runtime — CLI |
| `ora` | Runtime — CLI |
| `uuid` | Runtime — utility |
| `vitest` | Toolchain — test framework |
| `turbo` | Toolchain — monorepo build |

### Dependency Posture

- No obviously active known-vulnerability exposure was identified in reviewed files
- No hardcoded secrets were found in reviewed source files
- Current concern is **dependency currency and supply-chain hygiene** rather than an identified active advisory incident

### Recommendation

Adopt a regular dependency maintenance cadence. Run `pnpm outdated` and `pnpm audit` as part of CI. Prioritise updates for:

1. Security-sensitive or runtime-critical libraries
2. Native modules (`better-sqlite3`, `tree-sitter*`, `sharp`, `canvas`)
3. MCP-related integration packages
4. Build and test toolchain dependencies

---

## Performance and Scalability Review

### Primary Bottlenecks

| Bottleneck | Impact |
|-----------|--------|
| JS fallback vector search (O(N)) | Degrades badly at >5k chunks |
| Sequential embedding invocations | Slows all indexing operations |
| Full-file reads for hashing | Memory pressure on large files |
| Unbounded OCR/PDF processing | CPU/memory exhaustion risk |
| Vault-level Obsidian blob | Memory + event-loop blocking |

### Architectural Observations

- Indexing/reindexing logic is duplicated between `packages/cli` and `packages/mcp`; bugs and fixes must be applied twice
- The `searchCommand` in CLI creates a new `Embedder` instance per invocation, incurring repeated model warmup cost
- The `collectFilesRecursive` function in the MCP server has no depth limit or file count cap

### Recommendations

- Move shared indexing/reindexing orchestration into a service layer in `packages/core`
- Introduce explicit resource budgets: file size, page count, OCR time, network timeouts
- Prefer natively accelerated search paths; clearly surface limitations of the JS fallback
- Improve chunk-to-source join behaviour to support efficient tracing and display

---

## Security Posture Review

### Strengths

- No obvious hardcoded secrets in reviewed files
- SQL usage is generally parameterised, reducing classic injection risk
- Local-first design reduces some classes of external attack surface
- `pnpm onlyBuiltDependencies` is used to limit native build execution

### Weaknesses

- Weak trust-boundary enforcement between local, remote, plugin, and MCP inputs
- Automatic plugin execution model with no trust verification
- Shell execution directly from user-derived GitHub source URIs
- Broad filesystem and URL access through MCP operations

### Security Direction

The most important architectural improvement is to define and enforce explicit **trust zones**:

| Zone | Examples | Policy |
|------|---------|--------|
| Trusted local CLI | User-invoked commands | Current behaviour is mostly appropriate |
| Semi-trusted plugin inputs | Discovered plugins | Require explicit opt-in and allowlisting |
| Untrusted MCP client requests | Agent-driven indexing | Restrict scope, add allowlists, require confirmation |
| Untrusted remote content | Web URLs, YouTube, GitHub | Enforce size/timeout limits, MIME filtering |

---

## Recommended Remediation Roadmap

### Phase 0 — Immediate Priority

| # | Action | Finding |
|---|--------|---------|
| 1 | Fix command injection in GitHub plugin | F-01 |
| 2 | Disable or constrain automatic plugin discovery | F-02 |
| 3 | Restrict MCP path and URL indexing scope by default | F-03 |
| 4 | Add timeouts and size limits for network fetches and heavy extractors | F-04 |

### Phase 1 — Near Term

| # | Action | Finding |
|---|--------|---------|
| 5 | Sanitise knowledge base names and enforce path containment | F-05 |
| 6 | Replace full-file hashing with streaming hashes | F-10 |
| 7 | Improve embedding throughput with true batched or parallel inference | F-09 |
| 8 | Pin GitHub Actions to immutable commit SHAs | F-07 |
| 9 | Add automated security scanning in CI | F-07 |

### Phase 2 — Medium Term

| # | Action | Finding |
|---|--------|---------|
| 10 | Refactor duplicated CLI/MCP indexing logic into a shared core service | — |
| 11 | Improve large-dataset vector search behaviour | F-08 |
| 12 | Convert Obsidian plugin to async, note-level indexing | F-11 |
| 13 | Add optional secure-storage controls for sensitive knowledge bases | F-06 |
| 14 | Improve search-result source-path attribution | F-12 |

---

## Conclusion

RagClaw is a promising and thoughtfully organised local-first RAG system with a clean architecture. The primary concerns identified are not basic code quality problems, but rather **unsafe assumptions about trust** across plugin loading, shell execution, filesystem access, and MCP-driven content ingestion. These risks are fixable with targeted, well-scoped changes that do not require abandoning the current design direction.

With the hardening work in Phase 0 and Phase 1, the project would be substantially safer for broader use, including agent-driven workflows. The performance improvements in Phase 1 and Phase 2 would make it more reliable and scalable as knowledge bases grow beyond the current small-to-medium target scale.

---

## Appendix: Key Files Reviewed

- `package.json`
- `docs/SPEC.md`
- `packages/core/package.json`
- `packages/core/src/embedder/index.ts`
- `packages/core/src/store/index.ts`
- `packages/core/src/extractors/web.ts`
- `packages/core/src/extractors/pdf.ts`
- `packages/core/src/extractors/image.ts`
- `packages/core/src/extractors/code.ts`
- `packages/core/src/chunkers/code.ts`
- `packages/core/src/chunkers/semantic.ts`
- `packages/cli/package.json`
- `packages/cli/src/config.ts`
- `packages/cli/src/commands/add.ts`
- `packages/cli/src/commands/reindex.ts`
- `packages/cli/src/commands/search.ts`
- `packages/cli/src/plugins/loader.ts`
- `packages/mcp/package.json`
- `packages/mcp/src/index.ts`
- `plugins/ragclaw-plugin-github/src/index.ts`
- `plugins/ragclaw-plugin-obsidian/src/index.ts`
- `plugins/ragclaw-plugin-youtube/src/index.ts`
- `.github/workflows/ci.yaml`
- `.github/workflows/publish.yaml`
