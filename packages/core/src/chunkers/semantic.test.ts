/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { describe, expect, it } from "vitest";
import { SemanticChunker } from "../chunkers/semantic.js";
import type { ExtractedContent } from "../types.js";

function makeContent(text: string, sourceType: "markdown" | "text" = "markdown"): ExtractedContent {
  return { text, metadata: {}, sourceType, mimeType: "text/plain" };
}

describe("SemanticChunker", () => {
  describe("canHandle", () => {
    const chunker = new SemanticChunker();

    it("handles markdown content", () => {
      expect(chunker.canHandle(makeContent("", "markdown"))).toBe(true);
    });

    it("handles text content", () => {
      expect(chunker.canHandle(makeContent("", "text"))).toBe(true);
    });

    it("does not handle code content", () => {
      expect(chunker.canHandle({ text: "", metadata: {}, sourceType: "code" })).toBe(false);
    });

    it("does not handle pdf content", () => {
      expect(chunker.canHandle({ text: "", metadata: {}, sourceType: "pdf" })).toBe(false);
    });
  });

  describe("chunk", () => {
    it("creates a single chunk for small content", async () => {
      const chunker = new SemanticChunker();
      const content = makeContent("Hello world\nThis is a test.");
      const chunks = await chunker.chunk(content, "src-1", "/test.md");

      expect(chunks.length).toBe(1);
      expect(chunks[0].text).toContain("Hello world");
      expect(chunks[0].sourceId).toBe("src-1");
      expect(chunks[0].sourcePath).toBe("/test.md");
      expect(chunks[0].startLine).toBe(1);
    });

    it("splits on headings", async () => {
      // Each section needs enough content to exceed overlapChars (default 50 tokens × 4 = 200 chars)
      // so the chunker flushes when it hits the next heading.
      const pad = "Lorem ipsum dolor sit amet. ".repeat(10); // ~280 chars
      const chunker = new SemanticChunker();
      const content = makeContent(
        `# Section 1\n\n${pad}\n\n` + `# Section 2\n\n${pad}\n\n` + `# Section 3\n\n${pad}`
      );
      const chunks = await chunker.chunk(content, "src-1", "/test.md");

      // Should have multiple chunks (one per section, possibly with overlap)
      expect(chunks.length).toBeGreaterThanOrEqual(2);

      // First chunk should reference section 1
      expect(chunks[0].metadata.heading).toBe("Section 1");
    });

    it("splits on max chunk size", async () => {
      // The chunker splits at line boundaries, so we need multiple lines
      // that together exceed maxChars. chunkSize=10 tokens → maxChars=40.
      const chunker = new SemanticChunker({ chunkSize: 10, overlap: 0 });
      const lines = Array.from({ length: 20 }, (_, i) => `Line ${i}: some content here`);
      const content = makeContent(lines.join("\n"));
      const chunks = await chunker.chunk(content, "src-1", "/test.md");

      expect(chunks.length).toBeGreaterThan(1);
    });

    it("returns empty array for empty content", async () => {
      const chunker = new SemanticChunker();
      const content = makeContent("");
      const chunks = await chunker.chunk(content, "src-1", "/test.md");

      expect(chunks).toEqual([]);
    });

    it("returns empty array for whitespace-only content", async () => {
      const chunker = new SemanticChunker();
      const content = makeContent("   \n  \n  ");
      const chunks = await chunker.chunk(content, "src-1", "/test.md");

      expect(chunks).toEqual([]);
    });

    it("preserves heading metadata", async () => {
      const chunker = new SemanticChunker();
      const content = makeContent("## My Section\n\nSome text under a heading.");
      const chunks = await chunker.chunk(content, "src-1", "/test.md");

      expect(chunks.length).toBeGreaterThanOrEqual(1);
      expect(chunks[0].metadata.heading).toBe("My Section");
      expect(chunks[0].metadata.type).toBe("section");
    });

    it("marks non-heading chunks as paragraph", async () => {
      const chunker = new SemanticChunker();
      const content = makeContent("Just some plain text without headings.");
      const chunks = await chunker.chunk(content, "src-1", "/test.md");

      expect(chunks.length).toBe(1);
      expect(chunks[0].metadata.type).toBe("paragraph");
      expect(chunks[0].metadata.heading).toBeUndefined();
    });

    it("generates unique IDs for each chunk", async () => {
      const chunker = new SemanticChunker({ chunkSize: 10, overlap: 0 });
      const content = makeContent(`Line 1\nLine 2\nLine 3\n${"X".repeat(200)}`);
      const chunks = await chunker.chunk(content, "src-1", "/test.md");

      const ids = chunks.map((c) => c.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });
  });
});
