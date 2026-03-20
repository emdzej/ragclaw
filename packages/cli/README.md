# @emdzej/ragclaw-cli

Command-line interface for RagClaw — local-first RAG engine.

## Installation

```bash
npm install -g @emdzej/ragclaw-cli
```

## Usage

```bash
# Index documents
ragclaw add ./docs/
ragclaw add https://example.com

# Search
ragclaw search "authentication flow"

# Manage
ragclaw status
ragclaw list
ragclaw remove ./old-docs/
```

## Documentation

See the main [RagClaw repository](https://github.com/emdzej/ragclaw) for full documentation.

## License

MIT
