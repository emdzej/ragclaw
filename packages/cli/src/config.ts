/**
 * Re-export all config from @emdzej/ragclaw-core.
 *
 * CLI command files import from "../config.js" — this barrel keeps those
 * imports working while the real implementation lives in core.
 */
export {
  getConfig,
  resetConfigCache,
  getDbPath,
  getPluginsDir,
  getDataDir,
  ensureDataDir,
  getConfigFilePath,
  getEnabledPlugins,
  setEnabledPlugins,
  setConfigValue,
  SETTABLE_KEYS,
  RAGCLAW_DIR,
  DEFAULT_EXTRACTOR_LIMITS,
  type RagclawConfig,
  type ConfigKeyMeta,
  type ExtractorLimits,
} from "@emdzej/ragclaw-core";
