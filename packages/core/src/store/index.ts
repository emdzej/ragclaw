import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import type {
  SourceRecord,
  ChunkRecord,
  SearchQuery,
  SearchResult,
  StoreStats,
  StoreConfig,
} from "../types.js";
import { cosineSimilarity } from "../utils/math.js";

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

-- Indexes
CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source_id);
CREATE INDEX IF NOT EXISTS idx_sources_path ON sources(path);
-- Speeds up listSources() ORDER BY indexed_at DESC and getStats() MAX(indexed_at)
CREATE INDEX IF NOT EXISTS idx_sources_indexed_at ON sources(indexed_at);

-- Full-text search (FTS5)
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  id,
  text,
  content=chunks,
  content_rowid=rowid
);

-- FTS triggers for auto-sync
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, id, text) VALUES (NEW.rowid, NEW.id, NEW.text);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, id, text) VALUES('delete', OLD.rowid, OLD.id, OLD.text);
END;

CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, id, text) VALUES('delete', OLD.rowid, OLD.id, OLD.text);
  INSERT INTO chunks_fts(rowid, id, text) VALUES (NEW.rowid, NEW.id, NEW.text);
END;
`;

export class Store {
  private db: Database.Database | null = null;
  private dbPath: string = "";
  private hasVec: boolean = false;
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

    // Try to load sqlite-vec extension
    this.hasVec = this.tryLoadVec();

    if (!this.hasVec) {
      // Emit once at open time so users know about the performance trade-off.
      console.warn(
        "[ragclaw] sqlite-vec extension not available — vector search will use a JS fallback. " +
        "For best performance, install the sqlite-vec extension."
      );
    }
  }

  /**
   * Write nomic defaults into store_meta for legacy databases that were
   * created before the embedder plugin system existed.
   * Only runs if `embedder_name` is not yet set.
   */
  private migrateLegacyMeta(): void {
    if (!this.db) return;

    const existing = this.db
      .prepare("SELECT value FROM store_meta WHERE key = 'embedder_name'")
      .get() as { value: string } | undefined;

    if (!existing) {
      const insert = this.db.prepare(
        "INSERT OR IGNORE INTO store_meta (key, value) VALUES (?, ?)"
      );
      const migrate = this.db.transaction(() => {
        insert.run("embedder_name", "nomic");
        insert.run("embedder_model", "nomic-ai/nomic-embed-text-v1.5");
        insert.run("embedder_dimensions", "768");
      });
      migrate();
    }
  }

  private tryLoadVec(): boolean {
    if (!this.db) return false;

    // Read stored dimensions — fall back to 768 if not set yet
    const dimRow = this.db
      .prepare("SELECT value FROM store_meta WHERE key = 'embedder_dimensions'")
      .get() as { value: string } | undefined;
    const dim = dimRow ? parseInt(dimRow.value, 10) : 768;

    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
          id TEXT PRIMARY KEY,
          embedding FLOAT[${dim}]
        );
      `);
      return true;
    } catch {
      // Extension not available, will use JS fallback
      return false;
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
    const row = this.db
      .prepare("SELECT value FROM store_meta WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  /**
   * Synchronous variant used internally (before async context is available).
   */
  private getMetaSync(key: string): string | null {
    if (!this.db) return null;
    const row = this.db
      .prepare("SELECT value FROM store_meta WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  /**
   * Write (upsert) a metadata key/value pair.
   */
  async setMeta(key: string, value: string): Promise<void> {
    if (!this.db) throw new Error("Store not opened");
    this.db
      .prepare("INSERT OR REPLACE INTO store_meta (key, value) VALUES (?, ?)")
      .run(key, value);
  }

  /**
   * Return all metadata as a plain object.
   */
  async getAllMeta(): Promise<Record<string, string>> {
    if (!this.db) throw new Error("Store not opened");
    const rows = this.db
      .prepare("SELECT key, value FROM store_meta")
      .all() as { key: string; value: string }[];
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

    const row = this.db
      .prepare("SELECT * FROM sources WHERE path = ?")
      .get(path) as Record<string, unknown> | undefined;

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
        this.db.prepare("DELETE FROM chunks_vec WHERE id IN (SELECT id FROM chunks WHERE source_id = ?)").run(id);
      } catch {
        // Ignore vec errors
      }
    }
  }

  async listSources(): Promise<SourceRecord[]> {
    if (!this.db) throw new Error("Store not opened");

    const rows = this.db.prepare("SELECT * FROM sources ORDER BY indexed_at DESC").all() as Record<string, unknown>[];

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
        const embeddingBlob = chunk.embedding
          ? Buffer.from(chunk.embedding.buffer)
          : null;

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
        this.db.prepare("DELETE FROM chunks_vec WHERE id IN (SELECT id FROM chunks WHERE source_id = ?)").run(sourceId);
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

    // Hybrid search
    if (!query.embedding) {
      throw new Error("Hybrid search requires embedding");
    }

    const vectorResults = await this.vectorSearch(query.embedding, limit * 2);
    const keywordResults = await this.keywordSearch(query.text, limit * 2);

    return this.mergeResults(vectorResults, keywordResults, limit);
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
      const rows = this.db.prepare(`
        SELECT c.*, s.path AS source_path, vec_distance_cosine(v.embedding, ?) AS dist
        FROM chunks_vec v
        JOIN chunks c ON c.id = v.id
        JOIN sources s ON s.id = c.source_id
        ORDER BY dist ASC
        LIMIT ?
      `).all(embeddingBlob, limit) as Record<string, unknown>[];

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
    const rows = this.db.prepare(
      "SELECT id, embedding FROM chunks WHERE embedding IS NOT NULL"
    ).all() as { id: string; embedding: Buffer }[];

    if (rows.length === 0) return [];

    // Warn once per search when the dataset is large.
    if (rows.length > 5_000) {
      console.warn(
        `[ragclaw] JS fallback vector search is scanning ${rows.length.toLocaleString()} chunks. ` +
        `Install the sqlite-vec extension for significantly faster search at scale.`
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
    const fullRows = this.db.prepare(`
      SELECT c.*, s.path AS source_path
      FROM chunks c
      JOIN sources s ON s.id = c.source_id
      WHERE c.id IN (${placeholders})
    `).all(...ids) as Record<string, unknown>[];

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

    // Escape special FTS5 characters
    const escapedText = text.replace(/['"]/g, '""');

    const rows = this.db.prepare(`
      SELECT c.*, s.path AS source_path, bm25(chunks_fts) AS rank
      FROM chunks_fts fts
      JOIN chunks c ON c.id = fts.id
      JOIN sources s ON s.id = c.source_id
      WHERE chunks_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(`"${escapedText}"`, limit) as Record<string, unknown>[];

    // Normalize BM25 scores (they're negative, lower is better)
    const maxRank = Math.max(...rows.map((r) => Math.abs(r.rank as number)), 1);

    return rows.map((row) => ({
      chunk: this.rowToChunk(row),
      score: 1 - Math.abs(row.rank as number) / maxRank,
      scoreKeyword: 1 - Math.abs(row.rank as number) / maxRank,
    }));
  }

  private mergeResults(
    vectorResults: SearchResult[],
    keywordResults: SearchResult[],
    limit: number
  ): SearchResult[] {
    const merged = new Map<string, SearchResult>();

    // Add vector results
    for (const result of vectorResults) {
      merged.set(result.chunk.id, {
        ...result,
        score: result.score * this.config.vectorWeight,
      });
    }

    // Merge keyword results
    for (const result of keywordResults) {
      const existing = merged.get(result.chunk.id);
      if (existing) {
        existing.score += result.score * this.config.keywordWeight;
        existing.scoreKeyword = result.scoreKeyword;
      } else {
        merged.set(result.chunk.id, {
          ...result,
          score: result.score * this.config.keywordWeight,
        });
      }
    }

    const results = Array.from(merged.values());
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
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
  // Stats
  // ─────────────────────────────────────────────────────────────────────────────

  async getStats(): Promise<StoreStats> {
    if (!this.db) throw new Error("Store not opened");

    const sources = this.db.prepare("SELECT COUNT(*) as count FROM sources").get() as { count: number };
    const chunks = this.db.prepare("SELECT COUNT(*) as count FROM chunks").get() as { count: number };
    const lastUpdated = this.db.prepare("SELECT MAX(indexed_at) as ts FROM sources").get() as { ts: number | null };

    // Get file size
    const fs = await import("fs/promises");
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
}
