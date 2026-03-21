/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { createHash } from "crypto";
import { stat } from "fs/promises";
import { existsSync } from "fs";
import { Store } from "./store/index.js";
import { Embedder } from "./embedder/index.js";
import { createEmbedder } from "./embedder/factory.js";
import { SemanticChunker } from "./chunkers/semantic.js";
import { CodeChunker } from "./chunkers/code.js";
import { MarkdownExtractor } from "./extractors/markdown.js";
import { TextExtractor } from "./extractors/text.js";
import { PdfExtractor } from "./extractors/pdf.js";
import { DocxExtractor } from "./extractors/docx.js";
import { WebExtractor } from "./extractors/web.js";
import type { CrawlOptions } from "./extractors/web.js";
import { CodeExtractor } from "./extractors/code.js";
import { ImageExtractor } from "./extractors/image.js";
import { hashFile } from "./utils/hash.js";
import type { Source, Extractor, Chunker, ChunkRecord, ExtractedContent, SourceRecord, EmbedderPlugin } from "./types.js";
import type { EmbedderResolvedConfig } from "./embedder/factory.js";
import type { ExtractorLimits } from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Outcome of a single `indexSource()` call. */
export type IndexOutcome =
  | { status: "indexed"; sourceId: string; chunks: number }
  | { status: "unchanged"; sourceId: string }
  | { status: "skipped"; reason: string }
  | { status: "error"; error: string };

/** Options for `indexSource()`. */
export interface IndexSourceOptions {
  /** When true, re-index even if the content hash hasn't changed. */
  force?: boolean;
}

/** Outcome of a single `reindexSource()` call. */
export type ReindexOutcome =
  | { status: "updated"; sourceId: string; chunks: number }
  | { status: "unchanged"; sourceId: string }
  | { status: "removed"; sourceId: string }
  | { status: "missing" }
  | { status: "skipped"; reason: string }
  | { status: "error"; error: string };

/** Options for `reindexSource()`. */
export interface ReindexSourceOptions {
  /** Re-index regardless of content hash. */
  force?: boolean;
  /** Remove the source record if the file no longer exists. */
  prune?: boolean;
}

/** Per-page result emitted by `indexCrawl()`. */
export interface IndexCrawlPageResult {
  url: string;
  outcome: IndexOutcome;
}

/** Summary returned by `indexCrawl()` after all pages are processed. */
export interface IndexCrawlSummary {
  indexed: number;
  skipped: number;
  errors: number;
  totalChunks: number;
}

/** Options for `indexCrawl()`. */
export interface IndexCrawlOptions extends CrawlOptions {
  /** Callback fired after each page is indexed. */
  onPage?: (result: IndexCrawlPageResult) => void;
}

/** Configuration for `IndexingService`. */
export interface IndexingServiceConfig {
  /** Extra extractors (e.g. from plugins) prepended before built-ins. */
  extraExtractors?: Extractor[];
  /** Extractor limits (timeouts, size caps, etc.). */
  extractorLimits?: Partial<ExtractorLimits>;
  /** Callback fired on embedding model download progress (0–1). */
  onModelProgress?: (progress: number) => void;
  /**
   * Embedder to use.  Accepts:
   *  - An `EmbedderPlugin` instance (plugin-provided or custom)
   *  - An `EmbedderResolvedConfig` object (alias / model / etc.)
   *  - Omit for the default nomic embedder
   */
  embedder?: EmbedderPlugin | EmbedderResolvedConfig;
}

// ---------------------------------------------------------------------------
// IndexingService
// ---------------------------------------------------------------------------

/**
 * Encapsulates the per-source indexing pipeline used by both the CLI and the
 * MCP server.  Callers are responsible for:
 *
 *  1. Opening the `Store` and passing it in.
 *  2. Collecting / expanding sources (file walking, guard checks, plugin
 *     `expand()`, etc.).
 *  3. Iterating sources and calling `indexSource()` / `reindexSource()`.
 *  4. Presenting progress / results to the user.
 *
 * The service owns the extractors, chunkers, and embedder so the
 * caller doesn't have to wire them together.
 */
export class IndexingService {
  private extractors: Extractor[];
  private semanticChunker: SemanticChunker;
  private codeChunker: CodeChunker;
  private embedder: EmbedderPlugin;
  private ready = false;

  constructor(private cfg: IndexingServiceConfig = {}) {
    this.extractors = [
      ...(cfg.extraExtractors ?? []),
      new MarkdownExtractor(),
      new PdfExtractor({ limits: cfg.extractorLimits }),
      new DocxExtractor(),
      new WebExtractor(cfg.extractorLimits),
      new CodeExtractor(),
      new ImageExtractor({ limits: cfg.extractorLimits }),
      new TextExtractor(), // fallback — keep last
    ];
    this.semanticChunker = new SemanticChunker();
    this.codeChunker = new CodeChunker();

    // Resolve embedder: plugin instance > resolved config > default nomic
    if (cfg.embedder && "embed" in cfg.embedder) {
      // Already an EmbedderPlugin instance
      this.embedder = cfg.embedder as EmbedderPlugin;
    } else if (cfg.embedder) {
      // EmbedderResolvedConfig object
      this.embedder = createEmbedder({
        ...(cfg.embedder as EmbedderResolvedConfig),
        onProgress: cfg.onModelProgress,
      });
    } else {
      // Default: nomic via factory (respects onProgress)
      this.embedder = createEmbedder({ onProgress: cfg.onModelProgress });
    }
  }

  /** Warm up the embedding model. Call once before first use. */
  async init(): Promise<void> {
    if (this.ready) return;
    await this.embedder.init?.();
    // Ensure dimensions are detected (init may trigger auto-detect)
    if (this.embedder.dimensions === 0) {
      await this.embedder.embed("warmup");
    }
    this.ready = true;
  }

  /**
   * Check that the embedder's dimensions match what's stored in the database.
   * Throws a descriptive error if there's a mismatch.
   *
   * Also writes embedder metadata to the store on first use (when store_meta
   * doesn't have a non-nomic embedder yet after the legacy migration).
   */
  private async checkAndRecordEmbedderMeta(store: Store): Promise<void> {
    const storedDim = await store.getMeta("embedder_dimensions");
    const currentDim = this.embedder.dimensions;

    // If dimensions are unknown yet (auto-detect hasn't run), skip the check
    if (currentDim === 0) return;

    if (storedDim !== null && parseInt(storedDim, 10) !== currentDim) {
      const storedName = (await store.getMeta("embedder_name")) ?? "unknown";
      throw new Error(
        `Embedder dimension mismatch: the database contains ${storedDim}-dim embeddings ` +
          `(stored with "${storedName}") but the current embedder "${this.embedder.name}" ` +
          `produces ${currentDim}-dim vectors.\n` +
          `To fix: run \`ragclaw reindex --embedder ${this.embedder.name}\` to rebuild the index, ` +
          `or switch back to the original embedder.`,
      );
    }

    // Record/update embedder metadata in store
    await store.setMeta("embedder_name", this.embedder.name);
    await store.setMeta("embedder_dimensions", String(currentDim));
  }

  /**
   * Index a single source (file or URL).
   *
   * - Finds a matching extractor
   * - Computes a content hash and skips unchanged files (unless `force`)
   * - Extracts text, chunks, embeds, and stores
   * - Creates or updates the source record
   */
  async indexSource(
    store: Store,
    source: Source,
    options: IndexSourceOptions = {},
  ): Promise<IndexOutcome> {
    try {
      const extractor = this.extractors.find((e) => e.canHandle(source));
      if (!extractor) {
        return { status: "skipped", reason: "unsupported format" };
      }

      const isUrl = source.type === "url";
      const sourcePath = isUrl ? source.url! : source.path!;

      // Check dimension compatibility before any I/O (fast-fail)
      await this.checkAndRecordEmbedderMeta(store);

      const existing = await store.getSource(sourcePath);

      // Content hash for change detection
      let contentHash: string;
      if (!isUrl) {
        contentHash = await hashFile(source.path!);
        if (!options.force && existing && existing.contentHash === contentHash) {
          return { status: "unchanged", sourceId: existing.id };
        }
      } else {
        // URLs always get a fresh hash (force re-index)
        contentHash = createHash("sha256")
          .update(sourcePath + Date.now())
          .digest("hex");
      }

      // Remove old chunks when re-indexing
      if (existing) {
        await store.removeChunksBySource(existing.id);
      }

      // Extract → chunk → embed
      const extracted = await extractor.extract(source);
      const chunker: Chunker =
        extracted.sourceType === "code" ? this.codeChunker : this.semanticChunker;
      const chunks = await chunker.chunk(
        extracted,
        existing?.id ?? "",
        sourcePath,
      );
      const embeddings = await this.embedder.embedBatch(
        chunks.map((c) => c.text),
      );

      // For auto-detect embedders (dim was 0 at pre-check), write meta now
      // that dimensions are known after the first real embed.
      if (this.embedder.dimensions > 0) {
        await store.setMeta("embedder_name", this.embedder.name);
        await store.setMeta("embedder_dimensions", String(this.embedder.dimensions));
      }

      // Source metadata
      const now = Date.now();
      let mtime: number | undefined;
      if (!isUrl) {
        const fileStat = await stat(source.path!);
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
          type: source.type,
          contentHash,
          mtime,
          indexedAt: now,
          metadata: extracted.metadata,
        });
      }

      const chunkRecords: ChunkRecord[] = chunks.map((chunk, i) => ({
        ...chunk,
        sourceId: finalSourceId,
        embedding: embeddings[i],
        createdAt: now,
      }));

      await store.addChunks(chunkRecords);

      return {
        status: "indexed",
        sourceId: finalSourceId,
        chunks: chunkRecords.length,
      };
    } catch (err) {
      return { status: "error", error: String(err) };
    }
  }

  /**
   * Re-index an existing source record.
   *
   * - Checks if the source file still exists
   * - Optionally prunes missing sources
   * - Hash-checks for changes (skippable with `force`)
   * - Re-extracts, re-chunks, re-embeds, and updates the store
   */
  async reindexSource(
    store: Store,
    source: SourceRecord,
    options: ReindexSourceOptions = {},
  ): Promise<ReindexOutcome> {
    try {
      const isUrl = source.type === "url";

      // Check dimension compatibility before any I/O (fast-fail)
      await this.checkAndRecordEmbedderMeta(store);

      // Check existence
      if (!isUrl && !existsSync(source.path)) {
        if (options.prune) {
          await store.removeSource(source.id);
          return { status: "removed", sourceId: source.id };
        }
        return { status: "missing" };
      }

      // Hash-based change detection
      let currentHash: string | undefined;
      let currentMtime: number | undefined;

      if (!isUrl) {
        currentHash = await hashFile(source.path);
        const fileStat = await stat(source.path);
        currentMtime = fileStat.mtimeMs;
      }

      if (
        !options.force &&
        currentHash &&
        currentHash === source.contentHash
      ) {
        return { status: "unchanged", sourceId: source.id };
      }

      // Build a Source object for extractors
      const src: Source = isUrl
        ? { type: "url", url: source.path }
        : { type: "file", path: source.path };

      const extractor = this.extractors.find((e) => e.canHandle(src));
      if (!extractor) {
        return { status: "skipped", reason: "no extractor available" };
      }

      const extracted = await extractor.extract(src);
      const chunker: Chunker =
        extracted.sourceType === "code" ? this.codeChunker : this.semanticChunker;
      const chunks = await chunker.chunk(extracted, source.id, source.path);
      const embeddings = await this.embedder.embedBatch(
        chunks.map((c) => c.text),
      );

      // Swap chunks atomically
      await store.removeChunksBySource(source.id);

      const now = Date.now();
      await store.updateSource(source.id, {
        contentHash: currentHash,
        mtime: currentMtime,
        indexedAt: now,
        metadata: extracted.metadata,
      });

      const chunkRecords: ChunkRecord[] = chunks.map((chunk, i) => ({
        ...chunk,
        sourceId: source.id,
        embedding: embeddings[i],
        createdAt: now,
      }));

      await store.addChunks(chunkRecords);

      return {
        status: "updated",
        sourceId: source.id,
        chunks: chunkRecords.length,
      };
    } catch (err) {
      return { status: "error", error: String(err) };
    }
  }

  /**
   * Crawl a website starting from `startUrl` and index every discovered page.
   *
   * Uses the built-in `WebExtractor.crawl()` generator under the hood.
   * Each fetched page is run through the normal index pipeline (chunk → embed
   * → store).  Progress can be tracked via the `onPage` callback.
   *
   * Returns a summary of the crawl after all pages have been processed.
   */
  async indexCrawl(
    store: Store,
    startUrl: string,
    options: IndexCrawlOptions = {},
  ): Promise<IndexCrawlSummary> {
    // Find the WebExtractor instance (always present in the built-in list)
    const webExtractor = this.extractors.find(
      (e): e is WebExtractor => e instanceof WebExtractor,
    );

    if (!webExtractor) {
      throw new Error("WebExtractor not available — cannot crawl");
    }

    const { onPage, ...crawlOptions } = options;

    const summary: IndexCrawlSummary = {
      indexed: 0,
      skipped: 0,
      errors: 0,
      totalChunks: 0,
    };

    for await (const page of webExtractor.crawl(startUrl, crawlOptions)) {
      const source: Source = { type: "url", url: page.url };
      const outcome = await this.indexSource(store, source);

      switch (outcome.status) {
        case "indexed":
          summary.indexed++;
          summary.totalChunks += outcome.chunks;
          break;
        case "unchanged":
        case "skipped":
          summary.skipped++;
          break;
        case "error":
          summary.errors++;
          break;
      }

      onPage?.({ url: page.url, outcome });
    }

    return summary;
  }
}