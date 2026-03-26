/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { open, readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { ExtractedContent, Extractor, Source } from "../types.js";

/** Number of bytes to sample when detecting binary files. */
const BINARY_SNIFF_BYTES = 8192;

/**
 * Return true when the buffer looks like a binary file.
 *
 * Heuristic: any null byte (0x00) within the first `BINARY_SNIFF_BYTES`
 * is a strong indicator of binary content.  This catches ELF binaries,
 * compiled JARs, SQLite files, etc. while correctly passing through all
 * plain-text formats (UTF-8, Latin-1, ASCII).
 */
function looksLikeBinary(buf: Buffer): boolean {
  return buf.includes(0x00);
}

export class TextExtractor implements Extractor {
  /**
   * Accept any file source as a fallback.
   *
   * More-specific extractors (Markdown, PDF, DOCX, Code, Image) are
   * registered earlier in the pipeline and will claim their own file
   * types before this extractor is reached.  Binary detection happens
   * lazily inside `extract()` so we never read the file twice.
   */
  canHandle(source: Source): boolean {
    if (source.type === "text") return true;
    if (source.type === "file") return true;
    return false;
  }

  async extract(source: Source): Promise<ExtractedContent> {
    let text: string;
    const metadata: Record<string, unknown> = {};

    if (source.type === "text") {
      if (!source.content) throw new Error("TextExtractor requires content or file path");
      text = source.content;
      metadata.name = source.name ?? "inline-text";
    } else if (source.type === "file") {
      // Sniff the first BINARY_SNIFF_BYTES to catch binary files early
      // before attempting a full UTF-8 decode.
      const fh = await open(source.path, "r");
      try {
        const sniffBuf = Buffer.alloc(BINARY_SNIFF_BYTES);
        const { bytesRead } = await fh.read(sniffBuf, 0, BINARY_SNIFF_BYTES, 0);
        if (looksLikeBinary(sniffBuf.subarray(0, bytesRead))) {
          throw new Error(`TextExtractor: "${source.path}" appears to be a binary file — skipping`);
        }
      } finally {
        await fh.close();
      }

      text = await readFile(source.path, "utf-8");
      metadata.filename = basename(source.path);
    } else {
      throw new Error("TextExtractor requires content or file path");
    }

    return {
      text,
      metadata,
      sourceType: "text",
      mimeType: "text/plain",
    };
  }
}
