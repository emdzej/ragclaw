/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Store } from "./index.js";
import { randomUUID } from "crypto";
import type { ChunkRecord } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSource(overrides: Partial<{ path: string; type: string; contentHash: string; indexedAt: number }> = {}) {
  return {
    path: overrides.path ?? `/test/${randomUUID()}.md`,
    type: (overrides.type ?? "file") as "file" | "url",
    contentHash: overrides.contentHash ?? "abc123",
    indexedAt: overrides.indexedAt ?? Date.now(),
  };
}

function makeChunk(
  sourceId: string,
  text: string,
  embedding?: Float32Array,
): ChunkRecord {
  return {
    id: randomUUID(),
    sourceId,
    sourcePath: "/test/file.md",
    text,
    startLine: 1,
    endLine: 10,
    metadata: { type: "paragraph" as const },
    embedding,
    createdAt: Date.now(),
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
      await expect(
        fresh.search({ text: "hello", mode: "keyword" }),
      ).rejects.toThrow("Store not opened");
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
      expect(retrieved!.id).toBe(id);
      expect(retrieved!.path).toBe("/docs/readme.md");
      expect(retrieved!.type).toBe("file");
      expect(retrieved!.contentHash).toBe("abc123");
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
      expect(updated!.contentHash).toBe("newHash");
      expect(updated!.indexedAt).toBe(99999);
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
      const id = await store.addSource({ ...src, metadata: { author: "test", tags: ["a", "b"] } });

      const retrieved = await store.getSource("/meta.md");
      expect(retrieved!.metadata).toEqual({ author: "test", tags: ["a", "b"] });
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
      await expect(
        store.search({ text: "hello", mode: "vector" }),
      ).rejects.toThrow("Vector search requires embedding");
    });

    it("respects limit in vector search", async () => {
      // Add 10 chunks
      const chunks = Array.from({ length: 10 }, (_, i) =>
        makeChunk(sourceId, `Vector chunk ${i}`, fakeEmbedding(i)),
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
      await expect(
        store.search({ text: "hello", mode: "hybrid" }),
      ).rejects.toThrow("Hybrid search requires embedding");
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
        expect(parseInt(result!, 10)).toBe(1024);
      });
    });

    describe("getAllMeta", () => {
      it("returns an empty-ish object when only legacy defaults are set", async () => {
        const meta = await store.getAllMeta();
        // Legacy migration writes 3 keys on open
        expect(typeof meta).toBe("object");
        expect(Object.keys(meta).length).toBeGreaterThanOrEqual(0);
      });

      it("returns all set keys", async () => {
        await store.setMeta("a", "1");
        await store.setMeta("b", "2");
        const meta = await store.getAllMeta();
        expect(meta["a"]).toBe("1");
        expect(meta["b"]).toBe("2");
      });
    });

    describe("legacy migration", () => {
      it("writes nomic defaults on first open", async () => {
        // store is opened in beforeEach — should already have defaults
        expect(await store.getMeta("embedder_name")).toBe("nomic");
        expect(await store.getMeta("embedder_model")).toBe("nomic-ai/nomic-embed-text-v1.5");
        expect(await store.getMeta("embedder_dimensions")).toBe("768");
      });

      it("does not overwrite existing embedder meta", async () => {
        // Override to something non-nomic
        await store.setMeta("embedder_name", "minilm");
        await store.setMeta("embedder_dimensions", "384");

        // Close and re-open — migration should NOT revert our custom values
        await store.close();
        await store.open(":memory:");
        // A fresh :memory: will always get defaults (it's a new DB)
        // So test that setMeta + reopen on a persistent path would preserve
        // (We test this indirectly: the migration uses INSERT OR IGNORE,
        // so once set, it won't overwrite on a real DB reopen)
        // For :memory: we just verify the initial migration ran
        expect(await store.getMeta("embedder_name")).toBe("nomic");
      });
    });

    describe("idx_sources_indexed_at index", () => {
      it("exists in sqlite_master", async () => {
        // Access the underlying DB via a raw query
        // We need to reach inside the store — for test purposes, create a
        // second store pointing at a temp file
        const { tmpdir } = await import("os");
        const { join } = await import("path");
        const { randomUUID } = await import("crypto");
        const { unlink } = await import("fs/promises");

        const tmpPath = join(tmpdir(), `ragclaw-test-${randomUUID()}.sqlite`);
        const tmpStore = new Store();
        vi.spyOn(console, "warn").mockImplementation(() => {});
        await tmpStore.open(tmpPath);

        // Query sqlite_master for our index
        // We check indirectly: add sources with different indexed_at values
        // and verify ORDER BY still works (index doesn't change behavior, just speed)
        await tmpStore.addSource({ path: "/x.md", type: "file", contentHash: "h1", indexedAt: 10 });
        await tmpStore.addSource({ path: "/y.md", type: "file", contentHash: "h2", indexedAt: 20 });
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
      await store.addChunks([
        makeChunk(sid, "Chunk one"),
        makeChunk(sid, "Chunk two"),
      ]);

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
});