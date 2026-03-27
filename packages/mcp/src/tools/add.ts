/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { mkdir } from "node:fs/promises";
import { getDbPath, isUrlAllowed, Store } from "@emdzej/ragclaw-core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  buildIndexingService,
  collectSources,
  config,
  invalidateStoreCache,
  RAGCLAW_DIR,
} from "../services.js";

// ---------------------------------------------------------------------------
// Tool implementation
// ---------------------------------------------------------------------------

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

  // Write operation — use a fresh Store and invalidate cache afterward
  const store = new Store();
  await store.open(dbPath);

  try {
    // Use per-call chunker options if provided, else fall back to shared service.
    // Pass the store so the indexing service honours the DB's stored embedder.
    const indexingService =
      args.chunker !== undefined || args.chunkSize !== undefined || args.overlap !== undefined
        ? await buildIndexingService(args.chunker, args.chunkSize, args.overlap, store)
        : await buildIndexingService(undefined, undefined, undefined, store);

    // -----------------------------------------------------------------------
    // Crawl mode
    // -----------------------------------------------------------------------
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

    // -----------------------------------------------------------------------
    // Normal mode
    // -----------------------------------------------------------------------
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
    await invalidateStoreCache(dbName);
  }
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerAddTool(server: McpServer): void {
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
}
