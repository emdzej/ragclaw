/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { describe, expect, it } from "vitest";
import { FixedChunker } from "../chunkers/fixed.js";
import type { ExtractedContent } from "../types.js";

function makeContent(text: string, sourceType = "text"): ExtractedContent {
  return { text, metadata: {}, sourceType: sourceType as ExtractedContent["sourceType"] };
}

describe("FixedChunker", () => {
  describe("metadata fields", () => {
    it("has name 'fixed'", () => {
      expect(new FixedChunker().name).toBe("fixed");
    });

    it("has non-empty description", () => {
      expect(new FixedChunker().description.length).toBeGreaterThan(0);
    });

    it("handles array is ['*']", () => {
      expect(new FixedChunker().handles).toEqual(["*"]);
    });
  });

  describe("canHandle", () => {
    const chunker = new FixedChunker();

    it("handles markdown content", () => {
      expect(chunker.canHandle(makeContent("", "markdown"))).toBe(true);
    });

    it("handles text content", () => {
      expect(chunker.canHandle(makeContent("", "text"))).toBe(true);
    });

    it("handles code content", () => {
      expect(chunker.canHandle(makeContent("", "code"))).toBe(true);
    });

    it("handles pdf content", () => {
      expect(chunker.canHandle({ text: "", metadata: {}, sourceType: "pdf" })).toBe(true);
    });

    it("handles any unknown sourceType", () => {
      expect(
        chunker.canHandle({
          text: "",
          metadata: {},
          sourceType: "image" as ExtractedContent["sourceType"],
        })
      ).toBe(true);
    });
  });

  describe("chunk", () => {
    it("returns empty array for empty text", async () => {
      const chunker = new FixedChunker();
      expect(await chunker.chunk(makeContent(""), "src-1", "/test.txt")).toEqual([]);
    });

    it("returns empty array for whitespace-only text", async () => {
      const chunker = new FixedChunker();
      expect(await chunker.chunk(makeContent("   \n\n "), "src-1", "/test.txt")).toEqual([]);
    });

    it("creates a single chunk for short content", async () => {
      const chunker = new FixedChunker();
      const content = makeContent("Hello world\nThis is a test.");
      const chunks = await chunker.chunk(content, "src-1", "/test.txt");

      expect(chunks.length).toBe(1);
      expect(chunks[0].text).toContain("Hello world");
      expect(chunks[0].sourceId).toBe("src-1");
      expect(chunks[0].sourcePath).toBe("/test.txt");
    });

    it("sets metadata.type to block", async () => {
      const chunker = new FixedChunker();
      const chunks = await chunker.chunk(makeContent("A line of text."), "src-1", "/test.txt");
      expect(chunks[0].metadata.type).toBe("block");
    });

    it("splits into multiple chunks when content exceeds chunk size", async () => {
      // chunkSize=2 tokens → maxChars=8; each line is longer than that
      const chunker = new FixedChunker({ chunkSize: 2, overlap: 0 });
      const lines = Array.from({ length: 10 }, (_, i) => `Line number ${i} with content`);
      const chunks = await chunker.chunk(makeContent(lines.join("\n")), "src-1", "/test.txt");
      expect(chunks.length).toBeGreaterThan(1);
    });

    it("preserves overlap lines in subsequent chunks", async () => {
      const chunker = new FixedChunker({ chunkSize: 3, overlap: 1 });
      const lines = Array.from({ length: 15 }, (_, i) => `This is line ${i} with enough content`);
      const chunks = await chunker.chunk(makeContent(lines.join("\n")), "src-1", "/test.txt");
      expect(chunks.length).toBeGreaterThan(1);
      // With overlap, chunk N+1 starts with some content from chunk N
      if (chunks.length >= 2) {
        const lastLineOfFirst = chunks[0].text.split("\n").pop() ?? "";
        expect(chunks[1].text).toContain(lastLineOfFirst.slice(0, 10));
      }
    });

    it("generates unique IDs for each chunk", async () => {
      const chunker = new FixedChunker({ chunkSize: 2, overlap: 0 });
      const lines = Array.from({ length: 20 }, (_, i) => `Line ${i}: some content here`);
      const chunks = await chunker.chunk(makeContent(lines.join("\n")), "src-1", "/test.txt");
      const ids = chunks.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("records startLine and endLine", async () => {
      const chunker = new FixedChunker();
      const chunks = await chunker.chunk(makeContent("Line one\nLine two"), "src-1", "/test.txt");
      expect(chunks[0].startLine).toBe(1);
      expect(chunks[0].endLine).toBeGreaterThanOrEqual(1);
    });
  });
});
