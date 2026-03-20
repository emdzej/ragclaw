# Database Merge/Import

> Issue: https://github.com/emdzej/ragclaw/issues/49

## Use Cases

- Merge bazy z laptopa + desktop
- Import od kolegi/zespołu
- Łączenie projektów
- Selective backup/restore

## Challenges

### 1. Different Embedders

Embeddings are incompatible between models — can't directly merge chunks indexed with different embedders.

### 2. Duplicates

Same file may exist in both databases with identical or different content.

### 3. Conflicts

Same source path but different versions/content.

## Merge Strategies

| Strategy | Description |
|----------|-------------|
| `strict` | Only if identical embedder — copies everything directly |
| `reindex` | Imports sources, regenerates embeddings with local model |
| `sources-only` | Only source metadata, no chunks/embeddings |

## CLI

```bash
# Basic merge
ragclaw merge ./other.db

# With strategy
ragclaw merge ./other.db --strategy=reindex

# Preview changes
ragclaw merge ./other.db --dry-run

# Conflict handling
ragclaw merge ./other.db --skip-duplicates
ragclaw merge ./other.db --prefer=local    # or --prefer=remote

# Filter what to import
ragclaw merge ./other.db --include="*.md"
ragclaw merge ./other.db --exclude="node_modules/**"
```

## Additional Commands

### Export portable format

```bash
# Export without embeddings (small, universal)
ragclaw export --format=portable -o backup.db

# Full export with embeddings
ragclaw export --format=full -o backup.db
```

### Diff databases

```bash
ragclaw diff ./other.db

# Output:
# Sources only in local:    12
# Sources only in remote:   8
# Modified (different hash): 3
# Identical:                 45
```

### Remote merge (future)

```bash
ragclaw merge user@host:~/project/ragclaw.db  # via SSH
ragclaw merge https://example.com/shared.db   # via HTTP
```

## Implementation Notes

### Merge Flow

1. Open both databases
2. Compare `store_meta` — check embedder compatibility
3. Build diff (new sources, modified, conflicts)
4. Apply strategy:
   - `strict`: Direct SQL INSERT
   - `reindex`: Copy sources → extract → chunk → embed
   - `sources-only`: Copy `sources` table only
5. Update `store_meta` with merge timestamp

### Database Schema Additions

```sql
-- Track merge history
CREATE TABLE IF NOT EXISTS merge_history (
  id TEXT PRIMARY KEY,
  source_path TEXT NOT NULL,
  merged_at INTEGER NOT NULL,
  strategy TEXT NOT NULL,
  sources_added INTEGER,
  sources_updated INTEGER,
  sources_skipped INTEGER
);
```
