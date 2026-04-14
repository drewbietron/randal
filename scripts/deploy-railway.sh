#!/bin/bash
#
# deploy-railway.sh
# Deployment script for Railway that sets environment variables and deploys
#
# Usage:
#   ./scripts/deploy-railway.sh [options]
#
# Options:
#   --dry-run    Preview what would be set without actually deploying
#   -h, --help   Show this help message
#
# Requirements:
#   - Railway CLI must be installed and authenticated
#   - .env file must exist in project root
#   - Must be run from project root or scripts directory
#

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Configuration
ENV_FILE="$PROJECT_ROOT/.env"
DRY_RUN=false

# Logging functions
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

# Show usage information
show_usage() {
    cat << EOF
Railway Deployment Script

Usage: $0 [options]

Options:
  --dry-run    Preview what would be set without actually deploying
  -h, --help   Show this help message

Environment:
  The script reads variables from .env file in the project root.

Required Tools:
  - railway CLI must be installed
  - Must be logged in to Railway (railway login)

Examples:
  $0                    # Deploy with environment variables
  $0 --dry-run          # Preview what would be set
  $0 --help             # Show this help

EOF
}

# Parse command line arguments
parse_args() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            --dry-run)
                DRY_RUN=true
                shift
                ;;
            -h|--help)
                show_usage
                exit 0
                ;;
            *)
                log_error "Unknown option: $1"
                show_usage
                exit 1
                ;;
        esac
    done
}

# Check if railway CLI is installed
check_railway_cli() {
    if ! command -v railway &> /dev/null; then
        log_error "Railway CLI is not installed"
        echo "Install it with: npm install -g @railway/cli"
        echo "Or visit: https://docs.railway.app/develop/cli"
        exit 1
    fi
    log_success "Railway CLI found"
}

# Check if .env file exists
check_env_file() {
    if [[ ! -f "$ENV_FILE" ]]; then
        log_error ".env file not found at $ENV_FILE"
        echo "Please create a .env file based on .env.example"
        exit 1
    fi
    log_success "Found .env file"
}

# Ensure we're linked to a Railway project (auto init+link if needed)
ensure_railway_project() {
    # Check if already linked (has .railway/ directory)
    if [[ -d "$PROJECT_ROOT/.railway" ]]; then
        log_success "Railway project already linked (.railway/ found)"
        return 0
    fi

    log_warning "No .railway/ directory found — not linked to a Railway project"

    if [[ "$DRY_RUN" == true ]]; then
        log_info "[DRY-RUN] Would prompt to init/link Railway project"
        return 0
    fi

    echo ""
    echo "Would you like to:"
    echo "  1) Create a new Railway project (railway init)"
    echo "  2) Link to an existing Railway project (railway link)"
    echo "  3) Abort"
    echo ""
    read -rp "Choose [1/2/3]: " choice

    case "$choice" in
        1)
            log_info "Creating new Railway project..."
            railway init --name "$(basename "$PROJECT_ROOT")"
            log_success "Railway project created"
            ;;
        2)
            log_info "Linking to existing Railway project..."
            railway link
            log_success "Railway project linked"
            ;;
        *)
            log_info "Aborted by user"
            exit 0
            ;;
    esac
}

# Read and set environment variables
set_env_variables() {
    log_info "Reading environment variables from .env..."

    local count=0
    local vars_set=()

    # Read .env file line by line
    while IFS= read -r line || [[ -n "$line" ]]; do
        # Skip empty lines and comments
        [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue

        # Skip lines that don't look like VAR=value
        [[ ! "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] && continue

        # Extract variable name and value
        local var_name="${line%%=*}"
        local var_value="${line#*=}"

        # Remove optional quotes around value
        var_value="${var_value%\"}"
        var_value="${var_value#\"}"
        var_value="${var_value%\'}"
        var_value="${var_value#\'}"

        # Skip empty values (optional variables)
        if [[ -z "$var_value" ]]; then
            log_warning "Skipping empty variable: $var_name"
            continue
        fi

        if [[ "$DRY_RUN" == true ]]; then
            log_info "[DRY-RUN] Would set: $var_name=***"
        else
            log_info "Setting: $var_name"
            if railway variable set "${var_name}=${var_value}"; then
                vars_set+=("$var_name")
                ((count++))
            else
                log_error "Failed to set $var_name"
            fi
        fi
    done < "$ENV_FILE"

    if [[ "$DRY_RUN" == true ]]; then
        log_info "[DRY-RUN] Would set $count variables"
    else
        log_success "Successfully set $count environment variables"
        if [[ ${#vars_set[@]} -gt 0 ]]; then
            log_info "Variables set: ${vars_set[*]}"
        fi
    fi

    return 0
}

# Deploy to Railway
deploy() {
    if [[ "$DRY_RUN" == true ]]; then
        log_info "[DRY-RUN] Would run: railway up"
        log_info "[DRY-RUN] Deployment preview complete"
        return 0
    fi

    log_info "Starting Railway deployment..."
    if railway up; then
        log_success "Deployment completed successfully!"
        echo ""
        echo "Your app is now live on Railway!"
        railway status
    else
        log_error "Deployment failed"
        exit 1
    fi
}

# Main function
main() {
    echo "========================================"
    echo "  Railway Deployment Script"
    echo "========================================"
    echo ""

    parse_args "$@"

    if [[ "$DRY_RUN" == true ]]; then
        log_warning "DRY RUN MODE - No changes will be made"
        echo ""
    fi

    # Pre-deployment checks
    check_railway_cli
    check_env_file
    ensure_railway_project

    echo ""
    log_info "Starting deployment process..."
    echo ""

    # Set environment variables
    set_env_variables

    echo ""

    # Deploy
    deploy

    echo ""
    log_success "All done!"
}

# Run main function
cd "$PROJECT_ROOT" || exit 1
main "$@"
