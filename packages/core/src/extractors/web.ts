/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import * as cheerio from "cheerio";
import type { Extractor, ExtractedContent, Source } from "../types.js";
import type { ExtractorLimits } from "../config.js";
import { DEFAULT_EXTRACTOR_LIMITS } from "../config.js";

type CheerioElement = ReturnType<ReturnType<typeof cheerio.load>>[number];

// ---------------------------------------------------------------------------
// Crawl types
// ---------------------------------------------------------------------------

export interface CrawlOptions {
  /** Maximum link depth from the start URL (default: 3). */
  maxDepth?: number;
  /** Maximum number of pages to crawl (default: 100). */
  maxPages?: number;
  /** Stay on the same origin as the start URL (default: true). */
  sameOrigin?: boolean;
  /** Glob-style path prefixes to include (e.g. ["/docs/**"]). */
  include?: string[];
  /** Glob-style path prefixes to exclude (e.g. ["/blog/**"]). */
  exclude?: string[];
  /** Number of concurrent fetch requests (default: 1). */
  concurrency?: number;
  /** Delay between requests in milliseconds (default: 1000). */
  delayMs?: number;
  /** When true, skip robots.txt checks (default: false). */
  ignoreRobots?: boolean;
}

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

  // ---------------------------------------------------------------------------
  // Crawl support
  // ---------------------------------------------------------------------------

  /**
   * Crawl a site starting from `startUrl`, yielding an `ExtractedContent` for
   * each successfully fetched page.
   *
   * The crawl is BFS-ordered: pages at depth N are fully processed before any
   * page at depth N+1 is enqueued.  Visited URLs are tracked by their
   * normalised href (no hash fragment, no trailing slash variation) so redirect
   * chains and duplicate links are naturally deduplicated.
   */
  async *crawl(
    startUrl: string,
    options: CrawlOptions = {},
  ): AsyncGenerator<ExtractedContent & { url: string }> {
    const maxDepth = options.maxDepth ?? 3;
    const maxPages = options.maxPages ?? 100;
    const sameOrigin = options.sameOrigin ?? true;
    const concurrency = Math.max(1, options.concurrency ?? 1);
    const delayMs = options.delayMs ?? 1000;
    const ignoreRobots = options.ignoreRobots ?? false;

    const origin = new URL(startUrl).origin;

    // robots.txt cache: origin → Set of disallowed path prefixes
    const robotsCache = new Map<string, Set<string>>();

    if (!ignoreRobots) {
      const disallowed = await this.fetchRobotsTxt(origin);
      robotsCache.set(origin, disallowed);
    }

    // BFS queue: [url, depth]
    type QueueEntry = { url: string; depth: number };
    const queue: QueueEntry[] = [{ url: this.normaliseUrl(startUrl), depth: 0 }];
    const visited = new Set<string>([this.normaliseUrl(startUrl)]);
    let pagesIndexed = 0;

    while (queue.length > 0 && pagesIndexed < maxPages) {
      // Take up to `concurrency` entries from the front of the queue
      const batch = queue.splice(0, concurrency);

      const results = await Promise.allSettled(
        batch.map(async ({ url, depth }) => {
          // robots.txt check
          if (!ignoreRobots) {
            const urlObj = new URL(url);
            let disallowed = robotsCache.get(urlObj.origin);
            if (!disallowed) {
              disallowed = await this.fetchRobotsTxt(urlObj.origin);
              robotsCache.set(urlObj.origin, disallowed);
            }
            if (this.isRobotsDisallowed(urlObj.pathname, disallowed)) {
              return null;
            }
          }

          // include/exclude path filters
          const pathname = new URL(url).pathname;
          if (options.include && options.include.length > 0) {
            if (!options.include.some((p) => pathname.startsWith(p.replace(/\*\*$/, "")))) {
              return null;
            }
          }
          if (options.exclude && options.exclude.length > 0) {
            if (options.exclude.some((p) => pathname.startsWith(p.replace(/\*\*$/, "")))) {
              return null;
            }
          }

          const source: Source = { type: "url", url };
          const extracted = await this.extract(source);

          // Discover links for next depth if we haven't hit maxDepth yet
          let links: string[] = [];
          if (depth < maxDepth) {
            links = await this.extractLinks(url, sameOrigin ? origin : null);
          }

          return { extracted, links, url, depth };
        }),
      );

      for (const result of results) {
        if (pagesIndexed >= maxPages) break;
        if (result.status === "rejected" || result.value === null) continue;

        const { extracted, links, url, depth } = result.value;

        yield { ...extracted, url };
        pagesIndexed++;

        // Enqueue undiscovered links
        for (const link of links) {
          const norm = this.normaliseUrl(link);
          if (!visited.has(norm)) {
            visited.add(norm);
            queue.push({ url: norm, depth: depth + 1 });
          }
        }
      }

      // Polite delay between batches (skip after the last batch)
      if (queue.length > 0 && pagesIndexed < maxPages && delayMs > 0) {
        await this.sleep(delayMs);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Crawl helpers
  // ---------------------------------------------------------------------------

  /** Remove hash fragments and normalise trailing slashes for dedup. */
  private normaliseUrl(raw: string): string {
    try {
      const u = new URL(raw);
      u.hash = "";
      // Normalise: strip trailing slash from path (except root "/")
      if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
        u.pathname = u.pathname.slice(0, -1);
      }
      return u.toString();
    } catch {
      return raw;
    }
  }

  /**
   * Extract all `<a href>` links from a fetched page that are same-origin
   * (when `allowedOrigin` is set) and have an http(s) scheme.
   */
  private async extractLinks(pageUrl: string, allowedOrigin: string | null): Promise<string[]> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.fetchTimeoutMs);
      let response: Response;
      try {
        response = await fetch(pageUrl, {
          headers: {
            "User-Agent": "RagClaw/0.1 (local RAG indexer)",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) return [];

      const html = await this.readBodyWithLimit(response, pageUrl);
      const $ = cheerio.load(html);
      const base = new URL(pageUrl);
      const links: string[] = [];

      $("a[href]").each((_, el) => {
        const href = $(el).attr("href");
        if (!href) return;
        try {
          const resolved = new URL(href, base);
          if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return;
          if (allowedOrigin && resolved.origin !== allowedOrigin) return;
          links.push(resolved.toString());
        } catch {
          // Ignore malformed hrefs
        }
      });

      return links;
    } catch {
      return [];
    }
  }

  /**
   * Fetch and parse robots.txt for the given origin.
   * Returns a Set of disallowed path prefixes for `User-agent: *` and
   * `User-agent: RagClaw`.  On any fetch error, returns an empty set
   * (allow-all).
   */
  private async fetchRobotsTxt(origin: string): Promise<Set<string>> {
    const disallowed = new Set<string>();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      let response: Response;
      try {
        response = await fetch(`${origin}/robots.txt`, {
          headers: { "User-Agent": "RagClaw/0.1" },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) return disallowed;

      const text = await response.text();
      let applicable = false;

      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (line.startsWith("#") || line === "") {
          applicable = false;
          continue;
        }
        const [field, ...rest] = line.split(":");
        const value = rest.join(":").trim();

        if (field.toLowerCase() === "user-agent") {
          applicable = value === "*" || value.toLowerCase() === "ragclaw";
        } else if (applicable && field.toLowerCase() === "disallow" && value) {
          disallowed.add(value);
        }
      }
    } catch {
      // Network error → treat as allow-all
    }
    return disallowed;
  }

  /** Returns true if `pathname` matches any disallowed prefix. */
  private isRobotsDisallowed(pathname: string, disallowed: Set<string>): boolean {
    for (const prefix of disallowed) {
      if (pathname.startsWith(prefix)) return true;
    }
    return false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}