/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────────
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
};

// fs.existsSync — controlled per test
const mockExistsSync = vi.fn((_path: string) => true);
vi.mock("node:fs", () => ({ existsSync: (path: string) => mockExistsSync(path) }));

// fs/promises.readdir — controlled per test
const mockReaddir = vi.fn(async () => [] as string[]);
vi.mock("node:fs/promises", () => ({ readdir: () => mockReaddir() }));

// Config helpers
const MOCK_DATA_DIR = "/mock/data";
vi.mock("../config.js", () => ({
  getDataDir: vi.fn(() => MOCK_DATA_DIR),
}));

// Import subject under test AFTER all vi.mock calls
const { dbList } = await import("./db.js");

// ── Helpers ────────────────────────────────────────────────────────────────────

function logOutput(): string {
  return consoleSpy.log.mock.calls.flat().join("\n");
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("dbList()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockReaddir.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── dataDir does not exist ─────────────────────────────────────────────────

  describe("when dataDir does not exist", () => {
    beforeEach(() => {
      mockExistsSync.mockReturnValue(false);
    });

    it("prints soft message and does not throw", async () => {
      await dbList({});

      expect(logOutput()).toContain("No knowledge bases found");
    });

    it("outputs empty JSON array with --json", async () => {
      await dbList({ json: true });

      expect(logOutput()).toBe("[]");
    });
  });

  // ── dataDir is empty ───────────────────────────────────────────────────────

  describe("when dataDir is empty", () => {
    beforeEach(() => {
      mockReaddir.mockResolvedValue([]);
    });

    it("prints soft message", async () => {
      await dbList({});

      expect(logOutput()).toContain("No knowledge bases found");
    });

    it("outputs empty JSON array with --json", async () => {
      await dbList({ json: true });

      expect(logOutput()).toBe("[]");
    });
  });

  // ── dataDir contains sqlite files ──────────────────────────────────────────

  describe("when dataDir contains sqlite files", () => {
    beforeEach(() => {
      mockReaddir.mockResolvedValue(["default.sqlite", "work.sqlite", "research.sqlite"]);
    });

    it("prints each database name", async () => {
      await dbList({});

      const output = logOutput();
      expect(output).toContain("default");
      expect(output).toContain("work");
      expect(output).toContain("research");
    });

    it("does not include the .sqlite extension in output", async () => {
      await dbList({});

      expect(logOutput()).not.toContain(".sqlite");
    });

    it("outputs sorted JSON array with --json", async () => {
      // readdir returns unsorted — the command must sort
      mockReaddir.mockResolvedValue(["work.sqlite", "default.sqlite", "research.sqlite"]);

      await dbList({ json: true });

      const parsed = JSON.parse(logOutput()) as string[];
      expect(parsed).toEqual(["default", "research", "work"]);
    });

    it("outputs valid JSON array with --json", async () => {
      await dbList({ json: true });

      expect(() => JSON.parse(logOutput())).not.toThrow();
    });
  });

  // ── non-sqlite files are ignored ───────────────────────────────────────────

  describe("filtering", () => {
    it("ignores files that do not end with .sqlite", async () => {
      mockReaddir.mockResolvedValue(["default.sqlite", "config.yaml", "notes.txt", "backup.db"]);

      await dbList({ json: true });

      const parsed = JSON.parse(logOutput()) as string[];
      expect(parsed).toEqual(["default"]);
    });
  });

  // ── readdir throws ─────────────────────────────────────────────────────────

  describe("when readdir throws", () => {
    beforeEach(() => {
      mockReaddir.mockRejectedValue(new Error("permission denied"));
    });

    it("prints soft message and does not propagate the error", async () => {
      await expect(dbList({})).resolves.not.toThrow();

      expect(logOutput()).toContain("No knowledge bases found");
    });

    it("outputs empty JSON array with --json", async () => {
      await dbList({ json: true });

      expect(logOutput()).toBe("[]");
    });
  });
});
