import { homedir } from "os";
import { join, dirname } from "path";
import { existsSync } from "fs";
import { readdir, readFile } from "fs/promises";
import { execSync } from "child_process";
import type {
  RagClawPlugin,
  PluginManifest,
  LoadedPlugin,
  PluginLoaderOptions,
  Extractor,
  Chunker,
} from "@emdzej/ragclaw-core";

const DEFAULT_LOCAL_PLUGINS_DIR = join(homedir(), ".openclaw", "ragclaw", "plugins");

export class PluginLoader {
  private options: PluginLoaderOptions;
  private loadedPlugins: LoadedPlugin[] = [];
  private initialized = false;

  constructor(options: PluginLoaderOptions = {}) {
    this.options = {
      localPluginsDir: DEFAULT_LOCAL_PLUGINS_DIR,
      ...options,
    };
  }

  /**
   * Discover all available plugins (npm global + local)
   */
  async discover(): Promise<PluginManifest[]> {
    const manifests: PluginManifest[] = [];

    // 1. Scan npm global packages for ragclaw-plugin-*
    const npmPlugins = await this.discoverNpmPlugins();
    manifests.push(...npmPlugins);

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
   * Load all discovered plugins
   */
  async loadAll(): Promise<LoadedPlugin[]> {
    if (this.initialized) {
      return this.loadedPlugins;
    }

    const manifests = await this.discover();
    
    for (const manifest of manifests) {
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
    const dir = this.options.localPluginsDir!;
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
