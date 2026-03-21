/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { RagClawPlugin, LoadedPlugin } from "@emdzej/ragclaw-core";

// ── Mocks ───────────────────────────────────────────────────────────────────

// Mock getPluginsDir (imported by PluginLoader constructor)
vi.mock("../config.js", () => ({
  getPluginsDir: vi.fn(() => "/fake/plugins"),
}));

// Mock fs and fs/promises
const mockExistsSync = vi.fn();
vi.mock("fs", () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
}));

const mockReaddir = vi.fn();
const mockReadFile = vi.fn();
vi.mock("fs/promises", () => ({
  readdir: (...args: unknown[]) => mockReaddir(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
}));

// Mock child_process (for npm global prefix)
const mockExecSync = vi.fn();
vi.mock("child_process", () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

// Import after mocks are set up
const { PluginLoader, getPluginLoader } = await import("./loader.js");

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Create a fake dirent. */
function fakeDirent(name: string, isDir = true) {
  return {
    name,
    isDirectory: () => isDir,
    isFile: () => !isDir,
    isSymbolicLink: () => false,
  };
}

/** Fake package.json content. */
function fakePackageJson(name: string, version = "1.0.0", main = "dist/index.js") {
  return JSON.stringify({ name, version, main, ragclaw: { schemes: ["test"] } });
}

/** Create a minimal plugin object. */
function fakePlugin(name: string): RagClawPlugin {
  return {
    name,
    version: "1.0.0",
    extractors: [],
    schemes: ["test"],
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("PluginLoader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // By default, directories don't exist
    mockExistsSync.mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── discover() ────────────────────────────────────────────────────────
  describe("discover()", () => {
    it("returns empty array when no plugins dir exists", async () => {
      const loader = new PluginLoader({ enabledPlugins: [] });
      const manifests = await loader.discover();
      expect(manifests).toEqual([]);
    });

    it("discovers local plugins from package.json", async () => {
      mockExistsSync.mockImplementation((path: string) => {
        if (path === "/fake/plugins") return true;
        if (path === "/fake/plugins/ragclaw-plugin-test/package.json") return true;
        return false;
      });

      mockReaddir.mockResolvedValue([fakeDirent("ragclaw-plugin-test")]);
      mockReadFile.mockResolvedValue(fakePackageJson("ragclaw-plugin-test"));

      const loader = new PluginLoader({ enabledPlugins: ["ragclaw-plugin-test"] });
      const manifests = await loader.discover();

      expect(manifests).toHaveLength(1);
      expect(manifests[0].name).toBe("ragclaw-plugin-test");
      expect(manifests[0].source).toBe("local");
      expect(manifests[0].main).toBe("dist/index.js");
    });

    it("skips hidden directories", async () => {
      mockExistsSync.mockImplementation((path: string) => {
        if (path === "/fake/plugins") return true;
        return false;
      });

      mockReaddir.mockResolvedValue([fakeDirent(".hidden-plugin")]);

      const loader = new PluginLoader({ enabledPlugins: [] });
      const manifests = await loader.discover();

      expect(manifests).toEqual([]);
    });

    it("discovers plugins with only index.js (no package.json)", async () => {
      mockExistsSync.mockImplementation((path: string) => {
        if (path === "/fake/plugins") return true;
        if (path === "/fake/plugins/my-plugin/package.json") return false;
        if (path === "/fake/plugins/my-plugin/index.js") return true;
        return false;
      });

      mockReaddir.mockResolvedValue([fakeDirent("my-plugin")]);

      const loader = new PluginLoader({ enabledPlugins: [] });
      const manifests = await loader.discover();

      expect(manifests).toHaveLength(1);
      expect(manifests[0].main).toBe("index.js");
      expect(manifests[0].version).toBe("0.0.0"); // default
    });

    it("scans npm global plugins when scanGlobalNpm is true", async () => {
      mockExecSync.mockReturnValue("/usr/local\n");
      mockExistsSync.mockImplementation((path: string) => {
        if (path === "/usr/local/lib/node_modules") return true;
        if (path === "/usr/local/lib/node_modules/ragclaw-plugin-npm/package.json") return true;
        if (path === "/fake/plugins") return false; // no local plugins
        return false;
      });

      mockReaddir.mockImplementation(async (dir: string) => {
        if (dir === "/usr/local/lib/node_modules") {
          return [fakeDirent("ragclaw-plugin-npm"), fakeDirent("unrelated-package")];
        }
        return [];
      });

      mockReadFile.mockResolvedValue(fakePackageJson("ragclaw-plugin-npm"));

      const loader = new PluginLoader({ scanGlobalNpm: true, enabledPlugins: ["ragclaw-plugin-npm"] });
      const manifests = await loader.discover();

      // Should only find the ragclaw-plugin-* package
      expect(manifests).toHaveLength(1);
      expect(manifests[0].name).toBe("ragclaw-plugin-npm");
      expect(manifests[0].source).toBe("npm");
    });

    it("skips npm scanning when scanGlobalNpm is false (default)", async () => {
      const loader = new PluginLoader({ enabledPlugins: [] });
      await loader.discover();

      expect(mockExecSync).not.toHaveBeenCalled();
    });

    it("discovers plugins in additionalPaths", async () => {
      mockExistsSync.mockImplementation((path: string) => {
        if (path === "/extra/plugins") return true;
        if (path === "/extra/plugins/ragclaw-plugin-extra/package.json") return true;
        return false;
      });

      mockReaddir.mockImplementation(async (dir: string) => {
        if (dir === "/extra/plugins") {
          return [fakeDirent("ragclaw-plugin-extra")];
        }
        return [];
      });

      mockReadFile.mockResolvedValue(fakePackageJson("ragclaw-plugin-extra"));

      const loader = new PluginLoader({
        additionalPaths: ["/extra/plugins"],
        enabledPlugins: ["ragclaw-plugin-extra"],
      });
      const manifests = await loader.discover();

      expect(manifests).toHaveLength(1);
      expect(manifests[0].name).toBe("ragclaw-plugin-extra");
      expect(manifests[0].source).toBe("workspace");
    });
  });

  // ── loadAll() ─────────────────────────────────────────────────────────
  describe("loadAll()", () => {
    it("only loads plugins in the enabledPlugins allowlist", async () => {
      mockExistsSync.mockImplementation((path: string) => {
        if (path === "/fake/plugins") return true;
        if (path.endsWith("/package.json")) return true;
        return false;
      });

      mockReaddir.mockResolvedValue([
        fakeDirent("ragclaw-plugin-allowed"),
        fakeDirent("ragclaw-plugin-blocked"),
      ]);

      mockReadFile.mockImplementation(async (_path: string) => {
        if (_path.includes("allowed")) return fakePackageJson("ragclaw-plugin-allowed");
        if (_path.includes("blocked")) return fakePackageJson("ragclaw-plugin-blocked");
        return "{}";
      });

      // Mock dynamic import — this is the tricky part
      // PluginLoader does `await import(entryPath)` which we can't easily mock
      // So we test loadAll filtering via discover + load integration
      const loader = new PluginLoader({ enabledPlugins: ["ragclaw-plugin-allowed"] });

      // Spy on load to avoid real dynamic imports.
      // The real load() pushes to this.loadedPlugins internally, so our mock must do the same.
      const loadSpy = vi.spyOn(loader, "load").mockImplementation(async (manifest) => {
        const plugin = fakePlugin(manifest.name);
        const lp = { manifest, plugin } satisfies LoadedPlugin;
        // @ts-expect-error accessing private to replicate real behaviour
        loader.loadedPlugins.push(lp);
        return lp;
      });

      const loaded = await loader.loadAll();

      // Should only attempt to load the allowed plugin
      expect(loadSpy).toHaveBeenCalledTimes(1);
      expect(loadSpy.mock.calls[0][0].name).toBe("ragclaw-plugin-allowed");
      expect(loaded).toHaveLength(1);
    });

    it("loads no plugins when enabledPlugins is empty", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReaddir.mockResolvedValue([fakeDirent("ragclaw-plugin-test")]);
      mockReadFile.mockResolvedValue(fakePackageJson("ragclaw-plugin-test"));

      const loader = new PluginLoader({ enabledPlugins: [] });
      const loaded = await loader.loadAll();

      expect(loaded).toEqual([]);
    });

    it("caches results on subsequent calls", async () => {
      const loader = new PluginLoader({ enabledPlugins: [] });
      const first = await loader.loadAll();
      const second = await loader.loadAll();

      expect(first).toBe(second);
    });

    it("handles plugin load failures gracefully", async () => {
      mockExistsSync.mockImplementation((path: string) => {
        if (path === "/fake/plugins") return true;
        if (path.endsWith("/package.json")) return true;
        return false;
      });

      mockReaddir.mockResolvedValue([fakeDirent("ragclaw-plugin-bad")]);
      mockReadFile.mockResolvedValue(fakePackageJson("ragclaw-plugin-bad"));

      const loader = new PluginLoader({ enabledPlugins: ["ragclaw-plugin-bad"] });
      vi.spyOn(loader, "load").mockRejectedValue(new Error("module not found"));

      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const loaded = await loader.loadAll();

      expect(loaded).toEqual([]);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to load plugin"),
        expect.anything(),
      );
    });
  });

  // ── getExtractors / getChunkers / getSchemes / getExtensions ──────────
  describe("accessors (getExtractors, getSchemes, etc.)", () => {
    it("aggregates extractors from loaded plugins", async () => {
      const loader = new PluginLoader({ enabledPlugins: [] });

      // Manually inject loaded plugins
      const extractor = { canHandle: () => true, extract: async () => ({ text: "", metadata: {}, sourceType: "text" as const }) };
      // @ts-expect-error accessing private for test
      loader.loadedPlugins = [
        {
          manifest: { name: "test", version: "1.0.0", main: "index.js", path: "/", source: "local" as const },
          plugin: { name: "test", version: "1.0.0", extractors: [extractor] },
        },
      ];

      const extractors = loader.getExtractors();
      expect(extractors).toHaveLength(1);
      expect(extractors[0]).toBe(extractor);
    });

    it("aggregates schemes from loaded plugins", async () => {
      const loader = new PluginLoader({ enabledPlugins: [] });

      // @ts-expect-error accessing private for test
      loader.loadedPlugins = [
        {
          manifest: { name: "test", version: "1.0.0", main: "index.js", path: "/", source: "local" as const },
          plugin: { name: "test", version: "1.0.0", schemes: ["github", "gh"] },
        },
      ];

      const schemes = loader.getSchemes();
      expect(schemes.size).toBe(2);
      expect(schemes.has("github")).toBe(true);
      expect(schemes.has("gh")).toBe(true);
    });

    it("aggregates file extensions from loaded plugins", async () => {
      const loader = new PluginLoader({ enabledPlugins: [] });

      // @ts-expect-error accessing private for test
      loader.loadedPlugins = [
        {
          manifest: { name: "test", version: "1.0.0", main: "index.js", path: "/", source: "local" as const },
          plugin: { name: "test", version: "1.0.0", extensions: [".epub", ".XLSX"] },
        },
      ];

      const extensions = loader.getExtensions();
      expect(extensions.size).toBe(2);
      expect(extensions.has(".epub")).toBe(true);
      expect(extensions.has(".xlsx")).toBe(true); // lowercased
    });
  });

  // ── expandSource() ────────────────────────────────────────────────────
  describe("expandSource()", () => {
    it("returns expanded sources from plugin", async () => {
      const loader = new PluginLoader({ enabledPlugins: [] });

      const expandedSources = [
        { type: "url" as const, url: "obsidian:///vault/note1.md" },
        { type: "url" as const, url: "obsidian:///vault/note2.md" },
      ];

      // @ts-expect-error accessing private for test
      loader.loadedPlugins = [
        {
          manifest: { name: "test", version: "1.0.0", main: "index.js", path: "/", source: "local" as const },
          plugin: { name: "test", version: "1.0.0", expand: vi.fn().mockResolvedValue(expandedSources) },
        },
      ];

      const result = await loader.expandSource({ type: "url", url: "obsidian:///vault" });
      expect(result).toBe(expandedSources);
    });

    it("returns null when no plugin handles expansion", async () => {
      const loader = new PluginLoader({ enabledPlugins: [] });

      // @ts-expect-error accessing private for test
      loader.loadedPlugins = [
        {
          manifest: { name: "test", version: "1.0.0", main: "index.js", path: "/", source: "local" as const },
          plugin: { name: "test", version: "1.0.0" }, // no expand function
        },
      ];

      const result = await loader.expandSource({ type: "url", url: "obsidian:///vault" });
      expect(result).toBeNull();
    });
  });

  // ── dispose() ─────────────────────────────────────────────────────────
  describe("dispose()", () => {
    it("calls dispose on all loaded plugins and clears state", async () => {
      const loader = new PluginLoader({ enabledPlugins: [] });
      const disposeFn = vi.fn();

      // @ts-expect-error accessing private for test
      loader.loadedPlugins = [
        {
          manifest: { name: "test", version: "1.0.0", main: "index.js", path: "/", source: "local" as const },
          plugin: { name: "test", version: "1.0.0", dispose: disposeFn },
        },
      ];
      // @ts-expect-error accessing private for test
      loader.initialized = true;

      await loader.dispose();

      expect(disposeFn).toHaveBeenCalledOnce();
      // @ts-expect-error accessing private for test
      expect(loader.loadedPlugins).toEqual([]);
      // @ts-expect-error accessing private for test
      expect(loader.initialized).toBe(false);
    });
  });
});

// ── getPluginLoader singleton ───────────────────────────────────────────────
describe("getPluginLoader()", () => {
  it("returns a PluginLoader instance", () => {
    const loader = getPluginLoader();
    expect(loader).toBeInstanceOf(PluginLoader);
  });
});