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

| Alias | Model | Dims | Est. RAM |
|-------|-------|------|----------|
| `nomic` | `nomic-ai/nomic-embed-text-v1.5` | 768 | ~600 MB |
| `bge` | `BAAI/bge-m3` | 1024 | ~2.3 GB |
| `mxbai` | `mixedbread-ai/mxbai-embed-large-v1` | 1024 | ~1.4 GB |
| `minilm` | `sentence-transformers/all-MiniLM-L6-v2` | 384 | ~90 MB |

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
