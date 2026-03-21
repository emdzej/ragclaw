# Changelog

## [0.4.0] — 2026-03-21

### New features

#### Web crawler (`ragclaw add --crawl`)

You can now crawl an entire website and index every reachable page in one command:

```bash
ragclaw add --crawl https://example.com/docs
```

New flags on `ragclaw add` (and the `rag_add` MCP tool):

| Flag | Default | Description |
|------|---------|-------------|
| `--crawl` | — | Enable BFS crawling from the given URL |
| `--crawl-max-depth <n>` | `3` | Maximum link-follow depth |
| `--crawl-max-pages <n>` | `100` | Hard cap on pages indexed |
| `--crawl-same-origin` | `true` | Stay on the same hostname |
| `--crawl-include <patterns>` | — | Comma-separated URL path prefixes to allow |
| `--crawl-exclude <patterns>` | — | Comma-separated URL path prefixes to skip |
| `--crawl-concurrency <n>` | `3` | Parallel in-flight requests |
| `--crawl-delay <ms>` | `200` | Polite delay between requests |
| `--ignore-robots` | `false` | Ignore `robots.txt` rules |

The crawler respects `robots.txt` by default, normalises URLs to avoid duplicates, and filters to same-origin links unless `--crawl-same-origin false` is passed.

#### Knowledge base merge (`ragclaw merge`)

Merge one SQLite knowledge base into another without re-indexing from scratch:

```bash
# Merge remote.db into the default KB (strict — embeddings copied verbatim)
ragclaw merge remote.db

# Re-embed all imported text with the local model
ragclaw merge remote.db --strategy reindex

# Preview what would change without writing anything
ragclaw merge remote.db --dry-run

# Conflict resolution
ragclaw merge remote.db --on-conflict prefer-remote

# Selective import
ragclaw merge remote.db --include docs/,wiki/
ragclaw merge remote.db --exclude tmp/
```

Options:

| Flag | Default | Description |
|------|---------|-------------|
| `--strategy <s>` | `strict` | `strict` (copy embeddings) or `reindex` (re-embed locally) |
| `--on-conflict <r>` | `skip` | `skip`, `prefer-local`, or `prefer-remote` |
| `--dry-run` | — | Show a diff without writing anything |
| `--include <paths>` | — | Comma-separated source path prefixes to import |
| `--exclude <paths>` | — | Comma-separated source path prefixes to skip |

Each merge is recorded in a `merge_history` table inside the target database. The `rag_merge` MCP tool exposes the same functionality to AI assistants.

#### Offline model pre-download (`ragclaw embedder download`)

Pre-fetch embedding model files before going offline or before a CI/CD pipeline runs:

```bash
# Download a single preset
ragclaw embedder download nomic

# Download all four built-in presets
ragclaw embedder download --all

# Download a raw Hugging Face model ID
ragclaw embedder download org/model-name
```

Models already present in the local cache (`~/.cache/ragclaw/models/`) are silently skipped. The command prints a summary and exits with code `1` if any download fails, making it safe to use in scripts.

### Bug fixes

- **CLI version flag** — `ragclaw --version` / `ragclaw -V` now reads the version from `package.json` at runtime instead of a hardcoded string, so it always reflects the installed package version.

---

## [0.3.0] and earlier

See the git log for changes prior to 0.4.0.
