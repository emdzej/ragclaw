/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import type { EmbedderPlugin, RagClawPlugin } from "@emdzej/ragclaw-core";
import { DEFAULT_BASE_URL, DEFAULT_MODEL, OllamaEmbedder } from "./embedder.js";

export type { OllamaEmbedderConfig } from "./embedder.js";
export { DEFAULT_BASE_URL, DEFAULT_MODEL, OLLAMA_MODEL_DIMS, OllamaEmbedder } from "./embedder.js";

// ─────────────────────────────────────────────────────────────────────────────
// Plugin
// ─────────────────────────────────────────────────────────────────────────────

/**
 * RagClaw plugin that provides local embeddings via a running Ollama instance.
 *
 * Register it in `ragclaw.yaml`:
 * ```yaml
 * plugins:
 *   - ragclaw-plugin-ollama
 *
 * plugin.ragclaw-plugin-ollama:
 *   model: mxbai-embed-large          # default: nomic-embed-text
 *   baseUrl: http://localhost:11434   # default
 * ```
 *
 * Or use directly:
 * ```ts
 * import ollamaPlugin from "ragclaw-plugin-ollama";
 * const plugin = ollamaPlugin;
 * await plugin.init({ model: "mxbai-embed-large" });
 * ```
 */
const ollamaPlugin: RagClawPlugin & { embedder: EmbedderPlugin } = {
  name: "ragclaw-plugin-ollama",
  version: "0.5.0",

  // Initialised with defaults; replaced in init() if config is supplied.
  embedder: new OllamaEmbedder(),

  async init(config?: Record<string, unknown>): Promise<void> {
    const model = typeof config?.model === "string" ? config.model : DEFAULT_MODEL;
    const baseUrl = typeof config?.baseUrl === "string" ? config.baseUrl : DEFAULT_BASE_URL;

    // Replace the embedder with one built from the resolved config.
    ollamaPlugin.embedder = new OllamaEmbedder({ model, baseUrl });
  },

  async dispose(): Promise<void> {
    await ollamaPlugin.embedder.dispose?.();
  },

  configSchema: [
    {
      key: "model",
      description: `Ollama model to use for embeddings (default: "${DEFAULT_MODEL}")`,
      type: "string",
      defaultValue: DEFAULT_MODEL,
    },
    {
      key: "baseUrl",
      description: `Ollama API base URL (default: "${DEFAULT_BASE_URL}")`,
      type: "string",
      defaultValue: DEFAULT_BASE_URL,
    },
  ],
};

export default ollamaPlugin;
