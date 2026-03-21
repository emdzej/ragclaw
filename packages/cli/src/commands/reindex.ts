import { existsSync } from "fs";
import ora from "ora";
import chalk from "chalk";
import {
  Store,
  IndexingService,
  isPathAllowed,
  isUrlAllowed,
  createEmbedder,
  resolvePreset,
  checkSystemRequirements,
} from "@emdzej/ragclaw-core";
import type { RagclawConfig } from "@emdzej/ragclaw-core";
import { getDbPath, getConfig } from "../config.js";
import { PluginLoader } from "../plugins/loader.js";
import { resolve } from "path";

interface ReindexOptions {
  db: string;
  force?: boolean;
  prune?: boolean;
  /** Embedder preset alias or HuggingFace model ID (e.g. "bge", "nomic"). */
  embedder?: string;
  // Security guard overrides (from CLI flags)
  allowedPaths?: string;
  allowUrls?: boolean;
  blockPrivateUrls?: boolean;
  enforceGuards?: boolean;
}

interface ReindexResult {
  updated: number;
  unchanged: number;
  removed: number;
  blocked: number;
  errors: string[];
}

/**
 * Build a `Partial<RagclawConfig>` from the CLI flags that were actually
 * passed.  Only keys whose flags are present are included.
 */
function buildOverrides(options: ReindexOptions): Partial<RagclawConfig> | undefined {
  const o: Partial<RagclawConfig> = {};
  let hasAny = false;

  if (options.allowedPaths !== undefined) {
    o.allowedPaths = options.allowedPaths
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((p) => resolve(p));
    hasAny = true;
  }
  if (options.allowUrls !== undefined) {
    o.allowUrls = options.allowUrls;
    hasAny = true;
  }
  if (options.blockPrivateUrls !== undefined) {
    o.blockPrivateUrls = options.blockPrivateUrls;
    hasAny = true;
  }
  if (options.enforceGuards !== undefined) {
    o.enforceGuards = options.enforceGuards;
    hasAny = true;
  }

  return hasAny ? o : undefined;
}

export async function reindex(options: ReindexOptions): Promise<void> {
  const overrides = buildOverrides(options);
  const config = getConfig(overrides);
  const dbPath = getDbPath(options.db);

  if (!existsSync(dbPath)) {
    console.log(chalk.red(`Knowledge base "${options.db}" not found.`));
    console.log(chalk.dim(`Run: ragclaw add <source> -d ${options.db}`));
    return;
  }

  const spinner = ora("Loading knowledge base...").start();

  const store = new Store();
  await store.open(dbPath);

  try {
    const sources = await store.listSources();

    if (sources.length === 0) {
      spinner.info("No sources to reindex.");
      return;
    }

    spinner.text = "Loading embedding model...";

    // Load plugins (for plugin-provided embedder support)
    const pluginLoader = new PluginLoader({
      enabledPlugins: config.enabledPlugins,
      scanGlobalNpm: config.scanGlobalNpm,
      config: config.pluginConfig,
    });
    await pluginLoader.loadAll();

    // Resolve embedder priority:
    //   1. Explicit CLI flag (-e / --embedder)
    //   2. Plugin-provided embedder
    //   3. Embedder stored in DB metadata (set at index time) — avoids mismatch
    //      between the global config default and what was actually used to build
    //      the existing vectors.
    //   4. Global config default / nomic
    const pluginEmbedder = pluginLoader.getEmbedder();

    let embedderAlias: string | undefined;
    let embedderModel: string | undefined;

    if (options.embedder) {
      // Explicit flag: treat as alias first, then as raw model ID
      embedderAlias = options.embedder;
    } else if (!pluginEmbedder) {
      // No explicit flag, no plugin — read from DB metadata so we keep using
      // the same model that produced the stored vectors.
      const storedModel = await store.getMeta("embedder_model");
      const storedName = await store.getMeta("embedder_name");
      if (storedModel) {
        embedderModel = storedModel;
      } else if (storedName) {
        embedderAlias = storedName;
      }
      // If nothing is stored yet (empty/new DB), fall through to createEmbedder()
      // default (nomic).
    }

    const onProgress = (p: number) => { spinner.text = `Downloading model... ${Math.round(p * 100)}%`; };
    const embedder = embedderAlias
      ? createEmbedder({ alias: embedderAlias, onProgress })
      : embedderModel
        ? createEmbedder({ model: embedderModel, onProgress })
        : pluginEmbedder
          ?? createEmbedder({ onProgress });

    // System requirements check (RAM) for known presets.
    // resolvePreset returns null for raw model IDs, so the check is safely skipped.
    const presetAlias = embedderAlias ?? embedderModel ?? "nomic";
    const preset = resolvePreset(presetAlias);
    if (preset) {
      const sysCheck = checkSystemRequirements(preset);
      if (sysCheck.errors.length > 0) {
        spinner.fail("System requirements not met");
        console.error(chalk.red(sysCheck.errors[0]));
        await store.close();
        return;
      }
      if (sysCheck.warnings.length > 0) {
        spinner.warn(chalk.yellow(sysCheck.warnings[0]));
      }
    }

    const indexingService = new IndexingService({
      extractorLimits: config.extractorLimits,
      embedder,
    });
    await indexingService.init();
    spinner.succeed("Model loaded");

    const result: ReindexResult = {
      updated: 0,
      unchanged: 0,
      removed: 0,
      blocked: 0,
      errors: [],
    };

    for (const source of sources) {
      const displayPath = source.path.length > 60
        ? "..." + source.path.slice(-57)
        : source.path;

      spinner.text = `Checking ${displayPath}`;

      try {
        // Guard enforcement (when enabled)
        if (config.enforceGuards) {
          const isUrl = source.type === "url";
          if (isUrl) {
            if (!config.allowUrls) {
              result.blocked++;
              console.log(chalk.yellow(`⊘ Blocked (URLs disabled): ${displayPath}`));
              continue;
            }
            const urlCheck = await isUrlAllowed(source.path, config);
            if (!urlCheck.allowed) {
              result.blocked++;
              console.log(chalk.yellow(`⊘ Blocked: ${urlCheck.reason}`));
              continue;
            }
          } else {
            const pathCheck = isPathAllowed(source.path, config);
            if (!pathCheck.allowed) {
              result.blocked++;
              console.log(chalk.yellow(`⊘ Blocked: ${pathCheck.reason}`));
              continue;
            }
          }
        }

        const outcome = await indexingService.reindexSource(store, source, {
          force: options.force,
          prune: options.prune,
        });

        switch (outcome.status) {
          case "updated":
            result.updated++;
            console.log(chalk.green(`✔ Updated: ${displayPath} (${outcome.chunks} chunks)`));
            break;
          case "unchanged":
            result.unchanged++;
            break;
          case "removed":
            result.removed++;
            console.log(chalk.yellow(`✗ Removed (not found): ${displayPath}`));
            break;
          case "missing":
            console.log(chalk.dim(`⊘ Missing: ${displayPath}`));
            break;
          case "skipped":
            console.log(chalk.dim(`⊘ Skipped: ${displayPath} (${outcome.reason})`));
            break;
          case "error":
            result.errors.push(`${displayPath}: ${outcome.error}`);
            console.log(chalk.red(`✖ Error: ${displayPath}`));
            break;
        }
      } catch (err) {
        result.errors.push(`${displayPath}: ${err}`);
        console.log(chalk.red(`✖ Error: ${displayPath}`));
      }
    }

    spinner.stop();

    // Summary
    console.log("");
    console.log(chalk.bold("Reindex complete:"));
    console.log(`  ${chalk.green("Updated:")} ${result.updated}`);
    console.log(`  ${chalk.dim("Unchanged:")} ${result.unchanged}`);
    if (result.removed > 0) {
      console.log(`  ${chalk.yellow("Removed:")} ${result.removed}`);
    }
    if (result.blocked > 0) {
      console.log(`  ${chalk.yellow("Blocked:")} ${result.blocked}`);
    }
    if (result.errors.length > 0) {
      console.log(`  ${chalk.red("Errors:")} ${result.errors.length}`);
      for (const err of result.errors.slice(0, 5)) {
        console.log(chalk.red(`    ${err}`));
      }
      if (result.errors.length > 5) {
        console.log(chalk.dim(`    ... and ${result.errors.length - 5} more`));
      }
    }

  } finally {
    await store.close();
  }
}
