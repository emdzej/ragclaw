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
import { invalidateStoreCache } from "../services.js";

// ---------------------------------------------------------------------------
// Tool implementation
// ---------------------------------------------------------------------------

async function ragRemove(args: { source: string; db?: string }): Promise<string> {
  const dbName = args.db || "default";
  const dbPath = getDbPath(dbName);

  if (!existsSync(dbPath)) {
    return `Knowledge base "${dbName}" not found.`;
  }

  // Write operation — use a fresh Store and invalidate cache afterward
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
    await invalidateStoreCache(dbName);
  }
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerRemoveTool(server: McpServer): void {
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
}
