import { describe, it, expect } from "vitest";
import { TextExtractor } from "./text.js";
import { MarkdownExtractor } from "./markdown.js";
import { CodeExtractor } from "./code.js";
import { WebExtractor } from "./web.js";
import { PdfExtractor } from "./pdf.js";
import { DocxExtractor } from "./docx.js";
import { ImageExtractor } from "./image.js";
import type { Source } from "../types.js";

describe("Extractor canHandle", () => {
  describe("TextExtractor", () => {
    const ext = new TextExtractor();

    it("handles inline text sources", () => {
      expect(ext.canHandle({ type: "text", content: "hello" })).toBe(true);
    });

    it("handles .txt files", () => {
      expect(ext.canHandle({ type: "file", path: "/tmp/doc.txt" })).toBe(true);
    });

    it("handles .text files", () => {
      expect(ext.canHandle({ type: "file", path: "/tmp/doc.text" })).toBe(true);
    });

    it("handles files with no extension", () => {
      expect(ext.canHandle({ type: "file", path: "/tmp/README" })).toBe(true);
    });

    it("does not handle .md files", () => {
      expect(ext.canHandle({ type: "file", path: "/tmp/doc.md" })).toBe(false);
    });

    it("does not handle URL sources", () => {
      expect(ext.canHandle({ type: "url", url: "http://example.com" })).toBe(false);
    });
  });

  describe("MarkdownExtractor", () => {
    const ext = new MarkdownExtractor();

    it("handles .md files", () => {
      expect(ext.canHandle({ type: "file", path: "/tmp/doc.md" })).toBe(true);
    });

    it("handles .markdown files", () => {
      expect(ext.canHandle({ type: "file", path: "/tmp/doc.markdown" })).toBe(true);
    });

    it("handles .mdx files", () => {
      expect(ext.canHandle({ type: "file", path: "/tmp/doc.mdx" })).toBe(true);
    });

    it("is case-insensitive on extension", () => {
      expect(ext.canHandle({ type: "file", path: "/tmp/doc.MD" })).toBe(true);
    });

    it("does not handle .txt files", () => {
      expect(ext.canHandle({ type: "file", path: "/tmp/doc.txt" })).toBe(false);
    });

    it("does not handle non-file sources", () => {
      expect(ext.canHandle({ type: "url", url: "http://example.com/doc.md" })).toBe(false);
    });
  });

  describe("CodeExtractor", () => {
    const ext = new CodeExtractor();

    it.each([
      [".ts", "TypeScript"],
      [".tsx", "TypeScript JSX"],
      [".js", "JavaScript"],
      [".jsx", "JavaScript JSX"],
      [".mjs", "ES module"],
      [".cjs", "CommonJS"],
      [".py", "Python"],
      [".go", "Go"],
      [".java", "Java"],
    ])("handles %s files (%s)", (extension) => {
      expect(ext.canHandle({ type: "file", path: `/tmp/file${extension}` })).toBe(true);
    });

    it("does not handle unknown extensions", () => {
      expect(ext.canHandle({ type: "file", path: "/tmp/file.rs" })).toBe(false);
      expect(ext.canHandle({ type: "file", path: "/tmp/file.rb" })).toBe(false);
      expect(ext.canHandle({ type: "file", path: "/tmp/file.c" })).toBe(false);
    });

    it("does not handle non-file sources", () => {
      expect(ext.canHandle({ type: "text", content: "code" })).toBe(false);
    });
  });

  describe("WebExtractor", () => {
    const ext = new WebExtractor();

    it("handles http:// URLs", () => {
      expect(ext.canHandle({ type: "url", url: "http://example.com" })).toBe(true);
    });

    it("handles https:// URLs", () => {
      expect(ext.canHandle({ type: "url", url: "https://example.com/page" })).toBe(true);
    });

    it("does not handle non-http URLs", () => {
      expect(ext.canHandle({ type: "url", url: "ftp://example.com" })).toBe(false);
    });

    it("does not handle file sources", () => {
      expect(ext.canHandle({ type: "file", path: "/tmp/page.html" })).toBe(false);
    });

    it("does not handle sources without url", () => {
      expect(ext.canHandle({ type: "url" })).toBe(false);
    });
  });

  describe("PdfExtractor", () => {
    const ext = new PdfExtractor();

    it("handles .pdf files", () => {
      expect(ext.canHandle({ type: "file", path: "/tmp/doc.pdf" })).toBe(true);
    });

    it("is case-insensitive", () => {
      expect(ext.canHandle({ type: "file", path: "/tmp/doc.PDF" })).toBe(true);
    });

    it("does not handle non-pdf files", () => {
      expect(ext.canHandle({ type: "file", path: "/tmp/doc.docx" })).toBe(false);
    });

    it("does not handle non-file sources", () => {
      expect(ext.canHandle({ type: "url", url: "http://example.com/doc.pdf" })).toBe(false);
    });
  });

  describe("DocxExtractor", () => {
    const ext = new DocxExtractor();

    it("handles .docx files", () => {
      expect(ext.canHandle({ type: "file", path: "/tmp/doc.docx" })).toBe(true);
    });

    it("is case-insensitive", () => {
      expect(ext.canHandle({ type: "file", path: "/tmp/doc.DOCX" })).toBe(true);
    });

    it("does not handle .doc files (old format)", () => {
      expect(ext.canHandle({ type: "file", path: "/tmp/doc.doc" })).toBe(false);
    });

    it("does not handle non-file sources", () => {
      expect(ext.canHandle({ type: "url", url: "http://example.com/doc.docx" })).toBe(false);
    });
  });

  describe("ImageExtractor", () => {
    const ext = new ImageExtractor();

    it.each([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".tif"])(
      "handles %s files",
      (extension) => {
        expect(ext.canHandle({ type: "file", path: `/tmp/image${extension}` })).toBe(true);
      }
    );

    it("is case-insensitive", () => {
      expect(ext.canHandle({ type: "file", path: "/tmp/image.PNG" })).toBe(true);
      expect(ext.canHandle({ type: "file", path: "/tmp/image.JPG" })).toBe(true);
    });

    it("does not handle .svg files", () => {
      expect(ext.canHandle({ type: "file", path: "/tmp/image.svg" })).toBe(false);
    });

    it("does not handle non-file sources", () => {
      expect(ext.canHandle({ type: "url", url: "http://example.com/image.png" })).toBe(false);
    });
  });
});

describe("TextExtractor.extract (inline text)", () => {
  const ext = new TextExtractor();

  it("extracts inline text content", async () => {
    const source: Source = { type: "text", content: "Hello world" };
    const result = await ext.extract(source);

    expect(result.text).toBe("Hello world");
    expect(result.sourceType).toBe("text");
    expect(result.mimeType).toBe("text/plain");
    expect(result.metadata.name).toBe("inline-text");
  });

  it("uses custom name for inline text", async () => {
    const source: Source = { type: "text", content: "Hello", name: "greeting" };
    const result = await ext.extract(source);

    expect(result.metadata.name).toBe("greeting");
  });

  it("throws when neither content nor path is provided", async () => {
    const source: Source = { type: "text" };
    await expect(ext.extract(source)).rejects.toThrow("requires content or file path");
  });
});
