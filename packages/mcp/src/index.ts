#!/usr/bin/env node

/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
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
} from "@emdzej/ragclaw-core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

const config = getConfig();
const RAGCLAW_DIR = config.dataDir;

// Tool definitions
const TOOLS: Tool[] = [
  {
    name: "rag_search",
    description:
      "Search the local knowledge base for relevant documents and code. Returns matching chunks with source paths and relevance scores.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query text",
        },
        db: {
          type: "string",
          description: "Knowledge base name (default: 'default')",
          default: "default",
        },
        limit: {
          type: "number",
          description: "Maximum number of results (default: 5)",
          default: 5,
        },
        mode: {
          type: "string",
          enum: ["vector", "keyword", "hybrid"],
          description: "Search mode (default: 'hybrid')",
          default: "hybrid",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "rag_add",
    description:
      "Index a file, directory, or URL into the knowledge base. Supports markdown, PDF, DOCX, code files, and web pages. Pass crawl=true with a URL to follow links and index an entire site section.",
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description: "File path, directory path, or URL to index",
        },
        db: {
          type: "string",
          description: "Knowledge base name (default: 'default')",
          default: "default",
        },
        recursive: {
          type: "boolean",
          description: "Recurse into directories (default: true)",
          default: true,
        },
        crawl: {
          type: "boolean",
          description: "Enable crawling — follow links from the seed URL (requires a URL source)",
          default: false,
        },
        crawlMaxDepth: {
          type: "number",
          description: "Max link depth from start URL (default: 3)",
          default: 3,
        },
        crawlMaxPages: {
          type: "number",
          description: "Max pages to crawl (default: 100)",
          default: 100,
        },
        crawlSameOrigin: {
          type: "boolean",
          description: "Stay on the same domain (default: true)",
          default: true,
        },
        crawlInclude: {
          type: "string",
          description: "Comma-separated path prefixes to include (e.g. '/docs,/api')",
        },
        crawlExclude: {
          type: "string",
          description: "Comma-separated path prefixes to exclude (e.g. '/blog,/archive')",
        },
        crawlConcurrency: {
          type: "number",
          description: "Concurrent requests during crawl (default: 1)",
          default: 1,
        },
        crawlDelay: {
          type: "number",
          description: "Delay between requests in milliseconds (default: 1000)",
          default: 1000,
        },
        ignoreRobots: {
          type: "boolean",
          description: "Ignore robots.txt restrictions — use responsibly (default: false)",
          default: false,
        },
      },
      required: ["source"],
    },
  },
  {
    name: "rag_status",
    description: "Get statistics about a knowledge base (number of sources, chunks, size).",
    inputSchema: {
      type: "object",
      properties: {
        db: {
          type: "string",
          description: "Knowledge base name (default: 'default')",
          default: "default",
        },
      },
    },
  },
  {
    name: "rag_list",
    description: "List all indexed sources in a knowledge base.",
    inputSchema: {
      type: "object",
      properties: {
        db: {
          type: "string",
          description: "Knowledge base name (default: 'default')",
          default: "default",
        },
      },
    },
  },
  {
    name: "rag_remove",
    description: "Remove a source from the knowledge base index.",
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description: "Source path or URL to remove",
        },
        db: {
          type: "string",
          description: "Knowledge base name (default: 'default')",
          default: "default",
        },
      },
      required: ["source"],
    },
  },
  {
    name: "rag_reindex",
    description:
      "Re-process changed sources in the knowledge base. Only re-indexes files that have changed since last indexing.",
    inputSchema: {
      type: "object",
      properties: {
        db: {
          type: "string",
          description: "Knowledge base name (default: 'default')",
          default: "default",
        },
        force: {
          type: "boolean",
          description: "Reindex all sources regardless of hash (default: false)",
          default: false,
        },
        prune: {
          type: "boolean",
          description: "Remove sources that no longer exist (default: false)",
          default: false,
        },
      },
    },
  },
  {
    name: "rag_merge",
    description:
      "Merge another knowledge base (SQLite .db file) into a local one. The source database is never modified. Use strategy='strict' (default) when both databases share the same embedder — embeddings are copied verbatim. Use strategy='reindex' to re-embed with the local model when embedders differ.",
    inputSchema: {
      type: "object",
      properties: {
        sourceDb: {
          type: "string",
          description: "Absolute path to the source .db file to merge from",
        },
        db: {
          type: "string",
          description: "Destination knowledge base name (default: 'default')",
          default: "default",
        },
        strategy: {
          type: "string",
          enum: ["strict", "reindex"],
          description:
            "Merge strategy: 'strict' (copy embeddings, requires identical embedder) or 'reindex' (re-embed text, works across embedders). Default: 'strict'.",
          default: "strict",
        },
        onConflict: {
          type: "string",
          enum: ["skip", "prefer-local", "prefer-remote"],
          description:
            "Conflict resolution when the same source exists in both DBs. Default: 'skip' (keep local).",
          default: "skip",
        },
        dryRun: {
          type: "boolean",
          description: "Preview what would change without writing anything (default: false)",
          default: false,
        },
        include: {
          type: "string",
          description: "Comma-separated path prefixes — only import matching sources",
        },
        exclude: {
          type: "string",
          description: "Comma-separated path prefixes — skip matching sources",
        },
      },
      required: ["sourceDb"],
    },
  },
];

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

async function ragSearch(args: {
  query: string;
  db?: string;
  limit?: number;
  mode?: "vector" | "keyword" | "hybrid";
}): Promise<string> {
  const dbName = args.db || "default";
  const dbPath = getDbPath(dbName);

  if (!existsSync(dbPath)) {
    return `Knowledge base "${dbName}" not found. Run rag_add first to create it.`;
  }

  const store = new Store();
  await store.open(dbPath);

  try {
    const embedding =
      args.mode !== "keyword"
        ? await getEmbedder(dbName, store).then((e) => e.embedQuery(args.query))
        : undefined;

    const results = await store.search({
      text: args.query,
      embedding,
      limit: args.limit || 5,
      mode: args.mode || "hybrid",
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
}): Promise<string> {
  const dbName = args.db || "default";
  const dbPath = getDbPath(dbName);

  // Ensure directory exists
  await mkdir(RAGCLAW_DIR, { recursive: true });

  const store = new Store();
  await store.open(dbPath);

  try {
    const indexingService = await getIndexingService();

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

async function ragList(args: { db?: string }): Promise<string> {
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
      return "No sources indexed.";
    }

    const lines = sources.map((s) => {
      const icon = s.type === "file" ? "📄" : s.type === "url" ? "🌐" : "📝";
      const date = new Date(s.indexedAt).toLocaleDateString();
      return `${icon} ${s.path} (${date})`;
    });

    return `Indexed sources (${sources.length}):\n${lines.join("\n")}`;
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

    const indexingService = await getIndexingService();

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

  const supportedExts = [
    ".md",
    ".markdown",
    ".mdx",
    ".txt",
    ".text",
    ".pdf",
    ".docx",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".py",
    ".go",
    ".java",
  ];

  for (const entry of entries) {
    if (collected.length >= maxFiles) return;

    const fullPath = join(dir, entry.name);

    if (entry.name.startsWith(".")) continue;
    if (entry.name === "node_modules") continue;

    if (entry.isDirectory()) {
      await collectFilesRecursive(fullPath, collected, currentDepth + 1, maxDepth, maxFiles);
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase();
      if (supportedExts.includes(ext)) {
        collected.push({ type: "file", path: fullPath });
      }
    }
  }
}

// Main server
async function main() {
  const server = new Server(
    {
      name: "ragclaw-mcp",
      version: "0.2.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // List tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  // Call tool
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      let result: string;

      switch (name) {
        case "rag_search":
          result = await ragSearch(args as Parameters<typeof ragSearch>[0]);
          break;
        case "rag_add":
          result = await ragAdd(args as Parameters<typeof ragAdd>[0]);
          break;
        case "rag_status":
          result = await ragStatus(args as Parameters<typeof ragStatus>[0]);
          break;
        case "rag_list":
          result = await ragList(args as Parameters<typeof ragList>[0]);
          break;
        case "rag_remove":
          result = await ragRemove(args as Parameters<typeof ragRemove>[0]);
          break;
        case "rag_reindex":
          result = await ragReindex(args as Parameters<typeof ragReindex>[0]);
          break;
        case "rag_merge":
          result = await ragMerge(args as Parameters<typeof ragMerge>[0]);
          break;
        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      return {
        content: [{ type: "text", text: result }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${error}` }],
        isError: true,
      };
    }
  });

  // Start server
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
