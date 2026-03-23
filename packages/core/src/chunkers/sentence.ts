/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { randomUUID } from "node:crypto";
import type { Chunk, Chunker, ExtractedContent } from "../types.js";

const DEFAULT_CHUNK_SIZE = 512; // tokens (approximate)
const DEFAULT_OVERLAP = 1; // sentences
const CHARS_PER_TOKEN = 4;

export interface SentenceChunkerOptions {
  /** Target chunk size in tokens (approximate). Default: 512. */
  chunkSize?: number;
  /**
   * Number of sentences to carry over from the previous chunk as overlap.
   * Default: 1.
   */
  overlap?: number;
}

/**
 * Splits content by sentence boundaries using \`Intl.Segmenter\`.
 *
 * Sentences are accumulated until the target token budget is reached, then
 * flushed as a chunk. The last `overlap` sentences are prepended to the next
 * chunk to preserve context across boundaries.
 *
 * Works for any prose content — markdown headings are stripped before
 * segmentation so they don't skew sentence boundaries.
 */
export class SentenceChunker implements Chunker {
  readonly name = "sentence";
  readonly description = "Sentence-boundary splitting via Intl.Segmenter with configurable overlap";
  readonly handles = ["markdown", "text"];

  private chunkSize: number;
  private overlap: number;
  private segmenter: Intl.Segmenter;

  constructor(options: SentenceChunkerOptions = {}) {
    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.overlap = options.overlap ?? DEFAULT_OVERLAP;
    this.segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
  }

  canHandle(content: ExtractedContent): boolean {
    return ["markdown", "text"].includes(content.sourceType);
  }

  async chunk(content: ExtractedContent, sourceId: string, sourcePath: string): Promise<Chunk[]> {
    if (!content.text.trim()) return [];

    const maxChars = this.chunkSize * CHARS_PER_TOKEN;

    // Split into lines to track line numbers; process paragraph by paragraph
    // so we don't cross large structural boundaries.
    const lines = content.text.split("\n");
    const chunks: Chunk[] = [];

    // Accumulate sentences across lines; track line number per sentence
    const sentences: Array<{ text: string; startLine: number; endLine: number }> = [];

    let lineNum = 1;
    for (const line of lines) {
      const stripped = line.replace(/^#{1,6}\s+/, "").trim();
      if (!stripped) {
        lineNum++;
        continue;
      }
      for (const seg of this.segmenter.segment(stripped)) {
        const s = seg.segment.trim();
        if (s) {
          sentences.push({ text: s, startLine: lineNum, endLine: lineNum });
        }
      }
      lineNum++;
    }

    if (sentences.length === 0) return [];

    // Group sentences into chunks respecting maxChars budget
    let current: typeof sentences = [];
    let currentChars = 0;

    const flush = (): void => {
      if (current.length === 0) return;
      const text = current
        .map((s) => s.text)
        .join(" ")
        .trim();
      if (!text) return;
      chunks.push({
        id: randomUUID(),
        text,
        sourceId,
        sourcePath,
        startLine: current[0].startLine,
        endLine: current[current.length - 1].endLine,
        metadata: { type: "paragraph" },
      });
    };

    for (const sentence of sentences) {
      const sentChars = sentence.text.length + 1; // +1 for space

      if (currentChars + sentChars > maxChars && current.length > 0) {
        flush();
        // Keep overlap sentences
        const overlapSentences = current.slice(Math.max(0, current.length - this.overlap));
        current = [...overlapSentences, sentence];
        currentChars = current.reduce((sum, s) => sum + s.text.length + 1, 0);
      } else {
        current.push(sentence);
        currentChars += sentChars;
      }
    }

    flush();
    return chunks;
  }
}
