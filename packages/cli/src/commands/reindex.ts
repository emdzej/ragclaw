import { existsSync } from "fs";
import { stat, readFile } from "fs/promises";
import { createHash } from "crypto";
import ora from "ora";
import chalk from "chalk";
import {
  Store,
  Embedder,
  SemanticChunker,
  CodeChunker,
  MarkdownExtractor,
  TextExtractor,
  PdfExtractor,
  DocxExtractor,
  WebExtractor,
  CodeExtractor,
  ImageExtractor,
  isPathAllowed,
  isUrlAllowed,
} from "@emdzej/ragclaw-core";
import type { Extractor, Chunker, ChunkRecord, RagclawConfig } from "@emdzej/ragclaw-core";
import { getDbPath, getConfig } from "../config.js";
import { resolve } from "path";

interface ReindexOptions {
  db: string;
  force?: boolean;
  prune?: boolean;
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
    const embedder = new Embedder();
    await embedder.embed("warmup");
    spinner.succeed("Model loaded");

    const extractors: Extractor[] = [
      new MarkdownExtractor(),
      new PdfExtractor({ limits: config.extractorLimits }),
      new DocxExtractor(),
      new WebExtractor(config.extractorLimits),
      new CodeExtractor(),
      new ImageExtractor({ limits: config.extractorLimits }),
      new TextExtractor(),
    ];
    const semanticChunker = new SemanticChunker();
    const codeChunker = new CodeChunker();

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
        // Check if source still exists
        const isUrl = source.type === "url";
        
        if (!isUrl && !existsSync(source.path)) {
          if (options.prune) {
            await store.removeSource(source.id);
            result.removed++;
            console.log(chalk.yellow(`✗ Removed (not found): ${displayPath}`));
          } else {
            console.log(chalk.dim(`⊘ Missing: ${displayPath}`));
          }
          continue;
        }

        // Guard enforcement (when enabled)
        if (config.enforceGuards) {
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

        // Calculate current hash
        let currentHash: string | undefined;
        let currentMtime: number | undefined;

        if (!isUrl) {
          const content = await readFile(source.path, "utf-8").catch(() =>
            readFile(source.path).then((b) => b.toString("base64"))
          );
          currentHash = createHash("sha256").update(content).digest("hex");
          const fileStat = await stat(source.path);
          currentMtime = fileStat.mtimeMs;
        }

        // Skip if unchanged (unless --force)
        if (!options.force && currentHash && currentHash === source.contentHash) {
          result.unchanged++;
          continue;
        }

        // Find extractor
        const src = isUrl
          ? { type: "url" as const, url: source.path }
          : { type: "file" as const, path: source.path };

        const extractor = extractors.find((e) => e.canHandle(src));
        if (!extractor) {
          result.errors.push(`${displayPath}: No extractor available`);
          continue;
        }

        // Re-extract and re-chunk
        spinner.text = `Reindexing ${displayPath}`;

        const extracted = await extractor.extract(src);
        const chunker: Chunker = extracted.sourceType === "code" ? codeChunker : semanticChunker;
        const chunks = await chunker.chunk(extracted, source.id, source.path);
        const embeddings = await embedder.embedBatch(chunks.map((c) => c.text));

        // Remove old chunks
        await store.removeChunksBySource(source.id);

        // Update source metadata
        const now = Date.now();
        await store.updateSource(source.id, {
          contentHash: currentHash,
          mtime: currentMtime,
          indexedAt: now,
          metadata: extracted.metadata,
        });

        // Add new chunks
        const chunkRecords: ChunkRecord[] = chunks.map((chunk, i) => ({
          ...chunk,
          sourceId: source.id,
          embedding: embeddings[i],
          createdAt: now,
        }));

        await store.addChunks(chunkRecords);
        result.updated++;
        console.log(chalk.green(`✔ Updated: ${displayPath} (${chunkRecords.length} chunks)`));

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
