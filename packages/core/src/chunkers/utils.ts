/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import type { ExtractedContent } from "../types.js";

/**
 * Returns true when `content` matches any of the given sourceTypes **or**
 * any of the given MIME type prefixes.
 *
 * MIME matching uses prefix comparison so that parameterised values like
 * `"text/html; charset=utf-8"` still match the pattern `"text/html"`.
 *
 * @param sourceTypes - ContentType keys accepted by this chunker (e.g. `["markdown", "web"]`).
 * @param mimeTypes   - MIME type prefixes accepted by this chunker (e.g. `["text/html"]`).
 * @param content     - The extracted content to test.
 */
export function matchesContent(
  sourceTypes: readonly string[],
  mimeTypes: readonly string[],
  content: ExtractedContent
): boolean {
  if (sourceTypes.includes(content.sourceType)) return true;

  if (content.mimeType) {
    const mime = content.mimeType.toLowerCase();
    for (const pattern of mimeTypes) {
      if (mime === pattern || mime.startsWith(`${pattern};`)) return true;
    }
  }

  return false;
}
