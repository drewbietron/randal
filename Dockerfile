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
RUN curl -L https://install.meilisearch.com | sh && \
    mv ./meilisearch /usr/local/bin/meilisearch

# Install Claude Code (default agent CLI)
RUN bun install -g @anthropic-ai/claude-code

# Copy Randal source and install dependencies
# Must include all workspace members (packages/* and tools/*) referenced in
# package.json so bun's frozen-lockfile check finds them.
COPY package.json bun.lock ./
COPY packages/ packages/
COPY tools/ tools/
RUN bun install --frozen-lockfile

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

ENTRYPOINT ["/app/entrypoint.sh"]
