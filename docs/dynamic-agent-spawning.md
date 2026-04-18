# Dynamic Agent Spawning Architecture

## Vision

The natural evolution of Randal's posse model: instead of pre-deploying N specialized agents, a single "front-door" gateway agent spawns specialists on demand via Railway API.

This document describes Phase 4 of the unified invocation layer plan. Phases 1–3 (implemented in `feat/unified-posse-invocation`) establish the delegation primitives — `DelegatedJobTracker`, `POST /posse/job`, posse-aware `POST /job`, and crash recovery. Phase 4 extends these to create and destroy agents dynamically.

## Current Model (Static Posse)

```
Gateway ──→ Agent A (always running)
         ──→ Agent B (always running)
         ──→ Agent C (always running)
```

- All agents run 24/7 regardless of demand
- ~$225/month for 10 agents on Railway
- Fixed expertise topology — adding a new specialty requires manual deploy
- Idle agents consume resources even when no work is available

## Target Model (Dynamic Spawning)

```
Gateway ──→ Front-door Agent (always running)
              ├──→ Spawns Specialist A (on demand, auto-teardown)
              ├──→ Spawns Specialist B (on demand, auto-teardown)
              └──→ Uses existing idle peers (if available)
```

- Only the front-door agent runs permanently
- Specialists spin up when needed, tear down when idle
- Cost scales with actual usage
- Expertise topology is emergent — spawn what you need, when you need it

## How It Builds on the Unified Invocation Layer

The `routeTask()` function in the mesh router (`packages/mesh/src/router.ts`) currently returns:

- A `RoutingDecision` — route to an existing idle agent with sufficient expertise
- `null` — no suitable agent available, run locally

With dynamic spawning, a third option emerges:

- A `SpawnDecision` — no idle specialist available → create one from an archetype template

The `POST /posse/job` and `POST /job` endpoints already handle delegation transparently via `DelegatedJobTracker`. The only change is in the routing logic: if `routeTask()` returns a spawn decision, the gateway:

1. Calls the Railway API to create a service from an archetype template
2. Waits for the service to become healthy (poll `/health`)
3. The new agent auto-registers in Meilisearch on startup
4. Delegates the task as normal via the existing `DelegatedJobTracker` flow

From the user's perspective (Discord, HTTP), nothing changes — the gateway handles spawn/delegate/teardown transparently.

## Railway API Integration

### Service Creation

```typescript
// Railway GraphQL API
// POST https://backboard.railway.com/graphql/v2
mutation {
  serviceCreate(
    input: {
      projectId: $projectId
      name: "specialist-{archetype}-{uuid}"
      source: { image: "ghcr.io/drewbietron/randal:latest" }
    }
  ) { id }
}
```

The gateway needs a `RAILWAY_API_TOKEN` with project-level permissions and the `RAILWAY_PROJECT_ID` for the target project.

### Environment Configuration

Each spawned agent gets environment variables from its archetype template plus inherited parent config:

| Variable | Source | Purpose |
|----------|--------|---------|
| `AGENT_NAME` | Archetype | Unique agent identity |
| `AGENT_ROLE` | Archetype | Role for mesh routing (e.g., `product-engineering`) |
| `AGENT_EXPERTISE` | Archetype | Comma-separated expertise tags |
| `RANDAL_SKIP_MEILISEARCH` | `false` | Uses shared Meilisearch instance |
| `MEILISEARCH_URL` | Parent | Shared Meilisearch endpoint |
| `MEILISEARCH_MASTER_KEY` | Parent | Shared Meilisearch auth |
| `OPENROUTER_API_KEY` | Parent | LLM API access |
| `RANDAL_SPAWNED_BY` | Parent name | Tracks lineage for teardown |
| `RANDAL_POSSE_NAME` | Parent | Joins the same posse |
| `RANDAL_AUTO_TEARDOWN` | `true` | Enables idle self-teardown |

### Health Polling

After spawning a service, poll `GET /health` every 5 seconds for up to 3 minutes:

```typescript
async function waitForHealth(endpoint: string, timeout = 180_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(`${endpoint}/health`);
      if (res.ok) return true;
    } catch {
      // Not ready yet
    }
    await sleep(5_000);
  }
  return false; // Spawn timeout
}
```

Railway typically takes 30–90 seconds for first deploy of a cached Docker image.

### Domain Assignment

Railway auto-assigns a `*.up.railway.app` domain to each service. The spawned agent registers itself in Meilisearch on startup (existing behavior in `packages/gateway/src/gateway.ts`), so the front-door discovers it via the existing mesh registry — no manual domain configuration needed.

## Service Template Registry

Agent archetypes are stored in a Meilisearch index `agent-archetypes-{posse}`:

```json
{
  "id": "product-engineering",
  "name": "Product Engineering Specialist",
  "role": "product-engineering",
  "expertise": ["react", "typescript", "nodejs", "nextjs", "tailwind", "prisma"],
  "specialization": "Full-stack web development with modern frameworks",
  "dockerImage": "ghcr.io/drewbietron/randal:latest",
  "resources": {
    "memory": "2Gi",
    "cpu": "1"
  },
  "warmupTime": "60s",
  "model": "anthropic/claude-sonnet-4",
  "maxConcurrentJobs": 2
}
```

The `routeTask()` function would query this index when no existing agent matches, selecting the archetype with the highest expertise overlap for the task's domain.

### Archetype Examples

| Archetype | Role | Key Expertise | Typical Use |
|-----------|------|---------------|-------------|
| `product-engineering` | Full-stack dev | React, TypeScript, Node.js | Feature implementation |
| `security-compliance` | Security review | OWASP, auth, encryption | Security audits |
| `data-engineering` | Data pipelines | SQL, ETL, analytics | Data tasks |
| `infra-devops` | Infrastructure | Docker, Railway, CI/CD | Deploy and infra |
| `research-analyst` | Research | Web search, synthesis | Deep research tasks |

## Idle Teardown

Spawned agents should not run indefinitely. The teardown lifecycle:

1. **Monitor**: If an agent has 0 active jobs for N minutes (default: 15), mark as `idle-candidate`
2. **Grace period**: Send a "preparing to teardown" notification to the parent gateway. Wait 2 minutes for new work to arrive
3. **Teardown sequence**:
   - Deregister from mesh (remove from Meilisearch `posse-registry-{posse}` index)
   - Delete the Railway service via GraphQL API
   - Remove any Meilisearch records (memory, chat history) scoped to the agent
4. **Never tear down the front-door agent** — check `RANDAL_SPAWNED_BY` existence

Teardown can be initiated by:

- The spawned agent itself (self-monitoring idle time via `RANDAL_AUTO_TEARDOWN`)
- The parent gateway (centralized idle monitoring)
- Budget controls (monthly limit reached)

## Cost Controls

```typescript
interface SpawnCostConfig {
  /** Max spawned agents running simultaneously (default: 3) */
  maxConcurrentSpawns: number;

  /** Railway cost cap per hour in USD (default: 5) */
  maxHourlyBudget: number;

  /** Hard monthly spending limit in USD */
  maxMonthlyBudget: number;

  /** Always prefer existing idle agents over spawning new ones (default: true) */
  preferIdle: boolean;

  /** Minimum seconds between spawns of the same archetype (default: 300) */
  cooldownSeconds: number;

  /** Minutes before idle teardown (default: 15) */
  idleTimeoutMinutes: number;
}
```

Cost tracking:

- Railway provides usage metrics via their API
- The gateway tracks spawn/teardown events with timestamps
- Estimated cost = (agent runtime hours) × (Railway per-hour rate for resource tier)
- When `maxMonthlyBudget` is 80% consumed, switch to "prefer idle only" mode
- When 100% consumed, reject all spawn requests and route to existing agents or local

## Failure Modes

| Failure | Detection | Recovery |
|---------|-----------|----------|
| **Spawn timeout** (Railway API slow) | Health poll exceeds 3 min | Delete the service, fall back to local execution |
| **Health check failure** (agent won't start) | Health returns non-200 after startup | Delete the service, log error with Railway logs, fall back to local |
| **Railway API rate limit** | 429 response | Queue spawn requests, retry with exponential backoff (max 60s) |
| **Budget exceeded** | Cost tracking exceeds limits | Reject spawn, route to existing agents or execute locally |
| **Orphaned agents** (gateway crashes before teardown) | Heartbeat monitor detects stale agents (no heartbeat for 10 min) | Auto-teardown via a background sweep job |
| **Recursive spawning** | Agent tries to spawn another agent | Guard: spawned agents (`RANDAL_SPAWNED_BY` set) cannot call spawn API |

### Orphan Detection

A background cron job (every 5 minutes) on the front-door gateway:

1. Query Meilisearch for all agents with `RANDAL_SPAWNED_BY` set
2. Check each agent's last heartbeat timestamp
3. If last heartbeat > 10 minutes ago and agent is not in the active trackers map:
   - Attempt health check — if responsive, just update records
   - If unresponsive, initiate teardown sequence

## Migration Path

| Phase | Description | Status |
|-------|-------------|--------|
| **Today** | Static posse with pre-deployed agents | Current |
| **Phase 1–3** | Unified invocation layer with delegation tracking | Implemented (`feat/unified-posse-invocation`) |
| **Phase 4a** | Add `SpawnDecision` to `routeTask()`, Railway API client, basic spawn/teardown | Future |
| **Phase 4b** | Archetype registry, cost controls, idle monitoring | Future |
| **Phase 4c** | Self-optimizing: track archetype usage frequency, pre-warm popular ones | Future |

### Phase 4a Details

Minimal additions to the existing codebase:

1. **New file**: `packages/mesh/src/spawner.ts` — Railway API client, spawn/teardown/health
2. **Modify**: `packages/mesh/src/router.ts` — `routeTask()` returns `RoutingDecision | SpawnDecision | null`
3. **Modify**: `packages/gateway/src/channels/http.ts` — `POST /posse/job` handles `SpawnDecision` (spawn → wait → delegate)
4. **New file**: `packages/gateway/src/archetype-registry.ts` — Meilisearch-backed archetype CRUD
5. **Modify**: `packages/gateway/src/gateway.ts` — orphan detection cron, cost tracking

### Phase 4b Details

- Meilisearch index for archetypes with CRUD endpoints
- Cost dashboard endpoint (`GET /posse/costs`)
- Idle monitoring loop integrated into gateway heartbeat
- Config file support for spawn cost limits

### Phase 4c Details

- Track which archetypes are spawned most frequently
- Pre-warm popular archetypes during business hours
- Auto-suggest new archetypes based on task routing misses
- A/B test archetype configurations for cost vs. performance

## Security Considerations

- **API key inheritance**: Spawned agents inherit API keys from the parent's Railway project environment variables. They share the same LLM and Meilisearch access.
- **Principle of least privilege**: Consider per-agent scoped tokens for Meilisearch (read-only for memory search, write for own agent records only). Railway service tokens can be scoped to the spawned service.
- **Recursion guard**: Spawned agents (those with `RANDAL_SPAWNED_BY` set) must not be able to spawn additional agents. The spawn API should check this and reject.
- **Network isolation**: All agents in the same Railway project share a private network. External access is via Railway's public domain only.
- **Secret rotation**: When parent rotates API keys, spawned agents need restart or re-deploy. Consider a shared secret store (Railway shared variables) rather than per-service env vars.
- **Audit trail**: All spawn/teardown events should be logged to Meilisearch with timestamp, archetype, cost, duration, and initiating job ID.
