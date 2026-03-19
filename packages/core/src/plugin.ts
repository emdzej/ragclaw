import type { Extractor, Chunker } from "./types.js";

/**
 * RagClaw plugin interface.
 * Plugins can provide custom extractors and chunkers for new data sources.
 */
export interface RagClawPlugin {
  /** Plugin name (should match package name) */
  name: string;
  
  /** Plugin version (semver) */
  version: string;
  
  /** Custom extractors provided by this plugin */
  extractors?: Extractor[];
  
  /** Custom chunkers provided by this plugin */
  chunkers?: Chunker[];
  
  /** URL schemes this plugin handles (e.g., "notion", "slack") */
  schemes?: string[];
  
  /** File extensions this plugin handles (e.g., ".epub", ".xlsx") */
  extensions?: string[];
  
  /** Optional initialization function */
  init?: (config?: Record<string, unknown>) => Promise<void>;
  
  /** Optional cleanup function */
  dispose?: () => Promise<void>;
}

/**
 * Plugin manifest from package.json
 */
export interface PluginManifest {
  /** Package name */
  name: string;
  
  /** Package version */
  version: string;
  
  /** Main entry point */
  main: string;
  
  /** Full path to plugin directory */
  path: string;
  
  /** Plugin source: npm global, local, or workspace */
  source: "npm" | "local" | "workspace";
  
  /** RagClaw-specific metadata from package.json */
  ragclaw?: {
    schemes?: string[];
    extensions?: string[];
  };
}

/**
 * Loaded plugin with resolved extractors and chunkers
 */
export interface LoadedPlugin {
  manifest: PluginManifest;
  plugin: RagClawPlugin;
}

/**
 * Plugin loader options
 */
export interface PluginLoaderOptions {
  /** Path to local plugins directory (default: ~/.openclaw/ragclaw/plugins) */
  localPluginsDir?: string;
  
  /** Additional paths to scan for plugins */
  additionalPaths?: string[];
  
  /** Plugin configuration (passed to plugin.init()) */
  config?: Record<string, Record<string, unknown>>;
}
