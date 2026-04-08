/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import type { ChunkRecord, SearchResult } from "@emdzej/ragclaw-core";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────
// All vi.mock() calls must come before any module imports.

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
  stop: vi.fn(),
  start: vi.fn(),
};
spinnerMock.start.mockReturnValue(spinnerMock);
vi.mock("ora", () => ({ default: vi.fn(() => spinnerMock) }));

// fs.existsSync — controlled per test
const mockExistsSync = vi.fn((_path: string) => true);
vi.mock("fs", () => ({ existsSync: (path: string) => mockExistsSync(path) }));

// Config helpers
vi.mock("../config.js", () => ({
  getDbPath: vi.fn((name: string) => `/mock/data/${name}.sqlite`),
  getConfig: vi.fn(() => ({
    enabledPlugins: [],
    scanGlobalNpm: false,
    pluginConfig: {},
  })),
}));

// Store mock — getMeta, search, open, close controlled per test
const storeMock = {
  open: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  getMeta: vi.fn(async (_key: string) => null as string | null),
  search: vi.fn(async (): Promise<SearchResult[]> => []),
};
vi.mock("@emdzej/ragclaw-core", () => ({
  Store: vi.fn(function () {
    return storeMock;
  }),
  createEmbedder: vi.fn(),
}));

// Import subject under test AFTER all vi.mock calls
const { searchCommand } = await import("./search.js");

import { createEmbedder as mockCreateEmbedder } from "@emdzej/ragclaw-core";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal EmbedderPlugin stub */
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

/** A minimal SearchResult for testing output formatting */
function makeResult(sourcePath: string, text: string): SearchResult {
  const now = Date.now();
  const chunk: ChunkRecord = {
    id: "c1",
    sourceId: "s1",
    sourcePath,
    text,
    startLine: 1,
    endLine: 5,
    metadata: { type: "section" },
    createdAt: now,
    timestamp: now,
  };
  return { chunk, score: 0.85, scoreVector: 0.9, scoreKeyword: 0.7 };
}

const defaultOptions = { db: "default", limit: "10" };

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("searchCommand() — embedder resolution from DB metadata (Bug 1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spinnerMock.start.mockReturnValue(spinnerMock);
    mockExistsSync.mockReturnValue(true);
    storeMock.open.mockResolvedValue(undefined);
    storeMock.close.mockResolvedValue(undefined);
    storeMock.search.mockResolvedValue([]);
    storeMock.getMeta.mockResolvedValue(null);
    (mockCreateEmbedder as Mock).mockReturnValue(makeEmbedder());
  });

  afterEach(() => {
    vi.clearAllMocks();
    spinnerMock.start.mockReturnValue(spinnerMock);
  });

  // ── Bug 1: embedder_model (full HF model ID) takes priority ───────────────

  describe("embedder resolution from store metadata", () => {
    it("uses createEmbedder({ model }) when embedder_model is stored", async () => {
      storeMock.getMeta.mockImplementation(async (key: string) => {
        if (key === "embedder_model") return "nomic-ai/nomic-embed-text-v1.5";
        if (key === "embedder_name") return "nomic-embed-text-v1.5";
        return null;
      });

      await searchCommand("hello", defaultOptions);

      // Must use { model } not { alias } — the short display name is not a valid alias
      expect(mockCreateEmbedder).toHaveBeenCalledWith(
        expect.objectContaining({ model: "nomic-ai/nomic-embed-text-v1.5" })
      );
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

      await searchCommand("hello", defaultOptions);

      expect(mockCreateEmbedder).toHaveBeenCalledWith(expect.objectContaining({ alias: "bge" }));
    });

    it("falls back to alias 'nomic' when no metadata is stored", async () => {
      storeMock.getMeta.mockResolvedValue(null);

      await searchCommand("hello", defaultOptions);

      expect(mockCreateEmbedder).toHaveBeenCalledWith(expect.objectContaining({ alias: "nomic" }));
    });

    it("does not throw when embedder_name is 'nomic-embed-text-v1.5' (the pre-fix crash case)", async () => {
      // Before the fix: createEmbedder({ alias: "nomic-embed-text-v1.5" }) threw
      //   "Unknown embedder preset 'nomic-embed-text-v1.5'"
      // Fix: use { model: storedModel } instead.
      storeMock.getMeta.mockImplementation(async (key: string) => {
        if (key === "embedder_model") return "nomic-ai/nomic-embed-text-v1.5";
        if (key === "embedder_name") return "nomic-embed-text-v1.5";
        return null;
      });

      await expect(searchCommand("hello", defaultOptions)).resolves.not.toThrow();
    });

    it("calls embedQuery with the exact search query string", async () => {
      const embedder = makeEmbedder();
      (mockCreateEmbedder as Mock).mockReturnValue(embedder);
      storeMock.getMeta.mockImplementation(async (key: string) =>
        key === "embedder_model" ? "nomic-ai/nomic-embed-text-v1.5" : null
      );

      await searchCommand("find authentication patterns", defaultOptions);

      expect(embedder.embedQuery).toHaveBeenCalledWith("find authentication patterns");
    });
  });

  // ── store.search receives correct parameters ──────────────────────────────

  describe("search parameter forwarding", () => {
    it("passes the query text to store.search", async () => {
      await searchCommand("jwt expiry", defaultOptions);

      expect(storeMock.search).toHaveBeenCalledWith(
        expect.objectContaining({ text: "jwt expiry" })
      );
    });

    it("parses the limit string and passes it as a number", async () => {
      await searchCommand("hello", { ...defaultOptions, limit: "3" });

      expect(storeMock.search).toHaveBeenCalledWith(expect.objectContaining({ limit: 3 }));
    });

    it("always passes mode: hybrid to store.search", async () => {
      await searchCommand("hello", defaultOptions);

      expect(storeMock.search).toHaveBeenCalledWith(expect.objectContaining({ mode: "hybrid" }));
    });
  });

  // ── Output formatting ─────────────────────────────────────────────────────

  describe("output formatting", () => {
    it("prints 'No results found' when store returns an empty array", async () => {
      storeMock.search.mockResolvedValue([]);

      await searchCommand("hello", defaultOptions);

      const output = consoleSpy.log.mock.calls.flat().join("\n");
      expect(output).toContain("No results found");
    });

    it("prints result count and source path when results are returned", async () => {
      storeMock.search.mockResolvedValue([makeResult("/docs/auth.md", "JWT authentication guide")]);

      await searchCommand("jwt", defaultOptions);

      const output = consoleSpy.log.mock.calls.flat().join("\n");
      expect(output).toContain("Found 1 result");
      expect(output).toContain("/docs/auth.md");
    });

    it("outputs valid JSON when --json flag is set", async () => {
      storeMock.search.mockResolvedValue([makeResult("/docs/auth.md", "JWT authentication guide")]);

      await searchCommand("jwt", { ...defaultOptions, json: true });

      const rawOutput = consoleSpy.log.mock.calls.flat().join("\n");
      expect(() => JSON.parse(rawOutput)).not.toThrow();
    });
  });

  // ── DB not found ──────────────────────────────────────────────────────────

  describe("missing knowledge base", () => {
    it("exits with an error when the DB file does not exist", async () => {
      mockExistsSync.mockReturnValue(false);

      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("process.exit called");
      }) as never);

      await expect(searchCommand("hello", defaultOptions)).rejects.toThrow("process.exit called");

      expect(consoleSpy.error).toHaveBeenCalled();
      exitSpy.mockRestore();
    });
  });

  // ── Store lifecycle ───────────────────────────────────────────────────────

  describe("store lifecycle", () => {
    it("always closes the store even when store.search throws", async () => {
      storeMock.getMeta.mockResolvedValue(null);
      (mockCreateEmbedder as Mock).mockReturnValue(makeEmbedder());
      storeMock.search.mockRejectedValue(new Error("db error"));

      await expect(searchCommand("hello", defaultOptions)).rejects.toThrow("db error");

      expect(storeMock.close).toHaveBeenCalledTimes(1);
    });
  });

  // ── --after / --before time filter flags ──────────────────────────────────

  describe("--after / --before time filter flags", () => {
    it("passes parsed after and before to store.search as filter", async () => {
      await searchCommand("hello", {
        ...defaultOptions,
        after: "1700000000000",
        before: "1700100000000",
      });

      expect(storeMock.search).toHaveBeenCalledWith(
        expect.objectContaining({
          filter: { after: 1700000000000, before: 1700100000000 },
        })
      );
    });

    it("passes only after when before is not provided", async () => {
      await searchCommand("hello", {
        ...defaultOptions,
        after: "1700000000000",
      });

      expect(storeMock.search).toHaveBeenCalledWith(
        expect.objectContaining({
          filter: { after: 1700000000000, before: undefined },
        })
      );
    });

    it("passes only before when after is not provided", async () => {
      await searchCommand("hello", {
        ...defaultOptions,
        before: "1700100000000",
      });

      expect(storeMock.search).toHaveBeenCalledWith(
        expect.objectContaining({
          filter: { after: undefined, before: 1700100000000 },
        })
      );
    });

    it("does not pass filter when neither after nor before is provided", async () => {
      await searchCommand("hello", defaultOptions);

      expect(storeMock.search).toHaveBeenCalledWith(
        expect.objectContaining({
          filter: undefined,
        })
      );
    });

    it("parses ISO 8601 strings for after and before", async () => {
      const afterIso = "2024-01-01T00:00:00Z";
      const beforeIso = "2024-06-01T00:00:00Z";
      const expectedAfter = new Date(afterIso).getTime();
      const expectedBefore = new Date(beforeIso).getTime();

      await searchCommand("hello", {
        ...defaultOptions,
        after: afterIso,
        before: beforeIso,
      });

      expect(storeMock.search).toHaveBeenCalledWith(
        expect.objectContaining({
          filter: { after: expectedAfter, before: expectedBefore },
        })
      );
    });
  });
});
