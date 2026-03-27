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

async function ragReadSource(args: { source: string; db?: string }): Promise<string> {
  const dbName = args.db || "default";
  const dbPath = getDbPath(dbName);

  if (!existsSync(dbPath)) {
    return `Knowledge base "${dbName}" not found. Run kb_add first to create it.`;
  }

  const store = await getCachedStore(dbName);

  const chunks = await store.getChunksBySourcePath(args.source);

  if (chunks.length === 0) {
    return `Source not found: ${args.source}`;
  }

  const formatted = chunks.map((chunk: { startLine?: number; endLine?: number; text: string }) => {
    const lines =
      chunk.startLine && chunk.endLine ? ` (lines ${chunk.startLine}-${chunk.endLine})` : "";
    return `--- chunk${lines} ---\n${chunk.text}`;
  });

  return `Source: ${args.source}\nChunks: ${chunks.length}\n\n${formatted.join("\n\n")}`;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerReadSourceTool(server: McpServer): void {
  server.registerTool(
    "kb_read_source",
    {
      description:
        "Retrieve the full indexed content of a source from the knowledge base. Returns all chunks in document order, concatenated. Use this when kb_search returns a relevant source and you need the complete content instead of just the matching chunk. The source parameter should be a source path exactly as shown in kb_search results.",
      inputSchema: {
        source: z.string().describe("Source path or URL exactly as shown in kb_search results"),
        db: z.string().optional().describe("Knowledge base name (default: 'default')"),
      },
    },
    async ({ source, db }) => {
      try {
        const result = await ragReadSource({ source, db });
        return { content: [{ type: "text" as const, text: result }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error}` }], isError: true };
      }
    }
  );
}
