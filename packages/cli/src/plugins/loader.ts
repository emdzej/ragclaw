/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  Chunker,
  EmbedderPlugin,
  Extractor,
  LoadedPlugin,
  PluginLoaderOptions,
  PluginManifest,
  RagClawPlugin,
  Source,
} from "@emdzej/ragclaw-core";
import { getPluginsDir } from "../config.js";

export class PluginLoader {
  private options: PluginLoaderOptions;
  private loadedPlugins: LoadedPlugin[] = [];
  private initialized = false;

  constructor(options: PluginLoaderOptions = {}) {
    this.options = {
      localPluginsDir: getPluginsDir(),
      ...options,
    };
  }

  /**
   * Discover all available plugins (npm global + local).
   * Global npm scanning is off by default (opt-in via scanGlobalNpm option).
   */
  async discover(): Promise<PluginManifest[]> {
    const manifests: PluginManifest[] = [];

    // 1. Scan npm global packages for ragclaw-plugin-* (off by default)
    if (this.options.scanGlobalNpm) {
      const npmPlugins = await this.discoverNpmPlugins();
      manifests.push(...npmPlugins);
    }

    // 2. Scan local plugins directory
    const localPlugins = await this.discoverLocalPlugins();
    manifests.push(...localPlugins);

    // 3. Scan additional paths
    if (this.options.additionalPaths) {
      for (const path of this.options.additionalPaths) {
        const additional = await this.discoverPluginsInDir(path, "workspace");
        manifests.push(...additional);
      }
    }

    return manifests;
  }

  /**
   * Load a plugin from its manifest
   */
  async load(manifest: PluginManifest): Promise<LoadedPlugin> {
    const entryPath = join(manifest.path, manifest.main);

    // Dynamic import
    const module = await import(entryPath);
    const plugin: RagClawPlugin = module.default || module;

    // Validate plugin
    if (!plugin.name || !plugin.version) {
      throw new Error(`Invalid plugin: ${manifest.name} - missing name or version`);
    }

    // Initialize if needed
    if (plugin.init) {
      const config = this.options.config?.[manifest.name];
      await plugin.init(config);
    }

    const loaded: LoadedPlugin = { manifest, plugin };
    this.loadedPlugins.push(loaded);

    return loaded;
  }

  /**
   * Load all discovered plugins that are in the enabled allowlist.
   * If enabledPlugins is undefined or empty, no plugins are loaded.
   */
  async loadAll(): Promise<LoadedPlugin[]> {
    if (this.initialized) {
      return this.loadedPlugins;
    }

    const manifests = await this.discover();
    const allowed = this.options.enabledPlugins;

    for (const manifest of manifests) {
      // Only load plugins explicitly listed in the allowlist
      if (!allowed || !allowed.includes(manifest.name)) {
        continue;
      }

      try {
        await this.load(manifest);
      } catch (err) {
        console.warn(`Failed to load plugin ${manifest.name}:`, err);
      }
    }

    this.initialized = true;
    return this.loadedPlugins;
  }

  /**
   * Get all extractors from loaded plugins
   */
  getExtractors(): Extractor[] {
    const extractors: Extractor[] = [];
    for (const { plugin } of this.loadedPlugins) {
      if (plugin.extractors) {
        extractors.push(...plugin.extractors);
      }
    }
    return extractors;
  }

  /**
   * Returns the first embedder provided by a loaded plugin, or `null`.
   * Resolution priority follows load order (first enabled plugin wins).
   */
  getEmbedder(): EmbedderPlugin | null {
    for (const { plugin } of this.loadedPlugins) {
      if (plugin.embedder) return plugin.embedder;
    }
    return null;
  }

  /**
   * Returns all embedders provided by loaded plugins, each paired with the
   * name of the plugin that provides it.
   */
  getEmbedders(): Array<{ pluginName: string; embedder: EmbedderPlugin }> {
    const result: Array<{ pluginName: string; embedder: EmbedderPlugin }> = [];
    for (const { manifest, plugin } of this.loadedPlugins) {
      if (plugin.embedder) {
        result.push({ pluginName: manifest.name, embedder: plugin.embedder });
      }
    }
    return result;
  }

  /**
   * Returns all loaded plugins (manifest + plugin instance pairs).
   */
  getLoadedPlugins(): LoadedPlugin[] {
    return this.loadedPlugins;
  }

  /**
   * Get all chunkers from loaded plugins
   */
  getChunkers(): Chunker[] {
    const chunkers: Chunker[] = [];
    for (const { plugin } of this.loadedPlugins) {
      if (plugin.chunkers) {
        chunkers.push(...plugin.chunkers);
      }
    }
    return chunkers;
  }

  /**
   * Get all registered URL schemes
   */
  getSchemes(): Map<string, LoadedPlugin> {
    const schemes = new Map<string, LoadedPlugin>();
    for (const loaded of this.loadedPlugins) {
      const pluginSchemes = loaded.plugin.schemes || loaded.manifest.ragclaw?.schemes || [];
      for (const scheme of pluginSchemes) {
        schemes.set(scheme, loaded);
      }
    }
    return schemes;
  }

  /**
   * Get all registered file extensions
   */
  getExtensions(): Map<string, LoadedPlugin> {
    const extensions = new Map<string, LoadedPlugin>();
    for (const loaded of this.loadedPlugins) {
      const pluginExts = loaded.plugin.extensions || loaded.manifest.ragclaw?.extensions || [];
      for (const ext of pluginExts) {
        extensions.set(ext.toLowerCase(), loaded);
      }
    }
    return extensions;
  }

  /**
   * Attempt to expand a source via loaded plugins.
   * Returns the expanded sources if a plugin handled it, or `null` if no
   * plugin provides expansion for this source.
   */
  async expandSource(source: Source): Promise<Source[] | null> {
    for (const { plugin } of this.loadedPlugins) {
      if (plugin.expand) {
        const expanded = await plugin.expand(source);
        if (expanded) return expanded;
      }
    }
    return null;
  }

  /**
   * Cleanup all plugins
   */
  async dispose(): Promise<void> {
    for (const { plugin } of this.loadedPlugins) {
      if (plugin.dispose) {
        await plugin.dispose();
      }
    }
    this.loadedPlugins = [];
    this.initialized = false;
  }

  // --- Private methods ---

  private async discoverNpmPlugins(): Promise<PluginManifest[]> {
    const manifests: PluginManifest[] = [];

    try {
      // Get npm global prefix
      const prefix = execSync("npm prefix -g", { encoding: "utf-8" }).trim();
      const globalNodeModules = join(prefix, "lib", "node_modules");

      if (!existsSync(globalNodeModules)) {
        return manifests;
      }

      const entries = await readdir(globalNodeModules, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        if (!entry.name.startsWith("ragclaw-plugin-")) continue;

        const pluginPath = join(globalNodeModules, entry.name);
        const manifest = await this.loadManifest(pluginPath, "npm");
        if (manifest) {
          manifests.push(manifest);
        }
      }
    } catch {
      // npm not available or error scanning
    }

    return manifests;
  }

  private async discoverLocalPlugins(): Promise<PluginManifest[]> {
    const dir = this.options.localPluginsDir;
    if (!dir) return [];
    return this.discoverPluginsInDir(dir, "local");
  }

  private async discoverPluginsInDir(
    dir: string,
    source: "local" | "workspace"
  ): Promise<PluginManifest[]> {
    const manifests: PluginManifest[] = [];

    if (!existsSync(dir)) {
      return manifests;
    }

    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name.startsWith(".")) continue;

      const pluginPath = join(dir, entry.name);
      const manifest = await this.loadManifest(pluginPath, source);
      if (manifest) {
        manifests.push(manifest);
      }
    }

    return manifests;
  }

  private async loadManifest(
    pluginPath: string,
    source: "npm" | "local" | "workspace"
  ): Promise<PluginManifest | null> {
    const pkgPath = join(pluginPath, "package.json");

    if (!existsSync(pkgPath)) {
      // Try index.js directly for simple plugins
      const indexPath = join(pluginPath, "index.js");
      if (existsSync(indexPath)) {
        return {
          name: dirname(pluginPath).split("/").pop() || "unknown",
          version: "0.0.0",
          main: "index.js",
          path: pluginPath,
          source,
        };
      }
      return null;
    }

    try {
      const pkgJson = JSON.parse(await readFile(pkgPath, "utf-8"));

      return {
        name: pkgJson.name,
        version: pkgJson.version,
        main: pkgJson.main || "index.js",
        path: pluginPath,
        source,
        ragclaw: pkgJson.ragclaw,
      };
    } catch {
      return null;
    }
  }
}

// Singleton for convenience
let defaultLoader: PluginLoader | null = null;

export function getPluginLoader(options?: PluginLoaderOptions): PluginLoader {
  if (!defaultLoader) {
    defaultLoader = new PluginLoader(options);
  }
  return defaultLoader;
}
