/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import pino from "pino";

/**
 * Create the application logger.
 *
 * Pino writes to stderr so it never interferes with the MCP JSON-RPC
 * protocol on stdout (stdio transport) or with HTTP responses.
 */
export function createLogger(level: string = "info"): pino.Logger {
  return pino({
    level,
    transport:
      process.env.NODE_ENV !== "production"
        ? { target: "pino-pretty", options: { destination: 2 } }
        : undefined,
    // In production, raw JSON goes to stderr by default (fd 2).
    // pino-pretty is only loaded in dev (it's a devDependency).
  });
}

/** Module-level singleton — set once during startup via `initLogger()`. */
let logger: pino.Logger = createLogger();

export function initLogger(level: string): void {
  logger = createLogger(level);
}

export function getLogger(): pino.Logger {
  return logger;
}
