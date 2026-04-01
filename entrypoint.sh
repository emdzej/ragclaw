#!/bin/sh
# Copyright (c) 2026 Michał Jaskólski and contributors
#
# This source code is licensed under the MIT License found in the
# LICENSE file in the root directory of this repository.
#
# Entrypoint for ragclaw-mcp Docker container.
# Performs pre-flight checks, then exec's into the Node process.

set -e

DATA_DIR="${RAGCLAW_DATA_DIR:-/data/ragclaw}"

# ------------------------------------------------------------------
# Pre-flight: verify the data directory is writable
# ------------------------------------------------------------------
if [ ! -d "$DATA_DIR" ]; then
  echo "ERROR: Data directory $DATA_DIR does not exist." >&2
  echo "       Mount a volume at $DATA_DIR or set RAGCLAW_DATA_DIR." >&2
  exit 1
fi

if ! touch "$DATA_DIR/.write-test" 2>/dev/null; then
  echo "ERROR: Data directory $DATA_DIR is not writable." >&2
  echo "       Ensure the volume is mounted with write permissions" >&2
  echo "       for UID $(id -u) / GID $(id -g)." >&2
  exit 1
fi
rm -f "$DATA_DIR/.write-test"

# ------------------------------------------------------------------
# Pre-flight: warn about network filesystems (SQLite WAL issue)
# ------------------------------------------------------------------
if command -v df >/dev/null 2>&1; then
  FS_TYPE=$(df -T "$DATA_DIR" 2>/dev/null | awk 'NR==2 {print $2}')
  case "$FS_TYPE" in
    nfs*|cifs|smb*|fuse.sshfs|9p)
      echo "WARNING: Data directory $DATA_DIR is on a network filesystem ($FS_TYPE)." >&2
      echo "         SQLite WAL mode may corrupt data on network-attached volumes." >&2
      echo "         Use a local bind mount or Docker named volume instead." >&2
      ;;
  esac
fi

# ------------------------------------------------------------------
# Hand off to the MCP server. exec replaces this shell process so
# signals (SIGTERM, SIGINT) go directly to Node.
# ------------------------------------------------------------------
exec node /app/dist/index.js "$@"
