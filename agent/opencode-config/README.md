# Randal OpenCode Config

This directory contains the static content for `~/.config/opencode/` — the global OpenCode configuration. `randal setup` generates `opencode.json` from your `randal.config.yaml` and symlinks the static content (agents, skills, lenses, etc.) from this directory into `~/.config/opencode/`.

## Setup

```bash
# Recommended:
randal setup

# Or manually:
ln -sfn ~/dev/randal/agent/opencode-config/* ~/.config/opencode/
cd ~/.config/opencode && bun install
```

> **Note:** `agent/setup.sh` is **deprecated**. Use `randal setup` instead.

## Breaking the symlink (for local experiments)

If you want to experiment with config changes without affecting the repo:

```bash
# 1. Remove the symlink (doesn't delete files — they're in the repo)
rm ~/.config/opencode

# 2. Copy the config to a real directory
cp -r ~/dev/randal/agent/opencode-config ~/.config/opencode

# 3. Now edit freely — changes are local only
```

## Re-linking after experiments

```bash
# 1. Remove your local copy (or back it up)
rm -rf ~/.config/opencode
# OR: mv ~/.config/opencode ~/.config/opencode.experiment

# 2. Re-create the symlink
ln -sfn ~/dev/randal/agent/opencode-config ~/.config/opencode
```

## Directory Structure

```
opencode-config/
  opencode.json         <- MCP servers, plugins, agent config, tool globs
  package.json          <- Plugin dependencies (@opencode-ai/plugin)
  agents/
    randal.md           <- Primary agent (orchestrator)
    build.md            <- Build subagent (implements plans)
    plan.md             <- Plan subagent (writes plans)
  tools/
    model-context.ts    <- Always-on: context window calculator
    loop-state.ts       <- Always-on: build loop persistence
  skills/
    catalog/SKILL.md    <- Index of all capability packs
    video/SKILL.md      <- Video production workflow guide
  rules/
    tool-architecture.md <- Rules for creating new capabilities
  lenses/
    architect.md        <- Backend, infrastructure, security
    crafter.md          <- Frontend, UI, design
    narrator.md         <- Documentation, content
    strategist.md       <- Product, business logic
    auditor.md          <- Security review, QA
    operator.md         <- CI/CD, deployment
    catalyst.md         <- Innovation, brainstorming
    provocateur.md      <- Devil's advocate
    diplomat.md         <- Conflict resolution
```

## Adding a New Capability

See `rules/tool-architecture.md` for the full pattern. Quick version:

1. Create `tools/{name}/` with lib + MCP server
2. Create `skills/{name}/SKILL.md` here
3. Add row to `skills/catalog/SKILL.md`
4. Add MCP block to `opencode.json`
5. Add `"{name}_*": false` to tools in opencode.json
6. Add `{name}_*: true` to `agents/build.md` tools

## API Keys

**All secrets go in the root `.env` file** (gitignored). The `opencode.json` config references them via `{env:VAR_NAME}` substitution:

```json
"video": {
  "type": "local",
  "command": ["bun", "run", ".../tools/video/mcp-server.ts"],
  "environment": {
    "OPENROUTER_API_KEY": "{env:OPENROUTER_API_KEY}",
    "GOOGLE_AI_STUDIO_KEY": "{env:GOOGLE_AI_STUDIO_KEY}"
  }
}
```

> **Never hardcode API keys in opencode.json** — this file is checked into git.
> Non-secret config values (URLs, model names) can stay inline.
> See `.env.example` for the full list of environment variables.
