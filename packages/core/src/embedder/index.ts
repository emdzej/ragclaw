/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { env, pipeline, type Tensor } from "@huggingface/transformers";
import type { EmbedderConfig, EmbedderPlugin, EmbedderPreset } from "../types.js";
import { DEFAULT_PRESET, EMBEDDER_PRESETS } from "./presets.js";

// Configure default cache directory
env.cacheDir = join(homedir(), ".cache", "ragclaw", "models");

/**
 * Return the directory where RagClaw caches HuggingFace model files.
 *
 * Respects any override that was applied via `env.cacheDir` (e.g. from a
 * custom `cacheDir` config option).
 */
export function getModelCacheDir(): string {
  return env.cacheDir as string;
}

/**
 * Check whether a model's ONNX files are already present in the local cache.
 *
 * A model is considered cached when its directory exists under
 * `<cacheDir>/<org>/<repo>/` (for `"org/repo"` model IDs) or
 * `<cacheDir>/<model>/` (for single-segment IDs).
 *
 * This mirrors the layout that `@huggingface/transformers` uses when it
 * fetches and stores model files.
 *
 * @param modelId  HuggingFace model ID, e.g. `"nomic-ai/nomic-embed-text-v1.5"`
 * @param cacheDir Override the cache directory (default: `getModelCacheDir()`)
 */
export function isModelCached(modelId: string, cacheDir?: string): boolean {
  const base = cacheDir ?? getModelCacheDir();
  // HF model IDs use "org/repo" — map to <cacheDir>/org/repo/
  const modelPath = join(base, ...modelId.split("/"));
  return existsSync(modelPath);
}

type FeatureExtractionPipeline = Awaited<ReturnType<typeof pipeline<"feature-extraction">>>;

/**
 * Configuration for constructing a HuggingFaceEmbedder.
 *
 * Accepts a full `EmbedderPreset` (from the preset registry or user config)
 * plus optional extras like progress callbacks and cache dir.
 */
export interface HuggingFaceEmbedderConfig extends Partial<EmbedderPreset> {
  /** Progress callback for model download. */
  onProgress?: (progress: number) => void;
  /** Custom model cache directory. */
  cacheDir?: string;
}

/**
 * HuggingFace Transformers-based embedder.
 *
 * Wraps `@huggingface/transformers` pipeline to generate embeddings from
 * any supported model.  Configurable via `EmbedderPreset` — prefixes,
 * pooling, normalization, and dimensions are all driven by config.
 *
 * For unknown models (no preset, no explicit `dim`), dimensions are
 * auto-detected on the first embedding call via a test embed.
 */
export class HuggingFaceEmbedder implements EmbedderPlugin {
  readonly name: string;
  private _dimensions: number;
  private readonly modelId: string;
  private readonly docPrefix: string;
  private readonly queryPrefix: string;
  private readonly pooling: "mean" | "none" | "cls" | "first_token" | "eos" | "last_token";
  private readonly normalize: boolean;
  private pipe: FeatureExtractionPipeline | null = null;
  private onProgress?: (progress: number) => void;
  private dimensionsDetected = false;

  constructor(config: HuggingFaceEmbedderConfig = {}) {
    // Resolve model-specific fields from a preset if only a model was given,
    // otherwise use defaults from the nomic preset.
    const defaultPreset = EMBEDDER_PRESETS[DEFAULT_PRESET];
    if (!defaultPreset) {
      throw new Error(`Built-in preset "${DEFAULT_PRESET}" is missing from EMBEDDER_PRESETS`);
    }

    this.modelId = config.model ?? defaultPreset.model;
    this._dimensions = config.dim ?? 0; // 0 = auto-detect
    this.docPrefix = config.docPrefix ?? "";
    this.queryPrefix = config.queryPrefix ?? "";
    this.pooling = config.pooling ?? "mean";
    this.normalize = config.normalize ?? true;
    this.onProgress = config.onProgress;

    // Derive a short name from the model ID (last path segment, lower-cased)
    this.name = this.modelId.split("/").pop()?.toLowerCase() ?? "huggingface";

    if (config.cacheDir) {
      env.cacheDir = config.cacheDir;
    }

    // If dimensions were provided, mark as detected so we skip auto-detect
    if (this._dimensions > 0) {
      this.dimensionsDetected = true;
    }
  }

  get dimensions(): number {
    return this._dimensions;
  }

  set dimensions(value: number) {
    this._dimensions = value;
  }

  // ─── Pipeline management ────────────────────────────────────────────────

  private async getPipeline(): Promise<FeatureExtractionPipeline> {
    if (!this.pipe) {
      this.pipe = await pipeline("feature-extraction", this.modelId, {
        progress_callback: this.onProgress
          ? (progress: { status: string; progress?: number }) => {
              if (progress.progress !== undefined) {
                this.onProgress?.(progress.progress / 100);
              }
            }
          : undefined,
      });

      // Auto-detect dimensions if not known yet
      if (!this.dimensionsDetected) {
        await this.detectDimensions();
      }
    }
    return this.pipe;
  }

  /**
   * Run a single test embed to discover the model's output dimensions.
   * Called once after the pipeline is first created, only when `dim` was
   * not provided in config.
   */
  private async detectDimensions(): Promise<void> {
    if (!this.pipe) return;

    const output = (await this.pipe("test", {
      pooling: this.pooling,
      normalize: this.normalize,
    })) as Tensor;

    const data = output.data as Float32Array;
    this._dimensions = data.length;
    this.dimensionsDetected = true;
  }

  // ─── EmbedderPlugin interface ───────────────────────────────────────────

  async init(): Promise<void> {
    await this.getPipeline();
  }

  async dispose(): Promise<void> {
    this.pipe = null;
  }

  /**
   * Generate embedding for a single document text.
   */
  async embed(text: string): Promise<Float32Array> {
    const pipe = await this.getPipeline();
    const prefixedText = this.docPrefix ? `${this.docPrefix}${text}` : text;

    const output = (await pipe(prefixedText, {
      pooling: this.pooling,
      normalize: this.normalize,
    })) as Tensor;

    return new Float32Array(output.data as Float32Array);
  }

  /**
   * Generate embedding for a query (may use a different prefix).
   */
  async embedQuery(text: string): Promise<Float32Array> {
    const pipe = await this.getPipeline();
    const prefixedText = this.queryPrefix ? `${this.queryPrefix}${text}` : text;

    const output = (await pipe(prefixedText, {
      pooling: this.pooling,
      normalize: this.normalize,
    })) as Tensor;

    return new Float32Array(output.data as Float32Array);
  }

  /**
   * Generate embeddings for multiple document texts (batched for efficiency).
   *
   * Passes each batch of up to 32 texts to the pipeline as an array so
   * the model runs true batched inference (single forward pass per batch)
   * instead of one-by-one.
   */
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const pipe = await this.getPipeline();
    const dims = this._dimensions;

    const results: Float32Array[] = [];

    // Process in batches to avoid memory issues
    const batchSize = 32;
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const prefixed = this.docPrefix ? batch.map((t) => `${this.docPrefix}${t}`) : batch;

      // Pass the full batch array — the pipeline tokenises and runs
      // a single forward pass, returning a Tensor of shape [N, dims].
      const output = (await pipe(prefixed, {
        pooling: this.pooling,
        normalize: this.normalize,
      })) as Tensor;

      // Slice the flat backing buffer into per-text embeddings.
      const data = output.data as Float32Array;
      for (let j = 0; j < batch.length; j++) {
        const start = j * dims;
        results.push(new Float32Array(data.slice(start, start + dims)));
      }
    }

    return results;
  }
}

// ─── Backward compatibility ────────────────────────────────────────────────

/**
 * @deprecated Use `HuggingFaceEmbedder` instead.
 *
 * Creates a `HuggingFaceEmbedder` configured from a legacy `EmbedderConfig`.
 * This preserves the original constructor signature (`new Embedder({ model?, cacheDir?, onProgress? })`).
 */
export class Embedder extends HuggingFaceEmbedder {
  constructor(config: EmbedderConfig = {}) {
    // Map legacy config to the new HuggingFaceEmbedder config.
    // If they specified a model that matches a known preset, use the preset's settings.
    // Otherwise, just pass model through for auto-detect.
    const defaultPreset = EMBEDDER_PRESETS[DEFAULT_PRESET];
    if (!defaultPreset) {
      throw new Error(`Built-in preset "${DEFAULT_PRESET}" is missing from EMBEDDER_PRESETS`);
    }
    const isDefaultModel = !config.model || config.model === defaultPreset.model;

    if (isDefaultModel) {
      // Use the full nomic preset
      super({
        ...defaultPreset,
        cacheDir: config.cacheDir,
        onProgress: config.onProgress,
      });
    } else {
      // Unknown model — let auto-detect handle dimensions
      super({
        model: config.model,
        cacheDir: config.cacheDir,
        onProgress: config.onProgress,
      });
    }
  }
}
