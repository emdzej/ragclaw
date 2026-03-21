/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { describe, it, expect } from "vitest";
import {
  EMBEDDER_PRESETS,
  DEFAULT_PRESET,
  resolvePreset,
  isKnownPreset,
  listPresets,
} from "./presets.js";

describe("EMBEDDER_PRESETS", () => {
  it("contains the four built-in presets", () => {
    expect(Object.keys(EMBEDDER_PRESETS)).toEqual(
      expect.arrayContaining(["nomic", "bge", "mxbai", "minilm"]),
    );
    expect(Object.keys(EMBEDDER_PRESETS)).toHaveLength(4);
  });

  it("each preset has required fields", () => {
    for (const [alias, preset] of Object.entries(EMBEDDER_PRESETS)) {
      expect(preset.model, `${alias}.model`).toBeTruthy();
      expect(preset.dim, `${alias}.dim`).toBeGreaterThan(0);
      expect(preset.pooling, `${alias}.pooling`).toBeTruthy();
      expect(typeof preset.normalize, `${alias}.normalize`).toBe("boolean");
    }
  });

  it("nomic preset has correct values", () => {
    const nomic = EMBEDDER_PRESETS["nomic"];
    expect(nomic.model).toBe("nomic-ai/nomic-embed-text-v1.5");
    expect(nomic.dim).toBe(768);
    expect(nomic.docPrefix).toBe("search_document: ");
    expect(nomic.queryPrefix).toBe("search_query: ");
  });

  it("minilm preset has smallest dimensions", () => {
    expect(EMBEDDER_PRESETS["minilm"].dim).toBe(384);
  });

  it("bge and mxbai presets have 1024 dimensions", () => {
    expect(EMBEDDER_PRESETS["bge"].dim).toBe(1024);
    expect(EMBEDDER_PRESETS["mxbai"].dim).toBe(1024);
  });

  it("mxbai has query prefix but no doc prefix", () => {
    const mxbai = EMBEDDER_PRESETS["mxbai"];
    expect(mxbai.queryPrefix).toBe("Represent this sentence: ");
    expect(mxbai.docPrefix).toBeUndefined();
  });

  it("each preset has estimatedRAM", () => {
    for (const [alias, preset] of Object.entries(EMBEDDER_PRESETS)) {
      expect(preset.estimatedRAM, `${alias}.estimatedRAM`).toBeGreaterThan(0);
    }
  });
});

describe("DEFAULT_PRESET", () => {
  it("is 'nomic'", () => {
    expect(DEFAULT_PRESET).toBe("nomic");
  });

  it("exists in the presets registry", () => {
    expect(EMBEDDER_PRESETS[DEFAULT_PRESET]).toBeDefined();
  });
});

describe("resolvePreset()", () => {
  it("returns preset for known alias", () => {
    const preset = resolvePreset("nomic");
    expect(preset).toBeDefined();
    expect(preset!.model).toBe("nomic-ai/nomic-embed-text-v1.5");
  });

  it("is case-insensitive", () => {
    expect(resolvePreset("NOMIC")).toBeDefined();
    expect(resolvePreset("Nomic")).toBeDefined();
    expect(resolvePreset("BGE")).toBeDefined();
  });

  it("returns undefined for unknown alias", () => {
    expect(resolvePreset("unknown-model")).toBeUndefined();
    expect(resolvePreset("")).toBeUndefined();
  });
});

describe("isKnownPreset()", () => {
  it("returns true for known aliases", () => {
    expect(isKnownPreset("nomic")).toBe(true);
    expect(isKnownPreset("bge")).toBe(true);
    expect(isKnownPreset("mxbai")).toBe(true);
    expect(isKnownPreset("minilm")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isKnownPreset("NOMIC")).toBe(true);
    expect(isKnownPreset("MiniLM")).toBe(true);
  });

  it("returns false for unknown aliases", () => {
    expect(isKnownPreset("openai")).toBe(false);
    expect(isKnownPreset("")).toBe(false);
    expect(isKnownPreset("ollama")).toBe(false);
  });
});

describe("listPresets()", () => {
  it("returns all preset aliases", () => {
    const presets = listPresets();
    expect(presets).toEqual(expect.arrayContaining(["nomic", "bge", "mxbai", "minilm"]));
    expect(presets).toHaveLength(4);
  });

  it("returns strings", () => {
    for (const alias of listPresets()) {
      expect(typeof alias).toBe("string");
    }
  });
});