/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import mammoth from "mammoth";
import type { ExtractedContent, Extractor, Source } from "../types.js";

export class DocxExtractor implements Extractor {
  canHandle(source: Source): boolean {
    if (source.type !== "file") return false;
    const ext = extname(source.path).toLowerCase();
    return ext === ".docx";
  }

  async extract(source: Source): Promise<ExtractedContent> {
    if (source.type !== "file") {
      throw new Error("DocxExtractor requires a file path");
    }

    const buffer = await readFile(source.path);
    const result = await mammoth.extractRawText({ buffer });

    const metadata: Record<string, unknown> = {
      filename: basename(source.path),
    };

    // mammoth doesn't extract metadata, but we note any warnings
    if (result.messages.length > 0) {
      metadata.warnings = result.messages.map((m) => m.message);
    }

    return {
      text: result.value,
      metadata,
      sourceType: "docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    };
  }
}
