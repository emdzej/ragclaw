import { basename, extname } from "path";
import Tesseract from "tesseract.js";
import type { Extractor, ExtractedContent, Source } from "../types.js";

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".tif"];

export class ImageExtractor implements Extractor {
  private language: string;

  constructor(language = "eng") {
    this.language = language;
  }

  canHandle(source: Source): boolean {
    if (source.type !== "file" || !source.path) return false;
    const ext = extname(source.path).toLowerCase();
    return IMAGE_EXTENSIONS.includes(ext);
  }

  async extract(source: Source): Promise<ExtractedContent> {
    if (!source.path) {
      throw new Error("ImageExtractor requires a file path");
    }

    const result = await Tesseract.recognize(source.path, this.language, {
      logger: () => {}, // Suppress progress logs
    });

    const text = result.data.text.trim();
    const confidence = result.data.confidence;

    const metadata: Record<string, unknown> = {
      filename: basename(source.path),
      ocrConfidence: confidence,
      language: this.language,
    };

    // Extract any detected paragraphs/blocks info
    if (result.data.blocks) {
      metadata.blocks = result.data.blocks.length;
    }

    return {
      text,
      metadata,
      sourceType: "text", // Treat OCR output as plain text
      mimeType: this.getMimeType(source.path),
    };
  }

  private getMimeType(path: string): string {
    const ext = extname(path).toLowerCase();
    switch (ext) {
      case ".png": return "image/png";
      case ".jpg":
      case ".jpeg": return "image/jpeg";
      case ".gif": return "image/gif";
      case ".webp": return "image/webp";
      case ".bmp": return "image/bmp";
      case ".tiff":
      case ".tif": return "image/tiff";
      default: return "image/unknown";
    }
  }
}

/**
 * Run OCR on an image buffer and return extracted text.
 * Useful for PDF pages that are image-only.
 */
export async function ocrFromBuffer(
  buffer: Buffer,
  language = "eng"
): Promise<{ text: string; confidence: number }> {
  const result = await Tesseract.recognize(buffer, language, {
    logger: () => {},
  });

  return {
    text: result.data.text.trim(),
    confidence: result.data.confidence,
  };
}
