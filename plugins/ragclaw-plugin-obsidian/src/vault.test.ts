/**
 * Tests for Obsidian vault operations that require FS mocking:
 *   - parseObsidianUrl / findVault (via extractor)
 *   - ObsidianExtractor.extract() — single note + vault/folder
 *   - expandObsidian() (via plugin.expand())
 *   - plugin.init() config
 *   - findMarkdownFiles limits
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Source } from "@emdzej/ragclaw-core";

// ── Mocks ───────────────────────────────────────────────────────────────────

const mockExistsSync = vi.fn<(path: string) => boolean>();
vi.mock("fs", () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(args[0] as string),
}));

const mockReadFile = vi.fn<(path: string, enc: string) => Promise<string>>();
const mockReaddir = vi.fn();
const mockStat = vi.fn();
vi.mock("fs/promises", () => ({
  readFile: (...args: unknown[]) => mockReadFile(args[0] as string, args[1] as string),
  readdir: (...args: unknown[]) => mockReaddir(...args),
  stat: (...args: unknown[]) => mockStat(...args),
}));

vi.mock("os", () => ({
  homedir: () => "/home/testuser",
}));

// Import after mocks
const pluginModule = await import("./index.js");
const plugin = pluginModule.default;

// ── Helpers ─────────────────────────────────────────────────────────────────

function fakeDirent(name: string, isDir: boolean) {
  return {
    name,
    isDirectory: () => isDir,
    isFile: () => !isDir,
    isSymbolicLink: () => false,
  };
}

function makeNoteContent(title: string, body: string, tags?: string[]): string {
  let content = "";
  if (tags) {
    content += `---\ntitle: ${title}\ntags: [${tags.join(", ")}]\n---\n`;
  }
  content += body;
  return content;
}

const extractor = plugin.extractors![0];

// ── Tests ───────────────────────────────────────────────────────────────────

describe("ObsidianExtractor.canHandle()", () => {
  it("handles obsidian:// URLs", () => {
    expect(extractor.canHandle({ type: "url", url: "obsidian://MyVault" })).toBe(true);
  });

  it("handles vault:// URLs", () => {
    expect(extractor.canHandle({ type: "url", url: "vault://MyVault/note.md" })).toBe(true);
  });

  it("rejects non-obsidian URLs", () => {
    expect(extractor.canHandle({ type: "url", url: "https://example.com" })).toBe(false);
    expect(extractor.canHandle({ type: "file", path: "/some/file.md" })).toBe(false);
  });
});

describe("ObsidianExtractor.extract() — single note", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("extracts a single note via named vault", async () => {
    // obsidian://MyVault/notes/hello.md  →  vault found at /home/testuser/Documents/MyVault
    mockExistsSync.mockImplementation((p: string) => {
      if (p === "MyVault") return false; // not absolute
      if (p === "/home/testuser/Documents/MyVault") return true;
      if (p === "/home/testuser/Documents/MyVault/.obsidian") return true;
      return false;
    });

    mockStat.mockResolvedValue({ isFile: () => true, isDirectory: () => false });

    const noteContent = makeNoteContent("Hello", "Hello world! This is my note.\n\nIt has [[links]] and #tags.", ["greeting", "demo"]);
    mockReadFile.mockResolvedValue(noteContent);

    const result = await extractor.extract({ type: "url", url: "obsidian://MyVault/notes/hello.md" });

    expect(result.sourceType).toBe("markdown");
    expect(result.text).toContain("# hello");
    expect(result.text).toContain("Hello world! This is my note.");
    expect(result.text).toContain("links"); // wikilinks processed
    expect(result.text).toContain("[tag: tags]"); // tags processed
    expect(result.text).toContain("**Tags:** greeting, demo"); // frontmatter tags shown
    expect(result.metadata.type).toBe("obsidian-note");
    expect(result.metadata.name).toBe("hello");
    expect(result.metadata.vault).toBe("MyVault");
    expect(result.metadata.path).toBe("notes/hello.md");
  });

  it("extracts a single note via absolute vault path", async () => {
    // obsidian:///vault  →  absolute path, entire path is vaultPath
    // For the absolute-path form pointing to a single file, the whole path
    // becomes vaultPath (no subPath). extractNote(vaultPath, vaultPath) so
    // relative() returns "" and basename(vaultPath) is the filename stem.
    mockExistsSync.mockImplementation((p: string) => {
      if (p === "/vault/hello.md") return true;
      return false;
    });

    mockStat.mockResolvedValue({ isFile: () => true, isDirectory: () => false });
    mockReadFile.mockResolvedValue("Just a note via absolute path.");

    const result = await extractor.extract({ type: "url", url: "obsidian:///vault/hello.md" });

    expect(result.sourceType).toBe("markdown");
    expect(result.text).toContain("# hello");
    expect(result.text).toContain("Just a note via absolute path.");
    expect(result.metadata.type).toBe("obsidian-note");
    // vault = basename of vaultPath = "hello.md" (absolute path edge case)
    expect(result.metadata.vault).toBe("hello.md");
  });

  it("extracts a note with frontmatter tags and aliases via named vault", async () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p === "TestVault") return false;
      if (p === "/home/testuser/Documents/TestVault") return true;
      if (p === "/home/testuser/Documents/TestVault/.obsidian") return true;
      return false;
    });

    mockStat.mockResolvedValue({ isFile: () => true, isDirectory: () => false });

    const noteContent = "---\ntitle: Test Note\ntags: [alpha, beta]\naliases: [TN, TestN]\n---\nSome body content.";
    mockReadFile.mockResolvedValue(noteContent);

    const result = await extractor.extract({ type: "url", url: "obsidian://TestVault/test.md" });

    expect(result.text).toContain("**Tags:** alpha, beta");
    expect(result.text).toContain("**Aliases:** TN, TestN");
    expect(result.text).toContain("Some body content.");
    expect(result.metadata.tags).toEqual(["alpha", "beta"]);
    expect(result.metadata.aliases).toEqual(["TN", "TestN"]);
  });

  it("extracts a note without frontmatter", async () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p === "V") return false;
      if (p === "/home/testuser/Documents/V") return true;
      if (p === "/home/testuser/Documents/V/.obsidian") return true;
      return false;
    });

    mockStat.mockResolvedValue({ isFile: () => true, isDirectory: () => false });
    mockReadFile.mockResolvedValue("Just plain content, no frontmatter.");

    const result = await extractor.extract({ type: "url", url: "obsidian://V/plain.md" });

    expect(result.text).toContain("# plain");
    expect(result.text).toContain("Just plain content, no frontmatter.");
    expect(result.text).not.toContain("**Tags:**");
  });
});

describe("ObsidianExtractor.extract() — vault/folder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("extracts an entire vault as a concatenated document", async () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p === "/vault") return true;
      if (p === "/vault/.obsidian") return true;
      return false;
    });

    // stat for vault path → directory
    mockStat.mockResolvedValue({ isFile: () => false, isDirectory: () => true });

    // readdir for vault → two notes + hidden dir (.obsidian) + non-md file
    mockReaddir.mockResolvedValue([
      fakeDirent(".obsidian", true),
      fakeDirent("note1.md", false),
      fakeDirent("note2.md", false),
      fakeDirent("image.png", false),
    ]);

    mockReadFile.mockImplementation(async (path: string) => {
      if (path === "/vault/note1.md") return "---\ntags: [a]\n---\nContent of note 1";
      if (path === "/vault/note2.md") return "Content of note 2 with [[link]]";
      return "";
    });

    const result = await extractor.extract({ type: "url", url: "obsidian:///vault" });

    expect(result.sourceType).toBe("markdown");
    expect(result.text).toContain("# Obsidian Vault: vault");
    expect(result.text).toContain("**Notes:** 2");
    expect(result.text).toContain("## note1");
    expect(result.text).toContain("Content of note 1");
    expect(result.text).toContain("## note2");
    expect(result.text).toContain("Content of note 2 with link"); // wikilink processed
    expect(result.text).not.toContain("image.png"); // non-md skipped
    expect(result.metadata.type).toBe("obsidian-vault");
    expect(result.metadata.noteCount).toBe(2);
  });

  it("extracts a subfolder of a vault", async () => {
    // Use named vault so subPath is properly split
    mockExistsSync.mockImplementation((p: string) => {
      if (p === "MyVault") return false;
      if (p === "/home/testuser/Documents/MyVault") return true;
      if (p === "/home/testuser/Documents/MyVault/.obsidian") return true;
      return false;
    });

    mockStat.mockResolvedValue({ isFile: () => false, isDirectory: () => true });

    mockReaddir.mockResolvedValue([
      fakeDirent("sub-note.md", false),
    ]);

    mockReadFile.mockResolvedValue("Sub folder note content");

    const result = await extractor.extract({ type: "url", url: "obsidian://MyVault/subfolder" });

    expect(result.text).toContain("**Folder:** subfolder");
    expect(result.text).toContain("## sub-note");
    expect(result.metadata.path).toBe("subfolder");
  });
});

describe("parseObsidianUrl / findVault — via extractor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves vault by name via default locations", async () => {
    // Simulate: vault "MyVault" found at /home/testuser/Documents/MyVault
    mockExistsSync.mockImplementation((p: string) => {
      if (p === "MyVault") return false; // not absolute
      if (p === "/home/testuser/Documents/MyVault") return true;
      if (p === "/home/testuser/Documents/MyVault/.obsidian") return true;
      return false;
    });

    mockStat.mockResolvedValue({ isFile: () => false, isDirectory: () => true });
    mockReaddir.mockResolvedValue([]);

    const result = await extractor.extract({ type: "url", url: "obsidian://MyVault" });

    expect(result.metadata.vault).toBe("MyVault");
    expect(result.metadata.type).toBe("obsidian-vault");
  });

  it("resolves vault by name with subpath", async () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p === "TestVault") return false;
      if (p === "/home/testuser/Documents/TestVault") return true;
      if (p === "/home/testuser/Documents/TestVault/.obsidian") return true;
      return false;
    });

    mockStat.mockResolvedValue({ isFile: () => true, isDirectory: () => false });
    mockReadFile.mockResolvedValue("Note content here");

    const result = await extractor.extract({ type: "url", url: "obsidian://TestVault/folder/note.md" });

    expect(result.metadata.type).toBe("obsidian-note");
    expect(result.metadata.vault).toBe("TestVault");
    expect(result.metadata.path).toContain("folder/note.md");
  });

  it("throws when vault not found by name", async () => {
    mockExistsSync.mockReturnValue(false);

    await expect(
      extractor.extract({ type: "url", url: "obsidian://NonExistent" }),
    ).rejects.toThrow("Vault not found: NonExistent");
  });

  it("throws when absolute path doesn't exist", async () => {
    mockExistsSync.mockReturnValue(false);

    await expect(
      extractor.extract({ type: "url", url: "obsidian:///does/not/exist" }),
    ).rejects.toThrow("Vault not found: /does/not/exist");
  });

  it("throws for invalid URL format", async () => {
    await expect(
      extractor.extract({ type: "url", url: "invalid://something" }),
    ).rejects.toThrow("Invalid Obsidian URL");
  });

  it("supports vault:// scheme", async () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p === "/vault") return true;
      if (p === "/vault/.obsidian") return true;
      return false;
    });

    mockStat.mockResolvedValue({ isFile: () => false, isDirectory: () => true });
    mockReaddir.mockResolvedValue([]);

    const result = await extractor.extract({ type: "url", url: "vault:///vault" });

    expect(result.metadata.type).toBe("obsidian-vault");
  });
});

describe("plugin.expand() — expandObsidian", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("expands a vault into individual note sources", async () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p === "/vault") return true;
      if (p === "/vault/.obsidian") return true;
      return false;
    });

    // First stat call: vault is directory
    mockStat
      .mockResolvedValueOnce({ isFile: () => false, isDirectory: () => true, size: 0 })
      // stat calls for each discovered file (size check)
      .mockResolvedValueOnce({ isFile: () => true, isDirectory: () => false, size: 100 })
      .mockResolvedValueOnce({ isFile: () => true, isDirectory: () => false, size: 200 });

    mockReaddir.mockResolvedValue([
      fakeDirent("note-a.md", false),
      fakeDirent("note-b.md", false),
    ]);

    const sources = await plugin.expand!({ type: "url", url: "obsidian:///vault" });

    expect(sources).toHaveLength(2);
    expect(sources![0].url).toContain("note-a.md");
    expect(sources![0].name).toBe("note-a");
    expect(sources![1].url).toContain("note-b.md");
    expect(sources![1].name).toBe("note-b");
  });

  it("returns null for single file source (no expansion needed)", async () => {
    // Use named vault so the single note path is properly resolved
    mockExistsSync.mockImplementation((p: string) => {
      if (p === "V") return false;
      if (p === "/home/testuser/Documents/V") return true;
      if (p === "/home/testuser/Documents/V/.obsidian") return true;
      return false;
    });

    mockStat.mockResolvedValue({ isFile: () => true, isDirectory: () => false });

    const result = await plugin.expand!({ type: "url", url: "obsidian://V/note.md" });
    expect(result).toBeNull();
  });

  it("returns null for non-obsidian URL", async () => {
    const result = await plugin.expand!({ type: "url", url: "https://example.com" });
    expect(result).toBeNull();
  });

  it("preserves vault:// scheme in expanded URLs", async () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p === "/vault") return true;
      if (p === "/vault/.obsidian") return true;
      return false;
    });

    mockStat
      .mockResolvedValueOnce({ isFile: () => false, isDirectory: () => true, size: 0 })
      .mockResolvedValueOnce({ isFile: () => true, isDirectory: () => false, size: 50 });

    mockReaddir.mockResolvedValue([
      fakeDirent("note.md", false),
    ]);

    const sources = await plugin.expand!({ type: "url", url: "vault:///vault" });

    expect(sources).toHaveLength(1);
    expect(sources![0].url).toMatch(/^vault:\/\//);
  });

  it("expands named vault with subpath", async () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p === "MyVault") return false;
      if (p === "/home/testuser/Documents/MyVault") return true;
      if (p === "/home/testuser/Documents/MyVault/.obsidian") return true;
      return false;
    });

    mockStat
      .mockResolvedValueOnce({ isFile: () => false, isDirectory: () => true, size: 0 })
      .mockResolvedValueOnce({ isFile: () => true, isDirectory: () => false, size: 100 });

    mockReaddir.mockResolvedValue([
      fakeDirent("deep-note.md", false),
    ]);

    const sources = await plugin.expand!({ type: "url", url: "obsidian://MyVault/subfolder" });

    expect(sources).toHaveLength(1);
    expect(sources![0].url).toContain("MyVault");
    expect(sources![0].url).toContain("deep-note.md");
  });
});

describe("findMarkdownFiles — recursive discovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("recursively discovers .md files in subdirectories", async () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p === "/vault") return true;
      if (p === "/vault/.obsidian") return true;
      return false;
    });

    mockStat.mockResolvedValue({ isFile: () => false, isDirectory: () => true });

    // Root readdir
    mockReaddir.mockImplementation(async (dir: string) => {
      if (dir === "/vault") {
        return [
          fakeDirent("folder", true),
          fakeDirent("root-note.md", false),
          fakeDirent(".obsidian", true), // hidden, should be skipped
        ];
      }
      if (dir === "/vault/folder") {
        return [
          fakeDirent("nested-note.md", false),
          fakeDirent("not-md.txt", false),
        ];
      }
      return [];
    });

    mockReadFile.mockImplementation(async (path: string) => {
      if (path === "/vault/root-note.md") return "Root note";
      if (path === "/vault/folder/nested-note.md") return "Nested note";
      return "";
    });

    const result = await extractor.extract({ type: "url", url: "obsidian:///vault" });

    expect(result.text).toContain("## root-note");
    expect(result.text).toContain("Root note");
    expect(result.text).toContain("## nested-note");
    expect(result.text).toContain("Nested note");
    expect(result.text).not.toContain("not-md"); // .txt skipped
    expect(result.text).not.toContain(".obsidian"); // hidden skipped
    expect(result.metadata.noteCount).toBe(2);
  });

  it("skips node_modules directories", async () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p === "/vault") return true;
      if (p === "/vault/.obsidian") return true;
      return false;
    });

    mockStat.mockResolvedValue({ isFile: () => false, isDirectory: () => true });

    mockReaddir.mockImplementation(async (dir: string) => {
      if (dir === "/vault") {
        return [
          fakeDirent("node_modules", true),
          fakeDirent("note.md", false),
        ];
      }
      // node_modules should never be entered
      if (dir === "/vault/node_modules") {
        throw new Error("Should not read node_modules!");
      }
      return [];
    });

    mockReadFile.mockResolvedValue("Note content");

    const result = await extractor.extract({ type: "url", url: "obsidian:///vault" });

    expect(result.metadata.noteCount).toBe(1);
  });
});

describe("plugin.init() — config limits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets maxNoteSize from config", async () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p === "/vault") return true;
      if (p === "/vault/.obsidian") return true;
      return false;
    });

    // Init with a very small maxNoteSize
    await plugin.init!({ maxNoteSize: "10" });

    mockStat.mockResolvedValue({ isFile: () => false, isDirectory: () => true });
    mockReaddir.mockResolvedValue([
      fakeDirent("small.md", false),
      fakeDirent("big.md", false),
    ]);

    mockReadFile.mockImplementation(async (path: string) => {
      if (path === "/vault/small.md") return "Short"; // 5 bytes < 10
      if (path === "/vault/big.md") return "This is longer than 10 bytes"; // > 10
      return "";
    });

    const result = await extractor.extract({ type: "url", url: "obsidian:///vault" });

    // Only the small note should be included (big exceeds MAX_NOTE_SIZE)
    expect(result.text).toContain("## small");
    expect(result.text).not.toContain("## big");

    // Reset the limit for other tests
    await plugin.init!({});
  });

  it("ignores invalid config values", async () => {
    // Should not throw
    await plugin.init!(undefined);
    await plugin.init!({});
    await plugin.init!({ maxNotes: "not-a-number" });
    await plugin.init!({ maxNoteSize: "-5" });
  });
});
