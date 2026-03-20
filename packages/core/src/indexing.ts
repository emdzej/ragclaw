import { createHash } from "crypto";
import { stat } from "fs/promises";
import { existsSync } from "fs";
import { Store } from "./store/index.js";
import { Embedder } from "./embedder/index.js";
import { SemanticChunker } from "./chunkers/semantic.js";
import { CodeChunker } from "./chunkers/code.js";
import { MarkdownExtractor } from "./extractors/markdown.js";
import { TextExtractor } from "./extractors/text.js";
import { PdfExtractor } from "./extractors/pdf.js";
import { DocxExtractor } from "./extractors/docx.js";
import { WebExtractor } from "./extractors/web.js";
import { CodeExtractor } from "./extractors/code.js";
import { ImageExtractor } from "./extractors/image.js";
import { hashFile } from "./utils/hash.js";
import type { Source, Extractor, Chunker, ChunkRecord, ExtractedContent, SourceRecord } from "./types.js";
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

/** Configuration for `IndexingService`. */
export interface IndexingServiceConfig {
  /** Extra extractors (e.g. from plugins) prepended before built-ins. */
  extraExtractors?: Extractor[];
  /** Extractor limits (timeouts, size caps, etc.). */
  extractorLimits?: Partial<ExtractorLimits>;
  /** Callback fired on embedding model download progress (0–1). */
  onModelProgress?: (progress: number) => void;
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
  private embedder: Embedder;
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
    this.embedder = new Embedder({
      onProgress: cfg.onModelProgress,
    });
  }

  /** Warm up the embedding model. Call once before first use. */
  async init(): Promise<void> {
    if (this.ready) return;
    await this.embedder.embed("warmup");
    this.ready = true;
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
}
