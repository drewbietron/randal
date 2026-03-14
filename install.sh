#!/bin/bash
# Randal — One-liner installer
# Usage: curl -fsSL https://raw.githubusercontent.com/your-org/randal/main/install.sh | bash
#
# Environment variables:
#   RANDAL_DIR — install location (default: ~/randal)
#
# Idempotent: running again updates rather than breaks things.
set -e

RANDAL_DIR="${RANDAL_DIR:-$HOME/randal}"
REPO_URL="https://github.com/your-org/randal.git"

echo ""
echo "  🤠 Randal Installer"
echo "  ════════════════════"
echo ""

# ── 1. Check / install Bun ──────────────────────────────────
if ! command -v bun &> /dev/null; then
  echo "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
  echo "  + Bun installed: $(bun --version)"
else
  echo "  + Bun found: $(bun --version)"
fi

# ── 2. Clone or update repo ────────────────────────────────
if [ -d "$RANDAL_DIR/.git" ]; then
  echo "  + Randal repo found at $RANDAL_DIR — pulling latest..."
  (cd "$RANDAL_DIR" && git pull --ff-only) || {
    echo "  ! git pull failed — continuing with existing code"
  }
else
  echo "Cloning Randal to $RANDAL_DIR..."
  git clone "$REPO_URL" "$RANDAL_DIR"
fi

cd "$RANDAL_DIR"

# ── 3. Install dependencies ────────────────────────────────
echo "Installing dependencies..."
bun install

# ── 4. Link CLI globally ───────────────────────────────────
echo "Linking randal CLI..."
bun link
echo "  + 'randal' command registered"

# ── 5. Build tools ──────────────────────────────────────────
echo ""
echo "Setting up tools..."

# Steer (macOS only — Swift)
if [[ "$(uname)" == "Darwin" ]] && command -v swift &> /dev/null; then
  echo "  Building steer (Swift)..."
  (cd tools/steer && swift build -c release) 2>/dev/null || echo "  ! steer build failed (Xcode CLI Tools required)"
fi

# Drive (Python)
if command -v uv &> /dev/null; then
  echo "  Installing drive (Python)..."
  (cd tools/drive && uv sync && uv pip install -e .) 2>/dev/null || echo "  ! drive install failed"
fi

# ── 6. Run interactive setup wizard ────────────────────────
echo ""
echo "Running setup wizard..."
bun run packages/cli/src/index.ts init "$@"

# ── 7. Start Meilisearch if selected ───────────────────────
if [ -f randal.config.yaml ] && grep -q "store: meilisearch" randal.config.yaml; then
  echo ""
  echo "Meilisearch memory selected. Checking status..."

  if curl -sf http://localhost:7700/health > /dev/null 2>&1; then
    echo "  + Meilisearch already running on :7700"
  elif command -v docker &> /dev/null; then
    echo "  Starting Meilisearch via Docker..."

    # Generate a master key if not in .env
    if ! grep -q "^MEILI_MASTER_KEY=" .env 2>/dev/null; then
      MEILI_KEY=$(openssl rand -hex 16)
      echo "" >> .env
      echo "MEILI_MASTER_KEY=${MEILI_KEY}" >> .env
      echo "  + Generated MEILI_MASTER_KEY in .env"
    else
      MEILI_KEY=$(grep "^MEILI_MASTER_KEY=" .env | cut -d'=' -f2)
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
    echo ""
    echo "  ! Docker not found. To start Meilisearch manually:"
    echo "    brew install meilisearch"
    echo "    # or: docker run -d -p 7700:7700 getmeili/meilisearch:v1.12"
  fi
fi

# ── 8. Done ─────────────────────────────────────────────────
echo ""
echo "  ════════════════════════════════════════"
echo "  🤠 Randal is ready!"
echo ""
echo "  Start your agent:"
echo "    cd $RANDAL_DIR"
echo "    randal serve"
echo ""
echo "  Dashboard: http://localhost:7600"
echo "  ════════════════════════════════════════"
echo ""
