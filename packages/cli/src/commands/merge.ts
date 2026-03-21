/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { ConflictResolution, EmbedderPlugin, MergeStrategy } from "@emdzej/ragclaw-core";
import { createEmbedder, getDbPath, MergeService, Store } from "@emdzej/ragclaw-core";
import chalk from "chalk";
import ora from "ora";
import { getConfig } from "../config.js";

interface MergeOptions {
  db: string;
  strategy?: string;
  onConflict?: string;
  dryRun?: boolean;
  include?: string;
  exclude?: string;
  embedder?: string;
}

export async function mergeCommand(sourceDb: string, options: MergeOptions): Promise<void> {
  // Resolve source DB path
  const sourcePath = resolve(sourceDb);
  if (!existsSync(sourcePath)) {
    console.error(chalk.red(`Source database not found: ${sourcePath}`));
    process.exit(1);
  }
  if (!statSync(sourcePath).isFile()) {
    console.error(chalk.red(`Not a file: ${sourcePath}`));
    process.exit(1);
  }

  const config = getConfig();
  const destPath = getDbPath(options.db);

  if (resolve(sourcePath) === resolve(destPath)) {
    console.error(chalk.red("Source and destination databases are the same file."));
    process.exit(1);
  }

  // Validate strategy
  const strategy = (options.strategy ?? "strict") as MergeStrategy;
  if (strategy !== "strict" && strategy !== "reindex") {
    console.error(chalk.red(`Unknown strategy "${strategy}". Use "strict" or "reindex".`));
    process.exit(1);
  }

  // Validate conflict resolution
  const onConflict = (options.onConflict ?? "skip") as ConflictResolution;
  if (!["skip", "prefer-local", "prefer-remote"].includes(onConflict)) {
    console.error(
      chalk.red(
        `Unknown --on-conflict value "${options.onConflict}". Use skip, prefer-local, or prefer-remote.`
      )
    );
    process.exit(1);
  }

  // Auto-create destination DB if needed
  if (!existsSync(destPath)) {
    const { ensureDataDir } = await import("../config.js");
    ensureDataDir();
    console.log(chalk.dim(`Creating knowledge base "${options.db}"...`));
  }

  const destStore = new Store();
  await destStore.open(destPath);

  const spinner = ora(options.dryRun ? "Computing diff..." : "Preparing merge...").start();

  try {
    // For reindex strategy, resolve the embedder
    let embedder: EmbedderPlugin | undefined;
    if (strategy === "reindex") {
      const embedderAlias =
        options.embedder ?? (typeof config.embedder === "string" ? config.embedder : undefined);
      embedder = createEmbedder(embedderAlias ? { alias: embedderAlias } : {});
      spinner.text = "Loading embedding model...";
      await embedder.init?.();
      if (embedder.dimensions === 0) await embedder.embed("warmup");
    }

    const include = options.include
      ? options.include
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    const exclude = options.exclude
      ? options.exclude
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;

    const mergeService = new MergeService();

    // Dry-run: just show the diff
    if (options.dryRun) {
      const diffResult = await mergeService.diff(destStore, sourcePath, include, exclude);
      spinner.succeed("Diff complete");

      console.log();
      console.log(chalk.bold("Merge preview") + chalk.dim(` (${sourcePath} → ${destPath})`));
      console.log();
      console.log(
        `  Embedder match: ${diffResult.embedderMatch ? chalk.green("yes") : chalk.yellow("no")}`
      );
      if (!diffResult.embedderMatch) {
        console.log(`    Local:  ${diffResult.destEmbedder}`);
        console.log(`    Remote: ${diffResult.srcEmbedder}`);
        console.log(chalk.yellow("  Use --strategy=reindex to merge with incompatible embedders."));
      }
      console.log();
      console.log(`  ${chalk.green("Would add:")}    ${diffResult.toAdd.length} source(s)`);
      console.log(
        `  ${chalk.yellow("Would update:")} ${diffResult.toUpdate.length} source(s) (conflict policy: ${onConflict})`
      );
      console.log(
        `  ${chalk.dim("Identical:")}    ${diffResult.identical.length} source(s) — skip`
      );
      console.log(
        `  ${chalk.dim("Local only:")}   ${diffResult.localOnly.length} source(s) — untouched`
      );

      if (diffResult.toAdd.length > 0) {
        console.log();
        console.log(chalk.dim("  Sources to add:"));
        for (const s of diffResult.toAdd.slice(0, 10)) {
          console.log(chalk.dim(`    + ${s.path}`));
        }
        if (diffResult.toAdd.length > 10) {
          console.log(chalk.dim(`    ... and ${diffResult.toAdd.length - 10} more`));
        }
      }

      if (diffResult.toUpdate.length > 0 && onConflict === "prefer-remote") {
        console.log();
        console.log(chalk.dim("  Sources to update (prefer-remote):"));
        for (const s of diffResult.toUpdate.slice(0, 10)) {
          console.log(chalk.dim(`    ~ ${s.path}`));
        }
        if (diffResult.toUpdate.length > 10) {
          console.log(chalk.dim(`    ... and ${diffResult.toUpdate.length - 10} more`));
        }
      }

      return;
    }

    // Real merge
    spinner.text = "Merging...";

    let processed = 0;
    const summary = await mergeService.merge(destStore, sourcePath, {
      strategy,
      onConflict,
      embedder,
      include,
      exclude,
      onProgress: ({ path: p, status, reason }) => {
        processed++;
        switch (status) {
          case "added":
            spinner.text = `[${processed}] Added ${p}`;
            break;
          case "updated":
            spinner.text = `[${processed}] Updated ${p}`;
            break;
          case "error":
            spinner.text = `[${processed}] Error: ${p} — ${reason}`;
            break;
        }
      },
    });

    if (summary.errors.length > 0) {
      spinner.warn("Merge completed with errors");
    } else {
      spinner.succeed("Merge complete");
    }

    console.log();
    console.log(
      chalk.green(
        `✓ Added ${summary.sourcesAdded}, updated ${summary.sourcesUpdated}, skipped ${summary.sourcesSkipped}`
      )
    );

    if (summary.errors.length > 0) {
      console.log();
      console.log(chalk.yellow(`  Errors (${summary.errors.length}):`));
      for (const e of summary.errors.slice(0, 5)) {
        console.log(chalk.yellow(`    ${e.path}: ${e.error}`));
      }
      if (summary.errors.length > 5) {
        console.log(chalk.yellow(`    ... and ${summary.errors.length - 5} more`));
      }
    }
  } finally {
    await destStore.close();
  }
}
