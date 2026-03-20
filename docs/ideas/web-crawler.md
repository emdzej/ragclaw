# Web Crawler

> Issue: https://github.com/emdzej/ragclaw/issues/50

## Use Cases

- Documentation sites (docs.example.com)
- Blogs
- Wiki / knowledge bases
- Static project sites

## CLI

```bash
# Basic crawl
ragclaw index https://docs.example.com --crawl

# With options
ragclaw index https://docs.example.com \
  --crawl \
  --max-depth=3 \
  --max-pages=100 \
  --same-origin \
  --include="/docs/**" \
  --exclude="/blog/**"

# Speed control
ragclaw index https://example.com --crawl --concurrency=4 --delay=500

# Ignore robots.txt (use responsibly)
ragclaw index https://example.com --crawl --ignore-robots
```

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `--crawl` | false | Enable crawling (follow links) |
| `--max-depth` | 3 | Maximum link depth from start URL |
| `--max-pages` | 100 | Maximum pages to crawl |
| `--same-origin` | true | Stay on same domain |
| `--include` | - | Glob patterns to include |
| `--exclude` | - | Glob patterns to exclude |
| `--concurrency` | 1 | Concurrent requests |
| `--delay` | 1000 | Delay between requests (ms) |
| `--ignore-robots` | false | Ignore robots.txt |
| `--follow-redirects` | true | Follow HTTP redirects |

## Implementation

### Extend existing WebExtractor

Add crawl capability to `WebExtractor` rather than separate extractor:

```typescript
interface CrawlOptions {
  maxDepth?: number;
  maxPages?: number;
  sameOrigin?: boolean;
  include?: string[];
  exclude?: string[];
  concurrency?: number;
  delayMs?: number;
  respectRobots?: boolean;
}

class WebExtractor {
  // Existing single-page extraction
  async extract(source: Source): Promise<ExtractedContent>;
  
  // New: crawl and yield pages
  async *crawl(startUrl: string, options: CrawlOptions): AsyncGenerator<ExtractedContent>;
}
```

### Features

#### robots.txt

```typescript
// Parse and respect robots.txt
const robots = await fetchRobotsTxt(origin);
if (!robots.isAllowed(url, 'RagClaw')) {
  skip(url);
}
```

#### Sitemap.xml

```typescript
// Optional: discover pages via sitemap
const sitemap = await fetchSitemap(origin);
for (const url of sitemap.urls) {
  queue.add(url);
}
```

#### Deduplication

```typescript
// Skip duplicate content (same hash, different URL)
const hash = contentHash(html);
if (seen.has(hash)) {
  skip(url); // canonical redirect, etc.
}
```

#### Incremental crawl

```typescript
// Use Last-Modified / ETag for re-crawl
const cached = store.getSource(url);
if (cached?.etag === response.headers.etag) {
  skip(url); // not modified
}
```

### Store URL origin in metadata

```typescript
metadata: {
  url: 'https://docs.example.com/guide/intro',
  origin: 'https://docs.example.com',  // crawl start point
  crawlDepth: 2,
  crawledAt: 1710965432000,
  etag: '"abc123"',
  lastModified: '2026-03-15T10:00:00Z'
}
```

### Progress reporting

```
Crawling https://docs.example.com
  Discovered: 47 pages
  Indexed:    23 pages
  Skipped:    5 (robots.txt)
  Errors:     2
  Depth:      2/3
  [████████░░░░░░░░] 49%
```

## Edge Cases

- Infinite loops (A→B→A) — track visited URLs
- Query params (?page=1, ?page=2) — normalize or allow
- Hash fragments (#section) — ignore by default
- JavaScript-rendered content — out of scope (use browser extractor?)
- Rate limit responses (429) — back off and retry

## Future Ideas

- `ragclaw crawl status` — show crawl history
- `ragclaw crawl resume <url>` — continue interrupted crawl
- Scheduled re-crawl via cron
- Webhook on new content
