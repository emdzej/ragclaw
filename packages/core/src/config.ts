/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";

/**
 * XDG Base Directory paths
 * https://specifications.freedesktop.org/basedir-spec/basedir-spec-latest.html
 */
function getXdgConfigHome(): string {
  return process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
}

function getXdgDataHome(): string {
  return process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
}

/**
 * Platform-aware default paths
 */
function getDefaultConfigDir(): string {
  if (platform() === "darwin") {
    // macOS: ~/Library/Application Support/ragclaw or XDG
    const macPath = join(homedir(), "Library", "Application Support", "ragclaw");
    if (existsSync(macPath)) return macPath;
  }
  return join(getXdgConfigHome(), "ragclaw");
}

function getDefaultDataDir(): string {
  if (platform() === "darwin") {
    const macPath = join(homedir(), "Library", "Application Support", "ragclaw");
    if (existsSync(macPath)) return macPath;
  }
  return join(getXdgDataHome(), "ragclaw");
}

/**
 * Legacy path for backwards compatibility
 */
const LEGACY_DIR = join(homedir(), ".openclaw", "ragclaw");

export interface ExtractorLimits {
  /** AbortController timeout for HTTP fetches in ms (default: 30 000). */
  fetchTimeoutMs: number;
  /** Max HTTP response body in bytes before aborting (default: 50 MB). */
  maxResponseSizeBytes: number;
  /** Max pages to process per PDF (default: 200). */
  maxPdfPages: number;
  /** Timeout per OCR invocation in ms (default: 60 000). */
  ocrTimeoutMs: number;
}

export const DEFAULT_EXTRACTOR_LIMITS: Readonly<ExtractorLimits> = {
  fetchTimeoutMs: 30_000,
  maxResponseSizeBytes: 50 * 1024 * 1024,
  maxPdfPages: 200,
  ocrTimeoutMs: 60_000,
};

/**
 * Embedder configuration block (for nested YAML config).
 * Used when `embedder:` in config.yaml is an object rather than a string alias.
 */
export interface EmbedderConfigBlock {
  /** Plugin name (for plugin-provided embedders, e.g. "ollama"). */
  plugin?: string;
  /** HuggingFace model ID (e.g. "BAAI/bge-m3"). */
  model?: string;
  /** Override output dimensions (optional, auto-detected if omitted). */
  dimensions?: number;
  /** API base URL (for Ollama, OpenAI-compatible, etc.). */
  baseUrl?: string;
}

export interface RagclawConfig {
  configDir: string;
  dataDir: string;
  pluginsDir: string;
  enabledPlugins: string[];
  scanGlobalNpm: boolean;

  /** Allowed filesystem paths for indexing.  Empty array = no restriction (CLI)
   *  or cwd-only (MCP — enforced at the call site in TASK-03d). */
  allowedPaths: string[];

  /** Whether URL sources are permitted (default: true). */
  allowUrls: boolean;

  /** Block fetches to private / reserved IP ranges (default: true). */
  blockPrivateUrls: boolean;

  /** Maximum directory recursion depth (default: 10). */
  maxDepth: number;

  /** Maximum number of files collected from a single directory source (default: 1000). */
  maxFiles: number;

  /** Whether the CLI should enforce path/URL guards (default: false).
   *  When true the CLI behaves like MCP — `isPathAllowed()`, `isUrlAllowed()`,
   *  `maxDepth` and `maxFiles` are checked.  Useful when the CLI is invoked
   *  autonomously rather than by a human user.
   *  MCP always enforces guards regardless of this setting. */
  enforceGuards: boolean;

  /** Resource limits for built-in extractors (web, PDF, image/OCR). */
  extractorLimits: ExtractorLimits;

  /** Per-plugin configuration parsed from `plugin.<name>.<key>` entries in
   *  config.yaml.  Keyed by plugin name, value is a flat key→value map. */
  pluginConfig: Record<string, Record<string, unknown>>;

  /**
   * Embedder to use for indexing.
   *  - `string`  — preset alias or HuggingFace model ID (e.g. "bge", "nomic", "BAAI/bge-m3")
   *  - `object`  — full config block with optional plugin/model/dimensions/baseUrl
   *  - `undefined` — use the default (nomic)
   *
   * Config file examples:
   * ```yaml
   * embedder: bge          # alias shorthand
   * embedder:
   *   model: BAAI/bge-m3   # HF model
   * embedder:
   *   plugin: ollama
   *   model: nomic-embed-text
   *   baseUrl: http://localhost:11434
   * ```
   */
  embedder?: string | EmbedderConfigBlock;
}

let cachedConfig: RagclawConfig | null = null;

/**
 * Load configuration with fallback priority:
 * 1. Overrides parameter (CLI flags)
 * 2. Environment variables (RAGCLAW_CONFIG_DIR, RAGCLAW_DATA_DIR, RAGCLAW_PLUGINS_DIR)
 * 3. Config file (~/.config/ragclaw/config.yaml)
 * 4. Legacy path (~/.openclaw/ragclaw/) if exists
 * 5. XDG defaults
 *
 * When `overrides` is provided the cached config is bypassed so callers with
 * different overrides don't pollute each other.
 */
export function getConfig(overrides?: Partial<RagclawConfig>): RagclawConfig {
  if (!overrides && cachedConfig) return cachedConfig;

  // Start with XDG defaults
  let configDir = getDefaultConfigDir();
  let dataDir = getDefaultDataDir();
  let pluginsDir = join(dataDir, "plugins");
  let enabledPlugins: string[] = [];
  let scanGlobalNpm = false;
  let allowedPaths: string[] = [];
  let allowUrls = true;
  let blockPrivateUrls = true;
  let maxDepth = 10;
  let maxFiles = 1000;
  let enforceGuards = false;
  const extractorLimits: ExtractorLimits = { ...DEFAULT_EXTRACTOR_LIMITS };
  const pluginConfig: Record<string, Record<string, unknown>> = {};
  let embedder: string | EmbedderConfigBlock | undefined;

  // Check for legacy path (backwards compatibility)
  if (existsSync(LEGACY_DIR)) {
    configDir = LEGACY_DIR;
    dataDir = LEGACY_DIR;
    pluginsDir = join(LEGACY_DIR, "plugins");
  }

  // Apply RAGCLAW_CONFIG_DIR early so we read the right config file
  if (process.env.RAGCLAW_CONFIG_DIR) {
    configDir = process.env.RAGCLAW_CONFIG_DIR;
  }

  // Try to load config file
  const configFile = join(configDir, "config.yaml");
  if (existsSync(configFile)) {
    try {
      const content = readFileSync(configFile, "utf-8");
      const parsed = parseConfigYaml(content);

      if (typeof parsed.dataDir === "string") dataDir = expandHome(parsed.dataDir);
      if (typeof parsed.pluginsDir === "string") pluginsDir = expandHome(parsed.pluginsDir);

      // plugins: list or comma-separated string
      if (Array.isArray(parsed.plugins)) {
        enabledPlugins = (parsed.plugins as unknown[]).map(String).filter(Boolean);
      } else if (typeof parsed.plugins === "string") {
        enabledPlugins = parsed.plugins
          .split(",")
          .map((s: string) => s.trim())
          .filter(Boolean);
      }

      if (typeof parsed.scanGlobalNpm === "boolean") {
        scanGlobalNpm = parsed.scanGlobalNpm;
      } else if (parsed.scanGlobalNpm === "true") {
        scanGlobalNpm = true;
      }

      // allowedPaths: YAML list or comma-separated string
      if (Array.isArray(parsed.allowedPaths)) {
        allowedPaths = (parsed.allowedPaths as unknown[])
          .map(String)
          .filter(Boolean)
          .map((p: string) => resolve(expandHome(p)));
      } else if (typeof parsed.allowedPaths === "string") {
        allowedPaths = parsed.allowedPaths
          .split(",")
          .map((s: string) => s.trim())
          .filter(Boolean)
          .map((p: string) => resolve(expandHome(p)));
      }

      if (typeof parsed.allowUrls === "boolean") {
        allowUrls = parsed.allowUrls;
      } else if (typeof parsed.allowUrls === "string") {
        allowUrls = parsed.allowUrls !== "false";
      }

      if (typeof parsed.blockPrivateUrls === "boolean") {
        blockPrivateUrls = parsed.blockPrivateUrls;
      } else if (typeof parsed.blockPrivateUrls === "string") {
        blockPrivateUrls = parsed.blockPrivateUrls !== "false";
      }

      if (typeof parsed.maxDepth === "number") {
        if (Number.isFinite(parsed.maxDepth) && parsed.maxDepth > 0) maxDepth = parsed.maxDepth;
      } else if (typeof parsed.maxDepth === "string") {
        const n = parseInt(parsed.maxDepth, 10);
        if (Number.isFinite(n) && n > 0) maxDepth = n;
      }

      if (typeof parsed.maxFiles === "number") {
        if (Number.isFinite(parsed.maxFiles) && parsed.maxFiles > 0) maxFiles = parsed.maxFiles;
      } else if (typeof parsed.maxFiles === "string") {
        const n = parseInt(parsed.maxFiles, 10);
        if (Number.isFinite(n) && n > 0) maxFiles = n;
      }

      if (typeof parsed.enforceGuards === "boolean") {
        enforceGuards = parsed.enforceGuards;
      } else if (parsed.enforceGuards === "true") {
        enforceGuards = true;
      }

      // Parse extractor.* keys (flat dotted keys — legacy flat format still supported)
      for (const [key, val] of Object.entries(parsed)) {
        if (key.startsWith("extractor.")) {
          const limitsKey = key.slice("extractor.".length) as keyof ExtractorLimits;
          if (limitsKey in DEFAULT_EXTRACTOR_LIMITS) {
            const n = typeof val === "number" ? val : parseInt(String(val), 10);
            if (Number.isFinite(n) && n > 0) {
              (extractorLimits as unknown as Record<string, number>)[limitsKey] = n;
            }
          }
        }
      }

      // Parse nested extractor block (new format)
      if (
        parsed.extractor &&
        typeof parsed.extractor === "object" &&
        !Array.isArray(parsed.extractor)
      ) {
        for (const [key, val] of Object.entries(parsed.extractor as Record<string, unknown>)) {
          const limitsKey = key as keyof ExtractorLimits;
          if (limitsKey in DEFAULT_EXTRACTOR_LIMITS) {
            const n = typeof val === "number" ? val : parseInt(String(val), 10);
            if (Number.isFinite(n) && n > 0) {
              (extractorLimits as unknown as Record<string, number>)[limitsKey] = n;
            }
          }
        }
      }

      // Parse plugin.<name>.<key> entries (flat dotted keys — legacy)
      for (const [key, val] of Object.entries(parsed)) {
        if (key.startsWith("plugin.")) {
          const rest = key.slice("plugin.".length);
          const dotIdx = rest.indexOf(".");
          if (dotIdx > 0) {
            const pluginName = rest.slice(0, dotIdx);
            const pluginKey = rest.slice(dotIdx + 1);
            if (!pluginConfig[pluginName]) pluginConfig[pluginName] = {};
            pluginConfig[pluginName][pluginKey] = val;
          }
        }
      }

      // Parse nested plugin block (new format)
      if (parsed.plugin && typeof parsed.plugin === "object" && !Array.isArray(parsed.plugin)) {
        for (const [pluginName, pluginVals] of Object.entries(
          parsed.plugin as Record<string, unknown>
        )) {
          if (pluginVals && typeof pluginVals === "object" && !Array.isArray(pluginVals)) {
            pluginConfig[pluginName] = {
              ...(pluginConfig[pluginName] ?? {}),
              ...(pluginVals as Record<string, unknown>),
            };
          }
        }
      }

      // Parse embedder: alias string or config block
      if (typeof parsed.embedder === "string") {
        embedder = parsed.embedder;
      } else if (
        parsed.embedder &&
        typeof parsed.embedder === "object" &&
        !Array.isArray(parsed.embedder)
      ) {
        const eb = parsed.embedder as Record<string, unknown>;
        embedder = {
          plugin: typeof eb.plugin === "string" ? eb.plugin : undefined,
          model: typeof eb.model === "string" ? eb.model : undefined,
          dimensions: typeof eb.dimensions === "number" ? eb.dimensions : undefined,
          baseUrl: typeof eb.baseUrl === "string" ? eb.baseUrl : undefined,
        };
      }
    } catch {
      // Ignore config parse errors
    }
  }

  // Environment variables override config file
  // Note: RAGCLAW_CONFIG_DIR was already applied above (before reading the file).
  if (process.env.RAGCLAW_DATA_DIR) {
    dataDir = process.env.RAGCLAW_DATA_DIR;
  }
  if (process.env.RAGCLAW_PLUGINS_DIR) {
    pluginsDir = process.env.RAGCLAW_PLUGINS_DIR;
  }
  if (process.env.RAGCLAW_ALLOWED_PATHS) {
    allowedPaths = process.env.RAGCLAW_ALLOWED_PATHS.split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((p) => resolve(expandHome(p)));
  }
  if (process.env.RAGCLAW_ALLOW_URLS !== undefined) {
    allowUrls = process.env.RAGCLAW_ALLOW_URLS !== "false";
  }
  if (process.env.RAGCLAW_BLOCK_PRIVATE_URLS !== undefined) {
    blockPrivateUrls = process.env.RAGCLAW_BLOCK_PRIVATE_URLS !== "false";
  }
  if (process.env.RAGCLAW_MAX_DEPTH) {
    const n = parseInt(process.env.RAGCLAW_MAX_DEPTH, 10);
    if (Number.isFinite(n) && n > 0) maxDepth = n;
  }
  if (process.env.RAGCLAW_MAX_FILES) {
    const n = parseInt(process.env.RAGCLAW_MAX_FILES, 10);
    if (Number.isFinite(n) && n > 0) maxFiles = n;
  }
  if (process.env.RAGCLAW_ENFORCE_GUARDS !== undefined) {
    enforceGuards = process.env.RAGCLAW_ENFORCE_GUARDS === "true";
  }
  if (process.env.RAGCLAW_FETCH_TIMEOUT_MS) {
    const n = parseInt(process.env.RAGCLAW_FETCH_TIMEOUT_MS, 10);
    if (Number.isFinite(n) && n > 0) extractorLimits.fetchTimeoutMs = n;
  }
  if (process.env.RAGCLAW_MAX_RESPONSE_SIZE_BYTES) {
    const n = parseInt(process.env.RAGCLAW_MAX_RESPONSE_SIZE_BYTES, 10);
    if (Number.isFinite(n) && n > 0) extractorLimits.maxResponseSizeBytes = n;
  }
  if (process.env.RAGCLAW_MAX_PDF_PAGES) {
    const n = parseInt(process.env.RAGCLAW_MAX_PDF_PAGES, 10);
    if (Number.isFinite(n) && n > 0) extractorLimits.maxPdfPages = n;
  }
  if (process.env.RAGCLAW_OCR_TIMEOUT_MS) {
    const n = parseInt(process.env.RAGCLAW_OCR_TIMEOUT_MS, 10);
    if (Number.isFinite(n) && n > 0) extractorLimits.ocrTimeoutMs = n;
  }
  // RAGCLAW_EMBEDDER accepts alias string only (nested config requires the file)
  if (process.env.RAGCLAW_EMBEDDER) {
    embedder = process.env.RAGCLAW_EMBEDDER;
  }

  let config: RagclawConfig = {
    configDir,
    dataDir,
    pluginsDir,
    enabledPlugins,
    scanGlobalNpm,
    allowedPaths,
    allowUrls,
    blockPrivateUrls,
    maxDepth,
    maxFiles,
    enforceGuards,
    extractorLimits,
    pluginConfig,
    embedder,
  };

  // CLI-flag overrides (highest priority)
  if (overrides) {
    config = { ...config, ...overrides };
  }

  // Only cache when there are no overrides (the "default" config)
  if (!overrides) {
    cachedConfig = config;
  }

  return config;
}

/**
 * Reset the cached config.  Exported for internal use by setEnabledPlugins()
 * and tests.
 */
export function resetConfigCache(): void {
  cachedConfig = null;
}

/**
 * Safe character set for knowledge base names: letters, digits, hyphens,
 * underscores, 1–64 characters.
 */
const SAFE_DB_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Validate and return a safe knowledge base name.
 * Rejects path separators, `..`, empty strings, and any character outside
 * the `[a-zA-Z0-9_-]` set.  Max length 64.
 *
 * @throws {Error} if the name is invalid
 */
export function sanitizeDbName(name: string): string {
  if (!SAFE_DB_NAME.test(name)) {
    throw new Error(
      `Invalid knowledge base name: "${name}". ` +
        `Names may contain only letters, digits, hyphens, and underscores (max 64 chars).`
    );
  }
  return name;
}

/**
 * Get database path for a knowledge base.
 *
 * The name is validated via `sanitizeDbName()` and the resolved path is
 * checked for containment within `dataDir` as defence in depth.
 */
export function getDbPath(name: string): string {
  const safeName = sanitizeDbName(name);
  const { dataDir } = getConfig();
  const dbPath = resolve(dataDir, `${safeName}.sqlite`);
  const resolvedDataDir = resolve(dataDir);
  if (!dbPath.startsWith(`${resolvedDataDir}/`) && dbPath !== resolvedDataDir) {
    throw new Error(`Knowledge base path escapes data directory: ${dbPath}`);
  }
  return dbPath;
}

/**
 * Get plugins directory
 */
export function getPluginsDir(): string {
  return getConfig().pluginsDir;
}

/**
 * Get data directory (for backwards compatibility)
 */
export function getDataDir(): string {
  return getConfig().dataDir;
}

/**
 * Ensure data directory exists
 */
export function ensureDataDir(): void {
  const { dataDir } = getConfig();
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
}

// Legacy export for backwards compatibility
export const RAGCLAW_DIR = getDataDir();

/**
 * Get the path to the config file
 */
export function getConfigFilePath(): string {
  const { configDir } = getConfig();
  return join(configDir, "config.yaml");
}

/**
 * Get list of enabled plugins from config
 */
export function getEnabledPlugins(): string[] {
  return getConfig().enabledPlugins;
}

/**
 * Metadata for config keys that can be viewed / persisted via `ragclaw config`.
 *
 * `yamlKey`  — the key used in config.yaml
 * `envVar`   — the corresponding environment variable (if any)
 * `type`     — how to serialise/deserialise the value
 * `configKey` — the field name on `RagclawConfig` (for flat keys) or undefined
 *               for nested extractor.* / plugin.* keys
 */
export interface ConfigKeyMeta {
  yamlKey: string;
  envVar?: string;
  type: "string" | "string[]" | "boolean" | "number";
  configKey: keyof RagclawConfig | undefined;
  description: string;
}

export const SETTABLE_KEYS: ConfigKeyMeta[] = [
  {
    yamlKey: "dataDir",
    envVar: "RAGCLAW_DATA_DIR",
    type: "string",
    configKey: "dataDir",
    description: "Data directory for knowledge bases",
  },
  {
    yamlKey: "pluginsDir",
    envVar: "RAGCLAW_PLUGINS_DIR",
    type: "string",
    configKey: "pluginsDir",
    description: "Local plugins directory",
  },
  {
    yamlKey: "plugins",
    envVar: undefined,
    type: "string[]",
    configKey: "enabledPlugins",
    description: "Enabled plugin names (comma-separated)",
  },
  {
    yamlKey: "scanGlobalNpm",
    envVar: undefined,
    type: "boolean",
    configKey: "scanGlobalNpm",
    description: "Scan global npm packages for plugins",
  },
  {
    yamlKey: "allowedPaths",
    envVar: "RAGCLAW_ALLOWED_PATHS",
    type: "string[]",
    configKey: "allowedPaths",
    description: "Allowed filesystem paths for indexing (comma-separated)",
  },
  {
    yamlKey: "allowUrls",
    envVar: "RAGCLAW_ALLOW_URLS",
    type: "boolean",
    configKey: "allowUrls",
    description: "Allow URL sources",
  },
  {
    yamlKey: "blockPrivateUrls",
    envVar: "RAGCLAW_BLOCK_PRIVATE_URLS",
    type: "boolean",
    configKey: "blockPrivateUrls",
    description: "Block fetches to private/reserved IPs",
  },
  {
    yamlKey: "maxDepth",
    envVar: "RAGCLAW_MAX_DEPTH",
    type: "number",
    configKey: "maxDepth",
    description: "Max directory recursion depth",
  },
  {
    yamlKey: "maxFiles",
    envVar: "RAGCLAW_MAX_FILES",
    type: "number",
    configKey: "maxFiles",
    description: "Max files per directory source",
  },
  {
    yamlKey: "enforceGuards",
    envVar: "RAGCLAW_ENFORCE_GUARDS",
    type: "boolean",
    configKey: "enforceGuards",
    description: "Enforce path/URL guards in CLI (for autonomous use)",
  },
  {
    yamlKey: "extractor.fetchTimeoutMs",
    envVar: "RAGCLAW_FETCH_TIMEOUT_MS",
    type: "number",
    configKey: undefined,
    description: "HTTP fetch timeout in ms (default: 30000)",
  },
  {
    yamlKey: "extractor.maxResponseSizeBytes",
    envVar: "RAGCLAW_MAX_RESPONSE_SIZE_BYTES",
    type: "number",
    configKey: undefined,
    description: "Max HTTP response body in bytes (default: 52428800)",
  },
  {
    yamlKey: "extractor.maxPdfPages",
    envVar: "RAGCLAW_MAX_PDF_PAGES",
    type: "number",
    configKey: undefined,
    description: "Max pages per PDF (default: 200)",
  },
  {
    yamlKey: "extractor.ocrTimeoutMs",
    envVar: "RAGCLAW_OCR_TIMEOUT_MS",
    type: "number",
    configKey: undefined,
    description: "OCR timeout in ms per invocation (default: 60000)",
  },
  {
    yamlKey: "embedder",
    envVar: "RAGCLAW_EMBEDDER",
    type: "string",
    configKey: "embedder",
    description: "Embedder preset alias or model (e.g. bge, nomic, BAAI/bge-m3)",
  },
];

/**
 * Persist a single config key to config.yaml.
 * The `rawValue` is the string as the user typed it (e.g. "true", "10",
 * "/a, /b").  It is written to the YAML file as-is.
 *
 * Throws if `yamlKey` is not in SETTABLE_KEYS.
 */
export function setConfigValue(yamlKey: string, rawValue: string): void {
  const meta = SETTABLE_KEYS.find((k) => k.yamlKey === yamlKey);
  if (!meta) {
    throw new Error(
      `Unknown config key: "${yamlKey}". Valid keys: ${SETTABLE_KEYS.map((k) => k.yamlKey).join(", ")}`
    );
  }

  const config = getConfig();
  const configFile = getConfigFilePath();

  // Ensure config directory exists
  if (!existsSync(config.configDir)) {
    mkdirSync(config.configDir, { recursive: true });
  }

  // Read existing lines
  let lines: string[] = [];
  if (existsSync(configFile)) {
    lines = readFileSync(configFile, "utf-8").split("\n");
  }

  const newLine = rawValue ? `${yamlKey}: ${rawValue}` : `${yamlKey}:`;

  const idx = lines.findIndex((l) => l.trimStart().startsWith(`${yamlKey}:`));
  if (idx !== -1) {
    lines[idx] = newLine;
  } else {
    lines.push(newLine);
  }

  writeFileSync(configFile, lines.join("\n"), "utf-8");
  resetConfigCache();
}

/**
 * Persist the enabled plugins list to config.yaml.
 * Preserves existing non-plugins config lines.
 */
export function setEnabledPlugins(plugins: string[]): void {
  setConfigValue("plugins", plugins.join(", "));
}

/**
 * Parse config.yaml using the `yaml` package.
 * Returns a plain object with string/number/boolean/object/array values.
 * Flat dotted keys (e.g. `extractor.fetchTimeoutMs`) from legacy files are
 * preserved as-is by the yaml parser and handled in getConfig().
 */
function parseConfigYaml(content: string): Record<string, unknown> {
  return (YAML.parse(content) as Record<string, unknown>) ?? {};
}

/**
 * Expand ~ to home directory
 */
function expandHome(path: string): string {
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  return path;
}
