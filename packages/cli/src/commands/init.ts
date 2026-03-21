/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { existsSync } from "node:fs";
import { Store } from "@emdzej/ragclaw-core";
import chalk from "chalk";
import { ensureDataDir, getDbPath } from "../config.js";

export async function initCommand(name: string): Promise<void> {
  const dbPath = getDbPath(name);

  if (existsSync(dbPath)) {
    console.log(chalk.yellow(`Knowledge base "${name}" already exists at ${dbPath}`));
    return;
  }

  // Create directory if needed
  ensureDataDir();

  // Initialize empty database
  const store = new Store();
  await store.open(dbPath);
  await store.close();

  console.log(chalk.green(`✓ Created knowledge base "${name}"`));
  console.log(chalk.dim(`  Path: ${dbPath}`));
  console.log();
  console.log("Next steps:");
  console.log(chalk.cyan(`  ragclaw add ./docs/          # Add a directory`));
  console.log(chalk.cyan(`  ragclaw add https://...      # Add a web page`));
  console.log(chalk.cyan(`  ragclaw search "your query"  # Search`));
}
