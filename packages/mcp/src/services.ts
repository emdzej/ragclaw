/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import type { EmbedderPlugin, RagclawConfig, Source } from "@emdzej/ragclaw-core";
import {
  createEmbedder,
  getConfig,
  getDbPath,
  IndexingService,
  isPathAllowed,
  isUrlAllowed,
  Store,
} from "@emdzej/ragclaw-core";
import { getLogger } from "./logger.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const config = getConfig();
const RAGCLAW_DIR = config.dataDir;

export { config, RAGCLAW_DIR };

export function getRagClawConfig(): RagclawConfig {
  return config;
}

// ---------------------------------------------------------------------------
// Cached singletons (expensive to initialise)
// ---------------------------------------------------------------------------

/** Embedders cached per DB name (different DBs may use different models). */
const cachedEmbedders = new Map<string, EmbedderPlugin>();

export async function getEmbedder(dbName: string, store: Store): Promise<EmbedderPlugin> {
  const cached = cachedEmbedders.get(dbName);
  if (cached) return cached;

  // Prefer embedder_model (full HF model ID) over embedder_name, which may be
  // a short display name like "nomic-embed-text-v1.5" rather than a valid alias.
  const storedModel = await store.getMeta("embedder_model");
  const storedName = (await store.getMeta("embedder_name")) ?? "nomic";
  const embedder = storedModel
    ? createEmbedder({ model: storedModel })
    : createEmbedder({ alias: storedName });

  // Warm up (downloads model on first call)
  await embedder.embed("warmup");

  cachedEmbedders.set(dbName, embedder);
  return embedder;
}

/**
 * Persistent Store connections cached per DB name.
 *
 * Opening a Store is expensive: schema init, migration checks, sqlite-vec
 * loading attempt.  By keeping one open Store per DB we avoid ~20-50 ms of
 * overhead on every MCP tool call.  SQLite WAL mode allows concurrent reads,
 * and better-sqlite3 is synchronous so there are no concurrent-write hazards.
 *
 * Write operations (add, remove, reindex, merge) call `invalidateStoreCache()`
 * after they are done to ensure the next read picks up fresh state.
 */
const cachedStores = new Map<string, Store>();

export async function getCachedStore(dbName: string): Promise<Store> {
  const existing = cachedStores.get(dbName);
  if (existing) return existing;

  const dbPath = getDbPath(dbName);
  const store = new Store();
  await store.open(dbPath);
  cachedStores.set(dbName, store);
  return store;
}

/**
 * Close and evict a cached Store.  Call after write operations so the next
 * read picks up any schema or data changes.
 */
export async function invalidateStoreCache(dbName: string): Promise<void> {
  const store = cachedStores.get(dbName);
  if (store) {
    await store.close();
    cachedStores.delete(dbName);
  }
}

/**
 * Close all cached stores.  Called during graceful shutdown.
 */
export async function closeAllCachedStores(): Promise<void> {
  const log = getLogger();
  for (const [name, store] of cachedStores) {
    try {
      await store.close();
      log.debug({ db: name }, "Closed cached store");
    } catch (err: unknown) {
      log.warn({ db: name, err }, "Error closing cached store");
    }
  }
  cachedStores.clear();
}

/** IndexingService used for add/reindex operations. */
let cachedIndexingService: IndexingService | null = null;

export async function getIndexingService(): Promise<IndexingService> {
  if (!cachedIndexingService) {
    // Use default embedder (nomic) for indexing via MCP.
    // The embedder will be written to store metadata on first index.
    const embedder = createEmbedder();
    cachedIndexingService = new IndexingService({
      extractorLimits: config.extractorLimits,
      embedder,
    });
    await cachedIndexingService.init();
  }
  return cachedIndexingService;
}

/** Create a one-off IndexingService with specific chunker options (not cached). */
export async function buildIndexingService(
  chunker?: string,
  chunkSize?: number,
  overlap?: number,
  store?: Store
): Promise<IndexingService> {
  // When a store is provided, honour the embedder it was originally indexed with
  // so that re-chunked embeddings match the existing dimensionality.
  let embedder: EmbedderPlugin;
  if (store) {
    const storedModel = await store.getMeta("embedder_model");
    const storedName = await store.getMeta("embedder_name");
    embedder = storedModel
      ? createEmbedder({ model: storedModel })
      : storedName
        ? createEmbedder({ alias: storedName })
        : createEmbedder();
  } else {
    embedder = createEmbedder();
  }

  const svc = new IndexingService({
    extractorLimits: config.extractorLimits,
    embedder,
    chunkerStrategy: chunker ?? "auto",
    chunkerDefaults: { chunkSize, overlap },
  });
  await svc.init();
  return svc;
}

// ---------------------------------------------------------------------------
// Source collection helpers (with security enforcement)
// ---------------------------------------------------------------------------

export async function collectSources(source: string, recursive: boolean): Promise<Source[]> {
  // URL
  if (source.startsWith("http://") || source.startsWith("https://")) {
    const urlCheck = await isUrlAllowed(source, config);
    if (!urlCheck.allowed) {
      throw new Error(urlCheck.reason);
    }
    return [{ type: "url", url: source }];
  }

  const resolved = resolve(source);

  // Path allowlist check (MCP defaults to cwd if allowedPaths is empty)
  const pathCheck = isPathAllowed(resolved, config, process.cwd());
  if (!pathCheck.allowed) {
    throw new Error(pathCheck.reason);
  }

  if (!existsSync(resolved)) {
    throw new Error(`Source not found: ${source}`);
  }

  const stats = await stat(resolved);
  if (stats.isFile()) {
    return [{ type: "file", path: resolved }];
  }

  if (stats.isDirectory() && recursive) {
    const collected: Source[] = [];
    await collectFilesRecursive(resolved, collected, 0, config.maxDepth, config.maxFiles);
    return collected;
  }

  return [];
}

async function collectFilesRecursive(
  dir: string,
  collected: Source[],
  currentDepth: number,
  maxDepth: number,
  maxFiles: number
): Promise<void> {
  if (currentDepth >= maxDepth) {
    return; // depth limit reached
  }

  if (collected.length >= maxFiles) {
    return; // file count limit reached
  }

  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (collected.length >= maxFiles) return;

    const fullPath = join(dir, entry.name);

    if (entry.name.startsWith(".")) continue;
    if (entry.name === "node_modules") continue;

    if (entry.isDirectory()) {
      await collectFilesRecursive(fullPath, collected, currentDepth + 1, maxDepth, maxFiles);
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase();
      // If a config allowedExtensions list is set, skip files not in it.
      // An empty list means no restriction — let extractors decide.
      if (config.allowedExtensions.length > 0 && !config.allowedExtensions.includes(ext)) {
        continue;
      }
      collected.push({ type: "file", path: fullPath });
    }
  }
}
