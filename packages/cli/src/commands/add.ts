/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { existsSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import type { RagclawConfig, Source } from "@emdzej/ragclaw-core";
import {
  checkSystemRequirements,
  createEmbedder,
  IndexingService,
  isPathAllowed,
  isUrlAllowed,
  resolvePreset,
  Store,
} from "@emdzej/ragclaw-core";
import chalk from "chalk";
import ora from "ora";
import { ensureDataDir, getConfig, getDbPath } from "../config.js";
import { PluginLoader } from "../plugins/loader.js";

interface AddOptions {
  db: string;
  type: string;
  recursive: boolean;
  include?: string;
  exclude?: string;
  /** Embedder preset alias or HuggingFace model ID (e.g. "bge", "nomic"). */
  embedder?: string;
  /** Chunker override for this invocation (e.g. "sentence", "fixed"). */
  chunker?: string;
  /** Override chunkSize for the selected chunker. */
  chunkSize?: string;
  /** Override overlap for the selected chunker. */
  overlap?: string;
  // Security guard overrides (from CLI flags)
  allowedPaths?: string;
  maxDepth?: string;
  maxFiles?: string;
  allowUrls?: boolean;
  blockPrivateUrls?: boolean;
  enforceGuards?: boolean;
  // Crawl options
  crawl?: boolean;
  crawlMaxDepth?: string;
  crawlMaxPages?: string;
  crawlSameOrigin?: boolean;
  crawlInclude?: string;
  crawlExclude?: string;
  crawlConcurrency?: string;
  crawlDelay?: string;
  ignoreRobots?: boolean;
}

/**
 * Build a `Partial<RagclawConfig>` from the CLI flags that were actually
 * passed.  Only keys whose flags are present are included — this ensures
 * `getConfig(overrides)` only overrides what the user explicitly set.
 */
function buildOverrides(options: AddOptions): Partial<RagclawConfig> | undefined {
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
  if (options.maxDepth !== undefined) {
    const n = parseInt(options.maxDepth, 10);
    if (Number.isFinite(n) && n > 0) {
      o.maxDepth = n;
      hasAny = true;
    }
  }
  if (options.maxFiles !== undefined) {
    const n = parseInt(options.maxFiles, 10);
    if (Number.isFinite(n) && n > 0) {
      o.maxFiles = n;
      hasAny = true;
    }
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

export async function addCommand(source: string, options: AddOptions): Promise<void> {
  const overrides = buildOverrides(options);
  const config = getConfig(overrides);
  const dbPath = getDbPath(options.db);

  // Auto-create database if it doesn't exist
  if (!existsSync(dbPath)) {
    ensureDataDir();
    console.log(chalk.dim(`Creating knowledge base "${options.db}"...`));
  }

  const store = new Store();
  await store.open(dbPath);

  const spinner = ora("Loading embedding model...").start();

  // Load plugins (only those explicitly enabled in config)
  const pluginLoader = new PluginLoader({
    enabledPlugins: config.enabledPlugins,
    scanGlobalNpm: config.scanGlobalNpm,
    config: config.pluginConfig,
  });
  await pluginLoader.loadAll();
  const pluginExtractors = pluginLoader.getExtractors();

  // Resolve embedder: CLI flag > config file > plugin-provided > default (nomic)
  // Resolution order (Phase 6 spec):
  //   1. --embedder CLI flag (alias or HF model)
  //   2. config file `embedder:` field (string alias only)
  //   3. plugin-provided embedder (first one wins)
  //   4. default: nomic
  const pluginEmbedder = pluginLoader.getEmbedder();
  const embedderAlias =
    options.embedder ?? (typeof config.embedder === "string" ? config.embedder : undefined);

  const onProgress = (p: number) => {
    spinner.text = `Downloading model... ${Math.round(p * 100)}%`;
  };
  const embedder = embedderAlias
    ? createEmbedder({ alias: embedderAlias, onProgress })
    : (pluginEmbedder ?? createEmbedder({ onProgress }));

  // System requirements check (RAM) for known presets
  const presetAlias = embedderAlias ?? "nomic";
  const preset = resolvePreset(presetAlias);
  if (preset) {
    const sysCheck = checkSystemRequirements(preset);
    if (sysCheck.errors.length > 0) {
      spinner.fail("System requirements not met");
      console.error(chalk.red(sysCheck.errors[0]));
      await store.close();
      process.exit(1);
    }
    if (sysCheck.warnings.length > 0) {
      spinner.warn(chalk.yellow(sysCheck.warnings[0]));
    }
  }

  // Create the indexing service — owns extractors, chunkers, embedder
  const indexingService = new IndexingService({
    extraExtractors: pluginExtractors,
    extraChunkers: pluginLoader.getChunkers(),
    extractorLimits: config.extractorLimits,
    embedder,
    chunkerStrategy: options.chunker ?? "auto",
    chunkerOverrides: config.chunking?.overrides,
    chunkerDefaults: {
      chunkSize:
        options.chunkSize !== undefined
          ? parseInt(options.chunkSize, 10)
          : config.chunking?.defaults?.chunkSize,
      overlap:
        options.overlap !== undefined
          ? parseInt(options.overlap, 10)
          : config.chunking?.defaults?.overlap,
    },
  });

  try {
    await indexingService.init();
    spinner.succeed("Model loaded");
  } catch (error) {
    spinner.fail("Failed to load model");
    throw error;
  }

  try {
    // -------------------------------------------------------------------------
    // Crawl mode: follow links from a seed URL
    // -------------------------------------------------------------------------
    if (options.crawl) {
      if (!source.includes("://")) {
        console.error(chalk.red("--crawl requires a URL source (e.g. https://docs.example.com)"));
        await store.close();
        process.exit(1);
      }

      if (config.enforceGuards) {
        const urlCheck = await isUrlAllowed(source, config);
        if (!urlCheck.allowed) {
          console.error(chalk.red(`Blocked: ${urlCheck.reason}`));
          await store.close();
          process.exit(1);
        }
      }

      const crawlMaxDepth =
        options.crawlMaxDepth !== undefined ? parseInt(options.crawlMaxDepth, 10) : undefined;
      const crawlMaxPages =
        options.crawlMaxPages !== undefined ? parseInt(options.crawlMaxPages, 10) : undefined;
      const crawlConcurrency =
        options.crawlConcurrency !== undefined ? parseInt(options.crawlConcurrency, 10) : undefined;
      const crawlDelay =
        options.crawlDelay !== undefined ? parseInt(options.crawlDelay, 10) : undefined;
      const crawlInclude = options.crawlInclude
        ? options.crawlInclude
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;
      const crawlExclude = options.crawlExclude
        ? options.crawlExclude
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;

      console.log(chalk.dim(`Crawling ${source}...`));

      let indexed = 0;

      const crawlSpinner = ora("Crawling...").start();

      const summary = await indexingService.indexCrawl(store, source, {
        maxDepth: crawlMaxDepth,
        maxPages: crawlMaxPages,
        sameOrigin: options.crawlSameOrigin,
        include: crawlInclude,
        exclude: crawlExclude,
        concurrency: crawlConcurrency,
        delayMs: crawlDelay,
        ignoreRobots: options.ignoreRobots,
        onPage: ({ url, outcome }) => {
          switch (outcome.status) {
            case "indexed":
              indexed++;
              crawlSpinner.text = `Crawled ${indexed} pages — ${url}`;
              break;
            case "error":
              crawlSpinner.text = `Error on ${url}: ${outcome.error}`;
              break;
          }
        },
      });

      crawlSpinner.succeed(`Crawl complete`);
      console.log();
      console.log(
        chalk.green(`✓ Indexed ${summary.indexed} page(s), ${summary.totalChunks} chunks`)
      );
      if (summary.skipped > 0) console.log(chalk.dim(`  Skipped: ${summary.skipped}`));
      if (summary.errors > 0) console.log(chalk.yellow(`  Errors:  ${summary.errors}`));

      return;
    }

    // -------------------------------------------------------------------------
    // Normal mode: file / directory / single URL
    // -------------------------------------------------------------------------
    const sources = await collectSources(source, options, config);

    // Let plugins expand compound sources (e.g. vault URL → individual notes)
    const expandedSources: Source[] = [];
    for (const src of sources) {
      const expanded = await pluginLoader.expandSource(src);
      if (expanded) {
        expandedSources.push(...expanded);
      } else {
        expandedSources.push(src);
      }
    }

    console.log(chalk.dim(`Found ${expandedSources.length} source(s) to process`));

    let totalChunks = 0;
    let indexed = 0;

    for (const src of expandedSources) {
      const displayPath =
        src.type === "url" ? src.url : src.type === "file" ? src.path : (src.name ?? "inline");
      const fileSpinner = ora(`Processing ${displayPath}`).start();

      try {
        // Guard enforcement (when enabled)
        if (config.enforceGuards) {
          if (src.type === "url") {
            const urlCheck = await isUrlAllowed(src.url, config);
            if (!urlCheck.allowed) {
              fileSpinner.warn(`Blocked: ${urlCheck.reason}`);
              continue;
            }
          } else if (src.type === "file") {
            const pathCheck = isPathAllowed(src.path, config);
            if (!pathCheck.allowed) {
              fileSpinner.warn(`Blocked: ${pathCheck.reason}`);
              continue;
            }
          }
        }

        const outcome = await indexingService.indexSource(store, src);

        switch (outcome.status) {
          case "indexed":
            totalChunks += outcome.chunks;
            indexed++;
            fileSpinner.succeed(`Indexed ${displayPath} (${outcome.chunks} chunks)`);
            break;
          case "unchanged":
            fileSpinner.info(`Skipping ${displayPath} (unchanged)`);
            break;
          case "skipped":
            fileSpinner.warn(`Skipping ${displayPath} (${outcome.reason})`);
            break;
          case "error":
            fileSpinner.fail(`Failed to process ${displayPath}: ${outcome.error}`);
            break;
        }
      } catch (error) {
        fileSpinner.fail(`Failed to process ${displayPath}: ${error}`);
      }
    }

    console.log();
    console.log(chalk.green(`✓ Indexed ${indexed} source(s), ${totalChunks} chunks`));
  } finally {
    await store.close();
  }
}

async function collectSources(
  source: string,
  options: AddOptions,
  config: RagclawConfig
): Promise<Source[]> {
  const resolved = resolve(source);

  if (!existsSync(resolved)) {
    // Check if it's a URL (http/https or custom scheme)
    if (source.includes("://")) {
      return [{ type: "url", url: source }];
    }
    throw new Error(`Source not found: ${source}`);
  }

  const stats = statSync(resolved);

  if (stats.isFile()) {
    return [{ type: "file", path: resolved }];
  }

  if (stats.isDirectory() && options.recursive) {
    return collectFilesRecursive(resolved, options, config);
  }

  return [];
}

async function collectFilesRecursive(
  dir: string,
  options: AddOptions,
  config: RagclawConfig,
  depth: number = 0,
  collected: Source[] = []
): Promise<Source[]> {
  // Enforce maxDepth when guards are active
  if (config.enforceGuards && depth >= config.maxDepth) {
    return collected;
  }

  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    // Enforce maxFiles when guards are active
    if (config.enforceGuards && collected.length >= config.maxFiles) {
      return collected;
    }

    const fullPath = join(dir, entry.name);

    // Skip hidden files and common excludes
    if (entry.name.startsWith(".")) continue;
    if (entry.name === "node_modules") continue;
    if (options.exclude && entry.name.match(new RegExp(options.exclude))) continue;

    if (entry.isDirectory()) {
      await collectFilesRecursive(fullPath, options, config, depth + 1, collected);
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase();

      // Check include pattern
      if (options.include && !entry.name.match(new RegExp(options.include))) {
        continue;
      }

      // Only include supported extensions
      const supportedExts = [
        ".md",
        ".markdown",
        ".mdx",
        ".txt",
        ".text",
        ".pdf",
        ".docx",
        ".ts",
        ".tsx",
        ".js",
        ".jsx",
        ".mjs",
        ".cjs",
        ".py",
        ".go",
        ".java",
        ".png",
        ".jpg",
        ".jpeg",
        ".gif",
        ".webp",
        ".bmp",
        ".tiff",
        ".tif",
      ];
      if (supportedExts.includes(ext)) {
        collected.push({ type: "file", path: fullPath });
      }
    }
  }

  return collected;
}
