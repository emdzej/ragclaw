import { readFile } from "fs/promises";
import { basename, extname } from "path";
import type { Extractor, ExtractedContent, Source } from "../types.js";

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
    if (source.type !== "file" || !source.path) return false;
    const ext = extname(source.path).toLowerCase();
    return ext in EXT_TO_LANG;
  }

  async extract(source: Source): Promise<ExtractedContent> {
    if (!source.path) {
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
