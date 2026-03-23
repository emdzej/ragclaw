/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { existsSync, statSync } from "node:fs";
import { readdir, rename, rm } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { ConflictResolution, EmbedderPlugin, MergeStrategy } from "@emdzej/ragclaw-core";
import {
  createEmbedder,
  getDbPath,
  MergeService,
  Store,
  sanitizeDbName,
} from "@emdzej/ragclaw-core";
import chalk from "chalk";
import ora from "ora";
import { ensureDataDir, getConfig, getDataDir } from "../config.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Parse a comma-separated keywords string into a trimmed, filtered array. */
function parseKeywords(raw: string): string[] {
  return raw
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

/** Read description + keywords from an already-open store. */
async function readDbInfo(
  store: Store
): Promise<{ description: string | null; keywords: string[] }> {
  const description = (await store.getMeta("db_description")) ?? null;
  const keywordsRaw = (await store.getMeta("db_keywords")) ?? "";
  const keywords = keywordsRaw ? parseKeywords(keywordsRaw) : [];
  return { description, keywords };
}

// ---------------------------------------------------------------------------
// db list
// ---------------------------------------------------------------------------

interface DbListOptions {
  json?: boolean;
}

type DbListEntry = {
  name: string;
  description: string | null;
  keywords: string[];
};

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

  if (names.length === 0) {
    if (options.json) {
      console.log(JSON.stringify([]));
    } else {
      console.log(chalk.dim("No knowledge bases found."));
    }
    return;
  }

  // Open each store briefly to read metadata
  const dbEntries: DbListEntry[] = await Promise.all(
    names.map(async (name) => {
      const dbPath = getDbPath(name);
      const store = new Store();
      try {
        await store.open(dbPath);
        const info = await readDbInfo(store);
        return { name, ...info };
      } catch {
        return { name, description: null, keywords: [] };
      } finally {
        await store.close();
      }
    })
  );

  if (options.json) {
    console.log(JSON.stringify(dbEntries));
    return;
  }

  console.log(chalk.bold("Knowledge bases:"));
  console.log();
  for (const entry of dbEntries) {
    const desc = entry.description ? chalk.dim(` — ${entry.description}`) : "";
    const kw = entry.keywords.length > 0 ? chalk.dim(`  [${entry.keywords.join(", ")}]`) : "";
    console.log(`  ${chalk.cyan(entry.name)}${desc}${kw}`);
  }
  console.log();
}

// ---------------------------------------------------------------------------
// db init
// ---------------------------------------------------------------------------

interface DbInitOptions {
  description?: string;
  keywords?: string;
}

export async function dbInit(name: string, options: DbInitOptions = {}): Promise<void> {
  const dbPath = getDbPath(name);

  if (existsSync(dbPath)) {
    console.log(chalk.yellow(`Knowledge base "${name}" already exists at ${dbPath}`));
    return;
  }

  // Create directory if needed
  ensureDataDir();

  // Initialize empty database
  const store = new Store();
  await store.open(dbPath);

  try {
    if (options.description) {
      await store.setMeta("db_description", options.description);
    }
    if (options.keywords) {
      await store.setMeta("db_keywords", options.keywords);
    }
  } finally {
    await store.close();
  }

  console.log(chalk.green(`✓ Created knowledge base "${name}"`));
  console.log(chalk.dim(`  Path: ${dbPath}`));
  if (options.description) {
    console.log(chalk.dim(`  Description: ${options.description}`));
  }
  if (options.keywords) {
    console.log(chalk.dim(`  Keywords: ${options.keywords}`));
  }
  console.log();
  console.log("Next steps:");
  console.log(chalk.cyan(`  ragclaw add ./docs/          # Add a directory`));
  console.log(chalk.cyan(`  ragclaw add https://...      # Add a web page`));
  console.log(chalk.cyan(`  ragclaw search "your query"  # Search`));
}

// ---------------------------------------------------------------------------
// db info get
// ---------------------------------------------------------------------------

interface DbInfoGetOptions {
  db: string;
  json?: boolean;
}

export async function dbInfoGet(options: DbInfoGetOptions): Promise<void> {
  const dbPath = getDbPath(options.db);

  if (!existsSync(dbPath)) {
    console.error(chalk.red(`Knowledge base "${options.db}" not found.`));
    process.exitCode = 1;
    return;
  }

  const store = new Store();
  await store.open(dbPath);

  let info: { description: string | null; keywords: string[] };
  try {
    info = await readDbInfo(store);
  } finally {
    await store.close();
  }

  if (options.json) {
    console.log(JSON.stringify({ name: options.db, ...info }));
    return;
  }

  console.log(chalk.bold(`Knowledge base: ${chalk.cyan(options.db)}`));
  console.log();
  console.log(
    `  Description: ${info.description ? chalk.dim(info.description) : chalk.dim("(not set)")}`
  );
  console.log(
    `  Keywords:    ${info.keywords.length > 0 ? chalk.dim(info.keywords.join(", ")) : chalk.dim("(not set)")}`
  );
  console.log();
}

// ---------------------------------------------------------------------------
// db info set
// ---------------------------------------------------------------------------

interface DbInfoSetOptions {
  db: string;
  description?: string;
  keywords?: string;
}

export async function dbInfoSet(options: DbInfoSetOptions): Promise<void> {
  const dbPath = getDbPath(options.db);

  if (!existsSync(dbPath)) {
    console.error(chalk.red(`Knowledge base "${options.db}" not found.`));
    process.exitCode = 1;
    return;
  }

  if (options.description === undefined && options.keywords === undefined) {
    console.error(chalk.red("Provide at least one of --description or --keywords."));
    process.exitCode = 1;
    return;
  }

  const store = new Store();
  await store.open(dbPath);

  try {
    if (options.description !== undefined) {
      await store.setMeta("db_description", options.description);
    }
    if (options.keywords !== undefined) {
      await store.setMeta("db_keywords", options.keywords);
    }
  } finally {
    await store.close();
  }

  console.log(chalk.green(`✓ Updated info for knowledge base "${options.db}"`));
  if (options.description !== undefined) {
    console.log(chalk.dim(`  Description: ${options.description || "(cleared)"}`));
  }
  if (options.keywords !== undefined) {
    console.log(chalk.dim(`  Keywords: ${options.keywords || "(cleared)"}`));
  }
}

// ---------------------------------------------------------------------------
// db delete
// ---------------------------------------------------------------------------

interface DbDeleteOptions {
  yes?: boolean;
}

export async function dbDelete(name: string, options: DbDeleteOptions): Promise<void> {
  let safeName: string;
  try {
    safeName = sanitizeDbName(name);
  } catch (err: unknown) {
    console.error(chalk.red(String(err)));
    process.exitCode = 1;
    return;
  }

  const dbPath = getDbPath(safeName);

  if (!existsSync(dbPath)) {
    console.error(chalk.red(`Knowledge base "${safeName}" not found.`));
    process.exitCode = 1;
    return;
  }

  if (!options.yes) {
    // Read a single line from stdin for confirmation
    const confirmed = await promptConfirm(
      `Delete knowledge base "${safeName}" at ${dbPath}? This cannot be undone. [y/N] `
    );
    if (!confirmed) {
      console.log(chalk.dim("Aborted."));
      return;
    }
  }

  try {
    await rm(dbPath);
    console.log(chalk.green(`✓ Deleted knowledge base "${safeName}"`));
  } catch (err: unknown) {
    console.error(chalk.red(`Failed to delete: ${err}`));
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// db rename
// ---------------------------------------------------------------------------

export async function dbRename(oldName: string, newName: string): Promise<void> {
  let safeOld: string;
  let safeNew: string;
  try {
    safeOld = sanitizeDbName(oldName);
    safeNew = sanitizeDbName(newName);
  } catch (err: unknown) {
    console.error(chalk.red(String(err)));
    process.exitCode = 1;
    return;
  }

  const oldPath = getDbPath(safeOld);
  const newPath = getDbPath(safeNew);

  if (!existsSync(oldPath)) {
    console.error(chalk.red(`Knowledge base "${safeOld}" not found.`));
    process.exitCode = 1;
    return;
  }

  if (existsSync(newPath)) {
    console.error(
      chalk.red(`Knowledge base "${safeNew}" already exists. Choose a different name.`)
    );
    process.exitCode = 1;
    return;
  }

  try {
    await rename(oldPath, newPath);
    console.log(chalk.green(`✓ Renamed knowledge base "${safeOld}" → "${safeNew}"`));
    console.log(chalk.dim(`  Path: ${newPath}`));
  } catch (err: unknown) {
    console.error(chalk.red(`Failed to rename: ${err}`));
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// db merge
// ---------------------------------------------------------------------------

interface DbMergeOptions {
  db: string;
  strategy?: string;
  onConflict?: string;
  dryRun?: boolean;
  include?: string;
  exclude?: string;
  embedder?: string;
}

export async function dbMerge(sourceDb: string, options: DbMergeOptions): Promise<void> {
  // Resolve source DB path
  const sourcePath = resolve(sourceDb);
  if (!existsSync(sourcePath)) {
    console.error(chalk.red(`Source database not found: ${sourcePath}`));
    process.exitCode = 1;
    return;
  }
  if (!statSync(sourcePath).isFile()) {
    console.error(chalk.red(`Not a file: ${sourcePath}`));
    process.exitCode = 1;
    return;
  }

  const config = getConfig();
  const destPath = getDbPath(options.db);

  if (resolve(sourcePath) === resolve(destPath)) {
    console.error(chalk.red("Source and destination databases are the same file."));
    process.exitCode = 1;
    return;
  }

  // Validate strategy
  const strategy = (options.strategy ?? "strict") as MergeStrategy;
  if (strategy !== "strict" && strategy !== "reindex") {
    console.error(chalk.red(`Unknown strategy "${strategy}". Use "strict" or "reindex".`));
    process.exitCode = 1;
    return;
  }

  // Validate conflict resolution
  const onConflict = (options.onConflict ?? "skip") as ConflictResolution;
  if (!["skip", "prefer-local", "prefer-remote"].includes(onConflict)) {
    console.error(
      chalk.red(
        `Unknown --on-conflict value "${options.onConflict}". Use skip, prefer-local, or prefer-remote.`
      )
    );
    process.exitCode = 1;
    return;
  }

  // Auto-create destination DB if needed
  if (!existsSync(destPath)) {
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

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function promptConfirm(message: string): Promise<boolean> {
  process.stdout.write(message);
  return new Promise((resolve) => {
    let answer = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.resume();
    process.stdin.once("data", (chunk: string) => {
      answer = chunk.trim().toLowerCase();
      process.stdin.pause();
      resolve(answer === "y" || answer === "yes");
    });
  });
}
