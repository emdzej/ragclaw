# RagClaw 🦞

Local-first RAG engine for OpenClaw. Index and search your documents, code, and web pages — fully offline, no API keys required.

## Features

- **📄 Multi-format** — Markdown, PDF, DOCX, code, web pages, images (OCR)
- **🔍 Hybrid search** — Vector similarity + BM25 keyword search
- **🌳 Code-aware** — Tree-sitter AST parsing for semantic code chunks
- **📱 Portable** — SQLite database, copy anywhere
- **🔌 MCP server** — Works with Codex, Claude Code, OpenCode
- **⚡ Incremental** — Only re-indexes changed files

## Quick Start

```bash
# Install
npm install -g @emdzej/ragclaw-cli

# Index some docs
ragclaw add ./docs/
ragclaw add https://docs.example.com

# Search
ragclaw search "how to configure auth"
```

## Supported Formats

| Type | Extensions |
|------|------------|
| Markdown | `.md`, `.mdx` |
| Text | `.txt` |
| PDF | `.pdf` (with OCR for scanned pages) |
| Word | `.docx` |
| Code | `.ts`, `.js`, `.py`, `.go`, `.java` |
| Images | `.png`, `.jpg`, `.gif`, `.webp`, `.bmp`, `.tiff` (OCR) |
| Web | `http://`, `https://` |

## CLI Commands

```bash
ragclaw add <source>       # Index file, directory, or URL
ragclaw search <query>     # Search knowledge base
ragclaw reindex            # Re-process changed files
ragclaw status             # Show KB statistics
ragclaw list               # List indexed sources
ragclaw remove <source>    # Remove from index
```

### Options

```bash
-d, --db <name>     # Knowledge base name (default: "default")
-l, --limit <n>     # Max search results
-m, --mode <mode>   # Search mode: vector|keyword|hybrid
-f, --force         # Reindex all (ignore hash)
-p, --prune         # Remove missing sources
```

## Storage & Portability

Knowledge bases are stored as SQLite files:
```
~/.openclaw/ragclaw/
├── default.sqlite      # Default KB
├── project-a.sqlite    # Named KB
└── docs.sqlite
```

**Copy/sync databases freely:**
```bash
# Backup
cp ~/.openclaw/ragclaw/default.sqlite ~/backup/

# Sync between machines
rsync -av ~/.openclaw/ragclaw/ user@server:~/.openclaw/ragclaw/

# Use from different location
ragclaw search "query" -d /path/to/backup.sqlite
```

---

## Integration Setup

### OpenClaw Skill

Copy the `skill/` directory to your OpenClaw workspace:

```bash
cp -r skill/ ~/.openclaw/workspace/skills/ragclaw/
```

Then use `/rag` commands in chat:
```
/rag add ./docs/
/rag search "authentication flow"
```

### MCP Server (Codex / Claude Code / OpenCode)

#### Option 1: Global install

```bash
npm install -g @emdzej/ragclaw-mcp
```

#### Option 2: npx (no install)

Use `npx @emdzej/ragclaw-mcp` as command.

---

### Codex CLI

Add to `~/.codex/config.yaml`:

```yaml
mcpServers:
  ragclaw:
    command: ragclaw-mcp
    # or: command: npx @emdzej/ragclaw-mcp
```

### Claude Code

Add to Claude Code MCP settings:

```json
{
  "mcpServers": {
    "ragclaw": {
      "command": "ragclaw-mcp"
    }
  }
}
```

### OpenCode

Add to `~/.opencode/config.json`:

```json
{
  "mcp": {
    "ragclaw": {
      "command": "ragclaw-mcp"
    }
  }
}
```

### Cursor

Add to Cursor settings (Settings → MCP):

```json
{
  "ragclaw": {
    "command": "ragclaw-mcp"
  }
}
```

### Windsurf

Add to `~/.windsurf/mcp.json`:

```json
{
  "servers": {
    "ragclaw": {
      "command": "ragclaw-mcp"
    }
  }
}
```

---

## MCP Tools

Once configured, these tools are available to AI agents:

| Tool | Description |
|------|-------------|
| `rag_search` | Search knowledge base |
| `rag_add` | Index file/directory/URL |
| `rag_reindex` | Re-process changed sources |
| `rag_status` | Get KB statistics |
| `rag_list` | List indexed sources |
| `rag_remove` | Remove source from index |

**Example prompts:**
```
Index the ./src directory into ragclaw
Search ragclaw for "error handling patterns"
Reindex ragclaw with force=true
```

---

## How It Works

1. **Extract** — Pull text from documents (PDF, DOCX, HTML, code, images via OCR)
2. **Chunk** — Split into semantic units (paragraphs, functions, classes)
3. **Embed** — Generate 768-dim vectors using `nomic-embed-text-v1.5`
4. **Store** — SQLite with FTS5 for keyword search
5. **Search** — Hybrid scoring: 70% vector + 30% BM25

All processing happens locally. No external APIs.

---

## Development

```bash
# Clone
git clone https://github.com/emdzej/ragclaw.git
cd ragclaw

# Install
pnpm install

# Build
pnpm build

# Link CLI globally
cd packages/cli && npm link
```

### Packages

| Package | Description |
|---------|-------------|
| `@emdzej/ragclaw-core` | Extractors, chunkers, embedder, store |
| `@emdzej/ragclaw-cli` | Command-line interface |
| `@emdzej/ragclaw-mcp` | MCP server for AI tools |

---

## License

MIT
