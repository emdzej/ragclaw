/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { existsSync } from "node:fs";
import { Store } from "@emdzej/ragclaw-core";
import chalk from "chalk";
import { getDbPath } from "../config.js";

interface ListOptions {
  db: string;
  type?: string;
}

export async function listCommand(options: ListOptions): Promise<void> {
  const dbPath = getDbPath(options.db);

  if (!existsSync(dbPath)) {
    console.error(chalk.red(`Knowledge base "${options.db}" not found.`));
    console.log(chalk.dim(`Run: ragclaw init ${options.db}`));
    process.exit(1);
  }

  const store = new Store();
  await store.open(dbPath);

  try {
    let sources = await store.listSources();

    if (options.type) {
      sources = sources.filter((s) => s.type === options.type);
    }

    if (sources.length === 0) {
      console.log(chalk.yellow("No sources indexed."));
      return;
    }

    console.log(chalk.bold(`Indexed sources (${sources.length}):\n`));

    for (const source of sources) {
      const date = new Date(source.indexedAt);
      const typeIcon = source.type === "file" ? "📄" : source.type === "url" ? "🌐" : "📝";

      console.log(`  ${typeIcon} ${chalk.cyan(source.path)}`);
      console.log(chalk.dim(`     Indexed: ${date.toLocaleString()}`));
    }
  } finally {
    await store.close();
  }
}
