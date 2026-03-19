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
  CodeChunker,
  MarkdownExtractor,
  TextExtractor,
  PdfExtractor,
  DocxExtractor,
  WebExtractor,
  CodeExtractor,
  ImageExtractor,
} from "@emdzej/ragclaw-core";
import type { Source, Extractor, ChunkRecord, Chunker } from "@emdzej/ragclaw-core";
import { getDbPath, RAGCLAW_DIR } from "../config.js";
import { mkdir } from "fs/promises";
import { PluginLoader } from "../plugins/loader.js";

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

  // Load plugins
  const pluginLoader = new PluginLoader();
  await pluginLoader.loadAll();
  const pluginExtractors = pluginLoader.getExtractors();

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

  const extractors: Extractor[] = [
    ...pluginExtractors, // Plugin extractors first (higher priority)
    new MarkdownExtractor(),
    new PdfExtractor(),
    new DocxExtractor(),
    new WebExtractor(),
    new CodeExtractor(),
    new ImageExtractor(),
    new TextExtractor(), // Fallback, keep last
  ];
  const semanticChunker = new SemanticChunker();
  const codeChunker = new CodeChunker();

  try {
    const sources = await collectSources(source, options);
    console.log(chalk.dim(`Found ${sources.length} source(s) to process`));

    let totalChunks = 0;

    for (const src of sources) {
      const displayPath = src.path || src.url || "unknown";
      const fileSpinner = ora(`Processing ${displayPath}`).start();

      try {
        // Find matching extractor
        const extractor = extractors.find((e) => e.canHandle(src));
        if (!extractor) {
          fileSpinner.warn(`Skipping ${displayPath} (unsupported format)`);
          continue;
        }

        // For URLs, we need different handling
        const isUrl = src.type === "url";
        const sourcePath = isUrl ? src.url! : src.path!;

        // Check if already indexed (for URLs, always re-fetch)
        const existing = await store.getSource(sourcePath);

        // For files, check content hash to skip unchanged
        let contentHash: string;
        if (!isUrl) {
          const content = await readFile(src.path!, "utf-8").catch(() => 
            readFile(src.path!).then(b => b.toString("base64"))
          );
          contentHash = createHash("sha256").update(content).digest("hex");

          if (existing && existing.contentHash === contentHash) {
            fileSpinner.info(`Skipping ${displayPath} (unchanged)`);
            continue;
          }
        } else {
          // For URLs, use timestamp-based hash (always re-index)
          contentHash = createHash("sha256").update(sourcePath + Date.now()).digest("hex");
        }

        // Remove old chunks if re-indexing
        if (existing) {
          await store.removeChunksBySource(existing.id);
        }

        // Extract content
        const extracted = await extractor.extract(src);

        // Choose chunker based on content type
        const chunker: Chunker = extracted.sourceType === "code" ? codeChunker : semanticChunker;

        // Chunk content
        const sourceId = existing?.id ?? "";
        const chunks = await chunker.chunk(extracted, sourceId, sourcePath);

        // Generate embeddings
        const embeddings = await embedder.embedBatch(chunks.map((c) => c.text));

        // Create/update source record
        const now = Date.now();
        let mtime: number | undefined;
        
        if (!isUrl) {
          const fileStat = await stat(src.path!);
          mtime = fileStat.mtimeMs;
        }

        let finalSourceId: string;
        if (existing) {
          await store.updateSource(existing.id, {
            contentHash,
            mtime,
            indexedAt: now,
            metadata: extracted.metadata,
          });
          finalSourceId = existing.id;
        } else {
          finalSourceId = await store.addSource({
            path: sourcePath,
            type: src.type,
            contentHash,
            mtime,
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

        fileSpinner.succeed(`Indexed ${displayPath} (${chunkRecords.length} chunks)`);
      } catch (error) {
        fileSpinner.fail(`Failed to process ${displayPath}: ${error}`);
      }
    }

    console.log();
    console.log(chalk.green(`✓ Indexed ${sources.length} source(s), ${totalChunks} chunks`));
  } finally {
    await store.close();
  }
}

async function collectSources(source: string, options: AddOptions): Promise<Source[]> {
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
      const supportedExts = [
        ".md", ".markdown", ".mdx", ".txt", ".text", ".pdf", ".docx",
        ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".java",
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".tif",
      ];
      if (supportedExts.includes(ext)) {
        sources.push({ type: "file", path: fullPath });
      }
    }
  }

  return sources;
}
