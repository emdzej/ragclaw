/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "crypto";
import { MergeService } from "./merge.js";
import { Store } from "./store/index.js";
import type { EmbedderPlugin } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeStore(): Promise<Store> {
  const store = new Store();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await store.open(":memory:");
  return store;
}

function makePluginEmbedder(dims: number, name = "test-embedder"): EmbedderPlugin {
  return {
    name,
    dimensions: dims,
    embed: vi.fn(async () => new Float32Array(dims).fill(0.1)),
    embedQuery: vi.fn(async () => new Float32Array(dims).fill(0.1)),
    embedBatch: vi.fn(async (texts: string[]) =>
      texts.map((_, i) => new Float32Array(dims).fill(0.1 + i * 0.01)),
    ),
  };
}

function fakeEmbedding(seed: number, dim = 768): Float32Array {
  const arr = new Float32Array(dim);
  for (let i = 0; i < dim; i++) arr[i] = Math.sin(seed * (i + 1));
  const norm = Math.sqrt(arr.reduce((sum, v) => sum + v * v, 0));
  if (norm > 0) for (let i = 0; i < dim; i++) arr[i] /= norm;
  return arr;
}

/**
 * Helper: add a source + chunks to a store and return the source id.
 * The store must have embedder meta written via `setMeta` before calling this.
 */
async function addSourceWithChunks(
  store: Store,
  path: string,
  texts: string[],
  dims = 768,
  contentHash = "hash-" + randomUUID(),
): Promise<string> {
  const sourceId = await store.addSource({
    path,
    type: "file",
    contentHash,
    indexedAt: Date.now(),
  });

  if (texts.length > 0) {
    await store.addChunks(
      texts.map((text, i) => ({
        id: randomUUID(),
        sourceId,
        sourcePath: path,
        text,
        startLine: i * 10 + 1,
        endLine: i * 10 + 10,
        metadata: { type: "paragraph" as const },
        embedding: fakeEmbedding(i, dims),
        createdAt: Date.now(),
      })),
    );
  }

  return sourceId;
}

/** Write embedder metadata to a store (simulates what IndexingService does). */
async function setEmbedderMeta(
  store: Store,
  name = "nomic",
  dims = 768,
  model = "nomic-embed-text-v1.5",
): Promise<void> {
  await store.setMeta("embedder_name", name);
  await store.setMeta("embedder_dimensions", String(dims));
  await store.setMeta("embedder_model", model);
}

// ---------------------------------------------------------------------------
// MergeService — we need to use real file paths for the source DB because
// MergeService opens the source DB via `new Store().open(path)`.
// We write a temp file-backed SQLite for the source and keep dest in-memory.
// ---------------------------------------------------------------------------

import { tmpdir } from "os";
import { join } from "path";
import { existsSync, rmSync } from "fs";

function tempDbPath(): string {
  return join(tmpdir(), `merge-test-${randomUUID()}.db`);
}

/** Create a file-backed store, run setup, return its path. */
async function makeFileStore(
  setup: (store: Store) => Promise<void>,
): Promise<{ store: Store; path: string }> {
  const path = tempDbPath();
  const store = new Store();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await store.open(path);
  await setup(store);
  return { store, path };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MergeService", () => {
  let destStore: Store;
  let mergeService: MergeService;
  const tempFiles: string[] = [];

  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    destStore = await makeStore();
    await setEmbedderMeta(destStore);
    mergeService = new MergeService();
  });

  afterEach(async () => {
    await destStore.close();
    vi.restoreAllMocks();
    // Clean up temp DB files
    for (const f of tempFiles) {
      if (existsSync(f)) rmSync(f);
    }
    tempFiles.length = 0;
  });

  // ── diff (dry-run helper) ──────────────────────────────────────────────────

  describe("diff", () => {
    it("reports sources from remote missing locally as toAdd", async () => {
      const { store: srcStore, path: srcPath } = await makeFileStore(async (s) => {
        await setEmbedderMeta(s);
        await addSourceWithChunks(s, "/docs/readme.md", ["hello world"]);
      });
      tempFiles.push(srcPath);
      await srcStore.close();

      const result = await mergeService.diff(destStore, srcPath);
      expect(result.toAdd).toHaveLength(1);
      expect(result.toAdd[0].path).toBe("/docs/readme.md");
      expect(result.toUpdate).toHaveLength(0);
      expect(result.identical).toHaveLength(0);
    });

    it("reports identical sources when content hashes match", async () => {
      const hash = "shared-hash-abc";
      await addSourceWithChunks(destStore, "/docs/shared.md", ["text"], 768, hash);

      const { store: srcStore, path: srcPath } = await makeFileStore(async (s) => {
        await setEmbedderMeta(s);
        await addSourceWithChunks(s, "/docs/shared.md", ["text"], 768, hash);
      });
      tempFiles.push(srcPath);
      await srcStore.close();

      const result = await mergeService.diff(destStore, srcPath);
      expect(result.identical).toHaveLength(1);
      expect(result.toAdd).toHaveLength(0);
      expect(result.toUpdate).toHaveLength(0);
    });

    it("reports toUpdate when same path but different content hash", async () => {
      await addSourceWithChunks(destStore, "/docs/changed.md", ["old text"], 768, "hash-old");

      const { store: srcStore, path: srcPath } = await makeFileStore(async (s) => {
        await setEmbedderMeta(s);
        await addSourceWithChunks(s, "/docs/changed.md", ["new text"], 768, "hash-new");
      });
      tempFiles.push(srcPath);
      await srcStore.close();

      const result = await mergeService.diff(destStore, srcPath);
      expect(result.toUpdate).toHaveLength(1);
      expect(result.toUpdate[0].path).toBe("/docs/changed.md");
      expect(result.toAdd).toHaveLength(0);
    });

    it("reports localOnly for sources only present in dest", async () => {
      await addSourceWithChunks(destStore, "/local-only.md", ["local"]);

      const { store: srcStore, path: srcPath } = await makeFileStore(async (s) => {
        await setEmbedderMeta(s);
        // no sources
      });
      tempFiles.push(srcPath);
      await srcStore.close();

      const result = await mergeService.diff(destStore, srcPath);
      expect(result.localOnly).toHaveLength(1);
      expect(result.localOnly[0].path).toBe("/local-only.md");
    });

    it("includes embedderMatch info", async () => {
      const { store: srcStore, path: srcPath } = await makeFileStore(async (s) => {
        await setEmbedderMeta(s, "nomic", 768);
      });
      tempFiles.push(srcPath);
      await srcStore.close();

      const result = await mergeService.diff(destStore, srcPath);
      expect(result.embedderMatch).toBe(true);
    });

    it("reports embedderMatch=false when embedders differ", async () => {
      const { store: srcStore, path: srcPath } = await makeFileStore(async (s) => {
        await setEmbedderMeta(s, "bge", 1024);
      });
      tempFiles.push(srcPath);
      await srcStore.close();

      const result = await mergeService.diff(destStore, srcPath);
      expect(result.embedderMatch).toBe(false);
    });
  });

  // ── merge — dry-run ───────────────────────────────────────────────────────

  describe("merge (dryRun)", () => {
    it("returns diff but writes nothing", async () => {
      const { store: srcStore, path: srcPath } = await makeFileStore(async (s) => {
        await setEmbedderMeta(s);
        await addSourceWithChunks(s, "/docs/new.md", ["hello"]);
      });
      tempFiles.push(srcPath);
      await srcStore.close();

      const summary = await mergeService.merge(destStore, srcPath, { dryRun: true });

      expect(summary.dryRun).toBe(true);
      expect(summary.diff.toAdd).toHaveLength(1);
      // Nothing written to dest
      const sources = await destStore.listSources();
      expect(sources).toHaveLength(0);
    });
  });

  // ── merge — strict strategy ───────────────────────────────────────────────

  describe("merge (strict strategy)", () => {
    it("adds new sources from remote into dest", async () => {
      const { store: srcStore, path: srcPath } = await makeFileStore(async (s) => {
        await setEmbedderMeta(s);
        await addSourceWithChunks(s, "/docs/a.md", ["chunk a1", "chunk a2"]);
        await addSourceWithChunks(s, "/docs/b.md", ["chunk b1"]);
      });
      tempFiles.push(srcPath);
      await srcStore.close();

      const summary = await mergeService.merge(destStore, srcPath);

      expect(summary.strategy).toBe("strict");
      expect(summary.sourcesAdded).toBe(2);
      expect(summary.sourcesUpdated).toBe(0);
      expect(summary.errors).toHaveLength(0);

      const sources = await destStore.listSources();
      expect(sources).toHaveLength(2);
    });

    it("copies chunk text and embeddings", async () => {
      const { store: srcStore, path: srcPath } = await makeFileStore(async (s) => {
        await setEmbedderMeta(s);
        await addSourceWithChunks(s, "/docs/content.md", ["the content text"]);
      });
      tempFiles.push(srcPath);
      await srcStore.close();

      await mergeService.merge(destStore, srcPath);

      const [src] = await destStore.listSources();
      expect(src.path).toBe("/docs/content.md");

      const chunks = await destStore.getChunksBySource(src.id);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].text).toBe("the content text");
      // embedding blob should be present
      expect(chunks[0].embedding).toBeInstanceOf(Float32Array);
    });

    it("fires onProgress callback for each source", async () => {
      const { store: srcStore, path: srcPath } = await makeFileStore(async (s) => {
        await setEmbedderMeta(s);
        await addSourceWithChunks(s, "/a.md", ["text a"]);
        await addSourceWithChunks(s, "/b.md", ["text b"]);
      });
      tempFiles.push(srcPath);
      await srcStore.close();

      const events: string[] = [];
      await mergeService.merge(destStore, srcPath, {
        onProgress: (r) => events.push(`${r.status}:${r.path}`),
      });

      expect(events).toContain("added:/a.md");
      expect(events).toContain("added:/b.md");
    });

    it("throws when embedder dimensions mismatch", async () => {
      const { store: srcStore, path: srcPath } = await makeFileStore(async (s) => {
        await setEmbedderMeta(s, "bge", 1024);
        await addSourceWithChunks(s, "/doc.md", ["text"], 1024);
      });
      tempFiles.push(srcPath);
      await srcStore.close();

      await expect(mergeService.merge(destStore, srcPath)).rejects.toThrow(
        /embedder mismatch/i,
      );
    });

    it("records merge history", async () => {
      const { store: srcStore, path: srcPath } = await makeFileStore(async (s) => {
        await setEmbedderMeta(s);
        await addSourceWithChunks(s, "/doc.md", ["text"]);
      });
      tempFiles.push(srcPath);
      await srcStore.close();

      await mergeService.merge(destStore, srcPath);

      // Verify via raw DB query that merge_history has a row
      const row = (destStore as unknown as { db: import("better-sqlite3").Database }).db
        ?.prepare("SELECT * FROM merge_history LIMIT 1")
        .get() as { strategy: string; sources_added: number } | undefined;

      expect(row).toBeDefined();
      expect(row?.strategy).toBe("strict");
      expect(row?.sources_added).toBe(1);
    });
  });

  // ── merge — conflict resolution ───────────────────────────────────────────

  describe("conflict resolution", () => {
    it("skips conflicting source by default (skip)", async () => {
      const localHash = "hash-local";
      const remoteHash = "hash-remote";
      await addSourceWithChunks(destStore, "/shared.md", ["local text"], 768, localHash);

      const { store: srcStore, path: srcPath } = await makeFileStore(async (s) => {
        await setEmbedderMeta(s);
        await addSourceWithChunks(s, "/shared.md", ["remote text"], 768, remoteHash);
      });
      tempFiles.push(srcPath);
      await srcStore.close();

      const summary = await mergeService.merge(destStore, srcPath);

      expect(summary.sourcesSkipped).toBe(1);
      expect(summary.sourcesUpdated).toBe(0);

      // Local version unchanged
      const [src] = await destStore.listSources();
      const chunks = await destStore.getChunksBySource(src.id);
      expect(chunks[0].text).toBe("local text");
    });

    it("skips conflicting source with prefer-local", async () => {
      await addSourceWithChunks(destStore, "/shared.md", ["local"], 768, "hash-L");

      const { store: srcStore, path: srcPath } = await makeFileStore(async (s) => {
        await setEmbedderMeta(s);
        await addSourceWithChunks(s, "/shared.md", ["remote"], 768, "hash-R");
      });
      tempFiles.push(srcPath);
      await srcStore.close();

      const summary = await mergeService.merge(destStore, srcPath, { onConflict: "prefer-local" });
      expect(summary.sourcesSkipped).toBe(1);
    });

    it("overwrites local with remote when prefer-remote", async () => {
      await addSourceWithChunks(destStore, "/shared.md", ["local text"], 768, "hash-L");

      const { store: srcStore, path: srcPath } = await makeFileStore(async (s) => {
        await setEmbedderMeta(s);
        await addSourceWithChunks(s, "/shared.md", ["remote text"], 768, "hash-R");
      });
      tempFiles.push(srcPath);
      await srcStore.close();

      const summary = await mergeService.merge(destStore, srcPath, {
        onConflict: "prefer-remote",
      });

      expect(summary.sourcesUpdated).toBe(1);

      const [src] = await destStore.listSources();
      const chunks = await destStore.getChunksBySource(src.id);
      expect(chunks[0].text).toBe("remote text");
    });
  });

  // ── merge — include / exclude filters ────────────────────────────────────

  describe("include / exclude filters", () => {
    it("only imports sources matching include prefix", async () => {
      const { store: srcStore, path: srcPath } = await makeFileStore(async (s) => {
        await setEmbedderMeta(s);
        await addSourceWithChunks(s, "/docs/guide.md", ["guide"]);
        await addSourceWithChunks(s, "/src/main.ts", ["code"]);
      });
      tempFiles.push(srcPath);
      await srcStore.close();

      const summary = await mergeService.merge(destStore, srcPath, {
        include: ["/docs/"],
      });

      expect(summary.sourcesAdded).toBe(1);
      const sources = await destStore.listSources();
      expect(sources[0].path).toBe("/docs/guide.md");
    });

    it("skips sources matching exclude prefix", async () => {
      const { store: srcStore, path: srcPath } = await makeFileStore(async (s) => {
        await setEmbedderMeta(s);
        await addSourceWithChunks(s, "/docs/guide.md", ["guide"]);
        await addSourceWithChunks(s, "/src/main.ts", ["code"]);
      });
      tempFiles.push(srcPath);
      await srcStore.close();

      const summary = await mergeService.merge(destStore, srcPath, {
        exclude: ["/src/"],
      });

      expect(summary.sourcesAdded).toBe(1);
      const sources = await destStore.listSources();
      expect(sources[0].path).toBe("/docs/guide.md");
    });
  });

  // ── merge — reindex strategy ──────────────────────────────────────────────

  describe("merge (reindex strategy)", () => {
    it("re-embeds chunks using the provided embedder", async () => {
      const { store: srcStore, path: srcPath } = await makeFileStore(async (s) => {
        await setEmbedderMeta(s, "bge", 512);
        await addSourceWithChunks(s, "/doc.md", ["text one", "text two"], 512);
      });
      tempFiles.push(srcPath);
      await srcStore.close();

      // dest uses nomic/768; reindex with a 768-dim embedder
      const embedder = makePluginEmbedder(768, "nomic");
      const summary = await mergeService.merge(destStore, srcPath, {
        strategy: "reindex",
        embedder,
      });

      expect(summary.strategy).toBe("reindex");
      expect(summary.sourcesAdded).toBe(1);
      expect(summary.errors).toHaveLength(0);

      // embedBatch was called with the chunk texts
      expect(embedder.embedBatch).toHaveBeenCalledOnce();
      const callArgs = (embedder.embedBatch as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArgs).toEqual(["text one", "text two"]);

      // chunks were written with new embeddings
      const [src] = await destStore.listSources();
      const chunks = await destStore.getChunksBySource(src.id);
      expect(chunks).toHaveLength(2);
      expect(chunks[0].embedding).toBeInstanceOf(Float32Array);
      expect(chunks[0].embedding!.length).toBeGreaterThan(0);
    });

    it("throws when strategy=reindex but no embedder provided", async () => {
      const { store: srcStore, path: srcPath } = await makeFileStore(async (s) => {
        await setEmbedderMeta(s, "nomic", 768);
      });
      tempFiles.push(srcPath);
      await srcStore.close();

      await expect(
        mergeService.merge(destStore, srcPath, { strategy: "reindex" }),
      ).rejects.toThrow(/embedder/i);
    });

    it("works across different embedders", async () => {
      // Source: bge/512, dest: nomic/768
      const { store: srcStore, path: srcPath } = await makeFileStore(async (s) => {
        await setEmbedderMeta(s, "bge", 512);
        await addSourceWithChunks(s, "/doc.md", ["hello world"], 512);
      });
      tempFiles.push(srcPath);
      await srcStore.close();

      const embedder = makePluginEmbedder(768, "nomic");
      const summary = await mergeService.merge(destStore, srcPath, {
        strategy: "reindex",
        embedder,
      });

      expect(summary.sourcesAdded).toBe(1);
      expect(summary.errors).toHaveLength(0);
    });
  });
});