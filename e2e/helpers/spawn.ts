/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execa } from "execa";

/** Absolute path to the compiled CLI binary. */
export const CLI_BIN = resolve(new URL("../../packages/cli/dist/cli.js", import.meta.url).pathname);

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** OS signal name if the process was killed/crashed (e.g. "SIGABRT"). */
  signal: string | undefined;
  /** True when the process exited with a non-zero code OR was killed by a signal. */
  failed: boolean;
}

export interface IsolatedEnv {
  /** Temp data dir — passed as RAGCLAW_DATA_DIR. */
  dataDir: string;
  /** Temp config dir — passed as RAGCLAW_CONFIG_DIR. */
  configDir: string;
  /** Run the CLI with this environment isolated. */
  run(args: string[], extraEnv?: Record<string, string>): Promise<SpawnResult>;
  /** Remove temp dirs. Call in afterEach / onTestFinished. */
  cleanup(): Promise<void>;
}

/**
 * Create a temporary isolated environment for one test.
 * The returned object manages its own temp directories and provides a `run()`
 * helper that spawns the CLI binary with those directories in scope.
 */
export async function createIsolatedEnv(): Promise<IsolatedEnv> {
  const base = tmpdir();
  const dataDir = await mkdtemp(join(base, "ragclaw-data-"));
  const configDir = await mkdtemp(join(base, "ragclaw-cfg-"));

  return {
    dataDir,
    configDir,

    async run(args: string[], extraEnv: Record<string, string> = {}): Promise<SpawnResult> {
      const result = await execa("node", [CLI_BIN, ...args], {
        env: {
          ...process.env,
          RAGCLAW_DATA_DIR: dataDir,
          RAGCLAW_CONFIG_DIR: configDir,
          // Suppress interactive / colour output for reliable assertions
          NO_COLOR: "1",
          CI: "1",
          ...extraEnv,
        },
        reject: false,
      });

      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode ?? 0,
        signal: result.signal ?? undefined,
        failed: result.failed,
      };
    },

    async cleanup(): Promise<void> {
      await rm(dataDir, { recursive: true, force: true });
      await rm(configDir, { recursive: true, force: true });
    },
  };
}
