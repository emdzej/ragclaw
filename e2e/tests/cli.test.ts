/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIsolatedEnv, type IsolatedEnv } from "../helpers/spawn.js";

// ---------------------------------------------------------------------------
// Shared isolated env — recreated for every test
// ---------------------------------------------------------------------------

let env: IsolatedEnv;

beforeEach(async () => {
  env = await createIsolatedEnv();
});

afterEach(async () => {
  await env.cleanup();
});

// ---------------------------------------------------------------------------
// --help / --version (no SQLite needed)
// ---------------------------------------------------------------------------

describe("global flags", () => {
  it("exits 0 and prints usage for --help", async () => {
    const { exitCode, stdout } = await env.run(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage:");
    expect(stdout).toContain("ragclaw");
  });

  it("exits 0 and prints version for --version", async () => {
    const { exitCode, stdout } = await env.run(["--version"]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^\d+\.\d+\.\d+/);
  });
});

// ---------------------------------------------------------------------------
// Subcommand --help banners (no SQLite needed)
// ---------------------------------------------------------------------------

describe("subcommand help banners", () => {
  const subcommands = [
    "add",
    "search",
    "status",
    "list",
    "remove",
    "reindex",
    "merge",
    "init",
    "db",
  ];

  for (const cmd of subcommands) {
    it(`${cmd} --help exits 0`, async () => {
      const { exitCode, stdout } = await env.run([cmd, "--help"]);
      expect(exitCode).toBe(0);
      expect(stdout.toLowerCase()).toContain("usage");
    });
  }
});

// ---------------------------------------------------------------------------
// doctor (reads system info, no SQLite needed)
// ---------------------------------------------------------------------------

describe("doctor", () => {
  it("exits 0 and reports system info", async () => {
    const { exitCode, stdout } = await env.run(["doctor"]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/System Check/i);
    expect(stdout).toMatch(/Node/i);
  });
});

// ---------------------------------------------------------------------------
// init (creates .sqlite file)
// ---------------------------------------------------------------------------

describe("init", () => {
  it("creates the .sqlite file and exits 0", async () => {
    const { exitCode, stdout } = await env.run(["init", "mydb"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("mydb");

    const dbFile = join(env.dataDir, "mydb.sqlite");
    expect(existsSync(dbFile)).toBe(true);
  });

  it("uses 'default' when no name is provided", async () => {
    const { exitCode, stdout } = await env.run(["init"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("default");

    const dbFile = join(env.dataDir, "default.sqlite");
    expect(existsSync(dbFile)).toBe(true);
  });

  it("rejects invalid KB names", async () => {
    const { failed, stderr, stdout } = await env.run(["init", "my/bad name"]);
    expect(failed).toBe(true);
    const combined = stdout + stderr;
    expect(combined.toLowerCase()).toMatch(/invalid|error/);
  });
});

// ---------------------------------------------------------------------------
// status / list — on a freshly-initialised KB
// ---------------------------------------------------------------------------

describe("status", () => {
  it("reports stats on a fresh KB", async () => {
    await env.run(["init", "fresh"]);
    const { exitCode, stdout } = await env.run(["status", "--db", "fresh"]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/0/);
  });
});

describe("list", () => {
  it("shows empty list on a fresh KB", async () => {
    await env.run(["init", "empty"]);
    const { exitCode, stdout } = await env.run(["list", "--db", "empty"]);
    expect(exitCode).toBe(0);
    expect(stdout.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// add → list → remove happy path
// ---------------------------------------------------------------------------

describe("add / list / remove", () => {
  it("indexes a text file, lists it, then removes it", { timeout: 120_000 }, async () => {
    await env.run(["init", "docs"]);

    // Write a tiny fixture into the isolated temp dir
    const fixture = join(env.dataDir, "fixture.txt");
    await writeFile(fixture, "ragclaw is a local-first RAG engine for indexing documents.");

    const addResult = await env.run(["add", fixture, "--db", "docs"]);
    expect(addResult.exitCode).toBe(0);

    const listResult = await env.run(["list", "--db", "docs"]);
    expect(listResult.exitCode).toBe(0);
    expect(listResult.stdout).toContain("fixture.txt");

    const removeResult = await env.run(["remove", fixture, "--db", "docs", "--yes"]);
    expect(removeResult.exitCode).toBe(0);

    const listAfter = await env.run(["list", "--db", "docs"]);
    expect(listAfter.exitCode).toBe(0);
    expect(listAfter.stdout).not.toContain("fixture.txt");
  });
});

// ---------------------------------------------------------------------------
// search — after indexing a known file
// ---------------------------------------------------------------------------

describe("search", () => {
  it("returns results for a term known to be in the indexed file", {
    timeout: 120_000,
  }, async () => {
    await env.run(["init", "searchdb"]);

    const fixture = join(env.dataDir, "searchable.txt");
    await writeFile(fixture, "ragclaw is a local-first RAG engine for indexing documents.");
    await env.run(["add", fixture, "--db", "searchdb"]);

    const { exitCode, stdout } = await env.run(["search", "ragclaw", "--db", "searchdb"]);
    expect(exitCode).toBe(0);
    expect(stdout.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// db list
// ---------------------------------------------------------------------------

describe("db list", () => {
  it("exits 0 and shows soft message when no databases exist", async () => {
    const { exitCode, stdout } = await env.run(["db", "list"]);
    expect(exitCode).toBe(0);
    expect(stdout.length).toBeGreaterThan(0);
  });

  it("lists database names after init", async () => {
    await env.run(["db", "init", "alpha"]);
    await env.run(["db", "init", "beta"]);

    const { exitCode, stdout } = await env.run(["db", "list"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("alpha");
    expect(stdout).toContain("beta");
  });

  it("--json returns a sorted JSON array of names", async () => {
    await env.run(["db", "init", "zebra"]);
    await env.run(["db", "init", "apple"]);

    const { exitCode, stdout } = await env.run(["db", "list", "--json"]);
    expect(exitCode).toBe(0);

    const parsed = JSON.parse(stdout) as string[];
    expect(parsed).toContain("zebra");
    expect(parsed).toContain("apple");
    expect(parsed.indexOf("apple")).toBeLessThan(parsed.indexOf("zebra"));
  });

  it("--json returns empty array when no databases exist", async () => {
    const { exitCode, stdout } = await env.run(["db", "list", "--json"]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// db init
// ---------------------------------------------------------------------------

describe("db init", () => {
  it("creates the .sqlite file and exits 0", async () => {
    const { exitCode, stdout } = await env.run(["db", "init", "newdb"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("newdb");

    const dbFile = join(env.dataDir, "newdb.sqlite");
    expect(existsSync(dbFile)).toBe(true);
  });

  it("uses 'default' when no name is provided", async () => {
    const { exitCode, stdout } = await env.run(["db", "init"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("default");

    const dbFile = join(env.dataDir, "default.sqlite");
    expect(existsSync(dbFile)).toBe(true);
  });

  it("reports already-exists message without error when called twice", async () => {
    await env.run(["db", "init", "dup"]);
    const { exitCode, stdout } = await env.run(["db", "init", "dup"]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/already exists/i);
  });

  it("rejects invalid KB names", async () => {
    const { failed } = await env.run(["db", "init", "bad/name"]);
    expect(failed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// db delete
// ---------------------------------------------------------------------------

describe("db delete", () => {
  it("deletes the .sqlite file with --yes and exits 0", async () => {
    await env.run(["db", "init", "to-delete"]);
    const dbFile = join(env.dataDir, "to-delete.sqlite");
    expect(existsSync(dbFile)).toBe(true);

    const { exitCode, stdout } = await env.run(["db", "delete", "to-delete", "--yes"]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/deleted/i);
    expect(existsSync(dbFile)).toBe(false);
  });

  it("exits non-zero when the DB does not exist", async () => {
    const { failed } = await env.run(["db", "delete", "nonexistent", "--yes"]);
    expect(failed).toBe(true);
  });

  it("exits non-zero for an invalid DB name", async () => {
    const { failed } = await env.run(["db", "delete", "bad/name", "--yes"]);
    expect(failed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// db rename
// ---------------------------------------------------------------------------

describe("db rename", () => {
  it("renames the .sqlite file and exits 0", async () => {
    await env.run(["db", "init", "oldname"]);
    const oldFile = join(env.dataDir, "oldname.sqlite");
    const newFile = join(env.dataDir, "newname.sqlite");
    expect(existsSync(oldFile)).toBe(true);

    const { exitCode, stdout } = await env.run(["db", "rename", "oldname", "newname"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("oldname");
    expect(stdout).toContain("newname");
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(newFile)).toBe(true);
  });

  it("exits non-zero when source does not exist", async () => {
    const { failed } = await env.run(["db", "rename", "missing", "target"]);
    expect(failed).toBe(true);
  });

  it("exits non-zero when target name already exists", async () => {
    await env.run(["db", "init", "src"]);
    await env.run(["db", "init", "existing"]);

    const { failed } = await env.run(["db", "rename", "src", "existing"]);
    expect(failed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// deprecated top-level aliases
// ---------------------------------------------------------------------------

describe("deprecated aliases", () => {
  it("'ragclaw init' still works and prints deprecation warning to stderr", async () => {
    const { exitCode, stderr } = await env.run(["init", "legacydb"]);
    expect(exitCode).toBe(0);
    expect(stderr).toMatch(/deprecated/i);

    const dbFile = join(env.dataDir, "legacydb.sqlite");
    expect(existsSync(dbFile)).toBe(true);
  });

  it("'ragclaw merge --help' still exits 0 and prints deprecation in description", async () => {
    const { exitCode, stdout } = await env.run(["merge", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout.toLowerCase()).toMatch(/deprecated/i);
  });
});

// ---------------------------------------------------------------------------
// error paths — bad arguments
// ---------------------------------------------------------------------------

describe("error handling", () => {
  it("exits non-zero for an unknown subcommand", async () => {
    const { failed } = await env.run(["not-a-real-command"]);
    expect(failed).toBe(true);
  });

  it("fails when source file does not exist", async () => {
    await env.run(["init", "errdb"]);
    const result = await env.run(["add", "/nonexistent/path/file.md", "--db", "errdb"]);
    // The CLI throws an unhandled error — process may crash (SIGABRT) or exit non-zero
    expect(result.failed).toBe(true);
  });
});
