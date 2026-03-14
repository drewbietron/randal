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

## 💬 Messaging Channels Setup

### Discord Bot Setup

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications) and create a new application.
2. Navigate to **Bot** settings. Click **Reset Token** to generate a bot token. Copy it.
3. Under **Privileged Gateway Intents**, enable **Message Content Intent**.
4. Navigate to **OAuth2 > URL Generator**. Select scopes: `bot`. Select permissions: `Send Messages`, `Read Message History`, `View Channels`.
5. Copy the generated URL and open it in a browser to invite the bot to your server.
6. Add the token to your Randal config and `.env`:

```yaml
gateway:
  channels:
    - type: discord
      token: "${DISCORD_BOT_TOKEN}"
      # allowFrom: ["your-discord-user-id"]
```

```bash
# .env
DISCORD_BOT_TOKEN=your-bot-token-here
```

### BlueBubbles / iMessage Setup (macOS only)

> iMessage (BlueBubbles) is **not available in containerized deployments** (Docker, Railway). It requires a local Mac with Messages.app.

**Prerequisites:**
- A Mac that stays awake (disable sleep, or use `caffeinate`)
- Messages.app signed into an Apple ID with iMessage active
- Set `APPLE_ID` in your `.env` file for reference

**Steps:**

1. Download and install [BlueBubbles Server](https://bluebubbles.app) on your Mac.
2. Open BlueBubbles Server, set a server password, and choose a connection method (local network or Cloudflare/Ngrok for remote access).
3. In BlueBubbles Server settings, add a webhook:
   - URL: `http://<randal-host>:<port>/webhooks/imessage`
   - Events: select at minimum **New Message**
4. Add the iMessage channel to your Randal config:

```yaml
gateway:
  channels:
    - type: imessage
      provider: bluebubbles
      url: "${BLUEBUBBLES_URL}"
      password: "${BLUEBUBBLES_PASSWORD}"
      # allowFrom: ["+15551234567"]
```

5. Set environment variables in your `.env`:

```bash
BLUEBUBBLES_URL=http://localhost:1234
BLUEBUBBLES_PASSWORD=your-server-password
APPLE_ID=your-apple-id@icloud.com
```

6. Start Randal and verify by sending a test iMessage to the Mac's phone number. Send `help` to see available commands.

### Channel Commands Reference

| Command | Example | Description |
|---------|---------|-------------|
| `run: <prompt>` | `run: refactor auth` | Start a new job |
| `status` | `status` | Show all active jobs |
| `status: <id>` | `status: abc1` | Show specific job |
| `stop` | `stop` | Stop most recent job |
| `stop: <id>` | `stop: abc1` | Stop specific job |
| `context: <text>` | `context: focus on tests` | Inject context |
| `jobs` | `jobs` | List all jobs |
| `memory: <query>` | `memory: auth patterns` | Search memory |
| `resume: <id>` | `resume: abc1` | Resume failed job |
| `help` | `help` | Show commands |

Unrecognized messages are treated as implicit `run:` commands.

> **Note for Railway/Docker deployments:** Discord works on all platforms. iMessage (BlueBubbles) is not available in containerized deployments. It requires a local Mac with Messages.app.

---

## 🔑 Environment Variables Reference

| Variable | Used By | Description |
|----------|---------|-------------|
| `RANDAL_API_TOKEN` | 📡 Gateway HTTP auth | Bearer token for API authentication. |
| `MEILI_MASTER_KEY` | 🧠 Memory (Meilisearch) | Meilisearch admin API key. |
| `ANTHROPIC_API_KEY` | 🤖 Agent (Claude/OpenCode) | Anthropic API key for model access. |
| `OPENROUTER_API_KEY` | 🤖 Agent / Embedder | OpenRouter API key (if using OpenRouter models). |
| `OPENAI_API_KEY` | 🔌 Embedder | OpenAI API key (if using OpenAI embeddings). |
| `DISCORD_BOT_TOKEN` | 💬 Discord channel | Discord bot token for the Discord adapter. |
| `BLUEBUBBLES_URL` | 💬 iMessage channel | BlueBubbles server URL (e.g., `http://localhost:1234`). |
| `BLUEBUBBLES_PASSWORD` | 💬 iMessage channel | BlueBubbles server password. |
| `APPLE_ID` | 💬 iMessage channel | Apple ID for iMessage (reference for Messages.app sign-in). |
