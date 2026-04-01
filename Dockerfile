# Copyright (c) 2026 Michał Jaskólski and contributors
#
# This source code is licensed under the MIT License found in the
# LICENSE file in the root directory of this repository.
#
# Multi-stage Dockerfile for @emdzej/ragclaw-mcp
# Produces a rootless, least-privilege container for the RagClaw MCP server.
#
# Build:
#   docker build -t ragclaw-mcp .
#
# Run (HTTP — default):
#   docker run -d \
#     --name ragclaw-mcp \
#     -p 3000:3000 \
#     -v ./config:/etc/ragclaw:ro \
#     -v ragclaw-data:/data/ragclaw \
#     --cap-drop=ALL \
#     --no-new-privileges \
#     --read-only \
#     --tmpfs /tmp:noexec,nosuid,size=64m \
#     ragclaw-mcp
#
# Run (stdio — for MCP clients like Claude Desktop):
#   docker run -i --rm \
#     -v ./config:/etc/ragclaw:ro \
#     -v ragclaw-data:/data/ragclaw \
#     --cap-drop=ALL \
#     --no-new-privileges \
#     ragclaw-mcp --transport stdio
#
# Extend allowed paths (e.g. mount a workspace for indexing):
#   docker run -d \
#     -p 3000:3000 \
#     -v ./config:/etc/ragclaw:ro \
#     -v ragclaw-data:/data/ragclaw \
#     -v /home/user/projects:/workspace:ro \
#     -e RAGCLAW_ALLOWED_PATHS="/data/ragclaw,/workspace" \
#     --cap-drop=ALL \
#     --no-new-privileges \
#     ragclaw-mcp

# =============================================================================
# Stage 1: Build
# =============================================================================
FROM node:22-bookworm AS build

# System dependencies for native modules:
#   better-sqlite3  — build-essential, python3
#   canvas          — libcairo2-dev, libpango1.0-dev, libjpeg-dev, libgif-dev, librsvg2-dev
#   tree-sitter     — build-essential (already covered)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    python3 \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg62-turbo-dev \
    libgif-dev \
    librsvg2-dev \
  && rm -rf /var/lib/apt/lists/*

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10.6.1 --activate

WORKDIR /build

# Copy workspace config first (maximise layer cache for dependency install)
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json biome.json ./

# Copy all package.json files for workspace resolution
COPY packages/core/package.json packages/core/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/mcp/package.json packages/mcp/package.json
COPY plugins/ragclaw-plugin-github/package.json plugins/ragclaw-plugin-github/package.json
COPY plugins/ragclaw-plugin-obsidian/package.json plugins/ragclaw-plugin-obsidian/package.json
COPY plugins/ragclaw-plugin-youtube/package.json plugins/ragclaw-plugin-youtube/package.json
COPY plugins/ragclaw-plugin-ollama/package.json plugins/ragclaw-plugin-ollama/package.json

# Install dependencies (separate layer — only invalidated when package.json or lockfile changes)
RUN pnpm install --frozen-lockfile

# Copy source code
COPY packages/ packages/
COPY plugins/ plugins/

# Build all packages (Turborepo handles dependency order)
RUN pnpm build

# Deploy MCP package with production-only dependencies into /prod.
# pnpm deploy creates a self-contained directory with all transitive prod deps.
RUN pnpm --filter @emdzej/ragclaw-mcp deploy --legacy --prod /prod/mcp

# Deploy plugins alongside (they have no extra prod deps beyond core)
RUN for plugin in ragclaw-plugin-github ragclaw-plugin-obsidian ragclaw-plugin-youtube ragclaw-plugin-ollama; do \
      mkdir -p /prod/plugins/$plugin && \
      cp -r plugins/$plugin/dist /prod/plugins/$plugin/dist && \
      cp plugins/$plugin/package.json /prod/plugins/$plugin/package.json; \
    done

# =============================================================================
# Stage 2: Runtime
# =============================================================================
FROM node:22-bookworm-slim AS runtime

# Runtime-only system libraries for native modules:
#   better-sqlite3  — none (statically linked)
#   canvas          — libcairo2, libpango, libjpeg, libgif, librsvg
#   tree-sitter     — libstdc++6 (included in slim)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libcairo2 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libjpeg62-turbo \
    libgif7 \
    librsvg2-2 \
    # df command for entrypoint filesystem check
    coreutils \
  && rm -rf /var/lib/apt/lists/*

# Create non-root user with fixed UID/GID
RUN groupadd -g 10001 ragclaw \
  && useradd -u 10001 -g ragclaw -s /usr/sbin/nologin -M -d /nonexistent ragclaw

# Create mount-point directories owned by ragclaw
RUN mkdir -p /etc/ragclaw /data/ragclaw \
  && chown ragclaw:ragclaw /data/ragclaw

# Copy deployed MCP server (self-contained with prod deps only)
WORKDIR /app
COPY --from=build /prod/mcp/ ./
COPY --from=build /prod/plugins/ plugins/

# Copy entrypoint script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Environment: locked-down defaults
ENV NODE_ENV=production
ENV RAGCLAW_CONFIG_DIR=/etc/ragclaw
ENV RAGCLAW_DATA_DIR=/data/ragclaw
ENV RAGCLAW_PLUGINS_DIR=/app/plugins
ENV RAGCLAW_ALLOWED_PATHS=/data/ragclaw
ENV RAGCLAW_BLOCK_PRIVATE_URLS=true

# Expose HTTP port (informational — only relevant in HTTP transport mode)
EXPOSE 3000

# Volume declarations (informational — documents mount points)
VOLUME ["/data/ragclaw"]

# Drop to non-root user
USER ragclaw:ragclaw

ENTRYPOINT ["/entrypoint.sh"]
CMD ["--transport", "http", "--host", "0.0.0.0", "--port", "3000"]

# Metadata
LABEL org.opencontainers.image.title="ragclaw-mcp" \
      org.opencontainers.image.description="RagClaw MCP server — local-first RAG engine" \
      org.opencontainers.image.url="https://github.com/emdzej/ragclaw" \
      org.opencontainers.image.source="https://github.com/emdzej/ragclaw" \
      org.opencontainers.image.licenses="MIT"
