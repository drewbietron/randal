# 🚀 Deployment Guide

Randal runs anywhere Bun runs. This guide covers two primary deployment targets: a local Mac Mini and Railway (cloud).

---

## 📋 Prerequisites

All deployments require:

- **Bun** >= 1.1
- **At least one agent CLI** installed and on PATH (`opencode`, `claude`, or `codex`)
- **API keys** for your chosen model provider (e.g., `ANTHROPIC_API_KEY`)
- **Meilisearch** (optional but recommended for production memory/search)

---

## 🍎 Mac Mini (Local)

A Mac Mini is the simplest deployment: Randal runs as a background process with `launchd` or a process manager.

### 1. Install Dependencies

```bash
# Install Bun
curl -fsSL https://bun.sh/install | bash

# Install Meilisearch
brew install meilisearch

# Install your agent CLI (example: Claude Code)
npm install -g @anthropic-ai/claude-code
```

### 2. Clone and Build

```bash
git clone <repo-url> ~/randal
cd ~/randal
bun install
```

### 3. Configure

```bash
cd ~/randal  # use examples/local-mac/ as a starting point
cp .env.example .env
# Edit .env with your API keys
```

Example `randal.config.yaml`:

```yaml
name: home-agent
runner:
  defaultAgent: opencode
  defaultModel: anthropic/claude-sonnet-4
  workdir: ~/dev
credentials:
  envFile: ./.env
  allow: [ANTHROPIC_API_KEY]
gateway:
  channels:
    - type: http
      port: 7600
      auth: "${RANDAL_API_TOKEN}"
memory:
  store: meilisearch
  url: http://localhost:7700
  apiKey: "${MEILI_MASTER_KEY}"
```

### 4. Start Meilisearch

```bash
# Start with a master key
meilisearch --master-key="${MEILI_MASTER_KEY}" --db-path ~/meilisearch-data

# Or run in background
nohup meilisearch --master-key="${MEILI_MASTER_KEY}" --db-path ~/meilisearch-data &
```

### 5. Start Randal

```bash
cd ~/randal
randal serve
```

To run as a persistent background service, create a `launchd` plist:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.randal.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/you/.bun/bin/bun</string>
    <string>/Users/you/randal/packages/cli/src/index.ts</string>
    <string>serve</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/you/randal</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/randal.out.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/randal.err.log</string>
</dict>
</plist>
```

```bash
cp com.randal.agent.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.randal.agent.plist
```

### 6. Verify

```bash
curl http://localhost:7600/health
# {"status":"ok","uptime":...,"version":"0.1.0"}

# Open dashboard
open http://localhost:7600/
```

---

## 🚂 Railway (Cloud)

Railway provides a simple container hosting platform. Randal can be deployed as a service alongside a Meilisearch instance.

### 1. Project Structure

Create a deployment directory with:

```
my-deployment/
  randal.config.yaml
  .env              # (Railway manages env vars; this is for local testing)
  Dockerfile
```

### 2. Dockerfile

```dockerfile
FROM oven/bun:1 AS base
WORKDIR /app

# Install agent CLI
RUN npm install -g @anthropic-ai/claude-code

# Copy and install
COPY package.json bun.lock ./
COPY packages/ packages/
RUN bun install --frozen-lockfile

# Copy deployment config
COPY randal.config.yaml ./randal.config.yaml

EXPOSE 7600
CMD ["bun", "packages/cli/src/index.ts", "serve"]
```

### 3. Railway Configuration

In the Railway dashboard:

1. Create a new project.
2. Add a **Meilisearch** service from the Railway template library.
3. Add a **custom service** pointing to your repo.
4. Set environment variables:

| Variable | Value |
|----------|-------|
| `ANTHROPIC_API_KEY` | Your API key |
| `RANDAL_API_TOKEN` | A generated secret for API auth |
| `MEILI_MASTER_KEY` | Match the Meilisearch service key |
| `PORT` | `7600` (or let Railway assign) |

5. Set the deploy config to use your Dockerfile.

### 4. Config for Railway

```yaml
name: my-cloud-agent
posse: production
runner:
  defaultAgent: claude-code
  defaultModel: claude-sonnet-4
  workdir: /app/workspace
credentials:
  envFile: ./.env
  allow: [ANTHROPIC_API_KEY]
gateway:
  channels:
    - type: http
      port: 7600
      auth: "${RANDAL_API_TOKEN}"
memory:
  store: meilisearch
  url: http://meilisearch.internal:7700
  apiKey: "${MEILI_MASTER_KEY}"
  index: memory-cloud-agent
  sharing:
    publishTo: shared
    readFrom: [shared]
```

> **Note**: Railway internal networking uses `*.internal` hostnames for service-to-service communication.

### 5. Deploy

```bash
# Via Railway CLI
railway up

# Or push to your connected Git repo for auto-deploy
git push origin main
```

---

## 🔍 Meilisearch Setup

Meilisearch is required for full-text memory search and cross-agent sharing. The file-based store works for single-agent, local use but does not support cross-agent queries.

### 📦 Local Install

```bash
# macOS
brew install meilisearch

# Linux (binary)
curl -L https://install.meilisearch.com | sh

# Docker
docker run -d -p 7700:7700 \
  -e MEILI_MASTER_KEY='your-master-key' \
  -v $(pwd)/meili-data:/meili_data \
  getmeili/meilisearch:latest
```

### ⚙️ Configuration

Randal auto-configures Meilisearch indexes on first connect. It sets:

- **Searchable attributes**: `content`, `category`, `type`, `source`
- **Filterable attributes**: `type`, `category`, `source`, `file`, `timestamp`
- **Sortable attributes**: `timestamp`

No manual index setup is needed. Just provide the URL and API key in your Randal config:

```yaml
memory:
  store: meilisearch
  url: http://localhost:7700
  apiKey: "${MEILI_MASTER_KEY}"
```

### 🤝 Cross-Agent Shared Index

For multiple agents in a posse to share learnings:

```yaml
# Agent A config
memory:
  store: meilisearch
  url: http://localhost:7700
  apiKey: "${MEILI_MASTER_KEY}"
  index: memory-agent-a
  sharing:
    publishTo: shared
    readFrom: [shared]

# Agent B config
memory:
  store: meilisearch
  url: http://localhost:7700
  apiKey: "${MEILI_MASTER_KEY}"
  index: memory-agent-b
  sharing:
    publishTo: shared
    readFrom: [shared]
```

Both agents publish to and read from the `shared` index while maintaining their own private indexes. The shared index is auto-created on first write.

### 🔒 Production Considerations

- Set a strong `MEILI_MASTER_KEY` (used as the admin API key).
- Use persistent storage (`--db-path` or a Docker volume).
- Meilisearch is single-node; for HA, use Meilisearch Cloud.
- Memory is append-only by design. Indexes grow over time. Monitor disk usage.

---

## 🔑 Environment Variables Reference

| Variable | Used By | Description |
|----------|---------|-------------|
| `RANDAL_API_TOKEN` | 📡 Gateway HTTP auth | Bearer token for API authentication. |
| `MEILI_MASTER_KEY` | 🧠 Memory (Meilisearch) | Meilisearch admin API key. |
| `ANTHROPIC_API_KEY` | 🤖 Agent (Claude/OpenCode) | Anthropic API key for model access. |
| `OPENROUTER_API_KEY` | 🤖 Agent / Embedder | OpenRouter API key (if using OpenRouter models). |
| `OPENAI_API_KEY` | 🔌 Embedder | OpenAI API key (if using OpenAI embeddings). |
