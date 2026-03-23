/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { randomUUID } from "node:crypto";
import type { Chunk, Chunker, ExtractedContent } from "../types.js";
import { matchesContent } from "./utils.js";

const DEFAULT_CHUNK_SIZE = 512; // tokens (approximate)
const DEFAULT_OVERLAP = 50; // tokens
const CHARS_PER_TOKEN = 4; // rough estimate

interface SemanticChunkerOptions {
  chunkSize?: number;
  overlap?: number;
}

const SOURCE_TYPES = ["markdown", "text", "web"] as const;

/**
 * MIME types treated as prose by SemanticChunker.
 * Includes the HTML/XML family produced by WebExtractor and any plain-text
 * variants an extractor might emit.
 */
const MIME_TYPES = [
  "text/html",
  "application/xhtml+xml",
  "application/xml",
  "text/xml",
  "text/plain",
  "text/markdown",
] as const;

export class SemanticChunker implements Chunker {
  readonly name = "semantic";
  readonly description =
    "Heading-aware paragraph splitting with configurable token window and overlap";
  readonly handles: string[] = [...SOURCE_TYPES, ...MIME_TYPES];

  private chunkSize: number;
  private overlap: number;

  constructor(options: SemanticChunkerOptions = {}) {
    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.overlap = options.overlap ?? DEFAULT_OVERLAP;
  }

  canHandle(content: ExtractedContent): boolean {
    return matchesContent(SOURCE_TYPES, MIME_TYPES, content);
  }

  async chunk(content: ExtractedContent, sourceId: string, sourcePath: string): Promise<Chunk[]> {
    const chunks: Chunk[] = [];
    const lines = content.text.split("\n");

    let currentChunk: string[] = [];
    let currentStartLine = 1;
    let currentHeading: string | undefined;
    let chunkCharCount = 0;

    const maxChars = this.chunkSize * CHARS_PER_TOKEN;
    const overlapChars = this.overlap * CHARS_PER_TOKEN;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Check for markdown headings
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        // Flush current chunk if we have content and hit a new section
        if (currentChunk.length > 0 && chunkCharCount > overlapChars) {
          chunks.push(
            this.createChunk(
              currentChunk,
              sourceId,
              sourcePath,
              currentStartLine,
              lineNum - 1,
              currentHeading
            )
          );

          // Keep overlap from end of previous chunk
          const overlapLines = this.getOverlapLines(currentChunk, overlapChars);
          currentChunk = overlapLines;
          chunkCharCount = overlapLines.join("\n").length;
          currentStartLine = lineNum - overlapLines.length;
        }

        currentHeading = headingMatch[2];
      }

      currentChunk.push(line);
      chunkCharCount += line.length + 1; // +1 for newline

      // Flush if chunk is too large
      if (chunkCharCount >= maxChars) {
        chunks.push(
          this.createChunk(
            currentChunk,
            sourceId,
            sourcePath,
            currentStartLine,
            lineNum,
            currentHeading
          )
        );

        // Keep overlap
        const overlapLines = this.getOverlapLines(currentChunk, overlapChars);
        currentChunk = overlapLines;
        chunkCharCount = overlapLines.join("\n").length;
        currentStartLine = lineNum - overlapLines.length + 1;
      }
    }

    // Flush remaining content
    if (currentChunk.length > 0) {
      const text = currentChunk.join("\n").trim();
      if (text.length > 0) {
        chunks.push(
          this.createChunk(
            currentChunk,
            sourceId,
            sourcePath,
            currentStartLine,
            lines.length,
            currentHeading
          )
        );
      }
    }

    return chunks;
  }

  private createChunk(
    lines: string[],
    sourceId: string,
    sourcePath: string,
    startLine: number,
    endLine: number,
    heading?: string
  ): Chunk {
    const text = lines.join("\n").trim();

    return {
      id: randomUUID(),
      text,
      sourceId,
      sourcePath,
      startLine,
      endLine,
      metadata: {
        type: heading ? "section" : "paragraph",
        heading,
      },
    };
  }

  private getOverlapLines(lines: string[], targetChars: number): string[] {
    const result: string[] = [];
    let chars = 0;

    for (let i = lines.length - 1; i >= 0 && chars < targetChars; i--) {
      result.unshift(lines[i]);
      chars += lines[i].length + 1;
    }

    return result;
  }
}
