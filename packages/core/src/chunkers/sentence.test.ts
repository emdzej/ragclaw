/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { describe, expect, it } from "vitest";
import { SentenceChunker } from "../chunkers/sentence.js";
import type { ExtractedContent } from "../types.js";

function makeContent(
  text: string,
  sourceType: "markdown" | "text" | "code" = "text"
): ExtractedContent {
  return { text, metadata: {}, sourceType, mimeType: "text/plain" };
}

describe("SentenceChunker", () => {
  describe("metadata fields", () => {
    it("has correct name", () => {
      expect(new SentenceChunker().name).toBe("sentence");
    });

    it("has non-empty description", () => {
      expect(new SentenceChunker().description.length).toBeGreaterThan(0);
    });

    it("handles array contains markdown and text", () => {
      const c = new SentenceChunker();
      expect(c.handles).toContain("markdown");
      expect(c.handles).toContain("text");
    });
  });

  describe("canHandle", () => {
    const chunker = new SentenceChunker();

    it("handles markdown content", () => {
      expect(chunker.canHandle(makeContent("", "markdown"))).toBe(true);
    });

    it("handles text content", () => {
      expect(chunker.canHandle(makeContent("", "text"))).toBe(true);
    });

    it("does not handle code content", () => {
      expect(chunker.canHandle(makeContent("", "code"))).toBe(false);
    });

    it("does not handle pdf content", () => {
      expect(chunker.canHandle({ text: "", metadata: {}, sourceType: "pdf" })).toBe(false);
    });
  });

  describe("chunk", () => {
    it("returns empty array for empty text", async () => {
      const chunker = new SentenceChunker();
      const chunks = await chunker.chunk(makeContent(""), "src-1", "/test.txt");
      expect(chunks).toEqual([]);
    });

    it("returns empty array for whitespace-only text", async () => {
      const chunker = new SentenceChunker();
      const chunks = await chunker.chunk(makeContent("   \n\t  "), "src-1", "/test.txt");
      expect(chunks).toEqual([]);
    });

    it("creates a single chunk for short content", async () => {
      const chunker = new SentenceChunker();
      const content = makeContent("Hello world. This is a test.");
      const chunks = await chunker.chunk(content, "src-1", "/test.txt");

      expect(chunks.length).toBe(1);
      expect(chunks[0].text).toContain("Hello world");
      expect(chunks[0].sourceId).toBe("src-1");
      expect(chunks[0].sourcePath).toBe("/test.txt");
    });

    it("sets metadata.type to paragraph", async () => {
      const chunker = new SentenceChunker();
      const chunks = await chunker.chunk(makeContent("A simple sentence."), "src-1", "/test.txt");
      expect(chunks[0].metadata.type).toBe("paragraph");
    });

    it("splits into multiple chunks when content exceeds chunk size", async () => {
      // chunkSize=5 tokens → maxChars=20; each sentence is longer than that
      const chunker = new SentenceChunker({ chunkSize: 5, overlap: 0 });
      const text = [
        "This is the first sentence with enough words to fill a chunk.",
        "This is the second sentence that should go into a different chunk.",
        "And here is a third sentence for good measure.",
      ].join(" ");
      const chunks = await chunker.chunk(makeContent(text), "src-1", "/test.txt");
      expect(chunks.length).toBeGreaterThan(1);
    });

    it("carries overlap sentences into next chunk", async () => {
      const chunker = new SentenceChunker({ chunkSize: 5, overlap: 1 });
      const text = [
        "First sentence that is long enough to trigger a split when combined.",
        "Second sentence added to push past the limit.",
        "Third sentence appears after the split.",
      ].join(" ");
      const chunks = await chunker.chunk(makeContent(text), "src-1", "/test.txt");
      // With overlap=1, the last sentence of chunk N appears at the start of chunk N+1
      if (chunks.length >= 2) {
        const lastOfFirst = chunks[0].text.split(/\.\s+/).pop() ?? "";
        expect(chunks[1].text).toContain(lastOfFirst.slice(0, 10));
      }
    });

    it("generates unique IDs for each chunk", async () => {
      const chunker = new SentenceChunker({ chunkSize: 5, overlap: 0 });
      const text = Array.from(
        { length: 10 },
        (_, i) => `Sentence number ${i} with enough words to be long.`
      ).join(" ");
      const chunks = await chunker.chunk(makeContent(text), "src-1", "/test.txt");
      const ids = chunks.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("strips markdown heading markers before segmenting", async () => {
      const chunker = new SentenceChunker();
      const content = makeContent("## My Heading\n\nSome sentence here.", "markdown");
      const chunks = await chunker.chunk(content, "src-1", "/test.md");
      // Heading markers should not appear as standalone sentences
      expect(chunks.some((c) => c.text.startsWith("##"))).toBe(false);
    });

    it("includes startLine and endLine", async () => {
      const chunker = new SentenceChunker();
      const chunks = await chunker.chunk(makeContent("One sentence here."), "src-1", "/test.txt");
      expect(chunks[0].startLine).toBeGreaterThanOrEqual(1);
      expect(chunks[0].endLine).toBeGreaterThanOrEqual(chunks[0].startLine ?? 1);
    });
  });
});
