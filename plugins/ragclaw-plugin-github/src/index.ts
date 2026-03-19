import type { RagClawPlugin, Extractor, ExtractedContent, Source } from "@emdzej/ragclaw-core";
import { execSync } from "child_process";

/**
 * GitHub content types
 */
type GitHubContentType = "repo" | "issues" | "issue" | "pulls" | "pr" | "discussions";

interface ParsedGitHubUrl {
  owner: string;
  repo: string;
  type: GitHubContentType;
  number?: number;
}

/**
 * Parse GitHub URL scheme
 * Formats:
 *   github://owner/repo           - README + docs
 *   github://owner/repo/issues    - all issues
 *   github://owner/repo/issues/30 - specific issue
 *   github://owner/repo/pulls     - all PRs
 *   github://owner/repo/pulls/5   - specific PR
 *   github://owner/repo/discussions - discussions
 */
function parseGitHubUrl(source: string): ParsedGitHubUrl | null {
  // Remove scheme
  const match = source.match(/^(?:github|gh):\/\/(.+)$/);
  if (!match) return null;

  const path = match[1];
  const parts = path.split("/");

  if (parts.length < 2) return null;

  const owner = parts[0];
  const repo = parts[1];
  const type = parts[2] as GitHubContentType | undefined;
  const number = parts[3] ? parseInt(parts[3], 10) : undefined;

  if (!type) {
    return { owner, repo, type: "repo" };
  }

  if (type === "issues" || type === "pulls" || type === "discussions") {
    if (number && !isNaN(number)) {
      return { owner, repo, type: type === "issues" ? "issue" : type === "pulls" ? "pr" : type, number };
    }
    return { owner, repo, type };
  }

  return null;
}

/**
 * Execute gh CLI command
 */
function gh(args: string): string {
  try {
    return execSync(`gh ${args}`, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
  } catch (error) {
    throw new Error(`gh CLI failed: ${error}`);
  }
}

/**
 * Fetch repository README and docs
 */
async function fetchRepo(owner: string, repo: string): Promise<ExtractedContent> {
  // Get repo info
  const infoJson = gh(`repo view ${owner}/${repo} --json name,description`);
  const info = JSON.parse(infoJson);

  // Get README (plain text output includes it)
  const readmeOutput = gh(`repo view ${owner}/${repo}`);
  // Extract content after the header
  const readmeMatch = readmeOutput.match(/^name:\t.+\ndescription:\t.+\n--\n([\s\S]*)$/m);
  const readme = readmeMatch ? readmeMatch[1].trim() : "";

  let text = `# ${info.name}\n\n`;
  if (info.description) {
    text += `${info.description}\n\n`;
  }
  text += "---\n\n";
  text += readme;

  return {
    text,
    sourceType: "markdown",
    metadata: {
      type: "github-repo",
      owner,
      repo,
      url: `https://github.com/${owner}/${repo}`,
    },
  };
}

/**
 * Fetch all issues
 */
async function fetchIssues(owner: string, repo: string): Promise<ExtractedContent> {
  const issuesJson = gh(`issue list -R ${owner}/${repo} --json number,title,body,author,labels,state,createdAt --limit 100`);
  const issues = JSON.parse(issuesJson);

  let text = `# Issues: ${owner}/${repo}\n\n`;
  text += `Total: ${issues.length} issues\n\n---\n\n`;

  for (const issue of issues) {
    text += `## #${issue.number}: ${issue.title}\n\n`;
    text += `**State:** ${issue.state} | **Author:** ${issue.author?.login || "unknown"} | **Created:** ${issue.createdAt}\n`;
    if (issue.labels?.length) {
      text += `**Labels:** ${issue.labels.map((l: { name: string }) => l.name).join(", ")}\n`;
    }
    text += `\n${issue.body || "(no description)"}\n\n---\n\n`;
  }

  return {
    text,
    sourceType: "markdown",
    metadata: {
      type: "github-issues",
      owner,
      repo,
      count: issues.length,
      url: `https://github.com/${owner}/${repo}/issues`,
    },
  };
}

/**
 * Fetch single issue with comments
 */
async function fetchIssue(owner: string, repo: string, number: number): Promise<ExtractedContent> {
  const issueJson = gh(`issue view ${number} -R ${owner}/${repo} --json number,title,body,author,labels,state,createdAt,comments`);
  const issue = JSON.parse(issueJson);

  let text = `# Issue #${issue.number}: ${issue.title}\n\n`;
  text += `**State:** ${issue.state} | **Author:** ${issue.author?.login || "unknown"} | **Created:** ${issue.createdAt}\n`;
  if (issue.labels?.length) {
    text += `**Labels:** ${issue.labels.map((l: { name: string }) => l.name).join(", ")}\n`;
  }
  text += `\n---\n\n${issue.body || "(no description)"}\n\n`;

  if (issue.comments?.length) {
    text += `## Comments (${issue.comments.length})\n\n`;
    for (const comment of issue.comments) {
      text += `### ${comment.author?.login || "unknown"} (${comment.createdAt})\n\n`;
      text += `${comment.body}\n\n---\n\n`;
    }
  }

  return {
    text,
    sourceType: "markdown",
    metadata: {
      type: "github-issue",
      owner,
      repo,
      number,
      title: issue.title,
      state: issue.state,
      url: `https://github.com/${owner}/${repo}/issues/${number}`,
    },
  };
}

/**
 * Fetch all PRs
 */
async function fetchPulls(owner: string, repo: string): Promise<ExtractedContent> {
  const prsJson = gh(`pr list -R ${owner}/${repo} --json number,title,body,author,labels,state,createdAt --limit 100`);
  const prs = JSON.parse(prsJson);

  let text = `# Pull Requests: ${owner}/${repo}\n\n`;
  text += `Total: ${prs.length} PRs\n\n---\n\n`;

  for (const pr of prs) {
    text += `## #${pr.number}: ${pr.title}\n\n`;
    text += `**State:** ${pr.state} | **Author:** ${pr.author?.login || "unknown"} | **Created:** ${pr.createdAt}\n`;
    if (pr.labels?.length) {
      text += `**Labels:** ${pr.labels.map((l: { name: string }) => l.name).join(", ")}\n`;
    }
    text += `\n${pr.body || "(no description)"}\n\n---\n\n`;
  }

  return {
    text,
    sourceType: "markdown",
    metadata: {
      type: "github-pulls",
      owner,
      repo,
      count: prs.length,
      url: `https://github.com/${owner}/${repo}/pulls`,
    },
  };
}

/**
 * Fetch single PR with comments and reviews
 */
async function fetchPR(owner: string, repo: string, number: number): Promise<ExtractedContent> {
  const prJson = gh(`pr view ${number} -R ${owner}/${repo} --json number,title,body,author,labels,state,createdAt,comments,reviews`);
  const pr = JSON.parse(prJson);

  let text = `# PR #${pr.number}: ${pr.title}\n\n`;
  text += `**State:** ${pr.state} | **Author:** ${pr.author?.login || "unknown"} | **Created:** ${pr.createdAt}\n`;
  if (pr.labels?.length) {
    text += `**Labels:** ${pr.labels.map((l: { name: string }) => l.name).join(", ")}\n`;
  }
  text += `\n---\n\n${pr.body || "(no description)"}\n\n`;

  if (pr.reviews?.length) {
    text += `## Reviews (${pr.reviews.length})\n\n`;
    for (const review of pr.reviews) {
      text += `### ${review.author?.login || "unknown"} — ${review.state}\n\n`;
      if (review.body) {
        text += `${review.body}\n\n`;
      }
      text += `---\n\n`;
    }
  }

  if (pr.comments?.length) {
    text += `## Comments (${pr.comments.length})\n\n`;
    for (const comment of pr.comments) {
      text += `### ${comment.author?.login || "unknown"} (${comment.createdAt})\n\n`;
      text += `${comment.body}\n\n---\n\n`;
    }
  }

  return {
    text,
    sourceType: "markdown",
    metadata: {
      type: "github-pr",
      owner,
      repo,
      number,
      title: pr.title,
      state: pr.state,
      url: `https://github.com/${owner}/${repo}/pull/${number}`,
    },
  };
}

/**
 * Fetch discussions
 */
async function fetchDiscussions(owner: string, repo: string): Promise<ExtractedContent> {
  // gh CLI doesn't have direct discussions support, use API
  const discussionsJson = gh(`api repos/${owner}/${repo}/discussions --paginate`);
  const discussions = JSON.parse(discussionsJson);

  let text = `# Discussions: ${owner}/${repo}\n\n`;
  text += `Total: ${discussions.length} discussions\n\n---\n\n`;

  for (const disc of discussions) {
    text += `## ${disc.title}\n\n`;
    text += `**Author:** ${disc.user?.login || "unknown"} | **Created:** ${disc.created_at}\n`;
    text += `**Category:** ${disc.category?.name || "uncategorized"}\n\n`;
    text += `${disc.body || "(no content)"}\n\n---\n\n`;
  }

  return {
    text,
    sourceType: "markdown",
    metadata: {
      type: "github-discussions",
      owner,
      repo,
      count: discussions.length,
      url: `https://github.com/${owner}/${repo}/discussions`,
    },
  };
}

/**
 * Get source URL string
 */
function getSourceUrl(source: Source): string {
  return source.url || source.path || "";
}

/**
 * GitHub Extractor
 */
class GitHubExtractor implements Extractor {
  name = "github";

  canHandle(source: Source): boolean {
    const url = getSourceUrl(source);
    return /^(?:github|gh):\/\//.test(url);
  }

  async extract(source: Source): Promise<ExtractedContent> {
    const url = getSourceUrl(source);
    const parsed = parseGitHubUrl(url);
    if (!parsed) {
      throw new Error(`Invalid GitHub URL: ${url}`);
    }

    const { owner, repo, type, number } = parsed;

    switch (type) {
      case "repo":
        return fetchRepo(owner, repo);
      case "issues":
        return fetchIssues(owner, repo);
      case "issue":
        return fetchIssue(owner, repo, number!);
      case "pulls":
        return fetchPulls(owner, repo);
      case "pr":
        return fetchPR(owner, repo, number!);
      case "discussions":
        return fetchDiscussions(owner, repo);
      default:
        throw new Error(`Unknown GitHub content type: ${type}`);
    }
  }
}

/**
 * Plugin definition
 */
const plugin: RagClawPlugin = {
  name: "ragclaw-plugin-github",
  version: "0.1.0",
  extractors: [new GitHubExtractor()],
  schemes: ["github", "gh"],
};

export default plugin;
