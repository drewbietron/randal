# Posse Conductor

The **Posse Conductor** is the central orchestration gateway for Randal's distributed agent system. It unifies multiple Randal agents into a cohesive "posse" — a team of specialized AI agents that work together with shared memory and coordinated task routing.

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Configuration Reference](#configuration-reference)
- [Local Setup (Mac Mini)](#local-setup-mac-mini)
- [Railway Deployment](#railway-deployment)
- [API Reference](#api-reference)
- [Troubleshooting](#troubleshooting)

---

## Overview

### What is the Posse Conductor?

The Conductor sits at the center of your Randal deployment, providing:

- **Unified Gateway**: Single HTTP/WebSocket endpoint for all agent communication
- **Intelligent Routing**: Automatically routes tasks to the best available agent
- **Real-time Dashboard**: Monitor agent health, active tasks, and system status
- **Posse Coordination**: Manages multi-agent teams with shared Meilisearch memory
- **OpenAI Compatibility**: Drop-in replacement for OpenAI API endpoints

### When to Use Single vs Posse Mode

| Mode | Use Case | Scale |
|------|----------|-------|
| **Single** | Local development, one agent per machine | 1 agent |
| **Posse** | Multi-agent teams, distributed deployments | 2+ agents |

### Key Concepts

- **Agent**: A running Randal instance with a unique identity
- **Posse**: A named group of agents that share memory and coordinate
- **Conductor**: The gateway that routes requests to the right agent
- **Registry**: Meilisearch index tracking all agents and their status
- **Routing**: Strategy for selecting which agent handles a request

---

## Architecture

### Single Mode Architecture

```
┌─────────────────────────────────────────┐
│         Posse Conductor                 │
│         (Port 7777)                     │
│  ┌──────────┐  ┌──────────────────┐    │
│  │  HTTP    │  │   Dashboard      │    │
│  │ Gateway  │  │   (WebSocket)    │    │
│  └────┬─────┘  └──────────────────┘    │
└───────┼─────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────┐
│     Single Randal Agent                 │
│     (Port 7600)                         │
│  ┌──────────┐  ┌──────────────────┐    │
│  │  Runner  │  │   Memory         │    │
│  │  Loop    │  │   (Meilisearch)  │    │
│  └──────────┘  └──────────────────┘    │
└─────────────────────────────────────────┘
```

### Posse Mode Architecture

```
                            ┌─────────────────────────────────────────┐
                            │         Posse Conductor                 │
                            │         (Port 7777)                     │
┌──────────┐               │  ┌──────────┐  ┌──────────────────┐    │
│  Client  │◄─────────────►│  │  HTTP    │  │   Dashboard      │    │
│  (CLI/   │   HTTP/WS     │  │ Gateway  │  │   (WebSocket)    │    │
│  Discord)│               │  └────┬─────┘  └──────────────────┘    │
└──────────┘               └───────┼─────────────────────────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              │                    │                    │
              ▼                    ▼                    ▼
       ┌──────────┐         ┌──────────┐         ┌──────────┐
       │ Agent A  │         │ Agent B  │         │ Agent C  │
       │ (Port    │         │ (Port    │         │ (Port    │
       │  7600)   │         │  7601)   │         │  7602)   │
       └────┬─────┘         └────┬─────┘         └────┬─────┘
            │                    │                    │
            └────────────────────┼────────────────────┘
                                 │
                    ┌────────────┴────────────┐
                    │    Meilisearch          │
                    │    (Port 7700)          │
                    │                         │
                    │  ┌──────────────────┐  │
                    │  │  posse-registry  │  │
                    │  │  (Agent Index)   │  │
                    │  └──────────────────┘  │
                    │  ┌──────────────────┐  │
                    │  │  shared-memory   │  │
                    │  │  (Memory Index)  │  │
                    │  └──────────────────┘  │
                    └─────────────────────────┘
```

### Components

| Component | Responsibility |
|-----------|---------------|
| **HTTP Gateway** | RESTful API for chat completions, agent management |
| **WebSocket Gateway** | Real-time dashboard updates, event streaming |
| **Agent Registry** | Polls Meilisearch for agent discovery and health |
| **Task Router** | Selects the best agent for each request |
| **Dashboard** | Web UI showing posse status and metrics |

---

## Configuration Reference

### Complete Configuration File

```yaml
# conductor.config.yaml

# Mode: 'single' for one agent, 'posse' for multi-agent
mode: posse

# Conductor's LLM model (used for meta-tasks like routing decisions)
model: moonshotai/kimi-k2.5

# Server configuration
server:
  port: 7777                    # HTTP/WebSocket port
  host: 0.0.0.0                 # Bind address (0.0.0.0 for all interfaces)

# Gateway configuration
gateway:
  http:
    enabled: true               # Enable HTTP API
    auth: ${CONDUCTOR_HTTP_AUTH} # Bearer token for API security (optional)
  discord:
    enabled: false              # Enable Discord gateway
    token: ${DISCORD_BOT_TOKEN} # Discord bot token
    guildId: "123456789"        # Optional: restrict to specific server

# Single mode configuration (only used when mode: single)
agent:
  name: local-agent
  url: http://localhost:7600
  model: moonshotai/kimi-k2.5

# Posse mode configuration (only used when mode: posse)
posse:
  name: my-production-posse
  meilisearch:
    url: http://localhost:7700
    apiKey: ${MEILI_MASTER_KEY}
  discovery:
    enabled: true               # Auto-discover agents from registry
    pollInterval: 30000         # Poll interval in milliseconds

# Routing configuration
routing:
  strategy: auto                # 'auto', 'round-robin', or 'explicit'
```

### Configuration Loading Order

The Conductor loads configuration in this priority order:

1. **Explicit path**: `CONDUCTOR_CONFIG_PATH` environment variable
2. **Inline YAML**: `CONDUCTOR_CONFIG_YAML` environment variable
3. **Auto-discovery**: Searches for `conductor.config.yaml`, `conductor.config.yml`, or `conductor.yaml` in current directory
4. **Environment variables**: All settings can be set via env vars (see below)

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `CONDUCTOR_MODE` | Operating mode | `single` |
| `CONDUCTOR_MODEL` | Conductor LLM model | `moonshotai/kimi-k2.5` |
| `CONDUCTOR_PORT` | HTTP port | `7777` |
| `CONDUCTOR_HOST` | Bind address | `0.0.0.0` |
| `CONDUCTOR_HTTP_AUTH` | API auth token | (none) |
| `CONDUCTOR_DISCORD_TOKEN` | Discord bot token | (none) |
| `CONDUCTOR_POSSE_NAME` | Posse name (posse mode) | (required) |
| `CONDUCTOR_MEILI_URL` | Meilisearch URL | `http://localhost:7700` |
| `CONDUCTOR_MEILI_API_KEY` | Meilisearch API key | (none) |

### Single Mode Configuration

For local development with one agent:

```yaml
mode: single
server:
  port: 7777
gateway:
  http:
    enabled: true
agent:
  name: my-agent
  url: http://localhost:7600
  model: moonshotai/kimi-k2.5
```

### Posse Mode Configuration

For multi-agent deployments:

```yaml
mode: posse
server:
  port: 7777
gateway:
  http:
    enabled: true
    auth: ${CONDUCTOR_HTTP_AUTH}
posse:
  name: production-team
  meilisearch:
    url: http://localhost:7700
    apiKey: ${MEILI_MASTER_KEY}
  discovery:
    enabled: true
    pollInterval: 30000
routing:
  strategy: auto
```

---

## Local Setup (Mac Mini)

### Prerequisites

- macOS 13+ (Ventura or later)
- 8GB+ RAM (16GB recommended)
- Docker Desktop (for Meilisearch)
- Bun 1.1+

### Quick Start with Setup Script

```bash
# Run the interactive setup wizard
./scripts/setup-local-posse.sh

# Or use non-interactive mode with defaults
./scripts/setup-local-posse.sh --non-interactive

# Specify custom config directory
./scripts/setup-local-posse.sh --config-dir ~/my-posse-config
```

### Manual Setup

#### 1. Configure Meilisearch

```bash
# Create data directory
mkdir -p ~/.randal/meili-data

# Start Meilisearch via Docker
docker run -d \
  --name randal-meilisearch \
  -p 7700:7700 \
  -e MEILI_MASTER_KEY=$(openssl rand -hex 16) \
  -v ~/.randal/meili-data:/meili_data \
  getmeili/meilisearch:v1.7
```

#### 2. Create Conductor Config

```bash
mkdir -p ~/.config/randal-posse

cat > ~/.config/randal-posse/conductor.config.yaml <<EOF
mode: posse
model: moonshotai/kimi-k2.5
server:
  port: 7777
  host: 0.0.0.0
gateway:
  http:
    enabled: true
  discord:
    enabled: false
posse:
  name: local-posse
  meilisearch:
    url: http://localhost:7700
    apiKey: \\\${MEILI_MASTER_KEY}
  discovery:
    enabled: true
    pollInterval: 30000
routing:
  strategy: auto
EOF
```

#### 3. Set Environment Variables

```bash
cat > ~/.config/randal-posse/.env <<EOF
MEILI_MASTER_KEY=$(openssl rand -hex 16)
CONDUCTOR_HTTP_AUTH=$(openssl rand -hex 32)
EOF

# Source the env file
source ~/.config/randal-posse/.env
```

#### 4. Build and Start

```bash
# Build the conductor
cd /path/to/randal
bun install
bun run --cwd packages/conductor typecheck

# Start the conductor
export CONDUCTOR_CONFIG_PATH=~/.config/randal-posse/conductor.config.yaml
bun run packages/conductor/src/index.ts
```

#### 5. Verify Installation

```bash
# Check health endpoint
curl http://localhost:7777/health

# Expected response:
# {
#   "status": "healthy",
#   "mode": "posse",
#   "agents": { "total": 0, "online": 0, "offline": 0 },
#   "version": "0.1.0",
#   "timestamp": "2026-04-16T..."
# }
```

### Running Multiple Agents on One Machine

To run a multi-agent posse on your Mac Mini:

```bash
# Terminal 1: Start first agent on port 7600
randal serve --port 7600 --name agent-alpha

# Terminal 2: Start second agent on port 7601
randal serve --port 7601 --name agent-beta

# Terminal 3: Start conductor
export CONDUCTOR_CONFIG_PATH=~/.config/randal-posse/conductor.config.yaml
bun run packages/conductor/src/index.ts
```

The Conductor will auto-discover agents through Meilisearch and route requests between them.

---

## Railway Deployment

### Overview

Deploy the Conductor to Railway for a cloud-hosted posse that can coordinate agents running anywhere.

### Deployment Structure

```
railway-deployment/
├── conductor.config.yaml    # Conductor configuration
├── Dockerfile               # Custom Dockerfile (optional)
├── railway.toml            # Railway settings
└── .env                    # Environment variables (not committed)
```

### 1. Create Railway Project

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Create project
railway init --name my-posse-conductor
```

### 2. Configuration for Railway

#### conductor.config.yaml

```yaml
mode: posse
model: moonshotai/kimi-k2.5
server:
  port: ${PORT:-7777}        # Railway sets PORT env var
  host: 0.0.0.0
gateway:
  http:
    enabled: true
    auth: ${CONDUCTOR_HTTP_AUTH}
posse:
  name: railway-posse
  meilisearch:
    url: ${MEILI_URL}        # External Meilisearch instance
    apiKey: ${MEILI_MASTER_KEY}
  discovery:
    enabled: true
    pollInterval: 30000
routing:
  strategy: auto
```

#### railway.toml

```toml
[build]
dockerfile = "Dockerfile"

[deploy]
startCommand = "bun run packages/conductor/src/index.ts"
healthcheckPath = "/health"
healthcheckTimeout = 30
restartPolicyType = "on_failure"
restartPolicyMaxRetries = 3
```

#### Dockerfile (optional)

```dockerfile
FROM ghcr.io/drewbietron/randal:latest

# Copy conductor config
COPY conductor.config.yaml /app/conductor.config.yaml

# Set config path
ENV CONDUCTOR_CONFIG_PATH=/app/conductor.config.yaml

# Expose port
EXPOSE 7777

# Start conductor
CMD ["bun", "run", "packages/conductor/src/index.ts"]
```

### 3. Set Environment Variables

In Railway dashboard or via CLI:

```bash
railway variables set \
  CONDUCTOR_MODE=posse \
  CONDUCTOR_HTTP_AUTH=$(openssl rand -hex 32) \
  MEILI_URL=https://your-meilisearch.up.railway.app \
  MEILI_MASTER_KEY=your-meili-master-key
```

### 4. Deploy

```bash
# Deploy to Railway
railway up

# View logs
railway logs

# Open dashboard
railway open
```

### 5. Connect External Agents

Agents running anywhere can join the posse:

```yaml
# Agent configuration
name: my-local-agent
runner:
  defaultAgent: opencode
  defaultModel: moonshotai/kimi-k2.5
memory:
  store: meilisearch
  url: https://your-meilisearch.up.railway.app  # Same as conductor
  apiKey: your-meili-master-key
  sharing:
    publishTo: [posse-shared]
    readFrom: [posse-shared]
```

The agent will auto-register in the shared Meilisearch, and the Conductor will discover it.

---

## API Reference

### HTTP Endpoints

#### Health Check

```http
GET /health
```

Response:
```json
{
  "status": "healthy",
  "mode": "posse",
  "agents": {
    "total": 3,
    "online": 3,
    "offline": 0,
    "busy": 1,
    "error": 0
  },
  "version": "0.1.0",
  "timestamp": "2026-04-16T10:00:00Z"
}
```

#### Chat Completions (OpenAI-compatible)

```http
POST /v1/chat/completions
Content-Type: application/json
Authorization: Bearer ${CONDUCTOR_HTTP_AUTH}

{
  "model": "moonshotai/kimi-k2.5",
  "messages": [
    {"role": "user", "content": "Hello, posse!"}
  ],
  "stream": false
}
```

Response:
```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1713259200,
  "model": "moonshotai/kimi-k2.5",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "Hello! How can I help you today?"
    },
    "finish_reason": "stop"
  }]
}
```

#### List Agents

```http
GET /posse/agents
Authorization: Bearer ${CONDUCTOR_HTTP_AUTH}
```

Response:
```json
{
  "agents": [
    {
      "id": "agent-alpha",
      "name": "agent-alpha",
      "endpoint": "http://localhost:7600",
      "models": ["moonshotai/kimi-k2.5"],
      "capabilities": ["coding", "planning"],
      "status": "online",
      "lastSeen": "2026-04-16T10:00:00Z",
      "version": "0.1.0"
    }
  ],
  "stats": {
    "total": 1,
    "online": 1,
    "offline": 0
  }
}
```

#### Send Posse Command

```http
POST /posse/command
Content-Type: application/json
Authorization: Bearer ${CONDUCTOR_HTTP_AUTH}

{
  "command": "status",
  "target": "all"
}
```

Response:
```json
{
  "command": "status",
  "targets": ["agent-alpha", "agent-beta"],
  "results": [
    {"agent": "agent-alpha", "success": true, "message": "Healthy"},
    {"agent": "agent-beta", "success": true, "message": "Healthy"}
  ],
  "success": true
}
```

### WebSocket Events

Connect to the dashboard WebSocket at:

```
ws://localhost:7777/dashboard
```

#### Client → Server Events

| Event | Description |
|-------|-------------|
| `dashboard:subscribe` | Subscribe to dashboard updates |
| `dashboard:unsubscribe` | Unsubscribe from updates |
| `command:send` | Send command to specific agent(s) |

#### Server → Client Events

| Event | Payload | Description |
|-------|---------|-------------|
| `agents:initial` | `AgentRecord[]` | Full agent list on connect |
| `agent:update` | `AgentRecord` | Single agent status update |
| `agent:remove` | `{ id: string }` | Agent removed from registry |
| `task:started` | `TaskEvent` | Task started |
| `task:completed` | `TaskEvent` | Task completed |
| `task:failed` | `TaskEvent` | Task failed |
| `stats:update` | `DashboardStats` | Aggregated statistics |

### WebSocket Example (JavaScript)

```javascript
const socket = io('http://localhost:7777');

// Subscribe to dashboard
socket.emit('dashboard:subscribe');

// Listen for updates
socket.on('agents:initial', (agents) => {
  console.log('All agents:', agents);
});

socket.on('agent:update', (agent) => {
  console.log('Agent updated:', agent.name, agent.status);
});

socket.on('task:completed', (event) => {
  console.log('Task completed:', event.taskName);
});
```

---

## Troubleshooting

### Common Issues

#### Meilisearch Connection Failed

**Symptom**: Conductor fails to start with "Meilisearch connection error"

**Solution**:
```bash
# Check if Meilisearch is running
curl http://localhost:7700/health

# Start Meilisearch if not running
docker start randal-meilisearch

# Or recreate the container
docker run -d \
  --name randal-meilisearch \
  -p 7700:7700 \
  -e MEILI_MASTER_KEY=your-key \
  -v ~/.randal/meili-data:/meili_data \
  getmeili/meilisearch:v1.7
```

#### No Agents Available

**Symptom**: Requests fail with "No agents available"

**Solution**:
```bash
# Check agent health
curl http://localhost:7777/posse/agents

# Verify agent is registering in Meilisearch
curl -H "Authorization: Bearer $MEILI_MASTER_KEY" \
  http://localhost:7700/indexes/posse-registry/search

# Check agent configuration
# Ensure memory.sharing.publishTo includes the posse name
```

#### Port Already in Use

**Symptom**: "EADDRINUSE: Port 7777 already in use"

**Solution**:
```bash
# Find process using port 7777
lsof -i :7777

# Kill the process
kill -9 <PID>

# Or use a different port in config
export CONDUCTOR_PORT=7778
```

#### Discord Gateway Not Connecting

**Symptom**: "Discord gateway failed to connect"

**Solution**:
1. Verify bot token: `echo $DISCORD_BOT_TOKEN`
2. Check bot permissions in Discord Developer Portal
3. Ensure bot is invited to server with correct permissions
4. Verify gateway intent settings

### Debug Mode

Enable verbose logging:

```bash
export DEBUG=conductor:*
bun run packages/conductor/src/index.ts
```

### Health Check Script

```bash
#!/bin/bash
# check-conductor-health.sh

echo "Checking Conductor health..."

# Check conductor
curl -sf http://localhost:7777/health > /dev/null && echo "✓ Conductor: OK" || echo "✗ Conductor: FAIL"

# Check Meilisearch
curl -sf http://localhost:7700/health > /dev/null && echo "✓ Meilisearch: OK" || echo "✗ Meilisearch: FAIL"

# List agents
echo ""
echo "Registered Agents:"
curl -s http://localhost:7777/posse/agents | jq '.agents[] | {name: .name, status: .status}'
```

### Getting Help

1. Check logs: `tail -f /tmp/randal-conductor.log`
2. Review configuration: `cat ~/.config/randal-posse/conductor.config.yaml`
3. Test Meilisearch: `curl http://localhost:7700/health`
4. Run setup tests: `./scripts/setup-local-posse.test.sh --verbose`

---

## Additional Resources

- [Main Randal README](../README.md)
- [Configuration Reference](config-reference.md)
- [Deployment Guide](deployment-guide.md)
- [Discord Integration Guide](discord-guide.md)
- [Mesh Guide](mesh-guide.md) - For multi-machine deployments
