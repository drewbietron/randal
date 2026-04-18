#!/bin/bash
# tests/integration/smoke.sh
# Railway integration smoke tests — run against a live deployment.
# Usage: BASE_URL=https://... AUTH_TOKEN=xxx ./smoke.sh

# Strict mode for setup only — individual tests handle errors via test_case()
set -uo pipefail

PASS=0
FAIL=0
LAST_BODY=""  # stash last response for diagnostics

test_case() {
  local name="$1"
  local result="$2" # 0 = pass, non-zero = fail
  if [ "$result" -eq 0 ]; then
    echo "  PASS  $name"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $name"
    if [ -n "$LAST_BODY" ]; then
      echo "        ↳ response: ${LAST_BODY:0:200}"
    fi
    FAIL=$((FAIL + 1))
  fi
}

# Retry-aware curl wrapper — retries up to 2 times on transient failures
rcurl() {
  curl --retry 2 --retry-delay 1 --retry-all-errors "$@"
}

# Validate required env vars
if [ -z "${BASE_URL:-}" ] || [ -z "${AUTH_TOKEN:-}" ]; then
  echo "ERROR: BASE_URL and AUTH_TOKEN must be set"
  echo "Usage: BASE_URL=https://... AUTH_TOKEN=xxx $0"
  exit 2
fi

AUTH="Authorization: Bearer $AUTH_TOKEN"

echo "Running smoke tests against $BASE_URL"
echo "========================================"

# 1. Health check (public — no auth)
LAST_BODY=$(rcurl -sf "$BASE_URL/health" || true)
echo "$LAST_BODY" | jq -e '.status == "ok"' > /dev/null 2>&1
test_case "GET /health returns status ok" $?

# 2. Instance info
LAST_BODY=$(rcurl -sf -H "$AUTH" "$BASE_URL/instance" 2>/dev/null || true)
echo "$LAST_BODY" | jq -e '.name' > /dev/null 2>&1
test_case "GET /instance returns name" $?

# 3. Submit job
JOB_RESP=$(rcurl -sf -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"prompt":"echo hello"}' "$BASE_URL/job" || true)
JOB_ID=$(echo "$JOB_RESP" | jq -r '.id' 2>/dev/null || true)
LAST_BODY="$JOB_RESP"
test_case "POST /job returns job ID" $([ -n "$JOB_ID" ] && [ "$JOB_ID" != "null" ] && echo 0 || echo 1)

# 4. Get job (only if we got a valid job ID)
if [ -n "$JOB_ID" ] && [ "$JOB_ID" != "null" ]; then
  LAST_BODY=$(rcurl -sf -H "$AUTH" "$BASE_URL/job/$JOB_ID" 2>/dev/null || true)
  echo "$LAST_BODY" | jq -e '.id' > /dev/null 2>&1
  test_case "GET /job/:id returns job" $?
else
  LAST_BODY="no job ID from previous step"
  test_case "GET /job/:id returns job" 1
fi

# 5. List jobs — use -w to capture HTTP status alongside body
JOBS_TMP=$(mktemp)
JOBS_HTTP=$(rcurl -s -o "$JOBS_TMP" -w "%{http_code}" -H "$AUTH" "$BASE_URL/jobs" 2>/dev/null || true)
LAST_BODY="HTTP $JOBS_HTTP: $(cat "$JOBS_TMP" | head -c 200)"
if [ "$JOBS_HTTP" = "200" ]; then
  cat "$JOBS_TMP" | jq -e 'type == "array"' > /dev/null 2>&1
  test_case "GET /jobs returns array" $?
else
  test_case "GET /jobs returns array" 1
fi
rm -f "$JOBS_TMP"

# 6. Posse (single instance — should 404)
POSSE_STATUS=$(rcurl -s -o /dev/null -w "%{http_code}" -H "$AUTH" "$BASE_URL/posse" || true)
LAST_BODY="HTTP $POSSE_STATUS"
test_case "GET /posse returns 404 (no posse)" $([ "$POSSE_STATUS" = "404" ] && echo 0 || echo 1)

# 7. Scheduler status
LAST_BODY=$(rcurl -sf -H "$AUTH" "$BASE_URL/scheduler" 2>/dev/null || true)
echo "$LAST_BODY" | jq -e '.' > /dev/null 2>&1
test_case "GET /scheduler returns JSON" $?

# 8. Cron — create
LAST_BODY=$(rcurl -sf -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"name":"ci-test","schedule":{"every":"1h"},"prompt":"test"}' \
  "$BASE_URL/cron" 2>/dev/null || true)
echo "$LAST_BODY" | jq -e '.ok == true' > /dev/null 2>&1
test_case "POST /cron creates job" $?

# Small delay to let the cron job register before listing/deleting
sleep 1

# 9. Cron — list — accepts bare array or object wrapping one
CRON_TMP=$(mktemp)
CRON_HTTP=$(rcurl -s -o "$CRON_TMP" -w "%{http_code}" -H "$AUTH" "$BASE_URL/cron" 2>/dev/null || true)
LAST_BODY="HTTP $CRON_HTTP: $(cat "$CRON_TMP" | head -c 200)"
if [ "$CRON_HTTP" = "200" ]; then
  cat "$CRON_TMP" | jq -e 'if type == "array" then true elif type == "object" then (.jobs // .crons // empty) | type == "array" else false end' > /dev/null 2>&1
  test_case "GET /cron returns array" $?
else
  test_case "GET /cron returns array" 1
fi
rm -f "$CRON_TMP"

# 10. Cron — delete
DEL_TMP=$(mktemp)
DEL_HTTP=$(rcurl -s -o "$DEL_TMP" -w "%{http_code}" -X DELETE -H "$AUTH" "$BASE_URL/cron/ci-test" 2>/dev/null || true)
LAST_BODY="HTTP $DEL_HTTP: $(cat "$DEL_TMP" | head -c 200)"
if [ "$DEL_HTTP" = "200" ]; then
  cat "$DEL_TMP" | jq -e '.ok == true' > /dev/null 2>&1
  test_case "DELETE /cron/:name removes job" $?
else
  test_case "DELETE /cron/:name removes job" 1
fi
rm -f "$DEL_TMP"

# 11. Config (sanitized)
LAST_BODY=$(rcurl -sf -H "$AUTH" "$BASE_URL/config" 2>/dev/null || true)
echo "$LAST_BODY" | jq -e '.runner.defaultAgent' > /dev/null 2>&1
test_case "GET /config returns sanitized config" $?

# 12. SSE events — submit a job, then connect and verify we receive the event.
# Railway's proxy buffers small SSE frames (like keep-alive pings), so we need
# real event data to flush through. We submit a quick job and wait for its event.
SSE_PASS=1
LAST_BODY=""
SSE_TMP=$(mktemp)
SSE_JOB_RESP=$(rcurl -sf -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"prompt":"sse-smoke-test"}' "$BASE_URL/job" 2>/dev/null || true)
SSE_JOB_ID=$(echo "$SSE_JOB_RESP" | jq -r '.id' 2>/dev/null || true)
if [ -n "$SSE_JOB_ID" ] && [ "$SSE_JOB_ID" != "null" ]; then
  curl -s -N -H "$AUTH" "$BASE_URL/events" > "$SSE_TMP" 2>/dev/null &
  SSE_PID=$!
  sleep 30
  kill $SSE_PID 2>/dev/null
  wait $SSE_PID 2>/dev/null
  if grep -q "event:" "$SSE_TMP" 2>/dev/null; then
    SSE_PASS=0
  else
    LAST_BODY="no SSE events received in 30s"
  fi
fi
rm -f "$SSE_TMP"
test_case "GET /events streams SSE" $SSE_PASS

# Results
echo ""
echo "========================================"
echo "Results: $PASS passed, $FAIL failed (of $((PASS + FAIL)) tests)"
echo "========================================"
[ "$FAIL" -eq 0 ]
