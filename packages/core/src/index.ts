// Types
export * from "./types.js";

// Store
export { Store } from "./store/index.js";

// Embedder
export { Embedder } from "./embedder/index.js";

// Chunkers
export { SemanticChunker } from "./chunkers/semantic.js";
export { CodeChunker } from "./chunkers/code.js";

// Extractors
export { MarkdownExtractor } from "./extractors/markdown.js";
export { TextExtractor } from "./extractors/text.js";
export { PdfExtractor } from "./extractors/pdf.js";
export { DocxExtractor } from "./extractors/docx.js";
export { WebExtractor } from "./extractors/web.js";
export { CodeExtractor } from "./extractors/code.js";
export { ImageExtractor, ocrFromBuffer } from "./extractors/image.js";

// Plugin system
export type {
  RagClawPlugin,
  PluginManifest,
  LoadedPlugin,
  PluginLoaderOptions,
  PluginConfigKey,
} from "./plugin.js";

// Config
export {
  getConfig,
  resetConfigCache,
  getDbPath,
  sanitizeDbName,
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
} from "./config.js";

// Utils
export { cosineSimilarity } from "./utils/math.js";

// Security guards
export { isPathAllowed, isUrlAllowed } from "./guards.js";
