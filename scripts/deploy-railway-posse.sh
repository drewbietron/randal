#!/usr/bin/env bash
set -euo pipefail

# Deploy Railway Multi-Project Posse
# Deploys a full Randal posse to Railway: one project with Meilisearch + N agent services

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Configuration
POSSE_CONFIG=""
POSSE_NAME=""
RAILWAY_PROJECT_NAME=""
RAILWAY_WORKSPACE=""
MEILISEARCH_MASTER_KEY=""
MEILISEARCH_PRIVATE_URL=""
DRY_RUN=false

# Parse command line arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --config)
      POSSE_CONFIG="$2"
      shift 2
      ;;
    --name)
      POSSE_NAME="$2"
      shift 2
      ;;
    --workspace)
      RAILWAY_WORKSPACE="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --help)
      echo "Usage: $0 --name NAME [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --name NAME           Posse name (required)"
      echo "  --config FILE         Path to posse configuration YAML (default: examples/railway-posse/full-company.yaml)"
      echo "  --workspace WORKSPACE Railway workspace ID or name (optional, will prompt if not provided)"
      echo "  --dry-run             Print commands without executing"
      echo "  --help                Show this help message"
      echo ""
      echo "Examples:"
      echo "  $0 --name my-posse --config examples/railway-posse/full-company.yaml"
      echo "  $0 --name my-posse --config examples/railway-posse/full-company.yaml --dry-run"
      exit 0
      ;;
    *)
      # Legacy positional arg support
      if [ -z "$POSSE_CONFIG" ]; then
        POSSE_CONFIG="$1"
      fi
      shift
      ;;
  esac
done

# Default config if not provided
POSSE_CONFIG="${POSSE_CONFIG:-examples/railway-posse/full-company.yaml}"

# Helper functions
log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warning() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

run_cmd() {
  if [ "$DRY_RUN" = true ]; then
    echo -e "${YELLOW}[DRY RUN]${NC} $*"
  else
    "$@"
  fi
}

# Check dependencies
check_dependencies() {
  log_info "Checking dependencies..."
  local missing=()
  command -v railway &>/dev/null || missing+=("railway (npm i -g @railway/cli)")
  command -v yq &>/dev/null     || missing+=("yq (brew install yq)")
  command -v jq &>/dev/null     || missing+=("jq (brew install jq)")

  if [ ${#missing[@]} -gt 0 ]; then
    log_error "Missing dependencies:"
    printf '  - %s\n' "${missing[@]}"
    exit 1
  fi
  log_success "All dependencies found"
}

# Parse posse configuration
parse_config() {
  log_info "Parsing configuration: $POSSE_CONFIG"

  if [ ! -f "$POSSE_CONFIG" ]; then
    log_error "Config file not found: $POSSE_CONFIG"
    exit 1
  fi

  if [ -z "$POSSE_NAME" ]; then
    POSSE_NAME=$(yq eval '.posse.name' "$POSSE_CONFIG")
  fi

  if [ -z "$POSSE_NAME" ] || [ "$POSSE_NAME" = "null" ]; then
    log_error "Posse name required. Use --name or set posse.name in config."
    exit 1
  fi

  RAILWAY_PROJECT_NAME="randal-posse-${POSSE_NAME}"
  log_success "Posse: $POSSE_NAME → Railway project: $RAILWAY_PROJECT_NAME"
}

# Create Railway project (non-interactive)
create_railway_project() {
  log_info "Creating Railway project: $RAILWAY_PROJECT_NAME"
  if [ -n "$RAILWAY_WORKSPACE" ]; then
    run_cmd railway init --name "$RAILWAY_PROJECT_NAME" --workspace "$RAILWAY_WORKSPACE"
  else
    run_cmd railway init --name "$RAILWAY_PROJECT_NAME"
  fi
  log_success "Railway project created"
}

# Generate Meilisearch master key
generate_meilisearch_key() {
  MEILISEARCH_MASTER_KEY=$(openssl rand -base64 32 | tr -d "=+/" | cut -c1-32)
  log_success "Generated Meilisearch master key"
}

# Deploy Meilisearch service
deploy_meilisearch() {
  log_info "Deploying Meilisearch service..."

  # Create service from Docker image (non-interactive — name and vars passed inline)
  run_cmd railway add --image getmeili/meilisearch:v1.12 \
    -v MEILI_MASTER_KEY="$MEILISEARCH_MASTER_KEY" \
    -v MEILI_ENV=production \
    -v MEILI_NO_ANALYTICS=true

  if [ "$DRY_RUN" = false ]; then
    log_info "Waiting for Meilisearch to initialize..."
    sleep 15

    # Meilisearch private URL uses Railway's internal networking
    MEILISEARCH_PRIVATE_URL="meilisearch.railway.internal"
    log_success "Meilisearch deployed (private: $MEILISEARCH_PRIVATE_URL)"
  fi
}

# Deploy a single agent service
deploy_agent() {
  local agent_name=$1
  local agent_config=$2

  local role=$(echo "$agent_config" | yq eval '.role' -)
  local specialization=$(echo "$agent_config" | yq eval '.specialization' -)
  local expertise=$(echo "$agent_config" | yq eval '.expertise | join(",")' -)

  log_info "Deploying agent: $agent_name (${role})"

  # Create empty service with explicit name (non-interactive)
  run_cmd railway add --service "$agent_name"

  # Set environment variables targeting this service
  run_cmd railway variable set \
    AGENT_NAME="$agent_name" \
    AGENT_ROLE="$role" \
    AGENT_EXPERTISE="$expertise" \
    AGENT_SPECIALIZATION="$specialization" \
    RANDAL_SKIP_MEILISEARCH="true" \
    MEILISEARCH_URL="\${{meilisearch.RAILWAY_PRIVATE_DOMAIN}}" \
    MEILISEARCH_MASTER_KEY="$MEILISEARCH_MASTER_KEY" \
    MEILI_MASTER_KEY="$MEILISEARCH_MASTER_KEY" \
    PORT="7600" \
    -s "$agent_name"

  # Set API key if available in environment
  if [ -n "${OPENROUTER_API_KEY:-}" ]; then
    run_cmd railway variable set OPENROUTER_API_KEY="$OPENROUTER_API_KEY" -s "$agent_name"
  elif [ -n "${ANTHROPIC_API_KEY:-}" ]; then
    run_cmd railway variable set ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" -s "$agent_name"
  else
    log_warning "  No API key in environment. Set OPENROUTER_API_KEY or ANTHROPIC_API_KEY manually."
  fi

  # Deploy the Randal Docker image to this service
  run_cmd railway up -d -s "$agent_name"

  # Generate public domain for gateway access
  log_info "Generating public domain for $agent_name..."
  run_cmd railway domain -s "$agent_name"

  log_success "Agent $agent_name deployed"
}

# Deploy all agents from config (non-interactive)
deploy_agents() {
  local agent_count=$(yq eval '.agents | length' "$POSSE_CONFIG")
  log_info "Deploying $agent_count agents..."
  echo ""

  for ((i=0; i<agent_count; i++)); do
    local agent_config=$(yq eval ".agents[$i]" "$POSSE_CONFIG")
    local agent_name=$(echo "$agent_config" | yq eval '.name' -)
    deploy_agent "$agent_name" "$agent_config"
    echo ""
  done

  log_success "All $agent_count agents deployed"
}

# Create deployment summary
create_summary() {
  local summary_file="railway-posse-${POSSE_NAME}-deployment.json"

  cat > "$summary_file" <<EOF
{
  "posse_name": "$POSSE_NAME",
  "railway_project": "$RAILWAY_PROJECT_NAME",
  "deployed_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "meilisearch": {
    "private_url": "${MEILISEARCH_PRIVATE_URL:-meilisearch.railway.internal}",
    "master_key": "$MEILISEARCH_MASTER_KEY"
  },
  "agents": $(yq eval '.agents | map(.name)' "$POSSE_CONFIG" -o=json)
}
EOF

  log_success "Deployment summary saved to: $summary_file"
  echo ""
  log_warning "IMPORTANT: Store the Meilisearch master key securely!"
  log_warning "Master key: $MEILISEARCH_MASTER_KEY"
}

# Print next steps with actual URLs
print_next_steps() {
  echo ""
  echo -e "${GREEN}=== Deployment Complete ===${NC}"
  echo ""
  echo "Your Railway posse '$POSSE_NAME' is now deployed!"
  echo ""
  echo "Next steps:"
  echo "  1. Open the Railway dashboard to verify all services:"
  echo "     railway open"
  echo "  2. View logs for a specific agent:"
  echo "     railway logs -s <agent-name>"
  echo "  3. Check Meilisearch health (from within Railway private network):"
  echo "     Meilisearch is accessible internally at: ${MEILISEARCH_PRIVATE_URL:-meilisearch.railway.internal}"
  echo ""
  echo "Management commands:"
  echo "  - List posses: ./scripts/list-railway-posses.sh"
  echo "  - Delete posse: ./scripts/delete-railway-posse.sh $POSSE_NAME"
  echo ""
}

# Main execution
main() {
  echo -e "${BLUE}=== Railway Multi-Project Posse Deployment ===${NC}"
  echo ""

  check_dependencies
  parse_config
  create_railway_project
  generate_meilisearch_key
  deploy_meilisearch
  deploy_agents
  create_summary
  print_next_steps

  log_success "Deployment complete!"
}

main
