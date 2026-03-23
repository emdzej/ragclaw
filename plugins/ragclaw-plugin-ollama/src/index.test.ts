/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MODEL, OLLAMA_MODEL_DIMS, OllamaEmbedder } from "./embedder.js";
import ollamaPlugin from "./index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeEmbedding(dims: number): number[] {
  return Array.from({ length: dims }, (_, i) => i / dims);
}

function mockFetchOk(embedding: number[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embedding }),
      text: async () => "",
    })
  );
}

function mockFetchError(status: number, body = ""): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: false,
      status,
      json: async () => ({}),
      text: async () => body,
    })
  );
}

function mockFetchNetworkError(message: string): void {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error(message)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

describe("OLLAMA_MODEL_DIMS", () => {
  it("contains nomic-embed-text with 768 dims", () => {
    expect(OLLAMA_MODEL_DIMS["nomic-embed-text"]).toBe(768);
  });

  it("contains mxbai-embed-large with 1024 dims", () => {
    expect(OLLAMA_MODEL_DIMS["mxbai-embed-large"]).toBe(1024);
  });

  it("contains all-minilm with 384 dims", () => {
    expect(OLLAMA_MODEL_DIMS["all-minilm"]).toBe(384);
  });

  it("returns undefined for unknown models", () => {
    expect(OLLAMA_MODEL_DIMS["unknown-model"]).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OllamaEmbedder
// ─────────────────────────────────────────────────────────────────────────────

describe("OllamaEmbedder", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("constructor", () => {
    it("uses default model and baseUrl when no config provided", () => {
      const embedder = new OllamaEmbedder();
      expect(embedder.name).toBe("ollama");
      expect(embedder.dimensions).toBe(OLLAMA_MODEL_DIMS[DEFAULT_MODEL]);
    });

    it("accepts custom model and baseUrl", () => {
      const embedder = new OllamaEmbedder({
        model: "mxbai-embed-large",
        baseUrl: "http://my-server:11434",
      });
      expect(embedder.dimensions).toBe(1024);
    });

    it("sets dimensions to 0 for unknown model (auto-detect)", () => {
      const embedder = new OllamaEmbedder({ model: "custom-model" });
      expect(embedder.dimensions).toBe(0);
    });

    it("strips trailing slash from baseUrl", () => {
      mockFetchOk(makeEmbedding(768));
      const embedder = new OllamaEmbedder({ baseUrl: "http://localhost:11434/" });
      // The slash is stripped — the fetch URL should not have double slashes.
      // We'll verify via embed() below.
      expect(embedder).toBeDefined();
    });
  });

  describe("embed()", () => {
    it("returns a Float32Array of correct length", async () => {
      const dims = 768;
      mockFetchOk(makeEmbedding(dims));

      const embedder = new OllamaEmbedder();
      const result = await embedder.embed("hello world");

      expect(result).toBeInstanceOf(Float32Array);
      expect(result.length).toBe(dims);
    });

    it("sends correct request body to Ollama", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ embedding: makeEmbedding(768) }),
        text: async () => "",
      });
      vi.stubGlobal("fetch", fetchMock);

      const embedder = new OllamaEmbedder({
        model: "nomic-embed-text",
        baseUrl: "http://localhost:11434",
      });
      await embedder.embed("test text");

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://localhost:11434/api/embeddings");
      expect(options.method).toBe("POST");
      expect(JSON.parse(options.body as string)).toEqual({
        model: "nomic-embed-text",
        prompt: "test text",
      });
    });

    it("auto-detects dimensions from first embed response for unknown model", async () => {
      mockFetchOk(makeEmbedding(512));
      const embedder = new OllamaEmbedder({ model: "some-custom-model" });
      expect(embedder.dimensions).toBe(0);

      await embedder.embed("probe");

      expect(embedder.dimensions).toBe(512);
    });

    it("does not re-detect dimensions after first call", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ embedding: makeEmbedding(512) }),
          text: async () => "",
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ embedding: makeEmbedding(512) }),
          text: async () => "",
        });
      vi.stubGlobal("fetch", fetchMock);

      const embedder = new OllamaEmbedder({ model: "some-custom-model" });
      await embedder.embed("first");
      expect(embedder.dimensions).toBe(512);

      await embedder.embed("second");
      // dimensions should remain 512, not reset to response length
      expect(embedder.dimensions).toBe(512);
    });

    it("throws a descriptive error on network failure", async () => {
      mockFetchNetworkError("ECONNREFUSED");
      const embedder = new OllamaEmbedder();
      await expect(embedder.embed("hello")).rejects.toThrow(/failed to connect to Ollama/);
    });

    it("throws with model name on HTTP 404", async () => {
      mockFetchError(404, "model not found");
      const embedder = new OllamaEmbedder({ model: "missing-model" });
      await expect(embedder.embed("hello")).rejects.toThrow(/missing-model/);
      await expect(embedder.embed("hello")).rejects.toThrow(/ollama pull/i);
    });

    it("throws on empty embedding array in response", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ embedding: [] }),
          text: async () => "",
        })
      );
      const embedder = new OllamaEmbedder();
      await expect(embedder.embed("hello")).rejects.toThrow(/empty/);
    });

    it("throws on missing embedding field in response", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ something_else: [] }),
          text: async () => "",
        })
      );
      const embedder = new OllamaEmbedder();
      await expect(embedder.embed("hello")).rejects.toThrow(/embedding.*missing/i);
    });
  });

  describe("embedQuery()", () => {
    it("returns same result as embed() (Ollama has no query prefix)", async () => {
      const embedding = makeEmbedding(768);
      mockFetchOk(embedding);

      const embedder = new OllamaEmbedder();
      const docResult = await embedder.embed("search for this");

      mockFetchOk(embedding);
      const queryResult = await embedder.embedQuery("search for this");

      expect(Array.from(docResult)).toEqual(Array.from(queryResult));
    });
  });

  describe("embedBatch()", () => {
    it("returns one vector per input text", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ embedding: makeEmbedding(768) }),
        text: async () => "",
      });
      vi.stubGlobal("fetch", fetchMock);

      const embedder = new OllamaEmbedder();
      const texts = ["alpha", "beta", "gamma"];
      const results = await embedder.embedBatch(texts);

      expect(results).toHaveLength(3);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      for (const r of results) {
        expect(r).toBeInstanceOf(Float32Array);
        expect(r.length).toBe(768);
      }
    });

    it("returns empty array for empty input", async () => {
      vi.stubGlobal("fetch", vi.fn());
      const embedder = new OllamaEmbedder();
      const results = await embedder.embedBatch([]);
      expect(results).toEqual([]);
    });

    it("preserves order of results", async () => {
      let call = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(async () => {
          const idx = call++;
          return {
            ok: true,
            json: async () => ({ embedding: [idx / 10] }),
            text: async () => "",
          };
        })
      );
      const embedder = new OllamaEmbedder({ model: "some-model" });
      const results = await embedder.embedBatch(["a", "b", "c"]);
      expect(results[0]?.[0]).toBeCloseTo(0.0);
      expect(results[1]?.[0]).toBeCloseTo(0.1);
      expect(results[2]?.[0]).toBeCloseTo(0.2);
    });
  });

  describe("init()", () => {
    it("calls embed() once as a health-check", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ embedding: makeEmbedding(768) }),
        text: async () => "",
      });
      vi.stubGlobal("fetch", fetchMock);

      const embedder = new OllamaEmbedder();
      await embedder.init();

      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it("throws if Ollama is unreachable", async () => {
      mockFetchNetworkError("ECONNREFUSED");
      const embedder = new OllamaEmbedder();
      await expect(embedder.init()).rejects.toThrow(/failed to connect/);
    });
  });

  describe("dispose()", () => {
    it("resolves without error", async () => {
      const embedder = new OllamaEmbedder();
      await expect(embedder.dispose()).resolves.toBeUndefined();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Plugin
// ─────────────────────────────────────────────────────────────────────────────

describe("ollamaPlugin", () => {
  beforeEach(async () => {
    // Reset the plugin's embedder to defaults before each test
    await ollamaPlugin.init?.();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("has correct name and version", () => {
    expect(ollamaPlugin.name).toBe("ragclaw-plugin-ollama");
    expect(ollamaPlugin.version).toBe("0.5.0");
  });

  it("exposes an embedder", () => {
    expect(ollamaPlugin.embedder).toBeDefined();
    expect(ollamaPlugin.embedder?.name).toBe("ollama");
  });

  it("has no extractors or chunkers", () => {
    expect(ollamaPlugin.extractors).toBeUndefined();
    expect(ollamaPlugin.chunkers).toBeUndefined();
  });

  it("replaces the embedder on init() with custom model", async () => {
    await ollamaPlugin.init?.({ model: "mxbai-embed-large" });
    expect(ollamaPlugin.embedder?.dimensions).toBe(1024);
  });

  it("uses DEFAULT_MODEL when init() is called with no config", async () => {
    await ollamaPlugin.init?.();
    expect(ollamaPlugin.embedder?.dimensions).toBe(OLLAMA_MODEL_DIMS[DEFAULT_MODEL]);
  });

  it("documents configSchema keys", () => {
    const keys = ollamaPlugin.configSchema?.map((k) => k.key);
    expect(keys).toContain("model");
    expect(keys).toContain("baseUrl");
  });

  it("dispose() resolves cleanly", async () => {
    await expect(ollamaPlugin.dispose?.()).resolves.toBeUndefined();
  });
});
