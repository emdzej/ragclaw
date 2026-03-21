/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock pdfjs-dist ─────────────────────────────────────────────────────────
// PdfExtractor does `await import("pdfjs-dist/legacy/build/pdf.mjs")` at
// runtime, so we mock the module before importing.

function makePage(text: string) {
  return {
    getTextContent: vi.fn().mockResolvedValue({
      items: text ? text.split(" ").map((str) => ({ str })) : [],
    }),
    getViewport: vi.fn().mockReturnValue({ width: 100, height: 100 }),
    render: vi.fn().mockReturnValue({ promise: Promise.resolve() }),
  };
}

function makeDoc(pages: ReturnType<typeof makePage>[], meta?: Record<string, unknown>) {
  return {
    numPages: pages.length,
    getPage: vi.fn(async (num: number) => pages[num - 1]),
    getMetadata: vi.fn(async () => (meta ? { info: meta } : { info: {} })),
  };
}

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument: vi.fn(),
}));

// Also mock fs/promises since PdfExtractor reads the file
vi.mock("fs/promises", () => ({
  readFile: vi.fn().mockResolvedValue(Buffer.from("fake-pdf-bytes")),
}));

// Mock the canvas module (used by ocrPage)
vi.mock("canvas", () => ({
  createCanvas: vi.fn(() => ({
    getContext: vi.fn(() => ({})),
    toBuffer: vi.fn(() => Buffer.from("fake-png")),
  })),
}));

// Mock image.js ocrFromBuffer (used by ocrPage)
vi.mock("./image.js", () => ({
  ocrFromBuffer: vi.fn().mockResolvedValue({ text: "OCR text from page", confidence: 90 }),
}));

const { PdfExtractor } = await import("./pdf.js");
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

// ── Tests ───────────────────────────────────────────────────────────────────

describe("PdfExtractor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── canHandle ───────────────────────────────────────────────────────────
  describe("canHandle()", () => {
    const ext = new PdfExtractor();

    it("accepts .pdf files", () => {
      expect(ext.canHandle({ type: "file", path: "/docs/report.pdf" })).toBe(true);
    });

    it("accepts .PDF (case-insensitive)", () => {
      expect(ext.canHandle({ type: "file", path: "/docs/REPORT.PDF" })).toBe(true);
    });

    it("rejects non-pdf files", () => {
      expect(ext.canHandle({ type: "file", path: "/docs/readme.md" })).toBe(false);
    });

    it("rejects url source type", () => {
      expect(ext.canHandle({ type: "url", url: "https://example.com/file.pdf" })).toBe(false);
    });

    it("rejects file source without path", () => {
      expect(ext.canHandle({ type: "file" } as unknown as import("../types.js").Source)).toBe(
        false
      );
    });
  });

  // ── extract() — basic text extraction ──────────────────────────────────
  describe("extract() — text extraction", () => {
    it("extracts text from a single-page PDF", async () => {
      const longText =
        "This is a reasonably long paragraph with enough words to exceed the minimum text threshold of fifty characters easily";
      const page = makePage(longText);
      const doc = makeDoc([page]);
      (pdfjs.getDocument as ReturnType<typeof vi.fn>).mockReturnValue({
        promise: Promise.resolve(doc),
      });

      const ext = new PdfExtractor({ enableOcr: false });
      const result = await ext.extract({ type: "file", path: "/docs/report.pdf" });

      expect(result.text).toBe(longText.split(" ").join(" "));
      expect(result.sourceType).toBe("pdf");
      expect(result.mimeType).toBe("application/pdf");
    });

    it("extracts text from multi-page PDF", async () => {
      const text1 =
        "First page content that is long enough to pass the minimum text per page threshold of fifty characters";
      const text2 =
        "Second page content that is also long enough to pass the minimum text per page threshold quite easily";
      const doc = makeDoc([makePage(text1), makePage(text2)]);
      (pdfjs.getDocument as ReturnType<typeof vi.fn>).mockReturnValue({
        promise: Promise.resolve(doc),
      });

      const ext = new PdfExtractor({ enableOcr: false });
      const result = await ext.extract({ type: "file", path: "/docs/report.pdf" });

      expect(result.text).toContain("First");
      expect(result.text).toContain("Second");
      // Pages joined by double newline
      expect(result.text).toContain("\n\n");
    });

    it("throws when source has no path", async () => {
      const ext = new PdfExtractor();
      await expect(
        ext.extract({ type: "file" } as unknown as import("../types.js").Source)
      ).rejects.toThrow("requires a file path");
    });
  });

  // ── extract() — page limit ─────────────────────────────────────────────
  describe("extract() — maxPdfPages", () => {
    it("respects maxPdfPages limit", async () => {
      const longText =
        "Page content that is definitely long enough to exceed fifty characters for the minimum text per page threshold easily";
      const pages = Array.from({ length: 10 }, () => makePage(longText));
      const doc = makeDoc(pages);
      (pdfjs.getDocument as ReturnType<typeof vi.fn>).mockReturnValue({
        promise: Promise.resolve(doc),
      });

      const ext = new PdfExtractor({ enableOcr: false, limits: { maxPdfPages: 3 } });
      const result = await ext.extract({ type: "file", path: "/docs/big.pdf" });

      // Only first 3 pages should be processed
      expect(doc.getPage).toHaveBeenCalledTimes(3);
      expect(result.metadata.pages).toBe(10); // total pages
      expect(result.metadata.pagesCapped).toBe(3); // capped at
    });

    it("does not set pagesCapped when all pages fit", async () => {
      const longText =
        "Enough content to exceed the fifty character threshold for minimum text per page detection in the PDF extractor";
      const doc = makeDoc([makePage(longText), makePage(longText)]);
      (pdfjs.getDocument as ReturnType<typeof vi.fn>).mockReturnValue({
        promise: Promise.resolve(doc),
      });

      const ext = new PdfExtractor({ enableOcr: false, limits: { maxPdfPages: 200 } });
      const result = await ext.extract({ type: "file", path: "/docs/small.pdf" });

      expect(result.metadata.pagesCapped).toBeUndefined();
    });
  });

  // ── extract() — metadata ───────────────────────────────────────────────
  describe("extract() — metadata", () => {
    it("includes PDF metadata (title, author)", async () => {
      const longText =
        "Enough words to satisfy the fifty character minimum text per page requirement for the PDF text extraction logic";
      const doc = makeDoc([makePage(longText)], { Title: "My Report", Author: "Jane Doe" });
      (pdfjs.getDocument as ReturnType<typeof vi.fn>).mockReturnValue({
        promise: Promise.resolve(doc),
      });

      const ext = new PdfExtractor({ enableOcr: false });
      const result = await ext.extract({ type: "file", path: "/docs/report.pdf" });

      expect(result.metadata.title).toBe("My Report");
      expect(result.metadata.author).toBe("Jane Doe");
    });

    it("includes filename in metadata", async () => {
      const longText =
        "Long text content that definitely surpasses the fifty character threshold for minimum page text detection";
      const doc = makeDoc([makePage(longText)]);
      (pdfjs.getDocument as ReturnType<typeof vi.fn>).mockReturnValue({
        promise: Promise.resolve(doc),
      });

      const ext = new PdfExtractor({ enableOcr: false });
      const result = await ext.extract({ type: "file", path: "/docs/my-report.pdf" });

      expect(result.metadata.filename).toBe("my-report.pdf");
    });

    it("handles metadata extraction failure gracefully", async () => {
      const longText =
        "Enough content to pass the minimum text per page threshold for the PDF extraction process cleanly";
      const doc = makeDoc([makePage(longText)]);
      doc.getMetadata.mockRejectedValue(new Error("no metadata"));
      (pdfjs.getDocument as ReturnType<typeof vi.fn>).mockReturnValue({
        promise: Promise.resolve(doc),
      });

      const ext = new PdfExtractor({ enableOcr: false });
      const result = await ext.extract({ type: "file", path: "/docs/report.pdf" });

      // Should still succeed, just without title/author
      expect(result.text).toBeTruthy();
      expect(result.metadata.title).toBeUndefined();
    });
  });

  // ── extract() — OCR fallback ───────────────────────────────────────────
  describe("extract() — OCR fallback", () => {
    it("falls back to OCR when page text is below MIN_TEXT_PER_PAGE", async () => {
      // Page with very little text (< 50 chars)
      const page = makePage("short");
      const doc = makeDoc([page]);
      (pdfjs.getDocument as ReturnType<typeof vi.fn>).mockReturnValue({
        promise: Promise.resolve(doc),
      });

      const ext = new PdfExtractor({ enableOcr: true });
      const result = await ext.extract({ type: "file", path: "/docs/scanned.pdf" });

      expect(result.text).toContain("OCR text from page");
      expect(result.metadata.ocrPages).toBe(1);
      expect(result.metadata.ocrLanguage).toBe("eng");
    });

    it("uses regular text when page text exceeds MIN_TEXT_PER_PAGE", async () => {
      const longText =
        "This paragraph has enough text content to be well above the fifty character minimum threshold for text detection";
      const doc = makeDoc([makePage(longText)]);
      (pdfjs.getDocument as ReturnType<typeof vi.fn>).mockReturnValue({
        promise: Promise.resolve(doc),
      });

      const ext = new PdfExtractor({ enableOcr: true });
      const result = await ext.extract({ type: "file", path: "/docs/normal.pdf" });

      // Should NOT have used OCR
      expect(result.metadata.ocrPages).toBeUndefined();
    });

    it("skips OCR when enableOcr is false, but keeps short text", async () => {
      const page = makePage("tiny text");
      const doc = makeDoc([page]);
      (pdfjs.getDocument as ReturnType<typeof vi.fn>).mockReturnValue({
        promise: Promise.resolve(doc),
      });

      const ext = new PdfExtractor({ enableOcr: false });
      const result = await ext.extract({ type: "file", path: "/docs/scanned.pdf" });

      // Should still include the short text, just not OCR'd
      expect(result.text).toContain("tiny");
      expect(result.metadata.ocrPages).toBeUndefined();
    });

    it("handles OCR failure gracefully (falls back to short text)", async () => {
      const { ocrFromBuffer } = await import("./image.js");
      (ocrFromBuffer as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("OCR crash"));

      const page = makePage("fallback text");
      const doc = makeDoc([page]);
      (pdfjs.getDocument as ReturnType<typeof vi.fn>).mockReturnValue({
        promise: Promise.resolve(doc),
      });

      const ext = new PdfExtractor({ enableOcr: true });
      const result = await ext.extract({ type: "file", path: "/docs/bad-ocr.pdf" });

      // Should fall back to the short text
      expect(result.text).toContain("fallback");
    });
  });
});
