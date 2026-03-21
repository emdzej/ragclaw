/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { ExtractedContent, Extractor, Source } from "../types.js";

export class TextExtractor implements Extractor {
  canHandle(source: Source): boolean {
    if (source.type === "text") return true;
    if (source.type !== "file") return false;

    const ext = extname(source.path).toLowerCase();
    return [".txt", ".text", ""].includes(ext);
  }

  async extract(source: Source): Promise<ExtractedContent> {
    let text: string;
    const metadata: Record<string, unknown> = {};

    if (source.type === "text") {
      if (!source.content) throw new Error("TextExtractor requires content or file path");
      text = source.content;
      metadata.name = source.name ?? "inline-text";
    } else if (source.type === "file") {
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
