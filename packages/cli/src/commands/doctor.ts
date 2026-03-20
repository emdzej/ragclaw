import os from "os";
import chalk from "chalk";
import { listPresets, resolvePreset, getConfig } from "@emdzej/ragclaw-core";
import { PluginLoader } from "../plugins/loader.js";

function formatBytes(bytes: number): string {
  const gb = bytes / (1024 ** 3);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 ** 2);
  return `${mb.toFixed(0)} MB`;
}

export async function doctorCommand(): Promise<void> {
  const config = getConfig();

  // ── System info ────────────────────────────────────────────────────────────
  const totalRAM = os.totalmem();
  const freeRAM = os.freemem();
  const nodeVersion = process.version;

  console.log(chalk.bold("System Check:"));
  console.log(`  RAM:   ${formatBytes(totalRAM)} total, ${formatBytes(freeRAM)} available`);
  console.log(`  Node:  ${nodeVersion}`);
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

    let status: string;
    if (ram > 0 && freeRAM < ram * 1.2) {
      status = chalk.red("ERROR  insufficient RAM");
    } else if (ram > 0 && freeRAM < ram * 2.0) {
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
