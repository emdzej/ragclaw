/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { existsSync } from "node:fs";
import { getDbPath, Store } from "@emdzej/ragclaw-core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildIndexingService, invalidateStoreCache } from "../services.js";

// ---------------------------------------------------------------------------
// Tool implementation
// ---------------------------------------------------------------------------

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

  // Write operation — use a fresh Store and invalidate cache afterward
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
    await invalidateStoreCache(dbName);
  }
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerReindexTool(server: McpServer): void {
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
}
