/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { Chunker, EmbedderPlugin, ExtractedContent } from "./types.js";

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

// ── Chunker helpers ──────────────────────────────────────────────────────────

function makeChunker(name: string, handles: string[], alwaysHandle = false): Chunker {
  return {
    name,
    description: `Test chunker: ${name}`,
    handles,
    canHandle: (content: ExtractedContent) => alwaysHandle || handles.includes(content.sourceType),
    chunk: vi.fn(async () => []),
  };
}

function makeExtractedContent(sourceType: ExtractedContent["sourceType"]): ExtractedContent {
  return { text: "test content", metadata: {}, sourceType };
}

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

  describe("resolveChunker priority stack", () => {
    const embedder = makePluginEmbedder(512);

    it("priority 1: per-call force strategy overrides everything", () => {
      const pluginChunker = makeChunker("plugin-chunker", ["text"]);
      const svc = new IndexingService({
        embedder,
        extraChunkers: [pluginChunker],
        chunkerStrategy: "semantic", // service-level forced strategy
      });
      // forceChunker="sentence" at call level should win
      const result = (
        svc as unknown as {
          resolveChunker: (c: ExtractedContent, p: string, f?: string) => Chunker;
        }
      ).resolveChunker(makeExtractedContent("text"), "/test.txt", "sentence");
      expect(result.name).toBe("sentence");
    });

    it("priority 1: service-level chunkerStrategy forces a chunker", () => {
      const svc = new IndexingService({ embedder, chunkerStrategy: "fixed" });
      const result = (
        svc as unknown as {
          resolveChunker: (c: ExtractedContent, p: string, f?: string) => Chunker;
        }
      ).resolveChunker(makeExtractedContent("code"), "/test.py");
      expect(result.name).toBe("fixed");
    });

    it("priority 2: config glob override matches source path", () => {
      const svc = new IndexingService({
        embedder,
        chunkerOverrides: [{ pattern: "**/*.md", chunker: "sentence" }],
      });
      const result = (
        svc as unknown as {
          resolveChunker: (c: ExtractedContent, p: string, f?: string) => Chunker;
        }
      ).resolveChunker(makeExtractedContent("markdown"), "/docs/readme.md");
      expect(result.name).toBe("sentence");
    });

    it("priority 2: config glob override does not match unrelated path", () => {
      const svc = new IndexingService({
        embedder,
        chunkerOverrides: [{ pattern: "**/*.md", chunker: "sentence" }],
      });
      // .ts file should NOT match the *.md pattern → falls through to auto (CodeChunker)
      const result = (
        svc as unknown as {
          resolveChunker: (c: ExtractedContent, p: string, f?: string) => Chunker;
        }
      ).resolveChunker(makeExtractedContent("code"), "/src/index.ts");
      expect(result.name).toBe("code");
    });

    it("priority 3: plugin chunker wins via canHandle() before built-ins", () => {
      const pluginChunker = makeChunker("my-plugin-chunker", ["text"], true);
      const svc = new IndexingService({ embedder, extraChunkers: [pluginChunker] });
      const result = (
        svc as unknown as {
          resolveChunker: (c: ExtractedContent, p: string, f?: string) => Chunker;
        }
      ).resolveChunker(makeExtractedContent("markdown"), "/test.md");
      expect(result.name).toBe("my-plugin-chunker");
    });

    it("priority 4: built-in auto selects CodeChunker for code", () => {
      const svc = new IndexingService({ embedder });
      const result = (
        svc as unknown as {
          resolveChunker: (c: ExtractedContent, p: string, f?: string) => Chunker;
        }
      ).resolveChunker(makeExtractedContent("code"), "/src/file.ts");
      expect(result.name).toBe("code");
    });

    it("priority 4: built-in auto selects SemanticChunker for markdown", () => {
      const svc = new IndexingService({ embedder });
      const result = (
        svc as unknown as {
          resolveChunker: (c: ExtractedContent, p: string, f?: string) => Chunker;
        }
      ).resolveChunker(makeExtractedContent("markdown"), "/docs/readme.md");
      expect(result.name).toBe("semantic");
    });

    it("priority 4: FixedChunker catches content that nothing else handles", () => {
      const svc = new IndexingService({ embedder });
      const result = (
        svc as unknown as {
          resolveChunker: (c: ExtractedContent, p: string, f?: string) => Chunker;
        }
      ).resolveChunker(
        makeExtractedContent("pdf"), // pdf → no SemanticChunker/CodeChunker match → FixedChunker
        "/photo.pdf"
      );
      expect(result.name).toBe("fixed");
    });

    it("unknown chunker name throws with suggestion", () => {
      const svc = new IndexingService({ embedder });
      expect(() =>
        (
          svc as unknown as {
            resolveChunker: (c: ExtractedContent, p: string, f?: string) => Chunker;
          }
        ).resolveChunker(
          makeExtractedContent("text"),
          "/test.txt",
          "sentense" // typo
        )
      ).toThrow(/sentense/);
    });

    it("unknown chunker error message includes available chunker names", () => {
      const svc = new IndexingService({ embedder });
      expect(() =>
        (
          svc as unknown as {
            resolveChunker: (c: ExtractedContent, p: string, f?: string) => Chunker;
          }
        ).resolveChunker(makeExtractedContent("text"), "/test.txt", "nonexistent-chunker")
      ).toThrow(/Available chunkers/);
    });

    it("listChunkers returns all built-in chunkers", () => {
      const svc = new IndexingService({ embedder });
      const list = svc.listChunkers();
      const names = list.map((c) => c.name);
      expect(names).toContain("code");
      expect(names).toContain("semantic");
      expect(names).toContain("sentence");
      expect(names).toContain("fixed");
    });

    it("listChunkers marks plugin chunkers with source='plugin'", () => {
      const pluginChunker = makeChunker("my-chunker", ["text"]);
      const svc = new IndexingService({ embedder, extraChunkers: [pluginChunker] });
      const list = svc.listChunkers();
      const plugin = list.find((c) => c.name === "my-chunker");
      expect(plugin?.source).toBe("plugin");
    });

    it("listChunkers marks built-in chunkers with source='built-in'", () => {
      const svc = new IndexingService({ embedder });
      const list = svc.listChunkers();
      expect(list.every((c) => c.source === "built-in")).toBe(true);
    });
  });
});
