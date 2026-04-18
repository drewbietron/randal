---

# Plan: Unified Posse Invocation Layer

**Created**: 2026-04-17T17:00:00Z
**File**: .opencode/plans/unified_posse_invocation_20260417.plan.md
**Status**: Drafting
**Planning Turn**: 2 of ~4
**Model**: openrouter/anthropic/claude-opus-4.6

## Summary

Evolve the existing Randal gateway to support consistent single-agent and multi-agent (posse) invocation. Fix the broken mesh delegation, add posse-level job submission to the gateway, implement session-consistent job tracking across agents, and document the path to dynamic agent spawning. The gateway remains the single front-door for all user interaction (Discord, HTTP, etc.), delegates to mesh peers as needed, and maintains full session ownership.

## Requirements

1. **Fix mesh delegation bug**: The `delegate_task` MCP tool in `tools/mcp-memory/handlers/posse.ts` POSTs to `/jobs` (plural) but the gateway HTTP app defines `POST /job` (singular). Delegation likely 404s. Fix the endpoint mismatch and verify with an integration test.

2. **Add `POST /posse/job` gateway endpoint**: A new endpoint that accepts a job request, uses mesh routing scores (expertise 0.4, reliability 0.3, load 0.2, model 0.1) to pick the best agent, submits the job to that agent, and returns the job ID + routing decision. The gateway creates a LOCAL tracking job that wraps the remote delegation so all existing EventBus → channel adapter flows work unchanged.

3. **Async job status bubbling**: When the gateway delegates a job to a remote agent, it should poll the remote agent's job status asynchronously (not blocking the gateway). Status updates from the remote agent should emit events on the local EventBus so Discord/SSE clients see progress. The gateway should always be able to answer "what's the status of job X?" instantly from its local tracking state.

4. **Discord session consistency**: The front-door gateway owns all Discord threads. When a posse-routed job starts, the gateway:
   - Responds instantly in Discord ("Starting: **topic** — routed to {agent}")
   - Creates a thread for the session
   - Relays progress events from the remote agent into the thread
   - Can handle multiple concurrent sessions/threads without blocking
   - Can answer status queries about any active job at any time

5. **Crash recovery for delegated jobs**: If the gateway restarts while a delegated job is in flight, it should be able to recover the delegation state from its local job record and resume polling the remote agent.

6. **Consistent invocation interface**: `POST /job` (single agent) and `POST /posse/job` (posse routing) should have identical request/response shapes. A client shouldn't need to know which mode they're in — the gateway handles routing transparently. Consider making `POST /job` itself posse-aware when posse config is present.

7. **Close PR #74**: The conductor package (`packages/conductor/`) should not be merged. Update the PR with the rationale and close it. The valuable work (Hono migration patterns, config system) is documented for future reference.

8. **Document Phase 4 architecture (dynamic spawning)**: Write an architecture document describing how agents could eventually spawn sub-agents on Railway on demand. This is NOT implemented now, but the invocation layer should be designed so that "pick an agent" can naturally evolve into "pick or create an agent." Key aspects:
   - Gateway → single front-door agent (always running)
   - Front-door agent decides when to delegate and to whom
   - If no suitable peer exists, spawn a new Railway service from a template
   - Tear down after idle timeout
   - Cost controls and resource limits
   - Railway API integration points
   - Service template registry (what agent archetypes can be spawned)

## Constraints

- All changes must be in existing packages (`packages/gateway/`, `packages/mesh/`, `tools/mcp-memory/`). No new packages.
- Must maintain backward compatibility — single-agent mode (no posse config) must work exactly as before.
- Discord adapter session management (threads, typing indicators, progress, recovery) must continue working.
- EventBus remains single-process. Distributed events are NOT in scope — use polling/SSE proxy instead.
- Must pass existing tests + lint + typecheck.
- The gateway must remain non-blocking — no synchronous waiting for remote job completion.

## Discovery Log

### File 1: `tools/mcp-memory/handlers/posse.ts` (439 lines)

**The `/jobs` vs `/job` bug — confirmed at line 282:**
```
const jobResp = await fetch(`${targetEndpoint}/jobs`, { method: "POST", ... });
```
The delegate_task handler POSTs to `${targetEndpoint}/jobs` but the gateway HTTP app defines `POST /job` (singular). This is a confirmed 404 bug. Additionally, the polling URL at line 331 uses `${targetEndpoint}/jobs/${jobId}` — the gateway has `GET /job/:id`, not `GET /jobs/:id`. **Both the submission and polling URLs are wrong.**

**Key interfaces:**
- `handleDelegateTask(params)` — auto-routes via `routeTask()` from `@randal/mesh`, or takes explicit `target` name
- Supports `async` mode (return immediately) and sync mode (poll with 3s interval, 5min timeout)
- Health check via `checkHealth()` before delegation
- Sends `{ prompt, origin: { channel: "posse", from: RANDAL_SELF_NAME } }` as the job payload
- Expects response shape `{ id?: string; jobId?: string }`
- Poll response expects `{ status, summary, error, filesChanged }`

**What needs to change:**
- Fix `/jobs` → `/job` on lines 282 and 331
- Fix polling URL `/jobs/${jobId}` → `/job/${jobId}`
- Consider adding the gateway's Bearer auth token to requests (already done via `RANDAL_PEER_AUTH_TOKEN`, line 278-280)

### File 2: `packages/gateway/src/channels/http.ts` (1210 lines)

**Key endpoints:**
- `POST /job` (line 286) — accepts `{ prompt, specFile, agent, model, maxIterations, workdir }`, calls `runner.submit()`, returns `{ id, status: "queued" }` with 201
- `GET /job/:id` (line 334) — checks active jobs first, then disk
- `GET /jobs` (line 362) — list with optional status filter, merges active + disk
- `DELETE /job/:id` (line 376) — stop a running job
- `GET /events` (line 406) — SSE stream from EventBus, 15s keepalive
- `GET /posse` (line 672) — posse info (agents list)
- `GET /posse/memory/search` (line 694) — search posse memory
- `GET /mesh/status` (line 1026) — mesh instance list
- `POST /mesh/route` (line 1036) — dry-run routing
- `POST /_internal/events` (line 1155) — brain event emission to EventBus

**Key types:**
- `HttpChannelOptions` — includes `runner: Runner`, `eventBus: EventBus`, `posseClient?`, `meshCoordinator?`, `channelAdapters?: ChannelAdapter[]`
- `meshCoordinator` interface: `getInstances()` and `routeDryRun(prompt)`

**Patterns:**
- Auth via Bearer token or session cookie, timing-safe compare
- Hono framework with cors, body size limit middleware
- Job persistence: `saveJob()` on submit, `done.then(saveJob)` on completion
- All endpoints return JSON, SSE for events

**What needs to change:**
- Add `POST /posse/job` endpoint that creates a local tracking job, routes via mesh, delegates to remote, starts async polling
- The existing `POST /job` could optionally become posse-aware (check if posse is configured + routing scores high enough)
- Need to pass `meshCoordinator` (or the mesh registry directly) to the new endpoint for routing decisions
- Need a new "delegated job" concept that wraps remote job tracking

### File 3: `packages/gateway/src/gateway.ts` (645 lines)

**Startup flow:**
1. Wait for Meilisearch (retry with backoff)
2. Init MemoryManager, MessageManager, AnnotationStore, SkillManager
3. Create Runner with event forwarding to EventBus
4. Create Scheduler
5. Create posseClient (MeiliSearch) if posse configured
6. Wire mesh coordinator (MeilisearchMeshRegistry, HealthMonitor, selfInstance)
7. Create HTTP app via `createHttpApp()`
8. Mount hooks router
9. Start scheduler
10. Start channel adapters (Discord, etc.)
11. Register in posse registry, setup heartbeat interval (5min)
12. Resume interrupted jobs from disk
13. PID file, logging

**Key observations:**
- `meshCoordinator` (line 311-325) is a thin adapter built on top of `MeilisearchMeshRegistry`. Currently `getInstances()` starts empty and is backfilled async. `routeDryRun()` embeds the task and calls `dryRunRoute()`.
- Event handler at line 189 persists job state on key events including `job.delegation.completed` — suggests delegation events were already anticipated
- Job recovery (line 531-584) iterates `listJobs("running")` + `listJobs("queued")`, calls `runner.resume(job)`, and calls `ch.recoverJob(jobId, replyTo)` on channel adapters
- `effectiveConfig` (line 471-480) patches `mesh.endpoint` to `http://localhost:${port}` if not set — important for self-registration

**What needs to change:**
- The mesh coordinator adapter needs to expose actual routing (not just dry-run) so the `POST /posse/job` endpoint can use it
- Job recovery needs to handle "delegated" jobs — if a job has `delegation.remoteEndpoint` and `delegation.remoteJobId`, resume polling instead of `runner.resume()`
- Need to pass routing capabilities to the HTTP app (or create a new `PosseJobManager` that handles delegated job lifecycle)

### File 4: `packages/runner/src/runner.ts` (715 lines)

**Key interfaces:**
- `JobRequest` — `{ prompt, specFile, agent, model, maxIterations, workdir, origin?: JobOrigin, metadata? }`
- `Runner.submit(request)` → `{ jobId: string, done: Promise<Job> }` — non-blocking, job ID available immediately
- `Runner.resume(job)` → `{ jobId: string, done: Promise<Job> }` — for crash recovery
- `Runner.stop(jobId)` → boolean
- `Runner.getJob(jobId)`, `Runner.getActiveJobs()`

**Job object (from `createJob`):**
- `id`, `status`, `prompt`, `agent`, `model`, `workdir`, `createdAt`, `startedAt`, `completedAt`, `duration`
- `iterations: { current, history[] }`, `plan[]`, `progressHistory[]`, `delegations[]`, `cost`, `updates[]`
- `origin?: JobOrigin`, `metadata?`
- Already has a `delegations` field — indicates delegation tracking was designed for

**Execution model:**
- `runBrainSession()` spawns a single long-lived process (OpenCode), monitors stdout for `<progress>` and `<plan-update>` tags
- Emits events: `job.queued`, `job.started`, `iteration.output`, `job.plan_updated`, `iteration.tool_use`, `job.complete`, `job.failed`, `job.stopped`
- Supports context compaction for resumed jobs

**What needs to change:**
- The Runner itself doesn't need to change for delegation — delegation happens at the gateway level above the runner
- However, we need a parallel concept: a "delegated job" that isn't run locally but is tracked locally
- The `Job.delegations` array could be used to store `{ remoteAgent, remoteJobId, remoteEndpoint, status }`
- We might want a `DelegatedJobTracker` class that mimics `Runner` interface for delegated jobs (poll remote, emit local events)

### File 5: `packages/gateway/src/jobs.ts` (114 lines)

**Simple YAML-based job persistence:**
- `saveJob(job)` — atomic write (temp + rename) to `~/.randal/jobs/{id}.yaml`
- `loadJob(id)` — read + parse YAML
- `listJobs(status?)` — readdir + filter + sort by createdAt desc
- `updateJob(id, updates)` — load, merge, save (protects `id` and `createdAt`)
- Sanitizes job IDs against path traversal

**What needs to change:**
- This module works as-is for delegated jobs too — we just save/load Job objects with delegation metadata
- May want to add a `listDelegatedJobs()` convenience that filters for jobs with active delegation state
- The `updateJob` function is key — the polling loop will call `updateJob(id, { delegation: { status: "running", lastPoll: ... } })` periodically

### File 6: `packages/gateway/src/events.ts` (65 lines)

**Simple pub/sub EventBus:**
- `subscribe(handler)` → unsubscribe function
- `emit(event: RunnerEvent)` — broadcasts to all subscribers
- Auto-removes subscribers after 3 consecutive errors
- Max 100 subscribers cap
- Single-process only (not distributed)

**What needs to change:**
- Nothing — this works perfectly for the use case. The posse job manager will emit `RunnerEvent`s onto this bus with the local tracking job ID, and all existing subscribers (SSE endpoint, Discord adapter) will receive them transparently.

### File 7: `packages/mesh/src/router.ts` (262 lines)

**Routing algorithm:**
- `routeTask(instances, context, weights?)` → `RoutingDecision | null`
- `dryRunRoute(instances, context, weights?)` → `RoutingDecision[]` (all candidates scored)
- Default weights: expertise 0.4, reliability 0.3, load 0.2, modelMatch 0.1

**Scoring functions:**
- `computeExpertiseScore` — 2-tier: cosine similarity on embedding vectors → role string match → 0.5 neutral
- `computeReliabilityScore` — looks up `ReliabilityScore` by agent name → 0.5 default
- `computeLoadScore` — idle=1.0, 0 jobs=1.0, 1 job=0.7, 2 jobs=0.4, 3+=0.1
- `computeModelMatchScore` — exact match=1.0, same provider=0.6, no match=0.2

**Key types:**
- `RoutingContext` — `{ prompt, domain?, model?, reliabilityScores?, taskVector? }`
- `RoutingDecision` — `{ instance: MeshInstance, score, breakdown, reason }`
- Returns `null` if best score < 0.1 (recommend local execution)

**What needs to change:**
- Nothing in the router itself — it's already well-designed
- The `POST /posse/job` endpoint will call `routeTask()` directly (same as `delegate_task` does)
- May want to expose `dryRunRoute()` results in the response for debugging/observability

### File 8: `packages/gateway/src/channels/discord.ts` (1556 lines)

**Session management model:**
- `conversations` Map: channelId → `{ threadChannel, history[], activeJobId }`
- `jobToChannel` Map: jobId → channelId (for event routing)
- `progressState` Map: jobId → edit-in-place message state
- `typingIntervals` Map: jobId → interval (8s refresh)

**Event routing pattern:**
- `onRunnerEvent(event)` — checks `job.origin.channel === "discord"`, finds channel via `jobToChannel`, routes to thread
- Terminal events (`job.complete`, `job.failed`) update conversation history, send buttons, update thread name, cleanup
- Intermediate events (`iteration.output`, `job.plan_updated`) edit-in-place a progress message with debounce (2s)
- Brain events (`brain.notification`, `brain.alert`) sent as standalone messages

**Recovery:**
- `recoverJob(jobId, threadId)` — called on gateway restart, restores `jobToChannel` + `conversations` from Meilisearch
- `preloadConversations()` — loads last 100 thread IDs from Meilisearch on startup

**What needs to change:**
- For posse-routed jobs, the Discord adapter needs NO changes. It already routes based on `job.origin.channel === "discord"` and `jobToChannel` mapping. As long as the posse job manager:
  1. Creates a local Job with `origin: { channel: "discord", replyTo, from }`
  2. Sets up `jobToChannel` mapping (or emits events with the right jobId)
  3. Emits `RunnerEvent`s on the EventBus with the local job ID
  ...the Discord adapter will handle everything naturally (threads, progress, typing, buttons, recovery).
- The `startNewConversation` method would need a small tweak if we want to show "routed to {agent}" in the initial reply message. This is cosmetic and can be done via the job's metadata.

## Architecture Overview

### Current Single-Agent Flow
```
User (Discord/HTTP)
  → Gateway HTTP app (POST /job)
    → Runner.submit({ prompt, origin })
      → Spawns OpenCode process
      → Monitors stdout for <progress>/<plan-update> tags
      → Emits RunnerEvents to EventBus
    → EventBus broadcasts to subscribers
      → Discord adapter: routes event to correct thread
      → SSE endpoint: streams to connected clients
    → Job persisted to disk (saveJob)
```

### Current Delegation Flow (MCP tool, broken)
```
Brain (running inside OpenCode)
  → MCP tool: delegate_task
    → Query posse members from Meilisearch
    → routeTask() selects best peer
    → checkHealth() pre-flight
    → POST ${peerEndpoint}/jobs  ← BUG: should be /job
      → 404 (never reaches peer's runner)
    → Poll GET ${peerEndpoint}/jobs/${jobId}  ← BUG: should be /job/${jobId}
    → Returns result to brain
```

**Problems with current delegation:**
1. Endpoint mismatch (`/jobs` vs `/job`) — confirmed 404
2. Delegation happens inside the brain process, not at gateway level
3. No local tracking job — gateway is unaware of the delegation
4. Discord can't show progress for delegated work (no EventBus events)
5. No crash recovery for in-flight delegations
6. Blocks the brain's MCP tool call while polling (up to 5 minutes)

### Proposed Unified Flow
```
User (Discord/HTTP)
  → Gateway (POST /posse/job  OR  POST /job with posse routing)
    → Mesh Router: routeTask(instances, context)
      → If routing score > threshold:
        [DELEGATED PATH]
        → Create local tracking Job with delegation metadata:
            { status: "running", delegation: { remoteAgent, remoteEndpoint, remoteJobId } }
        → POST ${peerEndpoint}/job (fixed URL)
        → Return { id: localJobId, status: "delegated", routedTo: agentName }
        → Start async DelegatedJobPoller:
            → Poll GET ${peerEndpoint}/job/${remoteJobId} every 3s
            → On remote progress → emit iteration.output on local EventBus
            → On remote plan update → emit job.plan_updated on local EventBus
            → On remote complete → update local job, emit job.complete
            → On remote failure → update local job, emit job.failed
        → EventBus propagates to Discord/SSE as normal
      → If routing score < threshold OR no peers:
        [LOCAL PATH — unchanged]
        → Runner.submit({ prompt, origin })
        → Existing brain session flow

Gateway restart:
  → listJobs("running") includes delegated jobs
  → Detect delegation metadata on job record
  → Resume DelegatedJobPoller instead of runner.resume()
  → Channel adapters recover normally via recoverJob()
```

**Key design decisions:**
1. **Delegation at gateway level, not brain level** — the gateway creates a local Job so all EventBus/channel flows work
2. **DelegatedJobPoller is a standalone async loop** — doesn't block anything, can be cancelled
3. **Same EventBus, same event types** — Discord adapter needs zero changes
4. **Job.delegation metadata** — stored on disk for crash recovery
5. **POST /job can be posse-aware** — if posse config exists and routing score is high, auto-delegate

## Implementation Steps

### Step 1: Fix delegate_task endpoint mismatch [backend]
- **Action**: modify
- **File**: `tools/mcp-memory/handlers/posse.ts`
- **Details**: Change `/jobs` to `/job` on the POST submission line (~282) and `/jobs/${jobId}` to `/job/${jobId}` on the polling line (~331). Also check the initial response parsing line (~321) for any `/jobs/` reference.
- **Depends on**: None
- **Verify**: `grep -n "/jobs" tools/mcp-memory/handlers/posse.ts` should show no remaining `/jobs` references (except maybe in comments)
- **Done Criteria**: All fetch URLs in delegate_task use `/job` (singular)
- `[x] done — 18dc25a`

### Step 2: Add /jobs endpoint aliases for backward compat [backend]
- **Action**: modify
- **File**: `packages/gateway/src/channels/http.ts`
- **Details**: Add route aliases so both `/job` and `/jobs` work. After the existing `POST /job` handler registration, add: `app.post("/jobs", jobHandler)` and `app.get("/jobs/:id", getJobHandler)`. Extract the handlers into named functions first if they're currently inline.
- **Depends on**: None
- **Verify**: Both `curl POST /job` and `curl POST /jobs` return 201 with a job ID
- **Done Criteria**: `/jobs` and `/jobs/:id` return identical responses to `/job` and `/job/:id`
- `[x] done — 5b4195b`

### Step 3: Create DelegatedJobTracker class [backend]
- **Action**: create
- **File**: `packages/gateway/src/delegation.ts`
- **Details**: New module with:
  - `DelegatedJobTracker` class:
    - Constructor: `(localJobId, remoteEndpoint, remoteJobId, eventBus, authToken?)`
    - `start()`: begins async polling loop (3s initial, exponential backoff on errors, max 30s)
    - `stop()`: cancels polling
    - `getState()`: returns `{ remoteJobId, remoteEndpoint, status, lastPolled, lastRemoteStatus }`
    - Private `poll()`: GET remote /job/{id}, compare status changes, emit events
    - Event mapping: remote `running` → local `job.started`, remote progress → local `iteration.output`, remote `complete` → local `job.complete` with summary, remote `failed` → local `job.failed`
    - Error handling: network failures increment backoff, 3 consecutive failures emit warning, 10 consecutive emit `job.failed`
  - `DelegationMetadata` type: `{ remoteAgent, remoteEndpoint, remoteJobId, startedAt, status, lastPolled }`
  - `DelegatedJobTracker.recover(job, eventBus)`: static factory that recreates a tracker from Job's delegation metadata
  - Helper: `createDelegatedJob(request, routingDecision)`: creates a Job object with delegation metadata, status "running"
- **Depends on**: None
- **Verify**: Unit test with mocked fetch that verifies events are emitted correctly
- **Done Criteria**: DelegatedJobTracker polls, emits events, handles errors, is recoverable
- `[x] done — eb56208`

### Step 4: Add DelegatedJobTracker tests [testing]
- **Action**: create
- **File**: `packages/gateway/src/__tests__/delegation.test.ts`
- **Details**: Tests for:
  - Tracker polls at correct interval
  - Emits `job.started` on first poll showing `running`
  - Emits `iteration.output` when remote job has new progress
  - Emits `job.complete` when remote status is `complete`
  - Emits `job.failed` when remote status is `failed`
  - Handles network errors with backoff
  - Stops cleanly when `stop()` called
  - `recover()` recreates from job metadata
  - `createDelegatedJob()` produces correct Job shape
- **Depends on**: Step 3
- **Verify**: `bun test packages/gateway/src/__tests__/delegation.test.ts`
- **Done Criteria**: All tests pass
- `[ ] pending`

### Step 5: Add POST /posse/job endpoint [backend]
- **Action**: modify
- **File**: `packages/gateway/src/channels/http.ts`
- **Details**: New endpoint after existing posse routes:
  1. Validate request (same shape as POST /job: `{ prompt, agent?, model?, ... }`)
  2. Check meshCoordinator exists (if not, return 503 "Posse not configured")
  3. Call `meshCoordinator.routeTask()` or the underlying `routeTask()` from mesh router
  4. If no suitable agent found, return 404 "No suitable agent available" with scores
  5. Create local tracking job via `createDelegatedJob(request, routingDecision)`
  6. Save local job via `saveJob()`
  7. POST to remote agent's `/job` endpoint with the prompt
  8. Start `DelegatedJobTracker` for the remote job
  9. Store tracker in a `Map<jobId, DelegatedJobTracker>` on the HTTP app context
  10. Return `{ id: localJobId, status: "delegated", routedTo: { name, endpoint, score, breakdown } }`
  - Also needs: accept meshCoordinator with actual routing capability (currently only has `routeDryRun`). Need to expose `routeTask()` or add it to the coordinator adapter in gateway.ts.
- **Depends on**: Steps 3, 6
- **Verify**: `curl -X POST /posse/job -d '{"prompt":"test"}' | jq .` returns routing decision
- **Done Criteria**: Endpoint creates local tracking job, submits to remote, returns routing info
- `[ ] pending`

### Step 6: Expose mesh routeTask in gateway coordinator [backend]
- **Action**: modify
- **File**: `packages/gateway/src/gateway.ts`
- **Details**: The current meshCoordinator adapter (lines ~311-325) only exposes `getInstances()` and `routeDryRun()`. Add a `routeTask(prompt)` method that:
  1. Embeds the prompt (same as routeDryRun)
  2. Calls `routeTask()` from `@randal/mesh` router
  3. Returns the `RoutingDecision` (or null if no suitable agent)
  - Pass the enhanced coordinator to `createHttpApp()`
- **Depends on**: None
- **Verify**: Type check passes with the new method
- **Done Criteria**: meshCoordinator exposes `routeTask()` alongside `routeDryRun()`
- `[ ] pending`

### Step 7: Wire delegation recovery into gateway startup [backend]
- **Action**: modify
- **File**: `packages/gateway/src/gateway.ts`
- **Details**: In the job recovery section (lines ~531-584), add a branch:
  - When iterating resumed jobs, check if job has delegation metadata
  - If `job.delegations?.length > 0` and the last delegation has status != "complete"/"failed":
    - Call `DelegatedJobTracker.recover(job, eventBus)` instead of `runner.resume(job)`
    - Store the tracker in the active trackers map
    - Call channel adapter `recoverJob()` as before
  - Import `DelegatedJobTracker` from `./delegation.ts`
- **Depends on**: Steps 3, 5
- **Verify**: Gateway restart with a persisted delegated job file should resume polling
- **Done Criteria**: Delegated jobs survive gateway restart
- `[ ] pending`

### Step 8: Make POST /job posse-aware (optional auto-routing) [backend]
- **Action**: modify
- **File**: `packages/gateway/src/channels/http.ts`
- **Details**: In the existing `POST /job` handler, after validation but before `runner.submit()`:
  - If meshCoordinator exists and request doesn't have `?local=true`:
    - Call `meshCoordinator.routeTask(prompt)`
    - If a remote agent scores > 0.3 better than self: auto-delegate (same flow as POST /posse/job)
    - Otherwise: run locally as before
  - If no meshCoordinator or `?local=true`: always run locally (existing behavior)
  - This makes `POST /job` and `POST /posse/job` converge — same endpoint works for both modes
- **Depends on**: Steps 5, 6
- **Verify**: POST /job with posse config auto-routes; POST /job?local=true always runs locally
- **Done Criteria**: Single endpoint handles both local and posse execution transparently
- `[ ] pending`

### Step 9: Add posse job listing endpoint [backend]
- **Action**: modify
- **File**: `packages/gateway/src/channels/http.ts`
- **Details**: Add `GET /posse/jobs` that:
  - Lists local jobs that have delegation metadata
  - For each, includes the routing decision (which agent, score)
  - Shows current delegation status (from tracker or last known state)
  - Also modify `GET /posse` to include a summary of active delegated jobs
- **Depends on**: Steps 3, 5
- **Verify**: `curl /posse/jobs | jq .` shows delegated job list
- **Done Criteria**: Users can see all posse-routed jobs and their status
- `[ ] pending`

### Step 10: Close PR #74 with rationale [docs]
- **Action**: run
- **File**: N/A (GitHub CLI)
- **Details**: Close the PR with a comment explaining: the conductor duplicates gateway+mesh functionality, the real work is evolving the gateway (this plan), link to this plan file, thank for the learning
- **Depends on**: None
- **Verify**: `gh pr view 74 --json state` shows `CLOSED`
- **Done Criteria**: PR #74 is closed with explanation
- `[ ] pending`

### Step 11: Write Phase 4 architecture document [docs]
- **Action**: create
- **File**: `docs/dynamic-agent-spawning.md`
- **Details**: Document covering:
  - Vision: Gateway → single front-door agent → delegates or spawns specialists
  - Why this model (emergent vs prescribed, cost-efficient, scales to zero)
  - How it builds on the unified invocation layer (routeTask returns "spawn" option)
  - Railway API integration: `POST /v1/services` to create from template, health polling, domain assignment
  - Service template registry: archetype definitions (like full-company.yaml agents), stored in Meilisearch
  - Warm-up flow: spawn → wait for health → register in mesh → route task
  - Idle teardown: no jobs for N minutes → deregister → destroy Railway service
  - Cost controls: max concurrent spawns, per-hour budget, auto-pause
  - Security: spawned agents inherit parent's auth tokens, scoped API keys
  - Failure modes: spawn timeout, health check failure, Railway API rate limits
  - Migration path from static posse to dynamic spawning
- **Depends on**: None
- **Verify**: File exists and covers all sections
- **Done Criteria**: Comprehensive architecture doc that a developer could use to implement Phase 4
- `[ ] pending`

## Sprint Contract

(To be filled during build)

## Files to Modify

| File | Change Type | Steps | Scope |
|------|------------|-------|-------|
| `tools/mcp-memory/handlers/posse.ts` | Bug fix | 1 | Fix `/jobs` → `/job` on lines ~282, ~321, ~331 |
| `packages/gateway/src/channels/http.ts` | Feature | 2, 5, 8, 9 | Add `/jobs` aliases, `POST /posse/job`, posse-aware `POST /job`, `GET /posse/jobs` |
| `packages/gateway/src/gateway.ts` | Feature | 6, 7 | Expose `routeTask()` on meshCoordinator, wire delegation recovery |
| `packages/gateway/src/delegation.ts` | **Create** | 3 | `DelegatedJobTracker` class, `createDelegatedJob()` helper, `DelegationMetadata` type |
| `packages/gateway/src/__tests__/delegation.test.ts` | **Create** | 4 | Unit tests for DelegatedJobTracker |
| `docs/dynamic-agent-spawning.md` | **Create** | 11 | Phase 4 architecture document |
| `packages/gateway/src/jobs.ts` | None | — | No changes needed (works as-is for delegated jobs) |
| `packages/gateway/src/events.ts` | None | — | No changes needed |
| `packages/mesh/src/router.ts` | None | — | No changes needed |
| `packages/gateway/src/channels/discord.ts` | None | — | No changes needed (events flow transparently) |
| `packages/runner/src/runner.ts` | None | — | No changes needed (delegation is above runner layer) |

## Dependencies / Prerequisites

- Working Meilisearch instance for agent registry
- At least 2 Randal agents deployed for integration testing
- OPENROUTER_API_KEY or ANTHROPIC_API_KEY for live testing

## Risks / Considerations

- Remote job polling adds latency and network dependency
- Gateway as single front-door is a SPOF for user-facing channels
- Dynamic agent spawning (Phase 4) has significant cost implications
- Endpoint mismatch bug may have additional instances beyond delegate_task
- Polling interval (3s) could be aggressive at scale — consider exponential backoff or SSE from remote
- The `meshCoordinator` in gateway.ts starts with empty instances — need to ensure discovery completes before routing

## Rollback Plan

- Git revert the branch. Single-agent mode is unaffected by mesh changes.

## Acceptance Criteria

- [ ] `delegate_task` MCP tool successfully delegates between two agents
- [ ] `POST /posse/job` routes to best agent and returns job ID
- [ ] Discord shows progress for posse-routed jobs in real-time
- [ ] Gateway can handle 3+ concurrent posse jobs without blocking
- [ ] Gateway restart recovers in-flight delegated jobs
- [ ] All existing tests pass
- [ ] Phase 4 architecture doc exists at `docs/dynamic-agent-spawning.md`
- [ ] PR #74 closed with rationale

## Build Notes

(Reserved for @build)

## Planning Progress

- [x] Requirements gathered (Turn 0)
- [x] Discovery (Turn 1 — all 8 files read, architecture mapped)
- [x] Drafting (Turn 2 — 11 steps, dependency graph, files table)
- [ ] Verification

---
