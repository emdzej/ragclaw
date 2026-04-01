/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { randomUUID } from "node:crypto";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { getLogger } from "../logger.js";
import { createServer } from "../server.js";
import { closeAllCachedStores } from "../services.js";

export type HttpTransportOptions = {
  version: string;
  host: string;
  port: number;
};

/**
 * Start the MCP server using Streamable HTTP transport over Express.
 *
 * Each connecting client gets its own MCP session (stateful mode).
 * Expensive resources (embedders, stores) are shared across sessions
 * via the module-level caches in `services.ts`.
 *
 * The server binds to the specified host and port and listens for
 * MCP JSON-RPC messages at the `/mcp` endpoint.
 */
export async function startHttp(options: HttpTransportOptions): Promise<void> {
  const { version, host, port } = options;
  const log = getLogger();

  const app = createMcpExpressApp({ host });

  /** Active transports keyed by session ID — used for cleanup on shutdown. */
  const transports = new Map<string, StreamableHTTPServerTransport>();

  // -------------------------------------------------------------------------
  // GET /healthz — lightweight liveness / readiness probe
  // -------------------------------------------------------------------------
  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  // -------------------------------------------------------------------------
  // POST /mcp — handles JSON-RPC requests (new sessions + existing sessions)
  // -------------------------------------------------------------------------
  app.post("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    // Existing session — route to its transport
    if (sessionId) {
      const transport = transports.get(sessionId);
      if (transport) {
        await transport.handleRequest(req, res, req.body);
        return;
      }
    }

    // New session — must be an initialize request
    if (!sessionId && isInitializeRequest(req.body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport);
          log.info({ sessionId: id }, "MCP session initialized");
        },
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          transports.delete(transport.sessionId);
          log.info({ sessionId: transport.sessionId }, "MCP session closed");
        }
      };

      const server = createServer(version);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // Invalid request
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Invalid session" },
      id: null,
    });
  });

  // -------------------------------------------------------------------------
  // GET /mcp — SSE stream for server-to-client notifications
  // -------------------------------------------------------------------------
  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string;
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (transport) {
      await transport.handleRequest(req, res);
    } else {
      res.status(400).send("Invalid session");
    }
  });

  // -------------------------------------------------------------------------
  // DELETE /mcp — explicit session termination
  // -------------------------------------------------------------------------
  app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string;
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (transport) {
      await transport.handleRequest(req, res);
    } else {
      res.status(400).send("Invalid session");
    }
  });

  // -------------------------------------------------------------------------
  // Graceful shutdown
  // -------------------------------------------------------------------------
  const server = app.listen(port, host, () => {
    log.info({ host, port, url: `http://${host}:${port}/mcp` }, "MCP HTTP server listening");
  });

  const shutdown = async (signal: string) => {
    log.info({ signal }, "Shutting down MCP HTTP server");

    // Stop accepting new connections
    server.close();

    // Close all active transports
    for (const [id, transport] of transports) {
      try {
        await transport.close();
        log.debug({ sessionId: id }, "Closed transport");
      } catch (err: unknown) {
        log.warn({ sessionId: id, err }, "Error closing transport");
      }
    }
    transports.clear();

    // Close all cached SQLite stores
    await closeAllCachedStores();

    log.info("Shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
