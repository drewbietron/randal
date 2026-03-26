#!/bin/bash

# cd to repo root regardless of where the script is invoked from
cd "$(dirname "$0")/.."
REPO_DIR="$(pwd)"

echo "=== Randal Setup ==="

# Check for Bun
if ! command -v bun &> /dev/null; then
  echo "Bun not found. Installing..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

echo "Bun: $(bun --version)"

# Install dependencies
echo "Installing dependencies..."
if ! bun install; then
  echo "  ! bun install failed — are you in the randal repo root?"
  exit 1
fi

# Register randal CLI globally
echo "Linking randal CLI..."
bun link || echo "  ! bun link failed (non-fatal, continuing)"

# Build tools
echo ""
echo "Setting up tools..."

# Steer (macOS only)
if [[ "$(uname)" == "Darwin" ]]; then
  echo "Building steer (Swift)..."
  if command -v swift &> /dev/null; then
    (cd tools/steer && swift build -c release) || echo "  ! steer build failed (Xcode CLI Tools required)"
  else
    echo "  - swift not found, skipping steer (run: xcode-select --install)"
  fi
fi

# Drive (Python)
echo "Installing drive..."
if command -v uv &> /dev/null; then
  (cd tools/drive && uv sync && uv pip install -e .) || echo "  ! drive install failed"
else
  echo "  - uv not found, skipping drive (install: curl -LsSf https://astral.sh/uv/install.sh | sh)"
fi

# Check tmux for drive
if ! command -v tmux &> /dev/null; then
  echo "  - tmux not found (drive requires tmux: brew install tmux)"
fi

# Install BlueBubbles on macOS if not present
if [[ "$(uname)" == "Darwin" ]]; then
  if [ ! -d "/Applications/BlueBubbles.app" ]; then
    echo ""
    echo "Installing BlueBubbles Server (iMessage bridge)..."
    if command -v brew &> /dev/null; then
      brew install --cask bluebubbles --no-quarantine 2>/dev/null && \
        echo "  + BlueBubbles Server installed" || \
        echo "  ! BlueBubbles install via Homebrew failed (can be installed during init)"
    else
      echo "  - Homebrew not found — BlueBubbles will be installed during init if needed"
    fi
  else
    echo "  + BlueBubbles Server already installed"
  fi
fi

# Detect agent CLIs
echo ""
echo "Detecting agent CLIs..."
for cli in opencode claude codex; do
  if command -v "$cli" &> /dev/null; then
    echo "  + $cli found"
  else
    echo "  - $cli not found"
  fi
done

# Detect tools
echo ""
echo "Detecting tools..."
for tool in steer drive; do
  if command -v "$tool" &> /dev/null; then
    echo "  + $tool found"
  else
    echo "  - $tool not found"
  fi
done

# Set up the Randal brain (OpenCode agent config)
echo ""
echo "Setting up Randal brain..."
if command -v opencode &> /dev/null; then
  bash "$REPO_DIR/agent/setup.sh" --non-interactive
else
  echo "  - opencode not found, skipping brain setup"
  echo "    Install OpenCode: https://opencode.ai"
fi

# Run init
echo ""
echo "Initializing Randal..."
bun run packages/cli/src/index.ts init "$@"

# Auto-generate API tokens if empty
if [ -f .env ]; then
  if grep -q "^RANDAL_API_TOKEN=$" .env 2>/dev/null; then
    TOKEN=$(openssl rand -hex 32)
    sed -i '' "s/^RANDAL_API_TOKEN=$/RANDAL_API_TOKEN=$TOKEN/" .env
    echo "  + Generated RANDAL_API_TOKEN in .env"
  fi
  if grep -q "^RANDAL_HOOK_TOKEN=$" .env 2>/dev/null; then
    HOOK_TOKEN=$(openssl rand -hex 32)
    sed -i '' "s/^RANDAL_HOOK_TOKEN=$/RANDAL_HOOK_TOKEN=$HOOK_TOKEN/" .env
    echo "  + Generated RANDAL_HOOK_TOKEN in .env"
  fi
fi

# Always set up Meilisearch (used by both harness memory and brain MCP)
echo ""
echo "Setting up Meilisearch..."

if curl -sf http://localhost:7700/health > /dev/null 2>&1; then
  echo "  + Meilisearch already running on :7700"
elif command -v brew &> /dev/null && brew list meilisearch &> /dev/null; then
  echo "  Meilisearch installed via Homebrew but not running. Starting..."
  brew services start meilisearch 2>/dev/null && echo "  + Meilisearch started via Homebrew" || echo "  ! Failed to start Meilisearch via Homebrew"
elif command -v docker &> /dev/null; then
  echo "  Starting Meilisearch via Docker..."

  # Generate a master key if not in .env
  if [ -f .env ] && ! grep -q "^MEILI_MASTER_KEY=" .env 2>/dev/null; then
    MEILI_KEY=$(openssl rand -hex 16)
    echo "" >> .env
    echo "MEILI_MASTER_KEY=${MEILI_KEY}" >> .env
    echo "  + Generated MEILI_MASTER_KEY in .env"
  elif [ -f .env ]; then
    MEILI_KEY=$(grep "^MEILI_MASTER_KEY=" .env | cut -d'=' -f2)
  else
    MEILI_KEY=$(openssl rand -hex 16)
  fi

  # Stop existing container if present
  docker rm -f randal-meilisearch 2>/dev/null || true

  # Start with persistent storage
  mkdir -p ~/.randal/meili-data
  docker run -d \
    --name randal-meilisearch \
    --restart unless-stopped \
    -p 7700:7700 \
    -v ~/.randal/meili-data:/meili_data \
    -e MEILI_MASTER_KEY="${MEILI_KEY}" \
    getmeili/meilisearch:v1.12

  echo "  + Meilisearch started on :7700 (data: ~/.randal/meili-data)"
else
  echo "  ! Could not start Meilisearch. Install manually:"
  echo "    brew install meilisearch && brew services start meilisearch"
  echo "    # or: docker run -d -p 7700:7700 getmeili/meilisearch:v1.12"
fi

echo ""
echo "=== Setup complete ==="
echo "Next steps:"
echo "  1. Edit randal.config.yaml (if needed)"
echo "  2. Add your API keys to .env"
echo "  3. Run: randal serve"
echo ""
echo "Dashboard: http://localhost:7600"
