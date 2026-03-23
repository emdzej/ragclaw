/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { createEmbedder, IndexingService } from "@emdzej/ragclaw-core";
import chalk from "chalk";
import { getConfig } from "../config.js";
import { PluginLoader } from "../plugins/loader.js";

interface ChunkersListOptions {
  json?: boolean;
}

export async function chunkersList(options: ChunkersListOptions): Promise<void> {
  const config = getConfig();

  // Load plugins to include plugin-provided chunkers in the list
  const pluginLoader = new PluginLoader({
    enabledPlugins: config.enabledPlugins,
    scanGlobalNpm: config.scanGlobalNpm,
    config: config.pluginConfig,
  });
  await pluginLoader.loadAll();

  const indexingService = new IndexingService({
    extraChunkers: pluginLoader.getChunkers(),
    extractorLimits: config.extractorLimits,
    embedder: createEmbedder(),
  });

  const chunkers = indexingService.listChunkers();

  if (options.json) {
    process.stdout.write(`${JSON.stringify(chunkers, null, 2)}\n`);
    return;
  }

  console.log(chalk.bold(`Available chunkers (${chunkers.length}):\n`));

  for (const c of chunkers) {
    const sourceLabel = c.source === "plugin" ? chalk.cyan("[plugin]") : chalk.dim("[built-in]");
    const handlesLabel =
      c.handles.length === 1 && c.handles[0] === "*"
        ? chalk.dim("all content types")
        : c.handles.join(", ");

    console.log(`  ${chalk.green(c.name)} ${sourceLabel}`);
    console.log(`    ${c.description}`);
    console.log(`    ${chalk.dim("handles:")} ${handlesLabel}`);
    console.log();
  }
}
