FROM oven/bun:1 AS base
WORKDIR /app

# Install agent CLIs (configurable via build args)
ARG INSTALL_CLAUDE_CODE=true
ARG INSTALL_OPENCODE=false
RUN if [ "$INSTALL_CLAUDE_CODE" = "true" ]; then npm install -g @anthropic-ai/claude-code; fi
RUN if [ "$INSTALL_OPENCODE" = "true" ]; then npm install -g opencode; fi

# Copy monorepo source
COPY package.json bun.lock ./
COPY packages/ packages/
RUN bun install --frozen-lockfile

# Config can be:
# 1. Baked in at build: COPY your-config.yaml /app/randal.config.yaml
# 2. Mounted at runtime: -v ./config.yaml:/app/randal.config.yaml
# 3. Passed via env var: RANDAL_CONFIG_PATH=/path/to/config.yaml
ARG CONFIG_PATH=""
RUN if [ -n "$CONFIG_PATH" ]; then cp "$CONFIG_PATH" /app/randal.config.yaml; fi

# Create workspace
RUN mkdir -p /home/bun/workspace

EXPOSE 7600

# Health check
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:7600/health || exit 1

CMD ["bun", "run", "packages/cli/src/index.ts", "serve"]
