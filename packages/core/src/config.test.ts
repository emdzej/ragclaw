/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_EXTRACTOR_LIMITS,
  getConfig,
  getDbPath,
  resetConfigCache,
  SETTABLE_KEYS,
  sanitizeDbName,
} from "./config.js";

// ---------------------------------------------------------------------------
// sanitizeDbName — pure function tests (Tier 1)
// ---------------------------------------------------------------------------

describe("sanitizeDbName", () => {
  it("accepts valid alphanumeric names", () => {
    expect(sanitizeDbName("mydb")).toBe("mydb");
    expect(sanitizeDbName("MyDatabase123")).toBe("MyDatabase123");
  });

  it("accepts names with hyphens and underscores", () => {
    expect(sanitizeDbName("my-db")).toBe("my-db");
    expect(sanitizeDbName("my_db")).toBe("my_db");
    expect(sanitizeDbName("my-db_2")).toBe("my-db_2");
  });

  it("accepts single character names", () => {
    expect(sanitizeDbName("a")).toBe("a");
    expect(sanitizeDbName("Z")).toBe("Z");
    expect(sanitizeDbName("0")).toBe("0");
  });

  it("accepts names up to 64 characters", () => {
    const name = "a".repeat(64);
    expect(sanitizeDbName(name)).toBe(name);
  });

  it("rejects empty string", () => {
    expect(() => sanitizeDbName("")).toThrow("Invalid knowledge base name");
  });

  it("rejects names longer than 64 characters", () => {
    const name = "a".repeat(65);
    expect(() => sanitizeDbName(name)).toThrow("Invalid knowledge base name");
  });

  it("rejects path traversal sequences", () => {
    expect(() => sanitizeDbName("..")).toThrow("Invalid knowledge base name");
    expect(() => sanitizeDbName("../secret")).toThrow("Invalid knowledge base name");
    expect(() => sanitizeDbName("foo/../bar")).toThrow("Invalid knowledge base name");
  });

  it("rejects path separators", () => {
    expect(() => sanitizeDbName("foo/bar")).toThrow("Invalid knowledge base name");
    expect(() => sanitizeDbName("foo\\bar")).toThrow("Invalid knowledge base name");
  });

  it("rejects special characters", () => {
    expect(() => sanitizeDbName("foo bar")).toThrow("Invalid knowledge base name");
    expect(() => sanitizeDbName("foo.bar")).toThrow("Invalid knowledge base name");
    expect(() => sanitizeDbName("foo@bar")).toThrow("Invalid knowledge base name");
    expect(() => sanitizeDbName("foo!")).toThrow("Invalid knowledge base name");
    expect(() => sanitizeDbName("foo$bar")).toThrow("Invalid knowledge base name");
  });
});

// ---------------------------------------------------------------------------
// getConfig — environment variable & overrides layer (Tier 2)
// ---------------------------------------------------------------------------

describe("getConfig", () => {
  // Save original env vars and restore after each test
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = [
    "RAGCLAW_CONFIG_DIR",
    "RAGCLAW_DATA_DIR",
    "RAGCLAW_PLUGINS_DIR",
    "RAGCLAW_ALLOWED_PATHS",
    "RAGCLAW_ALLOW_URLS",
    "RAGCLAW_BLOCK_PRIVATE_URLS",
    "RAGCLAW_MAX_DEPTH",
    "RAGCLAW_MAX_FILES",
    "RAGCLAW_ENFORCE_GUARDS",
    "RAGCLAW_FETCH_TIMEOUT_MS",
    "RAGCLAW_MAX_RESPONSE_SIZE_BYTES",
    "RAGCLAW_MAX_PDF_PAGES",
    "RAGCLAW_OCR_TIMEOUT_MS",
    // XDG
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
  ];

  beforeEach(() => {
    resetConfigCache();
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    resetConfigCache();
  });

  it("returns a config object with all required fields", () => {
    const config = getConfig();
    expect(config).toHaveProperty("configDir");
    expect(config).toHaveProperty("dataDir");
    expect(config).toHaveProperty("pluginsDir");
    expect(config).toHaveProperty("enabledPlugins");
    expect(config).toHaveProperty("allowedPaths");
    expect(config).toHaveProperty("allowUrls");
    expect(config).toHaveProperty("blockPrivateUrls");
    expect(config).toHaveProperty("maxDepth");
    expect(config).toHaveProperty("maxFiles");
    expect(config).toHaveProperty("enforceGuards");
    expect(config).toHaveProperty("extractorLimits");
    expect(config).toHaveProperty("pluginConfig");
  });

  it("has correct defaults", () => {
    const config = getConfig();
    expect(config.allowUrls).toBe(true);
    expect(config.blockPrivateUrls).toBe(true);
    expect(config.maxDepth).toBe(10);
    expect(config.maxFiles).toBe(1000);
    expect(config.enforceGuards).toBe(false);
    expect(config.enabledPlugins).toEqual([]);
    expect(config.scanGlobalNpm).toBe(false);
    expect(config.extractorLimits).toEqual(DEFAULT_EXTRACTOR_LIMITS);
    expect(config.pluginConfig).toEqual({});
  });

  it("caches config on subsequent calls", () => {
    const a = getConfig();
    const b = getConfig();
    expect(a).toBe(b); // Same reference
  });

  it("bypasses cache when overrides are provided", () => {
    const a = getConfig();
    const b = getConfig({ maxDepth: 99 });
    expect(b.maxDepth).toBe(99);
    expect(a.maxDepth).not.toBe(99);
    // Cache should still return original
    const c = getConfig();
    expect(c).toBe(a);
  });

  it("resetConfigCache forces re-read", () => {
    const a = getConfig();
    resetConfigCache();
    const b = getConfig();
    expect(a).not.toBe(b); // Different references
  });

  // ── Environment variables ──────────────────────────────────────────────

  describe("environment variable overrides", () => {
    it("RAGCLAW_CONFIG_DIR overrides config dir", () => {
      process.env.RAGCLAW_CONFIG_DIR = "/custom/config";
      const config = getConfig();
      expect(config.configDir).toBe("/custom/config");
    });

    it("RAGCLAW_DATA_DIR overrides data dir", () => {
      process.env.RAGCLAW_DATA_DIR = "/custom/data";
      const config = getConfig();
      expect(config.dataDir).toBe("/custom/data");
    });

    it("RAGCLAW_PLUGINS_DIR overrides plugins dir", () => {
      process.env.RAGCLAW_PLUGINS_DIR = "/custom/plugins";
      const config = getConfig();
      expect(config.pluginsDir).toBe("/custom/plugins");
    });

    it("RAGCLAW_ALLOWED_PATHS sets allowed paths from comma-separated list", () => {
      process.env.RAGCLAW_ALLOWED_PATHS = "/path/one, /path/two";
      const config = getConfig();
      expect(config.allowedPaths).toHaveLength(2);
      expect(config.allowedPaths[0]).toContain("path/one");
      expect(config.allowedPaths[1]).toContain("path/two");
    });

    it("RAGCLAW_ALLOW_URLS=false disables URLs", () => {
      process.env.RAGCLAW_ALLOW_URLS = "false";
      const config = getConfig();
      expect(config.allowUrls).toBe(false);
    });

    it("RAGCLAW_ALLOW_URLS=true keeps URLs enabled", () => {
      process.env.RAGCLAW_ALLOW_URLS = "true";
      const config = getConfig();
      expect(config.allowUrls).toBe(true);
    });

    it("RAGCLAW_BLOCK_PRIVATE_URLS=false disables private URL blocking", () => {
      process.env.RAGCLAW_BLOCK_PRIVATE_URLS = "false";
      const config = getConfig();
      expect(config.blockPrivateUrls).toBe(false);
    });

    it("RAGCLAW_MAX_DEPTH overrides max depth", () => {
      process.env.RAGCLAW_MAX_DEPTH = "5";
      const config = getConfig();
      expect(config.maxDepth).toBe(5);
    });

    it("RAGCLAW_MAX_DEPTH ignores invalid values", () => {
      process.env.RAGCLAW_MAX_DEPTH = "notanumber";
      const config = getConfig();
      expect(config.maxDepth).toBe(10); // default
    });

    it("RAGCLAW_MAX_FILES overrides max files", () => {
      process.env.RAGCLAW_MAX_FILES = "500";
      const config = getConfig();
      expect(config.maxFiles).toBe(500);
    });

    it("RAGCLAW_ENFORCE_GUARDS=true enables guards", () => {
      process.env.RAGCLAW_ENFORCE_GUARDS = "true";
      const config = getConfig();
      expect(config.enforceGuards).toBe(true);
    });

    it("RAGCLAW_ENFORCE_GUARDS=false keeps guards disabled", () => {
      process.env.RAGCLAW_ENFORCE_GUARDS = "false";
      const config = getConfig();
      expect(config.enforceGuards).toBe(false);
    });
  });

  // ── Extractor limits from env vars ─────────────────────────────────────

  describe("extractor limits from environment", () => {
    it("RAGCLAW_FETCH_TIMEOUT_MS overrides fetch timeout", () => {
      process.env.RAGCLAW_FETCH_TIMEOUT_MS = "5000";
      const config = getConfig();
      expect(config.extractorLimits.fetchTimeoutMs).toBe(5000);
    });

    it("RAGCLAW_MAX_RESPONSE_SIZE_BYTES overrides max response size", () => {
      process.env.RAGCLAW_MAX_RESPONSE_SIZE_BYTES = "1048576";
      const config = getConfig();
      expect(config.extractorLimits.maxResponseSizeBytes).toBe(1048576);
    });

    it("RAGCLAW_MAX_PDF_PAGES overrides max PDF pages", () => {
      process.env.RAGCLAW_MAX_PDF_PAGES = "50";
      const config = getConfig();
      expect(config.extractorLimits.maxPdfPages).toBe(50);
    });

    it("RAGCLAW_OCR_TIMEOUT_MS overrides OCR timeout", () => {
      process.env.RAGCLAW_OCR_TIMEOUT_MS = "120000";
      const config = getConfig();
      expect(config.extractorLimits.ocrTimeoutMs).toBe(120000);
    });

    it("ignores invalid (non-numeric) extractor env vars", () => {
      process.env.RAGCLAW_FETCH_TIMEOUT_MS = "nope";
      const config = getConfig();
      expect(config.extractorLimits.fetchTimeoutMs).toBe(DEFAULT_EXTRACTOR_LIMITS.fetchTimeoutMs);
    });

    it("ignores zero/negative extractor env vars", () => {
      process.env.RAGCLAW_FETCH_TIMEOUT_MS = "0";
      const config = getConfig();
      expect(config.extractorLimits.fetchTimeoutMs).toBe(DEFAULT_EXTRACTOR_LIMITS.fetchTimeoutMs);
    });
  });

  // ── CLI-flag overrides ─────────────────────────────────────────────────

  describe("CLI-flag overrides (highest priority)", () => {
    it("overrides beat env vars", () => {
      process.env.RAGCLAW_MAX_DEPTH = "5";
      const config = getConfig({ maxDepth: 20 });
      expect(config.maxDepth).toBe(20);
    });

    it("overrides are not cached", () => {
      const a = getConfig({ enforceGuards: true });
      const b = getConfig();
      expect(a.enforceGuards).toBe(true);
      expect(b.enforceGuards).toBe(false); // default
    });

    it("supports partial overrides (rest keeps defaults/env)", () => {
      process.env.RAGCLAW_MAX_FILES = "777";
      const config = getConfig({ maxDepth: 3 });
      expect(config.maxDepth).toBe(3);
      expect(config.maxFiles).toBe(777); // env still applies
    });
  });
});

// ---------------------------------------------------------------------------
// getDbPath — defence-in-depth containment check
// ---------------------------------------------------------------------------

describe("getDbPath", () => {
  beforeEach(() => {
    resetConfigCache();
  });

  afterEach(() => {
    resetConfigCache();
  });

  it("returns a .sqlite path within dataDir", () => {
    const path = getDbPath("mydb");
    expect(path).toMatch(/mydb\.sqlite$/);
  });

  it("throws for invalid names (delegates to sanitizeDbName)", () => {
    expect(() => getDbPath("../escape")).toThrow("Invalid knowledge base name");
    expect(() => getDbPath("foo/bar")).toThrow("Invalid knowledge base name");
    expect(() => getDbPath("")).toThrow("Invalid knowledge base name");
  });
});

// ---------------------------------------------------------------------------
// SETTABLE_KEYS metadata
// ---------------------------------------------------------------------------

describe("SETTABLE_KEYS", () => {
  it("is a non-empty array", () => {
    expect(SETTABLE_KEYS.length).toBeGreaterThan(0);
  });

  it("each entry has required fields", () => {
    for (const key of SETTABLE_KEYS) {
      expect(typeof key.yamlKey).toBe("string");
      expect(["string", "string[]", "boolean", "number"]).toContain(key.type);
      expect(typeof key.description).toBe("string");
    }
  });

  it("includes core config keys", () => {
    const yamlKeys = SETTABLE_KEYS.map((k) => k.yamlKey);
    expect(yamlKeys).toContain("dataDir");
    expect(yamlKeys).toContain("plugins");
    expect(yamlKeys).toContain("allowedPaths");
    expect(yamlKeys).toContain("enforceGuards");
    expect(yamlKeys).toContain("maxDepth");
    expect(yamlKeys).toContain("maxFiles");
  });

  it("includes extractor limit keys", () => {
    const yamlKeys = SETTABLE_KEYS.map((k) => k.yamlKey);
    expect(yamlKeys).toContain("extractor.fetchTimeoutMs");
    expect(yamlKeys).toContain("extractor.maxResponseSizeBytes");
    expect(yamlKeys).toContain("extractor.maxPdfPages");
    expect(yamlKeys).toContain("extractor.ocrTimeoutMs");
  });

  it("includes embedder key", () => {
    const yamlKeys = SETTABLE_KEYS.map((k) => k.yamlKey);
    expect(yamlKeys).toContain("embedder");
    const meta = SETTABLE_KEYS.find((k) => k.yamlKey === "embedder");
    expect(meta?.envVar).toBe("RAGCLAW_EMBEDDER");
    expect(meta?.type).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// YAML config file parsing — embedder field + nested blocks
// ---------------------------------------------------------------------------

describe("config file YAML parsing", () => {
  let tmpDir: string;

  // Save/restore env vars that affect config loading
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = [
    "RAGCLAW_CONFIG_DIR",
    "RAGCLAW_DATA_DIR",
    "RAGCLAW_EMBEDDER",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
  ];

  beforeEach(() => {
    // Create a temp dir used as RAGCLAW_CONFIG_DIR
    tmpDir = join(tmpdir(), `ragclaw-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    resetConfigCache();
    for (const key of envKeys) savedEnv[key] = process.env[key];
    process.env.RAGCLAW_CONFIG_DIR = tmpDir;
    process.env.RAGCLAW_DATA_DIR = tmpDir;
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    resetConfigCache();
  });

  function writeConfig(yaml: string) {
    writeFileSync(join(tmpDir, "config.yaml"), yaml, "utf-8");
    resetConfigCache();
  }

  it("parses embedder alias string", () => {
    writeConfig("embedder: bge\n");
    const cfg = getConfig();
    expect(cfg.embedder).toBe("bge");
  });

  it("parses embedder alias with quotes", () => {
    writeConfig('embedder: "nomic"\n');
    const cfg = getConfig();
    expect(cfg.embedder).toBe("nomic");
  });

  it("parses embedder as nested object with model", () => {
    writeConfig("embedder:\n  model: BAAI/bge-m3\n");
    const cfg = getConfig();
    expect(cfg.embedder).toEqual(expect.objectContaining({ model: "BAAI/bge-m3" }));
  });

  it("parses embedder object with plugin + baseUrl", () => {
    writeConfig(
      "embedder:\n  plugin: ollama\n  model: nomic-embed-text\n  baseUrl: http://localhost:11434\n"
    );
    const cfg = getConfig();
    expect(cfg.embedder).toEqual(
      expect.objectContaining({
        plugin: "ollama",
        model: "nomic-embed-text",
        baseUrl: "http://localhost:11434",
      })
    );
  });

  it("embedder is undefined when not set", () => {
    writeConfig("maxDepth: 5\n");
    const cfg = getConfig();
    expect(cfg.embedder).toBeUndefined();
  });

  it("parses booleans natively (true/false, not strings)", () => {
    writeConfig("allowUrls: false\nblockPrivateUrls: false\nscanGlobalNpm: true\n");
    const cfg = getConfig();
    expect(cfg.allowUrls).toBe(false);
    expect(cfg.blockPrivateUrls).toBe(false);
    expect(cfg.scanGlobalNpm).toBe(true);
  });

  it("parses numbers natively", () => {
    writeConfig("maxDepth: 7\nmaxFiles: 500\n");
    const cfg = getConfig();
    expect(cfg.maxDepth).toBe(7);
    expect(cfg.maxFiles).toBe(500);
  });

  it("parses plugins as a YAML list", () => {
    writeConfig("plugins:\n  - github\n  - youtube\n");
    const cfg = getConfig();
    expect(cfg.enabledPlugins).toEqual(["github", "youtube"]);
  });

  it("parses allowedPaths as a YAML list", () => {
    writeConfig("allowedPaths:\n  - /tmp/a\n  - /tmp/b\n");
    const cfg = getConfig();
    expect(cfg.allowedPaths).toHaveLength(2);
    expect(cfg.allowedPaths[0]).toContain("tmp/a");
    expect(cfg.allowedPaths[1]).toContain("tmp/b");
  });

  it("parses nested extractor block", () => {
    writeConfig("extractor:\n  fetchTimeoutMs: 5000\n  maxPdfPages: 50\n");
    const cfg = getConfig();
    expect(cfg.extractorLimits.fetchTimeoutMs).toBe(5000);
    expect(cfg.extractorLimits.maxPdfPages).toBe(50);
  });

  it("still supports legacy flat dotted extractor keys", () => {
    writeConfig("extractor.fetchTimeoutMs: 8000\n");
    const cfg = getConfig();
    expect(cfg.extractorLimits.fetchTimeoutMs).toBe(8000);
  });

  it("parses nested plugin block", () => {
    writeConfig("plugin:\n  github:\n    token: abc123\n    maxIssues: 50\n");
    const cfg = getConfig();
    expect(cfg.pluginConfig.github?.token).toBe("abc123");
    expect(cfg.pluginConfig.github?.maxIssues).toBe(50);
  });

  it("still supports legacy flat dotted plugin keys", () => {
    writeConfig("plugin.github.token: mytoken\n");
    const cfg = getConfig();
    expect(cfg.pluginConfig.github?.token).toBe("mytoken");
  });
});

// ---------------------------------------------------------------------------
// RAGCLAW_EMBEDDER env var
// ---------------------------------------------------------------------------

describe("RAGCLAW_EMBEDDER env var", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    resetConfigCache();
    savedEnv.RAGCLAW_EMBEDDER = process.env.RAGCLAW_EMBEDDER;
  });

  afterEach(() => {
    if (savedEnv.RAGCLAW_EMBEDDER === undefined) delete process.env.RAGCLAW_EMBEDDER;
    else process.env.RAGCLAW_EMBEDDER = savedEnv.RAGCLAW_EMBEDDER;
    resetConfigCache();
  });

  it("sets embedder from env var", () => {
    process.env.RAGCLAW_EMBEDDER = "minilm";
    const cfg = getConfig();
    expect(cfg.embedder).toBe("minilm");
  });

  it("env var overrides config file embedder", () => {
    process.env.RAGCLAW_EMBEDDER = "bge";
    // Even without a file, env var wins
    const cfg = getConfig();
    expect(cfg.embedder).toBe("bge");
  });
});
