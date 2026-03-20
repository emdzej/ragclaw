import { describe, it, expect } from "vitest";
import { extractVideoId, decodeHtmlEntities, formatTimestamp } from "./index.js";

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
    expect(decodeHtmlEntities('&quot;hello&#39;')).toBe('"hello\'');
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
