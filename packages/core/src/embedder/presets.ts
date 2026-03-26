/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import type { EmbedderPreset } from "../types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Built-in Embedder Presets
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Registry of known embedding models.
 *
 * Each preset bundles all model-specific knobs (prefixes, pooling, dimensions,
 * estimated RAM) so the user only has to pick an alias like `"nomic"` or
 * `"minilm"` in their config file.
 */
export const EMBEDDER_PRESETS: Record<string, EmbedderPreset> = {
  nomic: {
    model: "nomic-ai/nomic-embed-text-v1.5",
    dim: 768,
    docPrefix: "search_document: ",
    queryPrefix: "search_query: ",
    pooling: "mean",
    normalize: true,
    estimatedRAM: 600 * 1024 * 1024, // ~600 MB
  },

  bge: {
    model: "BAAI/bge-m3",
    dim: 1024,
    pooling: "mean",
    normalize: true,
    // Use the quantized (q8) variant to avoid the external-data-file split.
    // fp32 ONNX for bge-m3 is split into model.onnx (stub) + model.onnx_data
    // (2.3 GB), which @huggingface/transformers cannot load.  "q8" maps to
    // model_quantized.onnx — a self-contained 570 MB file.
    dtype: "q8",
    estimatedRAM: 600 * 1024 * 1024, // ~600 MB (quantized)
  },

  mxbai: {
    model: "mixedbread-ai/mxbai-embed-large-v1",
    dim: 1024,
    queryPrefix: "Represent this sentence: ",
    pooling: "mean",
    normalize: true,
    estimatedRAM: 1.4 * 1024 * 1024 * 1024, // ~1.4 GB
  },

  minilm: {
    model: "sentence-transformers/all-MiniLM-L6-v2",
    dim: 384,
    pooling: "mean",
    normalize: true,
    estimatedRAM: 90 * 1024 * 1024, // ~90 MB
  },
};

/** The default preset alias when no embedder is configured. */
export const DEFAULT_PRESET = "nomic";

/**
 * Look up a preset by alias (case-insensitive).
 *
 * @returns The matching preset, or `undefined` if the alias is not known.
 */
export function resolvePreset(alias: string): EmbedderPreset | undefined {
  return EMBEDDER_PRESETS[alias.toLowerCase()];
}

/**
 * Check whether an alias maps to a known built-in preset.
 */
export function isKnownPreset(alias: string): boolean {
  return alias.toLowerCase() in EMBEDDER_PRESETS;
}

/**
 * Return a list of all known preset aliases.
 */
export function listPresets(): string[] {
  return Object.keys(EMBEDDER_PRESETS);
}
