/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import type { RagClawPlugin, Extractor, ExtractedContent, Source, PluginConfigKey } from "@emdzej/ragclaw-core";
import { readFile, readdir, stat } from "fs/promises";
import { existsSync } from "fs";
import { join, basename, relative, extname } from "path";
import { homedir } from "os";

// ---------------------------------------------------------------------------
// Configurable limits (overridable via plugin config)
// ---------------------------------------------------------------------------

let MAX_NOTES = Infinity;
let MAX_NOTE_SIZE = Infinity;

// ---------------------------------------------------------------------------
// Default vault locations
// ---------------------------------------------------------------------------

function getDefaultVaultLocations(): string[] {
  const home = homedir();
  const platform = process.platform;

  if (platform === "darwin") {
    return [
      join(home, "Documents"),
      join(home, "Library", "Mobile Documents", "iCloud~md~obsidian", "Documents"),
      join(home, "Obsidian"),
    ];
  } else if (platform === "win32") {
    return [
      join(home, "Documents"),
      join(home, "Obsidian"),
    ];
  } else {
    return [
      join(home, "Documents"),
      join(home, "Obsidian"),
      join(home, ".obsidian"),
    ];
  }
}

// ---------------------------------------------------------------------------
// Vault discovery (sync — uses existsSync only, no heavy I/O)
// ---------------------------------------------------------------------------

function findVault(vaultName: string): string | null {
  // Check if it's already an absolute path
  if (existsSync(vaultName) && existsSync(join(vaultName, ".obsidian"))) {
    return vaultName;
  }

  // Search in default locations
  for (const location of getDefaultVaultLocations()) {
    const vaultPath = join(location, vaultName);
    if (existsSync(vaultPath) && existsSync(join(vaultPath, ".obsidian"))) {
      return vaultPath;
    }
  }

  // Check if .obsidian exists in home with vault name
  const homePath = join(homedir(), vaultName);
  if (existsSync(homePath) && existsSync(join(homePath, ".obsidian"))) {
    return homePath;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Async recursive markdown file discovery
// ---------------------------------------------------------------------------

async function findMarkdownFiles(dir: string, files: string[] = []): Promise<string[]> {
  if (files.length >= MAX_NOTES) return files;

  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (files.length >= MAX_NOTES) break;

    const fullPath = join(dir, entry.name);

    // Skip hidden files and .obsidian directory
    if (entry.name.startsWith(".")) continue;
    // Skip common non-note directories
    if (entry.name === "node_modules" || entry.name === ".git") continue;

    if (entry.isDirectory()) {
      await findMarkdownFiles(fullPath, files);
    } else if (entry.isFile() && extname(entry.name) === ".md") {
      files.push(fullPath);
    }
  }

  return files;
}

// ---------------------------------------------------------------------------
// Content processing helpers
// ---------------------------------------------------------------------------

/** @internal — exported for testing only.
 * Convert Obsidian wikilinks, embeds, and tags to readable format. */
export function processObsidianContent(content: string): string {
  // Convert ![[embeds]] to reference format (MUST run before wikilinks
  // so that the inner [[…]] is not stripped first)
  let processed = content.replace(/!\[\[([^\]]+)\]\]/g, (_, embed) => {
    return `[Embedded: ${embed}]`;
  });

  // Convert [[wikilinks]] to readable format
  processed = processed.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, link, alias) => {
    return alias || link;
  });

  // Handle tags
  processed = processed.replace(/#([a-zA-Z0-9_/-]+)/g, (_, tag) => {
    return `[tag: ${tag}]`;
  });

  return processed;
}

/** @internal — exported for testing only.
 * Extract YAML frontmatter from note content. */
export function extractFrontmatter(content: string): { frontmatter: Record<string, unknown> | null; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: null, body: content };
  }

  try {
    const yaml = match[1];
    const frontmatter: Record<string, unknown> = {};

    for (const line of yaml.split("\n")) {
      const keyValue = line.match(/^(\w+):\s*(.*)$/);
      if (keyValue) {
        const [, key, value] = keyValue;
        if (value.startsWith("[") && value.endsWith("]")) {
          frontmatter[key] = value.slice(1, -1).split(",").map(s => s.trim());
        } else {
          frontmatter[key] = value;
        }
      }
    }

    return { frontmatter, body: match[2] };
  } catch {
    return { frontmatter: null, body: content };
  }
}

// ---------------------------------------------------------------------------
// Obsidian URL parsing
// ---------------------------------------------------------------------------
//
// Formats:
//   obsidian://vault-name           - entire vault
//   obsidian://vault-name/folder    - specific folder
//   obsidian://vault-name/note.md   - specific note
//   obsidian:///absolute/path       - absolute path

interface ParsedObsidianUrl {
  vaultPath: string;
  subPath?: string;
}

function parseObsidianUrl(source: string): ParsedObsidianUrl | null {
  const match = source.match(/^(?:obsidian|vault):\/\/(.+)$/);
  if (!match) return null;

  const path = match[1];

  // Absolute path (three slashes: obsidian:///path)
  if (path.startsWith("/")) {
    const vaultPath = path;
    if (!existsSync(vaultPath)) {
      throw new Error(`Vault not found: ${vaultPath}`);
    }
    return { vaultPath };
  }

  // Vault name with optional subpath
  const parts = path.split("/");
  const vaultName = parts[0];
  const subPath = parts.slice(1).join("/") || undefined;

  const vaultPath = findVault(vaultName);
  if (!vaultPath) {
    throw new Error(`Vault not found: ${vaultName}. Searched in: ${getDefaultVaultLocations().join(", ")}`);
  }

  return { vaultPath, subPath };
}

/** Get source URL string from a Source. */
function getSourceUrl(source: Source): string {
  return source.url || source.path || "";
}

// ---------------------------------------------------------------------------
// Extractor — handles a single note (file-level source)
// ---------------------------------------------------------------------------

class ObsidianExtractor implements Extractor {
  name = "obsidian";

  canHandle(source: Source): boolean {
    const url = getSourceUrl(source);
    return /^(?:obsidian|vault):\/\//.test(url);
  }

  async extract(source: Source): Promise<ExtractedContent> {
    const url = getSourceUrl(source);
    const parsed = parseObsidianUrl(url);
    if (!parsed) {
      throw new Error(`Invalid Obsidian URL: ${url}`);
    }

    const { vaultPath, subPath } = parsed;
    const targetPath = subPath ? join(vaultPath, subPath) : vaultPath;

    const targetStat = await stat(targetPath);

    if (targetStat.isFile()) {
      return this.extractNote(targetPath, vaultPath);
    }

    // Vault/folder — fallback for callers that don't use expand().
    // This concatenates all notes into one blob (legacy behaviour).
    return this.extractVault(targetPath, vaultPath);
  }

  private async extractNote(notePath: string, vaultPath: string): Promise<ExtractedContent> {
    const raw = await readFile(notePath, "utf-8");
    const { frontmatter, body } = extractFrontmatter(raw);
    const processed = processObsidianContent(body);
    const relativePath = relative(vaultPath, notePath);
    const noteName = basename(notePath, ".md");

    let text = `# ${noteName}\n\n`;
    text += `**Path:** ${relativePath}\n\n`;

    if (frontmatter) {
      if (frontmatter.tags) {
        text += `**Tags:** ${Array.isArray(frontmatter.tags) ? frontmatter.tags.join(", ") : frontmatter.tags}\n`;
      }
      if (frontmatter.aliases) {
        text += `**Aliases:** ${Array.isArray(frontmatter.aliases) ? frontmatter.aliases.join(", ") : frontmatter.aliases}\n`;
      }
      text += "\n";
    }

    text += "---\n\n";
    text += processed;

    return {
      text,
      sourceType: "markdown",
      metadata: {
        type: "obsidian-note",
        vault: basename(vaultPath),
        path: relativePath,
        name: noteName,
        ...frontmatter,
      },
    };
  }

  private async extractVault(targetPath: string, vaultPath: string): Promise<ExtractedContent> {
    const files = await findMarkdownFiles(targetPath);
    const vaultName = basename(vaultPath);
    const isSubfolder = targetPath !== vaultPath;

    let text = `# Obsidian Vault: ${vaultName}\n\n`;
    if (isSubfolder) {
      text += `**Folder:** ${relative(vaultPath, targetPath)}\n\n`;
    }
    text += `**Notes:** ${files.length}\n\n---\n\n`;

    for (const file of files) {
      const raw = await readFile(file, "utf-8");

      // Skip notes that exceed the configured size limit
      if (raw.length > MAX_NOTE_SIZE) continue;

      const { frontmatter, body } = extractFrontmatter(raw);
      const processed = processObsidianContent(body);
      const relativePath = relative(vaultPath, file);
      const noteName = basename(file, ".md");

      text += `## ${noteName}\n\n`;
      text += `**Path:** ${relativePath}\n`;

      if (frontmatter?.tags) {
        text += `**Tags:** ${Array.isArray(frontmatter.tags) ? frontmatter.tags.join(", ") : frontmatter.tags}\n`;
      }

      text += "\n";
      text += processed;
      text += "\n\n---\n\n";
    }

    return {
      text,
      sourceType: "markdown",
      metadata: {
        type: "obsidian-vault",
        vault: vaultName,
        path: isSubfolder ? relative(vaultPath, targetPath) : "/",
        noteCount: files.length,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// expand() — turn a vault/folder URL into individual note Sources
// ---------------------------------------------------------------------------

async function expandObsidian(source: Source): Promise<Source[] | null> {
  const url = getSourceUrl(source);
  const parsed = parseObsidianUrl(url);
  if (!parsed) return null;

  const { vaultPath, subPath } = parsed;
  const targetPath = subPath ? join(vaultPath, subPath) : vaultPath;

  const targetStat = await stat(targetPath);

  // Single file — no expansion needed
  if (targetStat.isFile()) return null;

  // Discover notes
  const files = await findMarkdownFiles(targetPath);

  // Build per-note Sources with obsidian:// URLs so the extractor can
  // resolve the vault root for metadata.
  const scheme = url.startsWith("vault://") ? "vault" : "obsidian";
  const sources: Source[] = [];

  for (const file of files) {
    // Check note size limit before creating the source.
    // We stat the file here to avoid reading its full content.
    const fileStat = await stat(file);
    if (fileStat.size > MAX_NOTE_SIZE) continue;

    // Use the absolute-path form: obsidian:///absolute/vault/path/note.md
    // but with subPath so the extractor can resolve it properly.
    const relativeToVault = relative(vaultPath, file);
    // Reconstruct a URL that parseObsidianUrl can resolve back.
    // For absolute vaults (obsidian:///path), keep using absolute:
    const noteUrl = parsed.vaultPath.startsWith("/")
      ? `${scheme}://${join(parsed.vaultPath, relativeToVault)}`
      : `${scheme}://${url.replace(/^(?:obsidian|vault):\/\//, "").split("/")[0]}/${relativeToVault}`;

    sources.push({ type: "url", url: noteUrl, name: basename(file, ".md") });
  }

  return sources;
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin: RagClawPlugin = {
  name: "ragclaw-plugin-obsidian",
  version: "0.2.0",
  extractors: [new ObsidianExtractor()],
  schemes: ["obsidian", "vault"],

  configSchema: [
    { key: "maxNotes",    type: "number", description: "Max notes to index from a vault (default: unlimited)", defaultValue: undefined },
    { key: "maxNoteSize", type: "number", description: "Max note size in bytes to include (default: unlimited)", defaultValue: undefined },
  ],

  async init(config?: Record<string, unknown>) {
    if (!config) return;
    if (typeof config.maxNotes === "string") {
      const n = parseInt(config.maxNotes, 10);
      if (Number.isFinite(n) && n > 0) MAX_NOTES = n;
    }
    if (typeof config.maxNoteSize === "string") {
      const n = parseInt(config.maxNoteSize, 10);
      if (Number.isFinite(n) && n > 0) MAX_NOTE_SIZE = n;
    }
  },

  async expand(source: Source): Promise<Source[] | null> {
    return expandObsidian(source);
  },
};

export default plugin;