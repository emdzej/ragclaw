/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import type { EmbedderPlugin } from "@emdzej/ragclaw-core";

// ─────────────────────────────────────────────────────────────────────────────
// Known model dimensions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Known output dimensions for popular Ollama embedding models.
 * Used to avoid an extra API call when the model is recognised.
 * Falls back to 0 (auto-detect on first embed) for unlisted models.
 */
export const OLLAMA_MODEL_DIMS: Readonly<Record<string, number>> = {
  "nomic-embed-text": 768,
  "mxbai-embed-large": 1024,
  "all-minilm": 384,
  "snowflake-arctic-embed": 1024,
  "bge-m3": 1024,
  "bge-large": 1024,
  "bge-base": 768,
} as const;

/** Default Ollama base URL. */
export const DEFAULT_BASE_URL = "http://localhost:11434";

/** Default embedding model. */
export const DEFAULT_MODEL = "nomic-embed-text";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

export interface OllamaEmbedderConfig {
  /** Ollama model name (e.g. "nomic-embed-text", "mxbai-embed-large"). */
  model?: string;
  /** Ollama API base URL. Default: "http://localhost:11434". */
  baseUrl?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Response shapes
// ─────────────────────────────────────────────────────────────────────────────

interface OllamaEmbedResponse {
  embedding: number[];
}

// ─────────────────────────────────────────────────────────────────────────────
// OllamaEmbedder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Embedder that delegates to a locally running Ollama instance.
 *
 * Implements the `EmbedderPlugin` interface so it can be used as a drop-in
 * replacement for the built-in HuggingFace embedder.
 *
 * Ollama does not support native batch embedding — `embedBatch` falls back
 * to sequential calls.  For high-throughput indexing prefer the built-in
 * HuggingFace embedder which does true batched inference.
 *
 * @example
 * ```ts
 * const embedder = new OllamaEmbedder({ model: "nomic-embed-text" });
 * await embedder.init(); // verifies the model is available
 * const vec = await embedder.embed("hello world");
 * ```
 */
export class OllamaEmbedder implements EmbedderPlugin {
  readonly name = "ollama";

  dimensions: number;

  private readonly model: string;
  private readonly baseUrl: string;
  private dimensionsDetected: boolean;

  constructor(config: OllamaEmbedderConfig = {}) {
    this.model = config.model ?? DEFAULT_MODEL;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");

    const known = OLLAMA_MODEL_DIMS[this.model];
    this.dimensions = known ?? 0;
    this.dimensionsDetected = known !== undefined;
  }

  // ─── EmbedderPlugin interface ─────────────────────────────────────────────

  /**
   * Verify that the Ollama server is reachable and the model responds.
   * Sets `dimensions` as a side effect on the first call.
   */
  async init(): Promise<void> {
    // A real embed call is the most reliable health-check — it confirms
    // the server is running AND the model is available.
    await this.embed("init");
  }

  /** No persistent resources to clean up. */
  async dispose(): Promise<void> {
    // nothing
  }

  /** Embed a single document text. */
  async embed(text: string): Promise<Float32Array> {
    const vec = await this.callOllama(text);
    if (!this.dimensionsDetected) {
      this.dimensions = vec.length;
      this.dimensionsDetected = true;
    }
    return vec;
  }

  /**
   * Embed a search query.
   *
   * Ollama models don't use separate query/document prefixes, so this is
   * identical to `embed()`.  The distinction is kept in the interface for
   * compatibility with models that do use asymmetric prefixes.
   */
  async embedQuery(text: string): Promise<Float32Array> {
    return this.embed(text);
  }

  /**
   * Embed multiple texts.
   *
   * Ollama's `/api/embeddings` endpoint is single-text only, so we run
   * sequential requests.  Results preserve input order.
   */
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const results: Float32Array[] = [];
    for (const text of texts) {
      results.push(await this.embed(text));
    }
    return results;
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  private async callOllama(text: string): Promise<Float32Array> {
    const url = `${this.baseUrl}/api/embeddings`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, prompt: text }),
      });
    } catch (err: unknown) {
      throw new Error(
        `OllamaEmbedder: failed to connect to Ollama at ${this.baseUrl} — ` +
          `is Ollama running? (${String(err)})`
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `OllamaEmbedder: Ollama returned HTTP ${response.status} for model "${this.model}". ` +
          `Run 'ollama pull ${this.model}' to download it. Response: ${body}`
      );
    }

    const data = (await response.json()) as OllamaEmbedResponse;

    if (!Array.isArray(data.embedding) || data.embedding.length === 0) {
      throw new Error(
        `OllamaEmbedder: unexpected response shape from Ollama — ` +
          `"embedding" field missing or empty.`
      );
    }

    return new Float32Array(data.embedding);
  }
}
