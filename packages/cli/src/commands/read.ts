/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { existsSync } from "node:fs";
import { Store } from "@emdzej/ragclaw-core";
import chalk from "chalk";
import ora from "ora";
import { getDbPath } from "../config.js";

interface ReadOptions {
  db: string;
  json?: boolean;
}

export async function readCommand(source: string, options: ReadOptions): Promise<void> {
  const dbPath = getDbPath(options.db);

  if (!existsSync(dbPath)) {
    console.error(chalk.red(`Knowledge base "${options.db}" not found.`));
    console.log(chalk.dim(`Run: ragclaw db init ${options.db}`));
    process.exitCode = 1;
    return;
  }

  const store = new Store();
  await store.open(dbPath);

  const spinner = ora("Retrieving source...").start();

  try {
    const chunks = await store.getChunksBySourcePath(source);

    spinner.stop();

    if (chunks.length === 0) {
      console.error(chalk.yellow(`Source not found: ${source}`));
      console.log(chalk.dim("Use 'ragclaw list' to see indexed sources."));
      process.exitCode = 1;
      return;
    }

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            source,
            chunks: chunks.map((c) => ({
              id: c.id,
              text: c.text,
              startLine: c.startLine,
              endLine: c.endLine,
              metadata: c.metadata,
            })),
          },
          null,
          2
        )
      );
      return;
    }

    console.log(chalk.bold(`Source: ${source}`));
    console.log(chalk.dim(`Chunks: ${chunks.length}\n`));

    for (const chunk of chunks) {
      const lines =
        chunk.startLine && chunk.endLine
          ? chalk.dim(` (lines ${chunk.startLine}-${chunk.endLine})`)
          : "";
      console.log(chalk.cyan(`--- chunk${lines} ---`));
      console.log(chunk.text);
      console.log();
    }
  } finally {
    await store.close();
  }
}
