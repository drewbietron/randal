# 🚀 Deployment Guide

Randal runs anywhere Bun runs. This guide covers three deployment patterns: a local Mac Mini, Railway (cloud), and importing Randal as a library into an existing project.

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

### 1. Install

```bash
curl -fsSL https://raw.githubusercontent.com/your-org/randal/main/install.sh | bash
```

This single command:
- Installs Bun (if not present)
- Clones the Randal repo to `~/randal`
- Installs dependencies and links the `randal` CLI
- Runs the interactive setup wizard
- Starts Meilisearch via Docker (if selected and Docker is available)

Or manually:

```bash
git clone <repo-url> ~/randal
cd ~/randal
bash scripts/setup.sh
```

### 2. Configure

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

### 3. Meilisearch

> **Note:** If you used `install.sh` or `scripts/setup.sh`, Meilisearch is already running via Docker with persistent storage at `~/.randal/meili-data/`.

To manage manually:

```bash
# Start via Docker (recommended — data persists at ~/.randal/meili-data/)
docker run -d --name randal-meilisearch --restart unless-stopped \
  -p 7700:7700 \
  -v ~/.randal/meili-data:/meili_data \
  -e MEILI_MASTER_KEY="${MEILI_MASTER_KEY}" \
  getmeili/meilisearch:v1.12

# Or via Homebrew (use --db-path for persistence)
meilisearch --master-key="${MEILI_MASTER_KEY}" --db-path ~/.randal/meili-data
```

### 4. Start Randal

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

### 5. Verify

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

## 📦 Importing Randal as a Library

You can embed Randal into an existing application by importing `@randal/harness` programmatically. This is ideal for adding an AI agent to a project that already has its own Dockerfile, deployment pipeline, and codebase.

### How It Works

1. Your Dockerfile clones Randal into the image
2. Your `package.json` references `@randal/harness` as a `file:` dependency pointing to the cloned Randal
3. Your TypeScript entry point calls `createRandal()` to boot the engine
4. You ship whatever files your agent needs (codebase, knowledge, data) in the same image

Randal has no opinion about what ships alongside it. Your Dockerfile controls the contents. Randal just needs its config file and a working directory.

### 1. Project Structure

```
your-project/
  package.json          # depends on @randal/harness
  index.ts              # createRandal() entry point
  randal.config.yaml    # agent configuration
  Dockerfile            # clones Randal, installs agent CLI, copies your code
  knowledge/            # optional: files your agent needs
```

### 2. package.json

```json
{
  "name": "my-agent-service",
  "type": "module",
  "dependencies": {
    "@randal/harness": "file:/opt/randal/packages/harness"
  }
}
```

The `file:` path points to where Randal is cloned in the Docker image. Bun resolves the workspace dependencies automatically.

### 3. Entry Point

```typescript
import { createRandal } from "@randal/harness";

const randal = await createRandal({
  configPath: "./randal.config.yaml",
});

console.log(`Agent "${randal.config.name}" is running`);
```

`createRandal()` boots the full engine: gateway (HTTP server + channels), runner, scheduler, and memory. Options:

| Option | Type | Description |
|--------|------|-------------|
| `configPath` | string | Path to a `randal.config.yaml` file |
| `configYaml` | string | Raw YAML string to parse |
| `config` | object | Inline config object |
| `port` | number | Override the gateway port |
| `skipScheduler` | boolean | Don't start heartbeat/cron/hooks |
| `skipGateway` | boolean | Don't start the HTTP server |
| `memoryStore` | MemoryStore | Custom memory store implementation (advanced) |

### 4. Dockerfile

```dockerfile
FROM oven/bun:1
WORKDIR /app

# Install agent CLI
RUN npm install -g @anthropic-ai/claude-code

# Clone Randal (pin to a tag or commit for reproducibility)
RUN git clone --depth 1 https://github.com/your-org/randal.git /opt/randal
WORKDIR /opt/randal
RUN bun install --frozen-lockfile

# Set up the consumer application
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .

# Ship whatever your agent needs
RUN mkdir -p /app/workspace

EXPOSE 7600
CMD ["bun", "run", "index.ts"]
```

### 5. Security

When importing Randal, the Docker container is the isolation boundary. The agent can only access files and credentials you explicitly ship in the image.

Recommended config for imported usage:

```yaml
sandbox:
  enforcement: env-scrub

runner:
  workdir: /app/workspace
  allowedWorkdirs:
    - /app/workspace

credentials:
  allow: [ANTHROPIC_API_KEY]  # only what the agent needs
```

Randal logs a warning if it detects it's running outside a container with `sandbox.enforcement: "none"`. See [SECURITY.md](../SECURITY.md) for the full security model.

### 6. Custom Memory Store

If you need a memory backend other than Meilisearch or file, you can inject a custom `MemoryStore` implementation:

```typescript
import { createRandal } from "@randal/harness";
import type { MemoryStore } from "@randal/memory";

const myStore: MemoryStore = {
  async init() { /* ... */ },
  async search(query, limit) { /* ... */ },
  async index(doc) { /* ... */ },
  async recent(limit) { /* ... */ },
};

const randal = await createRandal({
  configPath: "./randal.config.yaml",
  memoryStore: myStore,
});
```

The custom store replaces the config-driven default. You own its performance characteristics.

See [`examples/imported-service/`](../examples/imported-service/) for a complete working example.

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
