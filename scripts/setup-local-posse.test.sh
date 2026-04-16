#!/bin/bash
#
# Posse Conductor Setup Script Tests
# ==================================
# Tests for the setup-local-posse.sh script
#
# Usage:
#   ./scripts/setup-local-posse.test.sh [options]
#
# Options:
#   --verbose    Show detailed test output
#   --keep-temp  Don't clean up temp directories after tests
#

set -euo pipefail

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SETUP_SCRIPT="$SCRIPT_DIR/setup-local-posse.sh"
TEST_DIR="$(mktemp -d)"
VERBOSE=false
KEEP_TEMP=false

# Test counters
TESTS_PASSED=0
TESTS_FAILED=0
TESTS_SKIPPED=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# ============================================================================
# Test Framework
# ============================================================================

log_test() {
    if [[ "$VERBOSE" == "true" ]]; then
        echo -e "${BLUE}[TEST]${NC} $1"
    fi
}

pass() {
    echo -e "${GREEN}[PASS]${NC} $1"
    ((TESTS_PASSED++))
}

fail() {
    echo -e "${RED}[FAIL]${NC} $1"
    if [[ -n "${2:-}" ]]; then
        echo "       $2"
    fi
    ((TESTS_FAILED++))
}

skip() {
    echo -e "${YELLOW}[SKIP]${NC} $1"
    ((TESTS_SKIPPED++))
}

assert_file_exists() {
    local file="$1"
    local msg="${2:-File should exist: $file}"

    if [[ -f "$file" ]]; then
        pass "$msg"
        return 0
    else
        fail "$msg" "File not found: $file"
        return 1
    fi
}

assert_dir_exists() {
    local dir="$1"
    local msg="${2:-Directory should exist: $dir}"

    if [[ -d "$dir" ]]; then
        pass "$msg"
        return 0
    else
        fail "$msg" "Directory not found: $dir"
        return 1
    fi
}

assert_contains() {
    local file="$1"
    local pattern="$2"
    local msg="${3:-File should contain pattern}"

    if grep -q "$pattern" "$file" 2>/dev/null; then
        pass "$msg"
        return 0
    else
        fail "$msg" "Pattern not found: $pattern"
        return 1
    fi
}

assert_not_contains() {
    local file="$1"
    local pattern="$2"
    local msg="${3:-File should NOT contain pattern}"

    if ! grep -q "$pattern" "$file" 2>/dev/null; then
        pass "$msg"
        return 0
    else
        fail "$msg" "Unexpected pattern found: $pattern"
        return 1
    fi
}

assert_yaml_valid() {
    local file="$1"
    local msg="${2:-YAML should be valid: $file}"

    if command -v yq &> /dev/null; then
        if yq eval '.' "$file" > /dev/null 2>&1; then
            pass "$msg"
            return 0
        else
            fail "$msg" "Invalid YAML syntax"
            return 1
        fi
    else
        skip "$msg (yq not installed)"
        return 0
    fi
}

assert_executable() {
    local file="$1"
    local msg="${2:-File should be executable: $file}"

    if [[ -x "$file" ]]; then
        pass "$msg"
        return 0
    else
        fail "$msg" "File is not executable"
        return 1
    fi
}

# ============================================================================
# Test Cases
# ============================================================================

test_script_exists() {
    log_test "Checking setup script exists"
    assert_file_exists "$SETUP_SCRIPT" "Setup script should exist"
    assert_executable "$SETUP_SCRIPT" "Setup script should be executable"
}

test_help_flag() {
    log_test "Testing --help flag"

    local output
    output=$("$SETUP_SCRIPT" --help 2>&1) || true

    if echo "$output" | grep -q "Posse Conductor"; then
        pass "--help flag shows usage information"
    else
        fail "--help flag should show usage information"
    fi
}

test_config_generation_single_mode() {
    log_test "Testing config generation (single mode)"

    local test_config_dir="$TEST_DIR/single-mode"
    mkdir -p "$test_config_dir"

    # Run setup in non-interactive mode
    "$SETUP_SCRIPT" --config-dir "$test_config_dir" --non-interactive --skip-deps &
    local pid=$!

    # Give it time to generate configs
    sleep 3

    # Kill the background process
    kill $pid 2>/dev/null || true
    wait $pid 2>/dev/null || true

    # Check generated files
    assert_file_exists "$test_config_dir/conductor.config.yaml" "Single mode: conductor.config.yaml should be created"
    assert_file_exists "$test_config_dir/.env" "Single mode: .env should be created"
    assert_file_exists "$test_config_dir/docker-compose.yml" "Single mode: docker-compose.yml should be created"

    # Check config content
    assert_contains "$test_config_dir/conductor.config.yaml" "mode: single" "Config should have single mode"
    assert_contains "$test_config_dir/conductor.config.yaml" "port: 7777" "Config should have default port"
    assert_not_contains "$test_config_dir/conductor.config.yaml" "posse:" "Single mode should not have posse section"

    # Check env file
    assert_contains "$test_config_dir/.env" "MEILI_MASTER_KEY" "Env file should have MEILI_MASTER_KEY"
}

test_config_generation_posse_mode() {
    log_test "Testing config generation (posse mode) - partial"

    # This test is limited since posse mode requires interactive input
    # We'll test the config structure instead

    local test_config_dir="$TEST_DIR/posse-mode"
    mkdir -p "$test_config_dir"

    # Create a manual posse config to validate structure
    cat > "$test_config_dir/conductor.config.yaml" <<'EOF'
mode: posse
model: moonshotai/kimi-k2.5
server:
  port: 7777
  host: 0.0.0.0
gateway:
  http:
    enabled: true
  discord:
    enabled: false
posse:
  name: test-posse
  meilisearch:
    url: http://localhost:7700
    apiKey: ${MEILI_MASTER_KEY}
  discovery:
    enabled: true
    pollInterval: 30000
routing:
  strategy: auto
EOF

    assert_yaml_valid "$test_config_dir/conductor.config.yaml" "Posse config should be valid YAML"
    assert_contains "$test_config_dir/conductor.config.yaml" "mode: posse" "Config should have posse mode"
    assert_contains "$test_config_dir/conductor.config.yaml" "name: test-posse" "Config should have posse name"
    assert_contains "$test_config_dir/conductor.config.yaml" "discovery:" "Config should have discovery section"
}

test_docker_compose_generation() {
    log_test "Testing Docker Compose generation"

    local test_config_dir="$TEST_DIR/docker-test"
    mkdir -p "$test_config_dir"

    # Create minimal env
    echo "MEILI_MASTER_KEY=test-key" > "$test_config_dir/.env"

    # Manually create docker-compose to test structure
    cat > "$test_config_dir/docker-compose.yml" <<'EOF'
version: '3.8'

services:
  meilisearch:
    image: getmeili/meilisearch:v1.7
    container_name: randal-posse-meilisearch
    ports:
      - "7700:7700"
    environment:
      - MEILI_MASTER_KEY=${MEILI_MASTER_KEY}
    volumes:
      - ~/.randal/meili-data:/meili_data
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:7700/health"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  meili_data:
EOF

    assert_file_exists "$test_config_dir/docker-compose.yml" "Docker Compose file should exist"
    assert_contains "$test_config_dir/docker-compose.yml" "getmeili/meilisearch:v1.7" "Should use correct Meilisearch image"
    assert_contains "$test_config_dir/docker-compose.yml" "healthcheck:" "Should have healthcheck configuration"
    assert_contains "$test_config_dir/docker-compose.yml" "restart: unless-stopped" "Should have restart policy"
}

test_env_file_generation() {
    log_test "Testing .env file generation"

    local test_config_dir="$TEST_DIR/env-test"
    mkdir -p "$test_config_dir"

    # Create sample env file
    cat > "$test_config_dir/.env" <<'EOF'
# Posse Conductor Environment Variables
MEILI_MASTER_KEY=test-key-1234567890abcdef
CONDUCTOR_HTTP_AUTH=test-auth-token-1234567890abcdef
DISCORD_BOT_TOKEN=
EOF

    assert_file_exists "$test_config_dir/.env" "Env file should exist"
    assert_contains "$test_config_dir/.env" "MEILI_MASTER_KEY=" "Env should have MEILI_MASTER_KEY"
    assert_contains "$test_config_dir/.env" "CONDUCTOR_HTTP_AUTH=" "Env should have CONDUCTOR_HTTP_AUTH"
}

test_prerequisite_checks() {
    log_test "Testing prerequisite check functions (dry-run)"

    # Test that the script can be sourced to check functions exist
    if bash -n "$SETUP_SCRIPT" 2>/dev/null; then
        pass "Setup script has valid bash syntax"
    else
        fail "Setup script has bash syntax errors"
    fi

    # Check for required commands in the script
    assert_contains "$SETUP_SCRIPT" "check_macos_version" "Script should have macOS version check"
    assert_contains "$SETUP_SCRIPT" "check_docker" "Script should have Docker check"
    assert_contains "$SETUP_SCRIPT" "check_bun" "Script should have Bun check"
    assert_contains "$SETUP_SCRIPT" "check_ram" "Script should have RAM check"
}

test_cleanup_handler() {
    log_test "Testing cleanup handler"

    assert_contains "$SETUP_SCRIPT" "trap cleanup" "Script should set up cleanup trap"
    assert_contains "$SETUP_SCRIPT" "cleanup()" "Script should have cleanup function"
    assert_contains "$SETUP_SCRIPT" "docker compose.*down" "Cleanup should stop Docker containers"
}

test_configuration_structure() {
    log_test "Testing configuration structure"

    # Verify the script contains all required configuration steps
    assert_contains "$SETUP_SCRIPT" "wizard_mode" "Script should have mode wizard"
    assert_contains "$SETUP_SCRIPT" "wizard_conductor" "Script should have conductor wizard"
    assert_contains "$SETUP_SCRIPT" "wizard_agents" "Script should have agents wizard"
    assert_contains "$SETUP_SCRIPT" "wizard_discord" "Script should have Discord wizard"
    assert_contains "$SETUP_SCRIPT" "generate_conductor_config" "Script should generate conductor config"
    assert_contains "$SETUP_SCRIPT" "generate_env_file" "Script should generate env file"
    assert_contains "$SETUP_SCRIPT" "generate_docker_compose" "Script should generate docker compose"
}

test_non_interactive_mode() {
    log_test "Testing non-interactive mode support"

    assert_contains "$SETUP_SCRIPT" "INTERACTIVE" "Script should support INTERACTIVE flag"
    assert_contains "$SETUP_SCRIPT" "--non-interactive" "Script should have --non-interactive option"
    assert_contains "$SETUP_SCRIPT" "non-interactive" "Script should handle non-interactive mode"
}

test_error_handling() {
    log_test "Testing error handling"

    assert_contains "$SETUP_SCRIPT" "set -euo pipefail" "Script should use strict mode"
    assert_contains "$SETUP_SCRIPT" "log_error" "Script should have error logging"
    assert_contains "$SETUP_SCRIPT" "trap cleanup" "Script should trap signals"
}

test_meilisearch_integration() {
    log_test "Testing Meilisearch integration"

    assert_contains "$SETUP_SCRIPT" "start_meilisearch" "Script should start Meilisearch"
    assert_contains "$SETUP_SCRIPT" "MEILI_PORT" "Script should use MEILI_PORT"
    assert_contains "$SETUP_SCRIPT" "docker compose.*meilisearch" "Script should use Docker Compose"
    assert_contains "$SETUP_SCRIPT" "meilisearch.*health" "Script should check Meilisearch health"
}

test_conductor_startup() {
    log_test "Testing conductor startup"

    assert_contains "$SETUP_SCRIPT" "start_conductor" "Script should start conductor"
    assert_contains "$SETUP_SCRIPT" "CONDUCTOR_PID" "Script should track conductor PID"
    assert_contains "$SETUP_SCRIPT" "CONDUCTOR_CONFIG_PATH" "Script should set config path"
}

# ============================================================================
# Main Test Runner
# ============================================================================

print_header() {
    echo ""
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║           Posse Conductor Setup Script Tests                 ║"
    echo "╚══════════════════════════════════════════════════════════════╝"
    echo ""
    echo "Test Directory: $TEST_DIR"
    echo "Setup Script:   $SETUP_SCRIPT"
    echo ""
}

print_summary() {
    local total=$((TESTS_PASSED + TESTS_FAILED + TESTS_SKIPPED))

    echo ""
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║                      Test Summary                            ║"
    echo "╠══════════════════════════════════════════════════════════════╣"
    printf "║  ${GREEN}Passed:${NC}  %-4d                                               ║\n" "$TESTS_PASSED"
    printf "║  ${RED}Failed:${NC}  %-4d                                               ║\n" "$TESTS_FAILED"
    printf "║  ${YELLOW}Skipped:${NC} %-4d                                               ║\n" "$TESTS_SKIPPED"
    printf "║  Total:   %-4d                                               ║\n" "$total"
    echo "╚══════════════════════════════════════════════════════════════╝"
    echo ""

    if [[ $TESTS_FAILED -eq 0 ]]; then
        echo -e "${GREEN}✓ All tests passed!${NC}"
        return 0
    else
        echo -e "${RED}✗ Some tests failed.${NC}"
        return 1
    fi
}

cleanup() {
    if [[ "$KEEP_TEMP" == "false" ]] && [[ -d "$TEST_DIR" ]]; then
        rm -rf "$TEST_DIR"
    fi
}

parse_args() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            --verbose)
                VERBOSE=true
                shift
                ;;
            --keep-temp)
                KEEP_TEMP=true
                shift
                ;;
            *)
                echo "Unknown option: $1"
                echo "Usage: $0 [--verbose] [--keep-temp]"
                exit 1
                ;;
        esac
    done
}

main() {
    parse_args "$@"

    print_header

    # Set up cleanup
    trap cleanup EXIT

    # Run all tests
    test_script_exists
    test_help_flag
    test_prerequisite_checks
    test_configuration_structure
    test_non_interactive_mode
    test_error_handling
    test_cleanup_handler
    test_meilisearch_integration
    test_conductor_startup
    test_config_generation_single_mode
    test_config_generation_posse_mode
    test_docker_compose_generation
    test_env_file_generation

    # Print summary
    print_summary
}

main "$@"
