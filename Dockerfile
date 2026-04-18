# Keep Bun version in sync with .github/workflows/ci.yml
FROM oven/bun:1.3.12
WORKDIR /app

# System dependencies (including headless Chromium for agent web browsing)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    chromium \
    && rm -rf /var/lib/apt/lists/*

# Update system packages to fix security vulnerabilities
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI (for PR creation and git operations)
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg 2>/dev/null \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Chromium environment (headless, no-sandbox for container use)
ENV CHROME_BIN="/usr/bin/chromium"
ENV PUPPETEER_EXECUTABLE_PATH="/usr/bin/chromium"
ENV CHROMIUM_FLAGS="--no-sandbox --headless --disable-gpu"

# Install Meilisearch (embedded for agent memory)
# Pin version for reproducible builds — matches install.sh's getmeili/meilisearch:v1.12
# Override at build time: docker build --build-arg MEILISEARCH_VERSION=v1.13.0 .
ARG MEILISEARCH_VERSION=v1.12.0
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) meili_arch="amd64" ;; \
      arm64) meili_arch="aarch64" ;; \
      *) echo "Unsupported arch: $arch" && exit 1 ;; \
    esac; \
    curl -fsSL -o /usr/local/bin/meilisearch \
      "https://github.com/meilisearch/meilisearch/releases/download/${MEILISEARCH_VERSION}/meilisearch-linux-${meili_arch}"; \
    chmod +x /usr/local/bin/meilisearch; \
    meilisearch --version

# Install Claude Code (default agent CLI)
RUN bun install -g @anthropic-ai/claude-code

# Install OpenCode CLI (required agent runtime)
RUN bun add -g opencode-ai

# NOTE: steer (macOS GUI automation) and drive (tmux terminal automation) are
# local-only tools that require macOS/tmux respectively. They are NOT installed
# in the Docker image. The agent brain detects their absence and skips GUI/terminal
# automation features. Install locally with: randal setup

# Copy Randal source and install dependencies
# Must include all workspace members (packages/* and tools/*) referenced in
# package.json so bun's frozen-lockfile check finds them.
COPY package.json bun.lock ./
COPY packages/ packages/
COPY tools/ tools/
RUN bun install --frozen-lockfile

# Copy agent config (agents, skills, lenses, rules, plugins for OpenCode)
# setup.ts resolves this via getRepoRoot()/agent/opencode-config
COPY agent/opencode-config/ agent/opencode-config/

# Create directories (including /app/tools/bin for persistent agent-installed binaries)
RUN mkdir -p /app/meeli-data /app/workspace /app/knowledge /app/tools/bin

# Add /app/tools/bin to PATH so agent-installed binaries are discoverable
ENV PATH="/app/tools/bin:$PATH"

# Copy entrypoint
COPY docker/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Config can be:
#   1. Baked in by consumer: COPY your-config.yaml /app/randal.config.yaml
#   2. Mounted at runtime:  -v ./config.yaml:/app/randal.config.yaml
#   3. Passed via env var:  RANDAL_CONFIG_PATH=/path/to/config.yaml

EXPOSE 7600

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:7600/health || exit 1

# Default config for Railway deployment (can be overridden at runtime)
COPY randal.config.railway.yaml /app/randal.config.yaml

ENTRYPOINT ["/app/entrypoint.sh"]
