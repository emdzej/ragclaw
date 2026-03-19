# ragclaw-plugin-obsidian

RagClaw plugin for indexing Obsidian vaults and notes.

## Installation

```bash
npm install -g ragclaw-plugin-obsidian
```

## Usage

```bash
# Index entire vault by name
ragclaw add obsidian://my-vault

# Index specific folder
ragclaw add obsidian://my-vault/Projects

# Index single note
ragclaw add obsidian://my-vault/Daily/2024-01-15.md

# Index vault by absolute path
ragclaw add obsidian:///Users/me/Documents/MyVault
```

## URL Schemes

| Scheme | Example | Description |
|--------|---------|-------------|
| `obsidian://` | `obsidian://my-vault` | Vault by name |
| `vault://` | `vault://my-vault/folder` | Alias for obsidian:// |
| `obsidian:///` | `obsidian:///absolute/path` | Absolute path (note: 3 slashes) |

## Vault Discovery

Vaults are searched in these locations:

**macOS:**
- `~/Documents/`
- `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/`
- `~/Obsidian/`

**Windows:**
- `C:\Users\<user>\Documents\`
- `C:\Users\<user>\Obsidian\`

**Linux:**
- `~/Documents/`
- `~/Obsidian/`
- `~/.obsidian/`

## Features

- **Wikilinks:** `[[links]]` converted to readable text
- **Embeds:** `![[embeds]]` converted to references
- **Tags:** `#tags` preserved as metadata
- **Frontmatter:** YAML properties extracted (tags, aliases, etc.)
- **Folders:** Index specific subfolders
- **Single notes:** Index individual files

## Search Examples

```bash
# Index your notes vault
ragclaw add obsidian://notes

# Search for project ideas
ragclaw search "project ideas" -d default

# Index just daily notes
ragclaw add obsidian://notes/Daily
```

## Metadata

Each note includes:
- `vault` — Vault name
- `path` — Relative path in vault
- `name` — Note filename (without .md)
- `tags` — From frontmatter
- `aliases` — From frontmatter

## License

MIT
