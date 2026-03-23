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
  error: vi.spyOn(console, "error").mockImplementation(() => {}),
};

// fs.existsSync — controlled per test
const mockExistsSync = vi.fn((_path: string) => true);
// fs.statSync — defaults to being a file
const mockStatSync = vi.fn((_path: string) => ({ isFile: () => true }));
vi.mock("node:fs", () => ({
  existsSync: (path: string) => mockExistsSync(path),
  statSync: (path: string) => mockStatSync(path),
}));

// fs/promises — controlled per test
const mockReaddir = vi.fn(async () => [] as string[]);
const mockRm = vi.fn(async (_path: string) => {});
const mockRename = vi.fn(async (_oldPath: string, _newPath: string) => {});
vi.mock("node:fs/promises", () => ({
  readdir: () => mockReaddir(),
  rm: (path: string) => mockRm(path),
  rename: (oldPath: string, newPath: string) => mockRename(oldPath, newPath),
}));

// @emdzej/ragclaw-core — mock Store and sanitizeDbName
const mockStoreOpen = vi.fn(async () => {});
const mockStoreClose = vi.fn(async () => {});
const mockStoreGetMeta = vi.fn(async (_key: string) => undefined as string | undefined);
const mockStoreSetMeta = vi.fn(async (_key: string, _value: string) => {});
vi.mock("@emdzej/ragclaw-core", () => {
  class Store {
    open = mockStoreOpen;
    close = mockStoreClose;
    getMeta = mockStoreGetMeta;
    setMeta = mockStoreSetMeta;
  }
  return {
    Store,
    sanitizeDbName: (name: string) => {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
        throw new Error(`Invalid knowledge base name: "${name}".`);
      }
      return name;
    },
    getDbPath: (name: string) => `/mock/data/${name}.sqlite`,
    MergeService: vi.fn(),
    createEmbedder: vi.fn(),
  };
});

// Config helpers
const MOCK_DATA_DIR = "/mock/data";
vi.mock("../config.js", () => ({
  getDataDir: vi.fn(() => MOCK_DATA_DIR),
  getDbPath: (name: string) => `/mock/data/${name}.sqlite`,
  ensureDataDir: vi.fn(),
  getConfig: vi.fn(() => ({ embedder: undefined })),
}));

// Import subjects under test AFTER all vi.mock calls
const { dbList, dbInit, dbInfoSet, dbDelete, dbRename } = await import("./db.js");

// ── Helpers ────────────────────────────────────────────────────────────────────

function logOutput(): string {
  return consoleSpy.log.mock.calls.flat().join("\n");
}

function errOutput(): string {
  return consoleSpy.error.mock.calls.flat().join("\n");
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

      const parsed = JSON.parse(logOutput()) as Array<{
        name: string;
        description: string | null;
        keywords: string[];
      }>;
      expect(parsed.map((e) => e.name)).toEqual(["default", "research", "work"]);
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

      const parsed = JSON.parse(logOutput()) as Array<{ name: string }>;
      expect(parsed.map((e) => e.name)).toEqual(["default"]);
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

// ── dbInit ─────────────────────────────────────────────────────────────────────

describe("dbInit()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("creates a new database when it does not exist", async () => {
    mockExistsSync.mockReturnValue(false);

    await dbInit("mydb");

    expect(mockStoreOpen).toHaveBeenCalledWith("/mock/data/mydb.sqlite");
    expect(mockStoreClose).toHaveBeenCalled();
    expect(logOutput()).toContain("mydb");
  });

  it("prints a message when the database already exists", async () => {
    mockExistsSync.mockReturnValue(true);

    await dbInit("existing");

    expect(mockStoreOpen).not.toHaveBeenCalled();
    expect(logOutput()).toContain("already exists");
  });

  it("includes next-steps hints in output", async () => {
    mockExistsSync.mockReturnValue(false);

    await dbInit("hints-db");

    const output = logOutput();
    expect(output).toContain("ragclaw add");
    expect(output).toContain("ragclaw search");
  });
});

// ── dbInit with description/keywords ──────────────────────────────────────────

describe("dbInit() with metadata options", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("writes description to store when --description is supplied", async () => {
    await dbInit("meta-db", { description: "API docs" });

    expect(mockStoreSetMeta).toHaveBeenCalledWith("db_description", "API docs");
    expect(logOutput()).toContain("API docs");
  });

  it("writes keywords to store when --keywords is supplied", async () => {
    await dbInit("kw-db", { keywords: "api, auth" });

    expect(mockStoreSetMeta).toHaveBeenCalledWith("db_keywords", "api, auth");
    expect(logOutput()).toContain("api, auth");
  });

  it("writes both description and keywords when both are supplied", async () => {
    await dbInit("both-db", { description: "Project X", keywords: "project, x" });

    expect(mockStoreSetMeta).toHaveBeenCalledWith("db_description", "Project X");
    expect(mockStoreSetMeta).toHaveBeenCalledWith("db_keywords", "project, x");
  });

  it("does not call setMeta when no options are supplied", async () => {
    await dbInit("plain-db");

    expect(mockStoreSetMeta).not.toHaveBeenCalled();
  });
});

// ── dbList metadata display ────────────────────────────────────────────────────

describe("dbList() metadata display", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockReaddir.mockResolvedValue(["docs.sqlite"]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows description in plain output when store has one", async () => {
    mockStoreGetMeta.mockImplementation(async (key: string) => {
      if (key === "db_description") return "API docs";
      return undefined;
    });

    await dbList({});

    expect(logOutput()).toContain("API docs");
  });

  it("shows keywords in plain output when store has them", async () => {
    mockStoreGetMeta.mockImplementation(async (key: string) => {
      if (key === "db_keywords") return "api, auth";
      return undefined;
    });

    await dbList({});

    expect(logOutput()).toContain("api");
    expect(logOutput()).toContain("auth");
  });

  it("includes description and keywords in --json output", async () => {
    mockStoreGetMeta.mockImplementation(async (key: string) => {
      if (key === "db_description") return "My docs";
      if (key === "db_keywords") return "foo, bar";
      return undefined;
    });

    await dbList({ json: true });

    const parsed = JSON.parse(logOutput()) as Array<{
      name: string;
      description: string | null;
      keywords: string[];
    }>;
    expect(parsed[0].description).toBe("My docs");
    expect(parsed[0].keywords).toEqual(["foo", "bar"]);
  });

  it("sets description to null in --json when store has none", async () => {
    mockStoreGetMeta.mockResolvedValue(undefined);

    await dbList({ json: true });

    const parsed = JSON.parse(logOutput()) as Array<{
      name: string;
      description: string | null;
      keywords: string[];
    }>;
    expect(parsed[0].description).toBeNull();
    expect(parsed[0].keywords).toEqual([]);
  });
});

// ── dbInfoSet ──────────────────────────────────────────────────────────────────

describe("dbInfoSet()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  it("writes description when --description is supplied", async () => {
    mockExistsSync.mockReturnValue(true);

    await dbInfoSet({ db: "mydb", description: "Updated description" });

    expect(mockStoreSetMeta).toHaveBeenCalledWith("db_description", "Updated description");
    expect(logOutput()).toContain("Updated description");
    expect(process.exitCode).toBeUndefined();
  });

  it("writes keywords when --keywords is supplied", async () => {
    mockExistsSync.mockReturnValue(true);

    await dbInfoSet({ db: "mydb", keywords: "search, api" });

    expect(mockStoreSetMeta).toHaveBeenCalledWith("db_keywords", "search, api");
    expect(logOutput()).toContain("search, api");
    expect(process.exitCode).toBeUndefined();
  });

  it("writes both description and keywords when both are supplied", async () => {
    mockExistsSync.mockReturnValue(true);

    await dbInfoSet({ db: "mydb", description: "Desc", keywords: "kw1, kw2" });

    expect(mockStoreSetMeta).toHaveBeenCalledWith("db_description", "Desc");
    expect(mockStoreSetMeta).toHaveBeenCalledWith("db_keywords", "kw1, kw2");
  });

  it("sets exitCode=1 when neither --description nor --keywords is supplied", async () => {
    mockExistsSync.mockReturnValue(true);

    await dbInfoSet({ db: "mydb" });

    expect(mockStoreSetMeta).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("sets exitCode=1 when the database does not exist", async () => {
    mockExistsSync.mockReturnValue(false);

    await dbInfoSet({ db: "ghost", description: "Desc" });

    expect(mockStoreSetMeta).not.toHaveBeenCalled();
    expect(errOutput()).toContain("not found");
    expect(process.exitCode).toBe(1);
  });

  it("shows (cleared) label in output when empty string is passed as description", async () => {
    mockExistsSync.mockReturnValue(true);

    await dbInfoSet({ db: "mydb", description: "" });

    expect(mockStoreSetMeta).toHaveBeenCalledWith("db_description", "");
    expect(logOutput()).toContain("(cleared)");
  });
});

// ── dbDelete ───────────────────────────────────────────────────────────────────

describe("dbDelete()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  it("deletes the .sqlite file when --yes is passed and DB exists", async () => {
    mockExistsSync.mockReturnValue(true);
    mockRm.mockResolvedValue(undefined);

    await dbDelete("mydb", { yes: true });

    expect(mockRm).toHaveBeenCalledWith("/mock/data/mydb.sqlite");
    expect(logOutput()).toContain("Deleted");
    expect(process.exitCode).toBeUndefined();
  });

  it("sets exitCode=1 when the DB does not exist", async () => {
    mockExistsSync.mockReturnValue(false);

    await dbDelete("ghost", { yes: true });

    expect(mockRm).not.toHaveBeenCalled();
    expect(errOutput()).toContain("not found");
    expect(process.exitCode).toBe(1);
  });

  it("sets exitCode=1 for an invalid DB name", async () => {
    await dbDelete("bad/name!", { yes: true });

    expect(mockRm).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("sets exitCode=1 when rm fails", async () => {
    mockExistsSync.mockReturnValue(true);
    mockRm.mockRejectedValue(new Error("permission denied"));

    await dbDelete("locked", { yes: true });

    expect(errOutput()).toContain("Failed to delete");
    expect(process.exitCode).toBe(1);
  });
});

// ── dbRename ───────────────────────────────────────────────────────────────────

describe("dbRename()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  it("renames the .sqlite file when old exists and new does not", async () => {
    // existsSync: true for old path, false for new path
    mockExistsSync
      .mockReturnValueOnce(true) // old path exists
      .mockReturnValueOnce(false); // new path does not exist
    mockRename.mockResolvedValue(undefined);

    await dbRename("old", "new");

    expect(mockRename).toHaveBeenCalledWith("/mock/data/old.sqlite", "/mock/data/new.sqlite");
    expect(logOutput()).toContain("old");
    expect(logOutput()).toContain("new");
    expect(process.exitCode).toBeUndefined();
  });

  it("sets exitCode=1 when old DB does not exist", async () => {
    mockExistsSync.mockReturnValue(false);

    await dbRename("missing", "target");

    expect(mockRename).not.toHaveBeenCalled();
    expect(errOutput()).toContain("not found");
    expect(process.exitCode).toBe(1);
  });

  it("sets exitCode=1 when new name already exists", async () => {
    // Both old and new exist
    mockExistsSync.mockReturnValue(true);

    await dbRename("source", "taken");

    expect(mockRename).not.toHaveBeenCalled();
    expect(errOutput()).toContain("already exists");
    expect(process.exitCode).toBe(1);
  });

  it("sets exitCode=1 for an invalid old name", async () => {
    await dbRename("bad/name", "ok");

    expect(mockRename).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("sets exitCode=1 for an invalid new name", async () => {
    mockExistsSync.mockReturnValue(true);

    await dbRename("ok", "bad/name");

    expect(mockRename).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("sets exitCode=1 when rename fails", async () => {
    mockExistsSync.mockReturnValueOnce(true).mockReturnValueOnce(false);
    mockRename.mockRejectedValue(new Error("cross-device rename"));

    await dbRename("src", "dst");

    expect(errOutput()).toContain("Failed to rename");
    expect(process.exitCode).toBe(1);
  });
});
