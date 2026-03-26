#!/bin/bash
# Randal Brain Setup (TUI-only)
# One-command setup for personal machines running OpenCode — no harness needed.
# Usage: bash agent/setup.sh [--non-interactive]

set -euo pipefail

# --- Configuration ---
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_DIR="$REPO_DIR/agent"
OC_CONFIG="$HOME/.config/opencode"
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
echo "  Config: $OC_CONFIG"
echo ""

# --- Helper: symlink with backup ---
link_file() {
  local src="$1"
  local dest="$2"
  local name
  name="$(basename "$dest")"

  if [ -L "$dest" ]; then
    # Already a symlink — remove and re-link (might point to old location)
    rm "$dest"
    ln -s "$src" "$dest"
    echo "  ✅ $name linked (refreshed)"
  elif [ -f "$dest" ]; then
    # Regular file — back up, then link
    mv "$dest" "${dest}.bak"
    ln -s "$src" "$dest"
    echo "  ✅ $name linked (old file backed up to ${name}.bak)"
  else
    ln -s "$src" "$dest"
    echo "  ✅ $name linked"
  fi
}

# --- 1. Create directories ---
echo "Creating config directories..."
mkdir -p "$OC_CONFIG/agents"
mkdir -p "$OC_CONFIG/tools"
echo ""

# --- 2. Symlink agent files ---
echo "Linking agent files..."
for file in randal.md plan.md build.md; do
  if [ -f "$AGENT_DIR/agents/$file" ]; then
    link_file "$AGENT_DIR/agents/$file" "$OC_CONFIG/agents/$file"
  else
    echo "  ⚠️  $file not found in $AGENT_DIR/agents/ — skipping"
  fi
done
echo ""

# --- 2b. Copy lens files ---
echo "Copying lens files..."
mkdir -p "$OC_CONFIG/lenses"
for file in "$AGENT_DIR/lenses/"*.md; do
  if [ -f "$file" ]; then
    name="$(basename "$file")"
    cp "$file" "$OC_CONFIG/lenses/$name"
    echo "  ✅ $name copied"
  fi
done
echo ""

# --- 3. Symlink custom tool files ---
echo "Linking custom tools..."
for file in model-context.ts loop-state.ts; do
  if [ -f "$AGENT_DIR/tools/$file" ]; then
    link_file "$AGENT_DIR/tools/$file" "$OC_CONFIG/tools/$file"
  else
    echo "  ⚠️  $file not found in $AGENT_DIR/tools/ — skipping"
  fi
done
echo ""

# --- 4. Remove old agent files ---
echo "Cleaning up old agents..."
for old_file in prd-writer.md prd-gen-template.md; do
  if [ -f "$OC_CONFIG/agents/$old_file" ] || [ -L "$OC_CONFIG/agents/$old_file" ]; then
    rm "$OC_CONFIG/agents/$old_file"
    echo "  🗑️  Removed $old_file"
  fi
done
echo ""

# --- 5. Check/update opencode.json ---
echo "Checking opencode.json..."
OC_JSON="$OC_CONFIG/opencode.json"

if [ ! -f "$OC_JSON" ]; then
  # Create minimal config
  cat > "$OC_JSON" << 'JSONEOF'
{
  "$schema": "https://opencode.ai/config.json",
  "agent": {
    "build": { "disable": true },
    "plan": { "disable": true }
  }
}
JSONEOF
  echo "  ✅ Created opencode.json with built-in agents disabled"
else
  # Check if disable config is present
  if grep -q '"disable"' "$OC_JSON" 2>/dev/null; then
    echo "  ✅ opencode.json already has agent disable config"
  else
    echo "  ⚠️  opencode.json exists but may not have built-in agents disabled."
    echo "     Add this to your opencode.json:"
    echo '     "agent": { "build": { "disable": true }, "plan": { "disable": true } }'
  fi
fi
echo ""

# --- 6. Install/check Meilisearch ---
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

# --- 7. Configure memory MCP if Meilisearch is running ---
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
            type: "stdio",
            command: $cmd,
            args: ["run", $script],
            env: { "MEILI_URL": $meiliUrl },
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
        echo "      \"type\": \"stdio\","
        echo "      \"command\": \"bun\","
        echo "      \"args\": [\"run\", \"$MCP_MEMORY_SERVER\"],"
        echo "      \"env\": { \"MEILI_URL\": \"$MEILI_URL\" },"
        echo "      \"enabled\": true"
        echo "    }"
        echo ""
      fi
    fi
  fi
  echo ""
fi

# --- 8. Detect optional tools ---
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

# --- 9. Summary ---
echo "=== Setup complete ==="
echo ""
echo "Next steps:"
echo "  1. Restart OpenCode"
echo "  2. Press Tab — you should see only Randal"
echo "  3. Try: \"What do you remember?\" (tests memory)"
echo ""
echo "To update: cd ~/dev/randal && git pull (symlinks auto-update)"
echo ""
