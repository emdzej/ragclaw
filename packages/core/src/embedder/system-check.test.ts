import { describe, it, expect, vi, afterEach } from "vitest";
import { checkSystemRequirements } from "./system-check.js";
import type { EmbedderPreset } from "../types.js";

// Mock the memory utility so tests are isolated from the real OS
vi.mock("../utils/memory.js", () => ({
  getAvailableMemory: vi.fn(() => 0),
}));

import { getAvailableMemory } from "../utils/memory.js";
const mockGetAvailableMemory = vi.mocked(getAvailableMemory);

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

  it("returns canRun=true with no issues when available RAM is ≥2× estimate", () => {
    mockGetAvailableMemory.mockReturnValue(1200 * 1024 * 1024); // 1200 MB
    const result = checkSystemRequirements(PRESET_600MB);
    expect(result.canRun).toBe(true);
    expect(result.warnings).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("returns a warning when available RAM is between 1.2× and 2× estimate", () => {
    mockGetAvailableMemory.mockReturnValue(900 * 1024 * 1024); // 900 MB = 1.5×
    const result = checkSystemRequirements(PRESET_600MB);
    expect(result.canRun).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Low available RAM");
    expect(result.errors).toHaveLength(0);
  });

  it("returns a warning at exactly 1.2× estimate (boundary)", () => {
    mockGetAvailableMemory.mockReturnValue(720 * 1024 * 1024); // exactly 1.2×
    const result = checkSystemRequirements(PRESET_600MB);
    // 720 >= 720 (1.2×) → not error; 720 < 1200 (2×) → warning
    expect(result.canRun).toBe(true);
    expect(result.warnings).toHaveLength(1);
  });

  it("returns an error when available RAM is below 1.2× estimate", () => {
    mockGetAvailableMemory.mockReturnValue(500 * 1024 * 1024); // 500 MB < 720 MB
    const result = checkSystemRequirements(PRESET_600MB);
    expect(result.canRun).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Insufficient available RAM");
    expect(result.warnings).toHaveLength(0);
  });

  it("skips the check when preset has no estimatedRAM", () => {
    mockGetAvailableMemory.mockReturnValue(10); // virtually no RAM
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
    mockGetAvailableMemory.mockReturnValue(10);
    const preset: EmbedderPreset = { ...PRESET_600MB, estimatedRAM: 0 };
    const result = checkSystemRequirements(preset);
    expect(result.canRun).toBe(true);
  });

  it("error message mentions the model name and a lighter alternative", () => {
    mockGetAvailableMemory.mockReturnValue(100 * 1024 * 1024);
    const result = checkSystemRequirements(PRESET_600MB);
    expect(result.errors[0]).toContain(PRESET_600MB.model);
    expect(result.errors[0]).toContain("minilm");
  });
});
