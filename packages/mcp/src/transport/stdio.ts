/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getLogger } from "../logger.js";
import { createServer } from "../server.js";

/**
 * Start the MCP server using stdio transport.
 *
 * This is the default mode — the server communicates over stdin/stdout
 * using the MCP JSON-RPC protocol.  A single McpServer instance is
 * created and connected to the transport.
 */
export async function startStdio(version: string): Promise<void> {
  const log = getLogger();
  log.info("Starting MCP server with stdio transport");

  const server = createServer(version);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  log.info("MCP server connected via stdio");
}
