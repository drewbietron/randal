---
name: catalog
description: Index of all Randal capability packs. Load this to discover available tools by category, then load the specific skill you need.
---

# Randal Capability Catalog

Load a capability's skill to get its full workflow guide and learn which tools to use.

## Available Capabilities

| Skill | Category | Description | MCP Tools | Required Env |
|---|---|---|---|---|
| `video` | media | Generate images, video clips (text-to-video, image-to-video), stitch clips, compose with Remotion | `video_*` | `OPENROUTER_API_KEY`, `GOOGLE_AI_STUDIO_KEY` |
| `research` | agent | Systematic research workflow for multi-source investigation, synthesis, and documentation | `tavily_*`, `memory_*` | — |
| `planning` | agent | Planning loop phases 1-3: dispatch templates, checkpoint parsing, quick-mode rules | — | — |
| `building` | agent | Build pipeline steps 1-11, dispatch templates, parallel execution, error handling, stall detection | — | — |
| `git-ops` | agent | Branch naming, slug generation, worktree strategy, auto-push, auto-PR, branch consolidation, cleanup | — | `gh` CLI |
| `lenses` | agent | Cognitive lens selection, domain tag mapping, Full-Spectrum Review checklist, dispatch integration | — | — |
| `session-ops` | agent | loop-state.json schema, recovery dashboard, abort/status commands, dual output protocol, cost budgets | — | — |
| `steer` | tool | macOS GUI automation — screenshots, clicking, typing, hotkeys, scrolling, window management, OCR | — | `steer` binary on PATH |
| `drive` | tool | Terminal automation via tmux — session management, command execution, output polling, parallel fanout, process management | — | `drive` binary on PATH, `tmux` |
| `memory` | tool | Persistent memory system — categorized memories stored in Meilisearch, searchable across conversations | — | `memory` MCP server |
| `image-gen` | media | Image generation and analysis — text-to-image, vision analysis, character consistency (CID system) | `image-gen_*` | `OPENROUTER_API_KEY` |

## Categories

- **agent** — Core orchestration skills for Randal's planning, building, and session management workflows
- **tool** — CLI tool and MCP server capability references (steer, drive, memory, image-gen)
- **media** — Video, audio, image, music generation
- **infra** — Deployment, CI/CD, infrastructure (future)
- **data** — Databases, APIs, scraping, ETL (future)
- **design** — UI, mockups, branding, design systems (future)
- **comms** — Email, SMS, Discord, Slack integrations (future)

## How to Use

1. Find the capability you need in the table above
2. Load its skill: `skill("video")` (or whatever the name is)
3. The skill tells you which `{name}_*` MCP tools to use and how to orchestrate them
4. If you're unsure which capability you need, scan the table — the description and MCP tools columns will help

## Adding a New Capability

When creating a new tool capability, add a row to the table above. See the architecture rules (`tool-architecture`) for the full pattern.
