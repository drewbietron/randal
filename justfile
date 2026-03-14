default:
    @just --list

# Setup (first-time install + init)
setup:
    bun install && just setup-tools && bun run packages/cli/src/index.ts init

# Build steer (macOS only)
build-steer:
    #!/bin/bash
    if [[ "$(uname)" == "Darwin" ]]; then
        cd tools/steer && swift build -c release
        echo "Steer built: tools/steer/.build/release/steer"
        echo "To install: cp tools/steer/.build/release/steer /usr/local/bin/steer"
    else
        echo "Steer is macOS-only, skipping"
    fi

# Install drive (Python CLI)
install-drive:
    #!/bin/bash
    if command -v uv &> /dev/null; then
        cd tools/drive && uv sync && uv pip install -e .
        echo "Drive installed"
    else
        echo "uv not found. Install: curl -LsSf https://astral.sh/uv/install.sh | sh"
    fi

# Setup tools (steer + drive)
setup-tools: build-steer install-drive
    @echo "Tools setup complete"

# Start the daemon
start:
    bun run packages/cli/src/index.ts serve

# Start in development mode (verbose logging)
dev:
    bun run packages/cli/src/index.ts serve --verbose

# Run a one-shot job
run prompt:
    bun run packages/cli/src/index.ts run "{{prompt}}"

# Docker: build and start with docker-compose
docker-up:
    docker compose up --build -d

# Docker: stop
docker-down:
    docker compose down

# Run all tests
test:
    bun test

# Run unit tests only
test-unit:
    bun test packages/

# Run integration tests
test-integration:
    bun test tests/integration/

# Run e2e tests
test-e2e:
    bun test tests/e2e/

# TypeScript type checking
typecheck:
    bunx tsc --noEmit

# Lint with Biome
lint:
    bunx biome check .

# Run typecheck + lint + tests
check:
    just typecheck && just lint && just test

# Format code
fmt:
    bunx biome format --write .
