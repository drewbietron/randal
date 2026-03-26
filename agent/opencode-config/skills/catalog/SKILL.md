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

## Categories

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
