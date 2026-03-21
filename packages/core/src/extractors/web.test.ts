/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WebExtractor } from "./web.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal HTML page for testing. */
function html(body: string, head = ""): string {
  return `<!DOCTYPE html><html><head>${head}</head><body>${body}</body></html>`;
}

/** Create a fake Response with streaming body support. */
function fakeResponse(
  body: string,
  opts: { status?: number; statusText?: string; contentType?: string; streamBody?: boolean } = {},
): Response {
  const status = opts.status ?? 200;
  const statusText = opts.statusText ?? "OK";
  const headers = new Headers({ "content-type": opts.contentType ?? "text/html; charset=utf-8" });

  if (opts.streamBody === false) {
    // Return response without readable stream body (simulates old runtimes)
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText,
      headers,
      body: null,
      text: async () => body,
    } as unknown as Response;
  }

  return new Response(body, { status, statusText, headers });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("WebExtractor", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ── canHandle ───────────────────────────────────────────────────────────
  describe("canHandle()", () => {
    const ext = new WebExtractor();

    it("accepts http:// URLs", () => {
      expect(ext.canHandle({ type: "url", url: "http://example.com" })).toBe(true);
    });

    it("accepts https:// URLs", () => {
      expect(ext.canHandle({ type: "url", url: "https://example.com/page" })).toBe(true);
    });

    it("rejects non-url source types", () => {
      expect(ext.canHandle({ type: "file", path: "http://foo.html" })).toBe(false);
    });

    it("rejects url sources without url field", () => {
      expect(ext.canHandle({ type: "url" })).toBe(false);
    });

    it("rejects ftp:// URLs", () => {
      expect(ext.canHandle({ type: "url", url: "ftp://example.com" })).toBe(false);
    });
  });

  // ── extract() basic ────────────────────────────────────────────────────
  describe("extract() — basic extraction", () => {
    it("extracts text from a simple page", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        fakeResponse(html("<main><h1>Title</h1><p>Hello world</p></main>")),
      );

      const ext = new WebExtractor();
      const result = await ext.extract({ type: "url", url: "https://example.com" });

      expect(result.text).toContain("# Title");
      expect(result.text).toContain("Hello world");
      expect(result.sourceType).toBe("web");
      expect(result.mimeType).toBe("text/html");
    });

    it("throws when source has no URL", async () => {
      const ext = new WebExtractor();
      await expect(ext.extract({ type: "url" })).rejects.toThrow("requires a URL");
    });

    it("throws on non-OK HTTP response", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        fakeResponse("Not Found", { status: 404, statusText: "Not Found" }),
      );

      const ext = new WebExtractor();
      await expect(ext.extract({ type: "url", url: "https://example.com/missing" }))
        .rejects.toThrow("404 Not Found");
    });
  });

  // ── Metadata extraction ────────────────────────────────────────────────
  describe("extract() — metadata", () => {
    it("extracts title from <title>", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        fakeResponse(html("<p>content</p>", "<title>My Page Title</title>")),
      );

      const ext = new WebExtractor();
      const result = await ext.extract({ type: "url", url: "https://example.com" });

      expect(result.metadata.title).toBe("My Page Title");
    });

    it("falls back to <h1> for title when <title> is empty", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        fakeResponse(html("<h1>Heading Title</h1><p>content</p>")),
      );

      const ext = new WebExtractor();
      const result = await ext.extract({ type: "url", url: "https://example.com" });

      expect(result.metadata.title).toBe("Heading Title");
    });

    it("extracts Open Graph metadata", async () => {
      const head = `
        <meta property="og:title" content="OG Title">
        <meta property="og:description" content="OG Desc">
        <meta name="author" content="John Doe">
      `;
      globalThis.fetch = vi.fn().mockResolvedValue(
        fakeResponse(html("<p>content</p>", head)),
      );

      const ext = new WebExtractor();
      const result = await ext.extract({ type: "url", url: "https://example.com" });

      expect(result.metadata.ogTitle).toBe("OG Title");
      expect(result.metadata.description).toBe("OG Desc");
      expect(result.metadata.author).toBe("John Doe");
    });

    it("falls back to meta[name=description] when og:description absent", async () => {
      const head = `<meta name="description" content="Meta Desc">`;
      globalThis.fetch = vi.fn().mockResolvedValue(
        fakeResponse(html("<p>content</p>", head)),
      );

      const ext = new WebExtractor();
      const result = await ext.extract({ type: "url", url: "https://example.com" });

      expect(result.metadata.description).toBe("Meta Desc");
    });

    it("includes the source URL in metadata", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        fakeResponse(html("<p>text</p>")),
      );

      const ext = new WebExtractor();
      const result = await ext.extract({ type: "url", url: "https://example.com/page" });

      expect(result.metadata.url).toBe("https://example.com/page");
    });
  });

  // ── Content cleaning ───────────────────────────────────────────────────
  describe("extract() — content cleaning", () => {
    it("removes script and style elements", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        fakeResponse(html(`
          <script>alert("xss")</script>
          <style>body{color:red}</style>
          <main><p>Clean content</p></main>
        `)),
      );

      const ext = new WebExtractor();
      const result = await ext.extract({ type: "url", url: "https://example.com" });

      expect(result.text).toContain("Clean content");
      expect(result.text).not.toContain("alert");
      expect(result.text).not.toContain("color:red");
    });

    it("removes nav, footer, header, aside, iframe, noscript", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        fakeResponse(html(`
          <nav><p>Nav link</p></nav>
          <footer><p>Footer text</p></footer>
          <header><p>Header text</p></header>
          <aside><p>Sidebar</p></aside>
          <main><p>Main content</p></main>
        `)),
      );

      const ext = new WebExtractor();
      const result = await ext.extract({ type: "url", url: "https://example.com" });

      expect(result.text).toContain("Main content");
      expect(result.text).not.toContain("Nav link");
      expect(result.text).not.toContain("Footer text");
      expect(result.text).not.toContain("Header text");
      expect(result.text).not.toContain("Sidebar");
    });

    it("removes elements by role attribute", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        fakeResponse(html(`
          <div role="navigation"><p>Role nav</p></div>
          <div role="banner"><p>Role banner</p></div>
          <main><p>Keep this</p></main>
        `)),
      );

      const ext = new WebExtractor();
      const result = await ext.extract({ type: "url", url: "https://example.com" });

      expect(result.text).toContain("Keep this");
      expect(result.text).not.toContain("Role nav");
      expect(result.text).not.toContain("Role banner");
    });

    it("removes elements by class name (.sidebar, .ad, etc.)", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        fakeResponse(html(`
          <div class="advertisement"><p>Buy stuff</p></div>
          <main><p>Article text</p></main>
        `)),
      );

      const ext = new WebExtractor();
      const result = await ext.extract({ type: "url", url: "https://example.com" });

      expect(result.text).toContain("Article text");
      expect(result.text).not.toContain("Buy stuff");
    });
  });

  // ── Text formatting ────────────────────────────────────────────────────
  describe("extract() — text formatting", () => {
    it("adds markdown heading prefixes", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        fakeResponse(html(`
          <article>
            <h1>H1</h1>
            <h2>H2</h2>
            <h3>H3</h3>
          </article>
        `)),
      );

      const ext = new WebExtractor();
      const result = await ext.extract({ type: "url", url: "https://example.com" });

      expect(result.text).toContain("# H1");
      expect(result.text).toContain("## H2");
      expect(result.text).toContain("### H3");
    });

    it("adds bullet markers to list items", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        fakeResponse(html(`
          <article>
            <ul><li>Item one</li><li>Item two</li></ul>
          </article>
        `)),
      );

      const ext = new WebExtractor();
      const result = await ext.extract({ type: "url", url: "https://example.com" });

      expect(result.text).toContain("• Item one");
      expect(result.text).toContain("• Item two");
    });

    it("deduplicates consecutive identical lines", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        fakeResponse(html(`
          <article>
            <p>Same text</p>
            <p>Same text</p>
            <p>Different text</p>
          </article>
        `)),
      );

      const ext = new WebExtractor();
      const result = await ext.extract({ type: "url", url: "https://example.com" });

      // "Same text" should appear only once
      const occurrences = result.text.split("Same text").length - 1;
      expect(occurrences).toBe(1);
    });

    it("prefers <main>/<article> content over full <body>", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        fakeResponse(html(`
          <div><p>Outside article</p></div>
          <article><p>Inside article</p></article>
        `)),
      );

      const ext = new WebExtractor();
      const result = await ext.extract({ type: "url", url: "https://example.com" });

      expect(result.text).toContain("Inside article");
      // The "Outside article" paragraph is NOT inside article, so shouldn't be found
      // (article is found first by the selector, only its children are extracted)
      expect(result.text).not.toContain("Outside article");
    });
  });

  // ── Response size limits ───────────────────────────────────────────────
  describe("extract() — response size limit", () => {
    it("enforces maxResponseSizeBytes via streaming", async () => {
      // Create a response body that exceeds the limit
      const bigBody = "x".repeat(200);
      globalThis.fetch = vi.fn().mockResolvedValue(
        fakeResponse(bigBody),
      );

      const ext = new WebExtractor({ maxResponseSizeBytes: 100 });
      await expect(ext.extract({ type: "url", url: "https://example.com" }))
        .rejects.toThrow("exceeds limit");
    });

    it("enforces maxResponseSizeBytes when body is null (fallback path)", async () => {
      const bigBody = "x".repeat(200);
      globalThis.fetch = vi.fn().mockResolvedValue(
        fakeResponse(bigBody, { streamBody: false }),
      );

      const ext = new WebExtractor({ maxResponseSizeBytes: 100 });
      await expect(ext.extract({ type: "url", url: "https://example.com" }))
        .rejects.toThrow("exceeds limit");
    });

    it("allows responses within the size limit", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        fakeResponse(html("<p>Small page</p>")),
      );

      const ext = new WebExtractor({ maxResponseSizeBytes: 10_000 });
      const result = await ext.extract({ type: "url", url: "https://example.com" });

      expect(result.text).toContain("Small page");
    });
  });

  // ── Timeout ────────────────────────────────────────────────────────────
  describe("extract() — fetch timeout", () => {
    it("aborts fetch when timeout expires", async () => {
      globalThis.fetch = vi.fn().mockImplementation(
        (_url: string, opts: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            opts.signal.addEventListener("abort", () => {
              const err = new DOMException("The operation was aborted", "AbortError");
              reject(err);
            });
          }),
      );

      const ext = new WebExtractor({ fetchTimeoutMs: 50 });
      await expect(ext.extract({ type: "url", url: "https://example.com" }))
        .rejects.toThrow("timed out");
    });
  });

  // ── Fetch headers ──────────────────────────────────────────────────────
  describe("extract() — request configuration", () => {
    it("sends User-Agent and Accept headers", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        fakeResponse(html("<p>ok</p>")),
      );
      globalThis.fetch = mockFetch;

      const ext = new WebExtractor();
      await ext.extract({ type: "url", url: "https://example.com" });

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.headers["User-Agent"]).toContain("RagClaw");
      expect(opts.headers["Accept"]).toContain("text/html");
    });
  });
});