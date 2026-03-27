/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAddTool } from "./tools/add.js";
import { registerChunkersTool } from "./tools/chunkers.js";
import { registerDatabaseTools } from "./tools/database.js";
import { registerMergeTool } from "./tools/merge.js";
import { registerReadSourceTool } from "./tools/read-source.js";
import { registerReindexTool } from "./tools/reindex.js";
import { registerRemoveTool } from "./tools/remove.js";
import { registerSearchTool } from "./tools/search.js";
import { registerStatusTool } from "./tools/status.js";

/**
 * Create a fully configured McpServer with all tools registered.
 *
 * Called once for stdio transport or once per session for HTTP transport.
 * Expensive resources (embedders, stores, indexing service) are shared
 * via module-level caches in `services.ts`, not per-server.
 */
export function createServer(version: string): McpServer {
  const server = new McpServer({
    name: "ragclaw-mcp",
    version,
    description:
      "RagClaw knowledge base server. Provides tools to index, search, and manage local knowledge bases (kb). Use kb_search to retrieve relevant information via hybrid vector + keyword search.",
  });

  registerSearchTool(server);
  registerReadSourceTool(server);
  registerAddTool(server);
  registerStatusTool(server);
  registerRemoveTool(server);
  registerReindexTool(server);
  registerChunkersTool(server);
  registerMergeTool(server);
  registerDatabaseTools(server);

  return server;
}
