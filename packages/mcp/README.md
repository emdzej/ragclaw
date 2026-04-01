# @emdzej/ragclaw-mcp

MCP server for RagClaw — exposes 14 RAG knowledge-base tools to AI agents via the [Model Context Protocol](https://modelcontextprotocol.io/).

Supports **stdio** (default, single-client) and **HTTP** (multi-client, Streamable HTTP) transports.

## Installation

```bash
npm install -g @emdzej/ragclaw-mcp
```

Or use without installing:

```bash
npx @emdzej/ragclaw-mcp
```

## Usage

```bash
# Default — stdio transport (launched by MCP hosts)
ragclaw-mcp

# HTTP transport on localhost:3000
ragclaw-mcp --transport http

# HTTP on a custom port with debug logging
ragclaw-mcp --transport http --port 8080 --log-level debug
```

### CLI flags

| Flag | Description | Default |
|------|-------------|---------|
| `--transport <type>` | `stdio` or `http` | `stdio` |
| `--port <number>` | Port for HTTP transport | `3000` |
| `--host <host>` | Host/IP for HTTP transport | `127.0.0.1` |
| `--log-level <level>` | `debug`, `info`, `warn`, `error` | `info` |
| `-V, --version` | Print version | |
| `-h, --help` | Print help | |

## Client configuration

### stdio transport (default)

Clients that manage the MCP process lifecycle (most common setup):

**Codex CLI** (`~/.codex/config.yaml`):

```yaml
mcpServers:
  ragclaw:
    command: ragclaw-mcp
```

**Claude Code** (MCP settings):

```json
{
  "mcpServers": {
    "ragclaw": {
      "command": "ragclaw-mcp"
    }
  }
}
```

**OpenCode** (`~/.opencode/config.json`):

```json
{
  "mcp": {
    "ragclaw": {
      "command": "ragclaw-mcp"
    }
  }
}
```

**Cursor** (Settings > MCP):

```json
{
  "ragclaw": {
    "command": "ragclaw-mcp"
  }
}
```

**Windsurf** (`~/.windsurf/mcp.json`):

```json
{
  "servers": {
    "ragclaw": {
      "command": "ragclaw-mcp"
    }
  }
}
```

### HTTP transport

Start the server separately, then point clients at `http://127.0.0.1:3000/mcp`:

```bash
ragclaw-mcp --transport http --port 3000
```

The HTTP endpoint supports MCP Streamable HTTP:
- `POST /mcp` — JSON-RPC requests (initialize + subsequent)
- `GET /mcp` — SSE stream for server-to-client notifications
- `DELETE /mcp` — explicit session termination

Sessions are stateful — each client gets its own MCP server instance, while expensive resources (embedders, SQLite stores) are shared across sessions.

## Tools

| Tool | Description |
|------|-------------|
| `kb_search` | Hybrid/vector/keyword search with query decomposition and RRF |
| `kb_read_source` | Retrieve full indexed content of a source |
| `kb_add` | Index a file, directory, or URL (with optional crawl) |
| `kb_status` | Knowledge base statistics |
| `kb_remove` | Remove a source from the index |
| `kb_reindex` | Re-process changed sources |
| `kb_db_merge` | Merge another `.db` file into a local KB |
| `kb_list_chunkers` | List available chunkers (built-in + plugin) |
| `kb_list_databases` | List all knowledge bases with name, description, keywords |
| `kb_db_init` | Create a new knowledge base |
| `kb_db_info` | Set description and keywords on a KB |
| `kb_db_info_get` | Read description and keywords from a KB |
| `kb_db_delete` | Delete a KB permanently (requires `confirm: true`) |
| `kb_db_rename` | Rename a KB (requires `confirm: true`) |

## Docker

A pre-built Docker image is available on GitHub Container Registry with all native dependencies and plugins included.

```bash
# Pull the image
docker pull ghcr.io/emdzej/ragclaw-mcp:latest

# Run with HTTP transport (default in Docker)
docker run -d \
  --name ragclaw-mcp \
  -p 3000:3000 \
  -v ./config:/etc/ragclaw:ro \
  -v ragclaw-data:/data/ragclaw \
  --cap-drop=ALL \
  --no-new-privileges \
  --read-only \
  --tmpfs /tmp:noexec,nosuid,size=64m \
  ghcr.io/emdzej/ragclaw-mcp:latest

# Run with stdio transport
docker run -i --rm \
  -v ./config:/etc/ragclaw:ro \
  -v ragclaw-data:/data/ragclaw \
  ghcr.io/emdzej/ragclaw-mcp:latest --transport stdio
```

The container runs as a non-root user (UID 10001). See [Docker section in the User Guide](../../docs/USER_GUIDE.md#14-docker) for full configuration, volumes, security hardening, and compose examples.

## Security

- The MCP server **always enforces guards** (`isPathAllowed`, `isUrlAllowed`) regardless of the CLI `enforceGuards` setting.
- HTTP transport binds to `127.0.0.1` by default. Binding to `0.0.0.0` logs a warning — no built-in authentication.
- Configure `allowedPaths`, `allowedUrls`, and other guard settings in `~/.config/ragclaw/config.yaml`.

## Development

```bash
pnpm install
pnpm build
pnpm --filter @emdzej/ragclaw-mcp test
```

## Documentation

See the main [RagClaw repository](https://github.com/emdzej/ragclaw) for full documentation:
- [SPEC.md](../../docs/SPEC.md) — Canonical specification
- [USER_GUIDE.md](../../docs/USER_GUIDE.md) — Feature reference

## License

MIT
