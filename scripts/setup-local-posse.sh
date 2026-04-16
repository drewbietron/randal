#!/bin/bash
#
# Posse Conductor Local Setup Script
# ==================================
# Interactive setup wizard for configuring and launching the Posse Conductor
# on a local Mac (or Linux) machine.
#
# Usage:
#   ./scripts/setup-local-posse.sh [options]
#
# Options:
#   --config-dir DIR    Configuration directory (default: ~/.config/randal-posse)
#   --skip-deps         Skip dependency checks
#   --non-interactive   Use defaults without prompting
#   --help              Show this help message
#

set -euo pipefail

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
CONFIG_DIR="${HOME}/.config/randal-posse"
MEILI_DATA_DIR="${HOME}/.randal/meili-data"
CONDUCTOR_PORT=7777
MEILI_PORT=7700

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Global state
INTERACTIVE=true
SKIP_DEPS=false
MODE="single"
POSSE_NAME=""
AGENTS=()
CONDUCTOR_MODEL="moonshotai/kimi-k2.5"
DISCORD_ENABLED=false
DISCORD_TOKEN=""

# ============================================================================
# Utility Functions
# ============================================================================

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[OK]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

print_banner() {
    echo ""
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║                                                              ║"
    echo "║           🤠 Posse Conductor Setup Wizard                   ║"
    echo "║                                                              ║"
    echo "║     Central orchestration for your Randal agent posse       ║"
    echo "║                                                              ║"
    echo "╚══════════════════════════════════════════════════════════════╝"
    echo ""
}

ask() {
    local prompt="$1"
    local default="${2:-}"
    local var_name="$3"

    if [[ "$INTERACTIVE" == "false" ]]; then
        printf -v "$var_name" '%s' "$default"
        return
    fi

    if [[ -n "$default" ]]; then
        read -rp "$prompt [$default]: " response
        printf -v "$var_name" '%s' "${response:-$default}"
    else
        read -rp "$prompt: " response
        printf -v "$var_name" '%s' "$response"
    fi
}

ask_yn() {
    local prompt="$1"
    local default="${2:-n}"
    local var_name="$3"

    if [[ "$INTERACTIVE" == "false" ]]; then
        printf -v "$var_name" '%s' "$default"
        return
    fi

    local yn_prompt="$prompt"
    if [[ "$default" == "y" ]]; then
        yn_prompt="$prompt [Y/n]: "
    else
        yn_prompt="$prompt [y/N]: "
    fi

    read -rp "$yn_prompt" response
    response="${response:-$default}"
    if [[ "$response" =~ ^[Yy] ]]; then
        printf -v "$var_name" '%s' "true"
    else
        printf -v "$var_name" '%s' "false"
    fi
}

# ============================================================================
# Prerequisites Check
# ============================================================================

check_macos_version() {
    if [[ "$OSTYPE" != "darwin"* ]]; then
        log_warn "Not running on macOS. Some features may not work."
        return 0
    fi

    local version
    version=$(sw_vers -productVersion 2>/dev/null || echo "0")
    local major_version
    major_version=$(echo "$version" | cut -d. -f1)

    if [[ "$major_version" -lt 13 ]]; then
        log_error "macOS 13+ required. Found: $version"
        return 1
    fi

    log_success "macOS $version (13+ required)"
    return 0
}

check_ram() {
    local total_ram_gb

    if [[ "$OSTYPE" == "darwin"* ]]; then
        total_ram_gb=$(($(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1024 / 1024 / 1024))
    else
        total_ram_gb=$(($(grep MemTotal /proc/meminfo 2>/dev/null | awk '{print $2}' || echo 0) / 1024 / 1024))
    fi

    if [[ "$total_ram_gb" -lt 8 ]]; then
        log_warn "Available RAM: ${total_ram_gb}GB (8GB+ recommended)"
        if [[ "$INTERACTIVE" == "true" ]]; then
            local continue_anyway
            ask_yn "Continue anyway?" "n" continue_anyway
            if [[ "$continue_anyway" != "true" ]]; then
                exit 1
            fi
        fi
    else
        log_success "RAM: ${total_ram_gb}GB"
    fi
}

check_docker() {
    if ! command -v docker &> /dev/null; then
        log_error "Docker not found. Please install Docker: https://docs.docker.com/get-docker/"
        return 1
    fi

    if ! docker info &> /dev/null; then
        log_error "Docker is installed but not running. Please start Docker."
        return 1
    fi

    log_success "Docker is installed and running"
}

check_bun() {
    if ! command -v bun &> /dev/null; then
        log_error "Bun not found. Installing..."
        curl -fsSL https://bun.sh/install | bash
        export PATH="$HOME/.bun/bin:$PATH"
    fi

    local bun_version
    bun_version=$(bun --version)
    log_success "Bun $bun_version"
}

check_env_vars() {
    local missing_vars=()

    if [[ -z "${ANTHROPIC_API_KEY:-}" ]] && [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
        missing_vars+=("ANTHROPIC_API_KEY or OPENROUTER_API_KEY")
    fi

    if [[ ${#missing_vars[@]} -gt 0 ]]; then
        log_warn "Missing optional API keys: ${missing_vars[*]}"
        log_info "You can add these to ~/.config/randal-posse/.env later"
    fi
}

check_prerequisites() {
    if [[ "$SKIP_DEPS" == "true" ]]; then
        log_info "Skipping dependency checks (--skip-deps)"
        return 0
    fi

    print_banner
    log_info "Checking prerequisites..."
    echo ""

    check_macos_version || return 1
    check_ram
    check_docker || return 1
    check_bun
    check_env_vars

    echo ""
    log_success "All prerequisites met!"
    echo ""
}

# ============================================================================
# Interactive Configuration Wizard
# ============================================================================

wizard_mode() {
    log_info "Configuration Mode"
    echo ""
    echo "  single - One agent, no distribution (simplest)"
    echo "  posse  - Multiple agents with shared memory and routing"
    echo ""

    local mode_choice
    ask "Mode" "single" mode_choice
    MODE="$mode_choice"

    if [[ "$MODE" == "posse" ]]; then
        ask "Posse name" "my-posse" POSSE_NAME
    fi
}

wizard_conductor() {
    log_info "Conductor Configuration"
    echo ""

    ask "Conductor port" "7777" CONDUCTOR_PORT
    ask "Conductor model" "moonshotai/kimi-k2.5" CONDUCTOR_MODEL
}

wizard_agents() {
    if [[ "$MODE" == "single" ]]; then
        log_info "Single Agent Configuration"
        echo ""

        local agent_name agent_url agent_model
        ask "Agent name" "local-agent" agent_name
        ask "Agent URL" "http://localhost:7600" agent_url
        ask "Agent model" "moonshotai/kimi-k2.5" agent_model

        AGENTS=("$agent_name|$agent_url|$agent_model")
    else
        log_info "Posse Agent Configuration"
        echo ""

        local add_agent=true
        local agent_num=1

        while [[ "$add_agent" == "true" ]]; do
            echo ""
            log_info "Agent #$agent_num"

            local agent_name agent_url agent_model
            ask "Agent name" "agent-$agent_num" agent_name
            ask "Agent URL" "http://localhost:$((7600 + agent_num - 1))" agent_url
            ask "Agent model" "moonshotai/kimi-k2.5" agent_model

            AGANTS+=("$agent_name|$agent_url|$agent_model")

            ask_yn "Add another agent?" "n" add_agent
            ((agent_num++))
        done
    fi
}

wizard_discord() {
    log_info "Discord Integration (Optional)"
    echo ""

    ask_yn "Enable Discord gateway?" "n" DISCORD_ENABLED

    if [[ "$DISCORD_ENABLED" == "true" ]]; then
        ask "Discord bot token" "" DISCORD_TOKEN
    fi
}

run_wizard() {
    if [[ "$INTERACTIVE" == "false" ]]; then
        log_info "Non-interactive mode: using defaults"
        MODE="single"
        CONDUCTOR_PORT="7777"
        CONDUCTOR_MODEL="moonshotai/kimi-k2.5"
        AGENTS=("local-agent|http://localhost:7600|moonshotai/kimi-k2.5")
        DISCORD_ENABLED="false"
        return 0
    fi

    wizard_mode
    wizard_conductor
    wizard_agents
    wizard_discord

    echo ""
    log_success "Configuration complete!"
    echo ""
}

# ============================================================================
# Configuration Generation
# ============================================================================

generate_conductor_config() {
    log_info "Generating conductor configuration..."

    mkdir -p "$CONFIG_DIR"

    local config_file="$CONFIG_DIR/conductor.config.yaml"

    cat > "$config_file" <<EOF
# Posse Conductor Configuration
# Generated by setup-local-posse.sh on $(date -Iseconds)

# Mode: 'single' for one agent, 'posse' for multi-agent
mode: ${MODE}

# Conductor's LLM model (for meta-tasks)
model: ${CONDUCTOR_MODEL}

# Server configuration
server:
  port: ${CONDUCTOR_PORT}
  host: 0.0.0.0

# Gateway configuration
gateway:
  http:
    enabled: true
    # Set auth token for API security (optional for local)
    # auth: \${CONDUCTOR_HTTP_AUTH}
  discord:
    enabled: ${DISCORD_ENABLED}
    token: \${DISCORD_BOT_TOKEN}

EOF

    if [[ "$MODE" == "single" ]]; then
        local agent_info="${AGENTS[0]}"
        IFS='|' read -r agent_name agent_url agent_model <<< "$agent_info"

        cat >> "$config_file" <<EOF
# Single agent configuration
agent:
  name: ${agent_name}
  url: ${agent_url}
  model: ${agent_model}

EOF
    else
        cat >> "$config_file" <<EOF
# Posse configuration
posse:
  name: ${POSSE_NAME}
  meilisearch:
    url: http://localhost:${MEILI_PORT}
    apiKey: \${MEILI_MASTER_KEY}
  discovery:
    enabled: true
    pollInterval: 30000

EOF
    fi

    cat >> "$config_file" <<EOF
# Routing configuration
routing:
  strategy: ${MODE == "single" && echo "explicit" || echo "auto"}
EOF

    log_success "Created $config_file"
}

generate_posse_config() {
    if [[ "$MODE" != "posse" ]]; then
        return 0
    fi

    log_info "Generating posse agent configurations..."

    local posse_config_file="$CONFIG_DIR/posse.config.yaml"

    cat > "$posse_config_file" <<EOF
# Posse Agent Definitions
# Generated by setup-local-posse.sh on $(date -Iseconds)

posse:
  name: ${POSSE_NAME}
  members:
EOF

    local agent_num=1
    for agent_info in "${AGENTS[@]}"; do
        IFS='|' read -r agent_name agent_url agent_model <<< "$agent_info"

        cat >> "$posse_config_file" <<EOF
    - name: ${agent_name}
      endpoint: ${agent_url}
      models:
        - ${agent_model}
      capabilities:
        - general
      weight: 1
EOF

        ((agent_num++))
    done

    log_success "Created $posse_config_file"
}

generate_env_file() {
    log_info "Generating environment file..."

    local env_file="$CONFIG_DIR/.env"

    if [[ -f "$env_file" ]]; then
        log_warn "$env_file already exists. Backing up to .env.backup"
        cp "$env_file" "$env_file.backup"
    fi

    # Generate random keys if not set
    local meili_key="${MEILI_MASTER_KEY:-$(openssl rand -hex 16 2>/dev/null || echo 'randal-local-key')}"
    local http_auth="${CONDUCTOR_HTTP_AUTH:-$(openssl rand -hex 32 2>/dev/null || echo '')}"

    cat > "$env_file" <<EOF
# Posse Conductor Environment Variables
# Generated by setup-local-posse.sh on $(date -Iseconds)

# Meilisearch
MEILI_MASTER_KEY=${meili_key}

# Conductor HTTP Auth (optional for local, recommended for production)
CONDUCTOR_HTTP_AUTH=${http_auth}

# Discord Bot Token (only if Discord gateway enabled)
DISCORD_BOT_TOKEN=${DISCORD_TOKEN}

# API Keys (add your own)
# ANTHROPIC_API_KEY=your_key_here
# OPENROUTER_API_KEY=your_key_here
EOF

    log_success "Created $env_file"
}

generate_docker_compose() {
    log_info "Generating Docker Compose for Meilisearch..."

    local compose_file="$CONFIG_DIR/docker-compose.yml"

    cat > "$compose_file" <<EOF
# Posse Conductor - Meilisearch Service
# Generated by setup-local-posse.sh on $(date -Iseconds)

version: '3.8'

services:
  meilisearch:
    image: getmeili/meilisearch:v1.7
    container_name: randal-posse-meilisearch
    ports:
      - "${MEILI_PORT}:7700"
    environment:
      - MEILI_MASTER_KEY=\${MEILI_MASTER_KEY}
    volumes:
      - ${MEILI_DATA_DIR}:/meili_data
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:7700/health"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  meili_data:
EOF

    log_success "Created $compose_file"
}

# ============================================================================
# Launch Sequence
# ============================================================================

start_meilisearch() {
    log_info "Starting Meilisearch..."

    mkdir -p "$MEILI_DATA_DIR"

    # Check if already running
    if curl -sf "http://localhost:${MEILI_PORT}/health" > /dev/null 2>&1; then
        log_success "Meilisearch already running on port ${MEILI_PORT}"
        return 0
    fi

    # Load env vars
    set -a
    source "$CONFIG_DIR/.env"
    set +a

    # Start via docker compose
    docker compose -f "$CONFIG_DIR/docker-compose.yml" up -d

    # Wait for health
    log_info "Waiting for Meilisearch to be ready..."
    local retries=30
    while [[ $retries -gt 0 ]]; do
        if curl -sf "http://localhost:${MEILI_PORT}/health" > /dev/null 2>&1; then
            log_success "Meilisearch is healthy!"
            return 0
        fi
        sleep 1
        ((retries--))
        echo -n "."
    done

    log_error "Meilisearch failed to start within 30 seconds"
    docker compose -f "$CONFIG_DIR/docker-compose.yml" logs --tail=50
    return 1
}

start_conductor() {
    log_info "Starting Posse Conductor..."

    cd "$REPO_DIR"

    # Export config path
    export CONDUCTOR_CONFIG_PATH="$CONFIG_DIR/conductor.config.yaml"

    # Load env vars
    set -a
    source "$CONFIG_DIR/.env"
    set +a

    # Build conductor if needed
    log_info "Building conductor..."
    bun run --cwd packages/conductor typecheck || log_warn "Type check had issues, continuing..."

    # Start conductor in background
    log_info "Launching conductor on port ${CONDUCTOR_PORT}..."
    bun run packages/conductor/src/index.ts &
    CONDUCTOR_PID=$!

    # Wait a moment for startup
    sleep 2

    # Check if process is running
    if ! kill -0 $CONDUCTOR_PID 2>/dev/null; then
        log_error "Conductor failed to start"
        return 1
    fi

    log_success "Conductor started (PID: $CONDUCTOR_PID)"
}

start_agents() {
    if [[ "$MODE" == "single" ]]; then
        log_info "Single mode: no additional agents to start"
        return 0
    fi

    log_info "Starting posse agents..."

    local agent_num=1
    for agent_info in "${AGENTS[@]}"; do
        IFS='|' read -r agent_name agent_url agent_model <<< "$agent_info"

        # Extract port from URL
        local agent_port
        agent_port=$(echo "$agent_url" | grep -oE '[0-9]+' | tail -1)

        log_info "Starting agent '$agent_name' on port $agent_port..."

        # TODO: Implement actual agent startup
        # For now, this is a placeholder that assumes agents are started separately
        log_warn "Agent startup not yet implemented. Start agents manually:"
        echo "  randal serve --port $agent_port --name $agent_name"

        ((agent_num++))
    done
}

display_dashboard() {
    echo ""
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║                    🎉 Setup Complete!                        ║"
    echo "╚══════════════════════════════════════════════════════════════╝"
    echo ""
    echo "  Conductor URL:    http://localhost:${CONDUCTOR_PORT}"
    echo "  Meilisearch URL:  http://localhost:${MEILI_PORT}"
    echo "  Config Directory: ${CONFIG_DIR}"
    echo ""
    echo "  Status Check:"
    echo "    curl http://localhost:${CONDUCTOR_PORT}/health"
    echo ""

    if [[ "$MODE" == "posse" ]]; then
        echo "  Posse: ${POSSE_NAME}"
        echo "  Agents: ${#AGENTS[@]}"
        echo ""
    fi

    echo "  Useful Commands:"
    echo "    View logs:     tail -f /tmp/randal-conductor.log"
    echo "    Stop all:      docker compose -f ${CONFIG_DIR}/docker-compose.yml down"
    echo "    Config file:   cat ${CONFIG_DIR}/conductor.config.yaml"
    echo ""
    echo "  Press Ctrl+C to stop the Conductor"
    echo ""
}

# ============================================================================
# Cleanup Handler
# ============================================================================

cleanup() {
    echo ""
    log_info "Shutting down Posse Conductor..."

    # Kill conductor process
    if [[ -n "${CONDUCTOR_PID:-}" ]]; then
        kill $CONDUCTOR_PID 2>/dev/null || true
        log_info "Stopped conductor (PID: $CONDUCTOR_PID)"
    fi

    # Stop Meilisearch
    log_info "Stopping Meilisearch..."
    docker compose -f "$CONFIG_DIR/docker-compose.yml" down 2>/dev/null || true

    log_success "Cleanup complete"
    exit 0
}

# ============================================================================
# Main
# ============================================================================

parse_args() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            --config-dir)
                CONFIG_DIR="$2"
                shift 2
                ;;
            --skip-deps)
                SKIP_DEPS=true
                shift
                ;;
            --non-interactive)
                INTERACTIVE=false
                shift
                ;;
            --help)
                echo "Posse Conductor Local Setup"
                echo ""
                echo "Usage: $0 [options]"
                echo ""
                echo "Options:"
                echo "  --config-dir DIR    Configuration directory (default: ~/.config/randal-posse)"
                echo "  --skip-deps         Skip dependency checks"
                echo "  --non-interactive   Use defaults without prompting"
                echo "  --help              Show this help message"
                exit 0
                ;;
            *)
                log_error "Unknown option: $1"
                exit 1
                ;;
        esac
    done
}

main() {
    parse_args "$@"

    # Set up cleanup handler
    trap cleanup INT TERM EXIT

    # Run setup steps
    check_prerequisites || exit 1
    run_wizard
    generate_conductor_config
    generate_posse_config
    generate_env_file
    generate_docker_compose

    # Start services
    start_meilisearch || exit 1
    start_conductor || exit 1
    start_agents

    # Display status
    display_dashboard

    # Wait for Ctrl+C
    wait
}

main "$@"
