/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename } from "node:path";
import chalk from "chalk";
import { getDataDir } from "../config.js";

interface DbListOptions {
  json?: boolean;
}

export async function dbList(options: DbListOptions): Promise<void> {
  const dataDir = getDataDir();

  if (!existsSync(dataDir)) {
    if (options.json) {
      console.log(JSON.stringify([]));
    } else {
      console.log(chalk.dim("No knowledge bases found."));
    }
    return;
  }

  let entries: string[];
  try {
    entries = await readdir(dataDir);
  } catch {
    if (options.json) {
      console.log(JSON.stringify([]));
    } else {
      console.log(chalk.dim("No knowledge bases found."));
    }
    return;
  }

  const names = entries
    .filter((f) => f.endsWith(".sqlite"))
    .map((f) => basename(f, ".sqlite"))
    .sort();

  if (options.json) {
    console.log(JSON.stringify(names));
    return;
  }

  if (names.length === 0) {
    console.log(chalk.dim("No knowledge bases found."));
    return;
  }

  console.log(chalk.bold("Knowledge bases:"));
  console.log();
  for (const name of names) {
    console.log(`  ${chalk.cyan(name)}`);
  }
  console.log();
}
