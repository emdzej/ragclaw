import { pipeline, env, Tensor } from "@huggingface/transformers";
import { homedir } from "os";
import { join } from "path";
import type { EmbedderConfig } from "../types.js";

// Configure cache directory
env.cacheDir = join(homedir(), ".cache", "ragclaw", "models");

const DEFAULT_MODEL = "nomic-ai/nomic-embed-text-v1.5";
const DIMENSIONS = 768;

type FeatureExtractionPipeline = Awaited<ReturnType<typeof pipeline<"feature-extraction">>>;

export class Embedder {
  private model: string;
  private pipe: FeatureExtractionPipeline | null = null;
  private onProgress?: (progress: number) => void;

  constructor(config: EmbedderConfig = {}) {
    this.model = config.model ?? DEFAULT_MODEL;
    this.onProgress = config.onProgress;

    if (config.cacheDir) {
      env.cacheDir = config.cacheDir;
    }
  }

  get dimensions(): number {
    return DIMENSIONS;
  }

  private async getPipeline(): Promise<FeatureExtractionPipeline> {
    if (!this.pipe) {
      this.pipe = await pipeline("feature-extraction", this.model, {
        progress_callback: this.onProgress
          ? (progress: { status: string; progress?: number }) => {
              if (progress.progress !== undefined) {
                this.onProgress!(progress.progress / 100);
              }
            }
          : undefined,
      });
    }
    return this.pipe;
  }

  /**
   * Generate embedding for a single text.
   */
  async embed(text: string): Promise<Float32Array> {
    const pipe = await this.getPipeline();

    // Nomic model uses "search_document:" prefix for documents
    const prefixedText = `search_document: ${text}`;

    const output = await pipe(prefixedText, {
      pooling: "mean",
      normalize: true,
    }) as Tensor;

    return new Float32Array(output.data as Float32Array);
  }

  /**
   * Generate embeddings for a query (uses different prefix).
   */
  async embedQuery(text: string): Promise<Float32Array> {
    const pipe = await this.getPipeline();

    // Nomic model uses "search_query:" prefix for queries
    const prefixedText = `search_query: ${text}`;

    const output = await pipe(prefixedText, {
      pooling: "mean",
      normalize: true,
    }) as Tensor;

    return new Float32Array(output.data as Float32Array);
  }

  /**
   * Generate embeddings for multiple texts (batched for efficiency).
   */
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const pipe = await this.getPipeline();

    const results: Float32Array[] = [];

    // Process in batches to avoid memory issues
    const batchSize = 32;
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const prefixed = batch.map((t) => `search_document: ${t}`);

      for (const text of prefixed) {
        const output = await pipe(text, {
          pooling: "mean",
          normalize: true,
        }) as Tensor;
        results.push(new Float32Array(output.data as Float32Array));
      }
    }

    return results;
  }
}
