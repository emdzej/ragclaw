/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getIndexingService } from "../services.js";

// ---------------------------------------------------------------------------
// Tool implementation
// ---------------------------------------------------------------------------

async function ragListChunkers(): Promise<string> {
  const indexingService = await getIndexingService();
  const chunkers = indexingService.listChunkers();
  return JSON.stringify(chunkers, null, 2);
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerChunkersTool(server: McpServer): void {
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
}
