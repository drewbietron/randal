# ⚙️ Configuration Reference

Randal is configured via a YAML file. Accepted filenames (checked in order):

1. `randal.config.yaml`
2. `randal.config.yml`
3. `randal.yaml`

Or specify explicitly: `randal --config path/to/config.yaml <command>`

All string values support `${ENV_VAR}` substitution from the process environment. The parsed config is deeply frozen (immutable at runtime).

---

## 📋 Top-Level

| Field | Type | Default | Required | Description |
|-------|------|---------|----------|-------------|
| `name` | string | — | Yes | Instance name. Used for memory index naming and identification. |
| `version` | string | `"0.1"` | No | Config schema version. |
| `posse` | string | — | No | Team/group identifier for multi-agent coordination. |

---

## 🪪 `identity`

Agent identity and knowledge configuration. Defaults to `{}` if omitted.

| Field | Type | Default | Required | Description |
|-------|------|---------|----------|-------------|
| `identity.persona` | string | — | No | Agent persona injected into system prompt. |
| `identity.systemPrompt` | string | — | No | Additional system instructions appended to prompt. |
| `identity.knowledge` | string[] | `[]` | No | Glob patterns for knowledge files. Contents loaded and injected into system prompt. |
| `identity.rules` | string[] | `[]` | No | Rules injected as a numbered list into system prompt. |

---

## 🎯 `runner`

Agent execution configuration. The `runner` section is required.

| Field | Type | Default | Required | Description |
|-------|------|---------|----------|-------------|
| `runner.defaultAgent` | `"opencode"` \| `"claude-code"` \| `"codex"` \| `"mock"` | `"opencode"` | No | Default agent adapter. |
| `runner.defaultModel` | string | `"anthropic/claude-sonnet-4"` | No | Default model identifier passed to the agent CLI. |
| `runner.defaultMaxIterations` | number | `20` | No | Maximum iterations per job before marking as failed. |
| `runner.workdir` | string | — | Yes | Working directory for agent processes. |
| `runner.allowedWorkdirs` | string[] | — | No | Whitelist of allowed working directories. If set, job workdirs are validated against this list. |
| `runner.completionPromise` | string | `"DONE"` | No | Completion marker tag. The runner looks for `<promise>DONE</promise>` in agent output. |
| `runner.struggle.noChangeThreshold` | number | `3` | No | Iterations with no file changes before the agent is considered stuck. |
| `runner.struggle.maxRepeatedErrors` | number | `3` | No | Consecutive non-zero exit codes before the agent is considered stuck. |

---

## 🔐 `credentials`

Environment and secret management. Defaults to `{}` if omitted.

| Field | Type | Default | Required | Description |
|-------|------|---------|----------|-------------|
| `credentials.envFile` | string | `"./.env"` | No | Path to `.env` file (relative to config file). |
| `credentials.allow` | string[] | `[]` | No | Allowlist of variable names to load from the `.env` file. Only listed vars are passed to the agent. |
| `credentials.inherit` | string[] | `["PATH", "HOME", "SHELL", "TERM"]` | No | Environment variables inherited from the parent process. |

---

## 📡 `gateway`

Server and channel configuration. Defaults to `{}` if omitted.

| Field | Type | Default | Required | Description |
|-------|------|---------|----------|-------------|
| `gateway.channels` | Channel[] | `[]` | No | Communication channels. At least one HTTP channel is needed for `randal serve`. |

### 🌐 HTTP Channel

| Field | Type | Default | Required | Description |
|-------|------|---------|----------|-------------|
| `type` | `"http"` | — | Yes | Channel type discriminator. |
| `port` | number | `7600` | No | HTTP server port. |
| `auth` | string | — | Yes | Bearer token for API authentication. Use `${RANDAL_API_TOKEN}` to read from env. |

### 💬 Discord Channel

| Field | Type | Default | Required | Description |
|-------|------|---------|----------|-------------|
| `type` | `"discord"` | — | Yes | Channel type discriminator. |
| `token` | string | — | Yes | Discord bot token. |
| `allowFrom` | string[] | — | No | Discord user/channel allowlist. |

### 💬 iMessage Channel

| Field | Type | Default | Required | Description |
|-------|------|---------|----------|-------------|
| `type` | `"imessage"` | — | Yes | Channel type discriminator. |
| `provider` | `"bluebubbles"` | — | Yes | iMessage bridge provider. |
| `url` | string | — | Yes | BlueBubbles server URL. |
| `password` | string | — | Yes | BlueBubbles password. |
| `allowFrom` | string[] | — | No | Phone number / contact allowlist. |

---

## 🧠 `memory`

Memory system configuration. Defaults to `{}` if omitted.

| Field | Type | Default | Required | Description |
|-------|------|---------|----------|-------------|
| `memory.store` | `"file"` \| `"meilisearch"` | `"file"` | No | Storage backend. |
| `memory.url` | string | — | No | Meilisearch server URL. Required when `store` is `"meilisearch"`. |
| `memory.apiKey` | string | — | No | Meilisearch API key. Required when `store` is `"meilisearch"`. |
| `memory.index` | string | `"memory-{name}"` | No | Meilisearch index name. Falls back to `memory-` + config `name`. |
| `memory.syncInterval` | number | `60` | No | File sync interval in seconds. |
| `memory.files` | string[] | `["MEMORY.md"]` | No | Markdown files to watch for memory entries. |
| `memory.autoInject.enabled` | boolean | `true` | No | Auto-inject relevant memory into agent system prompt. |
| `memory.autoInject.maxResults` | number | `5` | No | Maximum memory results to inject per iteration. |
| `memory.sharing.publishTo` | string | — | No | Shared Meilisearch index name to publish learnings to. |
| `memory.sharing.readFrom` | string[] | `[]` | No | Shared Meilisearch index names to read from. |

### 🔌 Embedder Configuration

Nested under `memory.embedder`. Defaults to `{ type: "builtin" }`.

**Builtin** (default, no configuration needed):

```yaml
memory:
  embedder:
    type: builtin
```

**OpenAI**:

| Field | Type | Default | Required |
|-------|------|---------|----------|
| `type` | `"openai"` | — | Yes |
| `model` | string | `"text-embedding-3-large"` | No |
| `apiKey` | string | — | Yes |

**OpenRouter**:

| Field | Type | Default | Required |
|-------|------|---------|----------|
| `type` | `"openrouter"` | — | Yes |
| `model` | string | — | Yes |
| `apiKey` | string | — | Yes |

**Ollama**:

| Field | Type | Default | Required |
|-------|------|---------|----------|
| `type` | `"ollama"` | — | Yes |
| `model` | string | — | Yes |
| `url` | string | `"http://localhost:11434"` | No |

---

## 🛠️ `tools`

Array of external tool definitions. Defaults to `[]`.

| Field | Type | Default | Required | Description |
|-------|------|---------|----------|-------------|
| `tools[].name` | string | — | Yes | Tool name. |
| `tools[].binary` | string | — | Yes | Executable binary name (must be on PATH). |
| `tools[].skill` | string | — | No | Path to a skill documentation markdown file. |
| `tools[].platforms` | `("darwin" \| "linux" \| "win32")[]` | `["darwin", "linux"]` | No | Platforms where this tool is available. |

---

## 💰 `tracking`

Cost tracking configuration. Defaults to `{}`.

| Field | Type | Default | Required | Description |
|-------|------|---------|----------|-------------|
| `tracking.tokenPricing` | `Record<string, { input: number, output: number }>` | `{}` | No | Per-model token pricing. Keys are model identifiers, values are cost-per-token for input and output. |

---

## 💓 `heartbeat`

The heartbeat is a periodic "check in and use your judgment" primitive. The agent wakes at a configured interval, reads a prompt/checklist, and decides whether anything needs attention.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `heartbeat.enabled` | boolean | `false` | Enable periodic heartbeat. |
| `heartbeat.every` | string | `"30m"` | Interval between ticks. Supports: `"15m"`, `"1h"`, `"2h30m"`. |
| `heartbeat.prompt` | string | `"./HEARTBEAT.md"` | Path to heartbeat prompt file, or inline prompt string. |
| `heartbeat.activeHours.start` | string | — | Start of active window (HH:MM format). |
| `heartbeat.activeHours.end` | string | — | End of active window (HH:MM format). |
| `heartbeat.activeHours.timezone` | string | `"UTC"` | Timezone for active hours. |
| `heartbeat.target` | string | `"none"` | Where to send heartbeat results. |
| `heartbeat.model` | string | — | Override model for heartbeat (use a cheap model like `claude-haiku-4`). |

Example:

```yaml
heartbeat:
  enabled: true
  every: 30m
  prompt: ./HEARTBEAT.md
  activeHours:
    start: "08:00"
    end: "22:00"
    timezone: "America/Denver"
  model: anthropic/claude-haiku-4
```

---

## 📅 `cron`

Precise scheduled tasks with three schedule formats.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `cron.jobs.<name>.schedule` | string \| `{every}` \| `{at}` | — | Cron expression, interval, or one-shot time. |
| `cron.jobs.<name>.prompt` | string | — | The prompt to execute. |
| `cron.jobs.<name>.execution` | `"main"` \| `"isolated"` | `"isolated"` | `main`: queue for next heartbeat. `isolated`: run as standalone job. |
| `cron.jobs.<name>.model` | string | — | Override model for this job. |
| `cron.jobs.<name>.announce` | boolean | `false` | Whether to announce results to channels. |

**Schedule formats:**

- ⏰ **Cron expression**: `"0 7 * * *"` (5-field: minute hour day-of-month month day-of-week)
- 🔄 **Interval**: `{ every: "30m" }` (repeating interval)
- 🎯 **One-shot**: `{ at: "2026-03-15T14:00:00Z" }` (fires once, then marked completed)

Example:

```yaml
cron:
  jobs:
    morning-briefing:
      schedule: "0 8 * * *"
      prompt: "Review pending tasks. Compile a morning status."
      execution: isolated
      announce: true
    periodic-check:
      schedule: { every: "1h" }
      prompt: "Check system health."
      execution: main
    deploy-reminder:
      schedule: { at: "2026-03-15T14:00:00Z" }
      prompt: "Remind the team about the deployment."
      execution: isolated
```

---

## 🪝 `hooks`

External event triggers via HTTP webhooks.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `hooks.enabled` | boolean | `false` | Enable webhook endpoints. |
| `hooks.token` | string | — | Auth token for webhook requests. If not set, hooks are disabled. |
| `hooks.path` | string | `"/hooks"` | URL path prefix for hook endpoints. |

When enabled, two endpoints are mounted:

- `POST /hooks/wake` — Wake the agent with a message. Modes: `"now"` (immediate heartbeat) or `"next-heartbeat"` (queued).
- `POST /hooks/agent` — Submit a job or queue a message. Modes: `"now"` (isolated job) or `"next-heartbeat"` (queued).

All requests require `Authorization: Bearer <token>` or `x-randal-token: <token>`.

Example:

```yaml
hooks:
  enabled: true
  token: "${RANDAL_HOOK_TOKEN}"
```

```bash
# Trigger immediate heartbeat with context
curl -X POST http://localhost:7600/hooks/wake \
  -H "Authorization: Bearer $RANDAL_HOOK_TOKEN" \
  -d '{"text": "New VIP email received", "mode": "now"}'

# Queue for next heartbeat
curl -X POST http://localhost:7600/hooks/wake \
  -H "Authorization: Bearer $RANDAL_HOOK_TOKEN" \
  -d '{"text": "Low priority notification", "mode": "next-heartbeat"}'
```

---

## 📁 Example Configs

### 🏁 Minimal (local one-shot)

```yaml
name: my-agent
runner:
  workdir: ~/dev/my-project
```

### 💻 Personal Dev Agent

```yaml
name: dev-agent
identity:
  persona: "Senior TypeScript engineer"
  rules:
    - "Write tests for all new functions"
    - "Use Biome for formatting"
runner:
  defaultAgent: opencode
  defaultModel: anthropic/claude-sonnet-4
  defaultMaxIterations: 30
  workdir: ~/dev/my-project
credentials:
  envFile: ./.env
  allow: [ANTHROPIC_API_KEY]
gateway:
  channels:
    - type: http
      port: 7600
      auth: "${RANDAL_API_TOKEN}"
memory:
  store: file
  files: [MEMORY.md]
```

### 🏭 Production Agent with Meilisearch

```yaml
name: support-agent
posse: production
identity:
  persona: "Customer support specialist"
  knowledge:
    - ./knowledge/help-center/*.md
    - ./knowledge/faq.md
  rules:
    - "Never delete production data"
    - "Never expose PII"
    - "Always escalate payment issues"
runner:
  defaultAgent: claude-code
  defaultModel: claude-sonnet-4
  workdir: /home/node/workspace
credentials:
  envFile: ./.env
  allow: [ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_AGENT_KEY]
gateway:
  channels:
    - type: http
      port: 7600
      auth: "${RANDAL_API_TOKEN}"
memory:
  store: meilisearch
  url: http://meilisearch.internal:7700
  apiKey: "${MEILI_MASTER_KEY}"
  index: memory-support
  sharing:
    publishTo: shared
    readFrom: [shared]
```

### 🛠️ Multi-Tool Agent

```yaml
name: ops-agent
runner:
  defaultAgent: opencode
  workdir: ~/dev/infra
credentials:
  envFile: ./.env
  allow: [ANTHROPIC_API_KEY, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY]
  inherit: [PATH, HOME, SHELL, TERM, SSH_AUTH_SOCK]
gateway:
  channels:
    - type: http
      port: 7600
      auth: "${RANDAL_API_TOKEN}"
tools:
  - name: terraform
    binary: terraform
    skill: ./skills/terraform.md
    platforms: [darwin, linux]
  - name: kubectl
    binary: kubectl
    platforms: [darwin, linux]
tracking:
  tokenPricing:
    "anthropic/claude-sonnet-4":
      input: 0.000003
      output: 0.000015
```
