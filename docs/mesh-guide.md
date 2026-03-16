# Multi-Instance Mesh Guide

The `@randal/mesh` package lets multiple Randal instances discover each other,
share work, and route jobs to the best-suited instance. This turns a
collection of single agents into a coordinated mesh.

---

## Concept overview

A **mesh** is a peer-to-peer network of Randal instances. Each instance:

- **Registers** itself with the mesh on startup.
- **Advertises** its specialization, current load, and health.
- **Accepts** delegated jobs from other instances.
- **Routes** incoming jobs to the best peer when a better match exists.

There is no central controller. Every instance maintains a local view of the
mesh by exchanging lightweight heartbeats over HTTP.

```
┌──────────┐       heartbeat       ┌──────────┐
│ Instance │ ◄──────────────────► │ Instance │
│  "infra" │                       │ "frontend"│
└────┬─────┘                       └─────┬────┘
     │          heartbeat                │
     └──────────────┬────────────────────┘
                    ▼
              ┌──────────┐
              │ Instance │
              │ "backend"│
              └──────────┘
```

---

## Instance registration and discovery

When `mesh.enabled` is `true`, the instance:

1. Reads `mesh.endpoint` to determine its own reachable URL.
2. Contacts known peers (listed in `.env` or discovered via DNS/mDNS).
3. Exchanges a registration payload containing:
   - Instance name
   - Specialization tag
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

## Specialization configuration

Each instance can declare a specialization — a domain it excels at:

```yaml
mesh:
  enabled: true
  specialization: frontend
  endpoint: http://frontend-agent:7600
```

Specialization tags are free-form strings. Common examples:

| Tag | Typical use |
|-----|------------|
| `frontend` | React, CSS, UI components |
| `backend` | API design, server logic |
| `infra` | Docker, CI/CD, Terraform |
| `database` | SQL, migrations, schema design |
| `docs` | Documentation, READMEs |
| `testing` | Test suites, coverage |
| `general` | No specific focus (default) |

When the analytics package is also enabled, specialization is informed by
reliability scores — instances that consistently succeed in a domain get
routed more of that domain's work.

---

## Routing algorithm

When a job arrives, the mesh router scores every available instance and picks
the best one. The score is a weighted sum of four factors:

```
score = w_s × specialization_match
      + w_r × reliability_score
      + w_l × (1 - load_ratio)
      + w_m × model_match
```

### Weights

| Factor | Key | Default | Description |
|--------|-----|---------|-------------|
| Specialization match | `specialization` | 0.4 | 1.0 if the job's detected domain matches the instance's specialization, 0.0 otherwise |
| Reliability score | `reliability` | 0.3 | Historical success rate for this domain (from `@randal/analytics`) |
| Load availability | `load` | 0.2 | Inverse of current load ratio (0 = fully loaded, 1 = idle) |
| Model match | `modelMatch` | 0.1 | 1.0 if the instance has access to the requested model |

Configure weights in your config:

```yaml
mesh:
  routingWeights:
    specialization: 0.4
    reliability: 0.3
    load: 0.2
    modelMatch: 0.1
```

### Routing decision flow

1. Classify the incoming job's domain (using analytics keywords or explicit
   tag).
2. Score all healthy peers (including self).
3. If the top-scoring peer is self, execute locally.
4. If the top-scoring peer is remote, delegate via
   `POST /api/mesh/delegate`.
5. Stream results back to the original requester.

---

## Health monitoring

Each instance sends heartbeats to all known peers at a configurable interval
(default: 30 seconds). A heartbeat contains:

```json
{
  "name": "infra-agent",
  "specialization": "infra",
  "endpoint": "http://infra-agent:7600",
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
───────────────────────────────────────────────────
Instance        Specialization  Load   Health
───────────────────────────────────────────────────
local (self)    infra           0.15   healthy
frontend-agent  frontend        0.42   healthy
backend-agent   backend         0.00   healthy
docs-agent      docs            0.78   degraded
───────────────────────────────────────────────────
Total instances: 4 │ Healthy: 3 │ Unhealthy: 1
```

### `randal mesh route`

Preview which instance would handle a given prompt:

```
$ randal mesh route "Fix the Docker build"

Routing Analysis
─────────────────────────────────────────────
Domain detected: infra

Instance        Spec    Rel    Load   Model  Score
─────────────────────────────────────────────
local (self)    0.40   0.27   0.17   0.10   0.94
backend-agent   0.00   0.21   0.20   0.10   0.51
frontend-agent  0.00   0.15   0.12   0.10   0.37
─────────────────────────────────────────────
→ Routing to: local (self)
```

---

## Configuration examples

### Minimal mesh instance

```yaml
name: worker-1
runner:
  workdir: ./workspace

mesh:
  enabled: true
  endpoint: http://localhost:7600
```

### Specialized infrastructure agent

```yaml
name: infra-agent
runner:
  workdir: ./workspace
  defaultModel: anthropic/claude-sonnet-4

mesh:
  enabled: true
  specialization: infra
  endpoint: http://infra-agent:7600
  routingWeights:
    specialization: 0.5
    reliability: 0.25
    load: 0.15
    modelMatch: 0.1
```

### Three-node mesh (docker-compose)

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
- Combine with `@randal/analytics` for reliability-informed routing.
- Monitor the `/api/mesh/status` endpoint from your infrastructure tooling.
- Set `MESH_PEERS` via environment variables so the same config image works
  across environments.
