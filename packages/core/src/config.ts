import { homedir, platform } from "os";
import { join, resolve } from "path";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "fs";

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

  // Check for legacy path (backwards compatibility)
  if (existsSync(LEGACY_DIR)) {
    configDir = LEGACY_DIR;
    dataDir = LEGACY_DIR;
    pluginsDir = join(LEGACY_DIR, "plugins");
  }

  // Try to load config file
  const configFile = join(configDir, "config.yaml");
  if (existsSync(configFile)) {
    try {
      const content = readFileSync(configFile, "utf-8");
      const parsed = parseSimpleYaml(content);
      if (parsed.dataDir) dataDir = expandHome(parsed.dataDir);
      if (parsed.pluginsDir) pluginsDir = expandHome(parsed.pluginsDir);
      if (parsed.plugins) {
        enabledPlugins = parsed.plugins.split(",").map((s: string) => s.trim()).filter(Boolean);
      }
      if (parsed.scanGlobalNpm) {
        scanGlobalNpm = parsed.scanGlobalNpm === "true";
      }
      if (parsed.allowedPaths) {
        allowedPaths = parsed.allowedPaths
          .split(",")
          .map((s: string) => s.trim())
          .filter(Boolean)
          .map((p: string) => resolve(expandHome(p)));
      }
      if (parsed.allowUrls) {
        allowUrls = parsed.allowUrls !== "false";
      }
      if (parsed.blockPrivateUrls) {
        blockPrivateUrls = parsed.blockPrivateUrls !== "false";
      }
      if (parsed.maxDepth) {
        const n = parseInt(parsed.maxDepth, 10);
        if (Number.isFinite(n) && n > 0) maxDepth = n;
      }
      if (parsed.maxFiles) {
        const n = parseInt(parsed.maxFiles, 10);
        if (Number.isFinite(n) && n > 0) maxFiles = n;
      }
    } catch {
      // Ignore config parse errors
    }
  }

  // Environment variables override config file
  if (process.env.RAGCLAW_CONFIG_DIR) {
    configDir = process.env.RAGCLAW_CONFIG_DIR;
  }
  if (process.env.RAGCLAW_DATA_DIR) {
    dataDir = process.env.RAGCLAW_DATA_DIR;
  }
  if (process.env.RAGCLAW_PLUGINS_DIR) {
    pluginsDir = process.env.RAGCLAW_PLUGINS_DIR;
  }
  if (process.env.RAGCLAW_ALLOWED_PATHS) {
    allowedPaths = process.env.RAGCLAW_ALLOWED_PATHS
      .split(",")
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

  let config: RagclawConfig = {
    configDir, dataDir, pluginsDir, enabledPlugins, scanGlobalNpm,
    allowedPaths, allowUrls, blockPrivateUrls, maxDepth, maxFiles,
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
 * Get database path for a knowledge base
 */
export function getDbPath(name: string): string {
  const { dataDir } = getConfig();
  return join(dataDir, `${name}.sqlite`);
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
 * `configKey` — the field name on `RagclawConfig`
 */
export interface ConfigKeyMeta {
  yamlKey: string;
  envVar?: string;
  type: "string" | "string[]" | "boolean" | "number";
  configKey: keyof RagclawConfig;
  description: string;
}

export const SETTABLE_KEYS: ConfigKeyMeta[] = [
  { yamlKey: "dataDir",          envVar: "RAGCLAW_DATA_DIR",            type: "string",   configKey: "dataDir",          description: "Data directory for knowledge bases" },
  { yamlKey: "pluginsDir",       envVar: "RAGCLAW_PLUGINS_DIR",         type: "string",   configKey: "pluginsDir",       description: "Local plugins directory" },
  { yamlKey: "plugins",          envVar: undefined,                     type: "string[]",  configKey: "enabledPlugins",   description: "Enabled plugin names (comma-separated)" },
  { yamlKey: "scanGlobalNpm",    envVar: undefined,                     type: "boolean",   configKey: "scanGlobalNpm",    description: "Scan global npm packages for plugins" },
  { yamlKey: "allowedPaths",     envVar: "RAGCLAW_ALLOWED_PATHS",       type: "string[]",  configKey: "allowedPaths",     description: "Allowed filesystem paths for indexing (comma-separated)" },
  { yamlKey: "allowUrls",        envVar: "RAGCLAW_ALLOW_URLS",          type: "boolean",   configKey: "allowUrls",        description: "Allow URL sources" },
  { yamlKey: "blockPrivateUrls", envVar: "RAGCLAW_BLOCK_PRIVATE_URLS",  type: "boolean",   configKey: "blockPrivateUrls", description: "Block fetches to private/reserved IPs" },
  { yamlKey: "maxDepth",         envVar: "RAGCLAW_MAX_DEPTH",           type: "number",    configKey: "maxDepth",         description: "Max directory recursion depth" },
  { yamlKey: "maxFiles",         envVar: "RAGCLAW_MAX_FILES",           type: "number",    configKey: "maxFiles",         description: "Max files per directory source" },
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
    throw new Error(`Unknown config key: "${yamlKey}". Valid keys: ${SETTABLE_KEYS.map((k) => k.yamlKey).join(", ")}`);
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
 * Simple YAML parser for config (no dependencies)
 */
function parseSimpleYaml(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = trimmed.match(/^(\w+):\s*(.+)$/);
    if (match) {
      result[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }

  return result;
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
