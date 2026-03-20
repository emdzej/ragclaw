import { describe, it, expect, vi, afterEach } from "vitest";
import os from "os";
import { checkSystemRequirements } from "./system-check.js";
import type { EmbedderPreset } from "../types.js";

const PRESET_600MB: EmbedderPreset = {
  model: "test/model-600mb",
  dim: 768,
  pooling: "mean",
  normalize: true,
  estimatedRAM: 600 * 1024 * 1024, // 600 MB
};

describe("checkSystemRequirements", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns canRun=true with no issues when free RAM is ≥2× estimate", () => {
    vi.spyOn(os, "freemem").mockReturnValue(1200 * 1024 * 1024); // 1200 MB
    const result = checkSystemRequirements(PRESET_600MB);
    expect(result.canRun).toBe(true);
    expect(result.warnings).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("returns a warning when free RAM is between 1.2× and 2× estimate", () => {
    vi.spyOn(os, "freemem").mockReturnValue(900 * 1024 * 1024); // 900 MB = 1.5×
    const result = checkSystemRequirements(PRESET_600MB);
    expect(result.canRun).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Low free RAM");
    expect(result.errors).toHaveLength(0);
  });

  it("returns a warning at exactly 1.2× estimate (boundary)", () => {
    vi.spyOn(os, "freemem").mockReturnValue(720 * 1024 * 1024); // exactly 1.2×
    const result = checkSystemRequirements(PRESET_600MB);
    // 720 >= 720 (1.2×) → not error; 720 < 1200 (2×) → warning
    expect(result.canRun).toBe(true);
    expect(result.warnings).toHaveLength(1);
  });

  it("returns an error when free RAM is below 1.2× estimate", () => {
    vi.spyOn(os, "freemem").mockReturnValue(500 * 1024 * 1024); // 500 MB < 720 MB
    const result = checkSystemRequirements(PRESET_600MB);
    expect(result.canRun).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Insufficient free RAM");
    expect(result.warnings).toHaveLength(0);
  });

  it("skips the check when preset has no estimatedRAM", () => {
    vi.spyOn(os, "freemem").mockReturnValue(10); // virtually no RAM
    const preset: EmbedderPreset = {
      model: "test/model-unknown-ram",
      dim: 512,
      pooling: "mean",
      normalize: true,
      // estimatedRAM intentionally omitted
    };
    const result = checkSystemRequirements(preset);
    expect(result.canRun).toBe(true);
    expect(result.warnings).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("skips the check when estimatedRAM is 0", () => {
    vi.spyOn(os, "freemem").mockReturnValue(10);
    const preset: EmbedderPreset = { ...PRESET_600MB, estimatedRAM: 0 };
    const result = checkSystemRequirements(preset);
    expect(result.canRun).toBe(true);
  });

  it("error message mentions the model name and a lighter alternative", () => {
    vi.spyOn(os, "freemem").mockReturnValue(100 * 1024 * 1024);
    const result = checkSystemRequirements(PRESET_600MB);
    expect(result.errors[0]).toContain(PRESET_600MB.model);
    expect(result.errors[0]).toContain("minilm");
  });
});
