import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock tesseract.js ───────────────────────────────────────────────────────
const mockRecognize = vi.fn();

vi.mock("tesseract.js", () => ({
  default: {
    recognize: (...args: unknown[]) => mockRecognize(...args),
  },
}));

const { ImageExtractor, ocrFromBuffer } = await import("./image.js");

// ── Helpers ─────────────────────────────────────────────────────────────────

function fakeOcrResult(text: string, confidence: number, blocks = 3) {
  return {
    data: {
      text,
      confidence,
      blocks: Array.from({ length: blocks }),
    },
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("ImageExtractor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRecognize.mockResolvedValue(fakeOcrResult("Hello World\n", 95, 2));
  });

  // ── canHandle ───────────────────────────────────────────────────────────
  describe("canHandle()", () => {
    const ext = new ImageExtractor();

    it.each([
      ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".tif",
    ])("accepts %s files", (extension) => {
      expect(ext.canHandle({ type: "file", path: `/img/photo${extension}` })).toBe(true);
    });

    it("accepts uppercase extensions", () => {
      expect(ext.canHandle({ type: "file", path: "/img/PHOTO.PNG" })).toBe(true);
    });

    it("rejects non-image files", () => {
      expect(ext.canHandle({ type: "file", path: "/docs/readme.md" })).toBe(false);
      expect(ext.canHandle({ type: "file", path: "/docs/data.pdf" })).toBe(false);
    });

    it("rejects url source type", () => {
      expect(ext.canHandle({ type: "url", url: "https://example.com/img.png" })).toBe(false);
    });

    it("rejects file source without path", () => {
      expect(ext.canHandle({ type: "file" })).toBe(false);
    });
  });

  // ── extract() — basic OCR ──────────────────────────────────────────────
  describe("extract()", () => {
    it("extracts text via OCR", async () => {
      const ext = new ImageExtractor();
      const result = await ext.extract({ type: "file", path: "/img/photo.png" });

      expect(result.text).toBe("Hello World");
      expect(result.sourceType).toBe("text");
      expect(mockRecognize).toHaveBeenCalledWith(
        "/img/photo.png",
        "eng",
        expect.objectContaining({ logger: expect.any(Function) }),
      );
    });

    it("throws when source has no path", async () => {
      const ext = new ImageExtractor();
      await expect(ext.extract({ type: "file" })).rejects.toThrow("requires a file path");
    });

    it("uses custom language", async () => {
      const ext = new ImageExtractor({ language: "deu" });
      await ext.extract({ type: "file", path: "/img/german.png" });

      expect(mockRecognize).toHaveBeenCalledWith(
        "/img/german.png",
        "deu",
        expect.anything(),
      );
    });
  });

  // ── extract() — metadata ───────────────────────────────────────────────
  describe("extract() — metadata", () => {
    it("includes filename, confidence, language, and block count", async () => {
      const ext = new ImageExtractor();
      const result = await ext.extract({ type: "file", path: "/img/scan.jpg" });

      expect(result.metadata).toMatchObject({
        filename: "scan.jpg",
        ocrConfidence: 95,
        language: "eng",
        blocks: 2,
      });
    });
  });

  // ── extract() — MIME type ──────────────────────────────────────────────
  describe("extract() — mimeType", () => {
    it.each([
      ["/img/photo.png", "image/png"],
      ["/img/photo.jpg", "image/jpeg"],
      ["/img/photo.jpeg", "image/jpeg"],
      ["/img/photo.gif", "image/gif"],
      ["/img/photo.webp", "image/webp"],
      ["/img/photo.bmp", "image/bmp"],
      ["/img/photo.tiff", "image/tiff"],
      ["/img/photo.tif", "image/tiff"],
    ])("returns correct MIME type for %s", async (path, expectedMime) => {
      const ext = new ImageExtractor();
      const result = await ext.extract({ type: "file", path });

      expect(result.mimeType).toBe(expectedMime);
    });
  });

  // ── extract() — timeout ────────────────────────────────────────────────
  describe("extract() — timeout", () => {
    it("rejects when OCR exceeds timeout", async () => {
      mockRecognize.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 5000)),
      );

      const ext = new ImageExtractor({ limits: { ocrTimeoutMs: 50 } });
      await expect(ext.extract({ type: "file", path: "/img/slow.png" }))
        .rejects.toThrow("OCR timed out");
    });
  });
});

// ── ocrFromBuffer() ─────────────────────────────────────────────────────────

describe("ocrFromBuffer()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRecognize.mockResolvedValue(fakeOcrResult("Buffer OCR text\n", 88));
  });

  it("extracts text from a buffer", async () => {
    const buf = Buffer.from("fake-image-bytes");
    const result = await ocrFromBuffer(buf);

    expect(result.text).toBe("Buffer OCR text");
    expect(result.confidence).toBe(88);
    expect(mockRecognize).toHaveBeenCalledWith(
      buf,
      "eng",
      expect.objectContaining({ logger: expect.any(Function) }),
    );
  });

  it("uses custom language", async () => {
    const buf = Buffer.from("fake-image-bytes");
    await ocrFromBuffer(buf, "fra");

    expect(mockRecognize).toHaveBeenCalledWith(buf, "fra", expect.anything());
  });

  it("rejects when OCR exceeds timeout", async () => {
    mockRecognize.mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 5000)),
    );

    const buf = Buffer.from("fake");
    await expect(ocrFromBuffer(buf, "eng", 50))
      .rejects.toThrow("OCR timed out");
  });
});
