/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import picomatch from "picomatch";
import { CodeChunker } from "./chunkers/code.js";
import { FixedChunker } from "./chunkers/fixed.js";
import { SemanticChunker } from "./chunkers/semantic.js";
import { SentenceChunker } from "./chunkers/sentence.js";
import type { ChunkingOverride, ExtractorLimits } from "./config.js";
import type { EmbedderResolvedConfig } from "./embedder/factory.js";
import { createEmbedder } from "./embedder/factory.js";
import { CodeExtractor } from "./extractors/code.js";
import { DocxExtractor } from "./extractors/docx.js";
import { ImageExtractor } from "./extractors/image.js";
import { MarkdownExtractor } from "./extractors/markdown.js";
import { PdfExtractor } from "./extractors/pdf.js";
import { TextExtractor } from "./extractors/text.js";
import type { CrawlOptions } from "./extractors/web.js";
import { WebExtractor } from "./extractors/web.js";
import type { Store } from "./store/index.js";
import type {
  Chunker,
  ChunkRecord,
  EmbedderPlugin,
  ExtractedContent,
  Extractor,
  Source,
  SourceRecord,
} from "./types.js";
import { hashFile } from "./utils/hash.js";

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
  /**
   * Override the chunker for this call.
   * Accepts a chunker name (e.g. "sentence", "fixed") or "auto".
   * Takes highest priority over config overrides and auto-selection.
   */
  chunker?: string;
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
  /**
   * Override the chunker for this call.
   * Accepts a chunker name (e.g. "sentence", "fixed") or "auto".
   * Takes highest priority over config overrides and auto-selection.
   */
  chunker?: string;
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
  /**
   * Extra chunkers (e.g. from plugins) tried before the built-in ones.
   *
   * Chunkers are tried in order via `canHandle()`.  The first match wins.
   * Built-in chunkers act as the final fallbacks via auto-selection.
   */
  extraChunkers?: Chunker[];
  /**
   * Default chunker selection strategy for this service instance.
   *  - `"auto"` (default) — first `canHandle()` match across the full chain
   *  - a chunker name string — forces that specific chunker for all content
   *
   * Can be overridden per-call via `IndexSourceOptions.chunker`.
   * Config-level pattern overrides are applied by callers before passing here.
   */
  chunkerStrategy?: "auto" | string;
  /**
   * Pattern-based chunker overrides from config.
   * Passed through from `RagclawConfig.chunking.overrides`.
   */
  chunkerOverrides?: ChunkingOverride[];
  /**
   * Global chunker option defaults (chunkSize, overlap) from config.
   * Applied when constructing built-in chunkers.
   */
  chunkerDefaults?: { chunkSize?: number; overlap?: number };
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
// Built-in chunker registry (ordered: code → semantic → sentence → fixed)
// ---------------------------------------------------------------------------

/** Descriptor returned by `listBuiltinChunkers()`. */
export interface ChunkerInfo {
  name: string;
  description: string;
  handles: string[];
  source: "built-in" | "plugin";
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
  private builtinChunkers: Chunker[];
  private extraChunkers: Chunker[];
  private chunkerStrategy: string;
  private chunkerOverrides: ChunkingOverride[];
  private embedder: EmbedderPlugin;
  private ready = false;

  constructor(cfg: IndexingServiceConfig = {}) {
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

    const defaults = cfg.chunkerDefaults ?? {};
    this.builtinChunkers = [
      new CodeChunker(),
      new SemanticChunker({ chunkSize: defaults.chunkSize, overlap: defaults.overlap }),
      new SentenceChunker({ chunkSize: defaults.chunkSize, overlap: defaults.overlap }),
      new FixedChunker({ chunkSize: defaults.chunkSize, overlap: defaults.overlap }),
    ];

    this.extraChunkers = cfg.extraChunkers ?? [];
    this.chunkerStrategy = cfg.chunkerStrategy ?? "auto";
    this.chunkerOverrides = cfg.chunkerOverrides ?? [];

    // Resolve embedder: plugin instance > resolved config > default nomic
    if (cfg.embedder && "embed" in cfg.embedder) {
      this.embedder = cfg.embedder as EmbedderPlugin;
    } else if (cfg.embedder) {
      this.embedder = createEmbedder({
        ...(cfg.embedder as EmbedderResolvedConfig),
        onProgress: cfg.onModelProgress,
      });
    } else {
      this.embedder = createEmbedder({ onProgress: cfg.onModelProgress });
    }
  }

  /** Warm up the embedding model. Call once before first use. */
  async init(): Promise<void> {
    if (this.ready) return;
    await this.embedder.init?.();
    if (this.embedder.dimensions === 0) {
      await this.embedder.embed("warmup");
    }
    this.ready = true;
  }

  /**
   * Return info about all chunkers available to this service instance —
   * plugin chunkers first, then built-ins.  Used by `ragclaw chunkers list`
   * and `rag_list_chunkers`.
   */
  listChunkers(): ChunkerInfo[] {
    return [
      ...this.extraChunkers.map((c) => ({
        name: c.name,
        description: c.description,
        handles: c.handles,
        source: "plugin" as const,
      })),
      ...this.builtinChunkers.map((c) => ({
        name: c.name,
        description: c.description,
        handles: c.handles,
        source: "built-in" as const,
      })),
    ];
  }

  /**
   * Resolve which chunker to use for a given piece of extracted content
   * and source path, following the priority stack:
   *
   *   1. Forced strategy (set at service level or per-call override)
   *   2. Config pattern overrides (first glob match against sourcePath)
   *   3. Plugin chunkers  (extraChunkers — canHandle, first match)
   *   4. Built-in auto    (builtinChunkers — canHandle, first match)
   *
   * @throws {Error} if a named chunker is requested but not found
   */
  resolveChunker(extracted: ExtractedContent, sourcePath: string, forceChunker?: string): Chunker {
    const all = [...this.extraChunkers, ...this.builtinChunkers];

    // Priority 1: explicit per-call override
    const strategyName =
      forceChunker ?? (this.chunkerStrategy !== "auto" ? this.chunkerStrategy : undefined);
    if (strategyName && strategyName !== "auto") {
      return this.requireChunkerByName(strategyName, all);
    }

    // Priority 2: config pattern overrides
    for (const override of this.chunkerOverrides) {
      const isMatch = picomatch(override.pattern, { dot: true });
      if (isMatch(sourcePath)) {
        return this.requireChunkerByName(override.chunker, all);
      }
    }

    // Priority 3 + 4: auto — first canHandle() match (plugins first, then built-ins)
    const match = all.find((c) => c.canHandle(extracted));
    if (match) return match;

    // Should never reach here since FixedChunker catches everything
    throw new Error(`No chunker available for content type "${extracted.sourceType}"`);
  }

  private requireChunkerByName(name: string, all: Chunker[]): Chunker {
    const found = all.find((c) => c.name === name);
    if (!found) {
      const available = all.map((c) => c.name).join(", ");
      const suggestion = this.findSimilarName(
        name,
        all.map((c) => c.name)
      );
      throw new Error(
        `Unknown chunker "${name}".${suggestion ? ` Did you mean "${suggestion}"?` : ""}` +
          ` Available chunkers: ${available}`
      );
    }
    return found;
  }

  private findSimilarName(input: string, candidates: string[]): string | undefined {
    // Simple Levenshtein-based suggestion (1–2 char difference)
    for (const candidate of candidates) {
      if (Math.abs(candidate.length - input.length) <= 2) {
        if (this.editDistance(input, candidate) <= 2) return candidate;
      }
    }
    return undefined;
  }

  private editDistance(a: string, b: string): number {
    const dp: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
      Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
    );
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        dp[i][j] =
          a[i - 1] === b[j - 1]
            ? dp[i - 1][j - 1]
            : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
    return dp[a.length][b.length];
  }

  /**
   * Check that the embedder's dimensions match what's stored in the database.
   * Throws a descriptive error if there's a mismatch.
   */
  private async checkAndRecordEmbedderMeta(store: Store): Promise<void> {
    const storedDim = await store.getMeta("embedder_dimensions");
    const currentDim = this.embedder.dimensions;

    if (currentDim === 0) return;

    if (storedDim !== null && parseInt(storedDim, 10) !== currentDim) {
      const storedName = (await store.getMeta("embedder_name")) ?? "unknown";
      throw new Error(
        `Embedder dimension mismatch: the database contains ${storedDim}-dim embeddings ` +
          `(stored with "${storedName}") but the current embedder "${this.embedder.name}" ` +
          `produces ${currentDim}-dim vectors.\n` +
          `To fix: run \`ragclaw reindex --embedder ${this.embedder.name}\` to rebuild the index, ` +
          `or switch back to the original embedder.`
      );
    }

    await store.setMeta("embedder_name", this.embedder.name);
    await store.setMeta("embedder_dimensions", String(currentDim));
  }

  /**
   * Index a single source (file or URL).
   */
  async indexSource(
    store: Store,
    source: Source,
    options: IndexSourceOptions = {}
  ): Promise<IndexOutcome> {
    try {
      const extractor = this.extractors.find((e) => e.canHandle(source));
      if (!extractor) {
        return { status: "skipped", reason: "unsupported format" };
      }

      const sourcePath =
        source.type === "url"
          ? source.url
          : source.type === "file"
            ? source.path
            : (source.name ?? "inline-text");

      await this.checkAndRecordEmbedderMeta(store);

      const existing = await store.getSource(sourcePath);

      let contentHash: string;
      if (source.type === "file") {
        contentHash = await hashFile(source.path);
        if (!options.force && existing && existing.contentHash === contentHash) {
          return { status: "unchanged", sourceId: existing.id };
        }
      } else {
        contentHash = createHash("sha256")
          .update(sourcePath + Date.now())
          .digest("hex");
      }

      if (existing) {
        await store.removeChunksBySource(existing.id);
      }

      const extracted = await extractor.extract(source);
      const chunker = this.resolveChunker(extracted, sourcePath, options.chunker);
      const chunks = await chunker.chunk(extracted, existing?.id ?? "", sourcePath);
      const embeddings = await this.embedder.embedBatch(chunks.map((c) => c.text));

      if (this.embedder.dimensions > 0) {
        await store.setMeta("embedder_name", this.embedder.name);
        await store.setMeta("embedder_dimensions", String(this.embedder.dimensions));
      }

      const now = Date.now();
      let mtime: number | undefined;
      if (source.type === "file") {
        const fileStat = await stat(source.path);
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
   */
  async reindexSource(
    store: Store,
    source: SourceRecord,
    options: ReindexSourceOptions = {}
  ): Promise<ReindexOutcome> {
    try {
      const isUrl = source.type === "url";

      await this.checkAndRecordEmbedderMeta(store);

      if (!isUrl && !existsSync(source.path)) {
        if (options.prune) {
          await store.removeSource(source.id);
          return { status: "removed", sourceId: source.id };
        }
        return { status: "missing" };
      }

      let currentHash: string | undefined;
      let currentMtime: number | undefined;

      if (!isUrl) {
        currentHash = await hashFile(source.path);
        const fileStat = await stat(source.path);
        currentMtime = fileStat.mtimeMs;
      }

      if (!options.force && currentHash && currentHash === source.contentHash) {
        return { status: "unchanged", sourceId: source.id };
      }

      const src: Source = isUrl
        ? { type: "url", url: source.path }
        : { type: "file", path: source.path };

      const extractor = this.extractors.find((e) => e.canHandle(src));
      if (!extractor) {
        return { status: "skipped", reason: "no extractor available" };
      }

      const extracted = await extractor.extract(src);
      const chunker = this.resolveChunker(extracted, source.path, options.chunker);
      const chunks = await chunker.chunk(extracted, source.id, source.path);
      const embeddings = await this.embedder.embedBatch(chunks.map((c) => c.text));

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
   */
  async indexCrawl(
    store: Store,
    startUrl: string,
    options: IndexCrawlOptions = {}
  ): Promise<IndexCrawlSummary> {
    const webExtractor = this.extractors.find((e): e is WebExtractor => e instanceof WebExtractor);

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
