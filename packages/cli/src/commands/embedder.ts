/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import type { EmbedderPreset } from "@emdzej/ragclaw-core";
import {
  checkSystemRequirements,
  createEmbedder,
  getConfig,
  getModelCacheDir,
  isModelCached,
  listPresets,
  resolvePreset,
} from "@emdzej/ragclaw-core";
import chalk from "chalk";
import ora from "ora";
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
      : (config.embedder?.model ?? config.embedder?.plugin ?? null);

  // ── Built-in presets ──────────────────────────────────────────────────────
  const aliases = listPresets();

  console.log(chalk.bold("Built-in presets:"));
  console.log();

  const aliasW = Math.max(...aliases.map((a) => a.length), 5);
  const modelW = Math.max(...aliases.map((a) => resolvePreset(a)?.model.length ?? 0), 5);

  const header = [
    "  ",
    "Alias".padEnd(aliasW + 2),
    "Model".padEnd(modelW + 2),
    "Dims".padEnd(6),
    "RAM".padEnd(10),
    "Status",
  ].join("");
  console.log(chalk.dim(header));
  console.log(chalk.dim(`  ${"─".repeat(header.length - 2)}`));

  for (const alias of aliases) {
    const preset = resolvePreset(alias);
    if (!preset) continue;
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

    const ph = ["  ", "Name".padEnd(nameW + 2), "Plugin".padEnd(pluginW + 2), "Dims"].join("");
    console.log(chalk.dim(ph));
    console.log(chalk.dim(`  ${"─".repeat(ph.length - 2)}`));

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

// ─── embedder download ────────────────────────────────────────────────────────

interface DownloadResult {
  name: string;
  modelId: string;
  skipped: boolean;
  error?: string;
}

/**
 * Download a single built-in preset (or arbitrary HF model ID).
 * Returns a DownloadResult indicating whether it was already cached, newly
 * downloaded, or failed.
 */
async function downloadBuiltin(alias: string, modelId: string): Promise<DownloadResult> {
  const alreadyCached = isModelCached(modelId);

  if (alreadyCached) {
    return { name: alias, modelId, skipped: true };
  }

  const spinner = ora(`  Downloading ${chalk.cyan(alias)} (${modelId})...`).start();
  let lastPct = 0;

  try {
    const embedder = createEmbedder({
      alias: resolvePreset(alias) ? alias : undefined,
      model: resolvePreset(alias) ? undefined : modelId,
      onProgress: (p) => {
        const pct = Math.round(p * 100);
        if (pct !== lastPct) {
          lastPct = pct;
          spinner.text = `  Downloading ${chalk.cyan(alias)} (${modelId})... ${pct}%`;
        }
      },
    });
    await embedder.init?.();
    await embedder.dispose?.();
    spinner.succeed(`  ${chalk.green("✓")} ${chalk.cyan(alias)} (${modelId})`);
    return { name: alias, modelId, skipped: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    spinner.fail(`  ${chalk.red("✗")} ${chalk.cyan(alias)} — ${msg}`);
    return { name: alias, modelId, skipped: false, error: msg };
  }
}

/**
 * Download a plugin-provided embedder.
 * Plugin owns the download logic via its `init()` method.  If the plugin
 * embedder's `name` looks like a HuggingFace model ID (`org/model`) we can
 * also check the local cache first.
 */
async function downloadPlugin(
  pluginName: string,
  embedder: {
    name: string;
    dimensions: number;
    init?: () => Promise<void>;
    dispose?: () => Promise<void>;
  }
): Promise<DownloadResult> {
  const modelId = embedder.name;
  const looksLikeHfModel = modelId.includes("/");

  if (looksLikeHfModel && isModelCached(modelId)) {
    return { name: `${pluginName}/${modelId}`, modelId, skipped: true };
  }

  const label = `${pluginName}/${chalk.cyan(modelId)}`;
  const spinner = ora(`  Downloading plugin embedder ${label}...`).start();

  try {
    await embedder.init?.();
    await embedder.dispose?.();
    spinner.succeed(`  ${chalk.green("✓")} ${label}`);
    return { name: `${pluginName}/${modelId}`, modelId, skipped: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    spinner.fail(`  ${chalk.red("✗")} ${label} — ${msg}`);
    return { name: `${pluginName}/${modelId}`, modelId, skipped: false, error: msg };
  }
}

interface DownloadOptions {
  /** If true, download all built-in presets and all plugin embedders. */
  all?: boolean;
}

/**
 * `ragclaw embedder download [name]`
 *
 * Downloads one or all embedding models to the local cache so that
 * subsequent offline use does not require a network connection.
 *
 * - With no argument / `--all`: downloads every built-in preset AND every
 *   plugin-provided embedder (if it exposes an `init()` hook).
 * - With a name: downloads that specific preset alias, HuggingFace model ID,
 *   or plugin embedder by name.
 *
 * Models that are already cached are silently skipped.
 */
export async function embedderDownload(
  name: string | undefined,
  options: DownloadOptions
): Promise<void> {
  const config = getConfig();
  const cacheDir = getModelCacheDir();

  console.log(chalk.dim(`Cache: ${cacheDir}`));
  console.log();

  // Load plugins so we can discover plugin-provided embedders
  const pluginLoader = new PluginLoader({
    enabledPlugins: config.enabledPlugins,
    scanGlobalNpm: config.scanGlobalNpm,
    config: config.pluginConfig,
  });
  await pluginLoader.loadAll();
  const pluginEmbedders = pluginLoader.getEmbedders();

  const results: DownloadResult[] = [];

  // ── Resolve what to download ─────────────────────────────────────────────

  const downloadAll = options.all || name === undefined;

  if (downloadAll) {
    // Download all built-in presets
    console.log(chalk.bold("Built-in presets:"));
    for (const alias of listPresets()) {
      const preset = resolvePreset(alias);
      if (!preset) continue;
      results.push(await downloadBuiltin(alias, preset.model));
    }

    // Download all plugin embedders
    if (pluginEmbedders.length > 0) {
      console.log();
      console.log(chalk.bold("Plugin embedders:"));
      for (const { pluginName, embedder } of pluginEmbedders) {
        results.push(await downloadPlugin(pluginName, embedder));
      }
    }
  } else {
    // Single target — could be a preset alias, HF model ID, or plugin embedder name
    // name is always defined here: downloadAll is only false when name !== undefined
    if (name === undefined) {
      throw new Error("Expected a name argument");
    }
    const preset = resolvePreset(name);

    if (preset) {
      // Known preset alias
      console.log(chalk.bold("Built-in preset:"));
      results.push(await downloadBuiltin(name, preset.model));
    } else {
      // Check if it matches a plugin embedder name or plugin name
      const matched = pluginEmbedders.find(
        ({ pluginName, embedder }) => embedder.name === name || pluginName === name
      );

      if (matched) {
        console.log(chalk.bold("Plugin embedder:"));
        results.push(await downloadPlugin(matched.pluginName, matched.embedder));
      } else {
        // Treat as a raw HuggingFace model ID
        console.log(chalk.bold("Model:"));
        results.push(await downloadBuiltin(name, name));
      }
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────

  console.log();

  const downloaded = results.filter((r) => !r.skipped && !r.error);
  const skipped = results.filter((r) => r.skipped);
  const failed = results.filter((r) => r.error);

  if (downloaded.length > 0) {
    console.log(chalk.green(`Downloaded: ${downloaded.length}`));
  }
  if (skipped.length > 0) {
    console.log(chalk.dim(`Already cached: ${skipped.length}`));
    for (const r of skipped) {
      console.log(chalk.dim(`  ✓ ${r.name}`));
    }
  }
  if (failed.length > 0) {
    console.log(chalk.red(`Failed: ${failed.length}`));
    process.exit(1);
  }
}
