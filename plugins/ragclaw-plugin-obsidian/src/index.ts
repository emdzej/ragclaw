import type { RagClawPlugin, Extractor, ExtractedContent, Source } from "@emdzej/ragclaw-core";
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, basename, relative, extname } from "path";
import { homedir } from "os";

/**
 * Default Obsidian vault locations by platform
 */
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

/**
 * Find vault path by name
 */
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

/**
 * Recursively find all markdown files in vault
 */
function findMarkdownFiles(dir: string, files: string[] = []): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    // Skip hidden files and .obsidian directory
    if (entry.name.startsWith(".")) continue;
    // Skip common non-note directories
    if (entry.name === "node_modules" || entry.name === ".git") continue;

    if (entry.isDirectory()) {
      findMarkdownFiles(fullPath, files);
    } else if (entry.isFile() && extname(entry.name) === ".md") {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Parse Obsidian wikilinks and convert to readable format
 */
function processObsidianContent(content: string): string {
  // Convert [[wikilinks]] to readable format
  let processed = content.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, link, alias) => {
    return alias || link;
  });

  // Convert ![[embeds]] to reference format
  processed = processed.replace(/!\[\[([^\]]+)\]\]/g, (_, embed) => {
    return `[Embedded: ${embed}]`;
  });

  // Handle tags
  processed = processed.replace(/#([a-zA-Z0-9_/-]+)/g, (_, tag) => {
    return `[tag: ${tag}]`;
  });

  return processed;
}

/**
 * Extract YAML frontmatter
 */
function extractFrontmatter(content: string): { frontmatter: Record<string, unknown> | null; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: null, body: content };
  }

  try {
    // Simple YAML parsing for common cases
    const yaml = match[1];
    const frontmatter: Record<string, unknown> = {};
    
    for (const line of yaml.split("\n")) {
      const keyValue = line.match(/^(\w+):\s*(.*)$/);
      if (keyValue) {
        const [, key, value] = keyValue;
        // Parse arrays
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

/**
 * Parse Obsidian URL
 * Formats:
 *   obsidian://vault-name           - entire vault
 *   obsidian://vault-name/folder    - specific folder
 *   obsidian://vault-name/note.md   - specific note
 *   obsidian:///absolute/path       - absolute path
 */
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

/**
 * Get source URL string
 */
function getSourceUrl(source: Source): string {
  return source.url || source.path || "";
}

/**
 * Obsidian Extractor
 */
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

    // Check if target is a single file
    if (existsSync(targetPath) && statSync(targetPath).isFile()) {
      return this.extractNote(targetPath, vaultPath);
    }

    // Extract entire vault or folder
    return this.extractVault(targetPath, vaultPath);
  }

  private extractNote(notePath: string, vaultPath: string): ExtractedContent {
    const raw = readFileSync(notePath, "utf-8");
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

  private extractVault(targetPath: string, vaultPath: string): ExtractedContent {
    const files = findMarkdownFiles(targetPath);
    const vaultName = basename(vaultPath);
    const isSubfolder = targetPath !== vaultPath;

    let text = `# Obsidian Vault: ${vaultName}\n\n`;
    if (isSubfolder) {
      text += `**Folder:** ${relative(vaultPath, targetPath)}\n\n`;
    }
    text += `**Notes:** ${files.length}\n\n---\n\n`;

    for (const file of files) {
      const raw = readFileSync(file, "utf-8");
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

/**
 * Plugin definition
 */
const plugin: RagClawPlugin = {
  name: "ragclaw-plugin-obsidian",
  version: "0.1.0",
  extractors: [new ObsidianExtractor()],
  schemes: ["obsidian", "vault"],
};

export default plugin;
