#!/bin/bash
#
# set-railway-env.sh
# Script to set Railway environment variables from .env file (without deploying)
#
# Usage:
#   ./scripts/set-railway-env.sh [options]
#
# Options:
#   --env-file <path>   Use a different env file (default: .env)
#   --required <vars>   Comma-separated list of required variables
#   -v, --verbose       Show verbose output
#   -h, --help          Show this help message
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
VERBOSE=false
REQUIRED_VARS=""

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

log_verbose() {
    if [[ "$VERBOSE" == true ]]; then
        echo -e "${BLUE}[VERBOSE]${NC} $1"
    fi
}

# Show usage information
show_usage() {
    cat << EOF
Railway Environment Variable Setup Script

Usage: $0 [options]

Options:
  --env-file <path>   Use a different env file (default: .env)
  --required <vars>   Comma-separated list of required variables to validate
  -v, --verbose       Show verbose output
  -h, --help          Show this help message

Default Required Variables:
  OPENROUTER_API_KEY or ANTHROPIC_API_KEY
  RANDAL_API_TOKEN
  MEILI_MASTER_KEY

Examples:
  $0                                    # Set all variables from .env
  $0 --env-file .env.production         # Use production env file
  $0 --required "API_KEY,SECRET_TOKEN"  # Validate specific vars exist
  $0 -v                                 # Verbose mode

EOF
}

# Parse command line arguments
parse_args() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            --env-file)
                ENV_FILE="$2"
                shift 2
                ;;
            --required)
                REQUIRED_VARS="$2"
                shift 2
                ;;
            -v|--verbose)
                VERBOSE=true
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

    # Convert relative path to absolute if needed
    if [[ ! "$ENV_FILE" = /* ]]; then
        ENV_FILE="$PROJECT_ROOT/$ENV_FILE"
    fi
}

# Check if railway CLI is installed
check_railway_cli() {
    if ! command -v railway &> /dev/null; then
        log_error "Railway CLI is not installed"
        echo "Install it with: npm install -g @railway/cli"
        echo "Or visit: https://docs.railway.app/develop/cli"
        exit 1
    fi
    log_verbose "Railway CLI found: $(railway --version)"
}

# Check if .env file exists
check_env_file() {
    if [[ ! -f "$ENV_FILE" ]]; then
        log_error ".env file not found at $ENV_FILE"
        echo "Please create a .env file based on .env.example"
        exit 1
    fi
    log_success "Found env file: $ENV_FILE"
}

# Validate that we're in a Railway project
validate_railway_project() {
    log_info "Validating Railway connection..."
    if ! railway status &> /dev/null; then
        log_error "Not connected to Railway or not authenticated"
        echo "Please run: railway login"
        echo "Then link your project: railway link"
        exit 1
    fi
    log_success "Railway connection verified"
}

# Validate required variables exist in .env
validate_required_vars() {
    local missing_vars=()

    # Check for API keys - at least one of these should exist
    local has_openrouter=$(grep -E "^OPENROUTER_API_KEY=" "$ENV_FILE" | grep -v "^OPENROUTER_API_KEY=$" || true)
    local has_anthropic=$(grep -E "^ANTHROPIC_API_KEY=" "$ENV_FILE" | grep -v "^ANTHROPIC_API_KEY=$" || true)

    if [[ -z "$has_openrouter" && -z "$has_anthropic" ]]; then
        missing_vars+=("OPENROUTER_API_KEY or ANTHROPIC_API_KEY")
    fi

    # Check other critical variables
    local critical_vars=("RANDAL_API_TOKEN" "MEILI_MASTER_KEY")
    for var in "${critical_vars[@]}"; do
        local value=$(grep -E "^${var}=" "$ENV_FILE" | cut -d'=' -f2 || true)
        if [[ -z "$value" ]]; then
            missing_vars+=("$var")
        fi
    done

    # Check user-specified required variables
    if [[ -n "$REQUIRED_VARS" ]]; then
        IFS=',' read -ra custom_vars <<< "$REQUIRED_VARS"
        for var in "${custom_vars[@]}"; do
            var=$(echo "$var" | xargs) # trim whitespace
            local value=$(grep -E "^${var}=" "$ENV_FILE" | cut -d'=' -f2 || true)
            if [[ -z "$value" ]]; then
                missing_vars+=("$var")
            fi
        done
    fi

    if [[ ${#missing_vars[@]} -gt 0 ]]; then
        log_error "Missing required environment variables:"
        for var in "${missing_vars[@]}"; do
            echo "  - $var"
        done
        echo ""
        echo "Please set these variables in your .env file"
        exit 1
    fi

    log_success "All required variables found"
}

# Set environment variables in Railway
set_env_variables() {
    log_info "Setting Railway environment variables..."
    echo ""

    local count=0
    local skipped=0
    local failed=0
    local vars_set=()
    local vars_skipped=()
    local vars_failed=()

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

        # Skip empty values
        if [[ -z "$var_value" ]]; then
            log_verbose "Skipping empty variable: $var_name"
            ((skipped++))
            vars_skipped+=("$var_name")
            continue
        fi

        log_info "Setting: $var_name"

        if railway variable set "${var_name}=${var_value}" &> /dev/null; then
            ((count++))
            vars_set+=("$var_name")
            log_verbose "Successfully set $var_name"
        else
            ((failed++))
            vars_failed+=("$var_name")
            log_error "Failed to set $var_name"
        fi
    done < "$ENV_FILE"

    echo ""
    echo "========================================"
    echo "  Summary"
    echo "========================================"
    echo -e "${GREEN}Set:${NC}     $count variables"
    echo -e "${YELLOW}Skipped:${NC} $skipped variables (empty)"
    echo -e "${RED}Failed:${NC}  $failed variables"
    echo ""

    if [[ ${#vars_set[@]} -gt 0 ]]; then
        echo "Variables set:"
        printf '  - %s\n' "${vars_set[@]}"
        echo ""
    fi

    if [[ ${#vars_skipped[@]} -gt 0 && "$VERBOSE" == true ]]; then
        echo "Variables skipped (empty):"
        printf '  - %s\n' "${vars_skipped[@]}"
        echo ""
    fi

    if [[ ${#vars_failed[@]} -gt 0 ]]; then
        echo "Variables failed:"
        printf '  - %s\n' "${vars_failed[@]}"
        echo ""
        exit 1
    fi

    log_success "Environment variables setup complete!"
}

# Main function
main() {
    echo "========================================"
    echo "  Railway Environment Setup"
    echo "========================================"
    echo ""

    parse_args "$@"

    # Pre-flight checks
    check_railway_cli
    check_env_file
    validate_required_vars
    validate_railway_project

    echo ""

    # Set variables
    set_env_variables

    echo ""
    log_info "You can now deploy with: ./scripts/deploy-railway.sh"
    log_info "Or view variables with: railway variable list"
}

# Run main function
cd "$PROJECT_ROOT" || exit 1
main "$@"
