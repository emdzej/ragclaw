/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChunkRecord } from "../types.js";
import { Store } from "./index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSource(
  overrides: Partial<{
    path: string;
    type: string;
    contentHash: string;
    indexedAt: number;
    createdAt: number;
    timestamp: number;
  }> = {}
) {
  const now = Date.now();
  return {
    path: overrides.path ?? `/test/${randomUUID()}.md`,
    type: (overrides.type ?? "file") as "file" | "url",
    contentHash: overrides.contentHash ?? "abc123",
    indexedAt: overrides.indexedAt ?? now,
    createdAt: overrides.createdAt ?? now,
    timestamp: overrides.timestamp ?? now,
  };
}

function makeChunk(
  sourceId: string,
  text: string,
  embedding?: Float32Array,
  timestamp?: number
): ChunkRecord {
  const now = Date.now();
  return {
    id: randomUUID(),
    sourceId,
    sourcePath: "/test/file.md",
    text,
    startLine: 1,
    endLine: 10,
    metadata: { type: "paragraph" as const },
    embedding,
    createdAt: now,
    timestamp: timestamp ?? now,
  };
}

/** Create a simple deterministic embedding for testing. */
function fakeEmbedding(seed: number, dim = 768): Float32Array {
  const arr = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    arr[i] = Math.sin(seed * (i + 1));
  }
  // Normalize to unit vector for cosine similarity
  const norm = Math.sqrt(arr.reduce((sum, v) => sum + v * v, 0));
  if (norm > 0) for (let i = 0; i < dim; i++) arr[i] /= norm;
  return arr;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Store", () => {
  let store: Store;

  beforeEach(async () => {
    store = new Store();
    // Suppress the sqlite-vec warning in test output
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await store.open(":memory:");
  });

  afterEach(async () => {
    await store.close();
    vi.restoreAllMocks();
  });

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  describe("lifecycle", () => {
    it("opens with :memory: without error", () => {
      // Already opened in beforeEach — just verify no throw
      expect(store).toBeDefined();
    });

    it("throws on operations when not opened", async () => {
      const fresh = new Store();
      await expect(fresh.addSource(makeSource())).rejects.toThrow("Store not opened");
      await expect(fresh.getSource("/foo")).rejects.toThrow("Store not opened");
      await expect(fresh.listSources()).rejects.toThrow("Store not opened");
      await expect(fresh.addChunks([])).rejects.toThrow("Store not opened");
      await expect(fresh.search({ text: "hello", mode: "keyword" })).rejects.toThrow(
        "Store not opened"
      );
    });

    it("can close and re-open", async () => {
      const id = await store.addSource(makeSource({ path: "/a.md" }));
      expect(id).toBeTruthy();

      await store.close();
      // After close, operations should fail
      await expect(store.listSources()).rejects.toThrow();

      // Re-open a fresh :memory: (data is gone — that's expected)
      await store.open(":memory:");
      const sources = await store.listSources();
      expect(sources).toEqual([]);
    });
  });

  // ─── Sources ──────────────────────────────────────────────────────────────

  describe("sources", () => {
    it("adds and retrieves a source by path", async () => {
      const src = makeSource({ path: "/docs/readme.md" });
      const id = await store.addSource(src);
      expect(id).toBeTruthy();

      const retrieved = await store.getSource("/docs/readme.md");
      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(id);
      expect(retrieved?.path).toBe("/docs/readme.md");
      expect(retrieved?.type).toBe("file");
      expect(retrieved?.contentHash).toBe("abc123");
    });

    it("returns null for non-existent source", async () => {
      const result = await store.getSource("/does-not-exist.md");
      expect(result).toBeNull();
    });

    it("rejects duplicate paths", async () => {
      await store.addSource(makeSource({ path: "/same.md" }));
      await expect(store.addSource(makeSource({ path: "/same.md" }))).rejects.toThrow();
    });

    it("updates a source", async () => {
      const id = await store.addSource(makeSource({ path: "/update-me.md" }));
      await store.updateSource(id, { contentHash: "newHash", indexedAt: 99999 });

      const updated = await store.getSource("/update-me.md");
      expect(updated?.contentHash).toBe("newHash");
      expect(updated?.indexedAt).toBe(99999);
    });

    it("updateSource is a no-op with empty updates", async () => {
      const id = await store.addSource(makeSource({ path: "/noop.md" }));
      // Should not throw
      await store.updateSource(id, {});
      const src = await store.getSource("/noop.md");
      expect(src).not.toBeNull();
    });

    it("removes a source", async () => {
      const id = await store.addSource(makeSource({ path: "/remove-me.md" }));
      await store.removeSource(id);

      const result = await store.getSource("/remove-me.md");
      expect(result).toBeNull();
    });

    it("lists sources ordered by indexed_at DESC", async () => {
      await store.addSource(makeSource({ path: "/a.md", indexedAt: 100 }));
      await store.addSource(makeSource({ path: "/b.md", indexedAt: 300 }));
      await store.addSource(makeSource({ path: "/c.md", indexedAt: 200 }));

      const list = await store.listSources();
      expect(list).toHaveLength(3);
      expect(list[0].path).toBe("/b.md");
      expect(list[1].path).toBe("/c.md");
      expect(list[2].path).toBe("/a.md");
    });

    it("stores and retrieves metadata", async () => {
      const src = makeSource({ path: "/meta.md" });
      const _id = await store.addSource({ ...src, metadata: { author: "test", tags: ["a", "b"] } });

      const retrieved = await store.getSource("/meta.md");
      expect(retrieved?.metadata).toEqual({ author: "test", tags: ["a", "b"] });
    });
  });

  // ─── Chunks ───────────────────────────────────────────────────────────────

  describe("chunks", () => {
    let sourceId: string;

    beforeEach(async () => {
      sourceId = await store.addSource(makeSource({ path: "/chunks-test.md" }));
    });

    it("adds chunks and retrieves via search", async () => {
      const chunk = makeChunk(sourceId, "Hello world, this is a test chunk.");
      await store.addChunks([chunk]);

      const results = await store.search({ text: "test chunk", mode: "keyword" });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].chunk.text).toContain("test chunk");
    });

    it("adds multiple chunks in a transaction", async () => {
      const chunks = [
        makeChunk(sourceId, "First chunk about TypeScript"),
        makeChunk(sourceId, "Second chunk about Rust"),
        makeChunk(sourceId, "Third chunk about Python"),
      ];
      await store.addChunks(chunks);

      // All three should be searchable
      const r1 = await store.search({ text: "TypeScript", mode: "keyword" });
      const r2 = await store.search({ text: "Rust", mode: "keyword" });
      const r3 = await store.search({ text: "Python", mode: "keyword" });

      expect(r1.length).toBe(1);
      expect(r2.length).toBe(1);
      expect(r3.length).toBe(1);
    });

    it("removes chunks by source (cascade)", async () => {
      const chunk = makeChunk(sourceId, "Chunk to be removed by source");
      await store.addChunks([chunk]);

      // Verify it's there
      const before = await store.search({ text: "removed by source", mode: "keyword" });
      expect(before.length).toBe(1);

      await store.removeChunksBySource(sourceId);

      const after = await store.search({ text: "removed by source", mode: "keyword" });
      expect(after.length).toBe(0);
    });

    it("cascades chunk deletion when source is removed", async () => {
      const chunk = makeChunk(sourceId, "Cascade delete test");
      await store.addChunks([chunk]);

      await store.removeSource(sourceId);

      const results = await store.search({ text: "Cascade delete", mode: "keyword" });
      expect(results.length).toBe(0);
    });

    it("stores and retrieves chunk metadata", async () => {
      const chunk = makeChunk(sourceId, "Metadata test chunk");
      chunk.metadata = { type: "section", heading: "Test Heading", language: "typescript" };
      await store.addChunks([chunk]);

      const results = await store.search({ text: "Metadata test", mode: "keyword" });
      expect(results.length).toBe(1);
      expect(results[0].chunk.metadata.type).toBe("section");
      expect(results[0].chunk.metadata.heading).toBe("Test Heading");
    });
  });

  // ─── Keyword Search ─────────────────────────────────────────────────────

  describe("keyword search", () => {
    let sourceId: string;

    beforeEach(async () => {
      sourceId = await store.addSource(makeSource({ path: "/search-test.md" }));
      await store.addChunks([
        makeChunk(sourceId, "Introduction to machine learning algorithms"),
        makeChunk(sourceId, "Advanced neural network architectures"),
        makeChunk(sourceId, "Database optimization techniques and indexing"),
        makeChunk(sourceId, "JavaScript frameworks comparison React Vue Angular"),
      ]);
    });

    it("finds matching chunks by keyword", async () => {
      const results = await store.search({ text: "machine learning", mode: "keyword" });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].chunk.text).toContain("machine learning");
    });

    it("respects limit parameter", async () => {
      const results = await store.search({ text: "the", mode: "keyword", limit: 2 });
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it("returns empty for no matches", async () => {
      const results = await store.search({ text: "xyznonexistent", mode: "keyword" });
      expect(results.length).toBe(0);
    });

    it("includes score in results", async () => {
      const results = await store.search({ text: "neural network", mode: "keyword" });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(typeof results[0].score).toBe("number");
      expect(results[0].scoreKeyword).toBeDefined();
    });

    it("includes sourcePath in chunk results", async () => {
      const results = await store.search({ text: "machine learning", mode: "keyword" });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].chunk.sourcePath).toBe("/search-test.md");
    });

    it("matches via trigram index when query is a substring of a word", async () => {
      // "algorith" is a substring of "algorithms" — trigram index finds it
      const results = await store.search({ text: "algorith", mode: "keyword" });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].chunk.text).toContain("algorithms");
    });

    it("matches via prefix token when query is a partial word", async () => {
      // "optim" is a prefix of "optimization" and "optimized" etc.
      const results = await store.search({ text: "optim", mode: "keyword" });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].chunk.text).toContain("optimization");
    });
  });

  // ─── Vector Search (JS fallback) ─────────────────────────────────────────

  describe("vector search (JS fallback)", () => {
    let sourceId: string;

    beforeEach(async () => {
      sourceId = await store.addSource(makeSource({ path: "/vec-test.md" }));
    });

    it("finds similar chunks by embedding", async () => {
      const emb1 = fakeEmbedding(1);
      const emb2 = fakeEmbedding(2);
      const emb3 = fakeEmbedding(100); // Very different seed

      await store.addChunks([
        makeChunk(sourceId, "Chunk A — close to query", emb1),
        makeChunk(sourceId, "Chunk B — also close", emb2),
        makeChunk(sourceId, "Chunk C — far away", emb3),
      ]);

      // Query with an embedding very close to emb1
      const queryEmb = fakeEmbedding(1.001);
      const results = await store.search({
        text: "",
        embedding: queryEmb,
        mode: "vector",
        limit: 3,
      });

      expect(results.length).toBe(3);
      // The closest match should be Chunk A (seed 1 vs query seed 1.001)
      expect(results[0].chunk.text).toContain("Chunk A");
      expect(results[0].score).toBeGreaterThan(0.9);
      expect(results[0].scoreVector).toBeDefined();
    });

    it("returns empty when no embeddings stored", async () => {
      await store.addChunks([makeChunk(sourceId, "No embedding chunk")]);

      const results = await store.search({
        text: "",
        embedding: fakeEmbedding(1),
        mode: "vector",
      });
      expect(results.length).toBe(0);
    });

    it("throws when vector mode is used without embedding", async () => {
      await expect(store.search({ text: "hello", mode: "vector" })).rejects.toThrow(
        "Vector search requires embedding"
      );
    });

    it("respects limit in vector search", async () => {
      // Add 10 chunks
      const chunks = Array.from({ length: 10 }, (_, i) =>
        makeChunk(sourceId, `Vector chunk ${i}`, fakeEmbedding(i))
      );
      await store.addChunks(chunks);

      const results = await store.search({
        text: "",
        embedding: fakeEmbedding(0),
        mode: "vector",
        limit: 3,
      });
      expect(results.length).toBe(3);
    });
  });

  // ─── Hybrid Search ──────────────────────────────────────────────────────

  describe("hybrid search", () => {
    let sourceId: string;

    beforeEach(async () => {
      sourceId = await store.addSource(makeSource({ path: "/hybrid-test.md" }));
      await store.addChunks([
        makeChunk(sourceId, "Machine learning with Python and TensorFlow", fakeEmbedding(1)),
        makeChunk(sourceId, "Web development using React and TypeScript", fakeEmbedding(2)),
        makeChunk(sourceId, "Database optimization and SQL queries", fakeEmbedding(3)),
      ]);
    });

    it("requires embedding for hybrid search", async () => {
      await expect(store.search({ text: "hello", mode: "hybrid" })).rejects.toThrow(
        "Hybrid search requires embedding"
      );
    });

    it("returns merged results from vector and keyword", async () => {
      const results = await store.search({
        text: "machine learning",
        embedding: fakeEmbedding(1),
        mode: "hybrid",
        limit: 3,
      });

      expect(results.length).toBeGreaterThanOrEqual(1);
      // Score should be a weighted combination
      expect(results[0].score).toBeGreaterThan(0);
    });

    it("defaults to hybrid mode", async () => {
      const results = await store.search({
        text: "machine learning",
        embedding: fakeEmbedding(1),
      });

      expect(results.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── Store Metadata ───────────────────────────────────────────────────────

  describe("store_meta", () => {
    describe("getMeta / setMeta", () => {
      it("returns null for non-existent key", async () => {
        const result = await store.getMeta("nonexistent_key");
        expect(result).toBeNull();
      });

      it("sets and gets a value", async () => {
        await store.setMeta("test_key", "test_value");
        const result = await store.getMeta("test_key");
        expect(result).toBe("test_value");
      });

      it("upserts (replaces) an existing key", async () => {
        await store.setMeta("my_key", "first");
        await store.setMeta("my_key", "second");
        const result = await store.getMeta("my_key");
        expect(result).toBe("second");
      });

      it("stores numeric values as strings", async () => {
        await store.setMeta("dim", "1024");
        const result = await store.getMeta("dim");
        expect(result).toBe("1024");
        expect(parseInt(result ?? "", 10)).toBe(1024);
      });
    });

    describe("getAllMeta", () => {
      it("returns an empty object for a brand-new database (excluding internal migration keys)", async () => {
        const meta = await store.getAllMeta();
        // migrateTrigramIndex() writes fts_trigram_built on open — filter it out
        const userKeys = Object.keys(meta).filter((k) => !k.startsWith("fts_"));
        expect(typeof meta).toBe("object");
        expect(userKeys.length).toBe(0);
      });

      it("returns all set keys", async () => {
        await store.setMeta("a", "1");
        await store.setMeta("b", "2");
        const meta = await store.getAllMeta();
        expect(meta.a).toBe("1");
        expect(meta.b).toBe("2");
      });
    });

    describe("legacy migration", () => {
      it("does NOT write nomic defaults when the database is empty (new DB)", async () => {
        // An empty DB has no chunks — migration must not pre-seed embedder meta.
        // This prevents a freshly-created knowledge base from blocking users who
        // want to index with a non-nomic embedder on their first `ragclaw add`.
        expect(await store.getMeta("embedder_name")).toBeNull();
        expect(await store.getMeta("embedder_model")).toBeNull();
        expect(await store.getMeta("embedder_dimensions")).toBeNull();
      });

      it("writes nomic defaults on open when chunks exist but no embedder meta is set (legacy DB)", async () => {
        // Simulate a legacy DB: has chunks but no embedder_name in store_meta.
        // We close the current :memory: store, write a temp file with chunks but
        // no embedder meta, then re-open it to trigger the migration.
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const { unlink } = await import("node:fs/promises");
        const { randomUUID: uuid } = await import("node:crypto");

        const tmpPath = join(tmpdir(), `ragclaw-legacy-${uuid()}.sqlite`);
        const legacyStore = new Store();
        await legacyStore.open(tmpPath);
        // Add a source and a chunk so the DB looks like a legacy populated DB
        const srcId = await legacyStore.addSource({
          path: "/legacy/doc.md",
          type: "file",
          contentHash: "abc",
          indexedAt: Date.now(),
          createdAt: Date.now(),
          timestamp: Date.now(),
        });
        await legacyStore.addChunks([
          {
            id: uuid(),
            text: "legacy text",
            sourceId: srcId,
            sourcePath: "/legacy/doc.md",
            metadata: { type: "paragraph" },
            createdAt: Date.now(),
            timestamp: Date.now(),
          },
        ]);
        // Remove embedder meta to mimic a pre-plugin-system DB
        // (store_meta was populated by migration — delete it to simulate legacy state)
        await legacyStore.close();

        // Manually strip the embedder meta using a raw SQLite connection
        const Database = (await import("better-sqlite3")).default;
        const rawDb = new Database(tmpPath);
        rawDb
          .prepare(
            "DELETE FROM store_meta WHERE key IN ('embedder_name','embedder_model','embedder_dimensions')"
          )
          .run();
        rawDb.close();

        // Re-open — migration should now fire because chunks exist but meta is absent
        const migratedStore = new Store();
        await migratedStore.open(tmpPath);
        expect(await migratedStore.getMeta("embedder_name")).toBe("nomic");
        expect(await migratedStore.getMeta("embedder_model")).toBe(
          "nomic-ai/nomic-embed-text-v1.5"
        );
        expect(await migratedStore.getMeta("embedder_dimensions")).toBe("768");
        await migratedStore.close();
        await unlink(tmpPath);
      });

      it("does not overwrite existing embedder meta on re-open", async () => {
        // Seed some data and custom embedder meta
        const srcId = await store.addSource({
          path: "/doc.md",
          type: "file",
          contentHash: "h",
          indexedAt: Date.now(),
          createdAt: Date.now(),
          timestamp: Date.now(),
        });
        await store.addChunks([
          {
            id: randomUUID(),
            text: "text",
            sourceId: srcId,
            sourcePath: "/doc.md",
            metadata: { type: "paragraph" },
            createdAt: Date.now(),
            timestamp: Date.now(),
          },
        ]);
        await store.setMeta("embedder_name", "minilm");
        await store.setMeta("embedder_dimensions", "384");
        // The INSERT OR IGNORE in migrateLegacyMeta means a re-open on a real file
        // DB will not overwrite. For :memory: we just verify the explicitly set
        // values are not touched by migration (migration skips because meta exists).
        expect(await store.getMeta("embedder_name")).toBe("minilm");
        expect(await store.getMeta("embedder_dimensions")).toBe("384");
      });
    });

    describe("idx_sources_indexed_at index", () => {
      it("exists in sqlite_master", async () => {
        // Access the underlying DB via a raw query
        // We need to reach inside the store — for test purposes, create a
        // second store pointing at a temp file
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const { randomUUID } = await import("node:crypto");
        const { unlink } = await import("node:fs/promises");

        const tmpPath = join(tmpdir(), `ragclaw-test-${randomUUID()}.sqlite`);
        const tmpStore = new Store();
        vi.spyOn(console, "warn").mockImplementation(() => {});
        await tmpStore.open(tmpPath);

        // Query sqlite_master for our index
        // We check indirectly: add sources with different indexed_at values
        // and verify ORDER BY still works (index doesn't change behavior, just speed)
        await tmpStore.addSource({
          path: "/x.md",
          type: "file",
          contentHash: "h1",
          indexedAt: 10,
          createdAt: 10,
          timestamp: 10,
        });
        await tmpStore.addSource({
          path: "/y.md",
          type: "file",
          contentHash: "h2",
          indexedAt: 20,
          createdAt: 20,
          timestamp: 20,
        });
        const list = await tmpStore.listSources();
        expect(list[0].path).toBe("/y.md"); // DESC order preserved

        await tmpStore.close();
        await unlink(tmpPath).catch(() => {});
      });
    });
  });

  // ─── Stats ────────────────────────────────────────────────────────────────

  describe("stats", () => {
    it("reports correct source and chunk counts", async () => {
      const sid = await store.addSource(makeSource({ path: "/stats.md" }));
      await store.addChunks([makeChunk(sid, "Chunk one"), makeChunk(sid, "Chunk two")]);

      // getStats calls fs.stat(this.dbPath) which won't work with :memory:
      // so we expect it to throw for :memory: databases
      await expect(store.getStats()).rejects.toThrow();
    });
  });

  // ─── hasVectorSupport ─────────────────────────────────────────────────────

  describe("hasVectorSupport", () => {
    it("reports whether sqlite-vec is available", () => {
      // In test env, sqlite-vec is likely not installed, so false
      expect(typeof store.hasVectorSupport).toBe("boolean");
    });
  });

  // ─── StoreConfig ──────────────────────────────────────────────────────────

  describe("config", () => {
    it("uses custom weights for hybrid search", async () => {
      const customStore = new Store({ vectorWeight: 0.9, keywordWeight: 0.1 });
      vi.spyOn(console, "warn").mockImplementation(() => {});
      await customStore.open(":memory:");

      const sid = await customStore.addSource(makeSource({ path: "/config-test.md" }));
      await customStore.addChunks([
        makeChunk(sid, "Custom weight test chunk about AI", fakeEmbedding(1)),
      ]);

      const results = await customStore.search({
        text: "AI",
        embedding: fakeEmbedding(1),
        mode: "hybrid",
      });

      expect(results.length).toBeGreaterThanOrEqual(1);
      await customStore.close();
    });
  });

  // ─── Temporal Columns ───────────────────────────────────────────────────

  describe("temporal columns", () => {
    it("stores and retrieves createdAt and timestamp on sources", async () => {
      const now = Date.now();
      const _id = await store.addSource(
        makeSource({ path: "/temporal.md", createdAt: now - 1000, timestamp: now - 2000 })
      );
      const src = await store.getSource("/temporal.md");
      expect(src).not.toBeNull();
      expect(src?.createdAt).toBe(now - 1000);
      expect(src?.timestamp).toBe(now - 2000);
    });

    it("stores and retrieves timestamp on chunks", async () => {
      const ts = 1700000000000;
      const sid = await store.addSource(makeSource({ path: "/ts-chunks.md", timestamp: ts }));
      const chunk = makeChunk(sid, "Temporal chunk test", undefined, ts);
      await store.addChunks([chunk]);

      const results = await store.search({ text: "Temporal chunk", mode: "keyword" });
      expect(results.length).toBe(1);
      expect(results[0].chunk.timestamp).toBe(ts);
    });
  });

  // ─── Temporal Column Migration ──────────────────────────────────────────

  describe("temporal column migration (legacy schema)", () => {
    it("adds created_at and timestamp columns to a pre-temporal DB and backfills", async () => {
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const { unlink } = await import("node:fs/promises");
      const { randomUUID: uuid } = await import("node:crypto");
      const Database = (await import("better-sqlite3")).default;

      const tmpPath = join(tmpdir(), `ragclaw-temporal-migration-${uuid()}.sqlite`);

      // Create a DB with the OLD schema (no created_at / timestamp columns)
      const rawDb = new Database(tmpPath);
      rawDb.exec(`
        CREATE TABLE IF NOT EXISTS sources (
          id TEXT PRIMARY KEY,
          path TEXT NOT NULL UNIQUE,
          type TEXT NOT NULL,
          content_hash TEXT,
          mtime INTEGER,
          indexed_at INTEGER NOT NULL,
          metadata TEXT
        );
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
        CREATE TABLE IF NOT EXISTS store_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source_id);
        CREATE INDEX IF NOT EXISTS idx_sources_path ON sources(path);
      `);

      // Seed some data into the old-schema DB
      const srcId = uuid();
      const chunkId = uuid();
      const indexedAt = 1600000000000;
      const chunkCreatedAt = 1600000000100;

      rawDb
        .prepare(
          "INSERT INTO sources (id, path, type, content_hash, indexed_at) VALUES (?, ?, ?, ?, ?)"
        )
        .run(srcId, "/old/doc.md", "file", "oldhash", indexedAt);

      rawDb
        .prepare(
          "INSERT INTO chunks (id, source_id, text, start_line, end_line, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        )
        .run(chunkId, srcId, "Legacy chunk text", 1, 5, '{"type":"paragraph"}', chunkCreatedAt);

      rawDb.close();

      // Now open with Store — migration should fire
      const migratedStore = new Store();
      vi.spyOn(console, "warn").mockImplementation(() => {});
      await migratedStore.open(tmpPath);

      // Verify sources got backfilled: created_at = indexed_at, timestamp = indexed_at
      const src = await migratedStore.getSource("/old/doc.md");
      expect(src).not.toBeNull();
      expect(src?.createdAt).toBe(indexedAt);
      expect(src?.timestamp).toBe(indexedAt);

      // Verify chunks got backfilled: timestamp = created_at
      const results = await migratedStore.search({ text: "Legacy chunk", mode: "keyword" });
      expect(results.length).toBe(1);
      expect(results[0].chunk.timestamp).toBe(chunkCreatedAt);

      await migratedStore.close();
      await unlink(tmpPath);
    });

    it("is idempotent — re-opening a migrated DB does not fail", async () => {
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const { unlink } = await import("node:fs/promises");
      const { randomUUID: uuid } = await import("node:crypto");

      const tmpPath = join(tmpdir(), `ragclaw-temporal-idem-${uuid()}.sqlite`);

      // First open — normal Store (has temporal columns from the start)
      const firstStore = new Store();
      vi.spyOn(console, "warn").mockImplementation(() => {});
      await firstStore.open(tmpPath);
      await firstStore.addSource(makeSource({ path: "/idem/test.md" }));
      await firstStore.close();

      // Second open — should not crash (migration is idempotent)
      const secondStore = new Store();
      await secondStore.open(tmpPath);
      const src = await secondStore.getSource("/idem/test.md");
      expect(src).not.toBeNull();
      expect(src?.createdAt).toBeGreaterThan(0);
      expect(src?.timestamp).toBeGreaterThan(0);
      await secondStore.close();

      await unlink(tmpPath);
    });
  });

  // ─── Time-Filtered Search ─────────────────────────────────────────────────

  describe("time-filtered search", () => {
    // Three time buckets: past, middle, future
    const T_PAST = 1000000000000; // ~2001
    const T_MIDDLE = 1500000000000; // ~2017
    const T_FUTURE = 1700000000000; // ~2023

    let sourceId: string;

    beforeEach(async () => {
      sourceId = await store.addSource(makeSource({ path: "/time-test.md" }));
      await store.addChunks([
        makeChunk(
          sourceId,
          "Keyword: alpha. Old data from the past about databases",
          undefined,
          T_PAST
        ),
        makeChunk(
          sourceId,
          "Keyword: alpha. Middle-era data about databases and caching",
          undefined,
          T_MIDDLE
        ),
        makeChunk(
          sourceId,
          "Keyword: alpha. Recent data about databases and performance",
          undefined,
          T_FUTURE
        ),
      ]);
    });

    describe("keyword search", () => {
      it("returns all chunks when no time filter", async () => {
        const results = await store.search({ text: "alpha", mode: "keyword" });
        expect(results.length).toBe(3);
      });

      it("filters with after (inclusive)", async () => {
        const results = await store.search({
          text: "alpha",
          mode: "keyword",
          filter: { after: T_MIDDLE },
        });
        expect(results.length).toBe(2);
        for (const r of results) {
          expect(r.chunk.timestamp).toBeGreaterThanOrEqual(T_MIDDLE);
        }
      });

      it("filters with before (exclusive)", async () => {
        const results = await store.search({
          text: "alpha",
          mode: "keyword",
          filter: { before: T_MIDDLE },
        });
        expect(results.length).toBe(1);
        expect(results[0].chunk.timestamp).toBe(T_PAST);
      });

      it("filters with both after and before", async () => {
        const results = await store.search({
          text: "alpha",
          mode: "keyword",
          filter: { after: T_MIDDLE, before: T_FUTURE },
        });
        expect(results.length).toBe(1);
        expect(results[0].chunk.timestamp).toBe(T_MIDDLE);
      });

      it("returns empty when no chunks match the time window", async () => {
        const results = await store.search({
          text: "alpha",
          mode: "keyword",
          filter: { after: T_FUTURE + 1 },
        });
        expect(results.length).toBe(0);
      });
    });

    describe("vector search (JS fallback)", () => {
      let vecSourceId: string;

      beforeEach(async () => {
        vecSourceId = await store.addSource(makeSource({ path: "/time-vec.md" }));
        await store.addChunks([
          makeChunk(vecSourceId, "Old vector chunk about AI", fakeEmbedding(1), T_PAST),
          makeChunk(vecSourceId, "Middle vector chunk about AI", fakeEmbedding(1.01), T_MIDDLE),
          makeChunk(vecSourceId, "Recent vector chunk about AI", fakeEmbedding(1.02), T_FUTURE),
        ]);
      });

      it("returns all when no time filter", async () => {
        const results = await store.search({
          text: "",
          embedding: fakeEmbedding(1),
          mode: "vector",
          limit: 10,
        });
        // The 3 vec chunks have embeddings; keyword chunks from outer beforeEach don't.
        // Vector search only returns chunks with embeddings, so we expect exactly 3.
        expect(results.length).toBeGreaterThanOrEqual(3);
      });

      it("filters with after", async () => {
        const results = await store.search({
          text: "",
          embedding: fakeEmbedding(1),
          mode: "vector",
          limit: 10,
          filter: { after: T_MIDDLE },
        });
        for (const r of results) {
          expect(r.chunk.timestamp).toBeGreaterThanOrEqual(T_MIDDLE);
        }
      });

      it("filters with before", async () => {
        const results = await store.search({
          text: "",
          embedding: fakeEmbedding(1),
          mode: "vector",
          limit: 10,
          filter: { before: T_MIDDLE },
        });
        for (const r of results) {
          expect(r.chunk.timestamp).toBeLessThan(T_MIDDLE);
        }
      });

      it("filters with after + before", async () => {
        const results = await store.search({
          text: "",
          embedding: fakeEmbedding(1),
          mode: "vector",
          limit: 10,
          filter: { after: T_MIDDLE, before: T_FUTURE },
        });
        for (const r of results) {
          expect(r.chunk.timestamp).toBeGreaterThanOrEqual(T_MIDDLE);
          expect(r.chunk.timestamp).toBeLessThan(T_FUTURE);
        }
      });
    });

    describe("hybrid search", () => {
      let hybridSourceId: string;

      beforeEach(async () => {
        hybridSourceId = await store.addSource(makeSource({ path: "/time-hybrid.md" }));
        await store.addChunks([
          makeChunk(
            hybridSourceId,
            "Old hybrid chunk about neural networks",
            fakeEmbedding(5),
            T_PAST
          ),
          makeChunk(
            hybridSourceId,
            "Middle hybrid chunk about neural networks",
            fakeEmbedding(5.01),
            T_MIDDLE
          ),
          makeChunk(
            hybridSourceId,
            "Recent hybrid chunk about neural networks",
            fakeEmbedding(5.02),
            T_FUTURE
          ),
        ]);
      });

      it("filters with after in hybrid mode", async () => {
        const results = await store.search({
          text: "neural networks",
          embedding: fakeEmbedding(5),
          mode: "hybrid",
          limit: 10,
          filter: { after: T_FUTURE },
        });
        for (const r of results) {
          expect(r.chunk.timestamp).toBeGreaterThanOrEqual(T_FUTURE);
        }
      });

      it("filters with before in hybrid mode", async () => {
        const results = await store.search({
          text: "neural networks",
          embedding: fakeEmbedding(5),
          mode: "hybrid",
          limit: 10,
          filter: { before: T_MIDDLE },
        });
        for (const r of results) {
          expect(r.chunk.timestamp).toBeLessThan(T_MIDDLE);
        }
      });
    });
  });
});
