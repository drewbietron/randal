# 🧱 Architecture

## 🗺️ System Overview

```
                                         ┌──────────────────┐
                                         │    📡 Dashboard   │
                                         │  (single HTML)    │
                                         └────────┬─────────┘
                                                  │ SSE / REST
                                                  ▼
┌──────────┐                          ┌──────────────────────┐
│  💻 CLI  │ ── HTTP ────────────────▶│                      │
└──────────┘                          │    🏗️ Gateway        │
                                      │                      │
┌──────────┐                          │  ┌────────────────┐  │
│ 💬 Discord│ ── discord.js ─────────▶│  │  📡 Channels   │  │
│          │◀─────────────────────────│  │  - HTTP API    │  │
└──────────┘                          │  │  - Discord     │  │
                                      │  │  - iMessage    │  │
┌──────────┐                          │  │  - Telegram    │  │
│ 📱 iMessage── BB webhook ──────────▶│  │  - Slack       │  │
│          │◀── BB REST ──────────────│  │  - Email       │  │
└──────────┘                          │  │  - WhatsApp    │  │
                                      │  │  - Signal      │  │
┌──────────┐                          │  │  - Voice       │  │
│ 🎙️ Phone │ ── LiveKit/SIP ────────▶│  └───────┬────────┘  │
│          │◀── TTS ─────────────────│          │           │
└──────────┘                          │  ┌───────┴────────┐  │
                                      │  │  🔀 EventBus   │  │
┌──────────┐                          │  │  📂 Job Persist│  │
│ 💬 Slack │ ── @slack/bolt ─────────▶│  └───────┬────────┘  │
└──────────┘                          └──────────┼───────────┘
                                                 │
                         ┌───────────────────────┼───────────────────────┐
                         ▼                       ▼                       ▼
                ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
                │    🎯 Runner     │    │   ⏰ Scheduler   │    │   📊 Analytics   │
                │  - Ralph Loop    │    │  - Heartbeat     │    │  - Annotations   │
                │  - Streaming     │    │  - Cron          │    │  - Scoring       │
                │  - Adapters      │    │  - Hooks         │    │  - Recommend.    │
                │  - MCP Server    │    │  (webhooks)      │    │  - Feedback      │
                │  - Compaction    │    └──────────────────┘    │  - Categorizer   │
                │  - Browser Tool  │                            └──────────────────┘
                └───┬──────────┬───┘
                    │          │
           ┌────────┘          └────────────────────────┐
           ▼                                            ▼
     ┌──────────────────┐      ┌──────────────────┐   ┌──────────────────┐
     │  🔐 Credentials  │      │    🧠 Memory     │   │   🌐 Mesh        │
     │ - .env parsing   │      │ - Meilisearch    │   │  - Registry      │
     │ - Allowlist      │      │ - Cross-agent    │   │  - Discovery     │
     │ - Inheritance    │      │ - Auto-inject    │   │  - Router        │
     └──────────────────┘      │ - Posse sharing  │   │  - Health Mon.   │
                               └──────────────────┘   └──────────────────┘

     ┌──────────────────┐
     │   🎙️ Voice       │
     │  - VoiceEngine   │
     │  - STT/TTS       │
     │  - LiveKit       │
     │  - Twilio SIP    │
     └──────────────────┘
```

---

## 📦 Packages

| Package | Name | Role |
|---------|------|------|
| `packages/core` | `@randal/core` | 🧩 Types, config schema (Zod), structured logger. Leaf dependency. |
| `packages/credentials` | `@randal/credentials` | 🔐 Parses `.env` files, filters by allowlist, inherits parent env vars. |
| `packages/memory` | `@randal/memory` | 🧠 Meilisearch-backed memory, cross-agent sharing, auto-injection. |
| `packages/runner` | `@randal/runner` | 🎯 Agent execution loop, adapter pattern, sentinel wrapping, struggle detection. |
| `packages/scheduler` | `@randal/scheduler` | ⏰ Heartbeat, cron scheduling, webhook hooks. Autonomy primitives. |
| `packages/gateway` | `@randal/gateway` | 🏗️ HTTP server (Hono), EventBus, YAML job persistence, orchestration. |
| `packages/harness` | `@randal/harness` | 🤝 `createRandal()` unified programmatic API. Boots the full engine. |
| `packages/dashboard` | `@randal/dashboard` | 📡 Single-page HTML dashboard with inline CSS/JS. |
| `packages/cli` | `randal` | 💻 CLI binary. Entry point for all commands. |

---

## ⚙️ Primitives

### 🎯 Runner (The Ralph Loop)

The core execution engine. For each job:

1. Create job record (status: `queued`).
2. Build a scoped environment via Credentials.
3. Loop up to `maxIterations`:
   a. Read and clear any injected context (`context.md`).
   b. Query Memory for relevant context (if enabled).
   c. Assemble system prompt: persona + rules + knowledge + skills + memory + injected context.
   d. Spawn agent process via `Bun.spawn(["bash", "-c", wrappedCommand])`.
   e. Capture stdout/stderr, parse token usage, check for completion promise.
   f. Update job state, emit events.
   g. If completion promise found (`<promise>DONE</promise>`): mark complete, return.
   h. If struggle detected: emit `job.stuck` event.
4. If max iterations exhausted: mark failed.

### 🔌 Agent Adapters

Adapters normalize different agent CLIs behind a common interface:

| Adapter | Binary | Notes |
|---------|--------|-------|
| `opencode` | `opencode` | `opencode run [--model] <prompt>` |
| `claude-code` | `claude` | `claude --print --dangerously-skip-permissions [--model] <prompt>` |
| `codex` | `codex` | `codex --full-auto [--model] <prompt>` |
| `mock` | `bash` | For testing. Reads from script files. |

Each adapter implements: `buildCommand()`, `parseUsage()`, `envOverrides()`.

### 🚦 Sentinel

Wraps agent commands with `__START_<token>` / `__DONE_<token>:<exitcode>` markers for reliable output boundary detection and exit code capture.

### 🔍 Struggle Detection

Monitors iteration history for signs the agent is stuck:

- 🔄 No file changes for N consecutive iterations
- ❌ N consecutive non-zero exit codes
- 🔁 Identical summaries across iterations
- 🔥 High token burn without observable progress

### 🏗️ Gateway

Orchestrates the daemon mode:

1. Creates EventBus (pub/sub for SSE streaming to dashboard).
2. Initializes MemoryManager (graceful fallback on failure).
3. Creates Runner with an event handler that emits to EventBus and persists job state.
4. Detects configured tools (checks `which` for each binary).
5. Creates Hono HTTP app with REST endpoints + SSE.
6. Starts messaging channel adapters (Discord, iMessage) from config.
7. Starts `Bun.serve`.

### 📡 Channel Adapters

Channel adapters provide inbound/outbound messaging for chat-based interaction. Each adapter implements the `ChannelAdapter` interface:

```typescript
interface ChannelAdapter {
  readonly name: string;
  start(): Promise<void>;
  stop(): void;
}
```

All adapters share `handleCommand()` for parsing and executing commands, and `formatEvent()` for formatting job notifications. Channel-aware event routing uses `JobOrigin` — when a channel starts a job, it stamps the origin so notifications route back only to the originating channel/chat.

| Channel | Transport | Platform | Auth |
|---------|-----------|----------|------|
| HTTP | REST + SSE | All | Bearer token |
| Discord | discord.js WebSocket | All | Bot token |
| iMessage | BlueBubbles REST + Webhook | macOS only | Server password |

**Adding a new channel:** Implement `ChannelAdapter`, add a config schema to `config.ts`, and add a case to the gateway startup loop. `handleCommand()` and `formatEvent()` are reusable.

### 🔐 Credentials

Builds a clean, scoped environment for agent processes:

- Parses `.env` file (handles quotes, comments, multiline).
- Filters variables through an explicit allowlist.
- Inherits specified vars from the parent process (default: `PATH`, `HOME`, `SHELL`, `TERM`).
- Injects `RANDAL_JOB_ID` and `RANDAL_ITERATION` per iteration.

### 🧠 Memory

Persistent memory backed by Meilisearch. Full-text search, filterable by type/category/source/file, sorted by timestamp. Auto-installed on first `randal serve`.

---

## 🔄 Data Flow

### Job Execution (Daemon Mode)

```
Client                Gateway              Runner              Agent
  |                     |                    |                   |
  |── POST /job ───────▶|                    |                   |
  |                     |── execute(req) ───▶|                   |
  |                     |                    |── spawn ─────────▶|
  |                     |                    |◀── stdout/exit ───|
  |                     |◀── event ──────────|                   |
  |◀── SSE event ───────|                    |                   |
  |                     |── saveJob(yaml) ──▶|                   |
  |                     |                    |                   |
```

1. Client submits job via `POST /job` (or `randal send`).
2. Gateway passes request to Runner.
3. Runner loops: spawns agent, collects output, emits events.
4. Gateway forwards events to EventBus (SSE) and persists job state to `~/.randal/jobs/`.
5. Dashboard receives events via SSE and updates in real time.

### Chat Channel Flow (Discord / iMessage)

```
User (Discord/iMessage)    Gateway              Runner              Agent
  |                          |                    |                   |
  |── "refactor auth" ──────▶|                    |                   |
  |                          |── parseCommand ──▶ |                   |
  |◀── "Job abc1 started" ──|── execute(req) ───▶|                   |
  |                          |                    |── spawn ─────────▶|
  |                          |                    |◀── stdout/exit ───|
  |                          |◀── event ──────────|                   |
  |◀── "Job abc1 complete" ──|                    |                   |
```

1. User sends a message via Discord DM or iMessage text.
2. Channel adapter parses the command (or treats as implicit `run:`).
3. `handleCommand()` executes against Runner/Memory/Jobs with a `JobOrigin` stamp.
4. Job events route back to the originating channel/chat only (no cross-channel spam).
5. Other channels pick up context via shared memory search.

### Memory Flow

```
Agent saves memory via memory API
        │
        ▼
Index to Meilisearch (with contentHash dedup)
        │
        ▼
Next iteration: search memory for relevant context
        │
        ▼
Auto-inject into system prompt as "## Relevant Memory"
```

If cross-agent sharing is configured:
- Learnings are also published to a shared Meilisearch index (`sharing.publishTo`).
- Before each iteration, results from shared indexes (`sharing.readFrom`) are merged into context.

---

## 🏗️ Gateway-Runner Decoupling

The Runner is a pure execution engine. It:
- Takes a config and a callback function.
- Executes jobs and emits events through the callback.
- Has no knowledge of HTTP, persistence, SSE, or the gateway.

The Gateway is an orchestrator. It:
- Creates and owns the Runner instance.
- Wires the Runner's event callback to the EventBus and job persistence.
- Exposes the HTTP API and serves the dashboard.

This separation means `randal run` can use the Runner directly with a simple console-logging callback — no gateway, no server, no persistence. The same Runner code powers both modes.

---

## 🤝 Posse Readiness

A **posse** is a named group of Randal instances that coordinate as a team. The architecture supports this through:

- **Config**: Each instance declares its `posse` membership (top-level `posse` field).
- **Memory sharing**: Instances in the same posse publish learnings to a shared Meilisearch index and read from each other's indexes.
- **Instance discovery**: The `/instance` endpoint exposes `name`, `posse`, and `capabilities`, enabling future service discovery.
- **Identity**: Each instance has its own persona, rules, and knowledge, allowing role specialization within a posse.

The current implementation provides the memory-sharing and identity primitives. Full posse orchestration (task routing, delegation, consensus) is a future layer that builds on these foundations.
