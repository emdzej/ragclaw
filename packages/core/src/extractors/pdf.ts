import { readFile } from "fs/promises";
import { basename, extname } from "path";
import type { Extractor, ExtractedContent, Source } from "../types.js";

// Minimum text length per page to consider it "has text"
const MIN_TEXT_PER_PAGE = 50;

export class PdfExtractor implements Extractor {
  private enableOcr: boolean;
  private ocrLanguage: string;

  constructor(options: { enableOcr?: boolean; ocrLanguage?: string } = {}) {
    this.enableOcr = options.enableOcr ?? true;
    this.ocrLanguage = options.ocrLanguage ?? "eng";
  }

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
    let ocrPages = 0;
    let usedOcr = false;
    
    for (let i = 1; i <= numPages; i++) {
      const page = await doc.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = textContent.items
        .map((item) => "str" in item ? item.str : "")
        .join(" ")
        .trim();
      
      // Check if page has meaningful text
      if (pageText.length >= MIN_TEXT_PER_PAGE) {
        textParts.push(pageText);
      } else if (this.enableOcr) {
        // Page appears to be an image/scan - try OCR
        try {
          const ocrText = await this.ocrPage(page, pdfjs);
          if (ocrText.length > 0) {
            textParts.push(ocrText);
            ocrPages++;
            usedOcr = true;
          }
        } catch {
          // OCR failed, skip this page
          if (pageText.length > 0) {
            textParts.push(pageText);
          }
        }
      } else if (pageText.length > 0) {
        textParts.push(pageText);
      }
    }

    const metadata: Record<string, unknown> = {
      filename: basename(source.path),
      pages: numPages,
    };

    if (usedOcr) {
      metadata.ocrPages = ocrPages;
      metadata.ocrLanguage = this.ocrLanguage;
    }

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

  private async ocrPage(page: unknown, pdfjs: unknown): Promise<string> {
    // Cast to any for simpler typing
    const p = page as { getViewport: (opts: { scale: number }) => { width: number; height: number }; render: (opts: unknown) => { promise: Promise<void> } };
    
    // Render page to canvas and extract image
    const viewport = p.getViewport({ scale: 2.0 }); // Higher scale = better OCR
    
    // Create a canvas for Node.js
    const { createCanvas } = await import("canvas");
    const canvas = createCanvas(viewport.width, viewport.height);
    const context = canvas.getContext("2d");

    await p.render({
      canvasContext: context as never,
      viewport,
    }).promise;

    // Convert to PNG buffer
    const pngBuffer = canvas.toBuffer("image/png");

    // Run OCR
    const { ocrFromBuffer } = await import("./image.js");
    const result = await ocrFromBuffer(pngBuffer, this.ocrLanguage);
    
    return result.text;
  }
}
