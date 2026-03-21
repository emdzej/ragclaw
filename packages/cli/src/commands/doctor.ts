/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import os from "os";
import chalk from "chalk";
import { Store, listPresets, resolvePreset, getConfig, checkSystemRequirements, getAvailableMemory } from "@emdzej/ragclaw-core";
import { PluginLoader } from "../plugins/loader.js";

function formatBytes(bytes: number): string {
  const gb = bytes / (1024 ** 3);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 ** 2);
  return `${mb.toFixed(0)} MB`;
}

/**
 * Probe whether sqlite-vec is available and where it comes from.
 * Uses an in-memory Store so it doesn't touch any real knowledge base.
 * We suppress the warning that Store emits when vec is unavailable.
 */
async function checkSqliteVec(): Promise<{ available: boolean; source: "npm" | "system" | null }> {
  // Silence the "sqlite-vec not available" warning — we'll report it ourselves.
  const originalWarn = console.warn;
  console.warn = () => {};

  try {
    const store = new Store();
    await store.open(":memory:");
    const available = store.hasVectorSupport;
    const source = store.vectorExtensionSource;
    await store.close();
    return { available, source };
  } finally {
    console.warn = originalWarn;
  }
}

export async function doctorCommand(): Promise<void> {
  const config = getConfig();

  // ── System info ────────────────────────────────────────────────────────────
  const totalRAM = os.totalmem();
  const availableRAM = getAvailableMemory(); // free + reclaimable cache
  const nodeVersion = process.version;

  console.log(chalk.bold("System Check:"));
  console.log(`  RAM:   ${formatBytes(totalRAM)} total, ${formatBytes(availableRAM)} available ${chalk.dim("(free + reclaimable cache)")}`);
  console.log(`  Node:  ${nodeVersion}`);
  console.log();

  // ── sqlite-vec status ──────────────────────────────────────────────────────
  console.log(chalk.bold("Vector Extension (sqlite-vec):"));
  const vec = await checkSqliteVec();
  if (vec.available) {
    const via = vec.source === "npm" ? "npm package" : "system extension";
    console.log(`  ${chalk.green("✓")} Available  ${chalk.dim(`(loaded via ${via})`)}`);
  } else {
    console.log(`  ${chalk.yellow("!")} Not available — vector search will use a slower JS fallback`);
    console.log(`    ${chalk.dim("To install:")}  npm install sqlite-vec  ${chalk.dim("(or install @emdzej/ragclaw-cli globally)")}`);
  }
  console.log();

  // ── Embedder compatibility ─────────────────────────────────────────────────
  console.log(chalk.bold("Embedder Compatibility:"));

  const aliases = listPresets();
  const maxAliasLen = Math.max(...aliases.map((a) => a.length));

  for (const alias of aliases) {
    const preset = resolvePreset(alias)!;
    const ram = preset.estimatedRAM ?? 0;
    const ramStr = formatBytes(ram);
    const dimStr = preset.dim ? `${preset.dim} dim` : "auto";

    const sysCheck = checkSystemRequirements(preset);
    let status: string;
    if (!sysCheck.canRun) {
      status = chalk.red("ERROR  insufficient RAM");
    } else if (sysCheck.warnings.length > 0) {
      status = chalk.yellow("WARN   may be slow");
    } else {
      status = chalk.green("OK");
    }

    const aliasCol = alias.padEnd(maxAliasLen + 2);
    const ramCol = `(~${ramStr})`.padEnd(12);
    const dimCol = dimStr.padEnd(8);
    console.log(`  ${chalk.cyan(aliasCol)} ${ramCol} ${preset.model.padEnd(48)} ${dimCol}  ${status}`);
  }

  console.log();

  // ── Current config ─────────────────────────────────────────────────────────
  console.log(chalk.bold("Current Config:"));
  const embedderConfig = config.embedder;
  if (typeof embedderConfig === "string") {
    console.log(`  embedder: ${chalk.cyan(embedderConfig)}`);
  } else if (embedderConfig && typeof embedderConfig === "object") {
    console.log(`  embedder: ${chalk.cyan(embedderConfig.model ?? embedderConfig.plugin ?? "(custom)")}`);
  } else {
    console.log(`  embedder: ${chalk.dim("nomic (default)")}`);
  }
  console.log();

  // ── Loaded plugins ─────────────────────────────────────────────────────────
  const pluginLoader = new PluginLoader({
    enabledPlugins: config.enabledPlugins,
    scanGlobalNpm: config.scanGlobalNpm,
    config: config.pluginConfig,
  });
  await pluginLoader.loadAll();
  const plugins = pluginLoader["loadedPlugins"] as Array<{ manifest: { name: string; version: string }; plugin: { embedder?: unknown } }>;

  if (plugins.length > 0) {
    console.log(chalk.bold("Plugins:"));
    for (const { manifest, plugin } of plugins) {
      const embedderNote = plugin.embedder ? chalk.green("(provides embedder)") : chalk.dim("(no embedder)");
      console.log(`  ${manifest.name.padEnd(36)} v${manifest.version}   ${embedderNote}`);
    }
  } else {
    console.log(chalk.dim("No plugins loaded."));
  }
}