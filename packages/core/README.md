# @emdzej/ragclaw-core

Core RAG engine for RagClaw — extractors, chunkers, embedder, and SQLite store.

## Installation

```bash
npm install @emdzej/ragclaw-core
```

## Features

- **Extractors** — Markdown, PDF, DOCX, Web, Code, Images (OCR)
- **Chunkers** — Semantic (documents) and AST-based (code via tree-sitter)
- **Embedder** — Configurable local embeddings (nomic, bge, mxbai, minilm, or custom HF models)
- **Store** — SQLite with FTS5 + vector search + `store_meta` for embedder tracking

## Embedder Presets

Four built-in presets are available via `createEmbedder({ alias })`:

| Alias | Model | Language | Context | Dims | ~RAM |
|-------|-------|----------|---------|------|------|
| `nomic` ⭐ | `nomic-ai/nomic-embed-text-v1.5` | English | 8 192 tok | 768 | ~600 MB |
| `bge` | `BAAI/bge-m3` | 100+ languages | 8 192 tok | 1024 | ~2.3 GB |
| `mxbai` | `mixedbread-ai/mxbai-embed-large-v1` | English | 512 tok | 1024 | ~1.4 GB |
| `minilm` | `sentence-transformers/all-MiniLM-L6-v2` | English | 256 tok | 384 | ~90 MB |

> ⭐ Default preset used when no alias is specified.

**Per-model notes:**

- **`nomic`** — Best general-purpose choice for English content. 8 192-token context handles long documents well. Supports [Matryoshka](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5#matryoshka-embeddings) representation — dimensions can be truncated to 512/256/128/64 with negligible quality loss if storage is tight. Requires task-instruction prefixes (`search_document:` / `search_query:`), which the preset applies automatically.

- **`bge`** — The only multilingual preset. Supports 100+ languages and tops multilingual retrieval benchmarks (MIRACL, MKQA). Choose this whenever your corpus is non-English or mixed-language. Heaviest RAM footprint (~2.3 GB).

- **`mxbai`** — Highest English retrieval quality per MTEB (64.68 avg over 56 datasets, beating OpenAI `text-embedding-3-large`). Hard limit: **512-token context window** — content beyond 512 tokens is silently truncated. Use with short-to-medium length documents.

- **`minilm`** — Lightest model (~90 MB, 22.7 M params). **256-token context window** — best for short notes, sentences, or any environment where RAM is a constraint. Not suited for long documents.

## Vector Search & sqlite-vec

The Store uses [sqlite-vec](https://alexgarcia.xyz/sqlite-vec/) for fast native vector search when available. If not, it falls back to a pure-JS cosine similarity scan — correct but slow above ~5 000 chunks.

Install `sqlite-vec` alongside this package to enable native search:

```bash
npm install sqlite-vec
```

The Store will automatically detect and load it at `open()` time. You can check status programmatically:

```typescript
const store = new Store();
await store.open("./kb.sqlite");

console.log(store.hasVectorSupport);      // true | false
console.log(store.vectorExtensionSource); // "npm" | "system" | null
```

## `createEmbedder()` Factory

```typescript
import { createEmbedder } from "@emdzej/ragclaw-core";

// Use default (nomic)
const embedder = createEmbedder();

// Use a preset alias
const embedder = createEmbedder({ alias: "minilm" });

// Use an arbitrary HuggingFace model (dims auto-detected)
const embedder = createEmbedder({ model: "some-org/some-model" });

// Use a plugin-provided embedder
const embedder = createEmbedder({ pluginEmbedder: myPlugin.embedder });

// Embed text
const vec = await embedder.embed("hello world");       // document embedding
const qvec = await embedder.embedQuery("hello world"); // query embedding
```

## `EmbedderPlugin` Interface

Implement this to provide a custom embedder from a plugin:

```typescript
interface EmbedderPlugin {
  embed(text: string): Promise<Float32Array>;
  embedQuery(text: string): Promise<Float32Array>;
  readonly dimensions: number;
  readonly modelName: string;
}
```

## System Requirements Checker

```typescript
import { checkSystemRequirements, resolvePreset } from "@emdzej/ragclaw-core";

const preset = resolvePreset("bge")!;
const check = checkSystemRequirements(preset);

if (!check.canRun) {
  console.error(check.errors[0]); // "Insufficient free RAM..."
}
if (check.warnings.length > 0) {
  console.warn(check.warnings[0]); // "Low free RAM..."
}
```

## Documentation

See the main [RagClaw repository](https://github.com/emdzej/ragclaw) for full documentation.

## License

MIT
