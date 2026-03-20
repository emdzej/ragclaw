import chalk from "chalk";
import type { EmbedderPreset } from "@emdzej/ragclaw-core";
import {
  listPresets,
  resolvePreset,
  getConfig,
  checkSystemRequirements,
} from "@emdzej/ragclaw-core";
import { PluginLoader } from "../plugins/loader.js";

function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / 1024 ** 2;
  return `${mb.toFixed(0)} MB`;
}

function statusBadge(preset: EmbedderPreset): string {
  const sysCheck = checkSystemRequirements(preset);
  if (!sysCheck.canRun) return chalk.red("✗ insufficient RAM");
  if (sysCheck.warnings.length > 0) return chalk.yellow("⚠ may be slow");
  return chalk.green("✓ ok");
}

export async function embedderList(): Promise<void> {
  const config = getConfig();

  // Determine the currently-configured embedder identifier for marking it
  const current =
    typeof config.embedder === "string"
      ? config.embedder
      : config.embedder?.model ?? config.embedder?.plugin ?? null;

  // ── Built-in presets ──────────────────────────────────────────────────────
  const aliases = listPresets();

  console.log(chalk.bold("Built-in presets:"));
  console.log();

  const aliasW = Math.max(...aliases.map((a) => a.length), 5);
  const modelW = Math.max(
    ...aliases.map((a) => resolvePreset(a)!.model.length),
    5
  );

  const header = [
    "  ",
    "Alias".padEnd(aliasW + 2),
    "Model".padEnd(modelW + 2),
    "Dims".padEnd(6),
    "RAM".padEnd(10),
    "Status",
  ].join("");
  console.log(chalk.dim(header));
  console.log(chalk.dim("  " + "─".repeat(header.length - 2)));

  for (const alias of aliases) {
    const preset = resolvePreset(alias)!;
    const isCurrent = alias === current || preset.model === current;
    const marker = isCurrent ? chalk.cyan("*") : " ";
    const aliasCol = chalk.cyan(alias.padEnd(aliasW + 2));
    const modelCol = preset.model.padEnd(modelW + 2);
    const dimCol = (preset.dim ? String(preset.dim) : "auto").padEnd(6);
    const ramCol = (preset.estimatedRAM ? `~${formatBytes(preset.estimatedRAM)}` : "—").padEnd(10);
    const status = statusBadge(preset);

    console.log(`  ${marker} ${aliasCol}${modelCol}${dimCol}${ramCol}${status}`);
  }

  // ── Plugin-provided embedders ─────────────────────────────────────────────
  const pluginLoader = new PluginLoader({
    enabledPlugins: config.enabledPlugins,
    scanGlobalNpm: config.scanGlobalNpm,
    config: config.pluginConfig,
  });
  await pluginLoader.loadAll();
  const pluginEmbedders = pluginLoader.getEmbedders();

  console.log();

  if (pluginEmbedders.length === 0) {
    console.log(chalk.dim("No plugin-provided embedders found."));
  } else {
    console.log(chalk.bold("Plugin embedders:"));
    console.log();

    const nameW = Math.max(...pluginEmbedders.map((e) => e.embedder.name.length), 4);
    const pluginW = Math.max(...pluginEmbedders.map((e) => e.pluginName.length), 6);

    const ph = [
      "  ",
      "Name".padEnd(nameW + 2),
      "Plugin".padEnd(pluginW + 2),
      "Dims",
    ].join("");
    console.log(chalk.dim(ph));
    console.log(chalk.dim("  " + "─".repeat(ph.length - 2)));

    for (const { pluginName, embedder } of pluginEmbedders) {
      const isCurrent = embedder.name === current || pluginName === current;
      const marker = isCurrent ? chalk.cyan("*") : " ";
      const nameCol = chalk.cyan(embedder.name.padEnd(nameW + 2));
      const pluginCol = pluginName.padEnd(pluginW + 2);
      const dimCol = embedder.dimensions > 0 ? String(embedder.dimensions) : "auto";

      console.log(`  ${marker} ${nameCol}${pluginCol}${dimCol}`);
    }
  }

  console.log();
  console.log(chalk.dim("* = currently configured    Use -e/--embedder <alias> to select."));
}
