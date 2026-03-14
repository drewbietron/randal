#!/bin/bash
set -e

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
bun install

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

# Run init
echo ""
echo "Initializing Randal..."
bun run packages/cli/src/index.ts init "$@"

echo ""
echo "=== Setup complete ==="
echo "Next steps:"
echo "  1. Edit randal.config.yaml"
echo "  2. Create .env with your API keys"
echo "  3. Run: bun run packages/cli/src/index.ts serve"
