# ragclaw-plugin-youtube

RagClaw plugin for indexing YouTube video transcripts.

## Installation

```bash
npm install -g ragclaw-plugin-youtube
```

## Usage

```bash
# Using youtube:// scheme
ragclaw add youtube://dQw4w9WgXcQ

# Using yt:// scheme (shorthand)
ragclaw add yt://dQw4w9WgXcQ

# Using full YouTube URL
ragclaw add "https://youtube.com/watch?v=dQw4w9WgXcQ"
ragclaw add "https://youtu.be/dQw4w9WgXcQ"
```

## Features

- Fetches auto-generated and manual transcripts
- Extracts video metadata (title, channel, duration)
- Formats transcript for semantic search
- Supports multiple URL formats

## Indexed Content

Each video is indexed with:

```markdown
# Video Title

**Video ID:** dQw4w9WgXcQ
**Channel:** Channel Name
**Duration:** 3:32
**URL:** https://youtube.com/watch?v=dQw4w9WgXcQ

---

## Transcript

Never gonna give you up, never gonna let you down...
```

## Limitations

- Requires videos to have transcripts (auto-generated or manual)
- Some videos may have transcripts disabled
- Age-restricted videos may not work

## Development

```bash
cd plugins/ragclaw-plugin-youtube
pnpm install
pnpm build
npm link
```

## License

MIT
