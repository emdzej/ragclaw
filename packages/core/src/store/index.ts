/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type {
  ChunkRecord,
  SearchQuery,
  SearchResult,
  SourceRecord,
  StoreConfig,
  StoreStats,
} from "../types.js";
import { cosineSimilarity } from "../utils/math.js";

/**
 * Explicit column list for search result hydration — excludes `embedding`
 * to avoid transferring large BLOBs that are never needed in results.
 */
const CHUNK_COLS = "c.id, c.source_id, c.text, c.start_line, c.end_line, c.metadata, c.created_at";

const SCHEMA = `
-- Source files/URLs tracking
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  content_hash TEXT,
  mtime INTEGER,
  indexed_at INTEGER NOT NULL,
  metadata TEXT
);

-- Indexed chunks
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  start_line INTEGER,
  end_line INTEGER,
  metadata TEXT,
  embedding BLOB,
  created_at INTEGER NOT NULL
);

-- Store-level key/value metadata (embedder name, dimensions, etc.)
CREATE TABLE IF NOT EXISTS store_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Merge history
CREATE TABLE IF NOT EXISTS merge_history (
  id TEXT PRIMARY KEY,
  source_path TEXT NOT NULL,
  merged_at INTEGER NOT NULL,
  strategy TEXT NOT NULL,
  sources_added INTEGER NOT NULL DEFAULT 0,
  sources_updated INTEGER NOT NULL DEFAULT 0,
  sources_skipped INTEGER NOT NULL DEFAULT 0
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source_id);
CREATE INDEX IF NOT EXISTS idx_sources_path ON sources(path);
-- Speeds up listSources() ORDER BY indexed_at DESC and getStats() MAX(indexed_at)
CREATE INDEX IF NOT EXISTS idx_sources_indexed_at ON sources(indexed_at);

-- Full-text search — unicode61 tokenizer (exact word matches, fast)
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  id,
  text,
  content=chunks,
  content_rowid=rowid
);

-- Full-text search — trigram tokenizer (fuzzy / substring / typo-tolerant)
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts_trigram USING fts5(
  id,
  text,
  content=chunks,
  content_rowid=rowid,
  tokenize="trigram"
);

-- FTS auto-sync triggers (both tables kept in sync with chunks)
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, id, text) VALUES (NEW.rowid, NEW.id, NEW.text);
  INSERT INTO chunks_fts_trigram(rowid, id, text) VALUES (NEW.rowid, NEW.id, NEW.text);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, id, text) VALUES('delete', OLD.rowid, OLD.id, OLD.text);
  INSERT INTO chunks_fts_trigram(chunks_fts_trigram, rowid, id, text) VALUES('delete', OLD.rowid, OLD.id, OLD.text);
END;

CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, id, text) VALUES('delete', OLD.rowid, OLD.id, OLD.text);
  INSERT INTO chunks_fts(rowid, id, text) VALUES (NEW.rowid, NEW.id, NEW.text);
  INSERT INTO chunks_fts_trigram(chunks_fts_trigram, rowid, id, text) VALUES('delete', OLD.rowid, OLD.id, OLD.text);
  INSERT INTO chunks_fts_trigram(rowid, id, text) VALUES (NEW.rowid, NEW.id, NEW.text);
END;
`;

export class Store {
  private db: Database.Database | null = null;
  private dbPath: string = "";
  private hasVec: boolean = false;
  private vecLoadedFrom: "npm" | "system" | null = null;
  private config: Required<StoreConfig>;

  constructor(config: StoreConfig = {}) {
    this.config = {
      vectorWeight: config.vectorWeight ?? 0.7,
      keywordWeight: config.keywordWeight ?? 0.3,
    };
  }

  async open(path: string): Promise<void> {
    this.dbPath = path;
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");

    // Initialize schema
    this.db.exec(SCHEMA);

    // Migrate legacy databases: write nomic defaults if no embedder meta exists
    this.migrateLegacyMeta();

    // Backfill the trigram FTS index for databases created before it was added
    this.migrateTrigramIndex();

    // Try to load sqlite-vec extension
    await this.tryLoadVec();

    if (!this.hasVec) {
      // Emit once at open time so users know about the performance trade-off.
      console.warn(
        "[ragclaw] sqlite-vec is not available — vector search will fall back to a slower JS implementation.\n" +
          "  To enable fast native vector search, install the sqlite-vec package:\n" +
          "    npm install -g @emdzej/ragclaw-cli   (already bundles sqlite-vec)\n" +
          "    — or —\n" +
          "    npm install sqlite-vec               (for programmatic use of @emdzej/ragclaw-core)\n" +
          "  The JS fallback is functionally correct but becomes noticeably slow above ~5 000 chunks."
      );
    }
  }

  /**
   * Write nomic defaults into store_meta for legacy databases that were
   * created before the embedder plugin system existed.
   *
   * Only runs when ALL of these conditions are true:
   *   1. `embedder_name` is not yet set in store_meta (the DB has no embedder recorded)
   *   2. The database already contains chunks (it is a legacy DB, not a brand-new one)
   *
   * Condition 2 prevents newly-created databases from being pre-seeded with
   * nomic defaults, which would block the user from indexing with a different
   * embedder on the very first `ragclaw add` invocation.
   */
  private migrateLegacyMeta(): void {
    if (!this.db) return;

    const existing = this.db
      .prepare("SELECT value FROM store_meta WHERE key = 'embedder_name'")
      .get() as { value: string } | undefined;

    if (!existing) {
      // Only backfill if the DB already has chunks — i.e., it is a real legacy
      // database, not an empty newly-created one.
      const hasChunks = this.db.prepare("SELECT 1 FROM chunks LIMIT 1").get() as undefined | object;
      if (!hasChunks) return;

      const insert = this.db.prepare("INSERT OR IGNORE INTO store_meta (key, value) VALUES (?, ?)");
      const migrate = this.db.transaction(() => {
        insert.run("embedder_name", "nomic");
        insert.run("embedder_model", "nomic-ai/nomic-embed-text-v1.5");
        insert.run("embedder_dimensions", "768");
      });
      migrate();
    }
  }

  /**
   * Backfill the trigram FTS index for databases that were created before the
   * `chunks_fts_trigram` table was introduced.
   *
   * Detection: if `fts_trigram_built` is already in `store_meta` the table has
   * been populated — skip.  Otherwise, run a content-table rebuild which
   * re-reads every row from `chunks` without touching the data itself.
   */
  private migrateTrigramIndex(): void {
    if (!this.db) return;

    const alreadyBuilt = this.db
      .prepare("SELECT 1 FROM store_meta WHERE key = 'fts_trigram_built'")
      .get();
    if (alreadyBuilt) return;

    // Only rebuild when there are actually chunks to populate the index with.
    const hasChunks = this.db.prepare("SELECT 1 FROM chunks LIMIT 1").get();
    if (!hasChunks) {
      // Mark as done so we don't attempt the rebuild on every open of a new DB.
      this.db
        .prepare("INSERT OR IGNORE INTO store_meta (key, value) VALUES (?, ?)")
        .run("fts_trigram_built", "1");
      return;
    }

    // Rebuild re-reads from the content table (chunks) — no data is modified.
    this.db.exec("INSERT INTO chunks_fts_trigram(chunks_fts_trigram) VALUES('rebuild')");
    this.db
      .prepare("INSERT OR IGNORE INTO store_meta (key, value) VALUES (?, ?)")
      .run("fts_trigram_built", "1");
  }

  private async tryLoadVec(): Promise<void> {
    if (!this.db) return;

    // Read stored dimensions — fall back to 768 if not set yet
    const dimRow = this.db
      .prepare("SELECT value FROM store_meta WHERE key = 'embedder_dimensions'")
      .get() as { value: string } | undefined;
    const dim = dimRow ? parseInt(dimRow.value, 10) : 768;

    // ── Step 1: try loading via the sqlite-vec npm package ───────────────────
    // The package ships prebuilt binaries and calls db.loadExtension() internally.
    try {
      // sqlite-vec is an optional dependency and may not be installed
      const sqliteVec = await import("sqlite-vec");
      sqliteVec.load(this.db);
      this.vecLoadedFrom = "npm";
    } catch {
      // sqlite-vec npm package not installed — that's fine, try system extension next.
    }

    // ── Step 2: verify vec0 actually works (also handles system-installed ext) ─
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
          id TEXT PRIMARY KEY,
          embedding FLOAT[${dim}]
        );
      `);
      this.hasVec = true;
      if (!this.vecLoadedFrom) this.vecLoadedFrom = "system";
    } catch {
      // Extension not available either way — will use JS fallback.
      this.hasVec = false;
      this.vecLoadedFrom = null;
    }
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Store Metadata
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Read a single metadata value by key.
   * Returns `null` if the key does not exist.
   */
  async getMeta(key: string): Promise<string | null> {
    if (!this.db) throw new Error("Store not opened");
    const row = this.db.prepare("SELECT value FROM store_meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  /**
   * Write (upsert) a metadata key/value pair.
   */
  async setMeta(key: string, value: string): Promise<void> {
    if (!this.db) throw new Error("Store not opened");
    this.db.prepare("INSERT OR REPLACE INTO store_meta (key, value) VALUES (?, ?)").run(key, value);
  }

  /**
   * Return all metadata as a plain object.
   */
  async getAllMeta(): Promise<Record<string, string>> {
    if (!this.db) throw new Error("Store not opened");
    const rows = this.db.prepare("SELECT key, value FROM store_meta").all() as {
      key: string;
      value: string;
    }[];
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Sources
  // ─────────────────────────────────────────────────────────────────────────────

  async addSource(source: Omit<SourceRecord, "id">): Promise<string> {
    if (!this.db) throw new Error("Store not opened");

    const id = randomUUID();
    const stmt = this.db.prepare(`
      INSERT INTO sources (id, path, type, content_hash, mtime, indexed_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      source.path,
      source.type,
      source.contentHash,
      source.mtime ?? null,
      source.indexedAt,
      source.metadata ? JSON.stringify(source.metadata) : null
    );

    return id;
  }

  async getSource(path: string): Promise<SourceRecord | null> {
    if (!this.db) throw new Error("Store not opened");

    const row = this.db.prepare("SELECT * FROM sources WHERE path = ?").get(path) as
      | Record<string, unknown>
      | undefined;

    if (!row) return null;

    return {
      id: row.id as string,
      path: row.path as string,
      type: row.type as SourceRecord["type"],
      contentHash: row.content_hash as string,
      mtime: row.mtime as number | undefined,
      indexedAt: row.indexed_at as number,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
    };
  }

  async updateSource(id: string, updates: Partial<SourceRecord>): Promise<void> {
    if (!this.db) throw new Error("Store not opened");

    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.contentHash !== undefined) {
      fields.push("content_hash = ?");
      values.push(updates.contentHash);
    }
    if (updates.mtime !== undefined) {
      fields.push("mtime = ?");
      values.push(updates.mtime);
    }
    if (updates.indexedAt !== undefined) {
      fields.push("indexed_at = ?");
      values.push(updates.indexedAt);
    }
    if (updates.metadata !== undefined) {
      fields.push("metadata = ?");
      values.push(JSON.stringify(updates.metadata));
    }

    if (fields.length === 0) return;

    values.push(id);
    this.db.prepare(`UPDATE sources SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  }

  async removeSource(id: string): Promise<void> {
    if (!this.db) throw new Error("Store not opened");

    // Chunks are deleted via CASCADE
    this.db.prepare("DELETE FROM sources WHERE id = ?").run(id);

    // Also remove from vec table if available
    if (this.hasVec) {
      try {
        this.db
          .prepare("DELETE FROM chunks_vec WHERE id IN (SELECT id FROM chunks WHERE source_id = ?)")
          .run(id);
      } catch {
        // Ignore vec errors
      }
    }
  }

  async listSources(): Promise<SourceRecord[]> {
    if (!this.db) throw new Error("Store not opened");

    const rows = this.db.prepare("SELECT * FROM sources ORDER BY indexed_at DESC").all() as Record<
      string,
      unknown
    >[];

    return rows.map((row) => ({
      id: row.id as string,
      path: row.path as string,
      type: row.type as SourceRecord["type"],
      contentHash: row.content_hash as string,
      mtime: row.mtime as number | undefined,
      indexedAt: row.indexed_at as number,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
    }));
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Chunks
  // ─────────────────────────────────────────────────────────────────────────────

  async addChunks(chunks: ChunkRecord[]): Promise<void> {
    if (!this.db) throw new Error("Store not opened");

    const insertChunk = this.db.prepare(`
      INSERT INTO chunks (id, source_id, text, start_line, end_line, metadata, embedding, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertVec = this.hasVec
      ? this.db.prepare("INSERT INTO chunks_vec (id, embedding) VALUES (?, ?)")
      : null;

    const transaction = this.db.transaction((chunks: ChunkRecord[]) => {
      for (const chunk of chunks) {
        const embeddingBlob = chunk.embedding ? Buffer.from(chunk.embedding.buffer) : null;

        insertChunk.run(
          chunk.id,
          chunk.sourceId,
          chunk.text,
          chunk.startLine ?? null,
          chunk.endLine ?? null,
          JSON.stringify(chunk.metadata),
          embeddingBlob,
          chunk.createdAt
        );

        if (insertVec && chunk.embedding) {
          try {
            insertVec.run(chunk.id, embeddingBlob);
          } catch {
            // Ignore vec errors
          }
        }
      }
    });

    transaction(chunks);
  }

  async removeChunksBySource(sourceId: string): Promise<void> {
    if (!this.db) throw new Error("Store not opened");

    if (this.hasVec) {
      try {
        this.db
          .prepare("DELETE FROM chunks_vec WHERE id IN (SELECT id FROM chunks WHERE source_id = ?)")
          .run(sourceId);
      } catch {
        // Ignore vec errors
      }
    }

    this.db.prepare("DELETE FROM chunks WHERE source_id = ?").run(sourceId);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Search
  // ─────────────────────────────────────────────────────────────────────────────

  async search(query: SearchQuery): Promise<SearchResult[]> {
    if (!this.db) throw new Error("Store not opened");

    const limit = query.limit ?? 10;
    const mode = query.mode ?? "hybrid";

    if (mode === "keyword") {
      return this.keywordSearch(query.text, limit);
    }

    if (mode === "vector") {
      if (!query.embedding) {
        throw new Error("Vector search requires embedding");
      }
      return this.vectorSearch(query.embedding, limit);
    }

    // Hybrid search — use deferred hydration for efficiency:
    // 1. Score each leg independently (lightweight — no full row hydration)
    // 2. Merge IDs via RRF
    // 3. Hydrate only the final winners in a single query
    if (!query.embedding) {
      throw new Error("Hybrid search requires embedding");
    }

    const vectorScored = await this.vectorScoreOnly(query.embedding, limit * 2);
    const keywordScored = await this.keywordScoreOnly(query.text, limit * 2);

    const mergedIds = this.mergeScored(vectorScored, keywordScored, limit);

    if (mergedIds.length === 0) return [];
    return this.hydrateResults(mergedIds);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Deferred-hydration helpers (hybrid mode only)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Return lightweight `{id, score}` pairs from vector search without
   * hydrating full chunk rows.  Uses native sqlite-vec when available,
   * falling back to the JS cosine scan.
   */
  private async vectorScoreOnly(
    embedding: Float32Array,
    limit: number
  ): Promise<{ id: string; score: number }[]> {
    if (!this.db) throw new Error("Store not opened");

    if (this.hasVec) {
      try {
        const embeddingBlob = Buffer.from(embedding.buffer);
        const rows = this.db
          .prepare(`
            SELECT v.id, vec_distance_cosine(v.embedding, ?) AS dist
            FROM chunks_vec v
            ORDER BY dist ASC
            LIMIT ?
          `)
          .all(embeddingBlob, limit) as { id: string; dist: number }[];

        return rows.map((r) => ({ id: r.id, score: 1 - r.dist }));
      } catch {
        // Fall through to JS fallback
      }
    }

    // JS fallback — score every embedding, keep top-K
    const rows = this.db
      .prepare("SELECT id, embedding FROM chunks WHERE embedding IS NOT NULL")
      .all() as { id: string; embedding: Buffer }[];

    if (rows.length === 0) return [];

    const scored: { id: string; score: number }[] = new Array(rows.length);
    for (let i = 0; i < rows.length; i++) {
      const buf = rows[i].embedding;
      const chunkEmbedding = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
      scored[i] = { id: rows[i].id, score: cosineSimilarity(embedding, chunkEmbedding) };
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  /**
   * Return lightweight `{id, score}` pairs from keyword (FTS5) search
   * without hydrating full chunk rows.  Merges exact and trigram legs,
   * normalises BM25 to [0, 1].
   */
  private keywordScoreOnly(text: string, limit: number): { id: string; score: number }[] {
    if (!this.db) throw new Error("Store not opened");

    // Build prefix-token query for unicode61 index (OR join)
    const words = text
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w.replace(/['"*]/g, ""))
      .filter((w) => w.length > 0);
    const prefixQuery = words.map((w) => `${w}*`).join(" OR ");

    // Build trigram query
    const trigramQuery = text.trim().replace(/['"]/g, "");

    // ── Exact / prefix leg ──────────────────────────────────────────────
    let exactRows: { id: string; rank: number }[] = [];
    if (prefixQuery.length > 0) {
      try {
        exactRows = this.db
          .prepare(`
            SELECT fts.id, bm25(chunks_fts) AS rank
            FROM chunks_fts fts
            WHERE chunks_fts MATCH ?
            ORDER BY rank
            LIMIT ?
          `)
          .all(prefixQuery, limit) as { id: string; rank: number }[];
      } catch {
        // Malformed query — skip
      }
    }

    // ── Trigram leg ─────────────────────────────────────────────────────
    let trigramRows: { id: string; rank: number }[] = [];
    if (trigramQuery.length >= 3) {
      try {
        trigramRows = this.db
          .prepare(`
            SELECT fts.id, bm25(chunks_fts_trigram) AS rank
            FROM chunks_fts_trigram fts
            WHERE chunks_fts_trigram MATCH ?
            ORDER BY rank
            LIMIT ?
          `)
          .all(trigramQuery, limit) as { id: string; rank: number }[];
      } catch {
        // Trigram table may not be populated — skip
      }
    }

    // ── Merge: deduplicate by id, keep better BM25 rank ────────────────
    const best = new Map<string, number>();
    for (const row of [...exactRows, ...trigramRows]) {
      const existing = best.get(row.id);
      if (existing === undefined || Math.abs(row.rank) < Math.abs(existing)) {
        best.set(row.id, row.rank);
      }
    }

    // Sort by rank ascending (more negative = better match), trim to limit
    const merged = Array.from(best.entries())
      .sort((a, b) => a[1] - b[1])
      .slice(0, limit);

    if (merged.length === 0) return [];

    // Normalise BM25 scores to [0, 1]
    const maxRank = Math.max(...merged.map(([, r]) => Math.abs(r)), 1);
    return merged.map(([id, rank]) => ({
      id,
      score: 1 - Math.abs(rank) / maxRank,
    }));
  }

  /**
   * Merge lightweight scored arrays via Reciprocal Rank Fusion (RRF).
   *
   * Returns `{id, score, scoreVector?, scoreKeyword?}` tuples sorted by
   * descending RRF score, trimmed to `limit`.
   */
  private mergeScored(
    vectorScored: { id: string; score: number }[],
    keywordScored: { id: string; score: number }[],
    limit: number,
    k = 60
  ): { id: string; score: number; scoreVector?: number; scoreKeyword?: number }[] {
    const scores = new Map<
      string,
      { rrfScore: number; scoreVector?: number; scoreKeyword?: number }
    >();

    // Vector leg
    for (let rank = 0; rank < vectorScored.length; rank++) {
      const r = vectorScored[rank];
      const contribution = this.config.vectorWeight / (k + rank + 1);
      scores.set(r.id, {
        rrfScore: contribution,
        scoreVector: r.score,
      });
    }

    // Keyword leg
    for (let rank = 0; rank < keywordScored.length; rank++) {
      const r = keywordScored[rank];
      const contribution = this.config.keywordWeight / (k + rank + 1);
      const existing = scores.get(r.id);
      if (existing) {
        existing.rrfScore += contribution;
        existing.scoreKeyword = r.score;
      } else {
        scores.set(r.id, {
          rrfScore: contribution,
          scoreKeyword: r.score,
        });
      }
    }

    return Array.from(scores.entries())
      .map(([id, s]) => ({
        id,
        score: s.rrfScore,
        scoreVector: s.scoreVector,
        scoreKeyword: s.scoreKeyword,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Hydrate the final winner IDs into full `SearchResult[]` with a single
   * bulk query.  Preserves the incoming order and scores.
   */
  private hydrateResults(
    mergedIds: { id: string; score: number; scoreVector?: number; scoreKeyword?: number }[]
  ): SearchResult[] {
    if (!this.db) throw new Error("Store not opened");
    if (mergedIds.length === 0) return [];

    const placeholders = mergedIds.map(() => "?").join(", ");
    const ids = mergedIds.map((r) => r.id);

    const rows = this.db
      .prepare(`
        SELECT ${CHUNK_COLS}, s.path AS source_path
        FROM chunks c
        JOIN sources s ON s.id = c.source_id
        WHERE c.id IN (${placeholders})
      `)
      .all(...ids) as Record<string, unknown>[];

    // Index by id for O(1) lookup
    const rowById = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      rowById.set(row.id as string, row);
    }

    // Build results in the ranked order from mergedIds
    const results: SearchResult[] = [];
    for (const entry of mergedIds) {
      const row = rowById.get(entry.id);
      if (!row) continue; // shouldn't happen — stale vec index entry
      results.push({
        chunk: this.rowToChunk(row),
        score: entry.score,
        scoreVector: entry.scoreVector,
        scoreKeyword: entry.scoreKeyword,
      });
    }

    return results;
  }

  private async vectorSearch(embedding: Float32Array, limit: number): Promise<SearchResult[]> {
    if (!this.db) throw new Error("Store not opened");

    if (this.hasVec) {
      return this.vectorSearchNative(embedding, limit);
    }

    return this.vectorSearchFallback(embedding, limit);
  }

  private vectorSearchNative(embedding: Float32Array, limit: number): SearchResult[] {
    if (!this.db) throw new Error("Store not opened");

    try {
      const embeddingBlob = Buffer.from(embedding.buffer);
      const rows = this.db
        .prepare(`
        SELECT ${CHUNK_COLS}, s.path AS source_path, vec_distance_cosine(v.embedding, ?) AS dist
        FROM chunks_vec v
        JOIN chunks c ON c.id = v.id
        JOIN sources s ON s.id = c.source_id
        ORDER BY dist ASC
        LIMIT ?
      `)
        .all(embeddingBlob, limit) as Record<string, unknown>[];

      return rows.map((row) => ({
        chunk: this.rowToChunk(row),
        score: 1 - (row.dist as number), // Convert distance to similarity
        scoreVector: 1 - (row.dist as number),
      }));
    } catch {
      // Fall back to JS if native fails
      return this.vectorSearchFallback(embedding, limit);
    }
  }

  private vectorSearchFallback(embedding: Float32Array, limit: number): SearchResult[] {
    if (!this.db) throw new Error("Store not opened");

    // ── Pass 1: score every embedding in a tight loop ──────────────────
    // Only fetch id + raw embedding blob to minimise memory and avoid
    // JSON.parse / rowToChunk overhead for the vast majority of rows that
    // won't make it into the final result set.
    const rows = this.db
      .prepare("SELECT id, embedding FROM chunks WHERE embedding IS NOT NULL")
      .all() as { id: string; embedding: Buffer }[];

    if (rows.length === 0) return [];

    // Warn once per search when the dataset is large.
    if (rows.length > 5_000) {
      console.warn(
        `[ragclaw] JS fallback vector search is scanning ${rows.length.toLocaleString()} chunks — ` +
          `this will be slow. Install the sqlite-vec package for native ANN search:\n` +
          `  npm install -g @emdzej/ragclaw-cli   (already bundles sqlite-vec)\n` +
          `  npm install sqlite-vec               (for programmatic use)`
      );
    }

    // Score all rows — keep only the top-K ids.
    const scored: { id: string; similarity: number }[] = new Array(rows.length);
    for (let i = 0; i < rows.length; i++) {
      const buf = rows[i].embedding;
      const chunkEmbedding = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
      scored[i] = { id: rows[i].id, similarity: cosineSimilarity(embedding, chunkEmbedding) };
    }

    scored.sort((a, b) => b.similarity - a.similarity);
    const topK = scored.slice(0, limit);

    if (topK.length === 0) return [];

    // ── Pass 2: hydrate only the winners ───────────────────────────────
    const placeholders = topK.map(() => "?").join(", ");
    const ids = topK.map((r) => r.id);
    const fullRows = this.db
      .prepare(`
      SELECT ${CHUNK_COLS}, s.path AS source_path
      FROM chunks c
      JOIN sources s ON s.id = c.source_id
      WHERE c.id IN (${placeholders})
    `)
      .all(...ids) as Record<string, unknown>[];

    // Index by id for quick lookup.
    const rowById = new Map<string, Record<string, unknown>>();
    for (const row of fullRows) {
      rowById.set(row.id as string, row);
    }

    // Build results in scored order.
    const results: SearchResult[] = [];
    for (const { id, similarity } of topK) {
      const row = rowById.get(id);
      if (!row) continue; // shouldn't happen
      results.push({
        chunk: this.rowToChunk(row),
        score: similarity,
        scoreVector: similarity,
      });
    }

    return results;
  }

  private async keywordSearch(text: string, limit: number): Promise<SearchResult[]> {
    if (!this.db) throw new Error("Store not opened");

    // Build a prefix-token query for the unicode61 (exact) index.
    // Each whitespace-separated word becomes a prefix token (word*) joined
    // with OR so that compound queries ("auth and migration") match chunks
    // about either topic.  BM25 naturally boosts chunks matching more terms.
    const words = text
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w.replace(/['"*]/g, ""))
      .filter((w) => w.length > 0);
    const prefixQuery = words.map((w) => `${w}*`).join(" OR ");

    // Build a trigram query for the fuzzy index.
    // Trigrams do not support the * operator — pass the raw text, but strip
    // FTS5 special chars to avoid syntax errors.
    const trigramQuery = text.trim().replace(/['"]/g, "");

    // ── Exact / prefix leg (unicode61 BM25) ─────────────────────────────────
    let exactRows: Record<string, unknown>[] = [];
    if (prefixQuery.length > 0) {
      try {
        exactRows = this.db
          .prepare(`
            SELECT ${CHUNK_COLS}, s.path AS source_path, bm25(chunks_fts) AS rank
            FROM chunks_fts fts
            JOIN chunks c ON c.id = fts.id
            JOIN sources s ON s.id = c.source_id
            WHERE chunks_fts MATCH ?
            ORDER BY rank
            LIMIT ?
          `)
          .all(prefixQuery, limit) as Record<string, unknown>[];
      } catch {
        // Malformed query (e.g. query too short for some edge cases) — skip.
      }
    }

    // ── Trigram leg (fuzzy / typo-tolerant) ─────────────────────────────────
    // Trigram tokenizer requires at least 3 characters; skip for very short input.
    let trigramRows: Record<string, unknown>[] = [];
    if (trigramQuery.length >= 3) {
      try {
        trigramRows = this.db
          .prepare(`
            SELECT ${CHUNK_COLS}, s.path AS source_path, bm25(chunks_fts_trigram) AS rank
            FROM chunks_fts_trigram fts
            JOIN chunks c ON c.id = fts.id
            JOIN sources s ON s.id = c.source_id
            WHERE chunks_fts_trigram MATCH ?
            ORDER BY rank
            LIMIT ?
          `)
          .all(trigramQuery, limit) as Record<string, unknown>[];
      } catch {
        // Trigram table may not be populated yet on the first open — skip.
      }
    }

    // ── Merge: deduplicate by chunk id, keep higher BM25 rank ───────────────
    // BM25 is negative (more negative = better match); lower abs = better.
    const best = new Map<string, Record<string, unknown>>();
    for (const row of [...exactRows, ...trigramRows]) {
      const id = row.id as string;
      const existing = best.get(id);
      if (!existing || Math.abs(row.rank as number) < Math.abs(existing.rank as number)) {
        best.set(id, row);
      }
    }

    const merged = Array.from(best.values());
    // Re-sort by rank (ascending — more negative is better) and trim to limit.
    merged.sort((a, b) => (a.rank as number) - (b.rank as number));
    const rows = merged.slice(0, limit);

    // Normalize BM25 scores to [0, 1]: best result → 1.0, worst → 0.0.
    const maxRank = Math.max(...rows.map((r) => Math.abs(r.rank as number)), 1);

    return rows.map((row) => ({
      chunk: this.rowToChunk(row),
      score: 1 - Math.abs(row.rank as number) / maxRank,
      scoreKeyword: 1 - Math.abs(row.rank as number) / maxRank,
    }));
  }

  private rowToChunk(row: Record<string, unknown>): ChunkRecord {
    return {
      id: row.id as string,
      sourceId: row.source_id as string,
      sourcePath: (row.source_path as string) ?? "",
      text: row.text as string,
      startLine: row.start_line as number | undefined,
      endLine: row.end_line as number | undefined,
      metadata: JSON.parse(row.metadata as string),
      embedding: row.embedding ? new Float32Array(row.embedding as ArrayBuffer) : undefined,
      createdAt: row.created_at as number,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Merge support — raw access used by MergeService
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Return all chunk records for a given source path (the path/URL shown in
   * search results), ordered by start_line so the caller can reconstruct the
   * original document.  Embeddings are omitted for efficiency.
   */
  async getChunksBySourcePath(sourcePath: string): Promise<ChunkRecord[]> {
    if (!this.db) throw new Error("Store not opened");
    const rows = this.db
      .prepare(`
        SELECT c.id, c.source_id, c.text, c.start_line, c.end_line,
               c.metadata, c.created_at, s.path AS source_path
        FROM chunks c
        JOIN sources s ON s.id = c.source_id
        WHERE s.path = ?
        ORDER BY c.start_line ASC, c.rowid ASC
      `)
      .all(sourcePath) as Record<string, unknown>[];
    return rows.map((row) => this.rowToChunk(row));
  }

  /**
   * Return all chunk records for a given source, including raw embedding blobs.
   * Used by MergeService to copy or re-embed chunks from a source DB.
   */
  async getChunksBySource(sourceId: string): Promise<ChunkRecord[]> {
    if (!this.db) throw new Error("Store not opened");
    const rows = this.db
      .prepare(`
        SELECT c.*, s.path AS source_path
        FROM chunks c
        JOIN sources s ON s.id = c.source_id
        WHERE c.source_id = ?
      `)
      .all(sourceId) as Record<string, unknown>[];
    return rows.map((row) => this.rowToChunk(row));
  }

  /**
   * Insert a merge history record.
   */
  async addMergeHistory(entry: {
    sourcePath: string;
    mergedAt: number;
    strategy: string;
    sourcesAdded: number;
    sourcesUpdated: number;
    sourcesSkipped: number;
  }): Promise<void> {
    if (!this.db) throw new Error("Store not opened");
    this.db
      .prepare(`
        INSERT INTO merge_history
          (id, source_path, merged_at, strategy, sources_added, sources_updated, sources_skipped)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        randomUUID(),
        entry.sourcePath,
        entry.mergedAt,
        entry.strategy,
        entry.sourcesAdded,
        entry.sourcesUpdated,
        entry.sourcesSkipped
      );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Stats
  // ─────────────────────────────────────────────────────────────────────────────

  async getStats(): Promise<StoreStats> {
    if (!this.db) throw new Error("Store not opened");

    const sources = this.db.prepare("SELECT COUNT(*) as count FROM sources").get() as {
      count: number;
    };
    const chunks = this.db.prepare("SELECT COUNT(*) as count FROM chunks").get() as {
      count: number;
    };
    const lastUpdated = this.db.prepare("SELECT MAX(indexed_at) as ts FROM sources").get() as {
      ts: number | null;
    };

    // Get file size
    const fs = await import("node:fs/promises");
    const stat = await fs.stat(this.dbPath);

    return {
      sources: sources.count,
      chunks: chunks.count,
      sizeBytes: stat.size,
      lastUpdated: lastUpdated.ts ?? undefined,
    };
  }

  get hasVectorSupport(): boolean {
    return this.hasVec;
  }

  /** Where the sqlite-vec extension was loaded from, or null if unavailable. */
  get vectorExtensionSource(): "npm" | "system" | null {
    return this.vecLoadedFrom;
  }
}
