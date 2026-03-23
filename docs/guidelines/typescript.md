# TypeScript Guidelines

> This project uses TypeScript 5.x with `strict: true` (enforced in every `tsconfig.json`) and
> [Biome](https://biomejs.dev/) as the combined formatter + linter.
> Run `pnpm lint` to check; `pnpm lint:fix` to auto-fix.

---

## Core Rules

| Rule | Setting |
|------|---------|
| `strict` | `true` — mandatory, never weaken |
| `noExplicitAny` | Biome warns — treat as error in new code |
| `noUnusedVariables` | Biome error |
| `noUnusedImports` | Biome error |
| `useNodejsImportProtocol` | `node:fs`, `node:path`, etc. — always use the `node:` prefix |
| Quote style | Double quotes (`"`) |
| Indent | 2 spaces |
| Line width | 100 characters |
| Trailing commas | `es5` |
| Semicolons | Always |

---

## ESM Imports

This repo is `"type": "module"` throughout.  
**Always include the `.js` extension** in relative imports — even when importing `.ts` source files:

```typescript
// ✅ Correct
import { Store } from "./store/index.js";
import type { Chunk } from "../types.js";

// ❌ Wrong — will fail at runtime under NodeNext resolution
import { Store } from "./store/index";
```

---

## Types vs Interfaces

```typescript
// ✅ Use `type` for data shapes and API contracts
type SearchMode = "vector" | "keyword" | "hybrid";

type SearchResult = {
  chunk: ChunkRecord;
  score: number;
  scoreVector?: number;
  scoreKeyword?: number;
};

// ✅ Use `interface` for service contracts / plugin contracts (with I-prefix)
interface IExtractor {
  canHandle(source: Source): boolean;
  extract(source: Source): Promise<ExtractedContent>;
}

interface IChunker {
  canHandle(content: ExtractedContent): boolean;
  chunk(content: ExtractedContent, sourceId: string, sourcePath: string): Promise<Chunk[]>;
}
```

**Rule of thumb:**
- `type` → data shapes, unions, utility types
- `interface` → contracts implemented by classes or plugins (`IExtractor`, `IChunker`, `IStore`)

---

## Const Objects over Enums

```typescript
// ✅ Good — tree-shakeable, no runtime overhead
const SearchModes = {
  VECTOR: "vector",
  KEYWORD: "keyword",
  HYBRID: "hybrid",
} as const;

type SearchMode = (typeof SearchModes)[keyof typeof SearchModes];

// ❌ Bad — enums add runtime overhead and poor tree-shaking
enum SearchMode { Vector = "vector", Keyword = "keyword" }
```

---

## Naming Conventions

| Kind | Convention | Example |
|------|-----------|---------|
| Variables | camelCase | `chunkList`, `isIndexed` |
| Constants | SCREAMING_SNAKE_CASE | `MAX_CHUNK_SIZE`, `DEFAULT_PRESET` |
| Functions | camelCase | `createEmbedder`, `hashFile` |
| Types | PascalCase | `SearchResult`, `EmbedderPreset` |
| Interfaces | PascalCase with `I` prefix | `IExtractor`, `IStore` |
| Const Objects | PascalCase + plural | `SearchModes`, `EmbedderPresets` |
| Classes | PascalCase | `MarkdownExtractor`, `SemanticChunker` |

---

## File Naming

| Kind | Convention | Example |
|------|-----------|---------|
| Types / interfaces | camelCase or PascalCase | `types.ts`, `plugin.ts` |
| Utilities | camelCase | `hash.ts`, `math.ts` |
| Tests | Same name + `.test.ts` | `guards.test.ts` |
| Barrel exports | `index.ts` | `src/index.ts` |

---

## Discriminated Unions (preferred over throwing for expected failures)

```typescript
// Return type that callers can narrow with a type guard
type GuardResult =
  | { allowed: true }
  | { allowed: false; reason: string };

// Usage — no try/catch needed
const result = isPathAllowed(inputPath, config);
if (!result.allowed) {
  return `Error: ${result.reason}`;
}
```

---

## Anti-Patterns

```typescript
// ❌ any
function process(data: any): any {}

// ✅ unknown + type narrowing
function process(data: unknown): string {
  if (typeof data !== "string") throw new TypeError("Expected string");
  return data.toUpperCase();
}

// ❌ type assertion without validation
const chunk = response as ChunkRecord;

// ✅ guard or zod parse
if (!isChunkRecord(response)) throw new Error("Invalid chunk");

// ❌ non-null assertion
const text = chunk!.text;

// ✅ optional chaining or explicit check
const text = chunk?.text ?? "";

// ❌ bare relative import (fails under NodeNext)
import { foo } from "./foo";

// ✅ with .js extension
import { foo } from "./foo.js";
```

---

## Explicit Return Types

Public functions exported from a package **must** have explicit return types:

```typescript
// ✅ exported — type is part of the public API
export function createEmbedder(config?: EmbedderResolvedConfig): EmbedderPlugin { ... }

// internal helper — return type may be inferred
function normalizeText(input: string) {
  return input.trim().toLowerCase();
}
```

---

## `readonly` for Immutable Data

```typescript
// ✅ Mark fields that should not be mutated after construction
export interface EmbedderPlugin {
  readonly name: string;
  dimensions: number; // mutable — auto-detected after first call
}
```
