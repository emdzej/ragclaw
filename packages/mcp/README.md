# @emdzej/ragclaw-mcp

MCP server for RagClaw — exposes RAG tools to Codex, Claude Code, OpenCode, Cursor, and Windsurf.

## Installation

```bash
npm install -g @emdzej/ragclaw-mcp
```

## Configuration

### Codex CLI

```yaml
# ~/.codex/config.yaml
mcpServers:
  ragclaw:
    command: ragclaw-mcp
```

### Claude Code / Cursor / Windsurf

```json
{
  "mcpServers": {
    "ragclaw": {
      "command": "ragclaw-mcp"
    }
  }
}
```

## Tools

| Tool | Description |
|------|-------------|
| `rag_search` | Search knowledge base |
| `rag_add` | Index file/directory/URL |
| `rag_reindex` | Re-process changed sources |
| `rag_status` | Get KB statistics including embedder info |
| `rag_list` | List indexed sources |
| `rag_remove` | Remove source from index |

**Note:** The MCP server automatically detects the embedder from each knowledge base's stored metadata. Different databases can use different embedding models — the correct model is loaded per database on first search.

## Documentation

See the main [RagClaw repository](https://github.com/emdzej/ragclaw) for full documentation.

## License

MIT
