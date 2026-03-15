# Security Model

Randal spawns autonomous AI agents as subprocesses. Those agents can read and write files, run commands, and interact with external services. Understanding the security model is critical before deploying Randal in any environment.

---

## Two Deployment Modes

Randal is designed for two distinct deployment patterns with different security expectations.

### Sandbox Mode (Container-Based)

**Use for:** Cloud deployments, imported library usage, production agents, CI/CD agents.

The agent runs inside a Docker container. The container is the isolation boundary — the agent can only access files, tools, and credentials that the consumer explicitly ships in the image.

- The consumer's Dockerfile determines what files, codebases, knowledge, and tools are available
- Randal's `credentials` config controls which env vars the agent subprocess sees within the container
- `runner.allowedWorkdirs` restricts which directories the agent can operate in
- The agent cannot escape the container to access the host machine

This is the recommended mode for any agent that runs unattended or handles sensitive data.

### Desktop Mode (Host-Based)

**Use for:** Local development agents, GUI automation (steer/drive), personal assistants.

The agent runs directly on the developer's machine. It has access to the host filesystem, network, and any credentials accessible to the OS user running Randal.

- Use `sandbox.enforcement: env-scrub` to limit credential exposure in the agent's environment
- The agent intentionally has host access because it needs to interact with GUI applications, take screenshots, control the terminal, etc.
- The developer accepts the risk of running an autonomous agent on their machine

This mode is inherently less secure. The `env-scrub` sandbox provides defense-in-depth but is not true isolation.

---

## What `env-scrub` Does

When `sandbox.enforcement` is set to `"env-scrub"`, Randal applies these restrictions to the agent's subprocess environment:

1. **Environment variable scrubbing** — Variables from `type: "none"` services and disabled `homeAccess` flags are removed from the agent's environment
2. **PATH filtering** — Directories containing blocked binaries are removed from PATH (`mode: "blocklist"`) or only allowed directories are kept (`mode: "allowlist"`)
3. **Home directory isolation** — A temporary HOME directory is created with only permitted config directories symlinked in (controlled by `homeAccess.ssh`, `homeAccess.gitconfig`, `homeAccess.docker`, `homeAccess.aws`)
4. **Config file neutralization** — When home access is restricted, override env vars point config files to `/dev/null` (e.g., `GIT_CONFIG_GLOBAL=/dev/null`, `DOCKER_CONFIG=/dev/null`)

### What `env-scrub` Does NOT Do

- **No filesystem isolation** — The agent process can read/write any file the OS user has access to. There is no chroot, mount namespace, or filesystem sandboxing.
- **No network isolation** — The agent can make any network request.
- **No resource limits** — No CPU, memory, or file descriptor limits are enforced.
- **No kernel-level enforcement** — A determined agent can bypass env-scrub by reading files directly from known paths (e.g., `cat ~/.ssh/id_rsa`).

The `env-scrub` sandbox makes it harder for agents to accidentally discover and use credentials, but it does not prevent a malicious or confused agent from accessing the host filesystem directly.

---

## `runner.allowedWorkdirs`

When set, job working directories are validated against this list before the agent is spawned. A job whose `workdir` is not within one of the allowed directories will be rejected with an error.

```yaml
runner:
  workdir: /app/workspace
  allowedWorkdirs:
    - /app/workspace
    - /app/data
```

Path matching is prefix-based: `/app/workspace` allows `/app/workspace`, `/app/workspace/src`, etc. Paths are resolved to absolute before comparison.

This is particularly useful in sandbox mode to restrict the agent to specific directories within the container.

---

## `credentials.allow` and `credentials.inherit`

These two fields control which environment variables the agent subprocess receives:

- **`credentials.allow`** — Explicit allowlist of variable names to extract from the `.env` file. Only listed variables are passed through. Everything else is dropped.
- **`credentials.inherit`** — Explicit allowlist of variable names to inherit from the parent (Randal daemon) process. Defaults to `PATH`, `HOME`, `SHELL`, `TERM`.

When combined with `env-scrub`, the agent subprocess receives only the variables you explicitly allow. No ambient credentials leak through.

---

## Recommendations

### For production / cloud agents

- Run inside a Docker container (sandbox mode)
- Set `sandbox.enforcement: env-scrub` for defense-in-depth within the container
- Set `runner.allowedWorkdirs` to restrict agent filesystem access
- Use `credentials.allow` to explicitly list only required env vars
- Use a minimal base image with only the tools the agent needs

### For local development agents

- Understand that the agent has full host access in desktop mode
- Use `sandbox.enforcement: env-scrub` to reduce accidental credential exposure
- Disable `homeAccess` flags for services the agent doesn't need (SSH, AWS, Docker)
- Consider running your local agent in Docker even for development if it doesn't need GUI access

### For imported library usage

When importing Randal into your application via `@randal/harness`:

- Your Dockerfile controls the isolation boundary
- Clone Randal into your Docker image and reference it as a local dependency
- Ship only the files your agent needs (config, knowledge, codebase)
- The agent can only see what you put in the container

Randal will log a warning at startup if it detects it is running outside a container with `sandbox.enforcement: "none"`.
