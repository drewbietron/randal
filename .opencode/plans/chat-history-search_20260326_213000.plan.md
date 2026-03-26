# Plan: Searchable Chat History with Semantic Search

**Slug**: chat-history-search
**Created**: 2026-03-26T21:30:00Z
**Status**: Complete
**Mode**: Thorough

## Summary

Upgrade the existing `MessageManager` (`packages/memory/src/messages.ts`) to support semantic/hybrid search and expose chat history search via the MCP server. The infrastructure already exists — `MessageManager` stores messages in a `messages-randal` Meilisearch index with full-text search, thread retrieval, and recent queries. This plan adds semantic embeddings, session summaries, project scoping, and MCP tool exposure so that users can ask "what were we discussing about X?" and get back relevant conversations with session IDs for resumption.

**Critical gap discovered**: The `MessageManager` is only wired into the gateway (`packages/gateway/src/gateway.ts`), which runs the full Randal platform server (HTTP, Discord, Telegram channels). OpenCode sessions use the standalone MCP memory server (`tools/mcp-memory-server.ts`), which has NO message storage or chat tools. The gateway is never started in the OpenCode workflow, so the `messages-randal` index never gets created and zero messages are ever captured. This plan must bring `MessageManager` (or equivalent) into the MCP server.

**Key insight**: Unlike memory, which is curated high-signal data, chat history is raw conversational data. They live in separate Meilisearch indexes with different signal weights, retention policies, and search priorities.

## Existing Infrastructure

- `MessageManager` class: `packages/memory/src/messages.ts` (188 lines)
- `MessageDoc` type: `packages/core/src/types.ts` (lines 293-302)
- Meilisearch index: `messages-{config.name}` (e.g., `messages-randal`)
- Already searchable, filterable, sortable by timestamp
- Already wired into gateway: `packages/gateway/src/gateway.ts`
- Fields: `id`, `threadId`, `speaker`, `channel`, `content`, `timestamp`, `jobId?`, `pendingAction?`
- **⚠️ NOT active in OpenCode**: MessageManager is only initialized by the gateway. The MCP server (`tools/mcp-memory-server.ts`) used by OpenCode has no message storage. The `messages-randal` Meilisearch index does not exist on the user's local instance.

## Requirements

### R1: Semantic Search on Chat History
1. Configure a Meilisearch embedder on the messages index (same REST/OpenRouter approach as memory plan)
2. Use hybrid search in `MessageManager.search()` with configurable semanticRatio
3. Fall back to keyword-only if embedder init fails
4. Shared embedder config from `config.memory.embedder` (same config as memory — one embedder config, two indexes)

### R2: Session Summaries
5. Add a `ChatSummaryDoc` type: periodic LLM-generated summaries of conversation windows
6. Store summaries in the same messages index (or a lightweight `chat-summaries-randal` index) with a `type: "summary"` discriminator
7. Summaries are generated every N messages (configurable, default: 20) or at session end
8. Summaries include: sessionId/threadId, time range, topic keywords, 2-3 sentence synopsis
9. Summaries are the PRIMARY search target for "what were we discussing" queries — much cheaper to embed and search than every individual message
10. Individual messages are the SECONDARY search target for more specific queries

### R3: MCP Tool Exposure
11. Add `chat_search` tool to the MCP server: semantic search across chat history, returns matching messages/summaries with sessionId for resumption
12. Add `chat_thread` tool to the MCP server: retrieve a specific thread by threadId (for "show me that conversation")
13. Add `chat_recent` tool to the MCP server: retrieve recent conversations (for "what were we working on recently?")
14. Tool response format includes session context: threadId, timestamp range, speaker, and a "resume" hint

### R4: Project Scoping
15. Add `scope` field to `MessageDoc` (same pattern as memory: `"global"` or `"project:/path"`)
16. Chat messages default to project scope (derived from git repo root or working directory)
17. Search defaults to current project's chats + optionally cross-project with `scope: "all"`

### R5: OpenCode Session Integration
18. The MCP server needs to capture OpenCode session messages — this is the tricky part
19. Option A: The MCP server adds a `chat_log` tool that Randal calls to log important messages (lightweight, explicit)
20. Option B: Hook into OpenCode's conversation persistence (if it exists) and index from there
21. Option C: Randal's system prompt instructs it to call `chat_log` at session boundaries (start, end, key decisions)
22. **Decision**: Start with Option A (explicit logging via tool) — simplest, most control. Can add automatic capture later.
22a. **Automatic capture via system prompt**: Randal's system prompt should instruct it to call `chat_log` for ALL user messages and key assistant responses — not just 'key moments'. This ensures the chat history is comprehensive. The system prompt guidance should be: 'After receiving each user message, call chat_log to persist it. After generating a substantive response (not just a status update), log a summary of your response.'

### R6: Acceptance Criteria
23. Searching "what were we discussing about authentication" returns relevant chat sessions even if the word "authentication" wasn't used (semantic match)
24. Search results include threadId/sessionId that can be used to resume the conversation
25. Session summaries are searchable and return higher-signal results than individual messages
26. Chat history search doesn't pollute memory search results (separate indexes)
27. Project scoping works: chats in repo A don't appear in searches from repo B

## Constraints

- Reuse the same OpenRouter embedder config as the memory plan (don't configure a second embedder)
- MessageManager changes must not break the existing gateway integration
- New MCP tools must not conflict with existing memory_* tools (use chat_* prefix)
- Session summary generation should use a cheap/fast model (Haiku or similar)
- Bun + TypeScript throughout

## Dependencies

- **Parallel with**: `memory-semantic-search` plan (shares embedder infrastructure)
- **Shared changes**: `config.memory.embedder` config (memory plan wires this up, chat plan consumes it)
- **Independent files**: `messages.ts`, MCP server chat tools, MessageDoc type updates

## Implementation Steps

### Step 1: Update MessageDoc type [backend] ✅
**File**: `packages/core/src/types.ts`
**Depends on**: None (parallel-safe with memory plan's MemoryDoc changes — different type)
**Acceptance**: TypeScript compiles, new fields are optional/backward-compatible

- Add `scope?: string` field to `MessageDoc` (same pattern as MemoryDoc)
- Add `type?: "message" | "summary"` field to `MessageDoc` (discriminator for summaries vs messages)
- Add `summary?: string` field (populated only for type: "summary" docs)
- Add `messageCount?: number` field (for summaries: how many messages this summarizes)
- All new fields optional to maintain backward compatibility

### Step 2: Add semantic search to MessageManager [backend] ✅
**File**: `packages/memory/src/messages.ts`
**Depends on**: Step 1, memory plan Step 1 (for embedder config types)
**Acceptance**: MessageManager.init() configures embedder, search uses hybrid mode

- Update `MessageManagerOptions` to accept embedder config and semanticRatio
- In `init()`: call `index.updateEmbedders()` with same REST embedder pattern as MeilisearchStore
- Add `scope` to filterable attributes, `type` to filterable attributes
- Update `search()` to use `hybrid: { embedder: "chat-embedder", semanticRatio }` when available
- Update `search()` to accept optional scope filter
- Fall back to keyword-only if embedder init fails

### Step 3: Add session summary generation [backend] ✅
**File**: `packages/memory/src/summaries.ts` (new)
**Depends on**: Step 1
**Acceptance**: Summary generator produces concise summaries from message batches

- Create `ChatSummaryGenerator` class
- Input: array of MessageDoc (a window of conversation)
- Output: a summary string (2-3 sentences covering topics discussed)
- Uses a cheap LLM (configurable, default: Haiku via OpenRouter) for generation
- Prompt template: "Summarize the following conversation in 2-3 sentences. Focus on topics discussed, decisions made, and action items: {messages}"
- Includes extracted topic keywords for better search matching

### Step 4: Integrate summary generation into MessageManager [backend] ✅
**File**: `packages/memory/src/messages.ts`
**Depends on**: Steps 2, 3
**Acceptance**: Summaries auto-generated every N messages per thread

- Track message count per threadId (in-memory counter, reset on restart)
- After every N messages (configurable, default: 20) in a thread, trigger summary generation
- Store summary as a MessageDoc with `type: "summary"`, linking to the threadId
- Also generate a summary on explicit `endSession(threadId)` call
- Summary generation is async/fire-and-forget — don't block message storage

### Step 5: Add chat tools to MCP server [backend] [infrastructure] ✅
**File**: `tools/mcp-memory-server.ts`
**Depends on**: Steps 2, 4, memory plan Step 5 (MCP server refactor)
**Acceptance**: New chat_search, chat_thread, chat_recent tools work via MCP

- **This is the critical step**: Initialize a `MessageManager` instance (or use `MeilisearchStore` directly for the messages index) inside the MCP server at startup. This creates the `messages-randal` index in Meilisearch and enables all chat operations.
- On MCP server init: create the messages index with the same config as MessageManager.init() — searchable attributes, filterable attributes, sortable attributes, plus embedder config.
- Add `chat_search` tool: searches messages index with hybrid search
  - Params: `query` (required), `limit` (optional, default 10), `scope` (optional)
  - Searches summaries first (type: "summary"), then individual messages
  - Returns: array of { threadId, speaker, content, timestamp, type, summary? }
  - Include a "resumeHint" in results: "This conversation was in session {threadId}"
- Add `chat_thread` tool: retrieves messages for a specific thread
  - Params: `threadId` (required), `limit` (optional, default 50)
  - Returns chronologically ordered messages
- Add `chat_recent` tool: retrieves recent conversations
  - Params: `limit` (optional, default 10)
  - Returns recent unique threads with their last message and summary if available
- Add `chat_log` tool: explicitly log a message to chat history
  - Params: `content` (required), `speaker` (optional, default "randal"), `threadId` (optional), `scope` (optional)
  - Used by Randal to capture key moments in OpenCode sessions

### Step 6: Update opencode.json and Randal system prompt [config] ✅
**File**: `~/.config/opencode/opencode.json`, Randal system prompt
**Depends on**: Step 5
**Acceptance**: MCP server exposes new tools, Randal knows to use chat_log

- No new env vars needed (reuses OPENROUTER_API_KEY from memory plan)
- Add guidance to Randal's system prompt: 
  - At session start: `chat_log({ content: "Session started: {topic}", speaker: "randal" })`
  - At key decisions: `chat_log({ content: "Decision: {what}", speaker: "randal" })`
  - At session end: `chat_log({ content: "Session ended: {summary}", speaker: "randal" })`
- Add guidance for searching: when user asks "what were we discussing about X", search chat_search first, then memory_search

### Step 7: Add tests [testing] ✅
**File**: `packages/memory/src/messages.test.ts` (new or extend existing)
**Depends on**: Steps 2, 3, 4, 5
**Acceptance**: All tests pass

- Test MessageManager.init() configures embedder
- Test MessageManager.search() uses hybrid mode
- Test scope filtering on chat search
- Test summary generation produces valid output
- Test summary integration: N messages triggers auto-summary
- Test MCP chat_search tool returns results with session context
- Test MCP chat_log tool stores messages correctly
- Mock Meilisearch and LLM for unit tests

### Step 8: Manual verification [testing] ✅
**File**: None (manual testing)
**Depends on**: Steps 5, 6, 7
**Acceptance**: End-to-end chat search works in OpenCode

- Start OpenCode session, have a conversation about a topic
- Use chat_log to capture key moments
- Search for the topic semantically — should return relevant results
- Verify threadId in results can be used to identify the session
- Test cross-session search: find conversations from previous sessions
- Verify chat results don't appear in memory_search (separate indexes)

## Planning Progress

- Phase: Requirements ✅
- Discovery: Complete ✅
- Drafting: Complete ✅
- Verification: Complete ✅

## Build Notes

### Commits (branch: `opencode/chat-history-search`)

| Hash | Description |
|------|-------------|
| `2cb273a` | chat-history: step 1 — add scope, type, summary fields to MessageDoc |
| `0227646` | chat-history: step 2 — add semantic/hybrid search to MessageManager |
| `f3d70af` | chat-history: step 3 — add ChatSummaryGenerator for session summaries |
| `5d7a166` | chat-history: step 4 — integrate auto-summary generation into MessageManager |
| `cd14928` | chat-history: step 5 — add chat_search, chat_thread, chat_recent, chat_log tools to MCP server |
| `62e2781` | chat-history: step 6 — add OPENROUTER_API_KEY and SUMMARY_MODEL env to opencode.json config |
| `23c1875` | chat-history: step 7 — add unit tests for MessageManager and ChatSummaryGenerator |

### Merge Prerequisites

- This branch is based on `opencode/memory-semantic-search` — **must merge that branch first** before merging this one. The memory-semantic-search branch provides the `EmbedderConfig` type, MeilisearchStore semantic search infrastructure, and the refactored MCP server structure that this plan builds on.

### Environment Requirements

- **`OPENROUTER_API_KEY`** must be set for:
  - Semantic/hybrid search on chat history (embedder configuration)
  - Auto-summary generation via ChatSummaryGenerator (LLM calls)
- **Without the key**: keyword-only search still works, no summaries are generated. The system degrades gracefully.
- **`SUMMARY_MODEL`** (optional): Override the default summary model (`anthropic/claude-haiku-3`).

### Operational Notes

- The `chat_log` tool must be called explicitly by Randal's system prompt — there is no automatic capture of OpenCode session messages yet. The system prompt guidance was added in Step 6, but Randal must actually follow it for chat history to be populated.
- Auto-summary threshold is **20 messages** per thread (configurable via the `summaryThreshold` constructor option on `MessageManager`).
- Thread IDs are auto-generated UUIDs if not provided via `chat_log` — the system prompt should instruct Randal to maintain a consistent `threadId` per session for thread coherence.
- Summary generation is fire-and-forget: it runs asynchronously and never blocks message storage. Failures are logged but do not affect the `add()` call.

### Verification Results

- `npx tsc --noEmit`: Clean (no errors)
- `bun test packages/memory/`: 133 tests pass (39 new + 94 existing), 0 failures
- New test files: `messages.test.ts` (20 tests), `summaries.test.ts` (19 tests)
