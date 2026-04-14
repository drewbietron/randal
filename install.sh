#!/bin/bash
# Randal — One-liner installer
# Usage: curl -fsSL https://raw.githubusercontent.com/drewbietron/randal/main/install.sh | bash
#
# Environment variables:
#   RANDAL_DIR — install location (default: ~/randal)
#
# Idempotent: running again updates rather than breaks things.
set -e

RANDAL_DIR="${RANDAL_DIR:-$HOME/randal}"
REPO_URL="https://github.com/drewbietron/randal.git"
case "$(uname)" in
  Darwin) IS_MACOS=true ;;
  *)      IS_MACOS=false ;;
esac

echo ""
echo "  🤠 Randal Installer"
echo "  ════════════════════"
echo ""

# ── Helper: ensure ~/.local/bin is on PATH ───────────────────
ensure_local_bin() {
  mkdir -p "$HOME/.local/bin"
  if ! echo "$PATH" | grep -q "$HOME/.local/bin"; then
    export PATH="$HOME/.local/bin:$PATH"
    # RC modification is handled later in the opt-in block
  fi
}

# ── Helper: install Homebrew (macOS) ─────────────────────────
ensure_homebrew() {
  if [ "$IS_MACOS" = true ] && ! command -v brew &> /dev/null; then
    echo "  Installing Homebrew..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv 2>/dev/null)"
  fi
}

# ── 1. Prerequisites ──────────────────────────────────────────
echo "Checking prerequisites..."

# Xcode CLI Tools (macOS — needed for git, swift, etc.)
if [ "$IS_MACOS" = true ] && ! xcode-select -p &> /dev/null; then
  echo "  Installing Xcode Command Line Tools..."
  xcode-select --install 2>/dev/null || true
  echo "  ! Xcode CLI Tools installation started. You may need to re-run this script after it completes."
fi

# Homebrew (macOS)
ensure_homebrew

# ── 2. Install Bun ───────────────────────────────────────────
if ! command -v bun &> /dev/null; then
  echo "  Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
  echo "  + Bun installed: $(bun --version)"
else
  echo "  + Bun: $(bun --version)"
fi

# ── 3. Install OpenCode CLI ─────────────────────────────────
if ! command -v opencode &> /dev/null; then
  echo "  Installing OpenCode CLI..."
  if [ "$IS_MACOS" = true ] && command -v brew &> /dev/null; then
    brew install opencode 2>/dev/null && echo "  + OpenCode CLI installed" || echo "  ! OpenCode CLI install failed"
  else
    # Direct download for Linux or macOS without Homebrew
    ensure_local_bin
    ARCH=$(uname -m)
    OS="unknown-linux-gnu"
    if [ "$IS_MACOS" = true ]; then
      OS="apple-darwin"
    fi
    curl -fsSL "https://github.com/opencode-ai/opencode/releases/latest/download/opencode-${ARCH}-${OS}" -o "$HOME/.local/bin/opencode" 2>/dev/null && {
      chmod +x "$HOME/.local/bin/opencode"
      echo "  + OpenCode CLI installed"
    } || echo "  ! OpenCode CLI install failed"
  fi
else
  echo "  + OpenCode CLI: $(opencode --version 2>&1)"
fi

# ── 3b. Install GitHub CLI ───────────────────────────────────
if ! command -v gh &> /dev/null; then
  echo "  Installing GitHub CLI..."
  if [ "$IS_MACOS" = true ] && command -v brew &> /dev/null; then
    brew install gh 2>/dev/null && echo "  + gh installed" || echo "  ! gh install failed"
  elif command -v apt-get &> /dev/null; then
    (curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg 2>/dev/null \
      && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
      && sudo apt-get update -qq && sudo apt-get install -y gh) 2>/dev/null && echo "  + gh installed" || echo "  ! gh install failed"
  fi
else
  echo "  + gh: $(gh --version 2>&1 | head -1)"
fi

# ── 4. Install Python 3.12+ (for drive) ─────────────────────
PY_VERSION=$(python3 -c 'import sys; print(sys.version_info.minor)' 2>/dev/null || echo "0")
if [ "$PY_VERSION" -lt 11 ] 2>/dev/null; then
  echo "  System Python is 3.${PY_VERSION} (need 3.11+)..."
  if [ "$IS_MACOS" = true ] && command -v brew &> /dev/null; then
    echo "  Installing Python 3.12 via Homebrew..."
    brew install python@3.12 2>/dev/null && echo "  + Python 3.12 installed" || echo "  ! Python 3.12 install failed"
    # Homebrew python is at a versioned path — link it
    BREW_PY="$(brew --prefix python@3.12 2>/dev/null)/bin/python3.12"
    if [ -x "$BREW_PY" ]; then
      ensure_local_bin
      ln -sf "$BREW_PY" "$HOME/.local/bin/python3"
      PY_VERSION=12
    fi
  elif command -v apt-get &> /dev/null; then
    sudo apt-get update -qq && sudo apt-get install -y python3.12 python3.12-venv python3-pip 2>/dev/null && {
      PY_VERSION=12
      echo "  + Python 3.12 installed"
    } || echo "  ! Python 3.12 install failed"
  fi
fi

# Install uv (fast Python package manager) if missing
if ! command -v uv &> /dev/null; then
  echo "  Installing uv..."
  curl -LsSf https://astral.sh/uv/install.sh | sh 2>/dev/null
  export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
  if command -v uv &> /dev/null; then
    echo "  + uv installed"
  fi
fi

# ── 5. Clone or update repo ─────────────────────────────────
echo ""
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

# ── 5b. Configure shell to load .env on startup ────────────
echo ""
echo "Configuring shell environment..."

# Source .env for this session
if [ -f "$RANDAL_DIR/.env" ]; then
  set -a; source "$RANDAL_DIR/.env" 2>/dev/null; set +a
  echo "  + .env loaded for current session"
fi

# Add to shell RC files for future sessions (opt-in)
ENV_LINE="set -a; source \"$RANDAL_DIR/.env\" 2>/dev/null; set +a"
ENV_COMMENT="# Randal env vars (secrets for OpenCode MCP servers)"
LOCAL_BIN_LINE='export PATH="$HOME/.local/bin:$PATH"'

MODIFY_RC="${RANDAL_MODIFY_RC:-}"
if [ "$MODIFY_RC" != "no" ] && [ -t 0 ]; then
  # Interactive terminal — ask the user
  echo ""
  printf "  Add Randal env + PATH entries to your shell RC files? [y/N] "
  read -r REPLY
  case "$REPLY" in
    [yY]|[yY][eE][sS]) MODIFY_RC="yes" ;;
    *) MODIFY_RC="no" ;;
  esac
elif [ "$MODIFY_RC" != "yes" ]; then
  # Non-interactive (piped install) — skip by default
  MODIFY_RC="no"
fi

if [ "$MODIFY_RC" = "yes" ]; then
  for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
    if [ -f "$rc" ] || [ "$(basename "$rc")" = ".$(basename "$SHELL")rc" ]; then
      # Add .local/bin to PATH if missing
      if ! grep -q '.local/bin' "$rc" 2>/dev/null; then
        echo "" >> "$rc"
        echo "# Randal — ensure ~/.local/bin is on PATH" >> "$rc"
        echo "$LOCAL_BIN_LINE" >> "$rc"
        echo "  + Added .local/bin PATH to $(basename "$rc")"
      fi
      # Add .env sourcing if missing
      if ! grep -q "randal/.env" "$rc" 2>/dev/null; then
        echo "" >> "$rc"
        echo "$ENV_COMMENT" >> "$rc"
        echo "$ENV_LINE" >> "$rc"
        echo "  + Added .env sourcing to $(basename "$rc")"
      else
        echo "  + .env sourcing already in $(basename "$rc")"
      fi
    fi
  done
else
  echo "  Skipped RC modification. To configure your shell manually, add:"
  echo "    $LOCAL_BIN_LINE"
  echo "    $ENV_LINE"
fi

# ── 6. Install Node/Bun dependencies ────────────────────────
echo ""
echo "Installing dependencies..."
bun install

# ── 7. Link CLI globally ────────────────────────────────────
echo "Linking randal CLI..."
bun link
echo "  + 'randal' command registered"

# ── 8. Build tools ──────────────────────────────────────────
echo ""
echo "Setting up tools..."
ensure_local_bin

# Steer (macOS only — Swift GUI automation)
if [ "$IS_MACOS" = true ] && command -v swift &> /dev/null; then
  echo "  Building steer (Swift)..."
  if (cd tools/steer && swift build -c release 2>/dev/null); then
    ln -sf "$RANDAL_DIR/tools/steer/.build/arm64-apple-macosx/release/steer" "$HOME/.local/bin/steer"
    echo "  + steer built and linked"
  else
    echo "  ! steer build failed (Xcode CLI Tools required)"
  fi
fi

# Drive (Python terminal automation)
DRIVE_INSTALLED=false
if command -v uv &> /dev/null; then
  echo "  Installing drive (Python)..."
  if (cd tools/drive && uv tool install . --force 2>/dev/null); then
    DRIVE_INSTALLED=true
    echo "  + drive installed via uv"
  fi
fi

if [ "$DRIVE_INSTALLED" = false ] && [ "$PY_VERSION" -ge 11 ] 2>/dev/null; then
  echo "  Installing drive (Python via pip)..."
  python3 -m pip install "$RANDAL_DIR/tools/drive" --quiet 2>/dev/null && {
    DRIVE_INSTALLED=true
    echo "  + drive installed via pip"
  } || echo "  ! drive pip install failed"
fi

if [ "$DRIVE_INSTALLED" = false ]; then
  echo "  ! drive: Python 3.11+ not available — drive will not be installed"
fi

# ── 9. Set up skills directory ───────────────────────────────
echo ""
echo "Setting up skills..."
if [ -d "tools/skills" ]; then
  mkdir -p skills
  for skill_file in tools/skills/*.md; do
    if [ -f "$skill_file" ]; then
      skill_name=$(basename "$skill_file" .md)
      mkdir -p "skills/$skill_name"
      cp "$skill_file" "skills/$skill_name/SKILL.md"
    fi
  done
  echo "  + Skills: $(ls skills/ 2>/dev/null | tr '\n' ' ')"
fi

# ── 10. Install BlueBubbles on macOS ────────────────────────
if [ "$IS_MACOS" = true ]; then
  if [ ! -d "/Applications/BlueBubbles.app" ]; then
    echo ""
    echo "Installing BlueBubbles Server (iMessage bridge)..."
    if command -v brew &> /dev/null; then
      brew install --cask bluebubbles --no-quarantine 2>/dev/null && \
        echo "  + BlueBubbles Server installed" || \
        echo "  ! BlueBubbles install failed (can be installed during init)"
    fi
  else
    echo "  + BlueBubbles Server already installed"
  fi
fi

# ── 11. Run interactive setup wizard ─────────────────────────
echo ""
echo "Running setup wizard..."
bun run packages/cli/src/index.ts init "$@"

# ── 12. Auto-generate API tokens if empty ────────────────────
if [ -f .env ]; then
  if grep -q "^RANDAL_API_TOKEN=$" .env 2>/dev/null; then
    TOKEN=$(openssl rand -hex 32)
    sed -i '' "s/^RANDAL_API_TOKEN=$/RANDAL_API_TOKEN=$TOKEN/" .env 2>/dev/null || \
      sed -i "s/^RANDAL_API_TOKEN=$/RANDAL_API_TOKEN=$TOKEN/" .env
    echo "  + Generated RANDAL_API_TOKEN"
  fi
  if grep -q "^RANDAL_HOOK_TOKEN=$" .env 2>/dev/null; then
    HOOK_TOKEN=$(openssl rand -hex 32)
    sed -i '' "s/^RANDAL_HOOK_TOKEN=$/RANDAL_HOOK_TOKEN=$HOOK_TOKEN/" .env 2>/dev/null || \
      sed -i "s/^RANDAL_HOOK_TOKEN=$/RANDAL_HOOK_TOKEN=$HOOK_TOKEN/" .env
    echo "  + Generated RANDAL_HOOK_TOKEN"
  fi
fi

# ── 13. Start Meilisearch if selected ────────────────────────
if [ -f randal.config.yaml ] && grep -q "store: meilisearch" randal.config.yaml; then
  echo ""
  echo "Meilisearch memory selected. Checking status..."

  if curl -sf http://localhost:7700/health > /dev/null 2>&1; then
    echo "  + Meilisearch already running on :7700"
  elif command -v meilisearch &> /dev/null; then
    mkdir -p ~/.randal/meili-data
    if ! grep -q "^MEILI_MASTER_KEY=" .env 2>/dev/null; then
      MEILI_KEY=$(openssl rand -hex 16)
      echo "MEILI_MASTER_KEY=${MEILI_KEY}" >> .env
    fi
    echo "  Starting Meilisearch..."
    nohup meilisearch --db-path ~/.randal/meili-data --master-key "$(grep MEILI_MASTER_KEY .env | cut -d= -f2)" > /dev/null 2>&1 &
    echo "  + Meilisearch started on :7700"
  elif command -v docker &> /dev/null; then
    echo "  Starting Meilisearch via Docker..."
    if ! grep -q "^MEILI_MASTER_KEY=" .env 2>/dev/null; then
      MEILI_KEY=$(openssl rand -hex 16)
      echo "MEILI_MASTER_KEY=${MEILI_KEY}" >> .env
    else
      MEILI_KEY=$(grep "^MEILI_MASTER_KEY=" .env | cut -d'=' -f2)
    fi
    docker rm -f randal-meilisearch 2>/dev/null || true
    mkdir -p ~/.randal/meili-data
    docker run -d \
      --name randal-meilisearch \
      --restart unless-stopped \
      -p 7700:7700 \
      -v ~/.randal/meili-data:/meili_data \
      -e MEILI_MASTER_KEY="${MEILI_KEY}" \
      getmeili/meilisearch:v1.12
    echo "  + Meilisearch started on :7700"
  else
    echo "  ! No Meilisearch binary or Docker found."
    if [ "$IS_MACOS" = true ] && command -v brew &> /dev/null; then
      echo "    Installing meilisearch via Homebrew..."
      brew install meilisearch 2>/dev/null && echo "  + meilisearch installed" || echo "  ! install failed"
    fi
  fi
fi

# ── 14. Done ─────────────────────────────────────────────────
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
