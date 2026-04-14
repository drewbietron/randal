# 💻 CLI Reference

```
🤠 randal — agent harness v0.2
```

---

## 🎬 Two Modes

Randal operates in two modes with different execution models:

**🎯 `randal run`** — Local one-shot. Creates a Runner directly, prints to stdout, blocks until done, exits. No server, no persistence, no dashboard.

**🏗️ `randal serve`** — Daemon. Starts an HTTP server with REST API, SSE event stream, job persistence (`~/.randal/jobs/`), memory integration, and a web dashboard. Jobs run in the background.

All other commands (`send`, `status`, `jobs`, `stop`, `context`, `resume`, `memory`) communicate with a running daemon via HTTP.

---

## 🌐 Global Options

| Flag | Type | Description |
|------|------|-------------|
| `--config <path>` | string | Path to config file. If omitted, searches for `randal.config.yaml`, `randal.config.yml`, or `randal.yaml` in the current directory. |
| `--url <url>` | string | Remote server URL. Default: `http://localhost:7600`. Used by remote commands (`send`, `status`, etc.). |
| `--version`, `-v` | flag | Print version and exit. |
| `--help`, `-h` | flag | Print help and exit. |

---

## 📋 Commands

### 🔧 `randal init`

Scaffold a `randal.config.yaml` in the current directory. Features an interactive onboarding wizard with environment auto-detection.

```bash
randal init              # Interactive — QuickStart or Advanced
randal init --wizard     # Jump straight to Advanced wizard
randal init --yes        # Non-interactive — auto-detect + defaults
randal init --from <path> # Bootstrap from existing config
```

See [Init Modes](#-init-modes) for details on each mode.

---

### 🧹 `randal reset`

Clear all Randal config and state. Returns to a fresh state ready for `randal init`.

```bash
randal reset          # Remove config + job/cron state (preserves .env and memory data)
randal reset --all    # Full wipe: config, .env, jobs, cron, Meilisearch data + container
randal reset --yes    # Skip confirmation prompts
```

| Flag | Description |
|------|-------------|
| `--all` | Also removes `.env` (with confirmation), stops `randal-meilisearch` Docker container, clears `~/.randal/meili-data/` |
| `--yes` | Skip all confirmation prompts (for scripting). Combinable with `--all`. |

**Default reset removes:**
- `randal.config.yaml` in current directory
- `~/.randal/jobs/` (all persisted job files)
- `~/.randal/cron.yaml` (cron scheduler state)

**Default reset preserves:**
- `.env` (contains your API keys)
- `~/.randal/meili-data/` (Meilisearch indexes and memory data)

---

### 🎯 `randal run <prompt|file>`

Run an agent locally in one-shot mode. If the argument is a path to an existing `.md` file, its contents are used as the prompt.

```bash
randal run "refactor the auth module"
randal run spec.md
randal run "fix tests" --max-iterations 10
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--agent` | string | Config `runner.defaultAgent` (`opencode`) | Agent adapter name. |
| `--model` | string | Config `runner.defaultModel` (`anthropic/claude-sonnet-4`) | Model identifier. |
| `--max-iterations` | number | Config `runner.defaultMaxIterations` (`20`) | Maximum iteration count. |
| `--workdir` | string | Config `runner.workdir` | Working directory for the agent process. |
| `--verbose`, `-v` | flag | `false` | Show iteration summaries during execution. |

Exits with code `1` if the job fails.

---

### 🏗️ `randal serve`

Start the daemon: gateway + runner + dashboard.

```bash
randal serve
randal serve --port 8080
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--port` | number | Config HTTP channel port (`7600`) | Override the HTTP server port. |

The server runs until terminated. Dashboard available at the root URL.

---

### 📨 `randal send <prompt|file>`

Submit a job to a running Randal instance via HTTP. If the argument is a path to an existing `.md` file, its contents are used as the prompt.

```bash
randal send "build the new API endpoint"
randal send spec.md --agent opencode
randal send "fix bug" --url http://remote:7600
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--agent` | string | — | Agent override. |
| `--model` | string | — | Model override. |
| `--max-iterations` | number | — | Max iterations override. |
| `--workdir` | string | — | Working directory override. |

Uses `RANDAL_API_TOKEN` environment variable for Bearer authentication.

---

### 📊 `randal status [job-id]`

Get the status of a specific job, or list all running jobs if no ID is given.

```bash
randal status             # List all running jobs
randal status abc12345    # Get details for a specific job
```

---

### 📋 `randal jobs`

List all jobs from the gateway.

```bash
randal jobs
randal jobs --status failed
randal jobs --status complete
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--status` | string | — | Filter by status: `queued`, `running`, `complete`, `failed`, `stopped`. |

---

### 🛑 `randal stop <job-id>`

Stop a running job.

```bash
randal stop abc12345
```

---

### 💉 `randal context [job-id] <text>`

Inject context into a running job. The text is written to a `context.md` file in the job's working directory and picked up at the start of the next iteration.

If no `job-id` is given and exactly one job is running, it targets that job. If multiple jobs are running, an explicit ID is required.

```bash
randal context "focus on the payment module first"    # Single running job
randal context abc12345 "skip the tests for now"      # Explicit job ID
```

---

### 🔄 `randal resume <job-id>`

Resume a failed job. Fetches the job's history, builds a prompt containing prior iteration summaries as context, and submits a new job.

```bash
randal resume abc12345
```

---

### 🧠 `randal memory <subcommand>`

Memory operations. Requires a running daemon (for `search` and `list`) or local config (for `add`).

#### `randal memory search <query>`

Search memory by query.

```bash
randal memory search "database migrations"
randal memory search "auth" --agent my-agent --limit 10
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--agent` | string | — | Filter by agent name. |
| `--category` | string | — | Filter by category. |
| `--limit` | number | — | Maximum results. |

#### `randal memory list`

List recent memories.

```bash
randal memory list
randal memory list --limit 20 --category lesson
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--agent` | string | — | Filter by agent name. |
| `--category` | string | — | Filter by category. |
| `--limit` | number | — | Maximum results. |

#### `randal memory add <content>`

Add a memory entry.

```bash
randal memory add "The deploy script requires Node 20" --category fact
randal memory add "User prefers tabs over spaces" --category preference
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--category` | string | `"fact"` | Memory category: `preference`, `pattern`, `fact`, `lesson`, `escalation`. |
| `--agent` | string | — | Agent name to associate with the memory. |

---

## 🔍 `randal audit`

Detect and report ambient host authentication. Scans for SSH keys, GitHub CLI auth, git credential stores, Google Cloud auth, AWS credentials, Docker registry auth, and npm/bun auth tokens.

```bash
randal audit              # Human-readable report
randal audit --json       # Machine-readable JSON output
```

| Flag | Type | Description |
|------|------|-------------|
| `--json` | flag | Output JSON format instead of human-readable text. |

Does not require a config file. Probes run in subprocesses with short timeouts and are non-destructive (read-only).

---

## 🔩 `randal setup`

Generate `opencode.json` and configure the OpenCode runtime. This command replaces `agent/setup.sh` and is the recommended way to set up a Randal deployment.

```bash
randal setup                  # Generate config, symlink dirs, install plugins
randal setup --dry-run        # Preview what would be generated (no writes)
randal setup --json           # Output raw JSON to stdout (for piping)
randal setup --verbose        # Show detailed MCP wiring and resolution steps
```

| Flag | Type | Description |
|------|------|-------------|
| `--config <path>` | string | Path to `randal.config.yaml`. |
| `--output <dir>` | string | Output directory. Default: `~/.config/opencode/`. |
| `--dry-run` | flag | Print generated `opencode.json` and planned symlinks without writing anything. |
| `--json` | flag | Output raw JSON to stdout for piping to other tools. |
| `--verbose` | flag | Show which MCP servers are included, why, which capabilities were detected, and identity resolution details. |

**What it does:**

1. Reads `randal.config.yaml` (or the file given by `--config`)
2. Compiles `opencode.json` from `opencode.base.json` + config values (MCP servers, tool permissions, capabilities)
3. Writes the generated `opencode.json` to `~/.config/opencode/opencode.json`
4. Symlinks static content (`agents/`, `skills/`, `lenses/`, `tools/`, `rules/`, `plugins/`, `package.json`, `tui.json`) from `agent/opencode-config/` into the output directory
5. Runs `bun install` for plugin dependencies

The command is idempotent — safe to run repeatedly. Existing non-symlink entries are backed up before replacement.

> **Migration from `agent/setup.sh`:** If you previously used `bash agent/setup.sh`, switch to `randal setup`. The old script still works but prints a deprecation warning. See [Deprecation: agent/setup.sh](#deprecation-agentsetupsh) below.

---

## 🩺 `randal doctor`

Validate the current deployment. Runs a series of diagnostic checks and reports pass/fail/warn for each.

```bash
randal doctor                 # Run all checks
randal doctor --config ./my-config.yaml   # Check a specific config
```

| Flag | Type | Description |
|------|------|-------------|
| `--config <path>` | string | Path to `randal.config.yaml`. |
| `--output <dir>` | string | OpenCode config directory to check. Default: `~/.config/opencode/`. |

**Checks performed:**

| Check | What it validates |
|-------|-------------------|
| Config | `randal.config.yaml` parses correctly |
| opencode.json | File exists at `~/.config/opencode/opencode.json` |
| Config freshness | Generated config matches current `randal.config.yaml` (detects stale configs) |
| Identity files | All referenced persona, rules, and knowledge files resolve |
| MCP servers | All MCP server binaries/scripts referenced in `opencode.json` exist on disk |
| Meilisearch | Health check passes (if memory is configured) |
| OpenCode CLI | `opencode` binary is available on PATH |
| Symlinks | Symlinks in `~/.config/opencode/` point to valid targets |

**Exit codes:** `0` if all checks pass, `1` if any check fails.

Example output:

```
  Randal Doctor — deployment validation

  [PASS] Config: randal.config.yaml parses correctly
  [PASS] opencode.json: opencode.json exists at ~/.config/opencode/opencode.json
  [PASS] Config freshness: opencode.json is consistent with current config
  [PASS] Identity files: All identity files resolve (persona, 3 rules)
  [PASS] MCP servers: All MCP server scripts exist (memory, scheduler, tavily)
  [PASS] Meilisearch: Meilisearch is healthy at http://localhost:7700
  [PASS] OpenCode CLI: `opencode` is available on PATH
  [PASS] Symlinks: 8 symlinks OK (agents, skills, lenses, ...)

  Summary: 8 passed, 0 warned, 0 failed
```

---

## ⬆️ `randal update`

Self-update for git-based installs. Fetches latest tags, compares versions, and optionally applies the update.

```bash
randal update              # Fetch, compare, pull if available, reinstall
randal update --check      # Just report if an update is available (exit 0/1)
randal update --pin v0.3.0 # Checkout a specific tag
randal update --dry-run    # Show what would change without applying
```

| Flag | Type | Description |
|------|------|-------------|
| `--check` | flag | Report availability and exit with code 0 (available) or 1 (up to date). |
| `--pin <version>` | string | Checkout a specific tag version. |
| `--dry-run` | flag | Show commits that would be applied without making changes. |

In container mode, reports the available update and suggests rebuilding the image. Does not modify the container filesystem.

Does not require a config file.

---

## 🚀 `randal deploy`

Deploy to Railway. Wraps the Railway deployment scripts with a consistent CLI interface.

```bash
randal deploy agent                                    # Deploy single agent
randal deploy agent --dry-run                          # Preview without deploying
randal deploy posse --name my-team                     # Deploy multi-agent posse
randal deploy posse --name my-team --config posse.yaml # Deploy with custom config
randal deploy env                                      # Set Railway env vars only
randal deploy list                                     # List deployed posses
randal deploy delete my-team                           # Delete a posse
```

### Subcommands

| Subcommand | Description |
|------------|-------------|
| `agent` | Deploy a single Randal agent to Railway. Reads `.env`, sets Railway variables, deploys. |
| `posse --name <name>` | Deploy a multi-agent posse with shared Meilisearch. Requires `--name`. |
| `env` | Set environment variables on Railway from `.env` without deploying. |
| `list` | List all deployed posses (local deployment summaries). |
| `delete <name>` | Delete a deployed posse. Use `--force` to skip confirmation. |

### Agent Options

| Flag | Description |
|------|-------------|
| `--dry-run` | Preview what would be set and deployed without making changes. |

### Posse Options

| Flag | Description |
|------|-------------|
| `--name <name>` | Posse name (required). Used as the Railway project name prefix. |
| `--config <file>` | Path to posse config YAML. Default: `examples/railway-posse/full-company.yaml`. |
| `--dry-run` | Preview without deploying. |

### Prerequisites

- **Railway CLI**: `curl -fsSL https://railway.com/install.sh | sh`
- **Railway auth**: `railway login`
- **`.env` file**: Must exist in project root with API keys
- **Posse only**: `yq` and `jq` must be installed (`brew install yq jq`)

### Examples

```bash
# First-time single agent deploy
railway login
randal deploy agent

# Deploy a 10-agent company
randal deploy posse --name acme-corp --config examples/railway-posse/full-company.yaml

# Update env vars without redeploying
randal deploy env

# Clean up
randal deploy delete acme-corp
```

---

## 📚 Skills Commands

### `randal skills list`

List all available skills (bundled + workspace).

### `randal skills search <query>`

Search skills by name or content.

### `randal skills show <name>`

Display a skill's full documentation.

---

## 📡 HTTP API Endpoints

When running in daemon mode (`randal serve`), the following REST endpoints are available. All endpoints except `GET /` require Bearer token authentication.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | 📡 Dashboard (HTML) |
| `GET` | `/health` | 💚 Health check: `{ status, uptime, version, updateChannel }` |
| `GET` | `/audit` | 🔍 Ambient auth audit report (JSON) |
| `GET` | `/instance` | 🪪 Instance info: name, posse, status, version, capabilities |
| `POST` | `/job` | 📨 Submit job: `{ prompt, specFile?, agent?, model?, maxIterations?, workdir? }` |
| `GET` | `/job/:id` | 📊 Get job details |
| `GET` | `/jobs` | 📋 List jobs. Optional `?status=` filter. |
| `DELETE` | `/job/:id` | 🛑 Stop a running job |
| `POST` | `/job/:id/context` | 💉 Inject context: `{ text }` |
| `GET` | `/events` | 📡 SSE event stream |
| `GET` | `/memory/search` | 🔍 Search memory: `?q=&limit=` |
| `GET` | `/memory/recent` | 🧠 Recent memories: `?limit=` |
| `GET` | `/config` | ⚙️ Sanitized config (credentials redacted) |
| `GET` | `/scheduler` | ⏰ Scheduler status: heartbeat, cron, hooks |
| `POST` | `/heartbeat/trigger` | 💓 Force an immediate heartbeat tick |
| `GET` | `/cron` | 📅 List all cron jobs |
| `POST` | `/cron` | ➕ Add a runtime cron job: `{ name, schedule, prompt, execution? }` |
| `DELETE` | `/cron/:name` | ➖ Remove a cron job |
| `POST` | `/hooks/wake` | 🪝 Wake hook: `{ text, mode }` (requires hook token) |
| `POST` | `/hooks/agent` | 🤖 Agent hook: `{ message, wakeMode?, model? }` (requires hook token) |

---

## 📅 Cron Commands

### `randal cron list`

List all registered cron jobs on a running instance.

```bash
randal cron list
randal cron list --url http://remote:7600
```

### `randal cron add`

Add a runtime cron job.

```bash
randal cron add my-job --schedule "0 8 * * *" --prompt "Morning briefing" --isolated
randal cron add check --schedule 30m --prompt "Check health"
```

| Flag | Type | Description |
|------|------|-------------|
| `--schedule` | string | Cron expression, duration (30m), or ISO datetime |
| `--prompt` | string | The prompt to execute |
| `--isolated` | flag | Use isolated execution (default: main/heartbeat) |
| `--model` | string | Override model |

### `randal cron remove`

Remove a cron job by name.

```bash
randal cron remove my-job
```

---

## 💓 Heartbeat Commands

### `randal heartbeat status`

Show heartbeat state: last tick, next tick, tick count, pending wake items.

```bash
randal heartbeat status
```

### `randal heartbeat trigger`

Force an immediate heartbeat tick (bypasses active hours).

```bash
randal heartbeat trigger
```

---

## 🔧 Init Modes

### `randal init` (default)

Interactive onboarding with environment auto-detection. Presents a choice between **⚡ QuickStart** (3 questions, smart defaults) and **🔧 Advanced** (full wizard walking through every config section).

Auto-detects:
- 🖥️ Platform (macOS / Linux)
- 🔌 Installed agent CLI (opencode)
- 🔍 Running Meilisearch instance

### `randal init --wizard`

Jump straight to the Advanced wizard flow (bypasses QuickStart/Advanced selection).

### `randal init --from <path>`

Bootstrap from an existing config file. Validates, fills gaps with defaults, and writes a merged result.

```bash
randal init --from ~/backups/randal.config.yaml
```

### `randal init --yes`

Non-interactive mode. Uses auto-detected values and all defaults. Useful for Docker builds and CI.

---

## 🌐 Mesh Commands

### `randal mesh status`

Show all instances in the mesh with health, load, specialization, and reliability scores.

```bash
randal mesh status
randal mesh status --url http://remote:7600
```

### `randal mesh route <prompt>`

Dry-run the routing algorithm and show which instance would handle the task and why.

```bash
randal mesh route "build a React component"
```

---

## 📊 Analytics Commands

### `randal analytics scores`

Show reliability scores broken down by agent, model, and domain.

```bash
randal analytics scores
randal analytics scores --url http://remote:7600
```

### `randal analytics recommendations`

Show current actionable recommendations based on annotation patterns.

```bash
randal analytics recommendations
```

---

## 🎙️ Voice Commands

### `randal voice status`

Show active voice sessions with duration and transcript length.

```bash
randal voice status
```

---

## ⚠️ Deprecation: `agent/setup.sh`

The `agent/setup.sh` script is **deprecated** and will be removed in a future version. Use `randal setup` instead.

**Migration:**

```bash
# Old way (deprecated)
bash agent/setup.sh

# New way
randal setup
```

`randal setup` is a superset of `agent/setup.sh` with several improvements:

- **Config-driven**: Generates `opencode.json` from `randal.config.yaml` instead of using hardcoded paths
- **Dynamic MCP wiring**: MCP servers are included based on your `capabilities` and config, not hardcoded
- **Cross-platform**: TypeScript-based, not bash-only
- **Dry-run support**: Preview changes before applying with `--dry-run`
- **Validation companion**: Pair with `randal doctor` to verify your deployment

The old script continues to work but prints a deprecation warning. If the `randal` CLI is available on PATH, it will suggest using `randal setup` instead.
