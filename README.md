# 🦅 RagClaw

Local-first RAG engine for OpenClaw. Index PDFs, web pages, code, and documents into a SQLite vector database. Zero cloud dependencies.

## Features

- **Zero-Ops** — No Docker, no cloud services, just a local SQLite file
- **Multi-Source** — PDF, DOCX, Web pages, Markdown, Code
- **Hybrid Search** — Vector similarity + BM25 keyword search
- **Code-Aware** — Tree-sitter parsing for TS/JS, Java, Go, Python
- **Offline Embeddings** — `nomic-embed-text-v1.5` via ONNX (no API keys)

## Installation

```bash
npm install -g @emdzej/ragclaw
```

## CLI Usage

```bash
# Initialize a new knowledge base
ragclaw init my-knowledge

# Add content
ragclaw add ./docs/                           # Directory
ragclaw add https://example.com/article       # Web page
ragclaw add ./paper.pdf                       # PDF
ragclaw add ./src/ --type code                # Code (tree-sitter)

# Search
ragclaw search "how to configure OAuth2"

# Status
ragclaw status
```

## OpenClaw Skill

```
User: zaindeksuj https://docs.example.com/guide
Agent: ✓ Indexed 15 chunks from docs.example.com

User: co wiesz o rate limiting?
Agent: Based on indexed knowledge: [relevant context]
```

## MCP Server (for Codex, Claude Desktop, OpenCode)

```json
{
  "mcpServers": {
    "ragclaw": {
      "command": "npx",
      "args": ["-y", "@emdzej/ragclaw-mcp"]
    }
  }
}
```

Tools: `rag_search`, `rag_add`, `rag_status`, `rag_list`, `rag_remove`

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Extractor  │ ──▶ │   Chunker   │ ──▶ │  Embedder   │ ──▶ │   Store     │
│ PDF/Web/Code│     │Semantic/AST │     │nomic-embed  │     │SQLite+vec   │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
                                                                   │
                    ┌──────────────────────────────────────────────┤
                    │                                              │
              ┌─────▼─────┐  ┌─────────────┐  ┌─────────────┐  ┌───▼───────┐
              │    CLI    │  │  MCP Server │  │OpenClaw Skill│ │OpenCode   │
              │  ragclaw  │  │  (Codex,    │  │             │  │  Skill    │
              │           │  │  Claude)    │  │             │  │           │
              └───────────┘  └─────────────┘  └─────────────┘  └───────────┘
```

## Storage

Knowledge bases are stored in `~/.openclaw/ragclaw/`:

```
~/.openclaw/ragclaw/
├── my-knowledge.sqlite
├── work-docs.sqlite
└── project-x.sqlite
```

## License

MIT
