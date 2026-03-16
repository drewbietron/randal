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

## 🔄 Prompt Resolution

All prompt-bearing config fields (`identity.persona`, `identity.systemPrompt`, `identity.rules`, `identity.knowledge`, `heartbeat.prompt`, `cron.jobs.*.prompt`, `tools.*.skill`) support a unified three-layer resolution system. Values are resolved at prompt build time, not at config parse time.

### Resolution Layers

Values are checked in this order:

| Layer | Detection | Behavior |
|-------|-----------|----------|
| **Layer 3: Code Module** | Ends with `.ts` or `.js` | Dynamic import, call `default(ctx)` export, return result string. |
| **Layer 1: File Reference** | Starts with `./` or `/`, or ends with `.md` or `.txt` | Read file, then apply `{{var}}` template interpolation. |
| **Layer 0: Inline Passthrough** | Everything else | Return as-is, no transformation. |

Layer 3 (code module) is checked first, so `./foo.ts` is treated as a code module, not a file reference.

### Template Interpolation (`{{var}}`)

File-loaded content (Layer 1) supports `{{key}}` template interpolation using variables from `identity.vars` plus auto-populated values:

| Variable | Source | Description |
|----------|--------|-------------|
| `name` | `config.name` | Agent instance name |
| `version` | `config.version` | Config schema version |
| `date` | Auto-generated | Current ISO date (e.g., `2026-03-15`) |
| *(user-defined)* | `identity.vars` | Custom key-value pairs from config |

User-defined vars take precedence over auto-populated vars with the same name. Unknown `{{key}}` placeholders are left as-is.

**Important:** `{{var}}` interpolation only applies to file-loaded content (Layer 1). It does **not** apply to code module output (Layer 3) or inline YAML values (Layer 0). Inline YAML values already have `${ENV_VAR}` substitution at config parse time.

### Code Module Contract

Code modules (`.ts`/`.js`) must export a default function:

```typescript
import type { PromptContext } from "@randal/core";

// For string fields (persona, systemPrompt, heartbeat.prompt, etc.)
export default function(ctx: PromptContext): string | Promise<string>;

// For rules arrays, modules may also return string[]
export default function(ctx: PromptContext): string | string[] | Promise<string | string[]>;
```

### `PromptContext` Interface

```typescript
interface PromptContext {
  basePath: string;              // Directory containing randal.config.yaml
  vars?: Record<string, string>; // Template variables (identity.vars + auto-populated)
  configName?: string;           // From config.name
}
```

### Examples

**Inline string (Layer 0):**

```yaml
identity:
  persona: "You are a helpful AI assistant."
```

**File reference with template vars (Layer 1):**

```yaml
identity:
  persona: ./IDENTITY.md
  vars:
    name: my-agent
    company: Acme Corp
```

Where `IDENTITY.md` contains:
```markdown
# {{name}}
You are {{name}}, built by {{company}}.
```

**Code module (Layer 3):**

```yaml
identity:
  systemPrompt: ./instructions.ts
```

Where `instructions.ts` contains:
```typescript
import type { PromptContext } from "@randal/core";

export default function(ctx: PromptContext): string {
  const isWeekend = [0, 6].includes(new Date().getDay());
  return isWeekend
    ? "Focus on maintenance tasks today."
    : "Prioritize active development tasks.";
}
```

**Mixed rules array:**

```yaml
identity:
  rules:
    - "NEVER delete data"
    - ./safety-rules.md
    - ./dynamic-rules.ts
```

File entries are split by newlines into individual rules. Code modules may return `string` (split by newlines) or `string[]`.

---

## 🪪 `identity`

Agent identity and knowledge configuration. Defaults to `{}` if omitted.

| Field | Type | Default | Required | Description |
|-------|------|---------|----------|-------------|
| `identity.persona` | string | — | No | Agent persona injected into system prompt. Supports [prompt resolution](#-prompt-resolution). |
| `identity.systemPrompt` | string | — | No | Additional system instructions appended to prompt. Supports [prompt resolution](#-prompt-resolution). |
| `identity.knowledge` | string[] | `[]` | No | Glob patterns or file paths for knowledge files. Contents loaded and injected into system prompt. Supports [prompt resolution](#-prompt-resolution). |
| `identity.rules` | string[] | `[]` | No | Rules injected as a numbered list into system prompt. Each entry supports [prompt resolution](#-prompt-resolution). File entries are split by newlines into individual rules. |
| `identity.vars` | `Record<string, string>` | `{}` | No | User-defined template variables. Available as `{{key}}` in file-loaded prompts. Auto-populated vars: `name`, `version`, `date`. |

---

## 🎯 `runner`

Agent execution configuration. The `runner` section is required.

| Field | Type | Default | Required | Description |
|-------|------|---------|----------|-------------|
| `runner.defaultAgent` | `"opencode"` \| `"claude-code"` \| `"codex"` \| `"mock"` | `"opencode"` | No | Default agent adapter. |
| `runner.defaultModel` | string | `"anthropic/claude-sonnet-4"` | No | Default model identifier passed to the agent CLI. |
| `runner.defaultMaxIterations` | number | `20` | No | Maximum iterations per job before marking as failed. |
| `runner.workdir` | string | — | Yes | Working directory for agent processes. |
| `runner.allowedWorkdirs` | string[] | — | No | Allowed working directories. If set, job workdirs are validated against this list before the agent is spawned. A job whose workdir is not within one of these directories is rejected with an error. Path matching is prefix-based and paths are resolved to absolute before comparison. Recommended for container-based deployments to restrict agent filesystem access. |
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

## 🔗 `services`

Named external service bindings with declarative credential delivery. Defaults to `{}` if omitted.

Each service is a named entry with a credential delivery mechanism and optional audit logging.

| Field | Type | Default | Required | Description |
|-------|------|---------|----------|-------------|
| `services.<name>.description` | string | — | No | Human-readable purpose of this service. |
| `services.<name>.credentials.type` | `"env"` \| `"file"` \| `"ambient"` \| `"script"` \| `"none"` | — | Yes | Credential delivery mechanism. |
| `services.<name>.audit` | boolean | `false` | No | Log when agent spawns with this service's credentials. |

### Credential Types

**`type: env`** — Inject environment variables directly.

| Field | Type | Description |
|-------|------|-------------|
| `vars` | `Record<string, string>` | Key-value map of env vars to inject. Supports `${ENV_VAR}` substitution. |

**`type: file`** — Copy a credential file and set env vars pointing to it.

| Field | Type | Description |
|-------|------|-------------|
| `file` | string | Source file path (relative to config). |
| `mountAs` | string | Destination path where the file is copied. |
| `vars` | `Record<string, string>` | Env vars to inject (typically pointing to the mounted file). |

**`type: ambient`** — Keep existing host binaries and config dirs available.

| Field | Type | Description |
|-------|------|-------------|
| `binaries` | string[] | Binary names to ensure stay in PATH. |
| `paths` | string[] | Config directories the agent needs access to. |

**`type: script`** — Run a script before each job and capture output as credentials.

| Field | Type | Description |
|-------|------|-------------|
| `command` | string | Script to execute (relative to config). |
| `vars` | `Record<string, string>` | Map of var names. Use `"stdout"` as the value to capture script output. |
| `ttl` | number | Re-run interval in seconds. Cached until expired. |

**`type: none`** — Explicitly block access to a service.

| Field | Type | Description |
|-------|------|-------------|
| `binaries` | string[] | Binary names to strip from PATH. |
| `vars` | string[] | Env var names to remove from the child process environment. |

Example:

```yaml
services:
  github:
    description: "GitHub via provisioned PAT"
    credentials:
      type: env
      vars:
        GH_TOKEN: ${GITHUB_PAT}
        GITHUB_TOKEN: ${GITHUB_PAT}
    audit: true

  gcloud:
    description: "Google Cloud via service account"
    credentials:
      type: file
      file: ./secrets/gcp-sa-key.json
      mountAs: /tmp/gcp-creds.json
      vars:
        GOOGLE_APPLICATION_CREDENTIALS: /tmp/gcp-creds.json

  aws:
    description: "AWS explicitly blocked"
    credentials:
      type: none
      binaries: [aws, aws-vault]
      vars: [AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN]

  internal-api:
    description: "Internal API via rotating token"
    credentials:
      type: script
      command: ./scripts/get-api-token.sh
      vars:
        INTERNAL_API_TOKEN: stdout
      ttl: 3600
```

---

## 🔒 `sandbox`

Process isolation configuration. Controls how aggressively Randal restricts the agent child process environment. Defaults to `{ enforcement: "none" }` (current behavior preserved).

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `sandbox.enforcement` | `"none"` \| `"env-scrub"` | `"none"` | Enforcement level. `none` = no restrictions. `env-scrub` = apply PATH filtering, home access restrictions, and env scrubbing. |
| `sandbox.pathFilter.mode` | `"inherit"` \| `"allowlist"` \| `"blocklist"` | `"inherit"` | How to filter the PATH variable. |
| `sandbox.pathFilter.allow` | string[] | `[]` | PATH prefixes to keep (when mode is `allowlist`). Supports `~` expansion. |
| `sandbox.pathFilter.block` | string[] | `[]` | Binary names whose containing dirs are removed (when mode is `blocklist`). |
| `sandbox.homeAccess.ssh` | boolean | `true` | Allow `~/.ssh` access. When false: sets `GIT_SSH_COMMAND=/bin/false`, unsets `SSH_AUTH_SOCK`. |
| `sandbox.homeAccess.gitconfig` | boolean | `true` | Allow `~/.gitconfig` credential helpers. When false: sets `GIT_CONFIG_GLOBAL=/dev/null`. |
| `sandbox.homeAccess.docker` | boolean | `true` | Allow `~/.docker/config.json`. When false: sets `DOCKER_CONFIG=/dev/null`. |
| `sandbox.homeAccess.aws` | boolean | `true` | Allow `~/.aws`. When false: unsets all `AWS_*` vars, sets null config paths. |

When any `homeAccess` flag is `false`, a temporary HOME directory is created with only the allowed config dirs symlinked in. The temp dir is cleaned up after the job completes.

Example:

```yaml
sandbox:
  enforcement: env-scrub
  pathFilter:
    mode: allowlist
    allow: [/usr/bin, /usr/local/bin, ~/.bun/bin]
  homeAccess:
    ssh: false
    gitconfig: false
    aws: false
```

---

## ⬆️ `updates`

Self-update configuration. Defaults to `{ autoCheck: false, channel: "stable" }`.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `updates.autoCheck` | boolean | `false` | Check for updates on `randal serve` startup. |
| `updates.channel` | `"stable"` \| `"latest"` | `"stable"` | `stable` = follow semver tags. `latest` = follow main HEAD. |

Example:

```yaml
updates:
  autoCheck: true
  channel: stable
```

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
| `allowFrom` | string[] | — | No | Discord user ID allowlist. |

**Setup:** Create a bot at [Discord Developer Portal](https://discord.com/developers/applications). Enable the **Message Content Intent** under Bot settings. The bot needs **Send Messages**, **Read Message History**, and **View Channels** permissions. `allowFrom` uses Discord user IDs (numeric strings like `"123456789012345678"`), not usernames. If `allowFrom` is omitted, the bot accepts all DMs; in guild channels, it only responds when mentioned.

### 💬 iMessage Channel

| Field | Type | Default | Required | Description |
|-------|------|---------|----------|-------------|
| `type` | `"imessage"` | — | Yes | Channel type discriminator. |
| `provider` | `"bluebubbles"` | — | Yes | iMessage bridge provider. |
| `url` | string | — | Yes | BlueBubbles server URL. |
| `password` | string | — | Yes | BlueBubbles password. |
| `allowFrom` | string[] | — | No | Phone number allowlist. |

**Setup:** Requires **macOS 12+** with a Mac that stays awake. Messages.app must be signed into an Apple ID with iMessage active. Install and run [BlueBubbles Server](https://bluebubbles.app). Configure the webhook URL as `http://<host>:<port>/webhooks/imessage`. Set `BLUEBUBBLES_URL`, `BLUEBUBBLES_PASSWORD`, and `APPLE_ID` in your `.env` file. `allowFrom` uses phone numbers (E.164 format recommended, e.g., `"+15551234567"`); numbers are normalized during comparison (spaces, dashes, and parentheses are stripped). **Cannot run in Docker or Railway** — macOS with Messages.app is required.

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
| `tracking.tokenPricing` | `Record<string, { input: number, output: number }>` | `{}` | No | Per-model token pricing in **dollars per million tokens**. Keys are model identifiers. Example: Claude Sonnet at $3/M input, $15/M output → `input: 3.00, output: 15.00`. |

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

### 💬 Personal Assistant with Multi-Channel

```yaml
name: assistant
identity:
  persona: "Personal dev assistant reachable via any channel."
runner:
  defaultAgent: claude-code
  defaultModel: claude-sonnet-4
  workdir: ~/dev
credentials:
  envFile: ./.env
  allow: [ANTHROPIC_API_KEY]
  inherit: [PATH, HOME, SHELL, TERM]
gateway:
  channels:
    - type: http
      port: 7600
      auth: "${RANDAL_API_TOKEN}"
    - type: discord
      token: "${DISCORD_BOT_TOKEN}"
      allowFrom: ["123456789012345678"]
    - type: imessage
      provider: bluebubbles
      url: "${BLUEBUBBLES_URL}"
      password: "${BLUEBUBBLES_PASSWORD}"
      allowFrom: ["+15551234567"]
memory:
  store: meilisearch
  url: http://localhost:7700
  apiKey: "${MEILI_MASTER_KEY}"
  index: memory-assistant
  autoInject:
    enabled: true
    maxResults: 5
```

---

## 🎙️ Voice & Video

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `voice.enabled` | boolean | `false` | Enable voice/video features |
| `voice.livekit.url` | string | `""` | LiveKit server URL |
| `voice.livekit.apiKey` | string | `""` | LiveKit API key |
| `voice.livekit.apiSecret` | string | `""` | LiveKit API secret |
| `voice.twilio.accountSid` | string | `""` | Twilio Account SID |
| `voice.twilio.authToken` | string | `""` | Twilio Auth Token |
| `voice.twilio.phoneNumber` | string | `""` | Twilio phone number |
| `voice.stt.provider` | `"deepgram"` \| `"whisper"` \| `"assemblyai"` | `"deepgram"` | Speech-to-text provider |
| `voice.stt.model` | string | — | STT model name |
| `voice.stt.apiKey` | string | `""` | STT provider API key |
| `voice.tts.provider` | `"elevenlabs"` \| `"cartesia"` \| `"openai"` \| `"edge"` | `"elevenlabs"` | Text-to-speech provider |
| `voice.tts.voice` | string | — | TTS voice ID |
| `voice.tts.apiKey` | string | `""` | TTS provider API key |
| `voice.turnDetection.mode` | `"auto"` \| `"manual"` | `"auto"` | Turn detection mode |
| `voice.video.enabled` | boolean | `false` | Enable video features |
| `voice.video.visionModel` | string | `"gpt-4o"` | Vision model for processing screen shares |
| `voice.video.publishScreen` | boolean | `false` | Publish agent screen as video track |
| `voice.video.recordSessions` | boolean | `false` | Record voice/video sessions |
| `voice.video.recordPath` | string | `"./recordings"` | Path to save recordings |

---

## 🌐 Multi-Instance Mesh

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `mesh.enabled` | boolean | `false` | Enable mesh orchestration |
| `mesh.specialization` | string | — | Instance specialization (e.g., "frontend", "backend") |
| `mesh.endpoint` | string | — | This instance's HTTP endpoint for peer communication |
| `mesh.routingWeights.specialization` | number | `0.4` | Weight for specialization match in routing |
| `mesh.routingWeights.reliability` | number | `0.3` | Weight for reliability score in routing |
| `mesh.routingWeights.load` | number | `0.2` | Weight for current load in routing |
| `mesh.routingWeights.modelMatch` | number | `0.1` | Weight for model availability in routing |

---

## 📊 Analytics & Self-Learning

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `analytics.enabled` | boolean | `false` | Enable analytics engine |
| `analytics.autoAnnotationPrompt` | boolean | `true` | Prompt for annotations after job completion |
| `analytics.feedbackInjection` | boolean | `true` | Inject empirical guidance into system prompts |
| `analytics.recommendationFrequency` | `"daily"` \| `"weekly"` \| `"on-demand"` | `"on-demand"` | How often to generate recommendations |
| `analytics.domainKeywords` | Record<string, string[]> | (see defaults) | Custom keyword-to-domain mapping |
| `analytics.agingHalfLife` | number | `30` | Half-life in days for annotation aging |

---

## 🌍 Browser Automation

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `browser.enabled` | boolean | `false` | Enable browser automation |
| `browser.headless` | boolean | `true` | Run browser in headless mode |
| `browser.profileDir` | string | — | Directory for browser profile persistence |
| `browser.sandbox` | boolean | `false` | Run browser in sandbox container |
| `browser.viewport.width` | number | `1280` | Browser viewport width |
| `browser.viewport.height` | number | `720` | Browser viewport height |
| `browser.timeout` | number | `30000` | Default timeout in milliseconds |

---

## 🔄 Runner Extensions

### MCP Server

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `runner.mcpServer.enabled` | boolean | `false` | Enable MCP server for bidirectional agent communication |
| `runner.mcpServer.port` | number | `7601` | MCP server port |
| `runner.mcpServer.tools` | string[] | `["memory_search", "context", "status", "skills", "annotate"]` | Tools to expose |

### Context Compaction

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `runner.compaction.enabled` | boolean | `false` | Enable context compaction |
| `runner.compaction.threshold` | number | `0.8` | Trigger compaction at this percentage of context window |
| `runner.compaction.model` | string | `"anthropic/claude-haiku-3"` | Model for summarization |
| `runner.compaction.maxSummaryTokens` | number | `2000` | Maximum tokens for compacted summary |

---

## 💬 Expanded Channel Types

### Telegram

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `type` | `"telegram"` | — | Channel type discriminator |
| `token` | string | — | Telegram Bot API token |
| `allowFrom` | string[] | — | Allowed Telegram user IDs |

### Slack

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `type` | `"slack"` | — | Channel type discriminator |
| `botToken` | string | — | Slack Bot token (xoxb-...) |
| `appToken` | string | — | Slack App token (xapp-...) |
| `signingSecret` | string | — | Slack signing secret |
| `allowFrom` | string[] | — | Allowed Slack user IDs |

### Email

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `type` | `"email"` | — | Channel type discriminator |
| `imap.host` | string | — | IMAP server host |
| `imap.port` | number | `993` | IMAP server port |
| `imap.user` | string | — | IMAP username |
| `imap.password` | string | — | IMAP password |
| `imap.tls` | boolean | `true` | Use TLS |
| `smtp.host` | string | — | SMTP server host |
| `smtp.port` | number | `587` | SMTP server port |
| `smtp.user` | string | — | SMTP username |
| `smtp.password` | string | — | SMTP password |
| `smtp.secure` | boolean | `false` | Use secure connection |
| `allowFrom` | string[] | — | Allowed email addresses |

### WhatsApp

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `type` | `"whatsapp"` | — | Channel type discriminator |
| `provider` | `"twilio"` \| `"baileys"` | `"twilio"` | WhatsApp provider |
| `accountSid` | string | — | Twilio Account SID |
| `authToken` | string | — | Twilio Auth Token |
| `phoneNumber` | string | — | WhatsApp phone number |
| `allowFrom` | string[] | — | Allowed phone numbers |

### Signal

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `type` | `"signal"` | — | Channel type discriminator |
| `phoneNumber` | string | — | Signal phone number |
| `signalCliBin` | string | `"signal-cli"` | Path to signal-cli binary |
| `allowFrom` | string[] | — | Allowed phone numbers |

### Voice

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `type` | `"voice"` | — | Channel type discriminator |
| `allowFrom` | string[] | — | Allowed phone numbers / caller IDs |
