/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { ExtractedContent, Extractor, Source } from "../types.js";

type Language = "typescript" | "javascript" | "python" | "go" | "java";

const EXT_TO_LANG: Record<string, Language> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".java": "java",
};

export class CodeExtractor implements Extractor {
  canHandle(source: Source): boolean {
    if (source.type !== "file") return false;
    const ext = extname(source.path).toLowerCase();
    return ext in EXT_TO_LANG;
  }

  async extract(source: Source): Promise<ExtractedContent> {
    if (source.type !== "file") {
      throw new Error("CodeExtractor requires a file path");
    }

    const ext = extname(source.path).toLowerCase();
    const language = EXT_TO_LANG[ext];

    const content = await readFile(source.path, "utf-8");

    const metadata: Record<string, unknown> = {
      filename: basename(source.path),
      language,
      lines: content.split("\n").length,
    };

    return {
      text: content,
      metadata,
      sourceType: "code",
      mimeType: this.getMimeType(language),
    };
  }

  private getMimeType(language: Language): string {
    switch (language) {
      case "typescript":
        return "text/typescript";
      case "javascript":
        return "text/javascript";
      case "python":
        return "text/x-python";
      case "go":
        return "text/x-go";
      case "java":
        return "text/x-java";
    }
  }
}
