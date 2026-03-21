/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { existsSync } from "fs";
import { createInterface } from "readline";
import chalk from "chalk";
import { Store } from "@emdzej/ragclaw-core";
import { getDbPath } from "../config.js";

interface RemoveOptions {
  db: string;
  yes?: boolean;
}

export async function removeCommand(source: string, options: RemoveOptions): Promise<void> {
  const dbPath = getDbPath(options.db);

  if (!existsSync(dbPath)) {
    console.error(chalk.red(`Knowledge base "${options.db}" not found.`));
    process.exit(1);
  }

  const store = new Store();
  await store.open(dbPath);

  try {
    const existing = await store.getSource(source);

    if (!existing) {
      console.error(chalk.red(`Source not found: ${source}`));
      process.exit(1);
    }

    // Confirm unless --yes
    if (!options.yes) {
      const confirmed = await confirm(`Remove "${source}" from the index?`);
      if (!confirmed) {
        console.log("Cancelled.");
        return;
      }
    }

    await store.removeSource(existing.id);
    console.log(chalk.green(`✓ Removed ${source}`));
  } finally {
    await store.close();
  }
}

function confirm(question: string): Promise<boolean> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}