import { readFile } from "fs/promises";
import { basename, extname } from "path";
import mammoth from "mammoth";
import type { Extractor, ExtractedContent, Source } from "../types.js";

export class DocxExtractor implements Extractor {
  canHandle(source: Source): boolean {
    if (source.type !== "file" || !source.path) return false;
    const ext = extname(source.path).toLowerCase();
    return ext === ".docx";
  }

  async extract(source: Source): Promise<ExtractedContent> {
    if (!source.path) {
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
