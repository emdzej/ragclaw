/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import type { ChunkRecord, SearchResult } from "@emdzej/ragclaw-core";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────
// All vi.mock() calls must be hoisted before any module imports.

// ── MCP SDK mocks — prevent real server/transport initialisation ──────────────
// Capture tool handlers registered via McpServer.registerTool so we can invoke
// them directly in tests.
type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;
const capturedToolHandlers = new Map<string, ToolHandler>();

const serverMock = {
  registerTool: vi.fn(
    (
      _name: string,
      _config: unknown,
      handler: (args: Record<string, unknown>) => Promise<unknown>
    ) => {
      capturedToolHandlers.set(_name, handler);
    }
  ),
  connect: vi.fn(async () => {}),
};

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: vi.fn(function () {
    return serverMock;
  }),
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn(function () {
    return {};
  }),
}));

// ── fs mocks ──────────────────────────────────────────────────────────────────
const mockExistsSync = vi.fn((_p: string) => true);
vi.mock("fs", () => ({ existsSync: (p: string) => mockExistsSync(p) }));

vi.mock("fs/promises", () => ({
  mkdir: vi.fn(async () => {}),
  readdir: vi.fn(async () => []),
  stat: vi.fn(async () => ({ isFile: () => false, isDirectory: () => false })),
}));

// ── Store mock ────────────────────────────────────────────────────────────────
const storeMock = {
  open: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  getMeta: vi.fn(async (_key: string) => null as string | null),
  search: vi.fn(async (): Promise<SearchResult[]> => []),
  listSources: vi.fn(async () => []),
  getStats: vi.fn(async () => ({ sources: 0, chunks: 0, sizeBytes: 0 })),
  getAllMeta: vi.fn(async () => ({})),
  getSource: vi.fn(async () => null),
  removeSource: vi.fn(async () => {}),
  hasVectorSupport: false,
};

// IndexingService mock
const indexingServiceMock = {
  init: vi.fn(async () => {}),
  indexSource: vi.fn(async () => ({ status: "indexed" as const, sourceId: "s1", chunks: 1 })),
  reindexSource: vi.fn(async () => ({ status: "unchanged" as const, sourceId: "s1" })),
  indexCrawl: vi.fn(async () => ({ indexed: 0, totalChunks: 0, skipped: 0, errors: 0 })),
};

// MergeService mock
const mergeServiceMock = {
  merge: vi.fn(async () => ({
    strategy: "strict",
    dryRun: false,
    sourcesAdded: 0,
    sourcesUpdated: 0,
    sourcesSkipped: 0,
    errors: [],
    diff: { toAdd: [], toUpdate: [], identical: [], localOnly: [] },
  })),
};

vi.mock("@emdzej/ragclaw-core", () => ({
  Store: vi.fn(function () {
    return storeMock;
  }),
  IndexingService: vi.fn(function () {
    return indexingServiceMock;
  }),
  MergeService: vi.fn(function () {
    return mergeServiceMock;
  }),
  createEmbedder: vi.fn(),
  getConfig: vi.fn(() => ({
    dataDir: "/mock/ragclaw",
    enabledPlugins: [],
    scanGlobalNpm: false,
    pluginConfig: {},
    enforceGuards: false,
    allowUrls: true,
    blockPrivateUrls: false,
    allowedPaths: [],
    extractorLimits: {},
    maxDepth: 10,
    maxFiles: 1000,
  })),
  getDbPath: vi.fn((name: string) => `/mock/data/${name}.sqlite`),
  isPathAllowed: vi.fn(() => ({ allowed: true })),
  isUrlAllowed: vi.fn(async () => ({ allowed: true })),
}));

// ── Import SUT after all vi.mock calls ────────────────────────────────────────
// This triggers main() which registers the handlers on serverMock.
await import("./index.js");

import { createEmbedder as mockCreateEmbedder } from "@emdzej/ragclaw-core";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEmbedder(overrides: Record<string, unknown> = {}) {
  return {
    name: "mock-model",
    dimensions: 768,
    embed: vi.fn(async (_text: string) => new Float32Array(768)),
    embedQuery: vi.fn(async (_text: string) => new Float32Array(768)),
    embedBatch: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array(768))),
    ...overrides,
  };
}

function makeResult(sourcePath: string, text: string): SearchResult {
  const chunk: ChunkRecord = {
    id: "c1",
    sourceId: "s1",
    sourcePath,
    text,
    startLine: 1,
    endLine: 5,
    metadata: { type: "section" },
    createdAt: Date.now(),
  };
  return { chunk, score: 0.85, scoreVector: 0.9, scoreKeyword: 0.7 };
}

/** Call the rag_search tool handler and return the text content. */
async function callRagSearch(args: Record<string, unknown>): Promise<string> {
  const handler = capturedToolHandlers.get("rag_search");
  if (!handler) throw new Error("rag_search handler not registered");
  const response = (await handler(args)) as { content: Array<{ type: string; text: string }> };
  return response.content[0].text;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

// Each test that exercises the embedder cache needs a unique DB name so the
// module-level cachedEmbedders Map doesn't return a stale result from a prior test.
let dbCounter = 0;
function freshDb() {
  return `testdb-${++dbCounter}`;
}

describe("MCP rag_search — embedder resolution (Bug 1 + Bug 3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    storeMock.open.mockResolvedValue(undefined);
    storeMock.close.mockResolvedValue(undefined);
    storeMock.getMeta.mockResolvedValue(null);
    storeMock.search.mockResolvedValue([]);
    (mockCreateEmbedder as Mock).mockReturnValue(makeEmbedder());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── Bug 3: keyword mode must NOT call getEmbedder / createEmbedder ─────────

  describe("keyword mode skips embedder entirely (Bug 3)", () => {
    it("does not call createEmbedder in keyword mode", async () => {
      await callRagSearch({ query: "hello", mode: "keyword", db: freshDb() });

      expect(mockCreateEmbedder).not.toHaveBeenCalled();
    });

    it("calls store.search with undefined embedding in keyword mode", async () => {
      await callRagSearch({ query: "hello", mode: "keyword", db: freshDb() });

      expect(storeMock.search).toHaveBeenCalledWith(expect.objectContaining({ mode: "keyword" }));
      // Vitest matcher: verify no embedding key, or embedding is undefined
      expect(storeMock.search).not.toHaveBeenCalledWith(
        expect.objectContaining({ embedding: expect.anything() })
      );
    });

    it("does not throw in keyword mode even when no embedder metadata is stored", async () => {
      storeMock.getMeta.mockResolvedValue(null);

      await expect(
        callRagSearch({ query: "hello", mode: "keyword", db: freshDb() })
      ).resolves.not.toThrow();
    });
  });

  // ── Bug 1: getEmbedder uses embedder_model (full HF ID), not display name ──

  describe("getEmbedder uses embedder_model first (Bug 1)", () => {
    it("uses createEmbedder({ model }) when embedder_model is stored", async () => {
      storeMock.getMeta.mockImplementation(async (key: string) => {
        if (key === "embedder_model") return "nomic-ai/nomic-embed-text-v1.5";
        if (key === "embedder_name") return "nomic-embed-text-v1.5";
        return null;
      });

      await callRagSearch({ query: "hello", mode: "vector", db: freshDb() });

      expect(mockCreateEmbedder).toHaveBeenCalledWith(
        expect.objectContaining({ model: "nomic-ai/nomic-embed-text-v1.5" })
      );
    });

    it("does NOT call createEmbedder({ alias: 'nomic-embed-text-v1.5' }) (the pre-fix crash case)", async () => {
      // Before the fix: getEmbedder() called createEmbedder({ alias: storedName })
      // which threw "Unknown embedder preset 'nomic-embed-text-v1.5'".
      storeMock.getMeta.mockImplementation(async (key: string) => {
        if (key === "embedder_model") return "nomic-ai/nomic-embed-text-v1.5";
        if (key === "embedder_name") return "nomic-embed-text-v1.5";
        return null;
      });

      await callRagSearch({ query: "hello", mode: "vector", db: freshDb() });

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

      await callRagSearch({ query: "hello", mode: "vector", db: freshDb() });

      expect(mockCreateEmbedder).toHaveBeenCalledWith(expect.objectContaining({ alias: "bge" }));
    });

    it("uses alias 'nomic' as fallback when no metadata is stored", async () => {
      storeMock.getMeta.mockResolvedValue(null);

      await callRagSearch({ query: "hello", mode: "vector", db: freshDb() });

      expect(mockCreateEmbedder).toHaveBeenCalledWith(expect.objectContaining({ alias: "nomic" }));
    });

    it("does not throw when embedder_name is the display name (nomic-embed-text-v1.5)", async () => {
      storeMock.getMeta.mockImplementation(async (key: string) => {
        if (key === "embedder_model") return "nomic-ai/nomic-embed-text-v1.5";
        if (key === "embedder_name") return "nomic-embed-text-v1.5";
        return null;
      });

      await expect(
        callRagSearch({ query: "hello", mode: "vector", db: freshDb() })
      ).resolves.not.toThrow();
    });
  });

  // ── hybrid mode also calls getEmbedder ────────────────────────────────────

  describe("hybrid mode calls getEmbedder", () => {
    it("calls createEmbedder in hybrid mode", async () => {
      storeMock.getMeta.mockImplementation(async (key: string) =>
        key === "embedder_model" ? "nomic-ai/nomic-embed-text-v1.5" : null
      );

      await callRagSearch({ query: "hello", mode: "hybrid", db: freshDb() });

      expect(mockCreateEmbedder).toHaveBeenCalled();
    });

    it("passes an embedding vector to store.search in hybrid mode", async () => {
      storeMock.getMeta.mockResolvedValue(null);
      const embedder = makeEmbedder();
      (mockCreateEmbedder as Mock).mockReturnValue(embedder);

      await callRagSearch({ query: "hello", mode: "hybrid", db: freshDb() });

      // In hybrid mode, embedQuery is called and the result passed to store.search
      expect(embedder.embedQuery).toHaveBeenCalledWith("hello");
      expect(storeMock.search).toHaveBeenCalledWith(expect.objectContaining({ mode: "hybrid" }));
    });
  });

  // ── DB not found ──────────────────────────────────────────────────────────

  describe("missing knowledge base", () => {
    it("returns error message when DB file does not exist", async () => {
      mockExistsSync.mockReturnValue(false);

      const result = await callRagSearch({ query: "hello" });

      expect(result).toContain("not found");
    });
  });

  // ── No results ────────────────────────────────────────────────────────────

  describe("empty result set", () => {
    it("returns 'No results found' when store.search returns empty array", async () => {
      storeMock.search.mockResolvedValue([]);

      const result = await callRagSearch({ query: "hello", mode: "keyword" });

      expect(result).toContain("No results found");
    });
  });

  // ── Results formatted ─────────────────────────────────────────────────────

  describe("result formatting", () => {
    it("includes source path and score in formatted output", async () => {
      storeMock.search.mockResolvedValue([makeResult("/docs/auth.md", "JWT guide")]);

      const result = await callRagSearch({ query: "jwt", mode: "keyword" });

      expect(result).toContain("/docs/auth.md");
      expect(result).toContain("Score:");
    });

    it("includes the chunk text in the output", async () => {
      storeMock.search.mockResolvedValue([makeResult("/docs/auth.md", "JWT authentication guide")]);

      const result = await callRagSearch({ query: "jwt", mode: "keyword" });

      expect(result).toContain("JWT authentication guide");
    });
  });

  // ── Store lifecycle ───────────────────────────────────────────────────────

  describe("store lifecycle", () => {
    it("always closes the store after search", async () => {
      await callRagSearch({ query: "hello", mode: "keyword" });

      expect(storeMock.close).toHaveBeenCalledTimes(1);
    });
  });
});
