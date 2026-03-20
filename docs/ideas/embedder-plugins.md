# Embedder Plugin System

> Issue: https://github.com/emdzej/ragclaw/issues/48

## Problem

Currently hardcoded to `nomic-ai/nomic-embed-text-v1.5` (768 dim).

## Proposal

Embedder as a **plugin system** — same pattern as extractors/chunkers.

## Architecture

### 1. Built-in Embedders (aliases)

```typescript
// Short aliases for common models
const EMBEDDER_PRESETS = {
  'nomic': { model: 'nomic-ai/nomic-embed-text-v1.5', dim: 768, queryPrefix: 'search_query:', docPrefix: 'search_document:' },
  'bge': { model: 'BAAI/bge-m3', dim: 1024 },
  'mxbai': { model: 'mixedbread-ai/mxbai-embed-large-v1', dim: 1024, queryPrefix: 'Represent this sentence:' },
  'minilm': { model: 'sentence-transformers/all-MiniLM-L6-v2', dim: 384 },
};
```

### 2. Embedder Plugin Interface

```typescript
interface EmbedderPlugin {
  name: string;
  
  // Model info
  dimensions: number;
  
  // Core methods
  embed(text: string): Promise<Float32Array>;
  embedQuery(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  
  // Lifecycle
  init?(): Promise<void>;
  dispose?(): Promise<void>;
}
```

### 3. External Plugin Packages

```bash
# Install external embedder
npm install ragclaw-embedder-ollama
npm install ragclaw-embedder-openai
```

```typescript
// Plugin example: Ollama embeddings
export class OllamaEmbedder implements EmbedderPlugin {
  name = 'ollama';
  dimensions = 4096; // llama3 embedding dim
  
  constructor(private config: { model: string; baseUrl?: string }) {}
  
  async embed(text: string) {
    const res = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: 'POST',
      body: JSON.stringify({ model: this.config.model, prompt: text })
    });
    return new Float32Array((await res.json()).embedding);
  }
}
```

### 4. Config File Support

```yaml
# ragclaw.yaml — defines HOW ragclaw works, not WHAT to index

embedder: bge  # alias

# OR full config
embedder:
  plugin: ollama
  model: nomic-embed-text
  baseUrl: http://localhost:11434

# OR HuggingFace model directly  
embedder:
  model: BAAI/bge-m3

# Other settings
store:
  path: ./ragclaw.db
  
chunker:
  maxTokens: 512
  overlap: 50
```

### 5. CLI Usage

```bash
# Paths always via CLI arguments
ragclaw index --embedder bge ./docs ./src

# Use config file (paths still from CLI)
ragclaw index --config ragclaw.yaml ./docs
```

## Built-in Aliases

| Alias | Model | Dim | Notes |
|-------|-------|-----|-------|
| `nomic` | nomic-ai/nomic-embed-text-v1.5 | 768 | Default, good balance |
| `bge` | BAAI/bge-m3 | 1024 | Best multilingual (100+ langs) |
| `mxbai` | mixedbread-ai/mxbai-embed-large-v1 | 1024 | Fast, MRL support |
| `minilm` | sentence-transformers/all-MiniLM-L6-v2 | 384 | Ultra-lightweight |

## Plugin Ideas

- `ragclaw-embedder-ollama` — local Ollama server
- `ragclaw-embedder-openai` — OpenAI API (text-embedding-3-*)
- `ragclaw-embedder-cohere` — Cohere Embed v4
- `ragclaw-embedder-voyage` — Voyage AI

## Store Compatibility

- Store metadata tracks embedder name + dimensions
- Error if re-indexing with incompatible embedder
- `ragclaw reindex --embedder <new>` to rebuild with different model
