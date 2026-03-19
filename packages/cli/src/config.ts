import { homedir, platform } from "os";
import { join } from "path";
import { existsSync, readFileSync, mkdirSync } from "fs";

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
}

let cachedConfig: RagclawConfig | null = null;

/**
 * Load configuration with fallback priority:
 * 1. Environment variables (RAGCLAW_CONFIG_DIR, RAGCLAW_DATA_DIR, RAGCLAW_PLUGINS_DIR)
 * 2. Config file (~/.config/ragclaw/config.yaml)
 * 3. Legacy path (~/.openclaw/ragclaw/) if exists
 * 4. XDG defaults
 */
export function getConfig(): RagclawConfig {
  if (cachedConfig) return cachedConfig;

  // Start with XDG defaults
  let configDir = getDefaultConfigDir();
  let dataDir = getDefaultDataDir();
  let pluginsDir = join(dataDir, "plugins");

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
    } catch {
      // Ignore config parse errors
    }
  }

  // Environment variables override everything
  if (process.env.RAGCLAW_CONFIG_DIR) {
    configDir = process.env.RAGCLAW_CONFIG_DIR;
  }
  if (process.env.RAGCLAW_DATA_DIR) {
    dataDir = process.env.RAGCLAW_DATA_DIR;
  }
  if (process.env.RAGCLAW_PLUGINS_DIR) {
    pluginsDir = process.env.RAGCLAW_PLUGINS_DIR;
  }

  cachedConfig = { configDir, dataDir, pluginsDir };
  return cachedConfig;
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
