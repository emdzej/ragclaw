import { describe, it, expect } from "vitest";
import { cosineSimilarity, cosineDistance } from "../utils/math.js";

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const a = [1, 2, 3];
    const b = [1, 2, 3];
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0);
  });

  it("returns 1 for identical Float32Array vectors", () => {
    const a = new Float32Array([0.5, 0.3, 0.8]);
    const b = new Float32Array([0.5, 0.3, 0.8]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0);
  });

  it("returns -1 for opposite vectors", () => {
    const a = [1, 0, 0];
    const b = [-1, 0, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = [1, 0];
    const b = [0, 1];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0);
  });

  it("returns 0 when one vector is all zeros", () => {
    const a = [0, 0, 0];
    const b = [1, 2, 3];
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it("returns 0 when both vectors are all zeros", () => {
    const a = [0, 0, 0];
    const b = [0, 0, 0];
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it("throws on vector length mismatch", () => {
    const a = [1, 2];
    const b = [1, 2, 3];
    expect(() => cosineSimilarity(a, b)).toThrow("Vector length mismatch");
  });

  it("handles single-element vectors", () => {
    expect(cosineSimilarity([5], [10])).toBeCloseTo(1.0);
    expect(cosineSimilarity([5], [-10])).toBeCloseTo(-1.0);
  });

  it("is symmetric", () => {
    const a = [1, 3, -5];
    const b = [4, -2, -1];
    expect(cosineSimilarity(a, b)).toBeCloseTo(cosineSimilarity(b, a));
  });

  it("is scale-invariant", () => {
    const a = [1, 2, 3];
    const b = [2, 4, 6]; // 2x of a
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0);
  });
});

describe("cosineDistance", () => {
  it("returns 0 for identical vectors", () => {
    const a = [1, 2, 3];
    const b = [1, 2, 3];
    expect(cosineDistance(a, b)).toBeCloseTo(0.0);
  });

  it("returns 2 for opposite vectors", () => {
    const a = [1, 0];
    const b = [-1, 0];
    expect(cosineDistance(a, b)).toBeCloseTo(2.0);
  });

  it("returns 1 for orthogonal vectors", () => {
    const a = [1, 0];
    const b = [0, 1];
    expect(cosineDistance(a, b)).toBeCloseTo(1.0);
  });

  it("equals 1 - cosineSimilarity", () => {
    const a = [1, 3, -5];
    const b = [4, -2, -1];
    expect(cosineDistance(a, b)).toBeCloseTo(1 - cosineSimilarity(a, b));
  });
});
