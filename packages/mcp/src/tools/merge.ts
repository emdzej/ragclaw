/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { EmbedderPlugin } from "@emdzej/ragclaw-core";
import {
  createEmbedder,
  getDbPath,
  isPathAllowed,
  MergeService,
  Store,
} from "@emdzej/ragclaw-core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config, invalidateStoreCache, RAGCLAW_DIR } from "../services.js";

// ---------------------------------------------------------------------------
// Tool implementation
// ---------------------------------------------------------------------------

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
    await invalidateStoreCache(dbName);
  }
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerMergeTool(server: McpServer): void {
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
}
