import * as cheerio from "cheerio";
import type { Extractor, ExtractedContent, Source } from "../types.js";
import type { ExtractorLimits } from "../config.js";
import { DEFAULT_EXTRACTOR_LIMITS } from "../config.js";

type CheerioElement = ReturnType<ReturnType<typeof cheerio.load>>[number];

export class WebExtractor implements Extractor {
  private fetchTimeoutMs: number;
  private maxResponseSizeBytes: number;

  constructor(limits?: Partial<ExtractorLimits>) {
    this.fetchTimeoutMs = limits?.fetchTimeoutMs ?? DEFAULT_EXTRACTOR_LIMITS.fetchTimeoutMs;
    this.maxResponseSizeBytes = limits?.maxResponseSizeBytes ?? DEFAULT_EXTRACTOR_LIMITS.maxResponseSizeBytes;
  }

  canHandle(source: Source): boolean {
    if (source.type !== "url" || !source.url) return false;
    return source.url.startsWith("http://") || source.url.startsWith("https://");
  }

  async extract(source: Source): Promise<ExtractedContent> {
    if (!source.url) {
      throw new Error("WebExtractor requires a URL");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.fetchTimeoutMs);

    let response: Response;
    try {
      response = await fetch(source.url, {
        headers: {
          "User-Agent": "RagClaw/0.1 (local RAG indexer)",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        signal: controller.signal,
      });
    } catch (err: unknown) {
      clearTimeout(timer);
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new Error(`Fetch timed out after ${this.fetchTimeoutMs}ms: ${source.url}`);
      }
      throw err;
    }

    if (!response.ok) {
      clearTimeout(timer);
      throw new Error(`Failed to fetch ${source.url}: ${response.status} ${response.statusText}`);
    }

    // Stream the body, enforcing a byte-size cap
    const html = await this.readBodyWithLimit(response, source.url);
    clearTimeout(timer);

    const contentType = response.headers.get("content-type") || "";

    const $ = cheerio.load(html);

    // Remove non-content elements
    $("script, style, nav, footer, header, aside, iframe, noscript").remove();
    $("[role='navigation'], [role='banner'], [role='contentinfo']").remove();
    $(".sidebar, .nav, .menu, .footer, .header, .advertisement, .ad").remove();

    // Extract metadata
    const metadata: Record<string, unknown> = {
      url: source.url,
      title: $("title").text().trim() || $("h1").first().text().trim(),
    };

    // Open Graph / meta tags
    const ogTitle = $('meta[property="og:title"]').attr("content");
    const ogDescription = $('meta[property="og:description"]').attr("content");
    const description = $('meta[name="description"]').attr("content");
    const author = $('meta[name="author"]').attr("content");

    if (ogTitle) metadata.ogTitle = ogTitle;
    if (ogDescription || description) metadata.description = ogDescription || description;
    if (author) metadata.author = author;

    // Try to find main content
    let mainContent = $("main, article, [role='main'], .content, .post, .article").first();
    if (mainContent.length === 0) {
      mainContent = $("body");
    }

    // Extract text, preserving some structure
    const text = this.extractText(mainContent, $);

    return {
      text,
      metadata,
      sourceType: "web",
      mimeType: contentType.split(";")[0].trim() || "text/html",
    };
  }

  /**
   * Read the response body, aborting if it exceeds `maxResponseSizeBytes`.
   */
  private async readBodyWithLimit(response: Response, url: string): Promise<string> {
    // If no body stream (e.g. older runtimes), fall back to .text()
    if (!response.body) {
      const text = await response.text();
      if (text.length > this.maxResponseSizeBytes) {
        throw new Error(
          `Response body (${text.length} bytes) exceeds limit (${this.maxResponseSizeBytes} bytes): ${url}`
        );
      }
      return text;
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > this.maxResponseSizeBytes) {
        reader.cancel();
        throw new Error(
          `Response body (>${this.maxResponseSizeBytes} bytes) exceeds limit: ${url}`
        );
      }
      chunks.push(value);
    }

    const decoder = new TextDecoder();
    return chunks.map((c) => decoder.decode(c, { stream: true })).join("") + decoder.decode();
  }

  private extractText(element: cheerio.Cheerio<CheerioElement>, $: cheerio.CheerioAPI): string {
    const lines: string[] = [];

    element.find("h1, h2, h3, h4, h5, h6, p, li, td, th, blockquote, pre, code").each((_, el) => {
      const $el = $(el);
      const tagName = el.tagName.toLowerCase();
      let text = $el.text().trim();

      if (!text) return;

      // Add markdown-style formatting for headings
      if (tagName.startsWith("h")) {
        const level = parseInt(tagName[1], 10);
        text = "#".repeat(level) + " " + text;
      }

      // Add bullet for list items
      if (tagName === "li") {
        text = "• " + text;
      }

      lines.push(text);
    });

    // Dedupe consecutive identical lines and join
    const deduped = lines.filter((line, i) => i === 0 || line !== lines[i - 1]);
    return deduped.join("\n\n");
  }
}
