# ragclaw-plugin-ollama

RagClaw plugin for local embeddings via [Ollama](https://ollama.com).

Delegates embedding to a locally-running Ollama server instead of bundling an ONNX model.
Any model served by Ollama can be used to embed documents in a RagClaw knowledge base.

## Requirements

- [Ollama](https://ollama.com) installed and running (`ollama serve`)
- At least one embedding model pulled (e.g. `ollama pull nomic-embed-text`)

## Installation

```bash
npm install -g ragclaw-plugin-ollama
```

## Configuration

Add the plugin to your RagClaw config (`~/.config/ragclaw/config.yaml`):

```yaml
enabledPlugins:
  - ragclaw-plugin-ollama

embedder:
  plugin: ragclaw-plugin-ollama
  model: nomic-embed-text     # any model available in your Ollama server
  baseUrl: http://localhost:11434  # default; omit if using the default port
```

## Supported Models

Dimensions are pre-wired for these popular models — no auto-detection needed:

| Model | Dimensions |
|-------|-----------|
| `nomic-embed-text` | 768 |
| `mxbai-embed-large` | 1024 |
| `all-minilm` | 384 |
| `snowflake-arctic-embed` | 1024 |
| `bge-large` | 1024 |
| `bge-base` | 768 |
| `bge-small` | 384 |

Any other model served by Ollama is also supported — dimensions are auto-detected on the first embedding call.

## Usage

Once configured, use RagClaw as normal — the Ollama embedder is used transparently:

```bash
# Index files using the Ollama embedder
ragclaw add ./docs

# Search
ragclaw search "how does authentication work"

# Check embedder info
ragclaw status
```

## Development

```bash
cd plugins/ragclaw-plugin-ollama
pnpm install
pnpm build
pnpm test
```

## License

MIT
