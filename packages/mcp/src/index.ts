#!/usr/bin/env node

/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, join, resolve } from "node:path";
import type { EmbedderPlugin, Source } from "@emdzej/ragclaw-core";
import {
  createEmbedder,
  getConfig,
  getDbPath,
  IndexingService,
  isPathAllowed,
  isUrlAllowed,
  MergeService,
  Store,
  sanitizeDbName,
} from "@emdzej/ragclaw-core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const _require = createRequire(import.meta.url);
const { version } = _require("../package.json") as { version: string };

const config = getConfig();
const RAGCLAW_DIR = config.dataDir;

// ---------------------------------------------------------------------------
// Cached singletons (expensive to initialise)
// ---------------------------------------------------------------------------

/** Embedders cached per DB name (different DBs may use different models). */
const cachedEmbedders = new Map<string, EmbedderPlugin>();

async function getEmbedder(dbName: string, store: Store): Promise<EmbedderPlugin> {
  const cached = cachedEmbedders.get(dbName);
  if (cached) return cached;

  // Prefer embedder_model (full HF model ID) over embedder_name, which may be
  // a short display name like "nomic-embed-text-v1.5" rather than a valid alias.
  const storedModel = await store.getMeta("embedder_model");
  const storedName = (await store.getMeta("embedder_name")) ?? "nomic";
  const embedder = storedModel
    ? createEmbedder({ model: storedModel })
    : createEmbedder({ alias: storedName });

  // Warm up (downloads model on first call)
  await embedder.embed("warmup");

  cachedEmbedders.set(dbName, embedder);
  return embedder;
}

/** IndexingService used for add/reindex operations. */
let cachedIndexingService: IndexingService | null = null;

async function getIndexingService(): Promise<IndexingService> {
  if (!cachedIndexingService) {
    // Use default embedder (nomic) for indexing via MCP.
    // The embedder will be written to store metadata on first index.
    const embedder = createEmbedder();
    cachedIndexingService = new IndexingService({
      extractorLimits: config.extractorLimits,
      embedder,
    });
    await cachedIndexingService.init();
  }
  return cachedIndexingService;
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function ragSearch(args: { query: string; db?: string; limit?: number }): Promise<string> {
  const dbName = args.db || "default";
  const dbPath = getDbPath(dbName);

  if (!existsSync(dbPath)) {
    return `Knowledge base "${dbName}" not found. Run kb_add first to create it.`;
  }

  const store = new Store();
  await store.open(dbPath);

  try {
    const embedding = await getEmbedder(dbName, store).then((e) => e.embedQuery(args.query));

    const results = await store.search({
      text: args.query,
      embedding,
      limit: args.limit || 5,
      mode: "hybrid",
    });

    if (results.length === 0) {
      return "No results found.";
    }

    const formatted = results.map((r, i) => {
      const lines =
        r.chunk.startLine && r.chunk.endLine
          ? ` (lines ${r.chunk.startLine}-${r.chunk.endLine})`
          : "";
      const score = (r.score * 100).toFixed(1);
      return `[${i + 1}] ${r.chunk.sourcePath}${lines}\nScore: ${score}%\n${r.chunk.text.slice(0, 500)}${r.chunk.text.length > 500 ? "..." : ""}`;
    });

    return formatted.join("\n\n---\n\n");
  } finally {
    await store.close();
  }
}

async function ragAdd(args: {
  source: string;
  db?: string;
  recursive?: boolean;
  crawl?: boolean;
  crawlMaxDepth?: number;
  crawlMaxPages?: number;
  crawlSameOrigin?: boolean;
  crawlInclude?: string;
  crawlExclude?: string;
  crawlConcurrency?: number;
  crawlDelay?: number;
  ignoreRobots?: boolean;
  chunker?: string;
  chunkSize?: number;
  overlap?: number;
}): Promise<string> {
  const dbName = args.db || "default";
  const dbPath = getDbPath(dbName);

  // Ensure directory exists
  await mkdir(RAGCLAW_DIR, { recursive: true });

  const store = new Store();
  await store.open(dbPath);

  try {
    // Use per-call chunker options if provided, else fall back to shared service.
    // Pass the store so the indexing service honours the DB's stored embedder.
    const indexingService =
      args.chunker !== undefined || args.chunkSize !== undefined || args.overlap !== undefined
        ? await buildIndexingService(args.chunker, args.chunkSize, args.overlap, store)
        : await buildIndexingService(undefined, undefined, undefined, store);

    // -------------------------------------------------------------------------
    // Crawl mode
    // -------------------------------------------------------------------------
    if (args.crawl) {
      if (!args.source.startsWith("http://") && !args.source.startsWith("https://")) {
        return "Error: crawl=true requires a URL source (http:// or https://)";
      }

      const urlCheck = await isUrlAllowed(args.source, config);
      if (!urlCheck.allowed) {
        return `Error: ${urlCheck.reason}`;
      }

      const crawlInclude = args.crawlInclude
        ? args.crawlInclude
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;
      const crawlExclude = args.crawlExclude
        ? args.crawlExclude
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;

      const summary = await indexingService.indexCrawl(store, args.source, {
        maxDepth: args.crawlMaxDepth,
        maxPages: args.crawlMaxPages,
        sameOrigin: args.crawlSameOrigin,
        include: crawlInclude,
        exclude: crawlExclude,
        concurrency: args.crawlConcurrency,
        delayMs: args.crawlDelay,
        ignoreRobots: args.ignoreRobots,
      });

      let result = `Crawl complete: ${summary.indexed} page(s) indexed, ${summary.totalChunks} chunks.`;
      if (summary.skipped > 0) result += ` Skipped: ${summary.skipped}.`;
      if (summary.errors > 0) result += ` Errors: ${summary.errors}.`;
      return result;
    }

    // -------------------------------------------------------------------------
    // Normal mode
    // -------------------------------------------------------------------------
    const sources = await collectSources(args.source, args.recursive ?? true);

    let indexed = 0;
    let totalChunks = 0;
    const errors: string[] = [];

    for (const src of sources) {
      const displayPath =
        src.type === "url" ? src.url : src.type === "file" ? src.path : (src.name ?? "unknown");

      try {
        const outcome = await indexingService.indexSource(store, src);

        switch (outcome.status) {
          case "indexed":
            indexed++;
            totalChunks += outcome.chunks;
            break;
          case "unchanged":
          case "skipped":
            break; // silently skip
          case "error":
            errors.push(`${displayPath}: ${outcome.error}`);
            break;
        }
      } catch (e) {
        errors.push(`${displayPath}: ${e}`);
      }
    }

    let result = `Indexed ${indexed} source(s), ${totalChunks} chunks.`;
    if (errors.length > 0) {
      result += `\n\nErrors:\n${errors.slice(0, 5).join("\n")}`;
      if (errors.length > 5) {
        result += `\n... and ${errors.length - 5} more`;
      }
    }
    return result;
  } finally {
    await store.close();
  }
}

async function ragStatus(args: { db?: string }): Promise<string> {
  const dbName = args.db || "default";
  const dbPath = getDbPath(dbName);

  if (!existsSync(dbPath)) {
    return `Knowledge base "${dbName}" not found.`;
  }

  const store = new Store();
  await store.open(dbPath);

  try {
    const stats = await store.getStats();
    const meta = await store.getAllMeta();
    const sizeKB = (stats.sizeBytes / 1024).toFixed(1);
    const updated = stats.lastUpdated ? new Date(stats.lastUpdated).toLocaleString() : "never";

    const embedderName = meta.embedder_name ?? "nomic";
    const embedderModel = meta.embedder_model ?? embedderName;
    const embedderDims = meta.embedder_dimensions ?? "?";

    return `Knowledge Base: ${dbName}
Path: ${dbPath}
Embedder: ${embedderName} (${embedderModel}, ${embedderDims} dims)
Sources: ${stats.sources}
Chunks: ${stats.chunks}
Size: ${sizeKB} KB
Last Updated: ${updated}
Vector Support: ${store.hasVectorSupport ? "native" : "JS fallback"}`;
  } finally {
    await store.close();
  }
}

async function ragRemove(args: { source: string; db?: string }): Promise<string> {
  const dbName = args.db || "default";
  const dbPath = getDbPath(dbName);

  if (!existsSync(dbPath)) {
    return `Knowledge base "${dbName}" not found.`;
  }

  const store = new Store();
  await store.open(dbPath);

  try {
    const existing = await store.getSource(args.source);
    if (!existing) {
      return `Source not found: ${args.source}`;
    }

    await store.removeSource(existing.id);
    return `Removed: ${args.source}`;
  } finally {
    await store.close();
  }
}

async function ragReindex(args: {
  db?: string;
  force?: boolean;
  prune?: boolean;
  chunker?: string;
  chunkSize?: number;
  overlap?: number;
}): Promise<string> {
  const dbName = args.db || "default";
  const dbPath = getDbPath(dbName);

  if (!existsSync(dbPath)) {
    return `Knowledge base "${dbName}" not found.`;
  }

  const store = new Store();
  await store.open(dbPath);

  try {
    const sources = await store.listSources();

    if (sources.length === 0) {
      return "No sources to reindex.";
    }

    // Always pass the store so the indexing service uses the DB's stored embedder
    const indexingService =
      args.chunker !== undefined || args.chunkSize !== undefined || args.overlap !== undefined
        ? await buildIndexingService(args.chunker, args.chunkSize, args.overlap, store)
        : await buildIndexingService(undefined, undefined, undefined, store);

    let updated = 0;
    let unchanged = 0;
    let removed = 0;
    const errors: string[] = [];

    for (const source of sources) {
      try {
        const outcome = await indexingService.reindexSource(store, source, {
          force: args.force,
          prune: args.prune,
        });

        switch (outcome.status) {
          case "updated":
            updated++;
            break;
          case "unchanged":
            unchanged++;
            break;
          case "removed":
            removed++;
            break;
          case "missing":
            // not pruned, just skip
            break;
          case "skipped":
            break;
          case "error":
            errors.push(`${source.path}: ${outcome.error}`);
            break;
        }
      } catch (err) {
        errors.push(`${source.path}: ${err}`);
      }
    }

    let result = `Reindex complete: ${updated} updated, ${unchanged} unchanged`;
    if (removed > 0) {
      result += `, ${removed} removed`;
    }
    if (errors.length > 0) {
      result += `\n\nErrors (${errors.length}):\n${errors.slice(0, 5).join("\n")}`;
      if (errors.length > 5) {
        result += `\n... and ${errors.length - 5} more`;
      }
    }
    return result;
  } finally {
    await store.close();
  }
}

async function ragMerge(args: {
  sourceDb: string;
  db?: string;
  strategy?: "strict" | "reindex";
  onConflict?: "skip" | "prefer-local" | "prefer-remote";
  dryRun?: boolean;
  include?: string;
  exclude?: string;
}): Promise<string> {
  const dbName = args.db || "default";
  const destDbPath = getDbPath(dbName);
  const sourceDbPath = resolve(args.sourceDb);

  if (!existsSync(sourceDbPath)) {
    return `Error: Source database not found: ${sourceDbPath}`;
  }

  // Security: source DB must be within an allowed path
  const pathCheck = isPathAllowed(sourceDbPath, config, process.cwd());
  if (!pathCheck.allowed) {
    return `Error: ${pathCheck.reason}`;
  }

  // Ensure destination directory exists
  await mkdir(RAGCLAW_DIR, { recursive: true });

  const destDb = new Store();
  await destDb.open(destDbPath);

  try {
    const strategy = args.strategy ?? "strict";

    // For reindex, create an embedder
    let embedder: EmbedderPlugin | undefined;
    if (strategy === "reindex") {
      embedder = createEmbedder();
      await embedder.embed("warmup");
    }

    const include = args.include
      ? args.include
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    const exclude = args.exclude
      ? args.exclude
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;

    const mergeService = new MergeService();
    const summary = await mergeService.merge(destDb, sourceDbPath, {
      strategy,
      onConflict: args.onConflict ?? "skip",
      dryRun: args.dryRun ?? false,
      include,
      exclude,
      embedder,
    });

    const { diff } = summary;

    if (summary.dryRun) {
      const lines: string[] = [
        `Dry-run diff (${sourceDbPath} → ${dbName}):`,
        `  Strategy : ${summary.strategy}`,
        `  To add   : ${diff.toAdd.length} source(s)`,
        `  To update: ${diff.toUpdate.length} source(s)`,
        `  Identical: ${diff.identical.length} source(s)`,
        `  Local only: ${diff.localOnly.length} source(s)`,
      ];
      if (diff.toAdd.length > 0) {
        lines.push("\nWould add:");
        diff.toAdd.slice(0, 10).forEach((s) => {
          lines.push(`  + ${s.path}`);
        });
        if (diff.toAdd.length > 10) lines.push(`  ... and ${diff.toAdd.length - 10} more`);
      }
      if (diff.toUpdate.length > 0) {
        lines.push("\nConflicts (would update or skip per --on-conflict):");
        diff.toUpdate.slice(0, 10).forEach((s) => {
          lines.push(`  ~ ${s.path}`);
        });
        if (diff.toUpdate.length > 10) lines.push(`  ... and ${diff.toUpdate.length - 10} more`);
      }
      return lines.join("\n");
    }

    let result = `Merge complete (${summary.strategy}): ${summary.sourcesAdded} added, ${summary.sourcesUpdated} updated, ${summary.sourcesSkipped} skipped.`;
    if (summary.errors.length > 0) {
      result += `\n\nErrors (${summary.errors.length}):\n`;
      result += summary.errors
        .slice(0, 5)
        .map((e) => `  ${e.path}: ${e.error}`)
        .join("\n");
      if (summary.errors.length > 5) result += `\n  ... and ${summary.errors.length - 5} more`;
    }
    return result;
  } finally {
    await destDb.close();
  }
}

// Helper to collect sources (with security enforcement)
async function collectSources(source: string, recursive: boolean): Promise<Source[]> {
  // URL
  if (source.startsWith("http://") || source.startsWith("https://")) {
    const urlCheck = await isUrlAllowed(source, config);
    if (!urlCheck.allowed) {
      throw new Error(urlCheck.reason);
    }
    return [{ type: "url", url: source }];
  }

  const resolved = resolve(source);

  // Path allowlist check (MCP defaults to cwd if allowedPaths is empty)
  const pathCheck = isPathAllowed(resolved, config, process.cwd());
  if (!pathCheck.allowed) {
    throw new Error(pathCheck.reason);
  }

  if (!existsSync(resolved)) {
    throw new Error(`Source not found: ${source}`);
  }

  const stats = await stat(resolved);
  if (stats.isFile()) {
    return [{ type: "file", path: resolved }];
  }

  if (stats.isDirectory() && recursive) {
    const collected: Source[] = [];
    await collectFilesRecursive(resolved, collected, 0, config.maxDepth, config.maxFiles);
    return collected;
  }

  return [];
}

async function collectFilesRecursive(
  dir: string,
  collected: Source[],
  currentDepth: number,
  maxDepth: number,
  maxFiles: number
): Promise<void> {
  if (currentDepth >= maxDepth) {
    return; // depth limit reached
  }

  if (collected.length >= maxFiles) {
    return; // file count limit reached
  }

  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (collected.length >= maxFiles) return;

    const fullPath = join(dir, entry.name);

    if (entry.name.startsWith(".")) continue;
    if (entry.name === "node_modules") continue;

    if (entry.isDirectory()) {
      await collectFilesRecursive(fullPath, collected, currentDepth + 1, maxDepth, maxFiles);
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase();
      // If a config allowedExtensions list is set, skip files not in it.
      // An empty list means no restriction — let extractors decide.
      if (config.allowedExtensions.length > 0 && !config.allowedExtensions.includes(ext)) {
        continue;
      }
      collected.push({ type: "file", path: fullPath });
    }
  }
}

async function ragListDatabases(): Promise<string> {
  if (!existsSync(RAGCLAW_DIR)) {
    return "[]";
  }

  let entries: string[];
  try {
    entries = await readdir(RAGCLAW_DIR);
  } catch {
    return "[]";
  }

  const names = entries
    .filter((f) => f.endsWith(".sqlite"))
    .map((f) => f.slice(0, -".sqlite".length))
    .sort();

  // Open each store briefly to read description + keywords
  const results = await Promise.all(
    names.map(async (name) => {
      const dbPath = getDbPath(name);
      const store = new Store();
      try {
        await store.open(dbPath);
        const description = (await store.getMeta("db_description")) ?? null;
        const keywordsRaw = (await store.getMeta("db_keywords")) ?? "";
        const keywords = keywordsRaw
          ? keywordsRaw
              .split(",")
              .map((k: string) => k.trim())
              .filter(Boolean)
          : [];
        return { name, description, keywords };
      } catch {
        return { name, description: null, keywords: [] };
      } finally {
        await store.close();
      }
    })
  );

  return JSON.stringify(results);
}

async function ragDbInit(args: {
  db?: string;
  description?: string;
  keywords?: string;
}): Promise<string> {
  const dbName = args.db ?? "default";
  const dbPath = getDbPath(dbName);

  if (existsSync(dbPath)) {
    return `Knowledge base "${dbName}" already exists at ${dbPath}`;
  }

  await mkdir(RAGCLAW_DIR, { recursive: true });

  const store = new Store();
  await store.open(dbPath);

  try {
    if (args.description) {
      await store.setMeta("db_description", args.description);
    }
    if (args.keywords) {
      await store.setMeta("db_keywords", args.keywords);
    }
  } finally {
    await store.close();
  }

  return `Created knowledge base "${dbName}" at ${dbPath}`;
}

async function ragDbInfo(args: {
  db?: string;
  description?: string;
  keywords?: string;
}): Promise<string> {
  const dbName = args.db ?? "default";
  const dbPath = getDbPath(dbName);

  if (!existsSync(dbPath)) {
    return `Error: Knowledge base "${dbName}" not found.`;
  }

  if (args.description === undefined && args.keywords === undefined) {
    return "Error: Provide at least one of description or keywords.";
  }

  const store = new Store();
  await store.open(dbPath);

  try {
    if (args.description !== undefined) {
      await store.setMeta("db_description", args.description);
    }
    if (args.keywords !== undefined) {
      await store.setMeta("db_keywords", args.keywords);
    }
  } finally {
    await store.close();
  }

  return `Updated info for knowledge base "${dbName}"`;
}

async function ragDbInfoGet(args: { db?: string }): Promise<string> {
  const dbName = args.db ?? "default";
  const dbPath = getDbPath(dbName);

  if (!existsSync(dbPath)) {
    return `Error: Knowledge base "${dbName}" not found.`;
  }

  const store = new Store();
  await store.open(dbPath);

  try {
    const description = (await store.getMeta("db_description")) ?? null;
    const keywordsRaw = (await store.getMeta("db_keywords")) ?? "";
    const keywords = keywordsRaw
      ? keywordsRaw
          .split(",")
          .map((k: string) => k.trim())
          .filter(Boolean)
      : [];
    return JSON.stringify({ name: dbName, description, keywords });
  } finally {
    await store.close();
  }
}

async function ragDbDelete(args: { db?: string; confirm?: boolean }): Promise<string> {
  if (!args.confirm) {
    return `Error: Destructive operation requires confirm=true. Set confirm=true to delete knowledge base "${args.db ?? "default"}".`;
  }

  const dbName = args.db ?? "default";
  let safeName: string;
  try {
    safeName = sanitizeDbName(dbName);
  } catch (err: unknown) {
    return `Error: ${err}`;
  }

  const dbPath = getDbPath(safeName);

  if (!existsSync(dbPath)) {
    return `Error: Knowledge base "${safeName}" not found.`;
  }

  try {
    await rm(dbPath);
    return `Deleted knowledge base "${safeName}"`;
  } catch (err: unknown) {
    return `Error: Failed to delete "${safeName}": ${err}`;
  }
}

async function ragDbRename(args: {
  oldName: string;
  newName: string;
  confirm?: boolean;
}): Promise<string> {
  if (!args.confirm) {
    return `Error: Destructive operation requires confirm=true. Set confirm=true to rename knowledge base "${args.oldName}" to "${args.newName}".`;
  }

  let safeOld: string;
  let safeNew: string;
  try {
    safeOld = sanitizeDbName(args.oldName);
    safeNew = sanitizeDbName(args.newName);
  } catch (err: unknown) {
    return `Error: ${err}`;
  }

  const oldPath = getDbPath(safeOld);
  const newPath = getDbPath(safeNew);

  if (!existsSync(oldPath)) {
    return `Error: Knowledge base "${safeOld}" not found.`;
  }

  if (existsSync(newPath)) {
    return `Error: Knowledge base "${safeNew}" already exists. Choose a different name.`;
  }

  try {
    await rename(oldPath, newPath);
    return `Renamed knowledge base "${safeOld}" to "${safeNew}"`;
  } catch (err: unknown) {
    return `Error: Failed to rename "${safeOld}": ${err}`;
  }
}

/** Create a one-off IndexingService with specific chunker options (not cached). */
async function buildIndexingService(
  chunker?: string,
  chunkSize?: number,
  overlap?: number,
  store?: Store
): Promise<IndexingService> {
  // When a store is provided, honour the embedder it was originally indexed with
  // so that re-chunked embeddings match the existing dimensionality.
  let embedder: EmbedderPlugin;
  if (store) {
    const storedModel = await store.getMeta("embedder_model");
    const storedName = await store.getMeta("embedder_name");
    embedder = storedModel
      ? createEmbedder({ model: storedModel })
      : storedName
        ? createEmbedder({ alias: storedName })
        : createEmbedder();
  } else {
    embedder = createEmbedder();
  }

  const svc = new IndexingService({
    extractorLimits: config.extractorLimits,
    embedder,
    chunkerStrategy: chunker ?? "auto",
    chunkerDefaults: { chunkSize, overlap },
  });
  await svc.init();
  return svc;
}

async function ragListChunkers(): Promise<string> {
  const indexingService = await getIndexingService();
  const chunkers = indexingService.listChunkers();
  return JSON.stringify(chunkers, null, 2);
}

// Main server
async function main() {
  const server = new McpServer({
    name: "ragclaw-mcp",
    version,
    description:
      "RagClaw knowledge base server. Provides tools to index, search, and manage local knowledge bases (kb). Use kb_search to retrieve relevant information via hybrid vector + keyword search.",
  });

  server.registerTool(
    "kb_search",
    {
      description:
        "Search the knowledge base for relevant documents and code. Returns matching chunks with source paths and relevance scores. Always prefer this over listing sources — search finds the relevant content directly.",
      inputSchema: {
        query: z.string().describe("Search query text"),
        db: z.string().optional().describe("Knowledge base name (default: 'default')"),
        limit: z.number().optional().describe("Maximum number of results (default: 5)"),
      },
    },
    async ({ query, db, limit }) => {
      try {
        const result = await ragSearch({ query, db, limit });
        return { content: [{ type: "text" as const, text: result }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "kb_add",
    {
      description:
        "Index a file, directory, or URL into the knowledge base. Supports markdown, PDF, DOCX, code files, and web pages. Pass crawl=true with a URL to follow links and index an entire site section.",
      inputSchema: {
        source: z.string().describe("File path, directory path, or URL to index"),
        db: z.string().optional().describe("Knowledge base name (default: 'default')"),
        recursive: z.boolean().optional().describe("Recurse into directories (default: true)"),
        crawl: z
          .boolean()
          .optional()
          .describe("Enable crawling — follow links from the seed URL (requires a URL source)"),
        crawlMaxDepth: z.number().optional().describe("Max link depth from start URL (default: 3)"),
        crawlMaxPages: z.number().optional().describe("Max pages to crawl (default: 100)"),
        crawlSameOrigin: z.boolean().optional().describe("Stay on the same domain (default: true)"),
        crawlInclude: z
          .string()
          .optional()
          .describe("Comma-separated path prefixes to include (e.g. '/docs,/api')"),
        crawlExclude: z
          .string()
          .optional()
          .describe("Comma-separated path prefixes to exclude (e.g. '/blog,/archive')"),
        crawlConcurrency: z
          .number()
          .optional()
          .describe("Concurrent requests during crawl (default: 1)"),
        crawlDelay: z
          .number()
          .optional()
          .describe("Delay between requests in milliseconds (default: 1000)"),
        ignoreRobots: z
          .boolean()
          .optional()
          .describe("Ignore robots.txt restrictions — use responsibly (default: false)"),
        chunker: z
          .string()
          .optional()
          .describe(
            "Chunker to use for this indexing call (e.g. 'sentence', 'fixed', 'semantic', 'code'). Overrides config and auto-selection."
          ),
        chunkSize: z
          .number()
          .int()
          .optional()
          .describe("Override chunk size in tokens for the selected chunker."),
        overlap: z
          .number()
          .int()
          .optional()
          .describe("Override overlap size in tokens for the selected chunker."),
      },
    },
    async ({
      source,
      db,
      recursive,
      crawl,
      crawlMaxDepth,
      crawlMaxPages,
      crawlSameOrigin,
      crawlInclude,
      crawlExclude,
      crawlConcurrency,
      crawlDelay,
      ignoreRobots,
      chunker,
      chunkSize,
      overlap,
    }) => {
      try {
        const result = await ragAdd({
          source,
          db,
          recursive,
          crawl,
          crawlMaxDepth,
          crawlMaxPages,
          crawlSameOrigin,
          crawlInclude,
          crawlExclude,
          crawlConcurrency,
          crawlDelay,
          ignoreRobots,
          chunker,
          chunkSize,
          overlap,
        });
        return { content: [{ type: "text" as const, text: result }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "kb_status",
    {
      description: "Get statistics about a knowledge base (number of sources, chunks, size).",
      inputSchema: {
        db: z.string().optional().describe("Knowledge base name (default: 'default')"),
      },
    },
    async ({ db }) => {
      try {
        const result = await ragStatus({ db });
        return { content: [{ type: "text" as const, text: result }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "kb_remove",
    {
      description: "Remove a source from the knowledge base index.",
      inputSchema: {
        source: z.string().describe("Source path or URL to remove"),
        db: z.string().optional().describe("Knowledge base name (default: 'default')"),
      },
    },
    async ({ source, db }) => {
      try {
        const result = await ragRemove({ source, db });
        return { content: [{ type: "text" as const, text: result }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "kb_reindex",
    {
      description:
        "Re-process changed sources in the knowledge base. Only re-indexes files that have changed since last indexing.",
      inputSchema: {
        db: z.string().optional().describe("Knowledge base name (default: 'default')"),
        force: z
          .boolean()
          .optional()
          .describe("Reindex all sources regardless of hash (default: false)"),
        prune: z
          .boolean()
          .optional()
          .describe("Remove sources that no longer exist (default: false)"),
        chunker: z
          .string()
          .optional()
          .describe(
            "Chunker to use for this reindex call (e.g. 'sentence', 'fixed', 'semantic', 'code'). Overrides config and auto-selection."
          ),
        chunkSize: z
          .number()
          .int()
          .optional()
          .describe("Override chunk size in tokens for the selected chunker."),
        overlap: z
          .number()
          .int()
          .optional()
          .describe("Override overlap size in tokens for the selected chunker."),
      },
    },
    async ({ db, force, prune, chunker, chunkSize, overlap }) => {
      try {
        const result = await ragReindex({ db, force, prune, chunker, chunkSize, overlap });
        return { content: [{ type: "text" as const, text: result }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "kb_list_chunkers",
    {
      description:
        "List all available chunkers (built-in and plugin-provided). Returns a JSON array with name, description, handles, and source fields.",
      inputSchema: {},
    },
    async () => {
      try {
        const result = await ragListChunkers();
        return { content: [{ type: "text" as const, text: result }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "kb_db_merge",
    {
      description:
        "Merge another knowledge base (SQLite .db file) into a local one. The source database is never modified. Use strategy='strict' (default) when both databases share the same embedder — embeddings are copied verbatim. Use strategy='reindex' to re-embed with the local model when embedders differ.",
      inputSchema: {
        sourceDb: z.string().describe("Absolute path to the source .db file to merge from"),
        db: z.string().optional().describe("Destination knowledge base name (default: 'default')"),
        strategy: z
          .enum(["strict", "reindex"])
          .optional()
          .describe(
            "Merge strategy: 'strict' (copy embeddings, requires identical embedder) or 'reindex' (re-embed text, works across embedders). Default: 'strict'."
          ),
        onConflict: z
          .enum(["skip", "prefer-local", "prefer-remote"])
          .optional()
          .describe(
            "Conflict resolution when the same source exists in both DBs. Default: 'skip' (keep local)."
          ),
        dryRun: z
          .boolean()
          .optional()
          .describe("Preview what would change without writing anything (default: false)"),
        include: z
          .string()
          .optional()
          .describe("Comma-separated path prefixes — only import matching sources"),
        exclude: z
          .string()
          .optional()
          .describe("Comma-separated path prefixes — skip matching sources"),
      },
    },
    async ({ sourceDb, db, strategy, onConflict, dryRun, include, exclude }) => {
      try {
        const result = await ragMerge({
          sourceDb,
          db,
          strategy,
          onConflict,
          dryRun,
          include,
          exclude,
        });
        return { content: [{ type: "text" as const, text: result }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "kb_list_databases",
    {
      description:
        "List all available knowledge bases. Returns a JSON array of objects with name, description, and keywords fields — use this to decide which knowledge base to search.",
      inputSchema: {},
    },
    async () => {
      try {
        const result = await ragListDatabases();
        return { content: [{ type: "text" as const, text: result }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "kb_db_init",
    {
      description:
        "Initialize a new knowledge base. Creates an empty SQLite database at the configured data directory. Safe to call if the knowledge base already exists — returns a message without overwriting.",
      inputSchema: {
        db: z.string().optional().describe("Knowledge base name (default: 'default')"),
        description: z
          .string()
          .optional()
          .describe("Human-readable description of this knowledge base"),
        keywords: z
          .string()
          .optional()
          .describe(
            "Comma-separated keywords that describe the content (e.g. 'api, auth, endpoints')"
          ),
      },
    },
    async ({ db, description, keywords }) => {
      try {
        const result = await ragDbInit({ db, description, keywords });
        return { content: [{ type: "text" as const, text: result }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "kb_db_info",
    {
      description:
        "Set or update the description and keywords for an existing knowledge base. Use this so that kb_list_databases can return enriched metadata that helps an agent decide which knowledge base to search.",
      inputSchema: {
        db: z.string().optional().describe("Knowledge base name (default: 'default')"),
        description: z
          .string()
          .optional()
          .describe("Human-readable description of this knowledge base"),
        keywords: z
          .string()
          .optional()
          .describe(
            "Comma-separated keywords that describe the content (e.g. 'api, auth, endpoints')"
          ),
      },
    },
    async ({ db, description, keywords }) => {
      try {
        const result = await ragDbInfo({ db, description, keywords });
        return { content: [{ type: "text" as const, text: result }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "kb_db_info_get",
    {
      description:
        "Get the description and keywords stored for a knowledge base. Returns a JSON object with name, description, and keywords fields. Use this to inspect metadata before updating it.",
      inputSchema: {
        db: z.string().optional().describe("Knowledge base name (default: 'default')"),
      },
    },
    async ({ db }) => {
      try {
        const result = await ragDbInfoGet({ db });
        return { content: [{ type: "text" as const, text: result }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "kb_db_delete",
    {
      description:
        "Delete a knowledge base and its .sqlite file permanently. This operation is irreversible. You MUST pass confirm=true explicitly to proceed — this prevents accidental deletion.",
      inputSchema: {
        db: z.string().optional().describe("Knowledge base name to delete (default: 'default')"),
        confirm: z
          .boolean()
          .optional()
          .describe(
            "Must be true to confirm the destructive operation. Omitting or passing false returns an error."
          ),
      },
    },
    async ({ db, confirm }) => {
      try {
        const result = await ragDbDelete({ db, confirm });
        return { content: [{ type: "text" as const, text: result }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "kb_db_rename",
    {
      description:
        "Rename a knowledge base. Errors if the new name already exists. You MUST pass confirm=true explicitly to proceed — this prevents accidental renaming.",
      inputSchema: {
        oldName: z.string().describe("Current name of the knowledge base"),
        newName: z.string().describe("New name for the knowledge base"),
        confirm: z
          .boolean()
          .optional()
          .describe(
            "Must be true to confirm the operation. Omitting or passing false returns an error."
          ),
      },
    },
    async ({ oldName, newName, confirm }) => {
      try {
        const result = await ragDbRename({ oldName, newName, confirm });
        return { content: [{ type: "text" as const, text: result }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error}` }], isError: true };
      }
    }
  );

  // Start server
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
