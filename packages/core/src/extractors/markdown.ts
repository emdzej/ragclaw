/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { readFile, stat } from "fs/promises";
import { basename, extname } from "path";
import type { Extractor, ExtractedContent, Source } from "../types.js";

export class MarkdownExtractor implements Extractor {
  canHandle(source: Source): boolean {
    if (source.type !== "file" || !source.path) return false;
    const ext = extname(source.path).toLowerCase();
    return [".md", ".markdown", ".mdx"].includes(ext);
  }

  async extract(source: Source): Promise<ExtractedContent> {
    if (!source.path) {
      throw new Error("MarkdownExtractor requires a file path");
    }

    const content = await readFile(source.path, "utf-8");
    const metadata = this.extractMetadata(content, source.path);

    return {
      text: this.removeYamlFrontmatter(content),
      metadata,
      sourceType: "markdown",
      mimeType: "text/markdown",
    };
  }

  private extractMetadata(content: string, path: string): Record<string, unknown> {
    const metadata: Record<string, unknown> = {
      filename: basename(path),
    };

    // Extract YAML frontmatter
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (frontmatterMatch) {
      const yaml = frontmatterMatch[1];
      // Simple YAML parsing (key: value pairs)
      for (const line of yaml.split("\n")) {
        const match = line.match(/^(\w+):\s*(.+)$/);
        if (match) {
          metadata[match[1]] = match[2].replace(/^["']|["']$/g, "");
        }
      }
    }

    // Extract title from first heading if not in frontmatter
    if (!metadata.title) {
      const headingMatch = content.match(/^#\s+(.+)$/m);
      if (headingMatch) {
        metadata.title = headingMatch[1];
      }
    }

    return metadata;
  }

  private removeYamlFrontmatter(content: string): string {
    return content.replace(/^---\n[\s\S]*?\n---\n*/, "");
  }
}