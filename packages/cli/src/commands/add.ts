import { existsSync, statSync } from "fs";
import { readdir, stat } from "fs/promises";
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
  isPathAllowed,
  isUrlAllowed,
  hashFile,
} from "@emdzej/ragclaw-core";
import type { Source, Extractor, ChunkRecord, Chunker, RagclawConfig } from "@emdzej/ragclaw-core";
import { getDbPath, ensureDataDir, getConfig } from "../config.js";
import { mkdir } from "fs/promises";
import { PluginLoader } from "../plugins/loader.js";

interface AddOptions {
  db: string;
  type: string;
  recursive: boolean;
  include?: string;
  exclude?: string;
  // Security guard overrides (from CLI flags)
  allowedPaths?: string;
  maxDepth?: string;
  maxFiles?: string;
  allowUrls?: boolean;
  blockPrivateUrls?: boolean;
  enforceGuards?: boolean;
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
    if (Number.isFinite(n) && n > 0) { o.maxDepth = n; hasAny = true; }
  }
  if (options.maxFiles !== undefined) {
    const n = parseInt(options.maxFiles, 10);
    if (Number.isFinite(n) && n > 0) { o.maxFiles = n; hasAny = true; }
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
    new PdfExtractor({ limits: config.extractorLimits }),
    new DocxExtractor(),
    new WebExtractor(config.extractorLimits),
    new CodeExtractor(),
    new ImageExtractor({ limits: config.extractorLimits }),
    new TextExtractor(), // Fallback, keep last
  ];
  const semanticChunker = new SemanticChunker();
  const codeChunker = new CodeChunker();

  try {
    const sources = await collectSources(source, options, config);
    console.log(chalk.dim(`Found ${sources.length} source(s) to process`));

    let totalChunks = 0;

    for (const src of sources) {
      const displayPath = src.path || src.url || "unknown";
      const fileSpinner = ora(`Processing ${displayPath}`).start();

      try {
        // Guard enforcement (when enabled)
        if (config.enforceGuards) {
          if (src.type === "url") {
            const urlCheck = await isUrlAllowed(src.url!, config);
            if (!urlCheck.allowed) {
              fileSpinner.warn(`Blocked: ${urlCheck.reason}`);
              continue;
            }
          } else if (src.path) {
            const pathCheck = isPathAllowed(src.path, config);
            if (!pathCheck.allowed) {
              fileSpinner.warn(`Blocked: ${pathCheck.reason}`);
              continue;
            }
          }
        }

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
          contentHash = await hashFile(src.path!);

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

async function collectSources(source: string, options: AddOptions, config: RagclawConfig): Promise<Source[]> {
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
  collected: Source[] = [],
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
        ".md", ".markdown", ".mdx", ".txt", ".text", ".pdf", ".docx",
        ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".java",
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".tif",
      ];
      if (supportedExts.includes(ext)) {
        collected.push({ type: "file", path: fullPath });
      }
    }
  }

  return collected;
}
