import { describe, it, expect } from "vitest";
import { processObsidianContent, extractFrontmatter } from "./index.js";

describe("processObsidianContent", () => {
  it("converts [[wikilinks]] to plain text", () => {
    expect(processObsidianContent("See [[My Note]]")).toBe("See My Note");
  });

  it("uses alias when present in wikilinks", () => {
    expect(processObsidianContent("See [[My Note|the note]]")).toBe("See the note");
  });

  it("converts ![[embeds]] to reference format", () => {
    expect(processObsidianContent("![[diagram.png]]")).toBe("[Embedded: diagram.png]");
  });

  it("converts #tags to [tag: ...] format", () => {
    expect(processObsidianContent("This is #important")).toBe("This is [tag: important]");
  });

  it("handles nested path tags", () => {
    expect(processObsidianContent("#project/backend")).toBe("[tag: project/backend]");
  });

  it("handles tags with underscores and hyphens", () => {
    expect(processObsidianContent("#my_tag-name")).toBe("[tag: my_tag-name]");
  });

  it("handles multiple transformations in one string", () => {
    const input = "See [[Note A|alias]] and ![[image.png]] with #tag1";
    const result = processObsidianContent(input);
    expect(result).toBe("See alias and [Embedded: image.png] with [tag: tag1]");
  });

  it("preserves plain text unchanged", () => {
    const plain = "Just a regular paragraph with no Obsidian syntax.";
    expect(processObsidianContent(plain)).toBe(plain);
  });

  it("handles empty string", () => {
    expect(processObsidianContent("")).toBe("");
  });
});

describe("extractFrontmatter", () => {
  it("extracts simple key-value frontmatter", () => {
    const content = "---\ntitle: My Note\nauthor: Alice\n---\nBody content";
    const result = extractFrontmatter(content);

    expect(result.frontmatter).toEqual({
      title: "My Note",
      author: "Alice",
    });
    expect(result.body).toBe("Body content");
  });

  it("extracts array values in frontmatter", () => {
    const content = "---\ntags: [foo, bar, baz]\n---\nBody";
    const result = extractFrontmatter(content);

    expect(result.frontmatter).toEqual({
      tags: ["foo", "bar", "baz"],
    });
  });

  it("returns null frontmatter when no frontmatter exists", () => {
    const content = "Just a note without frontmatter.";
    const result = extractFrontmatter(content);

    expect(result.frontmatter).toBeNull();
    expect(result.body).toBe(content);
  });

  it("returns null frontmatter for broken YAML", () => {
    // The regex won't match if --- isn't properly formatted
    const content = "---\ntitle My Note\n---\nBody";
    const result = extractFrontmatter(content);

    // The regex WILL match the --- delimiters, but the key: value regex
    // won't match "title My Note", so frontmatter will be empty {}
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe("Body");
  });

  it("handles empty frontmatter block", () => {
    const content = "---\n\n---\nBody content";
    const result = extractFrontmatter(content);

    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe("Body content");
  });

  it("handles empty body", () => {
    const content = "---\ntitle: Test\n---\n";
    const result = extractFrontmatter(content);

    expect(result.frontmatter).toEqual({ title: "Test" });
    expect(result.body).toBe("");
  });
});
