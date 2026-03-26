# Tool Architecture Rules

When creating, modifying, or discussing tool capabilities for Randal, follow these rules.

## The Canonical Pattern

Every new capability follows this structure:

```
1 Capability Pack = 1 MCP Server + 1 Skill + 1 Catalog Entry
```

### Directory structure:
```
tools/{name}/
  lib/              <- Implementation modules (TypeScript, Bun)
  mcp-server.ts     <- MCP stdio server entry point
  package.json      <- Package with @modelcontextprotocol/sdk + deps
  README.md         <- Setup and usage docs

agent/opencode-config/
  skills/{name}/SKILL.md    <- Workflow guide (loaded on demand by agent)
  skills/catalog/SKILL.md   <- Add a row to the capability table
  opencode.json              <- Add MCP server block + environment vars
```

### Naming conventions:
- MCP server name in opencode.json: `{name}` (e.g., "video", "audio", "deploy")
- MCP tool names: `{name}_{action}` (e.g., "video_generate_clip", "audio_tts")
- Skill name: matches MCP server name exactly
- Tool glob pattern: `"{name}_*"` for enabling/disabling all tools from a capability

### When to use what:
- **Custom tools** (in `tools/` dir, always in LLM context): ONLY for small, always-needed utilities like `model-context` and `loop-state`. These should be rare — 2-3 max.
- **MCP servers** (capability packs): For any grouping of related tools that share env vars or have 3+ tools. Video, audio, deploy, etc.
- **Skills**: ALWAYS create one for every MCP capability pack. The skill teaches the agent HOW to use the tools together.

### Environment variables:
- **All secrets** (API keys, tokens, passwords) go in the root `.env` file (gitignored)
- In opencode.json MCP `environment` blocks, reference secrets via `{env:VAR_NAME}` substitution (e.g. `"OPENROUTER_API_KEY": "{env:OPENROUTER_API_KEY}"`)
- Non-secret config values (URLs, model names, index names) can remain inline in the environment block
- Never hardcode secret values in opencode.json — it is checked into git
- See `.env.example` for the authoritative list of all environment variables

### Per-agent tool access:
- Disable capability tools globally: add `"{name}_*": false` to `tools` in opencode.json
- Enable for the build agent: add `{name}_*: true` to the `tools:` section in `agents/build.md` frontmatter
- The primary agent (Randal) dispatches work — it doesn't call capability MCP tools directly
- The build agent does the actual work and needs tool access

### Checklist for adding a new capability:
1. [ ] Create `tools/{name}/lib/` with implementation modules
2. [ ] Create `tools/{name}/mcp-server.ts` with MCP tool definitions
3. [ ] Create `tools/{name}/package.json` with `@modelcontextprotocol/sdk` dependency
4. [ ] Create `agent/opencode-config/skills/{name}/SKILL.md` with workflow guide
5. [ ] Add a row to `agent/opencode-config/skills/catalog/SKILL.md`
6. [ ] Add MCP server block to `agent/opencode-config/opencode.json`
7. [ ] Add `"{name}_*": false` to tools section in opencode.json
8. [ ] Add `{name}_*: true` to build.md frontmatter tools section
9. [ ] Run `bun test` in `tools/{name}/` to verify
10. [ ] Update the capability's README.md

### Template: opencode.json MCP block
```json
"{name}": {
  "type": "local",
  "command": ["bun", "run", "/Users/drewbie/dev/randal/tools/{name}/mcp-server.ts"],
  "environment": {
    "SOME_API_KEY": "{env:SOME_API_KEY}",
    "SOME_CONFIG_VALUE": "inline-is-fine-for-non-secrets"
  },
  "enabled": true
}
```
> **Important**: Add any new secret env vars to `.env.example` when adding a capability.
