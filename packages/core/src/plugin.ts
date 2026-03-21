/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import type { Extractor, Chunker, Source, EmbedderPlugin } from "./types.js";

/**
 * Describes a single config key that a plugin accepts.
 * Used by `ragclaw config list` to document plugin-specific settings.
 */
export interface PluginConfigKey {
  /** The key name (without the `plugin.<name>.` prefix). */
  key: string;
  /** Human-readable description. */
  description: string;
  /** Value type hint. */
  type: "string" | "number" | "boolean";
  /** Default value (for documentation). */
  defaultValue?: unknown;
}

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

  /** Optional embedder provided by this plugin. */
  embedder?: EmbedderPlugin;
  
  /** URL schemes this plugin handles (e.g., "notion", "slack") */
  schemes?: string[];
  
  /** File extensions this plugin handles (e.g., ".epub", ".xlsx") */
  extensions?: string[];
  
  /** Optional initialization function */
  init?: (config?: Record<string, unknown>) => Promise<void>;
  
  /** Optional cleanup function */
  dispose?: () => Promise<void>;

  /**
   * Optional source expansion.  When a plugin handles a compound source
   * (e.g. an Obsidian vault URL), `expand()` turns it into individual
   * sources (one per note) so the caller can index them independently.
   * Return `null`/`undefined` to signal that no expansion is needed and
   * the source should be processed as-is.
   */
  expand?: (source: Source) => Promise<Source[] | null | undefined>;

  /** Optional schema describing config keys the plugin accepts.
   *  Shown by `ragclaw config list` for discoverability. */
  configSchema?: PluginConfigKey[];
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

  /** Explicit list of plugin names allowed to load. If undefined, no plugins load. */
  enabledPlugins?: string[];

  /** Whether to scan global npm packages for plugins (default: false) */
  scanGlobalNpm?: boolean;
}