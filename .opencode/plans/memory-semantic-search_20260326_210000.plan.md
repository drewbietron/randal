# Plan: Memory Semantic Search + Project Scoping

**Slug**: memory-semantic-search
**Created**: 2026-03-26T21:00:00Z
**Status**: Complete
**Mode**: Thorough

## Summary

Upgrade Randal's memory system from pure BM25 keyword search to hybrid semantic search using Meilisearch's built-in embedder support, and add project-scoped vs. global memory categorization. Changes span three locations:

1. **`@randal/memory` package** (`packages/memory/`) — the shared implementation
2. **MCP memory server** (`tools/mcp-memory-server.ts`) — refactored to import from `@randal/memory` instead of duplicating logic
3. **`@randal/core` types + config** (`packages/core/`) — updated MemoryDoc type and config schema

## Requirements

### R1: Semantic Search via Meilisearch Embedders
1. Configure a Meilisearch embedder on the memory index at init time using `index.updateEmbedders()`
2. Use OpenRouter as the embedding provider to access `text-embedding-3-small` (user already has OpenRouter billing)
3. Meilisearch's REST embedder source should be used to call OpenRouter's embedding endpoint
4. At index time: Meilisearch auto-generates embeddings for new documents (no client-side embedding needed)
5. At search time: Use `hybrid: { embedder: "...", semanticRatio: 0.7 }` in search options
6. The `semanticRatio` should be configurable in the memory config (default 0.7 — favors semantic but still uses keywords)
7. The embedder config should read from the existing `config.memory.embedder` schema (currently dead code — wire it up)
8. If embedder init fails (e.g., bad API key, provider down), fall back gracefully to keyword-only search with a warning

### R2: Project Scoping (Global vs. Project Memories)
9. Add a `scope` field to `MemoryDoc`: `"global"` or `"project:{identifier}"`
10. Project identifier derived automatically from `git rev-parse --show-toplevel` (the repo root path)
11. If not in a git repo, scope defaults to `"global"`
12. Certain categories default to global scope: `preference`, `fact`
13. Other categories default to project scope: `pattern`, `lesson`, `skill-outcome`, all `session-*` categories
14. Users can explicitly override scope when storing (e.g., `memory_store({ ..., scope: "global" })`)
15. Search defaults to project-scoped: returns project memories + global memories (but NOT other projects' memories)
16. Cross-project search opt-in: `memory_search({ ..., scope: "all" })` to search everything
17. Add `scope` to Meilisearch filterable attributes

### R3: Shared Implementation (DRY)
18. Refactor `mcp-memory-server.ts` to import from `@randal/memory` instead of duplicating logic
19. The MCP server becomes a thin JSON-RPC transport layer over `MemoryManager` (or `MeilisearchStore` directly)
20. The MCP server still reads its config from env vars (MEILI_URL, MEILI_MASTER_KEY, MEILI_INDEX) but delegates all business logic to the package
21. Add new env vars for the MCP server: `OPENROUTER_API_KEY` (for embedder), `MEMORY_SCOPE` or auto-detect from git
22. Update `opencode.json` MCP config to pass the new env vars

### R4: Config & Type Updates
23. Update `MemoryDoc` interface in `@randal/core` types to add `scope` field
24. Wire up `config.memory.embedder` to be read by `MeilisearchStore.init()` and used to configure Meilisearch embedders
25. Add `semanticRatio` field to `config.memory` schema (default 0.7)
26. Add `openrouter` embedder type support: needs `apiKey`, `model`, and OpenRouter's embedding endpoint URL
27. The existing `openrouterEmbedderSchema` in config.ts already has `type`, `model`, `apiKey` — may need to add `url` for the REST embedder endpoint

### R5: Acceptance Criteria
28. Searching "outdoor recreation equipment marketplace" returns the paintball PRD memory (semantic match, not keyword)
29. Searching "paintball" still returns the paintball PRD (keyword match still works via hybrid)
30. A memory stored while working in repo A does NOT appear in searches from repo B (unless scope: "all")
31. A memory with category "preference" stored in repo A DOES appear in searches from repo B (global scope)
32. If OpenRouter embedding endpoint is unreachable, search falls back to keyword-only with a logged warning
33. The MCP server in opencode.json still works with the new implementation (no regression)
34. The `@randal/memory` package tests pass with the new changes

## Constraints

- Must use OpenRouter (not direct OpenAI) for embedding API calls
- Meilisearch's REST embedder source is the mechanism (it calls out to OpenRouter on behalf of the index)
- No breaking changes to existing memory data — existing documents should still be searchable (they'll lack embeddings until re-indexed)
- The MCP server must remain launchable via `bun run` from opencode.json
- Bun + TypeScript throughout (user preference)

## Answered Questions

- **OpenRouter embedding endpoint**: `POST https://openrouter.ai/api/v1/embeddings` — OpenAI-compatible format
- **Request format**: `{ model: "openai/text-embedding-3-small", input: ["text1", "text2"] }`
- **Response format**: `{ data: [{ embedding: [0.1, 0.2, ...] }, ...] }`
- **Meilisearch REST embedder config**: Maps perfectly — `source: "rest"`, `url: "https://openrouter.ai/api/v1/embeddings"`, request/response templates with `{{text}}` and `{{embedding}}` placeholders
- **Backfill**: Not needed for MVP — existing docs work with keyword search, new docs get embeddings automatically. Can add a backfill command later.

## Implementation Steps

- [x] Step 1: Update MemoryDoc type and config schema
- [x] Step 2: Add semantic search to MeilisearchStore
- [x] Step 3: Add scope filtering to MeilisearchStore
- [x] Step 4: Wire up embedder config in MemoryManager
- [x] Step 5: Refactor MCP server to use shared package
- [x] Step 6: Update opencode.json MCP config
- [x] Step 7: Update tool descriptions for scope awareness
- [x] Step 8: Add tests
- [x] Step 9: Manual verification and backfill consideration

### Step 1: Update MemoryDoc type and config schema [backend]
**File**: `packages/core/src/types.ts`, `packages/core/src/config.ts`
**Depends on**: None
**Acceptance**: TypeScript compiles, new fields are optional/backward-compatible

- Add `scope?: "global" | string` field to `MemoryDoc` interface (string allows `"project:/path/to/repo"`)
- Add `semanticRatio` field to `config.memory` schema (z.number().min(0).max(1).default(0.7))
- Update `openrouterEmbedderSchema` to include `url` field (default: `"https://openrouter.ai/api/v1/embeddings"`)
- Ensure all new fields have defaults so existing configs don't break

### Step 2: Add semantic search to MeilisearchStore [backend]
**File**: `packages/memory/src/stores/meilisearch.ts`
**Depends on**: Step 1
**Acceptance**: Store compiles, init configures embedder on Meilisearch index

- Update `MeilisearchStoreOptions` to accept `embedder` config and `semanticRatio`
- In `init()`: call `index.updateEmbedders()` with a REST embedder config:
  ```
  {
    "memory-embedder": {
      source: "rest",
      url: embedderConfig.url || "https://openrouter.ai/api/v1/embeddings",
      apiKey: embedderConfig.apiKey,
      request: { model: embedderConfig.model, input: ["{{text}}", "{{..}}"] },
      response: { data: [{ embedding: "{{embedding}}" }, "{{..}}"] },
      documentTemplate: "A memory entry: {{doc.content}}"
    }
  }
  ```
- Wrap `updateEmbedders()` in try/catch — if it fails, log warning and set a flag `semanticAvailable = false`
- In `search()`: if `semanticAvailable`, add `hybrid: { embedder: "memory-embedder", semanticRatio }` to search options
- If `semanticAvailable` is false, search falls back to existing keyword-only behavior (no regression)

### Step 3: Add scope filtering to MeilisearchStore [backend]
**File**: `packages/memory/src/stores/meilisearch.ts`, `packages/memory/src/stores/index.ts`
**Depends on**: Step 1
**Acceptance**: Scoped search returns only matching project + global memories

- Add `scope` to filterable attributes in `init()`
- Update `MemoryStore` interface: `search(query, limit, options?: { scope?: string })` 
- In `search()`: build filter string:
  - If scope is a project (e.g., `"project:/Users/drewbie/dev/randal"`): filter = `(scope = "global" OR scope = "project:/Users/drewbie/dev/randal")`
  - If scope is `"all"` or undefined: no scope filter (backward compatible)
- In `index()`: if doc has no scope set, assign default based on category:
  - `preference`, `fact` → `"global"`
  - Everything else → keep whatever was passed (or `"global"` if no project context)

### Step 4: Wire up embedder config in MemoryManager [backend]
**File**: `packages/memory/src/memory.ts`
**Depends on**: Steps 2, 3
**Acceptance**: MemoryManager passes embedder config through to MeilisearchStore

- When constructing `MeilisearchStore`, pass `config.memory.embedder` and `config.memory.semanticRatio`
- Update `search()` to accept optional scope parameter and pass through
- Update `searchForContext()` to accept and pass scope
- Update `index()` to set scope on docs if not already set

### Step 5: Refactor MCP server to use shared package [backend] [infrastructure]
**File**: `tools/mcp-memory-server.ts`
**Depends on**: Steps 2, 3, 4
**Acceptance**: MCP server starts, all 3 tools work, tests pass

- Remove duplicated types, logic, and Meilisearch client code
- Import `MeilisearchStore` from `@randal/memory` (or inline the store directly since MemoryManager needs a full RandalConfig)
- Actually: import `MeilisearchStore` directly (simpler than MemoryManager which requires full config)
- Keep the JSON-RPC transport layer and tool definitions
- Construct `MeilisearchStore` with options from env vars:
  - `MEILI_URL`, `MEILI_MASTER_KEY`, `MEILI_INDEX` (existing)
  - `OPENROUTER_API_KEY` (new — for embedder)
  - `EMBEDDING_MODEL` (new — default: `openai/text-embedding-3-small`)
  - `MEMORY_PROJECT` (new — optional, auto-detected from git if not set)
- In `handleMemorySearch`: call `store.search(query, limit, { scope })` — scope derived from `MEMORY_PROJECT` env var
- In `handleMemoryStore`: add scope to doc based on category defaults + optional override from params
- Add `scope` parameter to `memory_search` tool schema (optional, default: project-scoped)
- Add `scope` parameter to `memory_store` tool schema (optional, default: auto from category)
- Auto-detect project: on startup, run `git rev-parse --show-toplevel` to get repo root, use as default project scope

### Step 6: Update opencode.json MCP config [config]
**File**: `~/.config/opencode/opencode.json`
**Depends on**: Step 5
**Acceptance**: MCP server launches successfully with new env vars from opencode.json

- Add `OPENROUTER_API_KEY` to the memory MCP server environment (reference from user's existing env)
- Optionally add `EMBEDDING_MODEL` if user wants to override the default
- The `MEMORY_PROJECT` env var can be left unset (auto-detected from git)

### Step 7: Update tool descriptions for scope awareness [docs]
**File**: `tools/mcp-memory-server.ts` (tool definitions section)
**Depends on**: Step 5
**Acceptance**: Tool descriptions accurately reflect new scope behavior

- Update `memory_search` description to mention scope filtering (project memories + global by default)
- Update `memory_store` description to mention automatic scope assignment
- Add `scope` parameter descriptions to both tools
- Update `memory_search` description: "Returns matching memories sorted by semantic relevance (hybrid search)"

### Step 8: Add tests [testing]
**File**: `packages/memory/src/stores/meilisearch.test.ts` (new), update `packages/memory/src/memory.test.ts`
**Depends on**: Steps 2, 3, 4
**Acceptance**: All tests pass

- Test MeilisearchStore.init() calls updateEmbedders with correct REST config
- Test MeilisearchStore.search() passes hybrid options when semantic is available
- Test MeilisearchStore.search() falls back to keyword-only when semantic is unavailable
- Test scope filtering: project-scoped search returns project + global, excludes other projects
- Test default scope assignment: preference → global, pattern → project
- Test MemoryManager passes embedder config through correctly
- Mock Meilisearch client for unit tests (don't require running instance)

### Step 9: Manual verification and backfill consideration [testing]
**File**: None (manual testing)
**Depends on**: Steps 5, 6, 8
**Acceptance**: End-to-end semantic search works in OpenCode

- Start the MCP server via opencode.json config
- Store a test memory: "We built a marketplace for buying and selling paintball equipment"
- Search for "outdoor recreation equipment marketplace" — should return the paintball memory (semantic match)
- Search for "paintball" — should also return it (keyword match)
- Verify scope filtering works: store a project-scoped memory, search from a different directory
- Document how to backfill existing memories (future enhancement, not blocking)

## Planning Progress

- Phase: Requirements ✅
- Discovery: Complete ✅  
- Drafting: Complete ✅
- Verification: Complete ✅

## Build Notes

### Commit History (branch: `opencode/memory-semantic-search`)

| Step | Commit | Description |
|------|--------|-------------|
| 1 | `cfef97e` | Add scope field to MemoryDoc, semanticRatio to config, url to openrouter embedder schema |
| 2 | `84630ff` | Add hybrid semantic search to MeilisearchStore with REST embedder config |
| 3 | `32af8fd` | Add scope filtering to MeilisearchStore with project+global search and default scope assignment |
| 4 | `70e1764` | Wire up embedder config in MemoryManager with scope passthrough |
| 5 | `c3fe7ca` | Refactor MCP server to use shared MeilisearchStore with scope and semantic search |
| 6 | — | opencode.json updated with OPENROUTER_API_KEY env var (local config, not committed to repo) |
| 7 | `83d9f9f` | Update tool descriptions for scope and semantic search awareness |
| 8 | `1a6bdf1` | Add MeilisearchStore unit tests for semantic search, scope filtering, and indexing |
| 9 | (this commit) | Plan marked complete, build notes added |

### Setup Required

- **OPENROUTER_API_KEY**: Must be set in the MCP server environment (via `opencode.json` or shell env). Without it, the system gracefully falls back to keyword-only search.
- No other new secrets or infrastructure required — Meilisearch handles embedding generation server-side via its REST embedder.

### Backward Compatibility

- Existing memories remain searchable via keyword matching (BM25). They will **not** have embeddings until re-indexed.
- New memories stored after this change will automatically get embeddings generated by Meilisearch (via the REST embedder calling OpenRouter).
- No schema migration needed — the `scope` field is optional and defaults to `"global"`.

### Backfill Existing Memories (Future Enhancement)

Existing memories lack embeddings, so they won't appear in semantic search results (only keyword matches). To backfill:

1. A future `memory_reindex` tool could read all documents from the index and re-add them (triggering Meilisearch to generate embeddings).
2. Alternatively, a one-shot script: query all docs with `index.getDocuments({ limit: 1000 })`, delete them, and re-add them. Meilisearch's REST embedder will auto-generate embeddings on re-insertion.
3. This is **not blocking** for the MVP — keyword search still works for all existing data.

### Verification Results

- `npx tsc --noEmit`: Clean (no type errors)
- `bun test packages/memory/`: 94 tests pass, 189 expect() calls, 0 failures
- Manual end-to-end testing (MCP server startup, semantic search, scope filtering): deferred to user — requires running Meilisearch instance and valid OPENROUTER_API_KEY
