#!/usr/bin/env bash
set -euo pipefail

# Deploy Railway Multi-Project Posse
# This script deploys a full Randal posse to Railway with Meilisearch and multiple specialized agents

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default configuration
POSSE_CONFIG="${1:-examples/railway-posse/full-company.yaml}"
POSSE_NAME=""
RAILWAY_PROJECT_NAME=""
MEILISEARCH_MASTER_KEY=""
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
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --help)
      echo "Usage: $0 [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --config FILE       Path to posse configuration YAML (default: examples/railway-posse/full-company.yaml)"
      echo "  --name NAME         Posse name (default: extracted from config)"
      echo "  --dry-run          Print commands without executing"
      echo "  --help             Show this help message"
      exit 0
      ;;
    *)
      POSSE_CONFIG="$1"
      shift
      ;;
  esac
done

# Helper functions
log_info() {
  echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
  echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
  echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $1"
}

run_command() {
  if [ "$DRY_RUN" = true ]; then
    echo -e "${YELLOW}[DRY RUN]${NC} $*"
  else
    "$@"
  fi
}

# Check dependencies
check_dependencies() {
  log_info "Checking dependencies..."
  
  local missing_deps=()
  
  if ! command -v railway &> /dev/null; then
    missing_deps+=("railway")
  fi
  
  if ! command -v yq &> /dev/null; then
    missing_deps+=("yq")
  fi
  
  if ! command -v jq &> /dev/null; then
    missing_deps+=("jq")
  fi
  
  if [ ${#missing_deps[@]} -gt 0 ]; then
    log_error "Missing required dependencies: ${missing_deps[*]}"
    echo ""
    echo "Please install:"
    for dep in "${missing_deps[@]}"; do
      case $dep in
        railway)
          echo "  - Railway CLI: npm install -g @railway/cli"
          ;;
        yq)
          echo "  - yq: brew install yq (or see https://github.com/mikefarah/yq)"
          ;;
        jq)
          echo "  - jq: brew install jq"
          ;;
      esac
    done
    exit 1
  fi
  
  log_success "All dependencies found"
}

# Parse posse configuration
parse_config() {
  log_info "Parsing posse configuration: $POSSE_CONFIG"
  
  if [ ! -f "$POSSE_CONFIG" ]; then
    log_error "Configuration file not found: $POSSE_CONFIG"
    exit 1
  fi
  
  # Extract posse name
  if [ -z "$POSSE_NAME" ]; then
    POSSE_NAME=$(yq eval '.posse.name' "$POSSE_CONFIG")
  fi
  
  if [ -z "$POSSE_NAME" ] || [ "$POSSE_NAME" = "null" ]; then
    log_error "Could not determine posse name from configuration"
    exit 1
  fi
  
  RAILWAY_PROJECT_NAME="randal-posse-${POSSE_NAME}"
  
  log_success "Posse name: $POSSE_NAME"
  log_info "Railway project name: $RAILWAY_PROJECT_NAME"
}

# Create Railway project
create_railway_project() {
  log_info "Creating Railway project: $RAILWAY_PROJECT_NAME"
  
  # Check if project already exists
  if run_command railway status 2>/dev/null | grep -q "$RAILWAY_PROJECT_NAME"; then
    log_warning "Project $RAILWAY_PROJECT_NAME already exists"
    read -p "Do you want to continue with the existing project? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
      log_info "Aborted by user"
      exit 0
    fi
  else
    run_command railway init --name "$RAILWAY_PROJECT_NAME"
  fi
  
  log_success "Railway project ready"
}

# Generate Meilisearch master key
generate_meilisearch_key() {
  log_info "Generating Meilisearch master key..."
  
  # Generate a secure random key
  MEILISEARCH_MASTER_KEY=$(openssl rand -base64 32 | tr -d "=+/" | cut -c1-32)
  
  log_success "Generated Meilisearch master key"
}

# Deploy Meilisearch service
deploy_meilisearch() {
  log_info "Deploying Meilisearch service..."
  
  # Resource config (memory/CPU) must be set via Railway dashboard or API, not CLI/TOML
  log_info "Note: Resource limits (CPU/memory) must be configured in the Railway dashboard"
  
  # Add Meilisearch as a Docker image service (creates service + deploys image)
  run_command railway add --image getmeili/meilisearch:v1.12
  
  # Set environment variables for the meilisearch service
  run_command railway variable set MEILI_MASTER_KEY="$MEILISEARCH_MASTER_KEY" -s meilisearch
  run_command railway variable set MEILI_ENV=production -s meilisearch
  run_command railway variable set MEILI_NO_ANALYTICS=true -s meilisearch
  
  # Meilisearch is internal-only — use private networking, no public domain needed
  # Other services reference it via ${{meilisearch.RAILWAY_PRIVATE_DOMAIN}}
  
  if [ "$DRY_RUN" = false ]; then
    log_info "Waiting for Meilisearch to be healthy..."
    sleep 10
    log_success "Meilisearch deployed (accessible via private networking)"
  fi
}

# Deploy agent
deploy_agent() {
  local agent_name=$1
  local agent_config=$2
  
  log_info "Deploying agent: $agent_name"
  
  # Extract agent configuration
  local role=$(echo "$agent_config" | yq eval '.role' -)
  local specialization=$(echo "$agent_config" | yq eval '.specialization' -)
  local expertise=$(echo "$agent_config" | yq eval '.expertise | join(",")' -)
  
  log_info "  Role: $role"
  log_info "  Specialization: $specialization"
  
  # Create empty service for agent
  run_command railway add --service "$agent_name"
  
  # Set environment variables for this service
  run_command railway variable set AGENT_NAME="$agent_name" -s "$agent_name"
  run_command railway variable set AGENT_ROLE="$role" -s "$agent_name"
  run_command railway variable set AGENT_EXPERTISE="$expertise" -s "$agent_name"
  run_command railway variable set AGENT_SPECIALIZATION="$specialization" -s "$agent_name"
  # Cross-service reference to Meilisearch via Railway private networking
  run_command railway variable set 'MEILISEARCH_HOST=${{meilisearch.RAILWAY_PRIVATE_DOMAIN}}' -s "$agent_name"
  run_command railway variable set MEILISEARCH_MASTER_KEY="$MEILISEARCH_MASTER_KEY" -s "$agent_name"
  
  # Set OpenRouter API key (assumes it's set in current environment)
  if [ -n "${OPENROUTER_API_KEY:-}" ]; then
    run_command railway variable set OPENROUTER_API_KEY="$OPENROUTER_API_KEY" -s "$agent_name"
  else
    log_warning "OPENROUTER_API_KEY not set in environment. Remember to set it manually."
  fi
  
  # Deploy current directory's Dockerfile to this service
  # railway.toml controls the build config (builder, Dockerfile path, etc.)
  run_command railway up -d -s "$agent_name"
  
  log_success "Agent $agent_name deployed"
}

# Deploy all agents
deploy_agents() {
  log_info "Deploying agents..."
  
  # Get number of agents
  local agent_count=$(yq eval '.agents | length' "$POSSE_CONFIG")
  log_info "Found $agent_count agents to deploy"
  
  # Deploy each agent
  for ((i=0; i<agent_count; i++)); do
    local agent_config=$(yq eval ".agents[$i]" "$POSSE_CONFIG")
    local agent_name=$(echo "$agent_config" | yq eval '.name' -)
    
    deploy_agent "$agent_name" "$agent_config"
  done
  
  log_success "All agents deployed"
}

# Create deployment summary
create_summary() {
  log_info "Creating deployment summary..."
  
  local summary_file="railway-posse-${POSSE_NAME}-deployment.json"
  
  cat > "$summary_file" <<EOF
{
  "posse_name": "$POSSE_NAME",
  "railway_project": "$RAILWAY_PROJECT_NAME",
  "deployed_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "meilisearch": {
    "networking": "private (use \${{meilisearch.RAILWAY_PRIVATE_DOMAIN}} for cross-service access)",
    "master_key": "$MEILISEARCH_MASTER_KEY"
  },
  "agents": $(yq eval '.agents | map(.name)' "$POSSE_CONFIG" -o=json)
}
EOF
  
  log_success "Deployment summary saved to: $summary_file"
  echo ""
  log_warning "IMPORTANT: Store the Meilisearch master key securely!"
  echo ""
}

# Print next steps
print_next_steps() {
  echo ""
  echo -e "${GREEN}=== Deployment Complete ===${NC}"
  echo ""
  echo "Your Railway posse is now deployed!"
  echo ""
  echo "Next steps:"
  echo "  1. Verify all services are running: railway status"
  echo "  2. Check Meilisearch health: curl https://\$MEILISEARCH_URL/health"
  echo "  3. View logs: railway logs --service <service-name>"
  echo "  4. Test agent communication by sending a task"
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

# Run main function
main
