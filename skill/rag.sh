#!/usr/bin/env bash
# RagClaw skill entry point for OpenClaw
# Usage: rag.sh <command> [args...]

set -e

RAGCLAW_BIN="${RAGCLAW_BIN:-ragclaw}"

# Check if ragclaw is installed
if ! command -v "$RAGCLAW_BIN" &> /dev/null; then
    echo "Error: ragclaw CLI not found. Install with: npm install -g @emdzej/ragclaw-cli"
    exit 1
fi

CMD="${1:-help}"
shift || true

case "$CMD" in
    add)
        "$RAGCLAW_BIN" add "$@"
        ;;
    search)
        "$RAGCLAW_BIN" search "$@"
        ;;
    reindex)
        "$RAGCLAW_BIN" reindex "$@"
        ;;
    merge)
        "$RAGCLAW_BIN" merge "$@"
        ;;
    status)
        "$RAGCLAW_BIN" status "$@"
        ;;
    list)
        "$RAGCLAW_BIN" list "$@"
        ;;
    remove)
        "$RAGCLAW_BIN" remove "$@"
        ;;
    init)
        "$RAGCLAW_BIN" init "$@"
        ;;
    embedder)
        "$RAGCLAW_BIN" embedder "$@"
        ;;
    doctor)
        "$RAGCLAW_BIN" doctor "$@"
        ;;
    plugin)
        "$RAGCLAW_BIN" plugin "$@"
        ;;
    config)
        "$RAGCLAW_BIN" config "$@"
        ;;
    help|--help|-h)
        cat << 'EOF'
RagClaw - Local-first RAG for OpenClaw

Commands:
  add <source>           Index a file, directory, or URL
  search <query>         Search the knowledge base
  reindex                Re-process changed sources
  merge <source.sqlite>  Merge another knowledge base into this one
  status                 Show knowledge base stats (chunks, embedder, backend)
  list                   List indexed sources
  remove <source>        Remove a source from index
  init [name]            Initialize a new knowledge base
  embedder list          List embedder presets with RAM requirements
  embedder download [n]  Pre-download a model for offline use (--all for all)
  doctor                 Check system health and embedder compatibility
  plugin list            List discovered plugins
  plugin enable <name>   Enable a plugin
  plugin disable <name>  Disable a plugin
  config list            Show all config values and sources
  config get <key>       Show a single config value
  config set <key> <v>   Persist a config value

Common options:
  --db <name>            Knowledge base name (default: "default")
  --limit <n>            Max search results (default: 5)
  --mode <mode>          Search mode: vector|keyword|hybrid
  --embedder <preset>    Embedder preset: nomic|bge|mxbai|minilm
  --force                Force full reindex (ignore hashes)
  --prune                Remove missing sources during reindex
  --dry-run              Preview merge changes without writing

Web crawl options (for add with a URL):
  --crawl                Follow links from the seed URL
  --crawl-max-depth <n>  Link traversal depth (default: 3)
  --crawl-max-pages <n>  Max pages to fetch (default: 100)
  --crawl-same-origin    Stay on same domain (default: true)

Examples:
  rag add ./docs/
  rag add https://docs.example.com --crawl --crawl-max-depth 2
  rag search "how to configure auth"
  rag search "error handling" --mode hybrid --limit 10
  rag reindex --force
  rag merge /path/to/other.sqlite --dry-run
  rag embedder list
  rag doctor
  rag status
EOF
        ;;
    *)
        echo "Unknown command: $CMD"
        echo "Run 'rag help' for usage"
        exit 1
        ;;
esac
