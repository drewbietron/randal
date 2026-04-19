<img align="right" src="assets/posse.png" width="200" alt="Randal Has a Posse" />

# Randal

### The composable harness for autonomous AI agent posses.

**Point it at an agent. Give it a config. Let it ride.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Built with Bun](https://img.shields.io/badge/Built_with-Bun-f9f1e1?logo=bun)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-3178c6?logo=typescript&logoColor=white)](https://typescriptlang.org)
[![v0.1.0](https://img.shields.io/badge/version-0.1.0-blue)]()

---

<br clear="right"/>

Randal wraps [OpenCode](https://github.com/opencode-ai/opencode) (or any agent CLI) in a persistent execution loop and gives it superpowers:

- 🧠 **Memory** — Agents learn, remember, and share context across runs via Meilisearch
- ⏰ **Scheduling** — Heartbeats, cron jobs, and webhook triggers keep your agents alive
- 🔐 **Credentials** — Scoped env-var filtering with explicit allowlists and sandbox enforcement
- 📡 **Dashboard** — Real-time web UI with SSE streaming, job tracking, cost monitoring, and analytics
- 🤝 **Posse Mode** — Multiple agents with shared memory and coordinated teamwork
- 🎙️ **Voice & Video** *(experimental)* — Session management framework for LiveKit + Twilio integration (STT/TTS/SIP scaffolding in place)
- 🌐 **Multi-Instance Mesh** — Distributed orchestration with specialization-based routing across machines
- 📊 **Self-Learning Analytics** — Human annotation feedback loops, reliability scoring, and prompt tuning
- 💬 **Discord Integration** — Threaded conversations, slash commands, interactive buttons, progress tracking, per-server config
- 🌍 **Browser Automation** — Chrome/Chromium control via CDP for web browsing, screenshots, and interaction
- 🔄 **Real-Time Streaming** — Line-by-line agent output with tool use detection and MCP server integration
- 📦 **Context Compaction** — LLM-based summarization when context grows too large
- 🧩 **Skills System** — Discoverable, indexable, cross-agent skill sharing with file watching
- 🔧 **MCP Servers** — Built-in Memory (16 tools), Scheduler (3 tools), and Runner (5 tools) MCP servers
- 🎨 **Image & Video Generation** — Standalone MCP servers for AI-powered image and video creation

> *One agent is useful. A posse is unstoppable.*

---

## ⚡ Quick Start

```bash
curl -fsSL https://raw.githubusercontent.com/drewbietron/randal/main/install.sh | bash
```

One command. Installs Bun (if needed), clones the repo, builds tools (steer, drive), links the CLI, runs the setup wizard, and starts Meilisearch if selected.

Or clone and set up manually:

```bash
git clone https://github.com/drewbietron/randal && cd randal
bun install && bun link
randal init
randal setup
randal serve
```

Dashboard at [`http://localhost:7600`](http://localhost:7600). Your agent is live.

---

## 🎬 Three Ways to Run

### 🎯 One-Shot — `randal run`

Fire and forget. Run a single job locally, get the output, exit. No server, no persistence. Perfect for quick tasks.

```bash
randal run "refactor the auth module"
randal run spec.md --model claude-sonnet-4
```

### 🏗️ Daemon — `randal serve`

Long-lived gateway with HTTP API, SSE event stream, job persistence, memory integration, and a web dashboard. The control tower for your agent operations.

```bash
randal serve
randal serve --port 8080
```

Submit jobs remotely:
```bash
randal send "implement the payment webhook handler"
randal send feature-spec.md --agent opencode
```

### 🤖 Autonomous — Heartbeat + Cron + Hooks

This is where it gets interesting. The scheduler turns Randal from a job executor into a **self-directed autonomous agent**:

| Primitive | What It Does |
|-----------|-------------|
| 💓 **Heartbeat** | Periodic wake-ups. Agent reads a checklist, decides what needs attention. |
| 📅 **Cron** | Precise scheduled tasks. `"At 7am, compile a morning briefing."` |
| 🪝 **Hooks** | External triggers via webhooks. CI pipelines, email watchers, alerts. |

```yaml
heartbeat:
  enabled: true
  every: 30m
  prompt: ./HEARTBEAT.md
  activeHours:
    start: "08:00"
    end: "22:00"

cron:
  jobs:
    morning-briefing:
      schedule: "0 8 * * *"
      prompt: "Review pending tasks. Compile a morning status."
      execution: isolated
      announce: true

hooks:
  enabled: true
  token: "${RANDAL_HOOK_TOKEN}"
```

---

## 🤝 Assemble Your Posse

A **posse** is a named group of Randal instances that coordinate as a team. Each agent has its own identity, persona, and specialization — but they share a brain.

```yaml
# agent-a.config.yaml                    # agent-b.config.yaml
name: scout                              name: builder
identity:                                identity:
  persona: "You find and triage bugs."     persona: "You implement fixes."

memory:                                  memory:
  store: meilisearch                       store: meilisearch
  sharing:                                 sharing:
    publishTo: [posse-shared]                publishTo: [posse-shared]
    readFrom: [posse-shared]                 readFrom: [posse-shared]
```

Scout finds the problems. Builder fixes them. They share context through a unified Meilisearch index. No hand-off meetings required.

See [`examples/multi-agent-posse/`](examples/multi-agent-posse/) for a working two-agent setup.

---

## 🛠️ Configuration

Randal is configured via `randal.config.yaml`. All string values support `${ENV_VAR}` substitution.

```yaml
name: my-agent
runner:
  defaultAgent: opencode
  defaultModel: anthropic/claude-sonnet-4
  workdir: ~/dev/my-project

identity:
  persona: |
    You are a senior engineer who writes clean, tested code.
  rules:
    - "ALWAYS verify your work before marking complete"
    - "Write tests for new functionality"

credentials:
  envFile: ./.env
  allow: [ANTHROPIC_API_KEY]
  inherit: [PATH, HOME, SHELL, TERM]
```

Full reference: [📖 docs/config-reference.md](docs/config-reference.md)

---

## 💬 Discord Integration

Randal's primary messaging interface. Full-featured conversational agent with threads, slash commands, interactive buttons, real-time progress tracking, and per-server configuration.

### Quick Setup

```yaml
gateway:
  channels:
    - type: discord
      token: "${DISCORD_BOT_TOKEN}"
      allowFrom: ["123456789012345678"]
```

1. Create a bot at [discord.com/developers/applications](https://discord.com/developers/applications)
2. Enable **Message Content Intent** under Bot settings
3. Invite the bot with Send Messages, Read Message History, View Channels permissions
4. Set `DISCORD_BOT_TOKEN` in your `.env`

### What You Get

| Feature | Description |
|---------|-------------|
| 💬 **Conversations** | Threaded, multi-turn conversations with full context |
| ⌨️ **Slash Commands** | `/run`, `/status`, `/jobs`, `/stop`, `/resume`, `/memory`, `/dashboard` |
| 🔘 **Interactive Buttons** | Stop, Inject Context, Details, Retry, Resume, Save to Memory |
| 📊 **Progress Tracking** | Edit-in-place status with plan checklist, iteration count |
| 🏢 **Per-Server Config** | Custom commands, agent/model overrides, server-specific instructions |
| 🔄 **Recovery** | Conversations and jobs survive gateway restarts |

### Prefix Commands

| Command | Description |
|---------|-------------|
| `run: <prompt>` | Start a new job |
| `status` / `status: <id>` | Check job status |
| `stop` / `stop: <id>` | Stop a running job |
| `context: <text>` | Inject context into running job |
| `jobs` | List all jobs |
| `memory: <query>` | Search memory |
| `resume: <id>` | Resume a failed job |
| `help` | Show available commands |

Or just send a message without a prefix to start a job (implicit `run:`).

Full reference: [📖 docs/discord-guide.md](docs/discord-guide.md) · Channel adapters: [📖 docs/channel-adapters-guide.md](docs/channel-adapters-guide.md)

---

## 💻 CLI Reference

| Command | Description |
|---------|-------------|
| `randal init` | 🔧 Scaffold config (supports `--wizard`, `--from`, `--yes`) |
| `randal reset` | 🧹 Clean slate — remove config and state (`--all`, `--yes`) |
| `randal run <prompt\|file>` | 🎯 Run agent locally (one-shot) |
| `randal serve` | 🏗️ Start daemon (gateway + runner + scheduler) |
| `randal send <prompt\|file>` | 📨 Submit job to running instance |
| `randal status [job-id]` | 📊 Get job status |
| `randal jobs` | 📋 List all jobs |
| `randal stop <job-id>` | 🛑 Stop a running job |
| `randal context [job-id] <text>` | 💉 Inject context into running job |
| `randal resume <job-id>` | 🔄 Resume a failed job |
| `randal memory search\|list\|add` | 🧠 Memory operations |
| `randal message add\|search\|list\|thread` | 💬 Message history management |
| `randal skills list\|search\|show` | 🧩 Skill management |
| `randal cron list\|add\|remove` | 📅 Cron job management |
| `randal heartbeat status\|trigger` | 💓 Heartbeat control |
| `randal posse` | 🤝 Multi-agent posse management |
| `randal mesh status\|route` | 🌐 Mesh operations |
| `randal analytics scores\|recommendations` | 📊 Analytics and reliability |
| `randal voice status` | 🎙️ Voice session management |
| `randal gateway status\|kill\|restart\|token` | 🏗️ Gateway management |
| `randal audit` | 🔍 Audit ambient host auth (SSH, GitHub, AWS, etc.) |
| `randal setup` | 🔩 Generate opencode.json and configure runtime |
| `randal doctor` | 🩺 Validate deployment (config, MCP, symlinks) |
| `randal update` | ⬆️ Self-update (`--check`, `--pin`, `--dry-run`) |
| `randal deploy agent\|posse\|env\|list\|delete` | 🚀 Railway deployment |

Full reference: [📖 docs/cli-reference.md](docs/cli-reference.md)

---

## 🚀 Deploy Anywhere

<details>
<summary>🍎 <strong>Local Mac</strong></summary>

```bash
curl -fsSL https://raw.githubusercontent.com/drewbietron/randal/main/install.sh | bash
```

The installer handles Bun, dependencies, CLI registration, Meilisearch, and runs the setup wizard.

To start fresh: `randal reset && randal init`

See [`examples/local-mac/`](examples/local-mac/) for a full-featured local setup with heartbeat, cron, and active hours.

</details>

<details>
<summary>🚂 <strong>Railway (Cloud)</strong></summary>

Deploy a single agent or a full multi-agent posse with the CLI:

```bash
# Single agent
railway login
randal deploy agent

# Multi-agent posse (shared Meilisearch + N agents)
randal deploy posse --name my-team

# Preview without deploying
randal deploy agent --dry-run
```

The official Docker image (`ghcr.io/drewbietron/randal:latest`) bundles Bun, Meilisearch, OpenCode, and Randal. Manage deployed posses with `randal deploy list` and `randal deploy delete <name>`.

See [`examples/cloud-railway/`](examples/cloud-railway/) for config examples and [`docs/deployment-guide.md`](docs/deployment-guide.md) for the full guide.

</details>

<details>
<summary>🐳 <strong>Docker Compose</strong></summary>

```bash
docker compose up --build
```

One command. Meilisearch is bundled in the image. Mount your config:

```bash
# docker-compose.yml is included at the repo root
# Just create randal.config.yaml and .env, then:
docker compose up --build
```

</details>

---

## 📦 Programmatic Usage

Import `@randal/harness` to embed Randal in your own application. This is ideal for adding an AI agent to an existing project and deploying it alongside your own codebase.

```typescript
import { createRandal } from "@randal/harness";

const agent = await createRandal({
  configPath: "./randal.config.yaml",
});

// Submit a job
await agent.runner.execute({
  prompt: "Refactor the auth module",
});

// Or let the heartbeat + cron handle things autonomously.
// The agent is now riding on its own. 🤠

// Clean shutdown
agent.stop();
```

### Importing into an existing project

Extend the official Docker image with your config and files:

```dockerfile
FROM ghcr.io/drewbietron/randal:latest
COPY randal.config.yaml /app/randal.config.yaml
COPY knowledge/ /app/knowledge/
```

The image includes Bun, Meilisearch, OpenCode, and Randal — ready to run. Your Dockerfile controls what ships alongside it: codebase, knowledge files, data. For custom pre-start logic (e.g., database sync), add a `pre-start.sh` that the entrypoint will source automatically.

See [`examples/imported-service/`](examples/imported-service/) for the full pattern and [SECURITY.md](SECURITY.md) for deployment mode guidance.

---

## 🧱 Architecture

<details>
<summary>Click to expand system diagram</summary>

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
                                      │  └───────┬────────┘  │
                                      │          │           │
                                      │  ┌───────┴────────┐  │
                                      │  │  🔀 EventBus   │  │
                                      │  │  📂 Job Persist│  │
                                      │  └───────┬────────┘  │
                                      └──────────┼───────────┘
                                                 │
                                   ┌─────────────┴─────────────┐
                                   ▼                           ▼
                          ┌──────────────────┐        ┌──────────────────┐
                          │    🎯 Runner     │        │   ⏰ Scheduler   │
                          │  - Agent Loop    │        │  - Heartbeat     │
                          │  - Adapters      │        │  - Cron          │
                          │  - MCP Server    │        │  - Hooks         │
                          │  - Sentinel      │        │  (webhooks)      │
                          │  - Struggle Det. │        └──────────────────┘
                          │  - Browser (CDP) │
                          │  - Compaction    │
                          └───┬──────────┬───┘
                              │          │
                     ┌────────┘          └────────┐
                     ▼                            ▼
               ┌──────────────────┐      ┌──────────────────┐
               │  🔐 Credentials  │      │    🧠 Memory     │
               │ - .env parsing   │      │ - Meilisearch    │
               │ - Allowlist      │      │ - Cross-agent    │
               │ - Services       │      │ - Auto-inject    │
               │ - Sandbox        │      │ - Posse sharing  │
               │ - Ambient audit  │      │ - Embeddings     │
               └──────────────────┘      │ - Skills         │
                                         └──────────────────┘
        ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
        │  🌐 Mesh         │  │  📊 Analytics    │  │  🎙️ Voice       │
        │ - Registry       │  │ - Annotations    │  │ - LiveKit        │
        │ - Discovery      │  │ - Reliability    │  │ - Twilio         │
        │ - Routing        │  │ - Feedback       │  │ - STT/TTS        │
        │ - Health         │  │ - Recommendations│  │  (experimental)  │
        └──────────────────┘  └──────────────────┘  └──────────────────┘
```

12 packages. Clean separation. See [📖 docs/architecture.md](docs/architecture.md) for the full breakdown.

</details>

---

## 📁 Examples

| Example | What You Get |
|---------|-------------|
| [`examples/minimal/`](examples/minimal/) | 🏁 Absolute minimum config — 2 fields, up and running |
| [`examples/local-mac/`](examples/local-mac/) | 🍎 Full local macOS setup with heartbeat, cron, active hours |
| [`examples/cloud-railway/`](examples/cloud-railway/) | 🚂 Railway deployment with Dockerfile |
| [`examples/multi-agent-posse/`](examples/multi-agent-posse/) | 🤝 Two agents sharing memory — the posse in action |
| [`examples/customer-support/`](examples/customer-support/) | 🎧 Identity, knowledge base, cron jobs, webhook hooks |
| [`examples/imported-service/`](examples/imported-service/) | 📦 Import Randal as a dependency in your own app |
| [`examples/multi-instance-mesh/`](examples/multi-instance-mesh/) | 🌐 Multi-machine mesh with specialization-based routing |
| [`examples/full-platform/`](examples/full-platform/) | 🏢 Full platform config with all features enabled |
| [`examples/voice-enabled/`](examples/voice-enabled/) | 🎙️ Voice/video integration with LiveKit + Twilio |
| [`examples/browser-voice/`](examples/browser-voice/) | 🎙️ Browser-only voice with no Twilio dependency |
| [`examples/prompt-layers/`](examples/prompt-layers/) | 📝 Identity, knowledge, rules, and layered prompt composition |
| [`examples/analytics-driven/`](examples/analytics-driven/) | 📊 Self-learning loop with annotation feedback |

---

## 📋 Prerequisites

| Requirement | Notes |
|-------------|-------|
| **Bun** >= 1.1 | Runtime. [Install](https://bun.sh) |
| **Agent CLI** | [OpenCode](https://github.com/opencode-ai/opencode) (default adapter) or any compatible agent CLI |
| **Meilisearch** *(optional)* | Full-text memory search + cross-agent sharing. [Install](https://www.meilisearch.com/docs/learn/getting_started/installation) |
| **Chromium** *(optional)* | For browser automation via CDP. Bundled in Docker image. |
| **Python 3.11+** *(optional)* | For `drive` terminal automation tool. |
| **Swift** *(optional, macOS)* | For `steer` GUI automation tool. |

---

## 📖 Documentation

| Doc | What's Inside |
|-----|--------------|
| [Architecture](docs/architecture.md) | System design, package map, data flow diagrams |
| [CLI Reference](docs/cli-reference.md) | Every command, every flag, HTTP API endpoints |
| [Config Reference](docs/config-reference.md) | All YAML config options with examples |
| [Deployment Guide](docs/deployment-guide.md) | Mac Mini, Railway, Docker, Meilisearch setup |
| [Discord Integration Guide](docs/discord-guide.md) | Full Discord setup, slash commands, buttons, per-server config |
| [Channel Adapters Guide](docs/channel-adapters-guide.md) | HTTP API, channel overview, custom channel development |
| [Voice & Video Guide](docs/voice-video-guide.md) | LiveKit, Twilio, STT/TTS integration |
| [Mesh Guide](docs/mesh-guide.md) | Multi-instance deployment, routing, discovery |
| [Browser Automation Guide](docs/browser-automation-guide.md) | CDP setup, screenshots, web interaction |
| [Analytics Guide](docs/analytics-guide.md) | Annotations, reliability scoring, feedback loops |
| [Security Model](SECURITY.md) | Deployment modes, sandbox enforcement, isolation boundaries |

---

<div align="center">

**MIT License** · Built with 🤠 by the Randal posse

*Saddle up.*

<!-- Workflow test: git operations verified on 2026-04-15 -->

</div>
