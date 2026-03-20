import { existsSync } from "fs";
import chalk from "chalk";
import ora from "ora";
import { Store, createEmbedder } from "@emdzej/ragclaw-core";
import type { SearchMode } from "@emdzej/ragclaw-core";
import { getDbPath } from "../config.js";

interface SearchOptions {
  db: string;
  limit: string;
  mode: string;
  json?: boolean;
}

export async function searchCommand(query: string, options: SearchOptions): Promise<void> {
  const dbPath = getDbPath(options.db);

  if (!existsSync(dbPath)) {
    console.error(chalk.red(`Knowledge base "${options.db}" not found.`));
    console.log(chalk.dim(`Run: ragclaw init ${options.db}`));
    process.exit(1);
  }

  const store = new Store();
  await store.open(dbPath);

  const spinner = ora("Searching...").start();

  try {
    // Load embedder for vector/hybrid search.
    // Always inferred from store metadata — no --embedder flag on search.
    let embedding: Float32Array | undefined;
    if (options.mode !== "keyword") {
      // Read embedder info from store metadata (set during indexing)
      const storedName = await store.getMeta("embedder_name") ?? "nomic";
      const embedder = createEmbedder({ alias: storedName });
      embedding = await embedder.embedQuery(query);
    }

    const results = await store.search({
      text: query,
      embedding,
      limit: parseInt(options.limit, 10),
      mode: options.mode as SearchMode,
    });

    spinner.stop();

    if (results.length === 0) {
      console.log(chalk.yellow("No results found."));
      return;
    }

    if (options.json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    console.log(chalk.bold(`Found ${results.length} result(s):\n`));

    for (let i = 0; i < results.length; i++) {
      const { chunk, score, scoreVector, scoreKeyword } = results[i];
      const scoreStr = `${(score * 100).toFixed(1)}%`;

      console.log(chalk.cyan(`[${i + 1}] ${chunk.sourcePath}`));

      if (chunk.startLine && chunk.endLine) {
        console.log(chalk.dim(`    Lines ${chunk.startLine}-${chunk.endLine}`));
      }

      console.log(chalk.dim(`    Score: ${scoreStr}`));

      if (scoreVector !== undefined && scoreKeyword !== undefined) {
        console.log(chalk.dim(`    (vector: ${(scoreVector * 100).toFixed(1)}%, keyword: ${(scoreKeyword * 100).toFixed(1)}%)`));
      }

      // Show snippet (first 200 chars)
      const snippet = chunk.text.slice(0, 200).replace(/\n/g, " ");
      console.log(`    ${snippet}${chunk.text.length > 200 ? "..." : ""}`);
      console.log();
    }
  } finally {
    await store.close();
  }
}
