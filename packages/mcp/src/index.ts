#!/usr/bin/env node

/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { createRequire } from "node:module";
import { Command } from "commander";
import { getLogger, initLogger } from "./logger.js";
import { startHttp } from "./transport/http.js";
import { startStdio } from "./transport/stdio.js";

const _require = createRequire(import.meta.url);
const { version } = _require("../package.json") as { version: string };

const program = new Command();

program
  .name("ragclaw-mcp")
  .description(
    "RagClaw MCP server — exposes RAG knowledge base tools to AI agents via the Model Context Protocol."
  )
  .version(version)
  .option("--transport <type>", 'Transport type: "stdio" or "http"', "stdio")
  .option("--port <number>", "Port for HTTP transport", "3000")
  .option(
    "--host <host>",
    "Host/IP to bind HTTP transport (default: 127.0.0.1). WARNING: binding to 0.0.0.0 exposes the server without authentication.",
    "127.0.0.1"
  )
  .option("--log-level <level>", "Log level: debug, info, warn, error", "info")
  .action(async (opts: { transport: string; port: string; host: string; logLevel: string }) => {
    initLogger(opts.logLevel);
    const log = getLogger();

    const transport = opts.transport.toLowerCase();

    if (transport !== "stdio" && transport !== "http") {
      log.error({ transport }, 'Invalid transport — must be "stdio" or "http"');
      process.exitCode = 1;
      return;
    }

    if (transport === "stdio") {
      await startStdio(version);
    } else {
      const port = Number.parseInt(opts.port, 10);
      if (Number.isNaN(port) || port < 1 || port > 65535) {
        log.error({ port: opts.port }, "Invalid port number (1-65535)");
        process.exitCode = 1;
        return;
      }

      if (opts.host === "0.0.0.0" || opts.host === "::") {
        log.warn(
          "Binding to all interfaces — the MCP server has filesystem access. " +
            "Consider using 127.0.0.1 or adding authentication."
        );
      }

      await startHttp({ version, host: opts.host, port });
    }
  });

program.parse();
