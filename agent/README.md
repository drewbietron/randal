# Randal Brain — OpenCode Agent Setup

Randal's brain is a set of agent files and custom tools that run inside [OpenCode](https://opencode.ai). This directory contains everything needed to make OpenCode's TUI your direct interface to Randal — no harness required.

## Quick Start

```bash
cd ~/dev/randal
bash agent/setup.sh
```

That's it. Restart OpenCode and press Tab — you should see only Randal.

## What Gets Installed

| Component | Source | Destination |
|-----------|--------|-------------|
| `randal.md` (primary agent) | `agent/agents/randal.md` | `~/.config/opencode/agents/randal.md` |
| `plan.md` (planning subagent) | `agent/agents/plan.md` | `~/.config/opencode/agents/plan.md` |
| `build.md` (build subagent) | `agent/agents/build.md` | `~/.config/opencode/agents/build.md` |
| `model-context.ts` (context budget tool) | `agent/tools/model-context.ts` | `~/.config/opencode/tools/model-context.ts` |
| `loop-state.ts` (crash recovery tool) | `agent/tools/loop-state.ts` | `~/.config/opencode/tools/loop-state.ts` |

All files are **symlinked**, not copied. `git pull` updates the repo and symlinks follow automatically.

The setup script also:
- Installs and starts **Meilisearch** for persistent memory
- Configures the **MCP memory server** in OpenCode
- Removes old/conflicting agents (`prd-writer.md`, `prd-gen-template.md`)
- Backs up any existing non-symlink agent files to `.bak`

## Memory Setup (Meilisearch)

Meilisearch provides persistent memory across sessions. Randal can remember past conversations, decisions, and context.

### Automatic (via setup script)

The setup script handles installation and startup. It tries, in order:

1. **Homebrew**: `brew install meilisearch && brew services start meilisearch`
2. **Docker**: persistent container on port 7700
3. **Manual fallback** with instructions

### Manual Setup

```bash
# Install
brew install meilisearch

# Start as background service
brew services start meilisearch

# Verify
curl http://localhost:7700/health
# → {"status":"available"}
```

### Data Location

- **Homebrew**: managed by `brew services` (typically `~/Library/Application Support/meilisearch/`)
- **Docker**: `~/.randal/meili-data/`
- **Backups**: just copy the data directory

### Optional: Authentication

For local-only use, no auth is needed. To add a master key:

```bash
# Stop the service
brew services stop meilisearch

# Set a master key (save this somewhere)
export MEILI_MASTER_KEY="your-secret-key"

# Start with the key
MEILI_MASTER_KEY="your-secret-key" brew services start meilisearch

# Update your opencode.json MCP config to include the key:
# "env": { "MEILI_URL": "http://localhost:7700", "MEILI_MASTER_KEY": "your-secret-key" }
```

### Optional: Cross-Machine Sharing

Share memory between your laptop and Mac Mini via Tailscale:

```bash
# On your laptop, update the MCP config in opencode.json:
"env": { "MEILI_URL": "http://mac-mini.tailscale:7700" }
```

This lets your TUI sessions on the laptop search memories stored by the harness on the Mac Mini (and vice versa).

### When Meilisearch Stops Working

- **Agent still works** — all core features are independent of memory
- Memory tools return empty results gracefully (no errors, no crashes)
- Restart: `brew services restart meilisearch`
- Check logs: `brew services info meilisearch`
- Docker: `docker restart randal-meilisearch`
- Docker logs: `docker logs randal-meilisearch`

## Updating

```bash
cd ~/dev/randal && git pull
# Symlinks auto-update — no re-setup needed
# Restart OpenCode to pick up changes
```

Only re-run `bash agent/setup.sh` if:
- You cloned to a new machine
- New tool files were added to `agent/tools/`
- The setup script itself was updated with new config steps

## How It Works

```
~/dev/randal/agent/                    ~/.config/opencode/
├── agents/                            ├── agents/
│   ├── randal.md  ←─────symlink──────→│   ├── randal.md
│   ├── plan.md    ←─────symlink──────→│   ├── plan.md
│   └── build.md   ←─────symlink──────→│   └── build.md
└── tools/                             └── tools/
    ├── model-context.ts ←─symlink────→    ├── model-context.ts
    └── loop-state.ts    ←─symlink────→    └── loop-state.ts
```

- Agent files live in `~/dev/randal/agent/` (version controlled)
- Symlinks point `~/.config/opencode/` → repo files
- `git pull` updates the repo, symlinks follow automatically
- `opencode.json` stays local (machine-specific API keys, MCP config)

## Troubleshooting

### Tab shows multiple agents

Check that `opencode.json` has built-in agents disabled:

```json
{
  "agent": {
    "build": { "disable": true },
    "plan": { "disable": true }
  }
}
```

### Memory not working

```bash
# Check if Meilisearch is running
curl http://localhost:7700/health

# Restart
brew services restart meilisearch
# or
docker restart randal-meilisearch
```

### Agent not loading

Check that symlinks are in place:

```bash
ls -la ~/.config/opencode/agents/
# Should show → arrows pointing to ~/dev/randal/agent/agents/

ls -la ~/.config/opencode/tools/
# Should show → arrows pointing to ~/dev/randal/agent/tools/
```

If symlinks are broken (e.g., repo was moved), re-run `bash agent/setup.sh`.

### Old agents still showing

Run `bash agent/setup.sh` again — it removes `prd-writer.md` and `prd-gen-template.md` from the agents directory.

### Tools not available

Check for symlinks:

```bash
ls -la ~/.config/opencode/tools/
# Should show model-context.ts and loop-state.ts symlinks
```

Verify the tool files exist in the repo:

```bash
ls agent/tools/
# Should show model-context.ts and loop-state.ts
```
