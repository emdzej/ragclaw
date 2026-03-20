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

| Alias | Model | Language | Context | Dims | ~RAM |
|-------|-------|----------|---------|------|------|
| `nomic` ⭐ | `nomic-ai/nomic-embed-text-v1.5` | English | 8 192 tok | 768 | ~600 MB |
| `bge` | `BAAI/bge-m3` | **100+ languages** | 8 192 tok | 1024 | ~2.3 GB |
| `mxbai` | `mixedbread-ai/mxbai-embed-large-v1` | English | 512 tok | 1024 | ~1.4 GB |
| `minilm` | `sentence-transformers/all-MiniLM-L6-v2` | English | 256 tok | 384 | ~90 MB |

> ⭐ Default preset.

**When to use each preset:**

- **`nomic`** — Default for most use cases. Good English quality, handles long documents (8 192-token context), moderate RAM (~600 MB). Supports Matryoshka dimension truncation.
- **`bge`** — Non-English or mixed-language corpora. Tops multilingual benchmarks; requires ~2.3 GB RAM.
- **`mxbai`** — Highest English retrieval quality on MTEB (64.68). Hard limit of 512 tokens — longer content is truncated silently.
- **`minilm`** — Minimal RAM (~90 MB). 256-token limit makes it suitable only for short notes or sentences.

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

Vector Extension (sqlite-vec):
  ✓ Available  (loaded via npm package)

Embedder Compatibility:
  minilm  (~90 MB)   sentence-transformers/all-MiniLM-L6-v2    384 dim  OK
  nomic   (~600 MB)  nomic-ai/nomic-embed-text-v1.5            768 dim  OK
  mxbai   (~1.4 GB)  mixedbread-ai/mxbai-embed-large-v1       1024 dim  OK
  bge     (~2.3 GB)  BAAI/bge-m3                               1024 dim  WARN may be slow

Current Config:
  embedder: nomic (default)
```

`sqlite-vec` is declared as an optional dependency of this package and is bundled automatically when you install `@emdzej/ragclaw-cli` globally. If it shows as unavailable, run:

```bash
npm install sqlite-vec
```

## Documentation

See the main [RagClaw repository](https://github.com/emdzej/ragclaw) for full documentation.

## License

MIT
