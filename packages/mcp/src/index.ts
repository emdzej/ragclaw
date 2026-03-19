#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { homedir } from "os";
import { join } from "path";
import { existsSync } from "fs";
import { mkdir, readdir, readFile, stat } from "fs/promises";
import { createHash } from "crypto";
import { extname, resolve, basename } from "path";

import {
  Store,
  Embedder,
  SemanticChunker,
  CodeChunker,
  MarkdownExtractor,
  TextExtractor,
  PdfExtractor,
  DocxExtractor,
  WebExtractor,
  CodeExtractor,
} from "@emdzej/ragclaw-core";
import type { Source, Extractor, ChunkRecord, Chunker } from "@emdzej/ragclaw-core";

const RAGCLAW_DIR = join(homedir(), ".openclaw", "ragclaw");

function getDbPath(name: string): string {
  return join(RAGCLAW_DIR, `${name}.sqlite`);
}

// Tool definitions
const TOOLS: Tool[] = [
  {
    name: "rag_search",
    description: "Search the local knowledge base for relevant documents and code. Returns matching chunks with source paths and relevance scores.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query text",
        },
        db: {
          type: "string",
          description: "Knowledge base name (default: 'default')",
          default: "default",
        },
        limit: {
          type: "number",
          description: "Maximum number of results (default: 5)",
          default: 5,
        },
        mode: {
          type: "string",
          enum: ["vector", "keyword", "hybrid"],
          description: "Search mode (default: 'hybrid')",
          default: "hybrid",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "rag_add",
    description: "Index a file, directory, or URL into the knowledge base. Supports markdown, PDF, DOCX, code files, and web pages.",
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description: "File path, directory path, or URL to index",
        },
        db: {
          type: "string",
          description: "Knowledge base name (default: 'default')",
          default: "default",
        },
        recursive: {
          type: "boolean",
          description: "Recurse into directories (default: true)",
          default: true,
        },
      },
      required: ["source"],
    },
  },
  {
    name: "rag_status",
    description: "Get statistics about a knowledge base (number of sources, chunks, size).",
    inputSchema: {
      type: "object",
      properties: {
        db: {
          type: "string",
          description: "Knowledge base name (default: 'default')",
          default: "default",
        },
      },
    },
  },
  {
    name: "rag_list",
    description: "List all indexed sources in a knowledge base.",
    inputSchema: {
      type: "object",
      properties: {
        db: {
          type: "string",
          description: "Knowledge base name (default: 'default')",
          default: "default",
        },
      },
    },
  },
  {
    name: "rag_remove",
    description: "Remove a source from the knowledge base index.",
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description: "Source path or URL to remove",
        },
        db: {
          type: "string",
          description: "Knowledge base name (default: 'default')",
          default: "default",
        },
      },
      required: ["source"],
    },
  },
];

// Cached embedder (expensive to initialize)
let cachedEmbedder: Embedder | null = null;

async function getEmbedder(): Promise<Embedder> {
  if (!cachedEmbedder) {
    cachedEmbedder = new Embedder();
    // Warm up
    await cachedEmbedder.embed("test");
  }
  return cachedEmbedder;
}

// Tool implementations
async function ragSearch(args: {
  query: string;
  db?: string;
  limit?: number;
  mode?: "vector" | "keyword" | "hybrid";
}): Promise<string> {
  const dbName = args.db || "default";
  const dbPath = getDbPath(dbName);

  if (!existsSync(dbPath)) {
    return `Knowledge base "${dbName}" not found. Run rag_add first to create it.`;
  }

  const store = new Store();
  await store.open(dbPath);

  try {
    const embedder = await getEmbedder();
    const embedding = args.mode !== "keyword" 
      ? await embedder.embedQuery(args.query)
      : undefined;

    const results = await store.search({
      text: args.query,
      embedding,
      limit: args.limit || 5,
      mode: args.mode || "hybrid",
    });

    if (results.length === 0) {
      return "No results found.";
    }

    const formatted = results.map((r, i) => {
      const lines = r.chunk.startLine && r.chunk.endLine
        ? ` (lines ${r.chunk.startLine}-${r.chunk.endLine})`
        : "";
      const score = (r.score * 100).toFixed(1);
      return `[${i + 1}] ${r.chunk.sourcePath}${lines}\nScore: ${score}%\n${r.chunk.text.slice(0, 500)}${r.chunk.text.length > 500 ? "..." : ""}`;
    });

    return formatted.join("\n\n---\n\n");
  } finally {
    await store.close();
  }
}

async function ragAdd(args: {
  source: string;
  db?: string;
  recursive?: boolean;
}): Promise<string> {
  const dbName = args.db || "default";
  const dbPath = getDbPath(dbName);

  // Ensure directory exists
  await mkdir(RAGCLAW_DIR, { recursive: true });

  const store = new Store();
  await store.open(dbPath);

  const extractors: Extractor[] = [
    new MarkdownExtractor(),
    new PdfExtractor(),
    new DocxExtractor(),
    new WebExtractor(),
    new CodeExtractor(),
    new TextExtractor(),
  ];
  const semanticChunker = new SemanticChunker();
  const codeChunker = new CodeChunker();

  try {
    const embedder = await getEmbedder();
    const sources = await collectSources(args.source, args.recursive ?? true);
    
    let indexed = 0;
    let totalChunks = 0;
    const errors: string[] = [];

    for (const src of sources) {
      const displayPath = src.path || src.url || "unknown";

      try {
        const extractor = extractors.find((e) => e.canHandle(src));
        if (!extractor) {
          continue; // Skip unsupported
        }

        const isUrl = src.type === "url";
        const sourcePath = isUrl ? src.url! : src.path!;

        // Check existing
        const existing = await store.getSource(sourcePath);
        
        let contentHash: string;
        if (!isUrl) {
          const content = await readFile(src.path!, "utf-8").catch(() => 
            readFile(src.path!).then(b => b.toString("base64"))
          );
          contentHash = createHash("sha256").update(content).digest("hex");

          if (existing && existing.contentHash === contentHash) {
            continue; // Unchanged
          }
        } else {
          contentHash = createHash("sha256").update(sourcePath + Date.now()).digest("hex");
        }

        if (existing) {
          await store.removeChunksBySource(existing.id);
        }

        const extracted = await extractor.extract(src);
        const chunker: Chunker = extracted.sourceType === "code" ? codeChunker : semanticChunker;
        const chunks = await chunker.chunk(extracted, existing?.id ?? "", sourcePath);
        const embeddings = await embedder.embedBatch(chunks.map((c) => c.text));

        const now = Date.now();
        let mtime: number | undefined;
        if (!isUrl) {
          const fileStat = await stat(src.path!);
          mtime = fileStat.mtimeMs;
        }

        let finalSourceId: string;
        if (existing) {
          await store.updateSource(existing.id, {
            contentHash,
            mtime,
            indexedAt: now,
            metadata: extracted.metadata,
          });
          finalSourceId = existing.id;
        } else {
          finalSourceId = await store.addSource({
            path: sourcePath,
            type: src.type,
            contentHash,
            mtime,
            indexedAt: now,
            metadata: extracted.metadata,
          });
        }

        const chunkRecords: ChunkRecord[] = chunks.map((chunk, i) => ({
          ...chunk,
          sourceId: finalSourceId,
          embedding: embeddings[i],
          createdAt: now,
        }));

        await store.addChunks(chunkRecords);
        indexed++;
        totalChunks += chunkRecords.length;
      } catch (e) {
        errors.push(`${displayPath}: ${e}`);
      }
    }

    let result = `Indexed ${indexed} source(s), ${totalChunks} chunks.`;
    if (errors.length > 0) {
      result += `\n\nErrors:\n${errors.slice(0, 5).join("\n")}`;
      if (errors.length > 5) {
        result += `\n... and ${errors.length - 5} more`;
      }
    }
    return result;
  } finally {
    await store.close();
  }
}

async function ragStatus(args: { db?: string }): Promise<string> {
  const dbName = args.db || "default";
  const dbPath = getDbPath(dbName);

  if (!existsSync(dbPath)) {
    return `Knowledge base "${dbName}" not found.`;
  }

  const store = new Store();
  await store.open(dbPath);

  try {
    const stats = await store.getStats();
    const sizeKB = (stats.sizeBytes / 1024).toFixed(1);
    const updated = stats.lastUpdated 
      ? new Date(stats.lastUpdated).toLocaleString()
      : "never";

    return `Knowledge Base: ${dbName}
Path: ${dbPath}
Sources: ${stats.sources}
Chunks: ${stats.chunks}
Size: ${sizeKB} KB
Last Updated: ${updated}
Vector Support: ${store.hasVectorSupport ? "native" : "JS fallback"}`;
  } finally {
    await store.close();
  }
}

async function ragList(args: { db?: string }): Promise<string> {
  const dbName = args.db || "default";
  const dbPath = getDbPath(dbName);

  if (!existsSync(dbPath)) {
    return `Knowledge base "${dbName}" not found.`;
  }

  const store = new Store();
  await store.open(dbPath);

  try {
    const sources = await store.listSources();
    
    if (sources.length === 0) {
      return "No sources indexed.";
    }

    const lines = sources.map((s) => {
      const icon = s.type === "file" ? "📄" : s.type === "url" ? "🌐" : "📝";
      const date = new Date(s.indexedAt).toLocaleDateString();
      return `${icon} ${s.path} (${date})`;
    });

    return `Indexed sources (${sources.length}):\n${lines.join("\n")}`;
  } finally {
    await store.close();
  }
}

async function ragRemove(args: { source: string; db?: string }): Promise<string> {
  const dbName = args.db || "default";
  const dbPath = getDbPath(dbName);

  if (!existsSync(dbPath)) {
    return `Knowledge base "${dbName}" not found.`;
  }

  const store = new Store();
  await store.open(dbPath);

  try {
    const existing = await store.getSource(args.source);
    if (!existing) {
      return `Source not found: ${args.source}`;
    }

    await store.removeSource(existing.id);
    return `Removed: ${args.source}`;
  } finally {
    await store.close();
  }
}

// Helper to collect sources
async function collectSources(source: string, recursive: boolean): Promise<Source[]> {
  // URL
  if (source.startsWith("http://") || source.startsWith("https://")) {
    return [{ type: "url", url: source }];
  }

  const resolved = resolve(source);
  if (!existsSync(resolved)) {
    throw new Error(`Source not found: ${source}`);
  }

  const stats = await stat(resolved);
  if (stats.isFile()) {
    return [{ type: "file", path: resolved }];
  }

  if (stats.isDirectory() && recursive) {
    return collectFilesRecursive(resolved);
  }

  return [];
}

async function collectFilesRecursive(dir: string): Promise<Source[]> {
  const sources: Source[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  const supportedExts = [
    ".md", ".markdown", ".mdx", ".txt", ".text", ".pdf", ".docx",
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".java",
  ];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.name.startsWith(".")) continue;
    if (entry.name === "node_modules") continue;

    if (entry.isDirectory()) {
      const nested = await collectFilesRecursive(fullPath);
      sources.push(...nested);
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase();
      if (supportedExts.includes(ext)) {
        sources.push({ type: "file", path: fullPath });
      }
    }
  }

  return sources;
}

// Main server
async function main() {
  const server = new Server(
    {
      name: "ragclaw-mcp",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // List tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  // Call tool
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      let result: string;

      switch (name) {
        case "rag_search":
          result = await ragSearch(args as Parameters<typeof ragSearch>[0]);
          break;
        case "rag_add":
          result = await ragAdd(args as Parameters<typeof ragAdd>[0]);
          break;
        case "rag_status":
          result = await ragStatus(args as Parameters<typeof ragStatus>[0]);
          break;
        case "rag_list":
          result = await ragList(args as Parameters<typeof ragList>[0]);
          break;
        case "rag_remove":
          result = await ragRemove(args as Parameters<typeof ragRemove>[0]);
          break;
        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      return {
        content: [{ type: "text", text: result }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${error}` }],
        isError: true,
      };
    }
  });

  // Start server
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
