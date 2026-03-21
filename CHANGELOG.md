# Changelog

## [0.4.1] — 2026-03-21

### Documentation

- **OpenClaw skill setup guide** — added section 13 "OpenClaw skill setup" to `docs/USER_GUIDE.md` covering installation, usage, prerequisites, configuration, and storage paths.
- **USER_GUIDE installation fixes** — corrected scoped package names (`@emdzej/ragclaw-cli`, `@emdzej/ragclaw-mcp`), fixed the GitHub clone URL, and replaced `npm install / npm run build` with `pnpm install / pnpm run build` to match the actual toolchain.
- **USER_GUIDE section numbering** — added the previously missing `## 10. Configuration` heading; renumbered Plugins → §14 and Troubleshooting → §15 to accommodate the new §13.

### OpenClaw skill (`skill/`)

The skill bundled in the repository has been fully updated to match the current CLI:

- **`skill/SKILL.md`** — rewrote to cover all current commands (`reindex`, `merge`, `embedder list/download`, `doctor`, `plugin`, `config`); added full crawl flag reference, embedder presets table, image/OCR format entry, and corrected storage path to XDG `~/.local/share/ragclaw/`.
- **`skill/skill.json`** — added missing command entries (`reindex`, `merge`, `embedder`, `doctor`, `plugin`, `config`, `init`); fixed `storage` path.
- **`skill/rag.sh`** — added `case` branches for `reindex`, `merge`, `embedder`, `doctor`, `plugin`, and `config`; expanded `help` text to cover all commands, common options, and crawl flags.

### Package versions

All packages bumped to `0.4.1`:

- `@emdzej/ragclaw-core`
- `@emdzej/ragclaw-cli`
- `@emdzej/ragclaw-mcp`
- `ragclaw-plugin-github`
- `ragclaw-plugin-obsidian`
- `ragclaw-plugin-youtube`

Plugin `peerDependencies` lower bound updated to `>=0.4.1`.

---

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
