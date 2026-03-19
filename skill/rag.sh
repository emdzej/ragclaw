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
    help|--help|-h)
        cat << 'EOF'
RagClaw - Local-first RAG for OpenClaw

Commands:
  add <source>      Index a file, directory, or URL
  search <query>    Search the knowledge base
  status            Show knowledge base stats
  list              List indexed sources
  remove <source>   Remove a source from index
  init [name]       Initialize a new knowledge base

Options:
  --db <name>       Knowledge base name (default: "default")
  --limit <n>       Max search results (default: 5)
  --mode <mode>     Search mode: vector|keyword|hybrid

Examples:
  rag add ./docs/
  rag add https://docs.example.com
  rag search "how to configure auth"
  rag status
EOF
        ;;
    *)
        echo "Unknown command: $CMD"
        echo "Run 'rag help' for usage"
        exit 1
        ;;
esac
