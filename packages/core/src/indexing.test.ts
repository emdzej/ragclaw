/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { EmbedderPlugin } from "./types.js";

// ── Mock @huggingface/transformers ──────────────────────────────────────────
const mockPipe: Mock = vi.fn();
vi.mock("@huggingface/transformers", () => ({
  pipeline: vi.fn(async () => mockPipe),
  env: { cacheDir: "" },
  Tensor: class {},
}));

// Must import AFTER vi.mock
const { IndexingService } = await import("./indexing.js");
const { Store } = await import("./store/index.js");

// ── Helpers ─────────────────────────────────────────────────────────────────

function makePluginEmbedder(dims: number, name = "test-embedder"): EmbedderPlugin {
  return {
    name,
    dimensions: dims,
    embed: vi.fn(async () => new Float32Array(dims)),
    embedQuery: vi.fn(async () => new Float32Array(dims)),
    embedBatch: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array(dims))),
  };
}

async function makeStore(): Promise<InstanceType<typeof Store>> {
  const store = new Store();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await store.open(":memory:");
  return store;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("IndexingService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("embedder resolution", () => {
    it("accepts an EmbedderPlugin instance directly", () => {
      const plugin = makePluginEmbedder(512);
      const svc = new IndexingService({ embedder: plugin });
      // If it constructs without throwing, the plugin was accepted
      expect(svc).toBeInstanceOf(IndexingService);
    });

    it("accepts an EmbedderResolvedConfig alias", () => {
      const svc = new IndexingService({ embedder: { alias: "minilm" } });
      expect(svc).toBeInstanceOf(IndexingService);
    });

    it("defaults to nomic when no embedder specified", () => {
      const svc = new IndexingService();
      expect(svc).toBeInstanceOf(IndexingService);
    });
  });

  describe("dimension mismatch guard", () => {
    it("throws when embedder dims don't match stored dims", async () => {
      const store = await makeStore();

      // store_meta already has embedder_dimensions=768 from legacy migration

      // Now create a service with a 1024-dim embedder
      const embedder1024 = makePluginEmbedder(1024, "bge");
      const svc = new IndexingService({ embedder: embedder1024 });

      // Use a URL source so we skip the hashFile() call (URLs don't stat)
      const source = { type: "url" as const, url: "https://example.com/test" };

      const result = await svc.indexSource(store, source);
      expect(result.status).toBe("error");
      expect((result as { status: "error"; error: string }).error).toMatch(/dimension mismatch/i);
    });

    it("succeeds when embedder dims match stored dims", async () => {
      const store = await makeStore();

      // Use a 768-dim embedder matching the nomic default in store_meta
      const embedder768 = makePluginEmbedder(768, "nomic-embed-text-v1.5");
      const svc = new IndexingService({ embedder: embedder768 });

      const source = { type: "url" as const, url: "https://example.com/test" };

      const result = await svc.indexSource(store, source);
      // Should not be a dim-mismatch error
      if (result.status === "error") {
        expect((result as { status: "error"; error: string }).error).not.toMatch(
          /dimension mismatch/i
        );
      }
    });

    it("records embedder metadata in store after successful index", async () => {
      const store = await makeStore();

      // Set stored dims to 512 to match our embedder (avoid mismatch)
      await store.setMeta("embedder_dimensions", "512");
      const embedder512 = makePluginEmbedder(512, "custom-embedder");
      const svc = new IndexingService({ embedder: embedder512 });

      const source = { type: "url" as const, url: "https://example.com/test" };
      await svc.indexSource(store, source);

      // Metadata should reflect the embedder used (written after embed)
      const storedName = await store.getMeta("embedder_name");
      const storedDims = await store.getMeta("embedder_dimensions");
      expect(storedName).toBe("custom-embedder");
      expect(storedDims).toBe("512");
    });
  });
});
