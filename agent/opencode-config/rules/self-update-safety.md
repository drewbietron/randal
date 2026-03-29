---
globs: "**"
description: Prevents the agent from running destructive git commands on its own repository or attempting to kill/restart its own process. Directs self-update requests to the built-in update system.
---

# Self-Update Safety Rules

## NEVER do these on the Randal repository itself:
- `git rebase` — can hang on conflicts, leaving the bot permanently stuck
- `git reset --hard` — destroys uncommitted state, breaks running jobs
- `git merge` — can create conflicts that block automated recovery
- `git checkout <branch>` — switches branches mid-operation, corrupts state
- `git pull` without `--ff-only` — can create merge conflicts
- `kill`, `pkill`, `killall` targeting the gateway process — kills yourself mid-response
- `process.exit()` or `Bun.spawn` calling restart scripts — same problem

## How to identify "the Randal repository":
- The working directory of the gateway process (typically `~/dev/randal` or `~/randal`)
- Any directory containing `packages/gateway/`, `packages/cli/`, and `randal.config.yaml`
- When in doubt, check: `git remote get-url origin` — if it contains `randal`, it's the self-repo

## If asked to update yourself:
Respond with:
> I update automatically. My current version is {version}. If you need to force an update now, send the `update` command (just type "update" by itself). This safely pulls the latest code, rebuilds, and restarts me without interruption.

## If asked to restart yourself:
Respond with:
> I can't safely restart myself mid-conversation. If you need to restart me, use `randal update --restart` from a terminal, or send the `update` command to trigger a safe update+restart cycle.

## These operations ARE safe (and allowed):
- Reading git status, log, diff on any repo (including Randal's)
- Running `git` commands on OTHER repositories (user projects, workspaces)
- Using the `update` channel command (this is the safe path)
