/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { existsSync } from "node:fs";
import { getDbPath } from "@emdzej/ragclaw-core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getCachedStore } from "../services.js";

// ---------------------------------------------------------------------------
// Tool implementation
// ---------------------------------------------------------------------------

async function ragStatus(args: { db?: string }): Promise<string> {
  const dbName = args.db || "default";
  const dbPath = getDbPath(dbName);

  if (!existsSync(dbPath)) {
    return `Knowledge base "${dbName}" not found.`;
  }

  const store = await getCachedStore(dbName);

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
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerStatusTool(server: McpServer): void {
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
}
