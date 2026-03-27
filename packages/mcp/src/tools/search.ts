/**
 * Copyright (c) 2026 Michał Jaskólski and contributors
 *
 * This source code is licensed under the MIT License found in the
 * LICENSE file in the root directory of this repository.
 */

import { existsSync } from "node:fs";
import type { SearchResult } from "@emdzej/ragclaw-core";
import { getDbPath } from "@emdzej/ragclaw-core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getCachedStore, getEmbedder } from "../services.js";

// ---------------------------------------------------------------------------
// Query decomposition
// ---------------------------------------------------------------------------

/**
 * Split a compound query into independent sub-queries.
 *
 * Agents often pack multiple topics into a single search, e.g.:
 *   "how authentication works and what are the database migration steps"
 *
 * A single embedding for such a query lands in a "middle ground" of the
 * vector space that matches *neither* topic well, and the FTS leg requires
 * all terms to appear in a single chunk.
 *
 * This function splits on common natural-language delimiters so each
 * sub-query can be embedded and searched independently.
 */
function decomposeQuery(text: string): string[] {
  // Split on explicit delimiters that indicate separate intents:
  //   • semicolons, newlines
  //   • " and " / " & " when surrounded by 3+ word phrases
  //   • numbered list items (1. / 2. / - / *)
  const trimmed = text.trim();
  if (!trimmed) return [];

  // Step 1: split on semicolons and newlines
  let parts = trimmed
    .split(/[;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  // Step 2: split on " and " / " & " only when both sides have ≥3 words
  // (avoids splitting "pros and cons" or "search and replace")
  const refined: string[] = [];
  for (const part of parts) {
    const andSplit = part.split(/\s+(?:and|&)\s+/i);
    if (andSplit.length > 1 && andSplit.every((s) => s.trim().split(/\s+/).length >= 3)) {
      refined.push(...andSplit.map((s) => s.trim()).filter(Boolean));
    } else {
      refined.push(part);
    }
  }
  parts = refined;

  // Step 3: split numbered/bulleted items (e.g. "1. foo 2. bar" or "- foo - bar")
  const finalParts: string[] = [];
  for (const part of parts) {
    const listItems = part
      .split(/(?:^|\s)(?:\d+[.)]\s+|[-*]\s+)/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (listItems.length > 1) {
      finalParts.push(...listItems);
    } else {
      finalParts.push(part);
    }
  }

  // Deduplicate and filter out very short fragments (< 3 chars)
  const seen = new Set<string>();
  return finalParts.filter((q) => {
    if (q.length < 3) return false;
    const key = q.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Merge multiple ranked result lists using Reciprocal Rank Fusion (RRF).
 *
 * RRF is position-based and doesn't depend on raw score scales, making it
 * ideal for combining results from different sub-queries whose scores are
 * not directly comparable.
 *
 *   score_rrf(chunk) = Σ  1 / (k + rank_in_list)
 *
 * @param resultLists - Array of result arrays (each sorted by descending relevance)
 * @param limit - Maximum results to return
 * @param k - RRF constant (default 60, per the original paper)
 */
function reciprocalRankFusion(
  resultLists: SearchResult[][],
  limit: number,
  k = 60
): SearchResult[] {
  const scores = new Map<string, { result: SearchResult; rrfScore: number }>();

  for (const results of resultLists) {
    for (let rank = 0; rank < results.length; rank++) {
      const r = results[rank];
      const existing = scores.get(r.chunk.id);
      const contribution = 1 / (k + rank + 1);
      if (existing) {
        existing.rrfScore += contribution;
      } else {
        scores.set(r.chunk.id, { result: r, rrfScore: contribution });
      }
    }
  }

  const merged = Array.from(scores.values());
  merged.sort((a, b) => b.rrfScore - a.rrfScore);
  return merged.slice(0, limit).map((entry) => ({
    ...entry.result,
    score: entry.rrfScore,
  }));
}

// ---------------------------------------------------------------------------
// Tool implementation
// ---------------------------------------------------------------------------

async function ragSearch(args: { query: string; db?: string; limit?: number }): Promise<string> {
  const dbName = args.db || "default";
  const dbPath = getDbPath(dbName);

  if (!existsSync(dbPath)) {
    return `Knowledge base "${dbName}" not found. Run kb_add first to create it.`;
  }

  const store = await getCachedStore(dbName);
  const embedder = await getEmbedder(dbName, store);
  const limit = args.limit || 5;

  const subQueries = decomposeQuery(args.query);

  let results: SearchResult[];

  if (subQueries.length <= 1) {
    // Single query — use the original path (faster, no extra embedding calls)
    const embedding = await embedder.embedQuery(args.query);
    results = await store.search({
      text: args.query,
      embedding,
      limit,
      mode: "hybrid",
    });
  } else {
    // Multiple sub-queries — search each independently, merge with RRF
    const subResults = await Promise.all(
      subQueries.map(async (sq) => {
        const embedding = await embedder.embedQuery(sq);
        return store.search({
          text: sq,
          embedding,
          limit: limit * 2, // over-fetch per sub-query for better RRF merging
          mode: "hybrid",
        });
      })
    );
    results = reciprocalRankFusion(subResults, limit);
  }

  if (results.length === 0) {
    return "No results found.";
  }

  const formatted = results.map((r, i) => {
    const lines =
      r.chunk.startLine && r.chunk.endLine
        ? ` (lines ${r.chunk.startLine}-${r.chunk.endLine})`
        : "";
    const score = (r.score * 100).toFixed(1);
    return `[${i + 1}] ${r.chunk.sourcePath}${lines}\nScore: ${score}%\n${r.chunk.text}`;
  });

  return formatted.join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerSearchTool(server: McpServer): void {
  server.registerTool(
    "kb_search",
    {
      description:
        "Search the knowledge base for relevant documents and code. Returns matching chunks with source paths and relevance scores. Always prefer this over listing sources — search finds the relevant content directly.",
      inputSchema: {
        query: z.string().describe("Search query text"),
        db: z.string().optional().describe("Knowledge base name (default: 'default')"),
        limit: z.number().optional().describe("Maximum number of results (default: 5)"),
      },
    },
    async ({ query, db, limit }) => {
      try {
        const result = await ragSearch({ query, db, limit });
        return { content: [{ type: "text" as const, text: result }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error}` }], isError: true };
      }
    }
  );
}
