/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import type { EmbedderPlugin } from "../types.js";
import { HuggingFaceEmbedder } from "./index.js";
import { resolvePreset, EMBEDDER_PRESETS, DEFAULT_PRESET } from "./presets.js";

// ─────────────────────────────────────────────────────────────────────────────
// Embedder Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * High-level config used to resolve which embedder to create.
 *
 * Resolution order:
 * 1. `pluginEmbedder` → returned as-is (plugin takes full control)
 * 2. `alias`          → look up in `EMBEDDER_PRESETS` → new HuggingFaceEmbedder
 * 3. `model`          → new HuggingFaceEmbedder with auto-detect dims
 * 4. nothing          → default to `nomic` preset
 */
export interface EmbedderResolvedConfig {
  /** Preset alias ("nomic", "bge", "mxbai", "minilm"). */
  alias?: string;

  /** Arbitrary HuggingFace model ID (e.g. "some-org/some-model"). */
  model?: string;

  /** Override dimensions (skips auto-detect for unknown models). */
  dimensions?: number;

  /** Plugin-provided embedder (takes highest priority). */
  pluginEmbedder?: EmbedderPlugin;

  /** Progress callback for model downloads. */
  onProgress?: (progress: number) => void;

  /** Custom cache directory for model files. */
  cacheDir?: string;
}

/**
 * Create an `EmbedderPlugin` from a resolved config.
 *
 * This is the single entry point that the rest of ragclaw uses to obtain
 * an embedder.  It handles preset look-up, plugin delegation, and
 * fallback to the default model.
 *
 * @example
 * ```ts
 * // Use default (nomic)
 * const embedder = createEmbedder({});
 *
 * // Use a preset
 * const embedder = createEmbedder({ alias: "minilm" });
 *
 * // Use an arbitrary HuggingFace model
 * const embedder = createEmbedder({ model: "some-org/some-model" });
 *
 * // Use a plugin-provided embedder
 * const embedder = createEmbedder({ pluginEmbedder: myPlugin.embedder });
 * ```
 */
export function createEmbedder(config: EmbedderResolvedConfig = {}): EmbedderPlugin {
  // 1. Plugin embedder takes highest priority
  if (config.pluginEmbedder) {
    return config.pluginEmbedder;
  }

  // 2. Preset alias
  if (config.alias) {
    const preset = resolvePreset(config.alias);
    if (!preset) {
      throw new Error(
        `Unknown embedder preset "${config.alias}". ` +
          `Known presets: ${Object.keys(EMBEDDER_PRESETS).join(", ")}`,
      );
    }

    return new HuggingFaceEmbedder({
      ...preset,
      // Allow overriding dimensions even for presets
      dim: config.dimensions ?? preset.dim,
      onProgress: config.onProgress,
      cacheDir: config.cacheDir,
    });
  }

  // 3. Arbitrary model ID
  if (config.model) {
    // Check if the model matches any preset's model ID — use that preset if so
    for (const preset of Object.values(EMBEDDER_PRESETS)) {
      if (preset.model === config.model) {
        return new HuggingFaceEmbedder({
          ...preset,
          dim: config.dimensions ?? preset.dim,
          onProgress: config.onProgress,
          cacheDir: config.cacheDir,
        });
      }
    }

    // Not a known model — create with auto-detect
    return new HuggingFaceEmbedder({
      model: config.model,
      dim: config.dimensions ?? 0, // 0 = auto-detect
      onProgress: config.onProgress,
      cacheDir: config.cacheDir,
    });
  }

  // 4. Default to nomic preset
  const defaultPreset = EMBEDDER_PRESETS[DEFAULT_PRESET]!;
  return new HuggingFaceEmbedder({
    ...defaultPreset,
    onProgress: config.onProgress,
    cacheDir: config.cacheDir,
  });
}