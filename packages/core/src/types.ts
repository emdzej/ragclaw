/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Source Types
// ─────────────────────────────────────────────────────────────────────────────

export type SourceType = "file" | "url" | "text";
export type ContentType = "markdown" | "text" | "pdf" | "docx" | "web" | "code";

export interface FileSource {
  type: "file";
  path: string;
  name?: string;
}

export interface UrlSource {
  type: "url";
  url: string;
  name?: string;
}

export interface TextSource {
  type: "text";
  content: string;
  name?: string;
}

export type Source = FileSource | UrlSource | TextSource;

export interface SourceRecord {
  id: string;
  path: string;
  type: SourceType;
  contentHash: string;
  mtime?: number;
  indexedAt: number;
  metadata?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Extractor Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ExtractedContent {
  text: string;
  metadata: Record<string, unknown>;
  sourceType: ContentType;
  mimeType?: string;
}

export interface Extractor {
  canHandle(source: Source): boolean;
  extract(source: Source): Promise<ExtractedContent>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Chunker Types
// ─────────────────────────────────────────────────────────────────────────────

export interface Chunk {
  id: string;
  text: string;
  sourceId: string;
  sourcePath: string;
  startLine?: number;
  endLine?: number;
  metadata: {
    type: "paragraph" | "section" | "function" | "class" | "method" | "block";
    heading?: string;
    name?: string;
    language?: string;
    [key: string]: unknown;
  };
}

export interface ChunkRecord extends Chunk {
  embedding?: Float32Array;
  createdAt: number;
}

export interface Chunker {
  /** Unique name used in config overrides and --chunker CLI flag. */
  readonly name: string;
  /** Human-readable description shown by `ragclaw chunkers list`. */
  readonly description: string;
  /**
   * Content types or MIME types this chunker handles.
   * Use `["*"]` to indicate a universal fallback (handles any content).
   */
  readonly handles: string[];

  canHandle(content: ExtractedContent): boolean;
  chunk(content: ExtractedContent, sourceId: string, sourcePath: string): Promise<Chunk[]>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Search Types
// ─────────────────────────────────────────────────────────────────────────────

export type SearchMode = "vector" | "keyword" | "hybrid";

export interface SearchQuery {
  text: string;
  embedding?: Float32Array;
  limit?: number;
  mode?: SearchMode;
  filter?: {
    sourceType?: ContentType;
    sourcePath?: string;
  };
}

export interface SearchResult {
  chunk: ChunkRecord;
  score: number;
  scoreVector?: number;
  scoreKeyword?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Store Types
// ─────────────────────────────────────────────────────────────────────────────

export interface StoreStats {
  sources: number;
  chunks: number;
  sizeBytes: number;
  lastUpdated?: number;
}

export interface StoreConfig {
  vectorWeight?: number; // Default: 0.7
  keywordWeight?: number; // Default: 0.3
}

// ─────────────────────────────────────────────────────────────────────────────
// Embedder Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Embedder plugin interface.
 *
 * Any object that satisfies this contract can be used to generate embeddings —
 * whether it's a local HuggingFace model, an Ollama server, an OpenAI API
 * call, or a plugin-provided implementation.
 */
export interface EmbedderPlugin {
  /** Human-readable name (e.g. "nomic", "ollama", "openai"). */
  readonly name: string;

  /**
   * Output vector dimensions (e.g. 768, 1024).
   *
   * For HuggingFace models with auto-detection this starts as `0` and is
   * set after the first embedding call.  Consumers should call `init()`
   * or `embed()` at least once before reading this value.
   */
  dimensions: number;

  /** Embed a document text. */
  embed(text: string): Promise<Float32Array>;

  /** Embed a search query (may use a different prefix than documents). */
  embedQuery(text: string): Promise<Float32Array>;

  /** Batch-embed multiple document texts. */
  embedBatch(texts: string[]): Promise<Float32Array[]>;

  /** Optional one-time setup (model download, warm-up, connection check). */
  init?(): Promise<void>;

  /** Optional teardown (release model memory, close connections). */
  dispose?(): Promise<void>;
}

/**
 * Preset definition for a known embedding model.
 *
 * Presets bundle all model-specific knobs (prefixes, pooling, dimensions)
 * so the user only has to pick an alias like "bge" or "minilm".
 */
export interface EmbedderPreset {
  /** HuggingFace model ID (e.g. "BAAI/bge-m3"). */
  model: string;
  /** Output dimensions (e.g. 768, 1024, 384). */
  dim: number;
  /** Prefix prepended to document texts (e.g. "search_document: "). */
  docPrefix?: string;
  /** Prefix prepended to query texts (e.g. "search_query: "). */
  queryPrefix?: string;
  /** Approximate RAM required in bytes (for system checks). */
  estimatedRAM?: number;
  /** Pooling strategy (default: "mean"). */
  pooling?: "mean" | "none" | "cls" | "first_token" | "eos" | "last_token";
  /** Whether to L2-normalize output vectors (default: true). */
  normalize?: boolean;
}

/** Legacy config interface kept for backward compatibility. */
export interface EmbedderConfig {
  model?: string; // Default: nomic-embed-text-v1.5
  cacheDir?: string; // Default: ~/.cache/ragclaw/models
  onProgress?: (progress: number) => void;
}
