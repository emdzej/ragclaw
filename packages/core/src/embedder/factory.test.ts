/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { EmbedderPlugin } from "../types.js";

// ── Mock @huggingface/transformers ──────────────────────────────────────────
const mockPipe: Mock = vi.fn();

vi.mock("@huggingface/transformers", () => ({
  pipeline: vi.fn(async () => mockPipe),
  env: { cacheDir: "" },
  Tensor: class {},
}));

// Must import AFTER vi.mock
const { createEmbedder } = await import("./factory.js");
const { HuggingFaceEmbedder } = await import("./index.js");
const { EMBEDDER_PRESETS } = await import("./presets.js");

// ── Helpers ─────────────────────────────────────────────────────────────────

function fakeTensor(count: number, dims = 768): { data: Float32Array } {
  return { data: new Float32Array(count * dims) };
}

/** Create a minimal mock EmbedderPlugin. */
function mockEmbedderPlugin(overrides: Partial<EmbedderPlugin> = {}): EmbedderPlugin {
  return {
    name: "mock-plugin",
    dimensions: 512,
    embed: vi.fn(async () => new Float32Array(512)),
    embedQuery: vi.fn(async () => new Float32Array(512)),
    embedBatch: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array(512))),
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("createEmbedder()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPipe.mockResolvedValue(fakeTensor(1, 768));
  });

  // ── Resolution order ──────────────────────────────────────────────────

  describe("resolution order", () => {
    it("returns plugin embedder as-is when provided (highest priority)", () => {
      const plugin = mockEmbedderPlugin();
      const embedder = createEmbedder({ pluginEmbedder: plugin });

      expect(embedder).toBe(plugin);
      expect(embedder.name).toBe("mock-plugin");
      expect(embedder.dimensions).toBe(512);
    });

    it("plugin embedder takes priority over alias", () => {
      const plugin = mockEmbedderPlugin();
      const embedder = createEmbedder({
        pluginEmbedder: plugin,
        alias: "nomic",
      });

      expect(embedder).toBe(plugin);
    });

    it("resolves preset alias to HuggingFaceEmbedder", () => {
      const embedder = createEmbedder({ alias: "nomic" });

      expect(embedder).toBeInstanceOf(HuggingFaceEmbedder);
      expect(embedder.dimensions).toBe(768);
    });

    it("resolves model ID to HuggingFaceEmbedder", () => {
      const embedder = createEmbedder({ model: "some-org/some-model" });

      expect(embedder).toBeInstanceOf(HuggingFaceEmbedder);
      // Unknown model starts with 0 dims (auto-detect)
      expect(embedder.dimensions).toBe(0);
    });

    it("defaults to nomic preset when no config given", () => {
      const embedder = createEmbedder({});

      expect(embedder).toBeInstanceOf(HuggingFaceEmbedder);
      expect(embedder.dimensions).toBe(768);
    });

    it("defaults to nomic when called with no arguments", () => {
      const embedder = createEmbedder();

      expect(embedder).toBeInstanceOf(HuggingFaceEmbedder);
      expect(embedder.dimensions).toBe(768);
    });
  });

  // ── Preset aliases ────────────────────────────────────────────────────

  describe("preset aliases", () => {
    it("resolves all known presets", () => {
      for (const alias of Object.keys(EMBEDDER_PRESETS)) {
        const embedder = createEmbedder({ alias });
        expect(embedder).toBeInstanceOf(HuggingFaceEmbedder);
        expect(embedder.dimensions).toBe(EMBEDDER_PRESETS[alias].dim);
      }
    });

    it("throws for unknown alias", () => {
      expect(() => createEmbedder({ alias: "doesnotexist" })).toThrow(
        /Unknown embedder preset "doesnotexist"/
      );
    });

    it("error message lists known presets", () => {
      expect(() => createEmbedder({ alias: "bad" })).toThrow(/nomic/);
    });

    it("allows dimension override on preset", () => {
      const embedder = createEmbedder({ alias: "nomic", dimensions: 512 });
      expect(embedder.dimensions).toBe(512);
    });
  });

  // ── Model ID resolution ───────────────────────────────────────────────

  describe("model ID resolution", () => {
    it("uses preset settings when model matches a known preset model", () => {
      const embedder = createEmbedder({
        model: "nomic-ai/nomic-embed-text-v1.5",
      });

      expect(embedder).toBeInstanceOf(HuggingFaceEmbedder);
      // Should get nomic's preset dimensions since model matches
      expect(embedder.dimensions).toBe(768);
    });

    it("uses auto-detect for unknown model without explicit dims", () => {
      const embedder = createEmbedder({ model: "unknown/model" });
      expect(embedder.dimensions).toBe(0);
    });

    it("uses explicit dimensions when provided for unknown model", () => {
      const embedder = createEmbedder({
        model: "unknown/model",
        dimensions: 1024,
      });
      expect(embedder.dimensions).toBe(1024);
    });
  });

  // ── Config pass-through ───────────────────────────────────────────────

  describe("config pass-through", () => {
    it("passes onProgress to HuggingFaceEmbedder", async () => {
      const { pipeline: mockPipelineFactory } = await import("@huggingface/transformers");
      const onProgress = vi.fn();
      const embedder = createEmbedder({ onProgress });
      await embedder.embed?.("test");

      const factoryCall = (mockPipelineFactory as Mock).mock.calls[0];
      expect(factoryCall[2]).toHaveProperty("progress_callback");
    });

    it("does not pass onProgress to plugin embedder", () => {
      const plugin = mockEmbedderPlugin();
      const onProgress = vi.fn();
      const embedder = createEmbedder({ pluginEmbedder: plugin, onProgress });

      // Plugin is returned as-is, onProgress is not applied
      expect(embedder).toBe(plugin);
    });
  });
});
