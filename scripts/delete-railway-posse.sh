#!/usr/bin/env bash
set -euo pipefail

# Delete Railway Posse
# This script deletes a Randal posse from Railway

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

POSSE_NAME="${1:-}"
DRY_RUN=false
FORCE=false

# Parse command line arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --force)
      FORCE=true
      shift
      ;;
    --help)
      echo "Usage: $0 POSSE_NAME [OPTIONS]"
      echo ""
      echo "Arguments:"
      echo "  POSSE_NAME         Name of the posse to delete"
      echo ""
      echo "Options:"
      echo "  --dry-run         Print what would be deleted without actually deleting"
      echo "  --force           Skip confirmation prompts"
      echo "  --help            Show this help message"
      exit 0
      ;;
    *)
      POSSE_NAME="$1"
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
  if ! command -v railway &> /dev/null; then
    log_error "Railway CLI not found. Install with: npm install -g @railway/cli"
    exit 1
  fi
}

# Validate input
validate_input() {
  if [ -z "$POSSE_NAME" ]; then
    log_error "Posse name is required"
    echo ""
    echo "Usage: $0 POSSE_NAME [OPTIONS]"
    echo "Use --help for more information"
    exit 1
  fi
  
  log_info "Posse to delete: $POSSE_NAME"
}

# Confirm deletion
confirm_deletion() {
  if [ "$FORCE" = true ]; then
    return 0
  fi
  
  echo ""
  log_warning "This will permanently delete the Railway project and all its services!"
  log_warning "Project name: randal-posse-${POSSE_NAME}"
  echo ""
  read -p "Are you sure you want to continue? Type 'yes' to confirm: " -r
  echo ""
  
  if [ "$REPLY" != "yes" ]; then
    log_info "Deletion cancelled by user"
    exit 0
  fi
}

# Delete Railway project
delete_project() {
  local project_name="randal-posse-${POSSE_NAME}"
  
  log_info "Deleting Railway project: $project_name"
  
  # Note: Railway CLI doesn't have a direct delete command
  # Users need to delete via the dashboard or API
  echo ""
  log_warning "Railway CLI doesn't support project deletion via command line"
  echo ""
  echo "To delete this project:"
  echo "  1. Visit: https://railway.app/dashboard"
  echo "  2. Find project: $project_name"
  echo "  3. Go to project settings"
  echo "  4. Click 'Delete Project'"
  echo ""
  echo "Or use the Railway API:"
  echo "  railway api mutation 'mutation { projectDelete(id: \"PROJECT_ID\") }'"
  echo ""
  
  if [ "$DRY_RUN" = false ]; then
    # Try to unlink local project
    if railway status 2>/dev/null | grep -q "$project_name"; then
      log_info "Unlinking local Railway project..."
      run_command railway unlink || true
      log_success "Local project unlinked"
    fi
  fi
}

# Clean up local files
cleanup_local_files() {
  log_info "Cleaning up local deployment files..."
  
  local summary_file="railway-posse-${POSSE_NAME}-deployment.json"
  
  if [ -f "$summary_file" ]; then
    run_command rm -f "$summary_file"
    log_success "Removed: $summary_file"
  else
    log_info "No local summary file found: $summary_file"
  fi
}

# Print summary
print_summary() {
  echo ""
  echo -e "${GREEN}=== Deletion Summary ===${NC}"
  echo ""
  echo "Posse name: $POSSE_NAME"
  echo "Railway project: randal-posse-${POSSE_NAME}"
  echo ""
  
  if [ "$DRY_RUN" = true ]; then
    log_info "This was a dry run. No changes were made."
  else
    log_warning "Remember to delete the Railway project via the dashboard or API"
  fi
  
  echo ""
}

# Main execution
main() {
  echo -e "${BLUE}=== Railway Posse Deletion ===${NC}"
  echo ""
  
  check_dependencies
  validate_input
  confirm_deletion
  delete_project
  cleanup_local_files
  print_summary
  
  log_success "Deletion process complete"
}

main
