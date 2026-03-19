import { readFile } from "fs/promises";
import { basename, extname } from "path";
import type { Extractor, ExtractedContent, Source } from "../types.js";

export class TextExtractor implements Extractor {
  canHandle(source: Source): boolean {
    if (source.type === "text") return true;
    if (source.type !== "file" || !source.path) return false;

    const ext = extname(source.path).toLowerCase();
    return [".txt", ".text", ""].includes(ext);
  }

  async extract(source: Source): Promise<ExtractedContent> {
    let text: string;
    let metadata: Record<string, unknown> = {};

    if (source.type === "text" && source.content) {
      text = source.content;
      metadata.name = source.name ?? "inline-text";
    } else if (source.path) {
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
