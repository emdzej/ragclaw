---
model_tier: "medium"
name: memory
description: Search knowledge bases and recall time-stamped memories to answer questions grounded in authoritative sources. Combines internal knowledge (via Ragclaw), public library docs (via Context7), and temporal recall (e.g. "what did I save last week?").
compatibility: opencode
license: MIT
metadata:
  version: "0.9.0"
---

# Memory

Search, store, and recall. This skill retrieves authoritative knowledge from internal knowledge bases (via Ragclaw) and public library/framework documentation (via Context7), then synthesizes a grounded answer with clear provenance. Supports temporal queries -- filter by when content was stored to recall recent notes, past decisions, or anything in a time window.

## When to Use This Skill

Activate this skill when the user asks a question where **looking it up** is better than **reasoning from memory**:

- "How does X library handle Y?"
- "What's the recommended pattern for Z in framework W?"
- "What do we have documented about [domain topic]?"
- "What did I write down last week about authentication?"
- "What notes did I save yesterday?"
- "I need to build X with Y, advise me on patterns to use"
- "Remember this: [some information]" (store for later recall)

**Do NOT use this skill for:**

- Pure coding tasks ("write me a function that does X")
- General conversation or clarification questions
- Tasks where the user already provided all necessary context

## Workflow

### Step 1: Analyze the Query

Before searching, identify:

1. **Intent** -- is the user searching for knowledge, recalling something they stored, or asking to store new information?
2. **Temporal signals** -- does the query mention time? ("last week", "yesterday", "in March", "recently")
3. **Domain concepts** -- what internal/project-specific knowledge might be relevant?
4. **Specific libraries or frameworks** -- are any technologies explicitly mentioned by name?
5. **The core question** -- what does the user actually need to know?

### Step 2: Store Information (if intent is "remember this")

If the user wants to **store** information for later recall, use `kb_add` with the `content` parameter:

- Use `content` for inline text (not `source`).
- Use `name` to give the memory a descriptive label (e.g. "auth-decision-2025-04").
- Optionally set `timestamp` if the user specifies when the information is from (UTC epoch ms). If omitted, it defaults to now.
- Confirm what was stored and inform the user they can recall it later with search.

After storing, you're done -- skip to the response.

### Step 3: Search Internal Knowledge (Ragclaw)

Always start with internal knowledge -- your team may have standards or opinions that override generic documentation.

#### 3.1 Discover Available Knowledge Bases

Use `kb_list_databases` to list all available knowledge bases and their descriptions/keywords.

- If **no knowledge bases exist**, skip to Step 4 and note the gap in the output (see Step 5).
- If **one database exists**, search it.
- If **multiple databases exist**, select the most relevant one(s) based on their description and keywords matching the user's query. Search at most 2 databases to stay focused.

#### 3.2 Search the Knowledge Base

Use `kb_search` with a well-crafted query derived from the user's question. Target the specific concepts, not the full question verbatim.

- Use the `db` parameter to target the selected knowledge base(s).
- Set an appropriate `limit` (5 results is a good default).
- If results are poor or empty, try one reformulated query before giving up.

**Temporal filtering** -- if the query has time signals, convert them to epoch milliseconds and pass `after` and/or `before`:

| User says | Parameters |
|-----------|-----------|
| "last 24 hours" | `after: Date.now() - 86_400_000` |
| "last week" | `after: Date.now() - 604_800_000` |
| "in March 2025" | `after: 1740787200000, before: 1743465600000` |
| "before January" | `before: 1735689600000` |
| "yesterday" | `after: <start of yesterday epoch ms>, before: <start of today epoch ms>` |

When computing epoch ms values, use the current date and UTC. Be precise -- "last week" means 7 days ago from now, not "the previous calendar week".

#### 3.3 Read Full Sources (if needed)

If `kb_search` returns a relevant chunk but you need more context from the same source, use `kb_read_source` with the exact source path from the search result. This returns all chunks from that source concatenated in document order.

### Step 4: Search Public Documentation (Context7)

Use Context7 to look up official library and framework documentation. **Only do this if the user's query mentions specific technologies by name.**

If the query is purely conceptual with no specific library or framework named (e.g. "how should I structure a microservice?"), skip this step entirely.

#### 4.1 Resolve Library IDs

For each technology mentioned (up to 2-3 max), use `context7_resolve-library-id`:

- Pass the user's question as the `query` parameter for relevance ranking.
- Select the best match based on name similarity, source reputation, and snippet coverage.

#### 4.2 Query Documentation

For each resolved library ID, use `context7_query-docs`:

- Craft a specific query focused on what the user needs to know about that library.
- Be precise -- "How to set up authentication middleware in Express.js" is better than "auth".

**Important:** Context7 tools are limited to 3 calls each per question. Budget accordingly when multiple libraries are involved.

### Step 5: Synthesize and Respond

Combine all retrieved knowledge into a structured research brief. Use the following format:

```
## Internal Knowledge Base

[Findings from Ragclaw searches. Include the database name for each result.]
[Reference specific documents or chunks that informed the answer.]
[If temporal filtering was used, mention the time window.]

If no knowledge bases were configured:
> No internal knowledge bases are configured. You can create one by indexing
> relevant documentation, URLs, or files using the `kb_add` tool.
> This will improve future searches with project-specific context.

If knowledge bases exist but returned no relevant results:
> No relevant results found in [database name(s)]. Consider indexing
> documentation related to [topic] to improve future searches.

## Library Documentation

[Findings from Context7 queries. Include the library name for each result.]
[Reference specific documentation sections, code examples, or patterns.]

If Context7 was skipped (no specific technology mentioned):
> No specific library or framework was referenced -- skipped public
> documentation lookup.

If Context7 returned no useful results:
> No relevant documentation found for [library name(s)].

## Synthesis & Recommendation

[Combined reasoning that integrates both internal and public knowledge.]
[Clearly call out where internal standards differ from or extend public docs.]
[Provide actionable recommendations grounded in the retrieved sources.]
[If sources conflict, acknowledge the conflict and explain your reasoning.]
```

## MCP Tools Reference

| Tool | Purpose |
|------|---------|
| `kb_search` | Search for relevant chunks. Supports `after`/`before` (epoch ms) for temporal filtering. |
| `kb_read_source` | Retrieve full content of a source (all chunks concatenated). Use source path from `kb_search` results. |
| `kb_add` | Index a file/directory/URL (`source`) or inline text (`content`). Supports `timestamp` (epoch ms). |
| `kb_status` | Knowledge base statistics (chunks, sources, size). |
| `kb_remove` | Remove a source from the index. |
| `kb_reindex` | Re-process changed sources. Supports `force`, `prune`, chunker overrides. |
| `kb_list_chunkers` | List available chunkers (built-in and plugin-provided). |
| `kb_db_merge` | Merge another SQLite knowledge base into a local one. |
| `kb_list_databases` | List all knowledge bases with description and keywords. |
| `kb_db_init` | Create a new named knowledge base. |
| `kb_db_info` | Set description and keywords for a knowledge base. |
| `kb_db_info_get` | Get description and keywords for a knowledge base. |
| `kb_db_delete` | Delete a knowledge base permanently. |
| `kb_db_rename` | Rename a knowledge base. |

## Guidelines

### Query Crafting

- Extract the core concepts from the user's question -- don't search the full question verbatim.
- For Ragclaw, use domain-specific terminology that would appear in internal docs.
- For Context7, use the library's own terminology and concepts.

### Source Priority

- Internal knowledge takes priority over public documentation when they conflict.
- If internal docs reference specific versions or configurations, honor those.
- Public documentation fills gaps where internal knowledge is silent.

### Transparency

- Always cite which source informed each part of the answer.
- If a recommendation is your own synthesis (not directly from a source), say so.
- Never present retrieved information as your own reasoning or vice versa.

### Do Not Chase Source Files

- Ragclaw search results include source paths as metadata. **Never** use these paths to read, glob, or open the original files.
- Knowledge bases are portable -- they may have been indexed on a different machine, in a different directory, or from URLs that are no longer accessible.
- The chunk text returned by `kb_search` is the complete, authoritative content. If the chunk doesn't contain enough detail, search with a different query instead of trying to read the source file.

### Handling Uncertainty

- If both sources return nothing useful, say so clearly and provide the best answer you can from general knowledge, clearly labeled as such.
- Don't hallucinate sources or fabricate documentation references.

### Temporal Queries

- When the user mentions time, always compute the epoch milliseconds and use `after`/`before` filters. Don't just search with time words in the query -- semantic search won't reliably match timestamps.
- If no results are found within the time window, widen it or try without the filter and mention you broadened the search.
- `timestamp` on chunks represents when the content was written or relevant (user-supplied), not necessarily when it was indexed.
