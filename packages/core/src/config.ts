import { homedir, platform } from "os";
import { join } from "path";
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

  let config: RagclawConfig = { configDir, dataDir, pluginsDir, enabledPlugins, scanGlobalNpm };

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
 * Persist the enabled plugins list to config.yaml.
 * Preserves existing non-plugins config lines.
 */
export function setEnabledPlugins(plugins: string[]): void {
  const config = getConfig();
  const configFile = getConfigFilePath();

  // Ensure config directory exists
  const dir = config.configDir;
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Read existing config (if any) and replace/add the plugins line
  let lines: string[] = [];
  if (existsSync(configFile)) {
    lines = readFileSync(configFile, "utf-8").split("\n");
  }

  const pluginsLine = plugins.length > 0
    ? `plugins: ${plugins.join(", ")}`
    : "plugins:";

  const idx = lines.findIndex((l) => l.trimStart().startsWith("plugins:"));
  if (idx !== -1) {
    lines[idx] = pluginsLine;
  } else {
    // Add after last non-empty line (or at end)
    lines.push(pluginsLine);
  }

  writeFileSync(configFile, lines.join("\n"), "utf-8");

  // Bust the cached config so next getConfig() re-reads
  resetConfigCache();
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
