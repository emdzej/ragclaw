/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

// Spinner stub — supports all methods used in addCommand
const spinnerMock = {
  text: "",
  stop: vi.fn(),
  start: vi.fn(),
  succeed: vi.fn(),
  fail: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
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
    enforceGuards: false,
    allowUrls: true,
    blockPrivateUrls: false,
    allowedPaths: [],
    extractorLimits: {},
    maxDepth: 10,
    maxFiles: 1000,
    allowedExtensions: [],
  })),
  ensureDataDir: vi.fn(),
}));

// IndexingService mock
const indexingServiceMock = {
  init: vi.fn(async () => {}),
  indexSource: vi.fn(
    async () => ({ status: "indexed", sourceId: "s1", chunks: 3 }) as Record<string, unknown>
  ),
};

// Store mock
const storeMock = {
  open: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  getMeta: vi.fn(async (_key: string) => null as string | null),
};

vi.mock("@emdzej/ragclaw-core", () => ({
  Store: vi.fn(function () {
    return storeMock;
  }),
  IndexingService: vi.fn(function () {
    return indexingServiceMock;
  }),
  createEmbedder: vi.fn(() => ({
    name: "mock-embedder",
    dimensions: 768,
    embed: vi.fn(async () => new Float32Array(768)),
    embedQuery: vi.fn(async () => new Float32Array(768)),
    embedBatch: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array(768))),
  })),
  resolvePreset: vi.fn(() => null),
  checkSystemRequirements: vi.fn(() => ({ errors: [], warnings: [] })),
  isPathAllowed: vi.fn(() => ({ allowed: true })),
  isUrlAllowed: vi.fn(async () => ({ allowed: true })),
}));

// Plugin loader mock
vi.mock("../plugins/loader.js", () => ({
  PluginLoader: vi.fn(function () {
    return {
      loadAll: vi.fn(async () => {}),
      getExtractors: vi.fn(() => []),
      getChunkers: vi.fn(() => []),
      getEmbedder: vi.fn(() => null),
      expandSource: vi.fn(async () => null),
    };
  }),
}));

// Import subject under test AFTER all vi.mock calls
const { addCommand } = await import("./add.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

const defaultOptions = {
  db: "default",
  type: "auto",
  recursive: true,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("addCommand — inline text input", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spinnerMock.start.mockReturnValue(spinnerMock);
    mockExistsSync.mockReturnValue(true);
    storeMock.open.mockResolvedValue(undefined);
    storeMock.close.mockResolvedValue(undefined);
    indexingServiceMock.init.mockResolvedValue(undefined);
    indexingServiceMock.indexSource.mockResolvedValue({
      status: "indexed" as const,
      sourceId: "s1",
      chunks: 3,
    });
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  // ── Validation ──────────────────────────────────────────────────────────────

  describe("input validation", () => {
    it("errors when no source, --text, or --stdin is provided", async () => {
      await addCommand(undefined, { ...defaultOptions });

      expect(consoleSpy.error).toHaveBeenCalled();
      const output = consoleSpy.error.mock.calls.flat().join("\n");
      expect(output).toContain("provide a <source> argument, --text <content>, or --stdin");
      expect(process.exitCode).toBe(1);
    });

    it("errors when both --text and source are provided", async () => {
      await addCommand("./file.md", { ...defaultOptions, text: "hello" });

      expect(consoleSpy.error).toHaveBeenCalled();
      const output = consoleSpy.error.mock.calls.flat().join("\n");
      expect(output).toContain("provide only one of");
      expect(process.exitCode).toBe(1);
    });

    it("errors when both --text and --stdin are provided", async () => {
      await addCommand(undefined, { ...defaultOptions, text: "hello", stdin: true });

      expect(consoleSpy.error).toHaveBeenCalled();
      const output = consoleSpy.error.mock.calls.flat().join("\n");
      expect(output).toContain("provide only one of");
      expect(process.exitCode).toBe(1);
    });

    it("errors when both source and --stdin are provided", async () => {
      await addCommand("./file.md", { ...defaultOptions, stdin: true });

      expect(consoleSpy.error).toHaveBeenCalled();
      const output = consoleSpy.error.mock.calls.flat().join("\n");
      expect(output).toContain("provide only one of");
      expect(process.exitCode).toBe(1);
    });
  });

  // ── --text flag ─────────────────────────────────────────────────────────────

  describe("--text flag", () => {
    it("indexes inline text content via --text", async () => {
      await addCommand(undefined, { ...defaultOptions, text: "Remember this important fact" });

      // Verify indexSource was called with a TextSource
      expect(indexingServiceMock.indexSource).toHaveBeenCalledOnce();
      const call = indexingServiceMock.indexSource.mock.calls[0] as unknown[];
      const source = call[1];
      expect(source).toEqual({
        type: "text",
        content: "Remember this important fact",
        name: undefined,
      });
    });

    it("passes --name to the TextSource", async () => {
      await addCommand(undefined, {
        ...defaultOptions,
        text: "API key rotation policy",
        name: "security-notes",
      });

      const call = indexingServiceMock.indexSource.mock.calls[0] as unknown[];
      const source = call[1];
      expect(source).toEqual({
        type: "text",
        content: "API key rotation policy",
        name: "security-notes",
      });
    });

    it("reports success with chunk count via spinner", async () => {
      await addCommand(undefined, { ...defaultOptions, text: "Some content" });

      expect(spinnerMock.succeed).toHaveBeenCalledWith(expect.stringContaining("3 chunks"));
    });

    it("reports 'unchanged' when indexSource returns unchanged status", async () => {
      indexingServiceMock.indexSource.mockResolvedValueOnce({
        status: "unchanged" as const,
        sourceId: "s1",
      });

      await addCommand(undefined, { ...defaultOptions, text: "Duplicate content" });

      expect(spinnerMock.info).toHaveBeenCalledWith(expect.stringContaining("unchanged"));
    });

    it("reports 'skipped' when indexSource returns skipped status", async () => {
      indexingServiceMock.indexSource.mockResolvedValueOnce({
        status: "skipped" as const,
        sourceId: "s1",
        reason: "no extractor found",
      });

      await addCommand(undefined, { ...defaultOptions, text: "Skipped content" });

      expect(spinnerMock.warn).toHaveBeenCalledWith(expect.stringContaining("no extractor found"));
    });

    it("reports error when indexSource returns error status", async () => {
      indexingServiceMock.indexSource.mockResolvedValueOnce({
        status: "error" as const,
        sourceId: "s1",
        error: "embedding failed",
      });

      await addCommand(undefined, { ...defaultOptions, text: "Broken content" });

      expect(spinnerMock.fail).toHaveBeenCalledWith(expect.stringContaining("embedding failed"));
    });

    it("uses 'inline-text' as display name when --name is not provided", async () => {
      await addCommand(undefined, { ...defaultOptions, text: "No name given" });

      expect(spinnerMock.succeed).toHaveBeenCalledWith(expect.stringContaining("inline-text"));
    });

    it("uses custom name as display name when --name is provided", async () => {
      await addCommand(undefined, {
        ...defaultOptions,
        text: "Named content",
        name: "my-notes",
      });

      expect(spinnerMock.succeed).toHaveBeenCalledWith(expect.stringContaining("my-notes"));
    });
  });

  // ── --timestamp flag ─────────────────────────────────────────────────────────

  describe("--timestamp flag", () => {
    it("passes epoch ms timestamp to indexSource as third argument", async () => {
      await addCommand(undefined, {
        ...defaultOptions,
        text: "Timestamped content",
        timestamp: "1700000000000",
      });

      expect(indexingServiceMock.indexSource).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ timestamp: 1700000000000 })
      );
    });

    it("parses ISO 8601 string to epoch ms and passes to indexSource", async () => {
      await addCommand(undefined, {
        ...defaultOptions,
        text: "ISO timestamped content",
        timestamp: "2024-06-15T12:00:00Z",
      });

      const expectedMs = new Date("2024-06-15T12:00:00Z").getTime();
      expect(indexingServiceMock.indexSource).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ timestamp: expectedMs })
      );
    });

    it("passes { timestamp: undefined } when --timestamp is not provided", async () => {
      await addCommand(undefined, { ...defaultOptions, text: "No timestamp" });

      expect(indexingServiceMock.indexSource).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ timestamp: undefined })
      );
    });

    it("reports error for invalid timestamp value", async () => {
      await addCommand(undefined, {
        ...defaultOptions,
        text: "Bad timestamp",
        timestamp: "not-a-date",
      });

      expect(spinnerMock.fail).toHaveBeenCalledWith(expect.stringContaining("Invalid timestamp"));
    });
  });

  // ── Store lifecycle ─────────────────────────────────────────────────────────

  describe("store lifecycle", () => {
    it("always closes the store after --text indexing", async () => {
      await addCommand(undefined, { ...defaultOptions, text: "Test content" });

      expect(storeMock.close).toHaveBeenCalledOnce();
    });

    it("closes the store even when indexSource throws", async () => {
      indexingServiceMock.indexSource.mockRejectedValueOnce(new Error("boom"));

      await addCommand(undefined, { ...defaultOptions, text: "Failing content" });

      expect(storeMock.close).toHaveBeenCalledOnce();
    });
  });
});
