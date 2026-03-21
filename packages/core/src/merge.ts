/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { randomUUID } from "crypto";
import { Store } from "./store/index.js";
import type { SourceRecord, ChunkRecord, EmbedderPlugin } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** How incompatible embedders are handled. */
export type MergeStrategy = "strict" | "reindex";

/** What to do when the same source path exists in both databases. */
export type ConflictResolution =
  | "skip"       // keep local, ignore remote
  | "prefer-local"  // same as skip
  | "prefer-remote"; // overwrite local with remote

/** Options for a merge operation. */
export interface MergeOptions {
  /**
   * `strict`  — only merge when both databases share the same embedder.
   *             Chunk embeddings are copied directly (no re-embedding).
   * `reindex` — copy source metadata + chunk *text* from the remote DB,
   *             then re-embed locally. Works even when embedders differ.
   *
   * Default: `"strict"` when embedders match, auto-upgraded to `"reindex"`
   * when they differ and the caller explicitly requests `"reindex"`.
   */
  strategy?: MergeStrategy;

  /**
   * How to resolve a conflict (same `path`, different `content_hash`).
   * Default: `"skip"` (keep local version).
   */
  onConflict?: ConflictResolution;

  /**
   * When true, compute and return the diff but do not write anything to the
   * destination database.
   */
  dryRun?: boolean;

  /** Glob-style path prefix filter — only import sources whose path starts with one of these. */
  include?: string[];

  /** Glob-style path prefix filter — skip sources whose path starts with one of these. */
  exclude?: string[];

  /**
   * Embedder used for re-embedding during the `reindex` strategy.
   * Required when `strategy === "reindex"`.
   */
  embedder?: EmbedderPlugin;

  /** Callback fired after each source is processed. */
  onProgress?: (result: MergeSourceResult) => void;
}

/** Outcome of processing a single source during a merge. */
export interface MergeSourceResult {
  path: string;
  status: "added" | "updated" | "skipped" | "error";
  reason?: string;
}

/** Describes the difference between two databases (used for --dry-run / diff). */
export interface MergeDiff {
  /** Sources only in the remote DB (would be added). */
  toAdd: SourceRecord[];
  /** Sources in both DBs with a different content hash (would be updated per conflict policy). */
  toUpdate: SourceRecord[];
  /** Sources in both DBs with the same content hash (identical — would be skipped). */
  identical: SourceRecord[];
  /** Sources only in the local DB (not touched). */
  localOnly: SourceRecord[];
}

/** Summary returned after a merge (or dry-run). */
export interface MergeSummary {
  strategy: MergeStrategy;
  dryRun: boolean;
  diff: MergeDiff;
  sourcesAdded: number;
  sourcesUpdated: number;
  sourcesSkipped: number;
  errors: Array<{ path: string; error: string }>;
}

// ---------------------------------------------------------------------------
// MergeService
// ---------------------------------------------------------------------------

export class MergeService {
  /**
   * Merge the contents of `sourceDb` into `destDb`.
   *
   * The source database is opened read-only and is never modified.
   * All writes go to `destDb`.
   */
  async merge(
    destDb: Store,
    sourceDbPath: string,
    options: MergeOptions = {},
  ): Promise<MergeSummary> {
    const {
      onConflict = "skip",
      dryRun = false,
      include,
      exclude,
      onProgress,
    } = options;

    // ── Open source DB (read-only) ──────────────────────────────────────────
    const sourceDb = new Store();
    await sourceDb.open(sourceDbPath);

    try {
      // ── Embedder compatibility check ──────────────────────────────────────
      const destMeta = await destDb.getAllMeta();
      const srcMeta = await sourceDb.getAllMeta();

      const destEmbedder = destMeta.embedder_name ?? "nomic";
      const srcEmbedder = srcMeta.embedder_name ?? "nomic";
      const destDims = parseInt(destMeta.embedder_dimensions ?? "768", 10);
      const srcDims = parseInt(srcMeta.embedder_dimensions ?? "768", 10);

      const embeddersMatch = destEmbedder === srcEmbedder && destDims === srcDims;

      // Resolve strategy
      let strategy: MergeStrategy;
      if (options.strategy === "reindex") {
        strategy = "reindex";
        if (!options.embedder) {
          throw new Error(
            'MergeService: strategy "reindex" requires an embedder instance (options.embedder)',
          );
        }
      } else if (options.strategy === "strict" || !options.strategy) {
        if (!embeddersMatch) {
          throw new Error(
            `Cannot merge: embedder mismatch.\n` +
              `  Local:  ${destEmbedder} (${destDims} dims)\n` +
              `  Remote: ${srcEmbedder} (${srcDims} dims)\n` +
              `Use --strategy=reindex to re-embed with the local model.`,
          );
        }
        strategy = "strict";
      } else {
        strategy = options.strategy;
      }

      // ── Build diff ────────────────────────────────────────────────────────
      const remoteSources = await sourceDb.listSources();
      const diff = await this.buildDiff(destDb, remoteSources, include, exclude);

      const summary: MergeSummary = {
        strategy,
        dryRun,
        diff,
        sourcesAdded: 0,
        sourcesUpdated: 0,
        sourcesSkipped: diff.identical.length,
        errors: [],
      };

      if (dryRun) {
        return summary;
      }

      // ── Apply: sources to add ─────────────────────────────────────────────
      for (const remote of diff.toAdd) {
        try {
          await this.importSource(destDb, sourceDb, remote, strategy, options.embedder);
          summary.sourcesAdded++;
          onProgress?.({ path: remote.path, status: "added" });
        } catch (err) {
          summary.errors.push({ path: remote.path, error: String(err) });
          onProgress?.({ path: remote.path, status: "error", reason: String(err) });
        }
      }

      // ── Apply: conflicting sources ────────────────────────────────────────
      for (const remote of diff.toUpdate) {
        if (onConflict === "skip" || onConflict === "prefer-local") {
          summary.sourcesSkipped++;
          onProgress?.({ path: remote.path, status: "skipped", reason: "conflict: kept local" });
          continue;
        }

        // prefer-remote: overwrite local
        try {
          const existing = await destDb.getSource(remote.path);
          if (existing) {
            await destDb.removeChunksBySource(existing.id);
          }
          await this.importSource(destDb, sourceDb, remote, strategy, options.embedder, existing?.id);
          summary.sourcesUpdated++;
          onProgress?.({ path: remote.path, status: "updated" });
        } catch (err) {
          summary.errors.push({ path: remote.path, error: String(err) });
          onProgress?.({ path: remote.path, status: "error", reason: String(err) });
        }
      }

      // Skipped (identical)
      for (const src of diff.identical) {
        onProgress?.({ path: src.path, status: "skipped", reason: "identical" });
      }

      // ── Record merge history ──────────────────────────────────────────────
      await destDb.addMergeHistory({
        sourcePath: sourceDbPath,
        mergedAt: Date.now(),
        strategy,
        sourcesAdded: summary.sourcesAdded,
        sourcesUpdated: summary.sourcesUpdated,
        sourcesSkipped: summary.sourcesSkipped,
      });

      return summary;
    } finally {
      await sourceDb.close();
    }
  }

  // ---------------------------------------------------------------------------
  // diff (public helper — can be used standalone for `ragclaw diff`)
  // ---------------------------------------------------------------------------

  async diff(
    destDb: Store,
    sourceDbPath: string,
    include?: string[],
    exclude?: string[],
  ): Promise<MergeDiff & { embedderMatch: boolean; srcEmbedder: string; destEmbedder: string }> {
    const sourceDb = new Store();
    await sourceDb.open(sourceDbPath);

    try {
      const destMeta = await destDb.getAllMeta();
      const srcMeta = await sourceDb.getAllMeta();
      const destEmbedder = `${destMeta.embedder_name ?? "nomic"} (${destMeta.embedder_dimensions ?? "768"} dims)`;
      const srcEmbedder = `${srcMeta.embedder_name ?? "nomic"} (${srcMeta.embedder_dimensions ?? "768"} dims)`;
      const embedderMatch =
        (destMeta.embedder_name ?? "nomic") === (srcMeta.embedder_name ?? "nomic") &&
        (destMeta.embedder_dimensions ?? "768") === (srcMeta.embedder_dimensions ?? "768");

      const remoteSources = await sourceDb.listSources();
      const baseDiff = await this.buildDiff(destDb, remoteSources, include, exclude);

      return { ...baseDiff, embedderMatch, srcEmbedder, destEmbedder };
    } finally {
      await sourceDb.close();
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async buildDiff(
    destDb: Store,
    remoteSources: SourceRecord[],
    include?: string[],
    exclude?: string[],
  ): Promise<MergeDiff> {
    const toAdd: SourceRecord[] = [];
    const toUpdate: SourceRecord[] = [];
    const identical: SourceRecord[] = [];

    const localSources = await destDb.listSources();
    const localByPath = new Map(localSources.map((s) => [s.path, s]));

    for (const remote of remoteSources) {
      // Apply path filters
      if (include && include.length > 0) {
        if (!include.some((p) => remote.path.startsWith(p.replace(/\*\*$/, "")))) continue;
      }
      if (exclude && exclude.length > 0) {
        if (exclude.some((p) => remote.path.startsWith(p.replace(/\*\*$/, "")))) continue;
      }

      const local = localByPath.get(remote.path);
      if (!local) {
        toAdd.push(remote);
      } else if (local.contentHash !== remote.contentHash) {
        toUpdate.push(remote);
      } else {
        identical.push(remote);
      }
    }

    // localOnly = sources that exist locally but not in remote (after filter)
    const remotePaths = new Set(remoteSources.map((s) => s.path));
    const localOnly = localSources.filter((s) => !remotePaths.has(s.path));

    return { toAdd, toUpdate, identical, localOnly };
  }

  /**
   * Import a single source (and its chunks) from `sourceDb` into `destDb`.
   *
   * - `strict`:  copies chunk records verbatim including raw embedding blobs.
   * - `reindex`: copies chunk text only, re-embeds with `embedder`.
   *
   * When `existingId` is provided the source record is updated in-place;
   * otherwise a new record is inserted.
   */
  private async importSource(
    destDb: Store,
    sourceDb: Store,
    remote: SourceRecord,
    strategy: MergeStrategy,
    embedder?: EmbedderPlugin,
    existingId?: string,
  ): Promise<void> {
    const remoteChunks = await sourceDb.getChunksBySource(remote.id);

    // Upsert the source record
    let destSourceId: string;
    if (existingId) {
      await destDb.updateSource(existingId, {
        contentHash: remote.contentHash,
        mtime: remote.mtime,
        indexedAt: remote.indexedAt,
        metadata: remote.metadata,
      });
      destSourceId = existingId;
    } else {
      destSourceId = await destDb.addSource({
        path: remote.path,
        type: remote.type,
        contentHash: remote.contentHash,
        mtime: remote.mtime,
        indexedAt: remote.indexedAt,
        metadata: remote.metadata,
      });
    }

    if (remoteChunks.length === 0) return;

    let chunkRecords: ChunkRecord[];

    if (strategy === "strict") {
      // Copy verbatim — remap IDs and source reference
      const now = Date.now();
      chunkRecords = remoteChunks.map((c) => ({
        ...c,
        id: randomUUID(),
        sourceId: destSourceId,
        sourcePath: remote.path,
        createdAt: now,
      }));
    } else {
      // reindex: re-embed chunk texts with the local embedder
      if (!embedder) throw new Error("embedder required for reindex strategy");

      const texts = remoteChunks.map((c) => c.text);
      const embeddings = await embedder.embedBatch(texts);
      const now = Date.now();

      chunkRecords = remoteChunks.map((c, i) => ({
        ...c,
        id: randomUUID(),
        sourceId: destSourceId,
        sourcePath: remote.path,
        embedding: embeddings[i],
        createdAt: now,
      }));
    }

    await destDb.addChunks(chunkRecords);
  }
}