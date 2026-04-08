/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { existsSync } from "node:fs";
import { createEmbedder, Store } from "@emdzej/ragclaw-core";
import chalk from "chalk";
import ora from "ora";
import { getDbPath } from "../config.js";

/**
 * Parse a user-supplied timestamp value.
 * Accepts either a numeric epoch (milliseconds) or an ISO 8601 string.
 * Returns UTC epoch ms or `undefined` if the value is not provided.
 * Throws on invalid input.
 */
function parseTimestamp(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const asNum = Number(value);
  if (Number.isFinite(asNum) && asNum > 0) return asNum;
  const asDate = new Date(value);
  if (!Number.isNaN(asDate.getTime())) return asDate.getTime();
  throw new Error(
    `Invalid timestamp: "${value}". Provide epoch milliseconds or an ISO 8601 string.`
  );
}

interface SearchOptions {
  db: string;
  limit: string;
  json?: boolean;
  after?: string;
  before?: string;
}

export async function searchCommand(query: string, options: SearchOptions): Promise<void> {
  const dbPath = getDbPath(options.db);

  if (!existsSync(dbPath)) {
    console.error(chalk.red(`Knowledge base "${options.db}" not found.`));
    console.log(chalk.dim(`Run: ragclaw init ${options.db}`));
    process.exit(1);
  }

  // Parse time filter flags
  const after = parseTimestamp(options.after);
  const before = parseTimestamp(options.before);
  const filter = after !== undefined || before !== undefined ? { after, before } : undefined;

  const store = new Store();
  await store.open(dbPath);

  const spinner = ora("Searching...").start();

  try {
    // Always use hybrid search — load the embedder from store metadata.
    const storedModel = await store.getMeta("embedder_model");
    const storedName = (await store.getMeta("embedder_name")) ?? "nomic";
    const embedder = storedModel
      ? createEmbedder({ model: storedModel })
      : createEmbedder({ alias: storedName });
    const embedding = await embedder.embedQuery(query);

    const results = await store.search({
      text: query,
      embedding,
      limit: parseInt(options.limit, 10),
      mode: "hybrid",
      filter,
    });

    spinner.stop();

    if (results.length === 0) {
      console.log(chalk.yellow("No results found."));
      return;
    }

    if (options.json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    console.log(chalk.bold(`Found ${results.length} result(s):\n`));

    for (let i = 0; i < results.length; i++) {
      const { chunk, score, scoreVector, scoreKeyword } = results[i];
      const scoreStr = `${(score * 100).toFixed(1)}%`;

      console.log(chalk.cyan(`[${i + 1}] ${chunk.sourcePath}`));

      if (chunk.startLine && chunk.endLine) {
        console.log(chalk.dim(`    Lines ${chunk.startLine}-${chunk.endLine}`));
      }

      console.log(chalk.dim(`    Score: ${scoreStr}`));

      if (scoreVector !== undefined && scoreKeyword !== undefined) {
        console.log(
          chalk.dim(
            `    (vector: ${(scoreVector * 100).toFixed(1)}%, keyword: ${(scoreKeyword * 100).toFixed(1)}%)`
          )
        );
      }

      // Show full chunk text
      const snippet = chunk.text.replace(/\n/g, " ");
      console.log(`    ${snippet}`);
      console.log();
    }
  } finally {
    await store.close();
  }
}
