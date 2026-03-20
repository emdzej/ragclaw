import { describe, it, expect } from "vitest";
import { parseGitHubUrl, getSourceUrl } from "./index.js";

describe("parseGitHubUrl", () => {
  it("parses github://owner/repo as repo type", () => {
    const result = parseGitHubUrl("github://octocat/hello-world");
    expect(result).toEqual({
      owner: "octocat",
      repo: "hello-world",
      type: "repo",
    });
  });

  it("parses gh:// scheme", () => {
    const result = parseGitHubUrl("gh://octocat/hello-world");
    expect(result).toEqual({
      owner: "octocat",
      repo: "hello-world",
      type: "repo",
    });
  });

  it("parses issues listing", () => {
    const result = parseGitHubUrl("github://octocat/hello-world/issues");
    expect(result).toEqual({
      owner: "octocat",
      repo: "hello-world",
      type: "issues",
    });
  });

  it("parses specific issue", () => {
    const result = parseGitHubUrl("github://octocat/hello-world/issues/42");
    expect(result).toEqual({
      owner: "octocat",
      repo: "hello-world",
      type: "issue",
      number: 42,
    });
  });

  it("parses pulls listing", () => {
    const result = parseGitHubUrl("github://octocat/hello-world/pulls");
    expect(result).toEqual({
      owner: "octocat",
      repo: "hello-world",
      type: "pulls",
    });
  });

  it("parses specific PR", () => {
    const result = parseGitHubUrl("github://octocat/hello-world/pulls/5");
    expect(result).toEqual({
      owner: "octocat",
      repo: "hello-world",
      type: "pr",
      number: 5,
    });
  });

  it("parses discussions", () => {
    const result = parseGitHubUrl("github://octocat/hello-world/discussions");
    expect(result).toEqual({
      owner: "octocat",
      repo: "hello-world",
      type: "discussions",
    });
  });

  it("handles repos with dots and underscores", () => {
    const result = parseGitHubUrl("github://my_org/my.repo-name");
    expect(result).toEqual({
      owner: "my_org",
      repo: "my.repo-name",
      type: "repo",
    });
  });

  it("returns null for invalid scheme", () => {
    expect(parseGitHubUrl("https://github.com/foo/bar")).toBeNull();
    expect(parseGitHubUrl("gitlab://foo/bar")).toBeNull();
  });

  it("returns null for missing repo", () => {
    expect(parseGitHubUrl("github://owner")).toBeNull();
  });

  it("returns null for invalid content type", () => {
    expect(parseGitHubUrl("github://foo/bar/commits")).toBeNull();
    expect(parseGitHubUrl("github://foo/bar/wiki")).toBeNull();
  });

  it("returns null for invalid issue number", () => {
    // negative
    expect(parseGitHubUrl("github://foo/bar/issues/-1")).toBeNull();
    // zero
    expect(parseGitHubUrl("github://foo/bar/issues/0")).toBeNull();
  });

  it("rejects owner with special characters", () => {
    expect(parseGitHubUrl("github://foo bar/repo")).toBeNull();
    expect(parseGitHubUrl("github://foo@bar/repo")).toBeNull();
    expect(parseGitHubUrl("github://foo/bar/../evil/issues")).toBeNull();
  });
});

describe("getSourceUrl", () => {
  it("returns url when present", () => {
    expect(getSourceUrl({ type: "url", url: "http://example.com" })).toBe("http://example.com");
  });

  it("returns path when url is absent", () => {
    expect(getSourceUrl({ type: "file", path: "/tmp/file.txt" })).toBe("/tmp/file.txt");
  });

  it("prefers url over path", () => {
    expect(getSourceUrl({ type: "url", url: "http://x.com", path: "/tmp/f" })).toBe("http://x.com");
  });

  it("returns empty string when neither is present", () => {
    expect(getSourceUrl({ type: "text" })).toBe("");
  });
});
