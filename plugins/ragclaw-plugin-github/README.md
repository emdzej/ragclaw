# ragclaw-plugin-github

RagClaw plugin for indexing GitHub repositories, issues, pull requests, and discussions.

## Installation

```bash
npm install -g ragclaw-plugin-github
```

## Requirements

- [GitHub CLI](https://cli.github.com/) (`gh`) installed and authenticated

## Usage

```bash
# Index repository README
ragclaw add github://owner/repo

# Index all issues
ragclaw add github://owner/repo/issues

# Index specific issue with comments
ragclaw add github://owner/repo/issues/30

# Index all PRs
ragclaw add github://owner/repo/pulls

# Index specific PR with reviews
ragclaw add github://owner/repo/pulls/5

# Index discussions
ragclaw add github://owner/repo/discussions
```

## URL Schemes

| Scheme | Example | Content |
|--------|---------|---------|
| `github://` | `github://emdzej/ragclaw` | Full URL format |
| `gh://` | `gh://emdzej/ragclaw/issues` | Short alias |

## Supported Content Types

| Path | Description |
|------|-------------|
| `owner/repo` | Repository README and description |
| `owner/repo/issues` | All open/closed issues (limit 100) |
| `owner/repo/issues/N` | Specific issue with all comments |
| `owner/repo/pulls` | All pull requests (limit 100) |
| `owner/repo/pulls/N` | Specific PR with reviews and comments |
| `owner/repo/discussions` | Repository discussions |

## Search Examples

```bash
# Index a project's issues
ragclaw add github://emdzej/ksiazkomol/issues

# Search for implementation details
ragclaw search "work edition refactoring" -d default

# Index multiple content types
ragclaw add github://emdzej/ragclaw
ragclaw add github://emdzej/ragclaw/issues
ragclaw add github://emdzej/ragclaw/pulls
```

## License

MIT
