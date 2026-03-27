/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { getDbPath, Store, sanitizeDbName } from "@emdzej/ragclaw-core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getCachedStore, invalidateStoreCache, RAGCLAW_DIR } from "../services.js";

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function ragListDatabases(): Promise<string> {
  if (!existsSync(RAGCLAW_DIR)) {
    return "[]";
  }

  let entries: string[];
  try {
    entries = await readdir(RAGCLAW_DIR);
  } catch {
    return "[]";
  }

  const names = entries
    .filter((f) => f.endsWith(".sqlite"))
    .map((f) => f.slice(0, -".sqlite".length))
    .sort();

  // Open each store briefly to read description + keywords
  const results = await Promise.all(
    names.map(async (name) => {
      try {
        const store = await getCachedStore(name);
        const description = (await store.getMeta("db_description")) ?? null;
        const keywordsRaw = (await store.getMeta("db_keywords")) ?? "";
        const keywords = keywordsRaw
          ? keywordsRaw
              .split(",")
              .map((k: string) => k.trim())
              .filter(Boolean)
          : [];
        return { name, description, keywords };
      } catch {
        return { name, description: null, keywords: [] };
      }
    })
  );

  return JSON.stringify(results);
}

async function ragDbInit(args: {
  db?: string;
  description?: string;
  keywords?: string;
}): Promise<string> {
  const dbName = args.db ?? "default";
  const dbPath = getDbPath(dbName);

  if (existsSync(dbPath)) {
    return `Knowledge base "${dbName}" already exists at ${dbPath}`;
  }

  await mkdir(RAGCLAW_DIR, { recursive: true });

  // Write operation — create and then close so the next read picks it up
  const store = new Store();
  await store.open(dbPath);

  try {
    if (args.description) {
      await store.setMeta("db_description", args.description);
    }
    if (args.keywords) {
      await store.setMeta("db_keywords", args.keywords);
    }
  } finally {
    await store.close();
    // No invalidation needed — this is a brand-new DB, not in cache yet
  }

  return `Created knowledge base "${dbName}" at ${dbPath}`;
}

async function ragDbInfo(args: {
  db?: string;
  description?: string;
  keywords?: string;
}): Promise<string> {
  const dbName = args.db ?? "default";
  const dbPath = getDbPath(dbName);

  if (!existsSync(dbPath)) {
    return `Error: Knowledge base "${dbName}" not found.`;
  }

  if (args.description === undefined && args.keywords === undefined) {
    return "Error: Provide at least one of description or keywords.";
  }

  // Write operation — use a fresh Store and invalidate cache afterward
  const store = new Store();
  await store.open(dbPath);

  try {
    if (args.description !== undefined) {
      await store.setMeta("db_description", args.description);
    }
    if (args.keywords !== undefined) {
      await store.setMeta("db_keywords", args.keywords);
    }
  } finally {
    await store.close();
    await invalidateStoreCache(dbName);
  }

  return `Updated info for knowledge base "${dbName}"`;
}

async function ragDbInfoGet(args: { db?: string }): Promise<string> {
  const dbName = args.db ?? "default";
  const dbPath = getDbPath(dbName);

  if (!existsSync(dbPath)) {
    return `Error: Knowledge base "${dbName}" not found.`;
  }

  const store = await getCachedStore(dbName);

  const description = (await store.getMeta("db_description")) ?? null;
  const keywordsRaw = (await store.getMeta("db_keywords")) ?? "";
  const keywords = keywordsRaw
    ? keywordsRaw
        .split(",")
        .map((k: string) => k.trim())
        .filter(Boolean)
    : [];
  return JSON.stringify({ name: dbName, description, keywords });
}

async function ragDbDelete(args: { db?: string; confirm?: boolean }): Promise<string> {
  if (!args.confirm) {
    return `Error: Destructive operation requires confirm=true. Set confirm=true to delete knowledge base "${args.db ?? "default"}".`;
  }

  const dbName = args.db ?? "default";
  let safeName: string;
  try {
    safeName = sanitizeDbName(dbName);
  } catch (err: unknown) {
    return `Error: ${err}`;
  }

  const dbPath = getDbPath(safeName);

  if (!existsSync(dbPath)) {
    return `Error: Knowledge base "${safeName}" not found.`;
  }

  // Close any cached Store before deleting the file
  await invalidateStoreCache(safeName);

  try {
    await rm(dbPath);
    return `Deleted knowledge base "${safeName}"`;
  } catch (err: unknown) {
    return `Error: Failed to delete "${safeName}": ${err}`;
  }
}

async function ragDbRename(args: {
  oldName: string;
  newName: string;
  confirm?: boolean;
}): Promise<string> {
  if (!args.confirm) {
    return `Error: Destructive operation requires confirm=true. Set confirm=true to rename knowledge base "${args.oldName}" to "${args.newName}".`;
  }

  let safeOld: string;
  let safeNew: string;
  try {
    safeOld = sanitizeDbName(args.oldName);
    safeNew = sanitizeDbName(args.newName);
  } catch (err: unknown) {
    return `Error: ${err}`;
  }

  const oldPath = getDbPath(safeOld);
  const newPath = getDbPath(safeNew);

  if (!existsSync(oldPath)) {
    return `Error: Knowledge base "${safeOld}" not found.`;
  }

  if (existsSync(newPath)) {
    return `Error: Knowledge base "${safeNew}" already exists. Choose a different name.`;
  }

  // Close any cached Store before renaming the file
  await invalidateStoreCache(safeOld);

  try {
    await rename(oldPath, newPath);
    return `Renamed knowledge base "${safeOld}" to "${safeNew}"`;
  } catch (err: unknown) {
    return `Error: Failed to rename "${safeOld}": ${err}`;
  }
}

// ---------------------------------------------------------------------------
// Tool registrations
// ---------------------------------------------------------------------------

export function registerDatabaseTools(server: McpServer): void {
  server.registerTool(
    "kb_list_databases",
    {
      description:
        "List all available knowledge bases. Returns a JSON array of objects with name, description, and keywords fields — use this to decide which knowledge base to search.",
      inputSchema: {},
    },
    async () => {
      try {
        const result = await ragListDatabases();
        return { content: [{ type: "text" as const, text: result }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "kb_db_init",
    {
      description:
        "Initialize a new knowledge base. Creates an empty SQLite database at the configured data directory. Safe to call if the knowledge base already exists — returns a message without overwriting.",
      inputSchema: {
        db: z.string().optional().describe("Knowledge base name (default: 'default')"),
        description: z
          .string()
          .optional()
          .describe("Human-readable description of this knowledge base"),
        keywords: z
          .string()
          .optional()
          .describe(
            "Comma-separated keywords that describe the content (e.g. 'api, auth, endpoints')"
          ),
      },
    },
    async ({ db, description, keywords }) => {
      try {
        const result = await ragDbInit({ db, description, keywords });
        return { content: [{ type: "text" as const, text: result }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "kb_db_info",
    {
      description:
        "Set or update the description and keywords for an existing knowledge base. Use this so that kb_list_databases can return enriched metadata that helps an agent decide which knowledge base to search.",
      inputSchema: {
        db: z.string().optional().describe("Knowledge base name (default: 'default')"),
        description: z
          .string()
          .optional()
          .describe("Human-readable description of this knowledge base"),
        keywords: z
          .string()
          .optional()
          .describe(
            "Comma-separated keywords that describe the content (e.g. 'api, auth, endpoints')"
          ),
      },
    },
    async ({ db, description, keywords }) => {
      try {
        const result = await ragDbInfo({ db, description, keywords });
        return { content: [{ type: "text" as const, text: result }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "kb_db_info_get",
    {
      description:
        "Get the description and keywords stored for a knowledge base. Returns a JSON object with name, description, and keywords fields. Use this to inspect metadata before updating it.",
      inputSchema: {
        db: z.string().optional().describe("Knowledge base name (default: 'default')"),
      },
    },
    async ({ db }) => {
      try {
        const result = await ragDbInfoGet({ db });
        return { content: [{ type: "text" as const, text: result }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "kb_db_delete",
    {
      description:
        "Delete a knowledge base and its .sqlite file permanently. This operation is irreversible. You MUST pass confirm=true explicitly to proceed — this prevents accidental deletion.",
      inputSchema: {
        db: z.string().optional().describe("Knowledge base name to delete (default: 'default')"),
        confirm: z
          .boolean()
          .optional()
          .describe(
            "Must be true to confirm the destructive operation. Omitting or passing false returns an error."
          ),
      },
    },
    async ({ db, confirm }) => {
      try {
        const result = await ragDbDelete({ db, confirm });
        return { content: [{ type: "text" as const, text: result }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "kb_db_rename",
    {
      description:
        "Rename a knowledge base. Errors if the new name already exists. You MUST pass confirm=true explicitly to proceed — this prevents accidental renaming.",
      inputSchema: {
        oldName: z.string().describe("Current name of the knowledge base"),
        newName: z.string().describe("New name for the knowledge base"),
        confirm: z
          .boolean()
          .optional()
          .describe(
            "Must be true to confirm the operation. Omitting or passing false returns an error."
          ),
      },
    },
    async ({ oldName, newName, confirm }) => {
      try {
        const result = await ragDbRename({ oldName, newName, confirm });
        return { content: [{ type: "text" as const, text: result }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error}` }], isError: true };
      }
    }
  );
}
