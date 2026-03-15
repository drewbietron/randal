FROM oven/bun:1
WORKDIR /app

# Install agent CLI
RUN npm install -g @anthropic-ai/claude-code

# Clone Randal (pinned to a tag or commit for reproducibility)
RUN git clone --depth 1 https://github.com/your-org/randal.git /opt/randal
WORKDIR /opt/randal
RUN bun install --frozen-lockfile

# Set up the consumer application
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .

# Ship whatever files your agent needs — codebase, knowledge, data, etc.
# Examples:
#   COPY ../my-codebase/ /app/workspace/
#   COPY ./knowledge/ /app/knowledge/

RUN mkdir -p /app/workspace

EXPOSE 7600

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:7600/health || exit 1

CMD ["bun", "run", "index.ts"]
