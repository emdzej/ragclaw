// ─────────────────────────────────────────────────────────────────────────────
// Source Types
// ─────────────────────────────────────────────────────────────────────────────

export type SourceType = "file" | "url" | "text";
export type ContentType = "markdown" | "text" | "pdf" | "docx" | "web" | "code";

export interface Source {
  type: SourceType;
  path?: string; // For files
  url?: string; // For URLs
  content?: string; // For raw text
  name?: string; // Display name
}

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

export interface EmbedderConfig {
  model?: string; // Default: nomic-embed-text-v1.5
  cacheDir?: string; // Default: ~/.cache/ragclaw/models
  onProgress?: (progress: number) => void;
}
