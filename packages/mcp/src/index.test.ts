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

// ── pino mock — prevent real logging ──────────────────────────────────────────
vi.mock("pino", () => {
  const noopLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => noopLogger),
  };
  return { default: vi.fn(() => noopLogger) };
});

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
  indexSource: vi.fn(
    async (): Promise<Record<string, unknown>> => ({ status: "indexed", sourceId: "s1", chunks: 1 })
  ),
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
    allowedExtensions: [],
  })),
  getDbPath: vi.fn((name: string) => `/mock/data/${name}.sqlite`),
  isPathAllowed: vi.fn(() => ({ allowed: true })),
  isUrlAllowed: vi.fn(async () => ({ allowed: true })),
}));

import { createEmbedder as mockCreateEmbedder } from "@emdzej/ragclaw-core";
// ── Import SUT after all vi.mock calls ────────────────────────────────────────
// This registers tools on the serverMock via createServer().
import { createServer } from "./server.js";

// Register all tools on our mocked server by creating a server
createServer("0.0.0-test");

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

/** Call the kb_search tool handler and return the text content. */
async function callRagSearch(args: Record<string, unknown>): Promise<string> {
  const handler = capturedToolHandlers.get("kb_search");
  if (!handler) throw new Error("kb_search handler not registered");
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

describe("MCP kb_search — embedder resolution (Bug 1 + Bug 3)", () => {
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

  // ── Bug 1: getEmbedder uses embedder_model (full HF ID), not display name ──

  describe("getEmbedder uses embedder_model first (Bug 1)", () => {
    it("uses createEmbedder({ model }) when embedder_model is stored", async () => {
      storeMock.getMeta.mockImplementation(async (key: string) => {
        if (key === "embedder_model") return "nomic-ai/nomic-embed-text-v1.5";
        if (key === "embedder_name") return "nomic-embed-text-v1.5";
        return null;
      });

      await callRagSearch({ query: "hello", db: freshDb() });

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

      await callRagSearch({ query: "hello", db: freshDb() });

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

      await callRagSearch({ query: "hello", db: freshDb() });

      expect(mockCreateEmbedder).toHaveBeenCalledWith(expect.objectContaining({ alias: "bge" }));
    });

    it("uses alias 'nomic' as fallback when no metadata is stored", async () => {
      storeMock.getMeta.mockResolvedValue(null);

      await callRagSearch({ query: "hello", db: freshDb() });

      expect(mockCreateEmbedder).toHaveBeenCalledWith(expect.objectContaining({ alias: "nomic" }));
    });

    it("does not throw when embedder_name is the display name (nomic-embed-text-v1.5)", async () => {
      storeMock.getMeta.mockImplementation(async (key: string) => {
        if (key === "embedder_model") return "nomic-ai/nomic-embed-text-v1.5";
        if (key === "embedder_name") return "nomic-embed-text-v1.5";
        return null;
      });

      await expect(callRagSearch({ query: "hello", db: freshDb() })).resolves.not.toThrow();
    });
  });

  // ── always uses hybrid mode + calls getEmbedder ───────────────────────────

  describe("always hybrid mode calls getEmbedder", () => {
    it("always calls createEmbedder regardless of query", async () => {
      storeMock.getMeta.mockImplementation(async (key: string) =>
        key === "embedder_model" ? "nomic-ai/nomic-embed-text-v1.5" : null
      );

      await callRagSearch({ query: "hello", db: freshDb() });

      expect(mockCreateEmbedder).toHaveBeenCalled();
    });

    it("passes an embedding vector and mode: hybrid to store.search", async () => {
      storeMock.getMeta.mockResolvedValue(null);
      const embedder = makeEmbedder();
      (mockCreateEmbedder as Mock).mockReturnValue(embedder);

      await callRagSearch({ query: "hello", db: freshDb() });

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

      const result = await callRagSearch({ query: "hello" });

      expect(result).toContain("No results found");
    });
  });

  // ── Results formatted ─────────────────────────────────────────────────────

  describe("result formatting", () => {
    it("includes source path and score in formatted output", async () => {
      storeMock.search.mockResolvedValue([makeResult("/docs/auth.md", "JWT guide")]);

      const result = await callRagSearch({ query: "jwt" });

      expect(result).toContain("/docs/auth.md");
      expect(result).toContain("Score:");
    });

    it("includes the chunk text in the output", async () => {
      storeMock.search.mockResolvedValue([makeResult("/docs/auth.md", "JWT authentication guide")]);

      const result = await callRagSearch({ query: "jwt" });

      expect(result).toContain("JWT authentication guide");
    });
  });

  // ── Store lifecycle ───────────────────────────────────────────────────────

  describe("store lifecycle", () => {
    it("does not close the store after search (connection is cached)", async () => {
      await callRagSearch({ query: "hello" });

      // Store connections are cached for read-only operations — close is not called
      expect(storeMock.close).toHaveBeenCalledTimes(0);
    });
  });
});

// ── createServer tests ──────────────────────────────────────────────────────

describe("createServer", () => {
  it("registers all 14 tools", () => {
    // capturedToolHandlers was populated when createServer() was called above
    expect(capturedToolHandlers.size).toBe(14);
  });

  it("registers expected tool names", () => {
    const expectedTools = [
      "kb_search",
      "kb_read_source",
      "kb_add",
      "kb_status",
      "kb_remove",
      "kb_reindex",
      "kb_list_chunkers",
      "kb_db_merge",
      "kb_list_databases",
      "kb_db_init",
      "kb_db_info",
      "kb_db_info_get",
      "kb_db_delete",
      "kb_db_rename",
    ];

    for (const name of expectedTools) {
      expect(capturedToolHandlers.has(name), `Missing tool: ${name}`).toBe(true);
    }
  });
});

// ── kb_add inline text tests ────────────────────────────────────────────────

/** Call the kb_add tool handler and return the text content. */
async function callRagAdd(args: Record<string, unknown>): Promise<string> {
  const handler = capturedToolHandlers.get("kb_add");
  if (!handler) throw new Error("kb_add handler not registered");
  const response = (await handler(args)) as { content: Array<{ type: string; text: string }> };
  return response.content[0].text;
}

describe("MCP kb_add — inline text (content parameter)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    storeMock.open.mockResolvedValue(undefined);
    storeMock.close.mockResolvedValue(undefined);
    storeMock.getMeta.mockResolvedValue(null);
    indexingServiceMock.indexSource.mockResolvedValue({
      status: "indexed" as const,
      sourceId: "s1",
      chunks: 3,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── Validation ──────────────────────────────────────────────────────────────

  describe("input validation", () => {
    it("returns error when neither source nor content is provided", async () => {
      const result = await callRagAdd({ db: "default" });

      expect(result).toContain("Error");
      expect(result).toContain("provide either");
    });

    it("returns error when both source and content are provided", async () => {
      const result = await callRagAdd({
        source: "./file.md",
        content: "hello world",
      });

      expect(result).toContain("Error");
      expect(result).toContain("only one of");
    });
  });

  // ── Inline text indexing ────────────────────────────────────────────────────

  describe("content parameter", () => {
    it("indexes inline text content when content is provided", async () => {
      const result = await callRagAdd({
        content: "Remember this important fact",
      });

      expect(result).toContain("Indexed");
      expect(result).toContain("3 chunks");
      expect(indexingServiceMock.indexSource).toHaveBeenCalledOnce();
    });

    it("passes TextSource with correct type and content to indexSource", async () => {
      await callRagAdd({ content: "OAuth2 flow notes" });

      expect(indexingServiceMock.indexSource).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          type: "text",
          content: "OAuth2 flow notes",
        }),
        expect.objectContaining({ timestamp: undefined })
      );
    });

    it("passes name to TextSource when provided", async () => {
      await callRagAdd({
        content: "API key rotation policy",
        name: "security-notes",
      });

      expect(indexingServiceMock.indexSource).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          type: "text",
          content: "API key rotation policy",
          name: "security-notes",
        }),
        expect.objectContaining({ timestamp: undefined })
      );
    });

    it("uses 'inline-text' as default display name in response", async () => {
      const result = await callRagAdd({ content: "No name given" });

      expect(result).toContain("inline-text");
    });

    it("uses custom name in response when provided", async () => {
      const result = await callRagAdd({
        content: "Named content",
        name: "my-notes",
      });

      expect(result).toContain("my-notes");
    });

    it("reports 'unchanged' when indexSource returns unchanged status", async () => {
      indexingServiceMock.indexSource.mockResolvedValueOnce({
        status: "unchanged" as const,
        sourceId: "s1",
      });

      const result = await callRagAdd({ content: "Duplicate content" });

      expect(result).toContain("Skipped");
      expect(result).toContain("unchanged");
    });

    it("reports error when indexSource returns error status", async () => {
      indexingServiceMock.indexSource.mockResolvedValueOnce({
        status: "error" as const,
        sourceId: "s1",
        error: "embedding failed",
      });

      const result = await callRagAdd({ content: "Broken content" });

      expect(result).toContain("Error");
      expect(result).toContain("embedding failed");
    });
  });

  // ── Store lifecycle ─────────────────────────────────────────────────────────

  describe("store lifecycle", () => {
    it("closes the store after inline text indexing", async () => {
      await callRagAdd({ content: "Test content" });

      expect(storeMock.close).toHaveBeenCalledOnce();
    });
  });
});

// ── kb_add temporal timestamp tests ─────────────────────────────────────────

describe("MCP kb_add — timestamp parameter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    storeMock.open.mockResolvedValue(undefined);
    storeMock.close.mockResolvedValue(undefined);
    storeMock.getMeta.mockResolvedValue(null);
    indexingServiceMock.indexSource.mockResolvedValue({
      status: "indexed" as const,
      sourceId: "s1",
      chunks: 3,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("passes timestamp to indexSource when provided", async () => {
    await callRagAdd({ content: "Temporal note", timestamp: 1700000000000 });

    expect(indexingServiceMock.indexSource).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ timestamp: 1700000000000 })
    );
  });

  it("passes timestamp: undefined to indexSource when not provided", async () => {
    await callRagAdd({ content: "No timestamp note" });

    expect(indexingServiceMock.indexSource).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ timestamp: undefined })
    );
  });

  it("includes timestamp in successful response", async () => {
    const result = await callRagAdd({ content: "Dated content", timestamp: 1700000000000 });

    expect(result).toContain("Indexed");
    expect(result).toContain("3 chunks");
  });
});

// ── kb_search temporal filter tests ─────────────────────────────────────────

describe("MCP kb_search — after/before temporal filter", () => {
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

  it("passes after and before as filter to store.search", async () => {
    await callRagSearch({
      query: "temporal query",
      db: freshDb(),
      after: 1700000000000,
      before: 1700100000000,
    });

    expect(storeMock.search).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: { after: 1700000000000, before: 1700100000000 },
      })
    );
  });

  it("passes only after when before is not provided", async () => {
    await callRagSearch({
      query: "after only",
      db: freshDb(),
      after: 1700000000000,
    });

    expect(storeMock.search).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: { after: 1700000000000, before: undefined },
      })
    );
  });

  it("passes only before when after is not provided", async () => {
    await callRagSearch({
      query: "before only",
      db: freshDb(),
      before: 1700100000000,
    });

    expect(storeMock.search).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: { after: undefined, before: 1700100000000 },
      })
    );
  });

  it("does not pass filter when neither after nor before is provided", async () => {
    await callRagSearch({
      query: "no filter",
      db: freshDb(),
    });

    expect(storeMock.search).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: undefined,
      })
    );
  });

  it("passes filter through to each sub-query when query is decomposed", async () => {
    await callRagSearch({
      query: "how authentication works; what are the migration steps",
      db: freshDb(),
      after: 1700000000000,
    });

    // Should have been called twice (two sub-queries), each with the filter
    const searchCalls = storeMock.search.mock.calls as unknown[][];
    expect(searchCalls.length).toBe(2);
    for (const call of searchCalls) {
      expect(call[0]).toEqual(
        expect.objectContaining({
          filter: { after: 1700000000000, before: undefined },
        })
      );
    }
  });
});
