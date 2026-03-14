FROM oven/bun:1 AS base
WORKDIR /app

# Install agent CLI (claude-code in this example)
RUN npm install -g @anthropic-ai/claude-code

# Copy monorepo
COPY package.json bun.lock ./
COPY packages/ packages/
RUN bun install --frozen-lockfile

# Copy deployment config
ARG CONFIG_PATH=./randal.config.yaml
COPY ${CONFIG_PATH} /app/randal.config.yaml

# Create workspace directory
RUN mkdir -p /home/bun/workspace

EXPOSE 7600

CMD ["bun", "run", "packages/cli/src/index.ts", "serve", "--config", "/app/randal.config.yaml"]
