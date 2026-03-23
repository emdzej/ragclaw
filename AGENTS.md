# AGENTS.md — RagClaw Development Guidelines

> **Audience:** AI coding agents (Claude, Copilot, Codex, etc.).  
> Read this file **completely** before starting any task in this repository.  
> It is the authoritative contract for how code is written, tested, and shipped here.

---

## Project Overview

**RagClaw** — a local-first RAG (Retrieval-Augmented Generation) engine.  
Indexes documents, source code, and web pages into a portable SQLite database and exposes
hybrid vector + keyword search, a CLI, and an MCP server.

- **Repo:** https://github.com/emdzej/ragclaw
- **Stack:** TypeScript 5, Node.js 22, pnpm, Turborepo, Vitest, Biome
- **Database:** SQLite via `better-sqlite3` + `sqlite-vec` (optional native extension)

---

## Tech Guidelines

Load the relevant guide before touching that area:

| Technology | Guide | When to load |
|------------|-------|--------------|
| TypeScript | [`docs/guidelines/typescript.md`](docs/guidelines/typescript.md) | Types, naming, ESM imports |
| Testing | [`docs/guidelines/testing.md`](docs/guidelines/testing.md) | Vitest patterns, mocking |

**Rule:** Load the relevant guide(s) before starting work in that area.

---

## Repository Structure

```
ragclaw/
├── packages/
│   ├── core/           # @emdzej/ragclaw-core — extractors, chunkers, embedder, store
│   ├── cli/            # @emdzej/ragclaw-cli   — commander-based CLI
│   └── mcp/            # @emdzej/ragclaw-mcp   — MCP server (stdio transport)
├── plugins/
│   ├── ragclaw-plugin-github/    # GitHub repos, issues, PRs via github:// scheme
│   ├── ragclaw-plugin-obsidian/  # Obsidian vaults via obsidian:// scheme
│   └── ragclaw-plugin-youtube/   # YouTube transcripts via youtube:// scheme
├── e2e/                # End-to-end tests (vitest, separate from unit tests)
├── docs/
│   ├── SPEC.md         # Canonical specification — interfaces, schema, CLI contract
│   ├── HOW_IT_WORKS.md # Architecture narrative — chunking, embeddings, search flow
│   ├── USER_GUIDE.md   # End-user feature reference
│   ├── ideas/          # Future enhancement proposals (READ-ONLY — see below)
│   └── guidelines/     # Tech-specific guidelines (TypeScript, Testing)
├── biome.json          # Formatter + linter config (single source of truth for style)
├── turbo.json          # Turborepo task graph
├── pnpm-workspace.yaml # Workspace members
└── vitest.workspace.ts # Vitest workspace (all packages + e2e)
```

---

## ⚠️ Native Module Warning — Node 22 Required

This project contains native addons:

| Module | Why native |
|--------|-----------|
| `better-sqlite3` | SQLite C binding |
| `tree-sitter` + language grammars | AST parsing |
| `sqlite-vec` | Optional fast vector search |

**Rules:**
1. **Node.js 22 LTS is required.** Do NOT upgrade to Node 23+.
2. After any `pnpm install` that touches these packages, run `pnpm rebuild`.
3. When adding a new native dependency, document it in `docs/SPEC.md` under Dependencies.
4. `sqlite-vec` is an **optional** dependency — all code paths must degrade gracefully when it is absent.

---

## Development Commands

```bash
# Install (frozen lockfile — never change lockfile manually)
pnpm install --frozen-lockfile

# Build all packages (Turborepo handles dependency order)
pnpm build

# Run ALL tests including e2e
pnpm test

# Run unit tests only (faster, no native rebuild needed)
pnpm turbo run test --filter=!@emdzej/ragclaw-e2e

# Type-check (run for all three packages)
pnpm exec tsc --noEmit -p packages/core/tsconfig.json
pnpm exec tsc --noEmit -p packages/cli/tsconfig.json
pnpm exec tsc --noEmit -p packages/mcp/tsconfig.json

# Lint (biome)
pnpm lint

# Lint + auto-fix
pnpm --filter <package> lint:fix

# Watch mode for a single package
pnpm --filter @emdzej/ragclaw-core test:watch

# Clean build artifacts
pnpm clean
```

**Before every PR:**
```bash
pnpm lint && pnpm build && pnpm test
```

---

## Testing Rules

| Layer | Location | Runner | Notes |
|-------|----------|--------|-------|
| Unit | `packages/*/src/**/*.test.ts` | Vitest per-package | Use in-memory SQLite (`:memory:`), no real files |
| Unit | `plugins/*/src/**/*.test.ts` | Vitest per-package | Same rules |
| E2E | `e2e/tests/` | Vitest workspace | Allowed to write real SQLite files; clean up in `afterAll` |

- **Always run everything** (`pnpm test`) before marking a task complete.
- E2E tests are excluded from CI unit runs (`--filter=!@emdzej/ragclaw-e2e`) but **must pass locally** before a PR is opened.
- Test file naming: `*.test.ts` for unit, `*.e2e.ts` for end-to-end.
- Do **not** use `globals: true` — import `describe`, `it`, `expect`, `vi` explicitly from `vitest`.
- `testTimeout` is 10 000 ms — if a test legitimately needs more, increase the per-test timeout, not the global one.

---

## Git Workflow

### Branch Prefixes

| Prefix | Usage | Example |
|--------|-------|---------|
| `feature/` | New features | `feature/add-rerank-support` |
| `bugfix/` | Bug fixes | `bugfix/fix-sqlite-vec-fallback` |
| `chore/` | Maintenance | `chore/update-transformers` |

### Commit Convention (Conventional Commits)

```
<type>(<scope>): <description>

Types:  feat | fix | docs | style | refactor | test | chore | perf
Scopes: embedder | store | chunker | extractor | indexing | merge |
        cli | mcp | plugin | guards | config | e2e | deps
```

**Examples:**
```
feat(embedder): add Ollama-compatible embedder preset
fix(store): handle sqlite-vec unavailability without crash
test(extractor): add PDF OCR fallback unit test
docs(spec): update merge strategy table
chore(deps): bump @huggingface/transformers to 3.9.0
```

### CHANGELOG

`CHANGELOG.md` is updated **only on releases**, not per-PR. Do not touch it unless explicitly asked.

---

## Documentation Update Policy (MANDATORY)

Whenever you change **observable behaviour** (new CLI flag, changed interface, new embedder preset,
new plugin scheme, altered search scoring, etc.), you **must** update the relevant docs:

| Changed area | Update required |
|-------------|----------------|
| CLI commands / flags | `docs/SPEC.md` → CLI Commands section |
| Core interfaces | `docs/SPEC.md` → Components section |
| SQLite schema | `docs/SPEC.md` → Store schema |
| Architecture / data flow | `docs/HOW_IT_WORKS.md` |
| User-facing features | `docs/USER_GUIDE.md` |
| Both spec + narrative | Update both SPEC.md and HOW_IT_WORKS.md |
| New plugin / new package | Add `README.md` in the package root; verify `.github/workflows/publish.yaml` has an explicit publish step |

> **`docs/ideas/`** is a read-only reference. Check it before implementing a new feature
> to understand prior design thinking. Do not create or modify files there unless asked.

---

## Core Rules

### Language & Style

- All code, comments, variable names, and commit messages: **English only**.
- Follow [`docs/guidelines/typescript.md`](docs/guidelines/typescript.md) for all TypeScript conventions.
- Every file must start with the standard copyright header:

```typescript
/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */
```

### Environment Variables

⚠️ **NEVER commit secrets.**  
Use `.env.example` with placeholders (committed); `.env` for real values (gitignored).

---

## Common Patterns

### 1. Extractor Authoring

Implement the `Extractor` interface from `@emdzej/ragclaw-core`:

```typescript
import type { ExtractedContent, Extractor, Source } from "@emdzej/ragclaw-core";

export class EpubExtractor implements Extractor {
  // Return true only for sources this extractor can handle
  canHandle(source: Source): boolean {
    if (source.type !== "file") return false;
    return source.path.toLowerCase().endsWith(".epub");
  }

  async extract(source: Source): Promise<ExtractedContent> {
    if (source.type !== "file") throw new Error("EpubExtractor requires a file source");
    // ... parse epub ...
    return {
      text: extractedText,
      metadata: { filename: basename(source.path), title },
      sourceType: "text",   // use the closest existing ContentType
      mimeType: "application/epub+zip",
    };
  }
}
```

**Rules:**
- `canHandle` must be **pure and synchronous** — no I/O.
- Throw `Error` (not return `null`) when `extract` fails unexpectedly.
- Always populate `metadata.filename` at minimum.

---

### 2. Chunker Authoring

Implement the `Chunker` interface:

```typescript
import { randomUUID } from "node:crypto";
import type { Chunk, Chunker, ExtractedContent } from "@emdzej/ragclaw-core";

export class EpubChunker implements Chunker {
  canHandle(content: ExtractedContent): boolean {
    return content.mimeType === "application/epub+zip";
  }

  async chunk(
    content: ExtractedContent,
    sourceId: string,
    sourcePath: string
  ): Promise<Chunk[]> {
    // Split into meaningful units — chapters, sections, etc.
    return chapters.map((chapter) => ({
      id: randomUUID(),
      text: chapter.text,
      sourceId,
      sourcePath,
      startLine: chapter.startLine,
      endLine: chapter.endLine,
      metadata: {
        type: "section",
        heading: chapter.title,
      },
    }));
  }
}
```

**Rules:**
- Each chunk must have a unique `id` (use `randomUUID()` from `node:crypto`).
- Target chunk size: ~512 tokens (~400 words). Overlap: ~50 tokens.
- `metadata.type` must be one of: `"paragraph" | "section" | "function" | "class" | "method" | "block"`.

---

### 3. Plugin Authoring

A plugin is a workspace package under `plugins/` that exports a `RagClawPlugin` default export.

**Scaffold rules:**
1. Package name: `ragclaw-plugin-<name>` (no `@emdzej/` scope for plugins).
2. Must have `@emdzej/ragclaw-core` as a **peer** dependency (not `dependencies`).
3. `package.json` must include a `ragclaw` field declaring handled schemes/extensions:

```json
{
  "name": "ragclaw-plugin-notion",
  "ragclaw": {
    "schemes": ["notion"],
    "extensions": []
  },
  "peerDependencies": {
    "@emdzej/ragclaw-core": ">=0.5.0"
  }
}
```

4. Main export must be a default `RagClawPlugin`:

```typescript
// plugins/ragclaw-plugin-notion/src/index.ts
import type { RagClawPlugin } from "@emdzej/ragclaw-core";
import { NotionExtractor } from "./extractor.js";
import { NotionChunker } from "./chunker.js";

const plugin: RagClawPlugin = {
  name: "ragclaw-plugin-notion",
  version: "0.1.0",
  schemes: ["notion"],
  extractors: [new NotionExtractor()],
  chunkers: [new NotionChunker()],

  async init(config?: Record<string, unknown>) {
    // Validate config, set up API client, etc.
  },

  async dispose() {
    // Clean up connections
  },

  // Optional: expand a compound source into individual sources
  async expand(source) {
    if (source.type !== "url" || !source.url.startsWith("notion://")) return null;
    // Return one Source per page
    return pages.map((p) => ({ type: "url", url: `notion://${p.id}` }));
  },

  // Optional: document config keys for `ragclaw config list`
  configSchema: [
    { key: "token", description: "Notion integration token", type: "string" },
  ],
};

export default plugin;
```

5. Add the plugin to `vitest.workspace.ts` and `pnpm-workspace.yaml`.
6. **Write a `README.md`** in the plugin root. Follow the structure of existing plugin READMEs (`plugins/ragclaw-plugin-github/README.md` is a good template):
   - One-line description
   - Installation (`npm install -g <name>`)
   - Requirements (external tools / accounts needed)
   - Configuration (YAML snippet showing how to wire it in `~/.config/ragclaw/config.yaml`)
   - Usage examples
   - Development (`pnpm install && pnpm build && pnpm test`)
   - License
7. **Verify GitHub Actions workflows** — open `.github/workflows/publish.yaml` and confirm a publish step exists for the new plugin. If it is missing, add it immediately after the last existing plugin step, following the same pattern:

```yaml
      - name: Publish ragclaw-plugin-<name>
        working-directory: plugins/ragclaw-plugin-<name>
        run: npm publish --access public --provenance
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

> The version-bump `pnpm --filter "ragclaw-plugin-*"` glob in the workflow already covers new plugins automatically, but the **publish step must be added explicitly** — the glob does not publish.

---

### 4. Store Query Patterns

```typescript
import { Store } from "@emdzej/ragclaw-core";

const store = new Store();
await store.open(dbPath);     // always open before use

try {
  // Hybrid search (recommended default)
  const results = await store.search({
    text: "how does oauth work",
    embedding: await embedder.embedQuery("how does oauth work"),
    limit: 10,
    mode: "hybrid",                // "vector" | "keyword" | "hybrid"
    filter: {
      sourceType: "code",          // optional — filter by ContentType
      // sourcePath: "/src/auth",  // optional — prefix match
    },
  });

  for (const r of results) {
    console.log(`${r.chunk.sourcePath}:${r.chunk.startLine} — score ${r.score.toFixed(3)}`);
    console.log(r.chunk.text.slice(0, 200));
  }
} finally {
  await store.close();             // always close — releases SQLite connection
}
```

**Rules:**
- Always `store.open()` → use → `store.close()` in a `try/finally`.
- Do NOT share a single `Store` instance across concurrent operations — open a new one per operation.
- For `mode: "vector"` or `"hybrid"`, you **must** pass a pre-computed `embedding`. If you skip the embedding, results will be keyword-only regardless of `mode`.

---

### 5. Error Handling

RagClaw uses **discriminated union returns** for expected failures and **thrown errors** for unexpected ones:

```typescript
// ✅ Expected failure — guard returns a union
const pathCheck = isPathAllowed(inputPath, config);
if (!pathCheck.allowed) {
  return `Error: ${pathCheck.reason}`;  // surface to caller without throwing
}

const urlCheck = await isUrlAllowed(urlString, config);
if (!urlCheck.allowed) {
  return `Error: ${urlCheck.reason}`;
}

// ✅ Unexpected failure — throw with a descriptive message
if (!existsSync(dbPath)) {
  throw new Error(`Database not found: ${dbPath}. Run 'ragclaw init' first.`);
}

// ✅ Graceful degradation for optional native modules
let sqliteVec: typeof import("sqlite-vec") | null = null;
try {
  sqliteVec = await import("sqlite-vec");
} catch {
  // sqlite-vec unavailable — fall back to JS cosine similarity
}
```

**Rules:**
- Never swallow errors silently. At minimum, log a warning.
- Do not use `process.exit()` in library code (`core`, plugins). Only the CLI and MCP entry points may exit.
- Prefer `unknown` over `any` in catch clauses: `catch (err: unknown)`.

---

### 6. CLI Command Authoring

Commands live in `packages/cli/src/commands/`. Each file exports a function that receives a `commander.Command` and attaches the sub-command to it.

```typescript
// packages/cli/src/commands/mycommand.ts
import type { Command } from "commander";
import chalk from "chalk";
import ora from "ora";

export function registerMyCommand(program: Command): void {
  program
    .command("mycommand <arg>")
    .description("Short description shown in --help")
    .option("--db <name>", "Knowledge base name", "default")
    .option("--json", "Output as JSON")
    .action(async (arg: string, opts: { db: string; json: boolean }) => {
      const spinner = ora("Working...").start();
      try {
        // ... do work ...
        spinner.succeed(chalk.green("Done."));
      } catch (err: unknown) {
        spinner.fail(chalk.red(String(err)));
        process.exitCode = 1;
      }
    });
}
```

Then register in `packages/cli/src/cli.ts`:
```typescript
import { registerMyCommand } from "./commands/mycommand.js";
registerMyCommand(program);
```

**Rules:**
- Always use `process.exitCode = 1` instead of `process.exit(1)` — allows `afterAll` cleanup to run.
- Use `ora` for progress spinners, `chalk` for coloured output.
- The `--json` flag must cause the command to output **only** valid JSON to stdout (no spinners, no colour).
- All user-visible strings go to **stdout** for success, **stderr** for errors.

---

### 7. MCP Tool Authoring

MCP tools live in `packages/mcp/src/index.ts` and are registered with `server.tool()`:

```typescript
import { z } from "zod";

server.tool(
  "rag_my_tool",                           // tool name — snake_case, prefixed with rag_
  "Human-readable description for the LLM.",
  {
    // Zod schema for input validation
    query: z.string().describe("The search query"),
    db: z.string().optional().default("default").describe("Knowledge base name"),
    limit: z.number().int().min(1).max(100).optional().default(10),
  },
  async ({ query, db, limit }) => {
    // Apply security guards BEFORE any I/O
    const urlCheck = await isUrlAllowed(query, config);
    if (!urlCheck.allowed) {
      return { content: [{ type: "text", text: `Error: ${urlCheck.reason}` }] };
    }

    // ... do work ...

    return {
      content: [{ type: "text", text: formattedResult }],
    };
  }
);
```

**Rules:**
- Tool names must be `snake_case`, prefixed with `rag_`.
- Use **Zod** for all input validation — never trust raw input.
- Always apply `isPathAllowed` / `isUrlAllowed` guards before touching the filesystem or network.
- Return `{ content: [{ type: "text", text: "Error: ..." }] }` for user-facing errors — do NOT throw from a tool handler.
- Expensive resources (embedders, IndexingService) must be cached as module-level singletons (see `cachedEmbedders` pattern in `packages/mcp/src/index.ts`).

---

### 8. Security — Generic Principles

| Threat | Mitigation |
|--------|-----------|
| Path traversal | Always call `isPathAllowed(path, config)` from `packages/core/src/guards.ts` before reading/writing files |
| SSRF | Always call `await isUrlAllowed(url, config)` before fetching any URL |
| Command injection | **Never** use `child_process.exec` with user-supplied strings. Use `execFile` with an array of arguments, or use Node.js APIs directly |
| Dependency confusion | Plugins are loaded only if listed in `config.enabledPlugins` — never auto-load unknown packages |
| Secrets in commits | `.env` files are gitignored. Never log tokens, API keys, or passwords |
| Prototype pollution | Treat all `JSON.parse` output as `unknown` before narrowing |

The guards in `packages/core/src/guards.ts` are the **single source of truth** for access control. Both the CLI and MCP server use them. If you add a new code path that touches the filesystem or network, it must go through these guards.

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `better-sqlite3` native binding error after `pnpm install` | Run `pnpm rebuild` |
| `tree-sitter` fails to load | Run `pnpm rebuild`; ensure Node 22 |
| `sqlite-vec` not found | This is expected on some platforms — the store degrades gracefully to JS cosine similarity |
| TypeScript `Cannot find module './foo'` | Add `.js` extension to the import (ESM / NodeNext resolution) |
| E2E tests leave SQLite files behind | Ensure each test suite calls `store.close()` and deletes the file in `afterAll` |
| Vitest globals not found | This project does NOT use `globals: true` — import from `vitest` explicitly |

---

## Questions?

1. Check existing code in `packages/core/src/` for patterns.
2. Load relevant `docs/guidelines/*.md`.
3. Read `docs/SPEC.md` for the canonical interface definitions.
4. Check `docs/ideas/` for prior design thinking before proposing a new feature.
5. When in doubt, choose simplicity and local-first consistency over cleverness.

---

_Last updated: 2026-03-23 — added README and GitHub Actions publish verification rules for new plugins/packages_
