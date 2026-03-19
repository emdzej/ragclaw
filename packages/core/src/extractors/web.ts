import * as cheerio from "cheerio";
import type { Extractor, ExtractedContent, Source } from "../types.js";

type CheerioElement = ReturnType<ReturnType<typeof cheerio.load>>[number];

export class WebExtractor implements Extractor {
  canHandle(source: Source): boolean {
    if (source.type !== "url" || !source.url) return false;
    return source.url.startsWith("http://") || source.url.startsWith("https://");
  }

  async extract(source: Source): Promise<ExtractedContent> {
    if (!source.url) {
      throw new Error("WebExtractor requires a URL");
    }

    const response = await fetch(source.url, {
      headers: {
        "User-Agent": "RagClaw/0.1 (local RAG indexer)",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch ${source.url}: ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get("content-type") || "";
    const html = await response.text();

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
