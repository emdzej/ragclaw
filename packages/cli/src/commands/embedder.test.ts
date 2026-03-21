import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import type { EmbedderPlugin } from "@emdzej/ragclaw-core";

// ── Mocks ────────────────────────────────────────────────────────────────────
// Must be hoisted before any module imports that transitively use them.

// Silence chalk colouring so assertions work on plain strings
vi.mock("chalk", () => {
  const id = (s: unknown) => String(s);
  const c = Object.assign(id, {
    bold: id, dim: id, cyan: id, green: id, red: id, yellow: id,
  });
  return { default: c };
});

// Capture console output instead of printing to terminal
const consoleSpy = {
  log: vi.spyOn(console, "log").mockImplementation(() => {}),
  error: vi.spyOn(console, "error").mockImplementation(() => {}),
};

// Stub ora so spinner methods are no-ops and we can assert on them
const spinnerMock = {
  text: "",
  succeed: vi.fn(),
  fail: vi.fn(),
  start: vi.fn(),
};
spinnerMock.start.mockReturnValue(spinnerMock);
vi.mock("ora", () => ({ default: vi.fn(() => spinnerMock) }));

// Mock @emdzej/ragclaw-core exports used by embedder.ts
vi.mock("@emdzej/ragclaw-core", () => ({
  listPresets: vi.fn(() => ["nomic", "bge", "mxbai", "minilm"]),
  resolvePreset: vi.fn((alias: string) => {
    const presets: Record<string, { model: string; dim: number; estimatedRAM: number }> = {
      nomic: { model: "nomic-ai/nomic-embed-text-v1.5", dim: 768, estimatedRAM: 600 * 1024 * 1024 },
      bge:   { model: "BAAI/bge-m3",                   dim: 1024, estimatedRAM: 2.3 * 1024 ** 3 },
      mxbai: { model: "mixedbread-ai/mxbai-embed-large-v1", dim: 1024, estimatedRAM: 1.4 * 1024 ** 3 },
      minilm:{ model: "sentence-transformers/all-MiniLM-L6-v2", dim: 384, estimatedRAM: 90 * 1024 * 1024 },
    };
    return presets[alias.toLowerCase()];
  }),
  getConfig: vi.fn(() => ({
    enabledPlugins: [],
    scanGlobalNpm: false,
    pluginConfig: {},
  })),
  checkSystemRequirements: vi.fn(() => ({ canRun: true, warnings: [], errors: [] })),
  createEmbedder: vi.fn(),
  isModelCached: vi.fn(),
  getModelCacheDir: vi.fn(() => "/mock/cache/ragclaw/models"),
}));

// Mock PluginLoader — typed to avoid `never[]` inference
type PluginEmbedderEntry = { pluginName: string; embedder: EmbedderPlugin };
const pluginLoaderMock = {
  loadAll: vi.fn(async () => {}),
  getEmbedders: vi.fn((): PluginEmbedderEntry[] => []),
};
vi.mock("../plugins/loader.js", () => ({
  // Must use a real constructor function (not an arrow fn) so `new PluginLoader(...)` works
  PluginLoader: vi.fn(function () { return pluginLoaderMock; }),
}));

// Import the functions under test AFTER all vi.mock calls
const { embedderList, embedderDownload } = await import("./embedder.js");
import {
  isModelCached as mockIsModelCached,
  createEmbedder as mockCreateEmbedder,
} from "@emdzej/ragclaw-core";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal mock EmbedderPlugin. */
function makeEmbedder(overrides: Record<string, unknown> = {}) {
  return {
    name: "mock-model",
    dimensions: 768,
    init: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
    embed: vi.fn(async () => new Float32Array(768)),
    embedQuery: vi.fn(async () => new Float32Array(768)),
    embedBatch: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array(768))),
    ...overrides,
  };
}

// ── embedderDownload() ────────────────────────────────────────────────────────

describe("embedderDownload()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spinnerMock.start.mockReturnValue(spinnerMock);
    pluginLoaderMock.loadAll.mockResolvedValue(undefined);
    pluginLoaderMock.getEmbedders.mockReturnValue([]);
    // Default: model not cached, createEmbedder returns a working mock
    (mockIsModelCached as Mock).mockReturnValue(false);
    (mockCreateEmbedder as Mock).mockReturnValue(makeEmbedder());
  });

  afterEach(() => {
    vi.clearAllMocks();
    // Re-establish the spinner.start chain after clearAllMocks wipes return values
    spinnerMock.start.mockReturnValue(spinnerMock);
  });

  // ── Already-cached detection ────────────────────────────────────────────

  describe("already-cached models", () => {
    it("skips download and logs 'Already cached' when model is cached", async () => {
      (mockIsModelCached as Mock).mockReturnValue(true);

      await embedderDownload("nomic", {});

      // createEmbedder should NOT be called — no download needed
      expect(mockCreateEmbedder).not.toHaveBeenCalled();
      // Spinner should not be used either
      expect(spinnerMock.succeed).not.toHaveBeenCalled();
      // Console should mention the model
      const output = consoleSpy.log.mock.calls.flat().join("\n");
      expect(output).toContain("Already cached");
      expect(output).toContain("nomic");
    });

    it("lists each skipped model name in the summary", async () => {
      (mockIsModelCached as Mock).mockReturnValue(true);

      await embedderDownload("bge", {});

      const output = consoleSpy.log.mock.calls.flat().join("\n");
      expect(output).toContain("bge");
    });
  });

  // ── Download a single built-in preset ──────────────────────────────────

  describe("single preset download", () => {
    it("calls createEmbedder with the correct alias", async () => {
      await embedderDownload("nomic", {});

      expect(mockCreateEmbedder).toHaveBeenCalledWith(
        expect.objectContaining({ alias: "nomic" }),
      );
    });

    it("calls init() then dispose() on the created embedder", async () => {
      const embedder = makeEmbedder();
      (mockCreateEmbedder as Mock).mockReturnValue(embedder);

      await embedderDownload("nomic", {});

      expect(embedder.init).toHaveBeenCalledTimes(1);
      expect(embedder.dispose).toHaveBeenCalledTimes(1);
    });

    it("marks the spinner as succeeded after download", async () => {
      await embedderDownload("nomic", {});

      expect(spinnerMock.succeed).toHaveBeenCalledTimes(1);
      expect(spinnerMock.fail).not.toHaveBeenCalled();
    });

    it("shows 'Downloaded: 1' in the summary", async () => {
      await embedderDownload("bge", {});

      const output = consoleSpy.log.mock.calls.flat().join("\n");
      expect(output).toContain("Downloaded: 1");
    });

    it("passes onProgress callback to createEmbedder", async () => {
      await embedderDownload("nomic", {});

      expect(mockCreateEmbedder).toHaveBeenCalledWith(
        expect.objectContaining({ onProgress: expect.any(Function) }),
      );
    });

    it("updates spinner text with progress percentage during download", async () => {
      let capturedProgress: ((p: number) => void) | undefined;
      (mockCreateEmbedder as Mock).mockImplementation((cfg: { onProgress?: (p: number) => void }) => {
        capturedProgress = cfg.onProgress;
        return makeEmbedder();
      });

      await embedderDownload("nomic", {});

      // Simulate a mid-download progress event
      capturedProgress?.(0.42);
      expect(spinnerMock.text).toContain("42%");
    });
  });

  // ── Download by raw HuggingFace model ID ───────────────────────────────

  describe("raw HuggingFace model ID", () => {
    it("falls through to model-ID path when alias is not a known preset", async () => {
      await embedderDownload("some-org/custom-model", {});

      // Should create an embedder without an alias (raw model path)
      expect(mockCreateEmbedder).toHaveBeenCalledWith(
        expect.objectContaining({ model: "some-org/custom-model" }),
      );
    });

    it("calls init() and dispose() on the raw-model embedder", async () => {
      const embedder = makeEmbedder({ name: "custom-model" });
      (mockCreateEmbedder as Mock).mockReturnValue(embedder);

      await embedderDownload("some-org/custom-model", {});

      expect(embedder.init).toHaveBeenCalledTimes(1);
      expect(embedder.dispose).toHaveBeenCalledTimes(1);
    });
  });

  // ── Download all (--all / no name) ─────────────────────────────────────

  describe("download all presets (--all)", () => {
    it("downloads all four built-in presets when --all is set", async () => {
      await embedderDownload(undefined, { all: true });

      // createEmbedder called once per preset (4 total)
      expect(mockCreateEmbedder).toHaveBeenCalledTimes(4);
    });

    it("downloads all presets when name is omitted (no args)", async () => {
      await embedderDownload(undefined, {});

      expect(mockCreateEmbedder).toHaveBeenCalledTimes(4);
    });

    it("shows 'Downloaded: 4' when all presets were new", async () => {
      await embedderDownload(undefined, { all: true });

      const output = consoleSpy.log.mock.calls.flat().join("\n");
      expect(output).toContain("Downloaded: 4");
    });

    it("skips presets that are already cached and downloads the rest", async () => {
      // nomic is cached, others are not
      (mockIsModelCached as Mock).mockImplementation((modelId: string) =>
        modelId.includes("nomic"),
      );

      await embedderDownload(undefined, { all: true });

      // Only 3 createEmbedder calls (bge, mxbai, minilm)
      expect(mockCreateEmbedder).toHaveBeenCalledTimes(3);
      const output = consoleSpy.log.mock.calls.flat().join("\n");
      expect(output).toContain("Downloaded: 3");
      expect(output).toContain("Already cached: 1");
    });
  });

  // ── Plugin embedders ───────────────────────────────────────────────────

  describe("plugin embedders", () => {
    it("calls init() on a plugin embedder when downloading all", async () => {
      const pluginEmbedder = makeEmbedder({ name: "plugin-model" });
      pluginLoaderMock.getEmbedders.mockReturnValue([
        { pluginName: "ragclaw-plugin-test", embedder: pluginEmbedder },
      ]);

      await embedderDownload(undefined, { all: true });

      expect(pluginEmbedder.init).toHaveBeenCalledTimes(1);
      expect(pluginEmbedder.dispose).toHaveBeenCalledTimes(1);
    });

    it("downloads a plugin embedder by plugin name", async () => {
      const pluginEmbedder = makeEmbedder({ name: "plugin-model" });
      pluginLoaderMock.getEmbedders.mockReturnValue([
        { pluginName: "ragclaw-plugin-test", embedder: pluginEmbedder },
      ]);

      await embedderDownload("ragclaw-plugin-test", {});

      expect(pluginEmbedder.init).toHaveBeenCalledTimes(1);
      expect(pluginEmbedder.dispose).toHaveBeenCalledTimes(1);
    });

    it("downloads a plugin embedder by embedder name", async () => {
      const pluginEmbedder = makeEmbedder({ name: "my-plugin-embedder" });
      pluginLoaderMock.getEmbedders.mockReturnValue([
        { pluginName: "ragclaw-plugin-test", embedder: pluginEmbedder },
      ]);

      await embedderDownload("my-plugin-embedder", {});

      expect(pluginEmbedder.init).toHaveBeenCalledTimes(1);
    });

    it("skips plugin embedder if its name looks like a cached HF model ID", async () => {
      (mockIsModelCached as Mock).mockReturnValue(true);
      const pluginEmbedder = makeEmbedder({ name: "org/hf-model" });
      pluginLoaderMock.getEmbedders.mockReturnValue([
        { pluginName: "ragclaw-plugin-hf", embedder: pluginEmbedder },
      ]);

      await embedderDownload("ragclaw-plugin-hf", {});

      expect(pluginEmbedder.init).not.toHaveBeenCalled();
      const output = consoleSpy.log.mock.calls.flat().join("\n");
      expect(output).toContain("Already cached");
    });

    it("does not skip plugin embedder whose name is not a HF model ID", async () => {
      // even if isModelCached returns true, a non-HF name (no "/") won't be checked
      (mockIsModelCached as Mock).mockReturnValue(true);
      const pluginEmbedder = makeEmbedder({ name: "plain-model-name" });
      pluginLoaderMock.getEmbedders.mockReturnValue([
        { pluginName: "ragclaw-plugin-x", embedder: pluginEmbedder },
      ]);

      await embedderDownload("ragclaw-plugin-x", {});

      // init IS called because "plain-model-name" doesn't contain "/"
      expect(pluginEmbedder.init).toHaveBeenCalledTimes(1);
    });

    it("calls init() without dispose() if plugin embedder has no dispose", async () => {
      const pluginEmbedder = {
        name: "plugin-model",
        dimensions: 512,
        init: vi.fn(async () => {}),
        embed: vi.fn(),
        embedQuery: vi.fn(),
        embedBatch: vi.fn(),
        // no dispose
      };
      pluginLoaderMock.getEmbedders.mockReturnValue([
        { pluginName: "ragclaw-plugin-nodispose", embedder: pluginEmbedder },
      ]);

      await expect(
        embedderDownload("ragclaw-plugin-nodispose", {}),
      ).resolves.not.toThrow();

      expect(pluginEmbedder.init).toHaveBeenCalledTimes(1);
    });
  });

  // ── Error handling ─────────────────────────────────────────────────────

  describe("error handling", () => {
    it("marks spinner as failed and exits with code 1 on download error", async () => {
      (mockCreateEmbedder as Mock).mockReturnValue(
        makeEmbedder({
          init: vi.fn(async () => {
            throw new Error("network error");
          }),
        }),
      );

      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("process.exit called");
      }) as never);

      await expect(embedderDownload("nomic", {})).rejects.toThrow("process.exit called");

      expect(spinnerMock.fail).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(1);

      exitSpy.mockRestore();
    });

    it("includes the error message in the spinner fail text", async () => {
      (mockCreateEmbedder as Mock).mockReturnValue(
        makeEmbedder({
          init: vi.fn(async () => {
            throw new Error("timeout fetching model");
          }),
        }),
      );

      vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("exit");
      }) as never);

      await expect(embedderDownload("nomic", {})).rejects.toThrow();

      const failArg: string = spinnerMock.fail.mock.calls[0][0];
      expect(failArg).toContain("timeout fetching model");
    });
  });

  // ── Cache dir header ───────────────────────────────────────────────────

  describe("output header", () => {
    it("prints the cache directory at the start", async () => {
      await embedderDownload("nomic", {});

      const output = consoleSpy.log.mock.calls.flat().join("\n");
      expect(output).toContain("/mock/cache/ragclaw/models");
    });
  });
});

// ── embedderList() — smoke test (logic already covered by integration) ───────

describe("embedderList()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spinnerMock.start.mockReturnValue(spinnerMock);
    pluginLoaderMock.loadAll.mockResolvedValue(undefined);
    pluginLoaderMock.getEmbedders.mockReturnValue([]);
  });

  it("runs without throwing", async () => {
    await expect(embedderList()).resolves.not.toThrow();
  });

  it("prints the four built-in preset aliases", async () => {
    await embedderList();
    const output = consoleSpy.log.mock.calls.flat().join("\n");
    expect(output).toContain("nomic");
    expect(output).toContain("bge");
    expect(output).toContain("mxbai");
    expect(output).toContain("minilm");
  });

  it("prints 'No plugin-provided embedders found' when there are none", async () => {
    await embedderList();
    const output = consoleSpy.log.mock.calls.flat().join("\n");
    expect(output).toContain("No plugin-provided embedders found");
  });

  it("prints plugin embedder names when plugins are loaded", async () => {
    pluginLoaderMock.getEmbedders.mockReturnValue([
      {
        pluginName: "ragclaw-plugin-test",
        embedder: {
          name: "test-embedder",
          dimensions: 512,
          embed: vi.fn(),
          embedQuery: vi.fn(),
          embedBatch: vi.fn(),
        },
      },
    ]);

    await embedderList();
    const output = consoleSpy.log.mock.calls.flat().join("\n");
    expect(output).toContain("test-embedder");
    expect(output).toContain("ragclaw-plugin-test");
  });
});
