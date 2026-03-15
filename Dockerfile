FROM oven/bun:1
WORKDIR /app

# System dependencies
RUN apt-get update && apt-get install -y \
    git \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Meilisearch (embedded for agent memory)
RUN curl -L https://install.meilisearch.com | sh && \
    mv ./meilisearch /usr/local/bin/meilisearch

# Install Claude Code (default agent CLI)
RUN npm install -g @anthropic-ai/claude-code

# Copy Randal source and install dependencies
COPY package.json bun.lock ./
COPY packages/ packages/
RUN bun install --frozen-lockfile

# Create directories
RUN mkdir -p /app/meili-data /app/workspace /app/knowledge

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
