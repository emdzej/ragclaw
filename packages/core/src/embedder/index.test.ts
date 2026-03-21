/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { join } from "node:path";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

// ── Mock @huggingface/transformers before importing the module ──────────────
// The HuggingFaceEmbedder uses `pipeline("feature-extraction", model, ...)` which
// downloads a multi-hundred-MB model.  We mock the entire module so tests are fast
// and offline.

const mockPipe: Mock = vi.fn();

vi.mock("@huggingface/transformers", () => ({
  pipeline: vi.fn(async () => mockPipe),
  env: { cacheDir: "/mock/cache/ragclaw/models" },
  Tensor: class {},
}));

// Mock fs so isModelCached never touches the real filesystem
vi.mock("fs", () => ({
  existsSync: vi.fn(),
}));

// Must import AFTER vi.mock so the mock takes effect
const { HuggingFaceEmbedder, Embedder, isModelCached, getModelCacheDir } = await import(
  "./index.js"
);

import { existsSync } from "node:fs";

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Build a fake Tensor-like object with a flat Float32Array of the given length. */
function fakeTensor(count: number, dims = 768): { data: Float32Array } {
  const data = new Float32Array(count * dims);
  // Fill with deterministic values so we can verify slicing
  for (let i = 0; i < data.length; i++) {
    data[i] = i / data.length;
  }
  return { data };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("HuggingFaceEmbedder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: return a single-row tensor (768 dims for nomic preset)
    mockPipe.mockResolvedValue(fakeTensor(1, 768));
  });

  // ── Constructor / dimensions ────────────────────────────────────────────
  describe("constructor & dimensions", () => {
    it("uses nomic model as default when no config given", () => {
      const e = new HuggingFaceEmbedder();
      // Default constructor uses the nomic model from DEFAULT_PRESET
      expect(e.name).toBe("nomic-embed-text-v1.5");
    });

    it("uses preset dimensions when provided", () => {
      const e = new HuggingFaceEmbedder({ dim: 768 });
      expect(e.dimensions).toBe(768);
    });

    it("starts with dimensions=0 for auto-detect when no dim given", () => {
      const e = new HuggingFaceEmbedder({ model: "some/model" });
      expect(e.dimensions).toBe(0);
    });

    it("derives name from model ID", () => {
      const e = new HuggingFaceEmbedder({ model: "nomic-ai/nomic-embed-text-v1.5" });
      expect(e.name).toBe("nomic-embed-text-v1.5");
    });
  });

  // ── Auto-detection ──────────────────────────────────────────────────────
  describe("dimension auto-detection", () => {
    it("auto-detects dimensions on first embed() when dim=0", async () => {
      // First call is the auto-detect test embed, second is the real embed
      mockPipe
        .mockResolvedValueOnce(fakeTensor(1, 384)) // test embed → 384 dims
        .mockResolvedValueOnce(fakeTensor(1, 384)); // actual embed

      const e = new HuggingFaceEmbedder({ model: "some/model" });
      expect(e.dimensions).toBe(0);

      await e.embed("hello");
      expect(e.dimensions).toBe(384);
    });

    it("skips auto-detect when dim is provided", async () => {
      const e = new HuggingFaceEmbedder({ dim: 768 });
      await e.embed("hello");

      // Should only have 1 call (the actual embed), not 2 (test + actual)
      expect(mockPipe).toHaveBeenCalledTimes(1);
    });
  });

  // ── embed() ─────────────────────────────────────────────────────────────
  describe("embed()", () => {
    it("prepends docPrefix to text", async () => {
      const e = new HuggingFaceEmbedder({ dim: 768, docPrefix: "search_document: " });
      await e.embed("hello world");

      expect(mockPipe).toHaveBeenCalledWith("search_document: hello world", {
        pooling: "mean",
        normalize: true,
      });
    });

    it("uses no prefix when docPrefix is not set", async () => {
      const e = new HuggingFaceEmbedder({ dim: 768 });
      await e.embed("hello world");

      expect(mockPipe).toHaveBeenCalledWith("hello world", {
        pooling: "mean",
        normalize: true,
      });
    });

    it("returns a Float32Array of correct length", async () => {
      const e = new HuggingFaceEmbedder({ dim: 768 });
      const result = await e.embed("test");

      expect(result).toBeInstanceOf(Float32Array);
      expect(result.length).toBe(768);
    });

    it("reuses the pipeline on repeated calls (lazy init)", async () => {
      const { pipeline: mockPipelineFactory } = await import("@huggingface/transformers");
      const e = new HuggingFaceEmbedder({ dim: 768 });
      await e.embed("a");
      await e.embed("b");

      // pipeline() should only be called once (lazy singleton)
      expect(mockPipelineFactory).toHaveBeenCalledTimes(1);
    });

    it("uses custom pooling and normalize settings", async () => {
      const e = new HuggingFaceEmbedder({
        dim: 768,
        pooling: "cls",
        normalize: false,
      });
      await e.embed("test");

      expect(mockPipe).toHaveBeenCalledWith("test", {
        pooling: "cls",
        normalize: false,
      });
    });
  });

  // ── embedQuery() ────────────────────────────────────────────────────────
  describe("embedQuery()", () => {
    it("prepends queryPrefix to text", async () => {
      const e = new HuggingFaceEmbedder({
        dim: 768,
        queryPrefix: "search_query: ",
      });
      await e.embedQuery("find something");

      expect(mockPipe).toHaveBeenCalledWith("search_query: find something", {
        pooling: "mean",
        normalize: true,
      });
    });

    it("uses no prefix when queryPrefix is not set", async () => {
      const e = new HuggingFaceEmbedder({ dim: 768 });
      await e.embedQuery("find something");

      expect(mockPipe).toHaveBeenCalledWith("find something", {
        pooling: "mean",
        normalize: true,
      });
    });

    it("returns a Float32Array of correct length", async () => {
      const e = new HuggingFaceEmbedder({ dim: 768 });
      const result = await e.embedQuery("query");

      expect(result).toBeInstanceOf(Float32Array);
      expect(result.length).toBe(768);
    });
  });

  // ── embedBatch() ────────────────────────────────────────────────────────
  describe("embedBatch()", () => {
    it("prefixes every text with docPrefix", async () => {
      mockPipe.mockResolvedValue(fakeTensor(3, 768));
      const e = new HuggingFaceEmbedder({
        dim: 768,
        docPrefix: "search_document: ",
      });
      await e.embedBatch(["a", "b", "c"]);

      expect(mockPipe).toHaveBeenCalledWith(
        ["search_document: a", "search_document: b", "search_document: c"],
        { pooling: "mean", normalize: true }
      );
    });

    it("passes raw texts when no docPrefix", async () => {
      mockPipe.mockResolvedValue(fakeTensor(2, 768));
      const e = new HuggingFaceEmbedder({ dim: 768 });
      await e.embedBatch(["a", "b"]);

      expect(mockPipe).toHaveBeenCalledWith(["a", "b"], {
        pooling: "mean",
        normalize: true,
      });
    });

    it("returns one Float32Array per input text", async () => {
      mockPipe.mockResolvedValue(fakeTensor(3, 768));
      const e = new HuggingFaceEmbedder({ dim: 768 });
      const results = await e.embedBatch(["a", "b", "c"]);

      expect(results).toHaveLength(3);
      for (const r of results) {
        expect(r).toBeInstanceOf(Float32Array);
        expect(r.length).toBe(768);
      }
    });

    it("correctly slices the flat tensor into per-text embeddings", async () => {
      const DIMS = 768;
      mockPipe.mockResolvedValue(fakeTensor(2, DIMS));
      const e = new HuggingFaceEmbedder({ dim: DIMS });
      const [first, second] = await e.embedBatch(["x", "y"]);

      // First embedding should be indices 0..767, second 768..1535
      expect(first[0]).toBeCloseTo(0 / (2 * DIMS));
      expect(second[0]).toBeCloseTo(DIMS / (2 * DIMS));
    });

    it("batches in groups of 32", async () => {
      // Create 40 texts -> should produce 2 calls (32 + 8)
      const texts = Array.from({ length: 40 }, (_, i) => `text${i}`);
      mockPipe.mockResolvedValueOnce(fakeTensor(32, 768)).mockResolvedValueOnce(fakeTensor(8, 768));

      const e = new HuggingFaceEmbedder({ dim: 768 });
      const results = await e.embedBatch(texts);

      expect(mockPipe).toHaveBeenCalledTimes(2);
      expect(results).toHaveLength(40);

      // First call should have 32 items
      const firstCallArgs = mockPipe.mock.calls[0][0] as string[];
      expect(firstCallArgs).toHaveLength(32);

      // Second call should have 8 items
      const secondCallArgs = mockPipe.mock.calls[1][0] as string[];
      expect(secondCallArgs).toHaveLength(8);
    });

    it("handles empty input", async () => {
      const e = new HuggingFaceEmbedder({ dim: 768 });
      const results = await e.embedBatch([]);

      expect(results).toEqual([]);
      expect(mockPipe).not.toHaveBeenCalled();
    });
  });

  // ── init() / dispose() ─────────────────────────────────────────────────
  describe("init() & dispose()", () => {
    it("init() creates the pipeline eagerly", async () => {
      const { pipeline: mockPipelineFactory } = await import("@huggingface/transformers");
      const e = new HuggingFaceEmbedder({ dim: 768 });
      await e.init();

      expect(mockPipelineFactory).toHaveBeenCalledTimes(1);
    });

    it("dispose() clears the pipeline so it recreates on next use", async () => {
      const { pipeline: mockPipelineFactory } = await import("@huggingface/transformers");
      const e = new HuggingFaceEmbedder({ dim: 768 });
      await e.embed("test");
      expect(mockPipelineFactory).toHaveBeenCalledTimes(1);

      await e.dispose();
      await e.embed("test2");
      expect(mockPipelineFactory).toHaveBeenCalledTimes(2);
    });
  });

  // ── Config / progress callback ──────────────────────────────────────────
  describe("config options", () => {
    it("passes progress_callback when onProgress is provided", async () => {
      const { pipeline: mockPipelineFactory } = await import("@huggingface/transformers");
      const onProgress = vi.fn();
      const e = new HuggingFaceEmbedder({ dim: 768, onProgress });
      await e.embed("test");

      const factoryCall = (mockPipelineFactory as Mock).mock.calls[0];
      // Third argument is the options object with progress_callback
      expect(factoryCall[2]).toHaveProperty("progress_callback");
      expect(typeof factoryCall[2].progress_callback).toBe("function");
    });

    it("progress_callback normalises percentage to 0-1", async () => {
      const { pipeline: mockPipelineFactory } = await import("@huggingface/transformers");
      const onProgress = vi.fn();
      const e = new HuggingFaceEmbedder({ dim: 768, onProgress });
      await e.embed("test");

      const factoryCall = (mockPipelineFactory as Mock).mock.calls[0];
      const callback = factoryCall[2].progress_callback;

      // Simulate a progress event with progress = 50 (i.e. 50%)
      callback({ status: "downloading", progress: 50 });
      expect(onProgress).toHaveBeenCalledWith(0.5);
    });

    it("progress_callback ignores events without progress field", async () => {
      const { pipeline: mockPipelineFactory } = await import("@huggingface/transformers");
      const onProgress = vi.fn();
      const e = new HuggingFaceEmbedder({ dim: 768, onProgress });
      await e.embed("test");

      const factoryCall = (mockPipelineFactory as Mock).mock.calls[0];
      const callback = factoryCall[2].progress_callback;

      callback({ status: "ready" }); // no progress field
      expect(onProgress).not.toHaveBeenCalled();
    });

    it("uses custom model when provided", async () => {
      const { pipeline: mockPipelineFactory } = await import("@huggingface/transformers");
      const e = new HuggingFaceEmbedder({ model: "custom/model", dim: 512 });
      await e.embed("test");

      expect(mockPipelineFactory).toHaveBeenCalledWith(
        "feature-extraction",
        "custom/model",
        expect.anything()
      );
    });
  });
});

// ── Backward compatibility: Embedder alias ──────────────────────────────────

describe("Embedder (backward-compat alias)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPipe.mockResolvedValue(fakeTensor(1, 768));
  });

  it("is an instance of HuggingFaceEmbedder", () => {
    const e = new Embedder();
    expect(e).toBeInstanceOf(HuggingFaceEmbedder);
  });

  it("uses nomic preset dimensions (768) by default", () => {
    const e = new Embedder();
    expect(e.dimensions).toBe(768);
  });

  it("prepends nomic prefixes by default", async () => {
    const e = new Embedder();
    await e.embed("hello");

    expect(mockPipe).toHaveBeenCalledWith("search_document: hello", {
      pooling: "mean",
      normalize: true,
    });
  });

  it("applies query prefix for embedQuery", async () => {
    const e = new Embedder();
    await e.embedQuery("find");

    expect(mockPipe).toHaveBeenCalledWith("search_query: find", {
      pooling: "mean",
      normalize: true,
    });
  });

  it("accepts legacy config with custom model", async () => {
    const { pipeline: mockPipelineFactory } = await import("@huggingface/transformers");
    // Auto-detect test embed + actual embed
    mockPipe.mockResolvedValueOnce(fakeTensor(1, 512)).mockResolvedValueOnce(fakeTensor(1, 512));

    const e = new Embedder({ model: "custom/model" });
    await e.embed("test");

    expect(mockPipelineFactory).toHaveBeenCalledWith(
      "feature-extraction",
      "custom/model",
      expect.anything()
    );
  });
});

// ── getModelCacheDir() ──────────────────────────────────────────────────────

describe("getModelCacheDir()", () => {
  it("returns the value of env.cacheDir from @huggingface/transformers", async () => {
    // index.ts overwrites env.cacheDir at module-load time, so we can only
    // assert that getModelCacheDir() returns the same value as env.cacheDir
    // (i.e. the two stay in sync), not a specific path.
    const { env } = await import("@huggingface/transformers");
    const dir = getModelCacheDir();
    expect(dir).toBe(env.cacheDir);
  });

  it("returns a string", () => {
    expect(typeof getModelCacheDir()).toBe("string");
  });
});

// ── isModelCached() ─────────────────────────────────────────────────────────

describe("isModelCached()", () => {
  const mockExistsSync = vi.mocked(existsSync);

  beforeEach(() => {
    mockExistsSync.mockReset();
  });

  it("returns true when the model directory exists", () => {
    mockExistsSync.mockReturnValue(true);
    expect(isModelCached("nomic-ai/nomic-embed-text-v1.5")).toBe(true);
  });

  it("returns false when the model directory does not exist", () => {
    mockExistsSync.mockReturnValue(false);
    expect(isModelCached("nomic-ai/nomic-embed-text-v1.5")).toBe(false);
  });

  it("checks the correct path for an org/repo model ID", () => {
    mockExistsSync.mockReturnValue(false);
    isModelCached("BAAI/bge-m3", "/mock/cache/ragclaw/models");
    expect(mockExistsSync).toHaveBeenCalledWith(
      join("/mock/cache/ragclaw/models", "BAAI", "bge-m3")
    );
  });

  it("checks the correct path for a single-segment model ID", () => {
    mockExistsSync.mockReturnValue(false);
    isModelCached("my-model", "/mock/cache/ragclaw/models");
    expect(mockExistsSync).toHaveBeenCalledWith(join("/mock/cache/ragclaw/models", "my-model"));
  });

  it("uses a custom cacheDir when provided", () => {
    mockExistsSync.mockReturnValue(true);
    const result = isModelCached("org/model", "/custom/cache");
    expect(mockExistsSync).toHaveBeenCalledWith(join("/custom/cache", "org", "model"));
    expect(result).toBe(true);
  });

  it("uses env.cacheDir when no cacheDir argument is given", () => {
    mockExistsSync.mockReturnValue(false);
    // We can't rely on the exact path since index.ts sets env.cacheDir at load time.
    // Instead verify that the path contains the model segments.
    isModelCached("org/model");
    const [[checkedPath]] = mockExistsSync.mock.calls;
    expect(checkedPath as string).toContain("org");
    expect(checkedPath as string).toContain("model");
  });

  it("handles deep model IDs with multiple slashes as a single path join", () => {
    mockExistsSync.mockReturnValue(false);
    isModelCached("org/sub/model", "/mock/cache/ragclaw/models");
    expect(mockExistsSync).toHaveBeenCalledWith(
      join("/mock/cache/ragclaw/models", "org", "sub", "model")
    );
  });
});
