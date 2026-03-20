import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// ── Mock @huggingface/transformers before importing the module ──────────────
// The Embedder uses `pipeline("feature-extraction", model, ...)` which downloads
// a multi-hundred-MB model.  We mock the entire module so tests are fast and offline.

const mockPipe: Mock = vi.fn();

vi.mock("@huggingface/transformers", () => ({
  pipeline: vi.fn(async () => mockPipe),
  env: { cacheDir: "" },
  Tensor: class {},
}));

// Must import AFTER vi.mock so the mock takes effect
const { Embedder } = await import("./index.js");

// ── Helpers ─────────────────────────────────────────────────────────────────
const DIMENSIONS = 768;

/** Build a fake Tensor-like object with a flat Float32Array of the given length. */
function fakeTensor(count: number): { data: Float32Array } {
  const data = new Float32Array(count * DIMENSIONS);
  // Fill with deterministic values so we can verify slicing
  for (let i = 0; i < data.length; i++) {
    data[i] = i / data.length;
  }
  return { data };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Embedder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: return a single-row tensor
    mockPipe.mockResolvedValue(fakeTensor(1));
  });

  // ── Constructor / dimensions ────────────────────────────────────────────
  describe("constructor & dimensions", () => {
    it("exposes dimensions = 768", () => {
      const e = new Embedder();
      expect(e.dimensions).toBe(768);
    });
  });

  // ── embed() ─────────────────────────────────────────────────────────────
  describe("embed()", () => {
    it("prepends 'search_document: ' prefix to text", async () => {
      const e = new Embedder();
      await e.embed("hello world");

      expect(mockPipe).toHaveBeenCalledWith("search_document: hello world", {
        pooling: "mean",
        normalize: true,
      });
    });

    it("returns a Float32Array of length 768", async () => {
      const e = new Embedder();
      const result = await e.embed("test");

      expect(result).toBeInstanceOf(Float32Array);
      expect(result.length).toBe(DIMENSIONS);
    });

    it("reuses the pipeline on repeated calls (lazy init)", async () => {
      const { pipeline: mockPipelineFactory } = await import("@huggingface/transformers");
      const e = new Embedder();
      await e.embed("a");
      await e.embed("b");

      // pipeline() should only be called once (lazy singleton)
      expect(mockPipelineFactory).toHaveBeenCalledTimes(1);
    });
  });

  // ── embedQuery() ────────────────────────────────────────────────────────
  describe("embedQuery()", () => {
    it("prepends 'search_query: ' prefix to text", async () => {
      const e = new Embedder();
      await e.embedQuery("find something");

      expect(mockPipe).toHaveBeenCalledWith("search_query: find something", {
        pooling: "mean",
        normalize: true,
      });
    });

    it("returns a Float32Array of length 768", async () => {
      const e = new Embedder();
      const result = await e.embedQuery("query");

      expect(result).toBeInstanceOf(Float32Array);
      expect(result.length).toBe(DIMENSIONS);
    });
  });

  // ── embedBatch() ────────────────────────────────────────────────────────
  describe("embedBatch()", () => {
    it("prefixes every text with 'search_document: '", async () => {
      mockPipe.mockResolvedValue(fakeTensor(3));
      const e = new Embedder();
      await e.embedBatch(["a", "b", "c"]);

      expect(mockPipe).toHaveBeenCalledWith(
        ["search_document: a", "search_document: b", "search_document: c"],
        { pooling: "mean", normalize: true },
      );
    });

    it("returns one Float32Array per input text", async () => {
      mockPipe.mockResolvedValue(fakeTensor(3));
      const e = new Embedder();
      const results = await e.embedBatch(["a", "b", "c"]);

      expect(results).toHaveLength(3);
      for (const r of results) {
        expect(r).toBeInstanceOf(Float32Array);
        expect(r.length).toBe(DIMENSIONS);
      }
    });

    it("correctly slices the flat tensor into per-text embeddings", async () => {
      mockPipe.mockResolvedValue(fakeTensor(2));
      const e = new Embedder();
      const [first, second] = await e.embedBatch(["x", "y"]);

      // First embedding should be indices 0..767, second 768..1535
      expect(first[0]).toBeCloseTo(0 / (2 * DIMENSIONS));
      expect(second[0]).toBeCloseTo(DIMENSIONS / (2 * DIMENSIONS));
    });

    it("batches in groups of 32", async () => {
      // Create 40 texts → should produce 2 calls (32 + 8)
      const texts = Array.from({ length: 40 }, (_, i) => `text${i}`);
      mockPipe
        .mockResolvedValueOnce(fakeTensor(32))
        .mockResolvedValueOnce(fakeTensor(8));

      const e = new Embedder();
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
      const e = new Embedder();
      const results = await e.embedBatch([]);

      expect(results).toEqual([]);
      expect(mockPipe).not.toHaveBeenCalled();
    });
  });

  // ── Config / progress callback ──────────────────────────────────────────
  describe("config options", () => {
    it("passes progress_callback when onProgress is provided", async () => {
      const { pipeline: mockPipelineFactory } = await import("@huggingface/transformers");
      const onProgress = vi.fn();
      const e = new Embedder({ onProgress });
      await e.embed("test");

      const factoryCall = (mockPipelineFactory as Mock).mock.calls[0];
      // Third argument is the options object with progress_callback
      expect(factoryCall[2]).toHaveProperty("progress_callback");
      expect(typeof factoryCall[2].progress_callback).toBe("function");
    });

    it("progress_callback normalises percentage to 0–1", async () => {
      const { pipeline: mockPipelineFactory } = await import("@huggingface/transformers");
      const onProgress = vi.fn();
      const e = new Embedder({ onProgress });
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
      const e = new Embedder({ onProgress });
      await e.embed("test");

      const factoryCall = (mockPipelineFactory as Mock).mock.calls[0];
      const callback = factoryCall[2].progress_callback;

      callback({ status: "ready" }); // no progress field
      expect(onProgress).not.toHaveBeenCalled();
    });

    it("uses custom model when provided", async () => {
      const { pipeline: mockPipelineFactory } = await import("@huggingface/transformers");
      const e = new Embedder({ model: "custom/model" });
      await e.embed("test");

      expect(mockPipelineFactory).toHaveBeenCalledWith(
        "feature-extraction",
        "custom/model",
        expect.anything(),
      );
    });
  });
});
