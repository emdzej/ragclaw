/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { randomUUID } from "node:crypto";
import type { Chunk, Chunker, ExtractedContent } from "../types.js";

const DEFAULT_CHUNK_SIZE = 512; // tokens (approximate)
const DEFAULT_OVERLAP = 50; // tokens
const CHARS_PER_TOKEN = 4;

export interface FixedChunkerOptions {
  /** Target chunk size in tokens (approximate). Default: 512. */
  chunkSize?: number;
  /** Overlap in tokens between consecutive chunks. Default: 50. */
  overlap?: number;
}

/**
 * Fixed token-window chunker.
 *
 * Splits any content into fixed-size chunks regardless of structure.
 * Acts as the universal fallback — \`canHandle()\` always returns true.
 *
 * Splitting happens at line boundaries to avoid breaking mid-sentence where
 * possible, but will hard-split long lines if they exceed the window.
 */
export class FixedChunker implements Chunker {
  readonly name = "fixed";
  readonly description = "Fixed token-window splitting, language-agnostic universal fallback";
  readonly handles = ["*"];

  private chunkSize: number;
  private overlap: number;

  constructor(options: FixedChunkerOptions = {}) {
    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.overlap = options.overlap ?? DEFAULT_OVERLAP;
  }

  canHandle(_content: ExtractedContent): boolean {
    return true; // universal fallback
  }

  async chunk(content: ExtractedContent, sourceId: string, sourcePath: string): Promise<Chunk[]> {
    if (!content.text.trim()) return [];

    const maxChars = this.chunkSize * CHARS_PER_TOKEN;
    const overlapChars = this.overlap * CHARS_PER_TOKEN;
    const lines = content.text.split("\n");
    const chunks: Chunk[] = [];

    let currentLines: string[] = [];
    let currentChars = 0;
    let startLine = 1;

    const flush = (endLine: number): void => {
      const text = currentLines.join("\n").trim();
      if (!text) return;
      chunks.push({
        id: randomUUID(),
        text,
        sourceId,
        sourcePath,
        startLine,
        endLine,
        metadata: { type: "block" },
      });
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;
      const lineChars = line.length + 1; // +1 for newline

      if (currentChars + lineChars > maxChars && currentLines.length > 0) {
        flush(lineNum - 1);

        // Keep overlap from end of previous chunk
        const overlapLines = this.getOverlapLines(currentLines, overlapChars);
        currentLines = [...overlapLines, line];
        currentChars = currentLines.reduce((sum, l) => sum + l.length + 1, 0);
        startLine = lineNum - overlapLines.length;
      } else {
        currentLines.push(line);
        currentChars += lineChars;
      }
    }

    if (currentLines.length > 0) {
      flush(lines.length);
    }

    return chunks;
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
