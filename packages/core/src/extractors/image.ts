/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { basename, extname } from "path";
import Tesseract from "tesseract.js";
import type { Extractor, ExtractedContent, Source } from "../types.js";
import type { ExtractorLimits } from "../config.js";
import { DEFAULT_EXTRACTOR_LIMITS } from "../config.js";

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".tif"];

export class ImageExtractor implements Extractor {
  private language: string;
  private ocrTimeoutMs: number;

  constructor(options?: { language?: string; limits?: Partial<ExtractorLimits> }) {
    this.language = options?.language ?? "eng";
    this.ocrTimeoutMs = options?.limits?.ocrTimeoutMs ?? DEFAULT_EXTRACTOR_LIMITS.ocrTimeoutMs;
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

    const result = await Promise.race([
      Tesseract.recognize(source.path, this.language, {
        logger: () => {}, // Suppress progress logs
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`OCR timed out after ${this.ocrTimeoutMs}ms`)), this.ocrTimeoutMs)
      ),
    ]);

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
 *
 * @param ocrTimeoutMs  Optional timeout in ms; defaults to
 *                      `DEFAULT_EXTRACTOR_LIMITS.ocrTimeoutMs`.
 */
export async function ocrFromBuffer(
  buffer: Buffer,
  language = "eng",
  ocrTimeoutMs?: number,
): Promise<{ text: string; confidence: number }> {
  const timeout = ocrTimeoutMs ?? DEFAULT_EXTRACTOR_LIMITS.ocrTimeoutMs;

  const result = await Promise.race([
    Tesseract.recognize(buffer, language, {
      logger: () => {},
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`OCR timed out after ${timeout}ms`)), timeout)
    ),
  ]);

  return {
    text: result.data.text.trim(),
    confidence: result.data.confidence,
  };
}