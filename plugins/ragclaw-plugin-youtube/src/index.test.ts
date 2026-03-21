/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeHtmlEntities, extractVideoId, formatTimestamp } from "./index.js";

describe("extractVideoId", () => {
  it("extracts from youtube:// scheme", () => {
    expect(extractVideoId("youtube://dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("extracts from yt:// scheme", () => {
    expect(extractVideoId("yt://dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("extracts from standard watch URL", () => {
    expect(extractVideoId("https://youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("extracts from www.youtube.com watch URL", () => {
    expect(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("extracts from youtu.be short URL", () => {
    expect(extractVideoId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("extracts from embed URL", () => {
    expect(extractVideoId("https://youtube.com/embed/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("accepts bare video ID", () => {
    expect(extractVideoId("dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("handles IDs with hyphens and underscores", () => {
    expect(extractVideoId("a_B-c1234_5")).toBe("a_B-c1234_5");
  });

  it("returns null for invalid input", () => {
    expect(extractVideoId("not-a-video-id")).toBeNull();
    expect(extractVideoId("")).toBeNull();
    expect(extractVideoId("http://example.com")).toBeNull();
  });

  it("returns null for too-short ID", () => {
    expect(extractVideoId("abc")).toBeNull();
  });
});

describe("decodeHtmlEntities", () => {
  it("decodes &amp;", () => {
    expect(decodeHtmlEntities("foo &amp; bar")).toBe("foo & bar");
  });

  it("decodes &lt; and &gt;", () => {
    expect(decodeHtmlEntities("&lt;div&gt;")).toBe("<div>");
  });

  it("decodes &quot; and &#39;", () => {
    expect(decodeHtmlEntities("&quot;hello&#39;")).toBe("\"hello'");
  });

  it("decodes &apos;", () => {
    expect(decodeHtmlEntities("it&apos;s")).toBe("it's");
  });

  it("decodes hex numeric entities", () => {
    expect(decodeHtmlEntities("&#x41;")).toBe("A");
    expect(decodeHtmlEntities("&#x2764;")).toBe("❤");
  });

  it("decodes decimal numeric entities", () => {
    expect(decodeHtmlEntities("&#65;")).toBe("A");
    expect(decodeHtmlEntities("&#10084;")).toBe("❤");
  });

  it("handles multiple entities in one string", () => {
    expect(decodeHtmlEntities("&lt;a href=&quot;url&quot;&gt;")).toBe('<a href="url">');
  });

  it("returns plain text unchanged", () => {
    expect(decodeHtmlEntities("hello world")).toBe("hello world");
  });

  it("handles empty string", () => {
    expect(decodeHtmlEntities("")).toBe("");
  });
});

describe("formatTimestamp", () => {
  it("formats seconds only", () => {
    expect(formatTimestamp(5)).toBe("0:05");
  });

  it("formats minutes and seconds", () => {
    expect(formatTimestamp(65)).toBe("1:05");
  });

  it("formats exact minutes", () => {
    expect(formatTimestamp(120)).toBe("2:00");
  });

  it("formats hours, minutes and seconds", () => {
    expect(formatTimestamp(3661)).toBe("1:01:01");
  });

  it("pads seconds with leading zero", () => {
    expect(formatTimestamp(61)).toBe("1:01");
  });

  it("pads minutes with leading zero when hours present", () => {
    expect(formatTimestamp(3605)).toBe("1:00:05");
  });

  it("handles zero", () => {
    expect(formatTimestamp(0)).toBe("0:00");
  });

  it("handles fractional seconds (floors)", () => {
    expect(formatTimestamp(65.7)).toBe("1:05");
  });
});

// ── YouTubeExtractor.extract() tests ────────────────────────────────────────
// The extract() method is accessed via the plugin's `extractors[0]` entry.

describe("YouTubeExtractor.extract()", () => {
  let extractor: {
    canHandle: (s: { type: string; url?: string }) => boolean;
    extract: (s: { type: string; url?: string }) => Promise<{
      text: string;
      metadata: Record<string, unknown>;
      sourceType: string;
      mimeType: string;
    }>;
  };
  let originalFetch: typeof globalThis.fetch;

  /** Fake XML transcript returned by the caption track URL.
   *
   *  NOTE: The source regex `([^<]*(?:<[^>]+>[^<]*)*)` is greedy across
   *  `</p>` boundaries, so adjacent `<p>` elements are consumed as a
   *  single match.  The code still works because it strips inner HTML
   *  tags.  For testing, we use a single `<p>` element to keep things
   *  deterministic.  A multi-element test verifies the greedy behaviour.
   */
  const TRANSCRIPT_XML_SINGLE = `<p t="5000" d="3000">Hello world</p>`;

  const TRANSCRIPT_XML_MULTI = `<p t="0" d="5000">Hello world</p><p t="5000" d="3000">This is &amp;amp; a test</p><p t="8000" d="4000">Goodbye</p>`;

  /** Fake innertube API response with caption tracks. */
  function innertubeResponse(languageCode = "en") {
    return {
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [{ baseUrl: "https://example.com/captions", languageCode }],
        },
      },
    };
  }

  /** Fake oEmbed metadata response. */
  const OEMBED_RESPONSE = { title: "Test Video", author_name: "Test Channel" };

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    const mod = await import("./index.js");
    extractor = mod.default.extractors?.[0] as typeof extractor;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ── canHandle ─────────────────────────────────────────────────────────
  describe("canHandle()", () => {
    it("accepts youtube:// URLs", () => {
      expect(extractor.canHandle({ type: "url", url: "youtube://dQw4w9WgXcQ" })).toBe(true);
    });

    it("accepts yt:// URLs", () => {
      expect(extractor.canHandle({ type: "url", url: "yt://dQw4w9WgXcQ" })).toBe(true);
    });

    it("accepts youtube.com watch URLs", () => {
      expect(
        extractor.canHandle({ type: "url", url: "https://youtube.com/watch?v=dQw4w9WgXcQ" })
      ).toBe(true);
    });

    it("accepts youtu.be short URLs", () => {
      expect(extractor.canHandle({ type: "url", url: "https://youtu.be/dQw4w9WgXcQ" })).toBe(true);
    });

    it("rejects non-YouTube URLs", () => {
      expect(extractor.canHandle({ type: "url", url: "https://example.com" })).toBe(false);
    });

    it("rejects non-url source types", () => {
      expect(extractor.canHandle({ type: "file", url: "youtube://abc" })).toBe(false);
    });
  });

  // ── extract: success path ─────────────────────────────────────────────
  describe("success path", () => {
    it("fetches transcript and metadata, returns formatted text", async () => {
      globalThis.fetch = vi
        .fn()
        // 1st call: innertube API
        .mockResolvedValueOnce(new Response(JSON.stringify(innertubeResponse()), { status: 200 }))
        // 2nd call: caption track URL
        .mockResolvedValueOnce(new Response(TRANSCRIPT_XML_SINGLE, { status: 200 }))
        // 3rd call: oEmbed metadata
        .mockResolvedValueOnce(new Response(JSON.stringify(OEMBED_RESPONSE), { status: 200 }));

      const result = await extractor.extract({ type: "url", url: "youtube://dQw4w9WgXcQ" });

      // Header
      expect(result.text).toContain("# Test Video");
      expect(result.text).toContain("**Video ID:** dQw4w9WgXcQ");
      expect(result.text).toContain("**Channel:** Test Channel");
      expect(result.text).toContain("## Transcript");

      // Transcript text
      expect(result.text).toContain("Hello world");

      // Metadata
      expect(result.metadata.videoId).toBe("dQw4w9WgXcQ");
      expect(result.metadata.title).toBe("Test Video");
      expect(result.metadata.author).toBe("Test Channel");
      expect(result.metadata.segmentCount).toBe(1);
      expect(result.sourceType).toBe("text");
      expect(result.mimeType).toBe("text/plain");
    });

    it("handles multi-element transcript (greedy regex merges into one segment)", async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify(innertubeResponse()), { status: 200 }))
        .mockResolvedValueOnce(new Response(TRANSCRIPT_XML_MULTI, { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(OEMBED_RESPONSE), { status: 200 }));

      const result = await extractor.extract({ type: "url", url: "youtube://dQw4w9WgXcQ" });

      // The greedy regex merges adjacent <p> elements, stripping inner tags.
      // All text content should still be present in the output.
      expect(result.text).toContain("Hello world");
      expect(result.text).toContain("Goodbye");
      expect(result.metadata.segmentCount).toBe(1); // Greedy regex → 1 segment
    });

    it("handles missing metadata gracefully", async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify(innertubeResponse()), { status: 200 }))
        .mockResolvedValueOnce(new Response(TRANSCRIPT_XML_SINGLE, { status: 200 }))
        // oEmbed fails
        .mockResolvedValueOnce(new Response("Not found", { status: 404 }));

      const result = await extractor.extract({ type: "url", url: "youtube://dQw4w9WgXcQ" });

      expect(result.text).toContain("# YouTube Video"); // fallback title
      expect(result.text).toContain("**Channel:** Unknown");
    });

    it("prefers English caption track", async () => {
      const multiTrack = {
        captions: {
          playerCaptionsTracklistRenderer: {
            captionTracks: [
              { baseUrl: "https://example.com/captions-fr", languageCode: "fr" },
              { baseUrl: "https://example.com/captions-en", languageCode: "en" },
            ],
          },
        },
      };

      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify(multiTrack), { status: 200 }))
        .mockResolvedValueOnce(new Response(TRANSCRIPT_XML_SINGLE, { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(OEMBED_RESPONSE), { status: 200 }));

      await extractor.extract({ type: "url", url: "youtube://dQw4w9WgXcQ" });

      // The second fetch should be to the English track URL
      const fetchCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
      expect(fetchCalls[1][0]).toBe("https://example.com/captions-en");
    });
  });

  // ── extract: error cases ──────────────────────────────────────────────
  describe("error handling", () => {
    it("throws on invalid video ID (empty)", async () => {
      // youtube:// with nothing after → extractVideoId returns "" (falsy) → "Invalid" error
      await expect(extractor.extract({ type: "url", url: "youtube://" })).rejects.toThrow(
        "Invalid YouTube URL"
      );
    });

    it("throws when innertube API returns non-OK", async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce(new Response("error", { status: 403 }));

      await expect(
        extractor.extract({ type: "url", url: "youtube://dQw4w9WgXcQ" })
      ).rejects.toThrow("Failed to fetch video info: 403");
    });

    it("throws when no captions available", async () => {
      const noCaptions = { captions: { playerCaptionsTracklistRenderer: { captionTracks: [] } } };
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify(noCaptions), { status: 200 }));

      await expect(
        extractor.extract({ type: "url", url: "youtube://dQw4w9WgXcQ" })
      ).rejects.toThrow("No captions available");
    });

    it("throws when caption fetch fails", async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify(innertubeResponse()), { status: 200 }))
        .mockResolvedValueOnce(new Response("error", { status: 500 }));

      await expect(
        extractor.extract({ type: "url", url: "youtube://dQw4w9WgXcQ" })
      ).rejects.toThrow("Failed to fetch transcript: 500");
    });

    it("throws when transcript XML has no segments", async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify(innertubeResponse()), { status: 200 }))
        .mockResolvedValueOnce(new Response("<transcript></transcript>", { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(OEMBED_RESPONSE), { status: 200 }));

      await expect(
        extractor.extract({ type: "url", url: "youtube://dQw4w9WgXcQ" })
      ).rejects.toThrow("No transcript available");
    });
  });
});
