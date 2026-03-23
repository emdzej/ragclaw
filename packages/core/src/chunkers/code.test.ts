/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { describe, expect, it } from "vitest";
import { CodeChunker } from "../chunkers/code.js";
import type { ExtractedContent } from "../types.js";

function makeCodeContent(text: string, language: string): ExtractedContent {
  return {
    text,
    metadata: { language },
    sourceType: "code",
    mimeType: "text/plain",
  };
}

describe("CodeChunker", () => {
  describe("canHandle", () => {
    const chunker = new CodeChunker();

    it("handles code content", () => {
      expect(chunker.canHandle(makeCodeContent("", "typescript"))).toBe(true);
    });

    it("handles text/javascript MIME type", () => {
      expect(
        chunker.canHandle({
          text: "",
          metadata: {},
          sourceType: "code",
          mimeType: "text/javascript",
        })
      ).toBe(true);
    });

    it("handles application/javascript MIME type", () => {
      expect(
        chunker.canHandle({
          text: "",
          metadata: {},
          sourceType: "code",
          mimeType: "application/javascript",
        })
      ).toBe(true);
    });

    it("handles text/typescript MIME type", () => {
      expect(
        chunker.canHandle({
          text: "",
          metadata: {},
          sourceType: "code",
          mimeType: "text/typescript",
        })
      ).toBe(true);
    });

    it("handles text/x-python MIME type", () => {
      expect(
        chunker.canHandle({ text: "", metadata: {}, sourceType: "code", mimeType: "text/x-python" })
      ).toBe(true);
    });

    it("handles text/x-go MIME type", () => {
      expect(
        chunker.canHandle({ text: "", metadata: {}, sourceType: "code", mimeType: "text/x-go" })
      ).toBe(true);
    });

    it("does not handle markdown content", () => {
      expect(chunker.canHandle({ text: "", metadata: {}, sourceType: "markdown" })).toBe(false);
    });

    it("does not handle text content", () => {
      expect(chunker.canHandle({ text: "", metadata: {}, sourceType: "text" })).toBe(false);
    });

    it("does not handle text/html MIME type", () => {
      expect(
        chunker.canHandle({ text: "", metadata: {}, sourceType: "web", mimeType: "text/html" })
      ).toBe(false);
    });
  });

  describe("fallback chunking", () => {
    const chunker = new CodeChunker();

    it("creates chunks from code using line-based fallback", async () => {
      // Generate enough lines to trigger chunking (default is 50 lines/chunk)
      const lines: string[] = [];
      for (let i = 0; i < 120; i++) {
        lines.push(`const x${i} = ${i}; // line ${i + 1}`);
      }
      const content = makeCodeContent(lines.join("\n"), "typescript");
      const chunks = await chunker.chunk(content, "src-1", "/test.ts");

      expect(chunks.length).toBeGreaterThan(1);
      // Should be around 3 chunks for 120 lines at 50 lines/chunk
      expect(chunks.length).toBeGreaterThanOrEqual(2);
      expect(chunks.length).toBeLessThanOrEqual(4);

      // All chunks should have code metadata
      for (const chunk of chunks) {
        expect(chunk.metadata.type).toBe("block");
        expect(chunk.metadata.language).toBe("typescript");
        expect(chunk.sourceId).toBe("src-1");
        expect(chunk.sourcePath).toBe("/test.ts");
      }
    });

    it("skips tiny chunks (< 20 chars)", async () => {
      // 50 lines but most are very short
      const lines = Array(50).fill("x");
      const content = makeCodeContent(lines.join("\n"), "python");
      const chunks = await chunker.chunk(content, "src-1", "/test.py");

      // The 50-char chunk "x\nx\n..." repeated 50 times IS > 20 chars,
      // so we should still get a chunk
      expect(chunks.length).toBeGreaterThanOrEqual(1);
    });

    it("returns empty array for very short content", async () => {
      const content = makeCodeContent("x = 1", "python");
      const chunks = await chunker.chunk(content, "src-1", "/test.py");

      // "x = 1" is < 20 chars, so fallback should skip it
      expect(chunks).toEqual([]);
    });

    it("generates unique IDs", async () => {
      const lines: string[] = [];
      for (let i = 0; i < 120; i++) {
        lines.push(`const x${i} = ${i};`);
      }
      const content = makeCodeContent(lines.join("\n"), "javascript");
      const chunks = await chunker.chunk(content, "src-1", "/test.js");

      const ids = new Set(chunks.map((c) => c.id));
      expect(ids.size).toBe(chunks.length);
    });
  });
});
