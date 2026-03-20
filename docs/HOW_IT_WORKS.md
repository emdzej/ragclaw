# How RagClaw Works

This document explains how RagClaw processes your documents and makes them searchable. No PhD required.

## The Big Picture

When you run `ragclaw add ./docs/`, here's what happens:

```
Your Files → Extract Text → Split into Chunks → Generate Embeddings → Store in Database
```

When you run `ragclaw search "how to authenticate"`:

```
Your Query → Generate Embedding → Find Similar Chunks → Return Results
```

Let's break down each step.

---

## Step 1: Extraction

**Goal:** Get plain text out of your files.

Different file types need different approaches:

| File Type | How We Extract |
|-----------|----------------|
| Markdown (`.md`) | Already text — just read it |
| PDF (`.pdf`) | Parse the PDF structure, extract text layer |
| Word (`.docx`) | Unzip (it's actually a ZIP!), parse XML inside |
| Web pages | Fetch HTML, strip tags, keep the content |
| Code (`.ts`, `.py`, etc.) | Read as text, but treat it specially later |
| Images (`.png`, `.jpg`) | Run OCR (optical character recognition) |

**For scanned PDFs:** We detect pages with very little text (<50 characters) and automatically run OCR on them.

---

## Step 2: Chunking

**Goal:** Split long documents into smaller, meaningful pieces.

Why chunk? Because:
- Search works better on focused pieces than entire documents
- AI models have input limits
- You want to find the *relevant part*, not the whole book

### How We Chunk Documents

For regular text (markdown, docs, web pages), we use **semantic chunking**:

1. Split by paragraphs and headings
2. Keep chunks around 512 tokens (~400 words)
3. Overlap chunks by ~50 tokens (so we don't cut sentences in half)
4. Preserve context (include the parent heading)

**Example:**

```markdown
# Authentication

## OAuth2 Flow

OAuth2 is a protocol that allows...
[300 more words]

## API Keys

API keys are simpler but less secure...
[300 more words]
```

Becomes:

- **Chunk 1:** "Authentication > OAuth2 Flow: OAuth2 is a protocol that allows..."
- **Chunk 2:** "Authentication > API Keys: API keys are simpler but less secure..."

Each chunk knows which section it came from.

### How We Chunk Code

Code is special. We don't just split by lines — we parse the **Abstract Syntax Tree (AST)**.

Using [tree-sitter](https://tree-sitter.github.io/), we understand the code structure:

```typescript
// This becomes ONE chunk (a complete function)
export function authenticate(user: string, password: string): boolean {
  const hash = sha256(password);
  return database.verify(user, hash);
}

// This becomes ANOTHER chunk
export class AuthService {
  private tokens: Map<string, Token> = new Map();
  
  validateToken(token: string): boolean {
    return this.tokens.has(token);
  }
}
```

Each function, class, or method becomes its own chunk. This way, when you search for "token validation", you get the complete `validateToken` method — not a random slice of code.

**Supported languages:** TypeScript/JavaScript, Python, Go, Java

**Fallback:** If tree-sitter can't parse a file, we fall back to splitting every 50 lines.

---

## Step 3: Embeddings

**Goal:** Convert text into numbers that capture *meaning*.

This is where the magic happens.

### What's an Embedding?

An embedding is a list of numbers (a "vector") that represents the *meaning* of text. Similar meanings → similar numbers.

```
"How do I log in?"     → [0.12, -0.45, 0.78, 0.33, ...]
"Authentication help"  → [0.11, -0.44, 0.79, 0.31, ...]  ← Very similar!
"Pizza recipe"         → [-0.82, 0.15, -0.23, 0.67, ...] ← Very different
```

These vectors have 768 numbers each (dimensions). You can't read them, but computers can compare them mathematically.

### How We Generate Them

We use the **nomic-embed-text-v1.5** model:

- Runs 100% locally (no API calls, no internet needed)
- ~270MB download (cached after first use)
- Processes text in ~50ms per chunk

The model was trained on millions of text pairs to learn that "car" and "automobile" are similar, "bank" (money) and "bank" (river) are different based on context, etc.

### The Embedding Process

```
"OAuth2 is a protocol..."
        ↓
   [Tokenize into pieces]
        ↓
   [Run through neural network]
        ↓
   [768 numbers representing meaning]
        ↓
   [0.12, -0.45, 0.78, ..., 0.33]
```

We add prefixes to help the model understand intent:
- Documents get: `"search_document: OAuth2 is a protocol..."`
- Queries get: `"search_query: how does oauth work"`

---

## Step 4: Storage

**Goal:** Save everything so we can search it later.

Everything goes into a **SQLite database** — a single file you can copy anywhere.

### What We Store

```
┌─────────────────────────────────────────────────────────────┐
│  sources table                                              │
│  ─────────────────                                          │
│  id: "abc123"                                               │
│  path: "/docs/auth.md"                                      │
│  content_hash: "sha256..."  ← For detecting changes         │
│  indexed_at: 1710924000                                     │
└─────────────────────────────────────────────────────────────┘
           │
           │ has many
           ▼
┌─────────────────────────────────────────────────────────────┐
│  chunks table                                               │
│  ─────────────────                                          │
│  id: "chunk789"                                             │
│  source_id: "abc123"                                        │
│  text: "OAuth2 is a protocol that allows..."               │
│  start_line: 15                                             │
│  end_line: 45                                               │
│  embedding: [0.12, -0.45, 0.78, ...]  ← 768 floats          │
│  metadata: { heading: "Authentication > OAuth2" }           │
└─────────────────────────────────────────────────────────────┘
```

### Full-Text Search Index (FTS5)

SQLite's FTS5 extension creates a keyword search index:

```sql
-- When you search "oauth protocol", FTS5 finds chunks containing those words
-- It scores by: how rare the words are × how often they appear
```

This is classic search — like Google before it got smart.

### Vector Search

For semantic search, we store embeddings and compare them using **cosine similarity**:

```
similarity = cos(angle between two vectors)

1.0  = identical meaning
0.0  = unrelated
-1.0 = opposite meaning (rare in practice)
```

---

## Step 5: Search

**Goal:** Find the most relevant chunks for your query.

### Hybrid Search

We combine two approaches:

| Method | What it does | Good at |
|--------|--------------|---------|
| **Vector search** | Compare meaning via embeddings | "auth" finds "authentication" |
| **Keyword search** | Match exact words (FTS5/BM25) | "OAuth2" finds "OAuth2" |

Final score = **(0.7 × vector score) + (0.3 × keyword score)**

Why both? Vector search understands synonyms but might miss exact terms. Keyword search finds exact matches but misses paraphrases. Together, they cover more ground.

### Search Flow

```
Query: "how to validate JWT tokens"
                ↓
        [Generate query embedding]
                ↓
        [0.23, -0.67, 0.45, ...]
                ↓
    ┌───────────┴───────────┐
    ↓                       ↓
[Vector search]      [Keyword search]
Find chunks with     Find chunks with
similar embeddings   "JWT", "tokens", etc.
    ↓                       ↓
 Score: 0.85            Score: 0.72
    ↓                       ↓
    └───────────┬───────────┘
                ↓
    [Combine: 0.7×0.85 + 0.3×0.72 = 0.81]
                ↓
    [Return top results sorted by score]
```

---

## Incremental Indexing

RagClaw is smart about re-indexing:

1. **Content hashing:** We SHA-256 hash each file's content
2. **Skip unchanged:** If the hash matches what we stored, skip it
3. **Update changed:** If different, remove old chunks, add new ones

This means `ragclaw add ./docs/` is fast the second time — it only processes what changed.

---

## Performance Tips

| Scenario | Tip |
|----------|-----|
| First run is slow | Model downloads once (~270MB), then cached |
| Large codebase | Code parsing takes time; be patient |
| Many small files | Batch processing helps; we do this automatically |
| Scanned PDFs | OCR is slow (~1-2 sec/page); consider pre-processing |

### Typical Performance

- **Embedding:** ~50ms per chunk
- **Vector search:** <10ms for 10,000 chunks
- **Index size:** ~1KB per chunk (text + embedding + metadata)

---

## Putting It All Together

Here's the complete flow when you index a directory:

```
ragclaw add ./docs/
        ↓
[Scan directory, find files]
        ↓
[For each file:]
  ├─→ [Check content hash — skip if unchanged]
  ├─→ [Extract text based on file type]
  ├─→ [Chunk into semantic pieces]
  ├─→ [Generate embedding for each chunk]
  └─→ [Store in SQLite: source + chunks + embeddings + FTS index]
        ↓
[Done! Ready to search]
```

And when you search:

```
ragclaw search "authentication flow"
        ↓
[Generate query embedding]
        ↓
[Vector search: find similar chunk embeddings]
        ↓
[Keyword search: find matching words]
        ↓
[Combine scores (70% vector + 30% keyword)]
        ↓
[Return top results with source info]
```

---

## Why Local-First?

Everything runs on your machine:

- **Privacy:** Your code and docs never leave your computer
- **Speed:** No network latency, no API rate limits
- **Offline:** Works on a plane, in a bunker, wherever
- **Portable:** Copy the SQLite file anywhere

The only download is the embedding model (~270MB, once).

---

## Further Reading

- [SQLite FTS5](https://www.sqlite.org/fts5.html) — Full-text search in SQLite
- [Tree-sitter](https://tree-sitter.github.io/tree-sitter/) — Code parsing library
- [nomic-embed-text](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5) — The embedding model we use
- [Cosine Similarity](https://en.wikipedia.org/wiki/Cosine_similarity) — The math behind vector comparison
