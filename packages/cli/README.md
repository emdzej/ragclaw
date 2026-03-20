# @emdzej/ragclaw-cli

Command-line interface for RagClaw — local-first RAG engine.

## Installation

```bash
npm install -g @emdzej/ragclaw-cli
```

## Usage

```bash
# Index documents (default embedder: nomic)
ragclaw add ./docs/

# Index with a specific embedder
ragclaw add --embedder bge ./docs/
ragclaw add --embedder minilm ./notes/

# Search (embedder auto-detected from database metadata)
ragclaw search "authentication flow"

# Reindex (optionally switch embedder — rebuilds all vectors)
ragclaw reindex --embedder mxbai

# Status (shows embedder name, model, and dims)
ragclaw status

# List all available embedders (built-in presets + plugin-provided)
ragclaw embedder list

# Check system and embedder compatibility
ragclaw doctor

# Manage
ragclaw list
ragclaw remove ./old-docs/
```

## Embedder Selection

The embedder is resolved in this priority order:

1. `--embedder` CLI flag (alias or HuggingFace model ID)
2. `embedder:` field in `~/.config/ragclaw/config.yaml`
3. `RAGCLAW_EMBEDDER` environment variable
4. Plugin-provided embedder (first enabled plugin wins)
5. Default: `nomic` (768 dims, ~600 MB)

**Available presets:**

| Alias | Model | Dims | ~RAM |
|-------|-------|------|------|
| `nomic` | nomic-ai/nomic-embed-text-v1.5 | 768 | 600 MB |
| `bge` | BAAI/bge-m3 | 1024 | 2.3 GB |
| `mxbai` | mixedbread-ai/mxbai-embed-large-v1 | 1024 | 1.4 GB |
| `minilm` | sentence-transformers/all-MiniLM-L6-v2 | 384 | 90 MB |

For search, the embedder is always read from the database's stored metadata — no flag needed.

To see all available embedders at any time (built-in presets and any plugin-provided ones), run:

```
$ ragclaw embedder list

Built-in presets:

  Alias   Model                                   Dims  RAM       Status
  ──────────────────────────────────────────────────────────────────────
  * nomic   nomic-ai/nomic-embed-text-v1.5          768   ~600 MB   ✓ ok
    bge     BAAI/bge-m3                             1024  ~2.3 GB   ✓ ok
    mxbai   mixedbread-ai/mxbai-embed-large-v1      1024  ~1.4 GB   ✓ ok
    minilm  sentence-transformers/all-MiniLM-L6-v2  384   ~90 MB    ✓ ok

No plugin-provided embedders found.

* = currently configured    Use -e/--embedder <alias> to select.
```

When plugins that provide a custom embedder (e.g. an Ollama or OpenAI adapter) are enabled, they appear in a second section below the built-in presets.

## System Requirements

Run `ragclaw doctor` to check whether your machine has enough RAM for each preset:

```
$ ragclaw doctor

System Check:
  RAM:   16.0 GB total, 9.3 GB available
  Node:  v22.14.0

Embedder Compatibility:
  minilm  (~90 MB)   sentence-transformers/all-MiniLM-L6-v2    384 dim  OK
  nomic   (~600 MB)  nomic-ai/nomic-embed-text-v1.5            768 dim  OK
  mxbai   (~1.4 GB)  mixedbread-ai/mxbai-embed-large-v1       1024 dim  OK
  bge     (~2.3 GB)  BAAI/bge-m3                               1024 dim  WARN may be slow

Current Config:
  embedder: nomic (default)
```

## Documentation

See the main [RagClaw repository](https://github.com/emdzej/ragclaw) for full documentation.

## License

MIT
