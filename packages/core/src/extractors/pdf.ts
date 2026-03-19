import { readFile } from "fs/promises";
import { basename, extname } from "path";
import type { Extractor, ExtractedContent, Source } from "../types.js";

export class PdfExtractor implements Extractor {
  canHandle(source: Source): boolean {
    if (source.type !== "file" || !source.path) return false;
    const ext = extname(source.path).toLowerCase();
    return ext === ".pdf";
  }

  async extract(source: Source): Promise<ExtractedContent> {
    if (!source.path) {
      throw new Error("PdfExtractor requires a file path");
    }

    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    
    const buffer = await readFile(source.path);
    const uint8Array = new Uint8Array(buffer);
    
    const doc = await pdfjs.getDocument({ data: uint8Array }).promise;
    const numPages = doc.numPages;
    
    const textParts: string[] = [];
    
    for (let i = 1; i <= numPages; i++) {
      const page = await doc.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = textContent.items
        .map((item) => "str" in item ? item.str : "")
        .join(" ");
      textParts.push(pageText);
    }

    const metadata: Record<string, unknown> = {
      filename: basename(source.path),
      pages: numPages,
    };

    // Try to get PDF metadata
    try {
      const meta = await doc.getMetadata();
      if (meta?.info) {
        const info = meta.info as Record<string, unknown>;
        if (info.Title) metadata.title = info.Title;
        if (info.Author) metadata.author = info.Author;
      }
    } catch {
      // Metadata extraction failed, continue without it
    }

    return {
      text: textParts.join("\n\n"),
      metadata,
      sourceType: "pdf",
      mimeType: "application/pdf",
    };
  }
}
