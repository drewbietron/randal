#!/bin/bash
# Randal Brain Setup (TUI-only)
# One-command setup for personal machines running OpenCode — no harness needed.
# Usage: bash agent/setup.sh [--non-interactive]
#
# Architecture: Symlink-based config consolidation
#   All OpenCode config lives in this repo at agent/opencode-config/.
#   This script symlinks ~/.config/opencode -> agent/opencode-config/
#   so there is exactly ONE source of truth. Changes to agents, tools,
#   skills, lenses, and opencode.json are version-controlled in the repo
#   and take effect immediately through the symlink.
#
#   To experiment without affecting the repo:
#     rm ~/.config/opencode
#     cp -r agent/opencode-config ~/.config/opencode
#   To re-link: see agent/opencode-config/README.md
#
# What this does:
#   1. Symlinks ~/.config/opencode -> agent/opencode-config/ (one source of truth)
#   2. Installs plugin dependencies (bun install)
#   3. Checks/starts Meilisearch for persistent memory
#   4. Configures memory MCP server in opencode.json (through the symlink)
#   5. Detects optional tools (steer, drive)
#
# Idempotent: safe to run multiple times.

set -euo pipefail

# --- Configuration ---
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_DIR="$REPO_DIR/agent"
OC_CONFIG="$HOME/.config/opencode"
OC_SOURCE="$AGENT_DIR/opencode-config"
NON_INTERACTIVE=false

for arg in "$@"; do
  case "$arg" in
    --non-interactive) NON_INTERACTIVE=true ;;
  esac
done

echo ""
echo "=== Randal Brain Setup (TUI-only) ==="
echo ""
echo "  Repo:   $REPO_DIR"
echo "  Source: $OC_SOURCE"
echo "  Target: $OC_CONFIG"
echo ""

# --- Helper: symlink with backup (kept for potential future use) ---
link_file() {
  local src="$1"
  local dest="$2"
  local name
  name="$(basename "$dest")"

  if [ -L "$dest" ]; then
    rm "$dest"
    ln -s "$src" "$dest"
    echo "  ✅ $name linked (refreshed)"
  elif [ -f "$dest" ]; then
    mv "$dest" "${dest}.bak"
    ln -s "$src" "$dest"
    echo "  ✅ $name linked (old file backed up to ${name}.bak)"
  else
    ln -s "$src" "$dest"
    echo "  ✅ $name linked"
  fi
}

# --- 1. Prerequisites ---
echo "Checking prerequisites..."
if ! command -v bun &> /dev/null; then
  echo "  ❌ bun not found. Install: https://bun.sh"
  exit 1
fi
echo "  ✅ bun $(bun --version)"

if [ ! -d "$OC_SOURCE" ]; then
  echo "  ❌ OpenCode config source not found at $OC_SOURCE"
  echo "     Make sure you're running this from the Randal repo root."
  exit 1
fi
echo "  ✅ Config source exists"
echo ""

# --- 2. Symlink entire OpenCode config ---
echo "Linking OpenCode config..."

if [ -L "$OC_CONFIG" ]; then
  # Already a symlink — just refresh it
  rm "$OC_CONFIG"
  ln -sfn "$OC_SOURCE" "$OC_CONFIG"
  echo "  ✅ OpenCode config symlink refreshed"
elif [ -d "$OC_CONFIG" ]; then
  # Real directory — back up and replace
  BACKUP="$OC_CONFIG.bak.$(date +%s)"
  echo "  Backing up existing config to $BACKUP"
  mv "$OC_CONFIG" "$BACKUP"
  ln -sfn "$OC_SOURCE" "$OC_CONFIG"
  echo "  ✅ OpenCode config linked (old config backed up)"
else
  ln -sfn "$OC_SOURCE" "$OC_CONFIG"
  echo "  ✅ OpenCode config linked"
fi

# Install plugin dependencies
if [ -f "$OC_CONFIG/package.json" ]; then
  echo "  Installing plugin dependencies..."
  (cd "$OC_CONFIG" && bun install --frozen-lockfile 2>/dev/null || bun install) && \
    echo "  ✅ Dependencies installed" || \
    echo "  ⚠️  bun install failed — run manually: cd $OC_CONFIG && bun install"
fi
echo ""

# --- 3. Verify symlink ---
echo "Verifying config..."
OC_JSON="$OC_CONFIG/opencode.json"

if [ ! -f "$OC_JSON" ]; then
  echo "  ❌ opencode.json not found through symlink — something went wrong"
  exit 1
fi

if [ ! -d "$OC_CONFIG/agents" ]; then
  echo "  ❌ agents/ not found through symlink — something went wrong"
  exit 1
fi

echo "  ✅ opencode.json accessible"
echo "  ✅ agents/ accessible ($(ls "$OC_CONFIG/agents/" | wc -l | tr -d ' ') agents)"
echo "  ✅ tools/ accessible ($(ls "$OC_CONFIG/tools/" | wc -l | tr -d ' ') tools)"
echo "  ✅ lenses/ accessible ($(ls "$OC_CONFIG/lenses/" | wc -l | tr -d ' ') lenses)"
echo ""

# --- 4. Install/check Meilisearch ---
echo "Checking Meilisearch..."
MEILI_RUNNING=false
MEILI_URL=""

if curl -sf http://localhost:7701/health > /dev/null 2>&1; then
  echo "  ✅ Meilisearch already running on :7701 (Docker Compose)"
  MEILI_RUNNING=true
  MEILI_URL="http://localhost:7701"
elif curl -sf http://localhost:7700/health > /dev/null 2>&1; then
  echo "  ✅ Meilisearch already running on :7700 (Homebrew)"
  MEILI_RUNNING=true
  MEILI_URL="http://localhost:7700"
else
  echo "  Meilisearch not running. Attempting to install and start..."

  MEILI_STARTED=false

  # Try Docker Compose first
  if command -v docker &> /dev/null && docker compose version &> /dev/null; then
    echo "  Trying Docker Compose..."
    if bash "$REPO_DIR/scripts/meili-start.sh"; then
      MEILI_STARTED=true
      MEILI_URL="http://localhost:7701"
    fi
  fi

  # Try Homebrew if Docker Compose didn't work
  if [ "$MEILI_STARTED" = false ] && command -v brew &> /dev/null; then
    echo "  Trying Homebrew..."
    if brew install meilisearch 2>/dev/null; then
      if brew services start meilisearch 2>/dev/null; then
        echo "  ✅ Meilisearch installed and started via Homebrew"
        MEILI_STARTED=true
        MEILI_URL="http://localhost:7700"
      fi
    fi
  fi

  # Neither worked — print manual instructions
  if [ "$MEILI_STARTED" = false ]; then
    echo "  ⚠️  Could not auto-install Meilisearch."
    echo "     Install manually:"
    echo "       Docker Compose: bash scripts/meili-start.sh"
    echo "       Homebrew:       brew install meilisearch && brew services start meilisearch"
    echo "       Other:          https://www.meilisearch.com/docs/learn/getting_started/installation"
  fi

  # Wait for health check after starting
  if [ "$MEILI_STARTED" = true ]; then
    echo "  Waiting for Meilisearch to be ready..."
    for i in $(seq 1 10); do
      if curl -sf "${MEILI_URL}/health" > /dev/null 2>&1; then
        echo "  ✅ Meilisearch is healthy"
        MEILI_RUNNING=true
        break
      fi
      sleep 1
    done
    if [ "$MEILI_RUNNING" = false ]; then
      echo "  ⚠️  Meilisearch started but health check timed out after 10s"
      echo "     Check manually: curl ${MEILI_URL}/health"
    fi
  fi
fi
echo ""

# --- 5. Configure memory MCP if Meilisearch is running ---
# NOTE: This modifies the repo's opencode.json directly through the symlink.
# The change will show up in `git diff` and should be committed if desired.
if [ "$MEILI_RUNNING" = true ]; then
  if [ -z "$MEILI_URL" ]; then
    MEILI_URL="http://localhost:7700"
  fi
  echo "Configuring memory MCP server..."
  MCP_MEMORY_SERVER="$REPO_DIR/tools/mcp-memory-server.ts"

  if [ ! -f "$MCP_MEMORY_SERVER" ]; then
    echo "  ⚠️  MCP memory server not found at $MCP_MEMORY_SERVER — skipping"
  elif [ ! -f "$OC_JSON" ]; then
    echo "  ⚠️  opencode.json not found — skipping memory MCP config"
  else
    # Check if memory MCP is already configured
    if grep -q '"memory"' "$OC_JSON" 2>/dev/null && grep -q 'mcp-memory-server' "$OC_JSON" 2>/dev/null; then
      echo "  ✅ Memory MCP already configured in opencode.json"
    else
      # Try to add using jq
      if command -v jq &> /dev/null; then
        MCP_CONFIG=$(jq -n \
          --arg cmd "bun" \
          --arg script "$MCP_MEMORY_SERVER" \
          --arg meiliUrl "$MEILI_URL" \
          '{
            type: "local",
            command: [$cmd, "run", $script],
            environment: {
              "MEILI_URL": $meiliUrl,
              "MEILI_MASTER_KEY": "{env:MEILI_MASTER_KEY}",
              "OPENROUTER_API_KEY": "{env:OPENROUTER_API_KEY}",
              "SUMMARY_MODEL": "anthropic/claude-haiku-3"
            },
            enabled: true
          }')

        # Add memory to mcp section (create mcp if it doesn't exist)
        TMP_JSON=$(mktemp)
        jq --argjson mem "$MCP_CONFIG" '.mcp = (.mcp // {}) | .mcp.memory = $mem' "$OC_JSON" > "$TMP_JSON" && mv "$TMP_JSON" "$OC_JSON"
        echo "  ✅ Memory MCP added to opencode.json"
      else
        echo "  ⚠️  jq not installed — add this to the \"mcp\" section of opencode.json manually:"
        echo ""
        echo "    \"memory\": {"
        echo "      \"type\": \"local\","
        echo "      \"command\": [\"bun\", \"run\", \"$MCP_MEMORY_SERVER\"],"
        echo "      \"environment\": {"
        echo "        \"MEILI_URL\": \"$MEILI_URL\","
        echo "        \"MEILI_MASTER_KEY\": \"{env:MEILI_MASTER_KEY}\","
        echo "        \"OPENROUTER_API_KEY\": \"{env:OPENROUTER_API_KEY}\","
        echo "        \"SUMMARY_MODEL\": \"anthropic/claude-haiku-3\""
        echo "      },"
        echo "      \"enabled\": true"
        echo "    }"
        echo ""
      fi
    fi
  fi
  echo ""
fi

# --- 6. Detect optional tools ---
echo "Detecting optional tools..."

# Steer
if command -v steer &> /dev/null; then
  echo "  ✅ steer available (macOS GUI automation)"
elif [ -f "$REPO_DIR/tools/steer/.build/release/steer" ]; then
  echo "  ✅ steer built (not in PATH — run: export PATH=\"$REPO_DIR/tools/steer/.build/release:\$PATH\")"
else
  echo "  - steer not available (optional — macOS GUI automation)"
fi

# Drive
if command -v drive &> /dev/null; then
  echo "  ✅ drive available (terminal automation)"
elif [ -d "$REPO_DIR/tools/drive" ]; then
  echo "  - drive found but not installed (optional — run: cd tools/drive && uv sync)"
else
  echo "  - drive not available (optional — terminal automation)"
fi
echo ""

# --- 7. Summary ---
echo "=== Setup complete ==="
echo ""
echo "  Config: $OC_CONFIG -> $OC_SOURCE"
echo ""
echo "Next steps:"
echo "  1. Restart OpenCode"
echo "  2. Press Tab — you should see only Randal"
echo "  3. Try: \"What do you remember?\" (tests memory)"
echo ""
echo "Config is symlinked — git pull updates everything automatically."
echo ""
echo "To break the symlink for local experiments:"
echo "  rm ~/.config/opencode"
echo "  cp -r $OC_SOURCE ~/.config/opencode"
echo ""
echo "To re-link after experimenting:"
echo "  rm -rf ~/.config/opencode"
echo "  ln -sfn $OC_SOURCE ~/.config/opencode"
echo ""
