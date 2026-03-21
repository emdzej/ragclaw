/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

export { CodeChunker } from "./chunkers/code.js";
// Chunkers
export { SemanticChunker } from "./chunkers/semantic.js";
// Config
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
} from "./config.js";
export { createEmbedder, type EmbedderResolvedConfig } from "./embedder/factory.js";
export type { HuggingFaceEmbedderConfig } from "./embedder/index.js";
// Embedder
export {
  Embedder,
  getModelCacheDir,
  HuggingFaceEmbedder,
  isModelCached,
} from "./embedder/index.js";
// Embedder presets & factory
export {
  DEFAULT_PRESET,
  EMBEDDER_PRESETS,
  isKnownPreset,
  listPresets,
  resolvePreset,
} from "./embedder/presets.js";
export { checkSystemRequirements, type SystemCheck } from "./embedder/system-check.js";
export { CodeExtractor } from "./extractors/code.js";
export { DocxExtractor } from "./extractors/docx.js";
export { ImageExtractor, ocrFromBuffer } from "./extractors/image.js";
// Extractors
export { MarkdownExtractor } from "./extractors/markdown.js";
export { PdfExtractor } from "./extractors/pdf.js";
export { TextExtractor } from "./extractors/text.js";
export { type CrawlOptions, WebExtractor } from "./extractors/web.js";
// Security guards
export { isPathAllowed, isUrlAllowed } from "./guards.js";
// Indexing service
export {
  type IndexCrawlOptions,
  type IndexCrawlPageResult,
  type IndexCrawlSummary,
  IndexingService,
  type IndexingServiceConfig,
  type IndexOutcome,
  type IndexSourceOptions,
  type ReindexOutcome,
  type ReindexSourceOptions,
} from "./indexing.js";
// Merge service
export {
  type ConflictResolution,
  type MergeDiff,
  type MergeOptions,
  MergeService,
  type MergeSourceResult,
  type MergeStrategy,
  type MergeSummary,
} from "./merge.js";
// Plugin system
export type {
  LoadedPlugin,
  PluginConfigKey,
  PluginLoaderOptions,
  PluginManifest,
  RagClawPlugin,
} from "./plugin.js";
// Store
export { Store } from "./store/index.js";
// Types
export * from "./types.js";
export { hashFile } from "./utils/hash.js";
// Utils
export { cosineSimilarity } from "./utils/math.js";
export { getAvailableMemory } from "./utils/memory.js";
