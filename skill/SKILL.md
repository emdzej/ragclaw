# RagClaw Skill

Local-first RAG (Retrieval-Augmented Generation) for OpenClaw.

## Description

Index and search your documents, code, and web pages locally. Zero external APIs, offline embeddings, SQLite-based storage.

## Commands

### `/rag add <source>`
Index a file, directory, or URL.

**Examples:**
```
/rag add ./docs/
/rag add https://docs.example.com
/rag add ~/projects/my-app/src/
```

**Options:**
- `--db <name>` — Knowledge base name (default: "default")
- `--recursive` — Recurse into directories (default: true)

### `/rag search <query>`
Search the knowledge base.

**Examples:**
```
/rag search how to configure authentication
/rag search async function error handling
```

**Options:**
- `--db <name>` — Knowledge base name (default: "default")
- `--limit <n>` — Max results (default: 5)
- `--mode <mode>` — Search mode: vector|keyword|hybrid (default: hybrid)

### `/rag status`
Show knowledge base statistics.

### `/rag list`
List indexed sources.

### `/rag remove <source>`
Remove a source from the index.

## Supported Formats

| Type | Extensions |
|------|------------|
| Markdown | .md, .mdx |
| Text | .txt |
| PDF | .pdf |
| Word | .docx |
| Code | .ts, .js, .py, .go, .java |
| Web | http://, https:// |

## Storage

Knowledge bases are stored in `~/.openclaw/ragclaw/<name>.sqlite`

## How It Works

1. **Extract** — Pull text from documents (PDF, DOCX, HTML, code)
2. **Chunk** — Split into semantic units (paragraphs, functions, classes)
3. **Embed** — Generate 768-dim vectors using nomic-embed-text-v1.5
4. **Store** — SQLite with FTS5 for keyword search
5. **Search** — Hybrid: 70% vector similarity + 30% BM25 keyword

All processing happens locally. No API keys required.
