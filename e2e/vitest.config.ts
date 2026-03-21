/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const CLI_BIN = resolve(__dirname, "../packages/cli/dist/cli.js");

export default defineConfig({
  test: {
    name: "e2e",
    include: ["tests/**/*.test.ts"],
    testTimeout: 60_000,
    forceRerunTriggers: ["../packages/cli/dist/**"],
    // E2E tests spawn subprocesses that load a native embedding model.
    // Running tests concurrently causes mutex crashes (SIGABRT) in the native
    // module.  Use a forks pool with a single worker to force sequential runs.
    pool: "forks",
    maxWorkers: 1,
    env: {
      RAGCLAW_CLI_BIN: CLI_BIN,
    },
  },
});
