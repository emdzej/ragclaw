/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

// ── Mock child_process so `gh()` calls don't shell out ──────────────────────
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSourceUrl, parseGitHubUrl } from "./index.js";

vi.mock("child_process", () => ({
  execFileSync: vi.fn(),
}));
const mockExecFileSync = vi.mocked(execFileSync);

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

// ── GitHubExtractor.extract() tests ─────────────────────────────────────────
// The extract() method is accessed via the plugin's `extractors[0]` entry.

describe("GitHubExtractor.extract()", () => {
  let extractor: {
    canHandle: (s: { type: string; url?: string }) => boolean;
    extract: (s: {
      type: string;
      url?: string;
    }) => Promise<{ text: string; metadata: Record<string, unknown>; sourceType: string }>;
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("./index.js");
    extractor = mod.default.extractors?.[0] as typeof extractor;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── canHandle ─────────────────────────────────────────────────────────
  describe("canHandle()", () => {
    it("accepts github:// URLs", () => {
      expect(extractor.canHandle({ type: "url", url: "github://owner/repo" })).toBe(true);
    });

    it("accepts gh:// URLs", () => {
      expect(extractor.canHandle({ type: "url", url: "gh://owner/repo" })).toBe(true);
    });

    it("rejects https://github.com URLs", () => {
      expect(extractor.canHandle({ type: "url", url: "https://github.com/owner/repo" })).toBe(
        false
      );
    });
  });

  // ── extract: repo ─────────────────────────────────────────────────────
  describe("repo type", () => {
    it("fetches repo info and README", async () => {
      mockExecFileSync
        .mockReturnValueOnce(JSON.stringify({ name: "hello-world", description: "A test repo" }))
        .mockReturnValueOnce(
          "name:\thello-world\ndescription:\tA test repo\n--\n# Hello\n\nWelcome to my repo."
        );

      const result = await extractor.extract({ type: "url", url: "github://octocat/hello-world" });

      expect(result.text).toContain("# hello-world");
      expect(result.text).toContain("A test repo");
      expect(result.text).toContain("Welcome to my repo");
      expect(result.sourceType).toBe("markdown");
      expect(result.metadata.type).toBe("github-repo");
      expect(result.metadata.owner).toBe("octocat");
      expect(result.metadata.repo).toBe("hello-world");
    });
  });

  // ── extract: issues listing ───────────────────────────────────────────
  describe("issues type", () => {
    it("fetches and formats issues", async () => {
      const issues = [
        {
          number: 1,
          title: "Bug report",
          body: "Something broke",
          author: { login: "alice" },
          labels: [{ name: "bug" }],
          state: "OPEN",
          createdAt: "2024-01-01",
        },
        {
          number: 2,
          title: "Feature req",
          body: "Add something",
          author: { login: "bob" },
          labels: [],
          state: "CLOSED",
          createdAt: "2024-01-02",
        },
      ];
      mockExecFileSync.mockReturnValueOnce(JSON.stringify(issues));

      const result = await extractor.extract({
        type: "url",
        url: "github://octocat/hello-world/issues",
      });

      expect(result.text).toContain("# Issues: octocat/hello-world");
      expect(result.text).toContain("## #1: Bug report");
      expect(result.text).toContain("Something broke");
      expect(result.text).toContain("**Labels:** bug");
      expect(result.text).toContain("## #2: Feature req");
      expect(result.metadata.type).toBe("github-issues");
      expect(result.metadata.count).toBe(2);
    });
  });

  // ── extract: single issue ─────────────────────────────────────────────
  describe("issue type", () => {
    it("fetches single issue with comments", async () => {
      const issue = {
        number: 42,
        title: "Critical bug",
        body: "This is a serious issue",
        author: { login: "alice" },
        labels: [{ name: "critical" }],
        state: "OPEN",
        createdAt: "2024-01-01",
        comments: [{ author: { login: "bob" }, body: "Looking into it", createdAt: "2024-01-02" }],
      };
      mockExecFileSync.mockReturnValueOnce(JSON.stringify(issue));

      const result = await extractor.extract({
        type: "url",
        url: "github://octocat/hello-world/issues/42",
      });

      expect(result.text).toContain("# Issue #42: Critical bug");
      expect(result.text).toContain("This is a serious issue");
      expect(result.text).toContain("## Comments (1)");
      expect(result.text).toContain("Looking into it");
      expect(result.metadata.type).toBe("github-issue");
      expect(result.metadata.number).toBe(42);
    });
  });

  // ── extract: pulls listing ────────────────────────────────────────────
  describe("pulls type", () => {
    it("fetches and formats PRs", async () => {
      const prs = [
        {
          number: 10,
          title: "Add feature",
          body: "New cool stuff",
          author: { login: "carol" },
          labels: [],
          state: "OPEN",
          createdAt: "2024-02-01",
        },
      ];
      mockExecFileSync.mockReturnValueOnce(JSON.stringify(prs));

      const result = await extractor.extract({
        type: "url",
        url: "github://octocat/hello-world/pulls",
      });

      expect(result.text).toContain("# Pull Requests: octocat/hello-world");
      expect(result.text).toContain("## #10: Add feature");
      expect(result.metadata.type).toBe("github-pulls");
      expect(result.metadata.count).toBe(1);
    });
  });

  // ── extract: single PR ────────────────────────────────────────────────
  describe("pr type", () => {
    it("fetches single PR with reviews and comments", async () => {
      const pr = {
        number: 5,
        title: "Refactor auth",
        body: "Major refactor",
        author: { login: "dave" },
        labels: [{ name: "refactor" }],
        state: "MERGED",
        createdAt: "2024-02-15",
        reviews: [{ author: { login: "eve" }, state: "APPROVED", body: "LGTM" }],
        comments: [{ author: { login: "frank" }, body: "Nice work!", createdAt: "2024-02-16" }],
      };
      mockExecFileSync.mockReturnValueOnce(JSON.stringify(pr));

      const result = await extractor.extract({
        type: "url",
        url: "github://octocat/hello-world/pulls/5",
      });

      expect(result.text).toContain("# PR #5: Refactor auth");
      expect(result.text).toContain("Major refactor");
      expect(result.text).toContain("## Reviews (1)");
      expect(result.text).toContain("LGTM");
      expect(result.text).toContain("## Comments (1)");
      expect(result.text).toContain("Nice work!");
      expect(result.metadata.type).toBe("github-pr");
      expect(result.metadata.number).toBe(5);
      expect(result.metadata.state).toBe("MERGED");
    });
  });

  // ── extract: discussions ──────────────────────────────────────────────
  describe("discussions type", () => {
    it("fetches discussions via API", async () => {
      const discussions = [
        {
          title: "Question about X",
          body: "How does X work?",
          user: { login: "grace" },
          created_at: "2024-03-01",
          category: { name: "Q&A" },
        },
      ];
      mockExecFileSync.mockReturnValueOnce(JSON.stringify(discussions));

      const result = await extractor.extract({
        type: "url",
        url: "github://octocat/hello-world/discussions",
      });

      expect(result.text).toContain("# Discussions: octocat/hello-world");
      expect(result.text).toContain("## Question about X");
      expect(result.text).toContain("How does X work?");
      expect(result.text).toContain("**Category:** Q&A");
      expect(result.metadata.type).toBe("github-discussions");
      expect(result.metadata.count).toBe(1);
    });
  });

  // ── extract: error cases ──────────────────────────────────────────────
  describe("error handling", () => {
    it("throws on invalid GitHub URL", async () => {
      await expect(extractor.extract({ type: "url", url: "github://invalid" })).rejects.toThrow(
        "Invalid GitHub URL"
      );
    });

    it("throws when gh CLI fails", async () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error("gh: not found");
      });

      await expect(
        extractor.extract({ type: "url", url: "github://octocat/hello-world" })
      ).rejects.toThrow("gh CLI failed");
    });
  });
});
