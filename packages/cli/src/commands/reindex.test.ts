/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import type { SourceRecord } from "@emdzej/ragclaw-core";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

type ReindexOutcome =
  | { status: "updated"; sourceId: string; chunks: number }
  | { status: "unchanged"; sourceId: string }
  | { status: "removed"; sourceId: string }
  | { status: "missing" }
  | { status: "skipped"; reason: string }
  | { status: "error"; error: string };

// ── Mocks ─────────────────────────────────────────────────────────────────────
// All vi.mock() calls must be hoisted before any module imports.

// Silence chalk colouring so assertions work on plain strings
vi.mock("chalk", () => {
  const id = (s: unknown) => String(s);
  const c = Object.assign(id, {
    bold: id,
    dim: id,
    cyan: id,
    green: id,
    red: id,
    yellow: id,
  });
  return { default: c };
});

// Capture console output
const consoleSpy = {
  log: vi.spyOn(console, "log").mockImplementation(() => {}),
  error: vi.spyOn(console, "error").mockImplementation(() => {}),
};

// Spinner stub
const spinnerMock = {
  text: "",
  start: vi.fn(),
  stop: vi.fn(),
  succeed: vi.fn(),
  fail: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
};
spinnerMock.start.mockReturnValue(spinnerMock);
vi.mock("ora", () => ({ default: vi.fn(() => spinnerMock) }));

// fs.existsSync — controlled per test
const mockExistsSync = vi.fn((_path: string) => true);
vi.mock("fs", () => ({ existsSync: (p: string) => mockExistsSync(p) }));

// Config helpers
vi.mock("../config.js", () => ({
  getDbPath: vi.fn((name: string) => `/mock/data/${name}.sqlite`),
  getConfig: vi.fn(() => ({
    enabledPlugins: [],
    scanGlobalNpm: false,
    pluginConfig: {},
    enforceGuards: false,
    allowUrls: false,
    blockPrivateUrls: true,
    allowedPaths: [],
    extractorLimits: {},
  })),
}));

// Store mock
const storeMock = {
  open: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  getMeta: vi.fn(async (_key: string) => null as string | null),
  listSources: vi.fn(async (): Promise<SourceRecord[]> => []),
};

// IndexingService mock
const indexingServiceMock = {
  init: vi.fn(async () => {}),
  reindexSource: vi.fn(
    async (): Promise<ReindexOutcome> => ({ status: "unchanged", sourceId: "s1" })
  ),
};

vi.mock("@emdzej/ragclaw-core", () => ({
  Store: vi.fn(function () {
    return storeMock;
  }),
  IndexingService: vi.fn(function () {
    return indexingServiceMock;
  }),
  createEmbedder: vi.fn(),
  resolvePreset: vi.fn((_alias: string) => null),
  checkSystemRequirements: vi.fn(() => ({ errors: [], warnings: [] })),
  isPathAllowed: vi.fn(() => ({ allowed: true })),
  isUrlAllowed: vi.fn(async () => ({ allowed: true })),
}));

// PluginLoader mock
const pluginLoaderMock = {
  loadAll: vi.fn(async () => {}),
  getEmbedder: vi.fn((): unknown => undefined),
  getChunkers: vi.fn(() => []),
};
vi.mock("../plugins/loader.js", () => ({
  PluginLoader: vi.fn(function () {
    return pluginLoaderMock;
  }),
}));

// Import SUT after all vi.mock calls
const { reindex } = await import("./reindex.js");

import { createEmbedder as mockCreateEmbedder } from "@emdzej/ragclaw-core";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEmbedder(overrides: Record<string, unknown> = {}) {
  return {
    name: "mock-model",
    dimensions: 768,
    embed: vi.fn(async () => new Float32Array(768)),
    embedQuery: vi.fn(async () => new Float32Array(768)),
    embedBatch: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array(768))),
    ...overrides,
  };
}

function makeSource(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    id: "s1",
    path: "/docs/readme.md",
    type: "file",
    contentHash: "abc123",
    indexedAt: Date.now(),
    ...overrides,
  };
}

const defaultOptions = { db: "default" };

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("reindex() — embedder resolution from DB metadata (Bug 2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spinnerMock.start.mockReturnValue(spinnerMock);
    mockExistsSync.mockReturnValue(true);
    storeMock.open.mockResolvedValue(undefined);
    storeMock.close.mockResolvedValue(undefined);
    storeMock.getMeta.mockResolvedValue(null);
    storeMock.listSources.mockResolvedValue([makeSource()]);
    pluginLoaderMock.loadAll.mockResolvedValue(undefined);
    pluginLoaderMock.getEmbedder.mockReturnValue(undefined);
    pluginLoaderMock.getChunkers.mockReturnValue([]);
    indexingServiceMock.init.mockResolvedValue(undefined);
    indexingServiceMock.reindexSource.mockResolvedValue({ status: "unchanged", sourceId: "s1" });
    (mockCreateEmbedder as Mock).mockReturnValue(makeEmbedder());
  });

  afterEach(() => {
    vi.clearAllMocks();
    spinnerMock.start.mockReturnValue(spinnerMock);
  });

  // ── Bug 2: reads embedder_model from DB metadata when no -e flag ──────────

  describe("embedder resolution from store metadata (no -e flag, no plugin)", () => {
    it("uses createEmbedder({ model }) when embedder_model is stored in DB", async () => {
      // Bug 2 fix: without it, reindex would use the global config default
      // embedder (e.g. bge) even though the DB was indexed with nomic.
      storeMock.getMeta.mockImplementation(async (key: string) => {
        if (key === "embedder_model") return "nomic-ai/nomic-embed-text-v1.5";
        if (key === "embedder_name") return "nomic-embed-text-v1.5";
        return null;
      });

      await reindex(defaultOptions);

      expect(mockCreateEmbedder).toHaveBeenCalledWith(
        expect.objectContaining({ model: "nomic-ai/nomic-embed-text-v1.5" })
      );
    });

    it("does NOT call createEmbedder with the display name alias when embedder_model is present", async () => {
      // The old crashing call would have been: createEmbedder({ alias: "nomic-embed-text-v1.5" })
      storeMock.getMeta.mockImplementation(async (key: string) => {
        if (key === "embedder_model") return "nomic-ai/nomic-embed-text-v1.5";
        if (key === "embedder_name") return "nomic-embed-text-v1.5";
        return null;
      });

      await reindex(defaultOptions);

      expect(mockCreateEmbedder).not.toHaveBeenCalledWith(
        expect.objectContaining({ alias: "nomic-embed-text-v1.5" })
      );
    });

    it("falls back to createEmbedder({ alias }) when only embedder_name is stored", async () => {
      storeMock.getMeta.mockImplementation(async (key: string) => {
        if (key === "embedder_model") return null;
        if (key === "embedder_name") return "bge";
        return null;
      });

      await reindex(defaultOptions);

      expect(mockCreateEmbedder).toHaveBeenCalledWith(expect.objectContaining({ alias: "bge" }));
    });

    it("calls createEmbedder with no alias/model when neither metadata key is stored", async () => {
      storeMock.getMeta.mockResolvedValue(null);

      await reindex(defaultOptions);

      // No alias, no model — default invocation
      const call = (mockCreateEmbedder as Mock).mock.calls[0][0] as Record<string, unknown>;
      expect(call).not.toHaveProperty("model");
      expect(call).not.toHaveProperty("alias");
    });
  });

  // ── Explicit -e flag overrides DB metadata ────────────────────────────────

  describe("explicit -e / --embedder flag takes priority over DB metadata", () => {
    it("uses the explicit alias even when embedder_model is stored in DB", async () => {
      storeMock.getMeta.mockImplementation(async (key: string) => {
        if (key === "embedder_model") return "nomic-ai/nomic-embed-text-v1.5";
        return null;
      });

      await reindex({ ...defaultOptions, embedder: "bge" });

      expect(mockCreateEmbedder).toHaveBeenCalledWith(expect.objectContaining({ alias: "bge" }));
      expect(mockCreateEmbedder).not.toHaveBeenCalledWith(
        expect.objectContaining({ model: "nomic-ai/nomic-embed-text-v1.5" })
      );
    });

    it("uses the explicit alias and ignores DB embedder_name", async () => {
      storeMock.getMeta.mockImplementation(async (key: string) => {
        if (key === "embedder_name") return "nomic";
        return null;
      });

      await reindex({ ...defaultOptions, embedder: "minilm" });

      expect(mockCreateEmbedder).toHaveBeenCalledWith(expect.objectContaining({ alias: "minilm" }));
    });
  });

  // ── Plugin embedder takes priority over DB metadata ───────────────────────

  describe("plugin embedder takes priority over DB metadata", () => {
    it("uses plugin embedder instead of creating one from DB metadata", async () => {
      const pluginEmbed = makeEmbedder({ name: "plugin-embedder" });
      pluginLoaderMock.getEmbedder.mockReturnValue(pluginEmbed);
      storeMock.getMeta.mockImplementation(async (key: string) => {
        if (key === "embedder_model") return "nomic-ai/nomic-embed-text-v1.5";
        return null;
      });

      await reindex(defaultOptions);

      // createEmbedder should NOT have been called — plugin embedder is used directly
      expect(mockCreateEmbedder).not.toHaveBeenCalled();
    });
  });

  // ── Missing DB ────────────────────────────────────────────────────────────

  describe("missing knowledge base", () => {
    it("logs an error and returns early when the DB file does not exist", async () => {
      mockExistsSync.mockReturnValue(false);

      await reindex(defaultOptions);

      const output = consoleSpy.log.mock.calls.flat().join("\n");
      expect(output).toContain("not found");
      expect(mockCreateEmbedder).not.toHaveBeenCalled();
    });
  });

  // ── Empty source list ─────────────────────────────────────────────────────

  describe("no sources to reindex", () => {
    it("returns early when listSources returns empty array", async () => {
      storeMock.listSources.mockResolvedValue([]);

      await reindex(defaultOptions);

      expect(mockCreateEmbedder).not.toHaveBeenCalled();
      expect(indexingServiceMock.reindexSource).not.toHaveBeenCalled();
    });
  });

  // ── Store lifecycle ───────────────────────────────────────────────────────

  describe("store lifecycle", () => {
    it("always closes the store after successful reindexing", async () => {
      await reindex(defaultOptions);

      expect(storeMock.close).toHaveBeenCalledTimes(1);
    });

    it("closes the store even when reindexSource throws", async () => {
      indexingServiceMock.reindexSource.mockRejectedValue(new Error("io error"));

      await reindex(defaultOptions);

      expect(storeMock.close).toHaveBeenCalledTimes(1);
    });
  });

  // ── Summary output ────────────────────────────────────────────────────────

  describe("summary output", () => {
    it("prints 'Reindex complete' summary line after processing", async () => {
      await reindex(defaultOptions);

      const output = consoleSpy.log.mock.calls.flat().join("\n");
      expect(output).toContain("Reindex complete");
    });

    it("reports updated count when sources are updated", async () => {
      indexingServiceMock.reindexSource.mockResolvedValue({
        status: "updated",
        sourceId: "s1",
        chunks: 3,
      });

      await reindex(defaultOptions);

      const output = consoleSpy.log.mock.calls.flat().join("\n");
      expect(output).toContain("Updated:");
    });
  });
});
