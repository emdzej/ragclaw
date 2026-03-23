/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { describe, expect, it } from "vitest";
import type { ContentType, ExtractedContent } from "../types.js";
import { matchesContent } from "./utils.js";

function makeContent(sourceType: string, mimeType?: string): ExtractedContent {
  return { text: "", metadata: {}, sourceType: sourceType as ContentType, mimeType };
}

describe("matchesContent", () => {
  const SOURCE_TYPES = ["markdown", "text", "web"] as const;
  const MIME_TYPES = ["text/html", "application/xhtml+xml", "text/plain"] as const;

  describe("sourceType matching", () => {
    it("returns true when sourceType is in the list", () => {
      expect(matchesContent(SOURCE_TYPES, MIME_TYPES, makeContent("markdown"))).toBe(true);
    });

    it("returns true for 'web' sourceType", () => {
      expect(matchesContent(SOURCE_TYPES, MIME_TYPES, makeContent("web"))).toBe(true);
    });

    it("returns false when sourceType is not in the list", () => {
      expect(matchesContent(SOURCE_TYPES, MIME_TYPES, makeContent("code"))).toBe(false);
    });

    it("returns false for unknown sourceType with no mimeType", () => {
      expect(matchesContent(SOURCE_TYPES, MIME_TYPES, makeContent("pdf"))).toBe(false);
    });
  });

  describe("MIME type prefix matching", () => {
    it("returns true for exact MIME type match", () => {
      expect(matchesContent([], MIME_TYPES, makeContent("pdf", "text/html"))).toBe(true);
    });

    it("returns true when mimeType has charset parameter suffix", () => {
      expect(matchesContent([], MIME_TYPES, makeContent("pdf", "text/html; charset=utf-8"))).toBe(
        true
      );
    });

    it("returns true when mimeType has charset parameter with no space", () => {
      expect(matchesContent([], MIME_TYPES, makeContent("pdf", "text/html;charset=utf-8"))).toBe(
        true
      );
    });

    it("returns true for application/xhtml+xml with params", () => {
      expect(
        matchesContent([], MIME_TYPES, makeContent("pdf", "application/xhtml+xml; charset=utf-8"))
      ).toBe(true);
    });

    it("returns false for a MIME type not in the list", () => {
      expect(matchesContent([], MIME_TYPES, makeContent("pdf", "application/pdf"))).toBe(false);
    });

    it("returns false when mimeType is undefined", () => {
      expect(matchesContent([], MIME_TYPES, makeContent("pdf", undefined))).toBe(false);
    });

    it("is case-insensitive for MIME types", () => {
      expect(matchesContent([], MIME_TYPES, makeContent("pdf", "Text/HTML"))).toBe(true);
    });

    it("does NOT match a partial MIME type prefix that is not a full token", () => {
      // "text/htmlextra" should NOT match "text/html" because delimiter is ';'
      expect(matchesContent([], MIME_TYPES, makeContent("pdf", "text/htmlextra"))).toBe(false);
    });
  });

  describe("sourceType takes priority over mimeType", () => {
    it("returns true when sourceType matches even if mimeType does not", () => {
      expect(
        matchesContent(SOURCE_TYPES, MIME_TYPES, makeContent("markdown", "application/pdf"))
      ).toBe(true);
    });

    it("returns true when mimeType matches even if sourceType does not", () => {
      expect(matchesContent(SOURCE_TYPES, MIME_TYPES, makeContent("code", "text/html"))).toBe(true);
    });
  });

  describe("empty lists", () => {
    it("returns false when both lists are empty", () => {
      expect(matchesContent([], [], makeContent("markdown", "text/html"))).toBe(false);
    });

    it("returns false with empty sourceTypes but matching mimeType", () => {
      expect(matchesContent([], MIME_TYPES, makeContent("code", "text/html"))).toBe(true);
    });
  });
});
