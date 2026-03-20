import { existsSync } from "fs";
import chalk from "chalk";
import { Store, resolvePreset } from "@emdzej/ragclaw-core";
import { getDbPath } from "../config.js";

interface StatusOptions {
  db: string;
}

export async function statusCommand(options: StatusOptions): Promise<void> {
  const dbPath = getDbPath(options.db);

  if (!existsSync(dbPath)) {
    console.error(chalk.red(`Knowledge base "${options.db}" not found.`));
    console.log(chalk.dim(`Run: ragclaw init ${options.db}`));
    process.exit(1);
  }

  const store = new Store();
  await store.open(dbPath);

  try {
    const stats = await store.getStats();
    const meta = await store.getAllMeta();

    // Embedder info from store metadata
    const embedderName = meta.embedder_name ?? "nomic";
    const embedderDims = meta.embedder_dimensions;
    const preset = resolvePreset(embedderName);
    const embedderModel = meta.embedder_model ?? preset?.model ?? embedderName;
    const embedderDimsDisplay = embedderDims ?? (preset?.dim ? String(preset.dim) : "?");

    console.log(chalk.bold(`Knowledge Base: ${options.db}`));
    console.log(chalk.dim(`Path: ${dbPath}`));
    console.log();
    console.log(`  Embedder: ${chalk.cyan(embedderName)} (${embedderModel}, ${embedderDimsDisplay} dims)`);
    console.log(`  Sources:  ${chalk.cyan(stats.sources)}`);
    console.log(`  Chunks:   ${chalk.cyan(stats.chunks)}`);
    console.log(`  Size:     ${chalk.cyan(formatBytes(stats.sizeBytes))}`);

    if (stats.lastUpdated) {
      const date = new Date(stats.lastUpdated);
      console.log(`  Updated:  ${chalk.cyan(date.toLocaleString())}`);
    }

    console.log();
    console.log(`  Vector support: ${store.hasVectorSupport ? chalk.green("✓ native") : chalk.yellow("○ JS fallback")}`);
  } finally {
    await store.close();
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
