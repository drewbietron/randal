<img align="right" src="assets/posse.png" width="200" alt="Randal Has a Posse" />

# Randal

### The composable harness for autonomous AI agent posses.

**Point it at an agent. Give it a config. Let it ride.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Built with Bun](https://img.shields.io/badge/Built_with-Bun-f9f1e1?logo=bun)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-3178c6?logo=typescript&logoColor=white)](https://typescriptlang.org)
[![v0.2](https://img.shields.io/badge/version-0.2-blue)]()

---

<br clear="right"/>

Randal wraps agent CLIs — [OpenCode](https://github.com/nickthecook/opencode), [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://github.com/openai/codex) — in a persistent execution loop and gives them superpowers:

- 🧠 **Memory** — Agents learn, remember, and share context across runs
- ⏰ **Scheduling** — Heartbeats, cron jobs, and webhook triggers keep your agents alive
- 🔐 **Credentials** — Scoped env-var filtering with explicit allowlists. No leaks.
- 📡 **Dashboard** — Real-time web UI with SSE streaming, job tracking, and cost monitoring
- 🤝 **Posse Mode** — Multiple agents, shared memory, coordinated teamwork

> *One agent is useful. A posse is unstoppable.*

---

## ⚡ Quick Start

```bash
curl -fsSL https://raw.githubusercontent.com/your-org/randal/main/install.sh | bash
```

One command. Installs Bun (if needed), clones the repo, links the CLI, runs the setup wizard, and starts Meilisearch if selected.

Or clone and set up manually:

```bash
git clone https://github.com/your-org/randal && cd randal
bash scripts/setup.sh
```

Dashboard at [`http://localhost:7600`](http://localhost:7600). Your agent is live.

---

## 🎬 Three Ways to Run

### 🎯 One-Shot — `randal run`

Fire and forget. Run a single job locally, get the output, exit. No server, no persistence. Perfect for quick tasks.

```bash
randal run "refactor the auth module"
randal run spec.md --agent claude-code --model claude-sonnet-4
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

## 💬 Messaging Channels

Agents are reachable via HTTP, Discord DMs, or iMessage texts. Each channel uses the same prefix commands. Channel-aware routing ensures job notifications only go back to the originating channel. Cross-channel context is seamless via shared memory.

### Discord

```yaml
gateway:
  channels:
    - type: discord
      token: "${DISCORD_BOT_TOKEN}"
      allowFrom: ["123456789012345678"]
```

**Setup:**
1. Create a bot at [discord.com/developers/applications](https://discord.com/developers/applications)
2. Enable **Message Content Intent** under Bot settings
3. Invite the bot to your server with Send Messages, Read Message History, View Channels permissions
4. Set `DISCORD_BOT_TOKEN` in your `.env` file

### iMessage (macOS only)

```yaml
gateway:
  channels:
    - type: imessage
      provider: bluebubbles
      url: "${BLUEBUBBLES_URL}"
      password: "${BLUEBUBBLES_PASSWORD}"
      allowFrom: ["+15551234567"]
```

> **macOS only.** Requires a Mac with Messages.app signed into an Apple ID and [BlueBubbles Server](https://bluebubbles.app) running.

**Setup:**
1. Install BlueBubbles Server on your Mac
2. Configure a webhook pointing to `http://<host>:<port>/webhooks/imessage`
3. Set `BLUEBUBBLES_URL`, `BLUEBUBBLES_PASSWORD`, and `APPLE_ID` in your `.env` file

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

Full setup instructions: [📖 docs/deployment-guide.md](docs/deployment-guide.md)

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
| `randal cron list\|add\|remove` | 📅 Cron job management |
| `randal heartbeat status\|trigger` | 💓 Heartbeat control |

Full reference: [📖 docs/cli-reference.md](docs/cli-reference.md)

---

## 🚀 Deploy Anywhere

<details>
<summary>🍎 <strong>Local Mac</strong></summary>

```bash
curl -fsSL https://raw.githubusercontent.com/your-org/randal/main/install.sh | bash
```

The installer handles Bun, dependencies, CLI registration, Meilisearch, and runs the setup wizard.

To start fresh: `randal reset && randal init`

See [`examples/local-mac/`](examples/local-mac/) for a full-featured local setup with heartbeat, cron, and active hours.

</details>

<details>
<summary>🚂 <strong>Railway (Cloud)</strong></summary>

```bash
cp examples/cloud-railway/* .
# Edit randal.config.yaml for your deployment
railway up
```

See [`examples/cloud-railway/`](examples/cloud-railway/) for Dockerfile and `railway.toml`.

</details>

<details>
<summary>🐳 <strong>Docker Compose</strong></summary>

```bash
docker compose up
```

One command. Includes Randal + Meilisearch. Mount your config:

```bash
# docker-compose.yml is included at the repo root
# Just create randal.config.yaml and .env, then:
docker compose up --build
```

</details>

---

## 📦 Programmatic Usage

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
                                      │  │  - iMessage    │  │
┌──────────┐                          │  └───────┬────────┘  │
│ 📱 iMessage── BB webhook ──────────▶│          │           │
│          │◀── BB REST ──────────────│  ┌───────┴────────┐  │
└──────────┘                          │  │  🔀 EventBus   │  │
                                      │  │  📂 Job Persist│  │
                                      │  └───────┬────────┘  │
                                      └──────────┼───────────┘
                                                 │
                                   ┌─────────────┴─────────────┐
                                   ▼                           ▼
                          ┌──────────────────┐        ┌──────────────────┐
                          │    🎯 Runner     │        │   ⏰ Scheduler   │
                          │  - Ralph Loop    │        │  - Heartbeat     │
                          │  - Adapters      │        │  - Cron          │
                          │  - Sentinel      │        │  - Hooks         │
                          │  - Struggle Det. │        │  (webhooks)      │
                          └───┬──────────┬───┘        └──────────────────┘
                              │          │
                     ┌────────┘          └────────┐
                     ▼                            ▼
               ┌──────────────────┐      ┌──────────────────┐
               │  🔐 Credentials  │      │    🧠 Memory     │
               │ - .env parsing   │      │ - File / Meili   │
               │ - Allowlist      │      │ - Sync (chokidar)│
               │ - Inheritance    │      │ - Cross-agent    │
               └──────────────────┘      │ - Auto-inject    │
                                         └──────────────────┘
```

9 packages. Clean separation. See [📖 docs/architecture.md](docs/architecture.md) for the full breakdown.

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

---

## 📋 Prerequisites

| Requirement | Notes |
|-------------|-------|
| **Bun** >= 1.1 | Runtime. [Install](https://bun.sh) |
| **Agent CLI** (at least one) | [OpenCode](https://github.com/nickthecook/opencode) · [Claude Code](https://docs.anthropic.com/en/docs/claude-code) · [Codex](https://github.com/openai/codex) |
| **Meilisearch** *(optional)* | Full-text memory search + cross-agent sharing. [Install](https://www.meilisearch.com/docs/learn/getting_started/installation) |

---

## 📖 Documentation

| Doc | What's Inside |
|-----|--------------|
| [Architecture](docs/architecture.md) | System design, package map, data flow diagrams |
| [CLI Reference](docs/cli-reference.md) | Every command, every flag, HTTP API endpoints |
| [Config Reference](docs/config-reference.md) | All YAML config options with examples |
| [Deployment Guide](docs/deployment-guide.md) | Mac Mini, Railway, Docker, Meilisearch setup |

---

<div align="center">

**MIT License** · Built with 🤠 by the Randal posse

*Saddle up.*

</div>
