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
  const subcommands = ["add", "search", "status", "list", "remove", "reindex", "merge", "init"];

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
