import { existsSync, statSync } from "fs";
import { readdir, stat, readFile } from "fs/promises";
import { join, resolve, extname } from "path";
import { createHash } from "crypto";
import chalk from "chalk";
import ora from "ora";
import {
  Store,
  Embedder,
  SemanticChunker,
  MarkdownExtractor,
  TextExtractor,
} from "@emdzej/ragclaw-core";
import type { Source, Extractor, ChunkRecord } from "@emdzej/ragclaw-core";
import { getDbPath, RAGCLAW_DIR } from "../config.js";
import { mkdir } from "fs/promises";

interface AddOptions {
  db: string;
  type: string;
  recursive: boolean;
  include?: string;
  exclude?: string;
}

export async function addCommand(source: string, options: AddOptions): Promise<void> {
  const dbPath = getDbPath(options.db);

  // Auto-create database if it doesn't exist
  if (!existsSync(dbPath)) {
    await mkdir(RAGCLAW_DIR, { recursive: true });
    console.log(chalk.dim(`Creating knowledge base "${options.db}"...`));
  }

  const store = new Store();
  await store.open(dbPath);

  const spinner = ora("Loading embedding model...").start();

  let embedder: Embedder;
  try {
    embedder = new Embedder({
      onProgress: (progress) => {
        spinner.text = `Downloading model... ${Math.round(progress * 100)}%`;
      },
    });
    // Warm up the model
    await embedder.embed("test");
    spinner.succeed("Model loaded");
  } catch (error) {
    spinner.fail("Failed to load model");
    throw error;
  }

  const extractors: Extractor[] = [new MarkdownExtractor(), new TextExtractor()];
  const chunker = new SemanticChunker();

  try {
    const sources = await collectSources(source, options);
    console.log(chalk.dim(`Found ${sources.length} file(s) to process`));

    let totalChunks = 0;

    for (const src of sources) {
      const fileSpinner = ora(`Processing ${src.path}`).start();

      try {
        // Find matching extractor
        const extractor = extractors.find((e) => e.canHandle(src));
        if (!extractor) {
          fileSpinner.warn(`Skipping ${src.path} (unsupported format)`);
          continue;
        }

        // Check if already indexed with same hash
        const content = await readFile(src.path!, "utf-8");
        const contentHash = createHash("sha256").update(content).digest("hex");
        const existing = await store.getSource(src.path!);

        if (existing && existing.contentHash === contentHash) {
          fileSpinner.info(`Skipping ${src.path} (unchanged)`);
          continue;
        }

        // Remove old chunks if re-indexing
        if (existing) {
          await store.removeChunksBySource(existing.id);
        }

        // Extract content
        const extracted = await extractor.extract(src);

        // Chunk content
        const sourceId = existing?.id ?? "";
        const chunks = await chunker.chunk(extracted, sourceId, src.path!);

        // Generate embeddings
        const embeddings = await embedder.embedBatch(chunks.map((c) => c.text));

        // Create/update source record
        const fileStat = await stat(src.path!);
        const now = Date.now();

        let finalSourceId: string;
        if (existing) {
          await store.updateSource(existing.id, {
            contentHash,
            mtime: fileStat.mtimeMs,
            indexedAt: now,
            metadata: extracted.metadata,
          });
          finalSourceId = existing.id;
        } else {
          finalSourceId = await store.addSource({
            path: src.path!,
            type: "file",
            contentHash,
            mtime: fileStat.mtimeMs,
            indexedAt: now,
            metadata: extracted.metadata,
          });
        }

        // Store chunks with embeddings
        const chunkRecords: ChunkRecord[] = chunks.map((chunk, i) => ({
          ...chunk,
          sourceId: finalSourceId,
          embedding: embeddings[i],
          createdAt: now,
        }));

        await store.addChunks(chunkRecords);
        totalChunks += chunkRecords.length;

        fileSpinner.succeed(`Indexed ${src.path} (${chunkRecords.length} chunks)`);
      } catch (error) {
        fileSpinner.fail(`Failed to process ${src.path}: ${error}`);
      }
    }

    console.log();
    console.log(chalk.green(`✓ Indexed ${sources.length} file(s), ${totalChunks} chunks`));
  } finally {
    await store.close();
  }
}

async function collectSources(source: string, options: AddOptions): Promise<Source[]> {
  const resolved = resolve(source);

  if (!existsSync(resolved)) {
    // Check if it's a URL
    if (source.startsWith("http://") || source.startsWith("https://")) {
      return [{ type: "url", url: source }];
    }
    throw new Error(`Source not found: ${source}`);
  }

  const stats = statSync(resolved);

  if (stats.isFile()) {
    return [{ type: "file", path: resolved }];
  }

  if (stats.isDirectory() && options.recursive) {
    return collectFilesRecursive(resolved, options);
  }

  return [];
}

async function collectFilesRecursive(dir: string, options: AddOptions): Promise<Source[]> {
  const sources: Source[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    // Skip hidden files and common excludes
    if (entry.name.startsWith(".")) continue;
    if (entry.name === "node_modules") continue;
    if (options.exclude && entry.name.match(new RegExp(options.exclude))) continue;

    if (entry.isDirectory()) {
      const nested = await collectFilesRecursive(fullPath, options);
      sources.push(...nested);
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase();

      // Check include pattern
      if (options.include && !entry.name.match(new RegExp(options.include))) {
        continue;
      }

      // Only include supported extensions
      if ([".md", ".markdown", ".mdx", ".txt", ".text"].includes(ext)) {
        sources.push({ type: "file", path: fullPath });
      }
    }
  }

  return sources;
}
