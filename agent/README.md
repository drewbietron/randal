# Randal Brain — OpenCode Agent Setup

Randal's brain is a set of agent files and custom tools that run inside [OpenCode](https://opencode.ai). Everything lives in `agent/opencode-config/` — the setup script symlinks this directory to `~/.config/opencode/`.

## Quick Start

```bash
cd ~/dev/randal
bash agent/setup.sh
```

Restart OpenCode and press Tab — you should see only Randal.

## Architecture

- **Single source of truth**: `agent/opencode-config/` (version-controlled)
- **Setup**: `agent/setup.sh` creates one symlink: `~/.config/opencode → agent/opencode-config/`
- **Updates**: `git pull` updates the repo; the symlink follows automatically
- **Structure**: See [`agent/opencode-config/README.md`](opencode-config/README.md) for the full directory layout

## Memory Setup (Meilisearch)

Meilisearch provides persistent memory across sessions.

### Docker Compose (Recommended)

```bash
bash scripts/meili-start.sh          # start on port 7701
bash scripts/meili-stop.sh           # stop
bash scripts/meili-status.sh         # check status
```

### Homebrew (Alternative)

```bash
brew install meilisearch
brew services start meilisearch      # runs on port 7700
```

### MCP Config — Docker Compose (port 7701):
```json
"memory": {
  "type": "stdio",
  "command": "bun",
  "args": ["run", "~/dev/randal/tools/mcp-memory-server.ts"],
  "env": { "MEILI_URL": "http://localhost:7701" },
  "enabled": true
}
```

Homebrew (port 7700) — change `MEILI_URL` to `http://localhost:7700`.

### Data Location

- **Docker Compose**: `./meili-data/` in the repo
- **Homebrew**: managed by `brew services` (typically `~/Library/Application Support/meilisearch/`)

### Optional: Authentication

For local-only use, no auth is needed. To add a master key, set `MEILI_MASTER_KEY` env var before starting Meilisearch, and add it to your `opencode.json` MCP env.

### Optional: Cross-Machine Sharing

Share memory between machines via Tailscale — point `MEILI_URL` to the remote host (e.g. `http://mac-mini.tailscale:7700`).

## Updating

```bash
cd ~/dev/randal && git pull
# Symlink follows automatically — restart OpenCode to pick up changes
```

Only re-run `bash agent/setup.sh` if:
- You cloned to a new machine
- The setup script itself was updated with new config steps

## Troubleshooting

**Symlink broken or agent not loading:**
```bash
ls -la ~/.config/opencode
# Should be a symlink → .../agent/opencode-config
# If broken, re-run: bash agent/setup.sh
```

**Memory not working:**
```bash
curl http://localhost:7701/health      # Docker Compose
curl http://localhost:7700/health      # Homebrew
# Restart: bash scripts/meili-stop.sh && bash scripts/meili-start.sh
```

**Agent still works without Meilisearch** — all core features are independent of memory. Memory tools return empty results gracefully.
