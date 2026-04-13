# Multi-Instance Mesh Guide

The `@randal/mesh` package lets multiple Randal instances discover each other,
share work, and route jobs to the best-suited instance. This turns a
collection of single agents into a coordinated mesh.

---

## Concept overview

A **mesh** is a peer-to-peer network of Randal instances. Each instance:

- **Registers** itself with the mesh on startup.
- **Advertises** its role, expertise profile, current load, and health.
- **Accepts** delegated jobs from other instances.
- **Routes** incoming jobs to the best peer when a better match exists.

There is no central controller. Every instance maintains a local view of the
mesh by exchanging lightweight heartbeats over HTTP.

```
┌──────────────┐     heartbeat     ┌──────────────┐
│   Instance   │ ◄──────────────► │   Instance   │
│  platform-   │                   │  product-    │
│  infra       │                   │  engineering │
└──────┬───────┘                   └──────┬───────┘
       │          heartbeat               │
       └──────────────┬───────────────────┘
                      ▼
               ┌──────────────┐
               │   Instance   │
               │  security-   │
               │  compliance  │
               └──────────────┘
```

---

## Instance registration and discovery

When `mesh.enabled` is `true`, the instance:

1. Reads `mesh.endpoint` to determine its own reachable URL.
2. Contacts known peers (listed in `.env` or discovered via DNS/mDNS).
3. Exchanges a registration payload containing:
   - Instance name
   - Role and expertise profile
   - Gateway endpoint
   - Current load (active jobs / capacity)
   - Model availability

### Bootstrap methods

| Method | Config | Description |
|--------|--------|-------------|
| Static peers | `MESH_PEERS=url1,url2` env var | Comma-separated list of peer gateway URLs |
| DNS SRV | `MESH_DNS_SRV=_randal._tcp.local` | DNS service discovery |
| mDNS | Automatic on local networks | Zero-config LAN discovery |

On startup, the instance sends `POST /api/mesh/register` to each known peer
and begins periodic heartbeats.

---

## Agent profiles

Each instance declares an expertise profile that the mesh uses for intelligent
task routing. The profile has three tiers:

### `mesh.role` — broad domain (recommended)

One of 10 predefined domain slugs. Used for pre-filtering candidates and
analytics categorization.

| Domain Slug | Description | Typical expertise areas |
|---|---|---|
| `product-engineering` | Full-stack development | React, TypeScript, APIs, databases, architecture |
| `platform-infrastructure` | DevOps and SRE | Docker, Kubernetes, CI/CD, Terraform, observability |
| `security-compliance` | Application and infra security | AppSec, OWASP, GDPR, SOC2, penetration testing |
| `data-intelligence` | Data engineering and analytics | ETL, ML, BigQuery, Spark, dashboards, BI |
| `design-experience` | UX/UI and accessibility | Figma, design systems, a11y, i18n, prototyping |
| `content-communications` | Technical writing and comms | Docs, blog, release notes, marketing copy |
| `revenue-growth` | Sales and business development | GTM, partnerships, pricing, conversion funnels |
| `customer-operations` | Support and success | Zendesk, onboarding, SLAs, churn, NPS |
| `strategy-finance` | Product management and finance | Roadmaps, OKRs, budgets, sprint planning |
| `legal-governance` | Legal and policy | Contracts, NDAs, IP, licensing, regulatory |

```yaml
mesh:
  role: product-engineering
```

### `mesh.expertise` — rich skill description (recommended)

A natural language description of the agent's detailed skills. This text is
embedded (vectorized) at startup and used for semantic matching at routing
time.

Three formats are supported:

**Inline string:**

```yaml
mesh:
  expertise: >
    Expert in React, TypeScript, and frontend architecture.
    Deep knowledge of Next.js SSR, design systems, and
    responsive UI patterns.
```

**File reference:**

```yaml
mesh:
  expertise:
    file: ./profiles/frontend-eng.md
```

**Combined (file + additional context):**

```yaml
mesh:
  expertise:
    file: ./profiles/frontend-eng.md
    additional: "Also experienced with the internal billing system and Stripe integration"
```

The file format follows the same pattern as `identity.knowledge` — point to a
markdown file containing a detailed expertise description. At boot, the file
is read, concatenated with any `additional` text, and the full text is
embedded for semantic matching.

---

## Routing algorithm

When a job arrives, the mesh router scores every available instance and picks
the best one. The score is a weighted sum of four factors:

```
score = w_e × expertise_match
      + w_r × reliability_score
      + w_l × (1 - load_ratio)
      + w_m × model_match
```

### Weights

| Factor | Key | Default | Description |
|--------|-----|---------|-------------|
| Expertise match | `expertise` | 0.4 | Semantic similarity between task and agent expertise profile (2-tier fallback) |
| Reliability score | `reliability` | 0.3 | Historical success rate for this domain (from `@randal/analytics`) |
| Load availability | `load` | 0.2 | Inverse of current load ratio (0 = fully loaded, 1 = idle) |
| Model match | `modelMatch` | 0.1 | 1.0 if the instance has access to the requested model |

Configure weights in your config:

```yaml
mesh:
  routingWeights:
    expertise: 0.4
    reliability: 0.3
    load: 0.2
    modelMatch: 0.1
```

### 2-tier expertise scoring

The expertise match factor uses a cascading fallback strategy:

1. **Semantic (Tier 1)**: If both the task prompt and the agent's expertise
   profile have been embedded (requires `OPENROUTER_API_KEY`), the router
   computes cosine similarity between the two vectors. This is the most
   accurate tier — it understands that "fix the login flow" matches an agent
   with "authentication and session management" expertise, even though the
   words differ.

2. **Role match (Tier 2)**: If embeddings are unavailable, the router performs
   an exact match on `mesh.role` against the auto-detected task domain. Score:
   1.0 for exact match, 0.2 for no match.

### Routing decision flow

1. **Auto-detect domain**: Classify the task's domain from keywords using the
   10-domain taxonomy — or accept an explicit `domain` hint from the caller.
2. **Embed the task**: If the embedding service is available, vectorize the
   task description (single API call, <500ms).
3. **Pre-filter candidates**: If enough peers exist (>2), narrow to those
   whose `role` matches the detected domain. If no role matches, keep all
   candidates.
4. **Score all candidates**: Compute the weighted sum for each remaining peer
   (including self).
5. **Route**: If the top-scoring peer is self, execute locally. If remote,
   delegate via `POST /api/mesh/delegate` and stream results back.

---

## Health monitoring

Each instance sends heartbeats to all known peers at a configurable interval
(default: 30 seconds). A heartbeat contains:

```json
{
  "name": "eng-agent",
  "role": "product-engineering",
  "expertise": "React, TypeScript, frontend architecture...",
  "endpoint": "http://eng-agent:7600",
  "load": 0.35,
  "activeJobs": 2,
  "uptime": 86400,
  "version": "0.1"
}
```

An instance is marked **unhealthy** if it misses 3 consecutive heartbeats
(~90 seconds by default). Unhealthy instances receive a routing score of 0
and are skipped during delegation.

When an unhealthy instance resumes heartbeats, it is automatically
re-admitted to the mesh.

---

## Cross-instance job delegation

Delegation follows these rules:

1. **Depth limit**: Delegated jobs carry a `depth` counter. An instance will
   not re-delegate a job that has already been delegated
   `runner.maxDelegationDepth` times (default: 2).
2. **Sticky sessions**: Once a job is delegated to a peer, follow-up messages
   in the same conversation are routed to the same peer unless it becomes
   unhealthy.
3. **Fallback**: If the chosen peer rejects or times out, the originating
   instance falls back to local execution.
4. **Streaming**: Delegated jobs stream events back via SSE so the end user
   sees real-time progress.

### API endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/mesh/register` | POST | Register this instance with a peer |
| `/api/mesh/heartbeat` | POST | Send health heartbeat |
| `/api/mesh/delegate` | POST | Delegate a job to this instance |
| `/api/mesh/status` | GET | Return mesh topology and health |

---

## CLI commands

### `randal mesh status`

Display the current mesh topology:

```
$ randal mesh status

Mesh Status
──────────────────────────────────────────────────────────────────────────────────
Instance        Role                     Expertise                   Load   Health
──────────────────────────────────────────────────────────────────────────────────
local (self)    platform-infrastructure   K8s, Terraform, CI/CD...   0.15   healthy
eng-agent       product-engineering       React, TypeScript, APIs..  0.42   healthy
sec-agent       security-compliance       AppSec, OWASP, audits...   0.00   healthy
docs-agent      content-communications    Tech writing, guides...    0.78   degraded
──────────────────────────────────────────────────────────────────────────────────
Total instances: 4 │ Healthy: 3 │ Unhealthy: 1
```

### `randal mesh route`

Preview which instance would handle a given prompt:

```
$ randal mesh route "Fix the Docker build"

Routing Analysis
───────────────────────────────────────────────────────────
Domain detected: platform-infrastructure

Instance        Expert  Rel    Load   Model  Score
───────────────────────────────────────────────────────────
local (self)    0.920  0.270  0.170  0.100  0.94
eng-agent       0.310  0.210  0.200  0.100  0.51
sec-agent       0.050  0.150  0.120  0.100  0.37
───────────────────────────────────────────────────────────
→ Routing to: local (self)
```

---

## Configuration examples

### Minimal mesh instance

No profile fields required — the instance participates in the mesh but
receives a neutral expertise score (0.5) during routing.

```yaml
name: worker-1
runner:
  workdir: ./workspace

mesh:
  enabled: true
  endpoint: http://localhost:7600
```

### Infrastructure agent with expertise profile

```yaml
name: infra-agent
runner:
  workdir: ./workspace
  defaultModel: anthropic/claude-sonnet-4

mesh:
  enabled: true
  role: platform-infrastructure
  expertise: >
    Kubernetes cluster management, Terraform IaC, GitHub Actions CI/CD,
    Docker containerization, Prometheus/Grafana observability stack,
    AWS EKS and GCP GKE administration.
  endpoint: http://infra-agent:7600
  routingWeights:
    expertise: 0.5
    reliability: 0.25
    load: 0.15
    modelMatch: 0.1
```

### File-based expertise profile

```yaml
name: frontend-agent
runner:
  workdir: ./workspace

mesh:
  enabled: true
  role: product-engineering
  expertise:
    file: ./profiles/frontend-eng.md
    additional: "Also experienced with the internal billing system"
  endpoint: http://frontend-agent:7600
```

### Three-node mesh (docker-compose)

Each `configs/*.yaml` file should have `mesh.role` and `mesh.expertise` set
for optimal routing. See the examples above for the config format.

```yaml
# docker-compose.yml
services:
  frontend-agent:
    image: ghcr.io/drewbietron/randal:latest
    environment:
      MESH_PEERS: http://backend-agent:7600,http://infra-agent:7600
    volumes:
      - ./configs/frontend.yaml:/app/randal.config.yaml

  backend-agent:
    image: ghcr.io/drewbietron/randal:latest
    environment:
      MESH_PEERS: http://frontend-agent:7600,http://infra-agent:7600
    volumes:
      - ./configs/backend.yaml:/app/randal.config.yaml

  infra-agent:
    image: ghcr.io/drewbietron/randal:latest
    environment:
      MESH_PEERS: http://frontend-agent:7600,http://backend-agent:7600
    volumes:
      - ./configs/infra.yaml:/app/randal.config.yaml
```

---

## Tips

- Start with 2 instances and add more as your workload grows.
- Use `randal mesh route` to verify routing before deploying.
- Write detailed expertise descriptions — the more specific, the better the
  semantic routing. Include technologies, frameworks, and domain knowledge.
- Use `randal mesh route 'your task'` to preview how the expertise matcher
  scores your peers.
- Combine with `@randal/analytics` for reliability-informed routing.
- Monitor the `/api/mesh/status` endpoint from your infrastructure tooling.
- Set `MESH_PEERS` via environment variables so the same config image works
  across environments.
