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

Railway provides a simple container hosting platform. The official Randal Docker image bundles everything — Bun, Meilisearch, Claude Code, and Randal — so you only need a single service.

### 1. Project Structure

Create a deployment directory with:

```
my-deployment/
  randal.config.yaml
  Dockerfile
  railway.toml
```

### 2. Dockerfile

```dockerfile
FROM ghcr.io/drewbietron/randal:latest

# Copy your config
COPY randal.config.yaml /app/randal.config.yaml

# Copy knowledge files (if any)
# COPY knowledge/ /app/knowledge/
```

The official image includes an embedded Meilisearch instance for agent memory. No separate Meilisearch service is needed.

### 3. Railway Configuration

In the Railway dashboard:

1. Create a new project.
2. Add a **custom service** pointing to your repo.
3. Set environment variables:

| Variable | Value |
|----------|-------|
| `ANTHROPIC_API_KEY` | Your API key |
| `RANDAL_API_TOKEN` | A generated secret for API auth |
| `MEILI_MASTER_KEY` | A generated secret for the embedded Meilisearch |

4. Set the deploy config to use your Dockerfile.

### 4. Config for Railway

```yaml
name: my-cloud-agent
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
  url: http://127.0.0.1:7700
  apiKey: "${MEILI_MASTER_KEY}"
  index: memory-cloud-agent
```

> **Note**: The embedded Meilisearch binds to `127.0.0.1:7700` inside the container. For an external Meilisearch instance, set `RANDAL_SKIP_MEILISEARCH=true` and point the URL to your Meilisearch service.

### 5. Deploy

```bash
# Via Railway CLI
railway up

# Or push to your connected Git repo for auto-deploy
git push origin main
```

---

## 📦 Importing Randal into an Existing Project

You can add a Randal agent to an existing project by extending the official Docker image. This is ideal for adding an AI agent alongside your own codebase, knowledge base, or application.

### How It Works

1. Your Dockerfile extends `ghcr.io/drewbietron/randal:latest` (includes Bun, Meilisearch, Claude Code, Randal)
2. You copy your `randal.config.yaml` into the image
3. You ship whatever files your agent needs (codebase, knowledge, data)
4. The official entrypoint handles Meilisearch startup and `randal serve`
5. For custom pre-start logic, add a `pre-start.sh` hook

### 1. Project Structure

```
your-project/
  randal.config.yaml    # agent configuration
  Dockerfile            # extends the official Randal image
  knowledge/            # optional: files your agent needs
  pre-start.sh          # optional: custom startup logic
```

### 2. Dockerfile

```dockerfile
FROM ghcr.io/drewbietron/randal:latest

# Copy your config
COPY randal.config.yaml /app/randal.config.yaml

# Ship whatever your agent needs
COPY knowledge/ /app/knowledge/

# Optional: custom pre-start logic (e.g., DB sync)
# COPY pre-start.sh /app/pre-start.sh
```

The official image handles everything else — Meilisearch starts automatically, Randal serves on port 7600.

### 3. Pre-Start Hook

If you need custom logic before Randal starts (database sync, file setup, etc.), create a `pre-start.sh`. The Randal entrypoint sources this automatically:

```bash
#!/bin/bash
# pre-start.sh — runs before Randal starts

echo "Pulling data from my database..."
bun /app/scripts/sync-data.mjs || echo "Sync failed, continuing"
```

### 4. Security

The Docker container is the isolation boundary. Recommended config for imported usage:

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

See [SECURITY.md](../SECURITY.md) for the full security model.

### 5. External Meilisearch (Optional)

By default, the official image runs an embedded Meilisearch instance at `127.0.0.1:7700`. If you want to use an external Meilisearch instance instead:

1. Set `RANDAL_SKIP_MEILISEARCH=true` to skip the embedded instance
2. Point `memory.url` in your config to the external instance

### 6. Programmatic Usage (Advanced)

For full programmatic control, override the CMD to run your own entry point:

```dockerfile
FROM ghcr.io/drewbietron/randal:latest
COPY randal.config.yaml /app/randal.config.yaml
COPY index.ts /app/index.ts
CMD ["bun", "run", "/app/index.ts"]
```

```typescript
import { createRandal } from "@randal/harness";

const randal = await createRandal({
  configPath: "./randal.config.yaml",
});
```

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
