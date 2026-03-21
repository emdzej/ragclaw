/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

/**
 * Re-export all config from @emdzej/ragclaw-core.
 *
 * CLI command files import from "../config.js" — this barrel keeps those
 * imports working while the real implementation lives in core.
 */
export {
  type ConfigKeyMeta,
  DEFAULT_EXTRACTOR_LIMITS,
  type EmbedderConfigBlock,
  type ExtractorLimits,
  ensureDataDir,
  getConfig,
  getConfigFilePath,
  getDataDir,
  getDbPath,
  getEnabledPlugins,
  getPluginsDir,
  RAGCLAW_DIR,
  type RagclawConfig,
  resetConfigCache,
  SETTABLE_KEYS,
  sanitizeDbName,
  setConfigValue,
  setEnabledPlugins,
} from "@emdzej/ragclaw-core";
