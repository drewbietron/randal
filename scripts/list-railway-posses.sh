#!/usr/bin/env bash
set -euo pipefail

# List Railway Posses
# This script lists all Randal posses deployed to Railway

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Helper functions
log_info() {
  echo -e "${BLUE}[INFO]${NC} $1"
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $1"
}

# Check dependencies
check_dependencies() {
  if ! command -v railway &> /dev/null; then
    log_error "Railway CLI not found. Install with: npm install -g @railway/cli"
    exit 1
  fi
  
  if ! command -v jq &> /dev/null; then
    log_error "jq not found. Install with: brew install jq"
    exit 1
  fi
}

# List all Railway projects
list_projects() {
  log_info "Fetching Railway projects..."
  
  # Get all projects (Railway CLI doesn't have a native list command, so we work around it)
  # This assumes projects follow the naming convention: randal-posse-*
  
  railway whoami > /dev/null 2>&1 || {
    log_error "Not logged in to Railway. Run: railway login"
    exit 1
  }
  
  echo ""
  echo -e "${GREEN}=== Railway Posses ===${NC}"
  echo ""
  
  # Note: Railway CLI doesn't provide a direct way to list all projects
  # Users will need to use the Railway dashboard or API
  echo "To view all your Railway posses:"
  echo "  1. Visit: https://railway.app/dashboard"
  echo "  2. Look for projects starting with 'randal-posse-'"
  echo ""
  echo "Or use the Railway API:"
  echo "  railway api query 'query { projects { edges { node { id name createdAt } } } }'"
  echo ""
  
  # Try to read local deployment summaries
  local summary_files=(railway-posse-*-deployment.json)
  
  if [ -e "${summary_files[0]}" ]; then
    echo -e "${BLUE}Local Deployment Summaries:${NC}"
    echo ""
    
    for file in railway-posse-*-deployment.json; do
      [ -e "$file" ] || continue
      
      local posse_name=$(jq -r '.posse_name' "$file")
      local deployed_at=$(jq -r '.deployed_at' "$file")
      local railway_project=$(jq -r '.railway_project' "$file")
      local agent_count=$(jq -r '.agents | length' "$file")
      
      echo "  Posse: $posse_name"
      echo "    Project: $railway_project"
      echo "    Agents: $agent_count"
      echo "    Deployed: $deployed_at"
      echo "    Summary: $file"
      echo ""
    done
  else
    echo "No local deployment summaries found."
    echo ""
  fi
}

# Main execution
main() {
  check_dependencies
  list_projects
}

main
