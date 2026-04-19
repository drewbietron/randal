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
COOKIE_JAR=$(mktemp)

cleanup() {
  rm -f "$COOKIE_JAR"
}

trap cleanup EXIT

echo "Running smoke tests against $BASE_URL"
echo "========================================"

# 1. Health check (public — no auth)
LAST_BODY=$(rcurl -sf "$BASE_URL/health" || true)
echo "$LAST_BODY" | jq -e '.status == "ok"' > /dev/null 2>&1
test_case "GET /health returns status ok" $?

# 2. Public dashboard root
ROOT_TMP=$(mktemp)
ROOT_HTTP=$(rcurl -s -o "$ROOT_TMP" -w "%{http_code}" "$BASE_URL/" 2>/dev/null || true)
LAST_BODY="HTTP $ROOT_HTTP: $(cat "$ROOT_TMP" | head -c 200)"
if [ "$ROOT_HTTP" = "200" ]; then
  grep -qi "Randal" "$ROOT_TMP"
  test_case "GET / loads public dashboard" $?
else
  test_case "GET / loads public dashboard" 1
fi
rm -f "$ROOT_TMP"

# 3. Exchange bearer token for session cookie
SESSION_BODY=$(rcurl -sf -c "$COOKIE_JAR" -X POST -H "$AUTH" "$BASE_URL/auth/session" 2>/dev/null || true)
LAST_BODY="$SESSION_BODY"
COOKIE_PRESENT=$(grep -c "randal_session" "$COOKIE_JAR" 2>/dev/null || true)
echo "$SESSION_BODY" | jq -e '.ok == true' > /dev/null 2>&1 && [ "$COOKIE_PRESENT" -gt 0 ]
test_case "POST /auth/session sets session cookie" $?

# 4. Instance info via cookie-backed auth
LAST_BODY=$(rcurl -sf -b "$COOKIE_JAR" "$BASE_URL/instance" 2>/dev/null || true)
echo "$LAST_BODY" | jq -e '.name' > /dev/null 2>&1
test_case "GET /instance returns name via session cookie" $?

# 5. Jobs list via cookie-backed auth
COOKIE_JOBS=$(rcurl -sf -b "$COOKIE_JAR" "$BASE_URL/jobs" 2>/dev/null || true)
LAST_BODY="$COOKIE_JOBS"
echo "$COOKIE_JOBS" | jq -e 'type == "array"' > /dev/null 2>&1
test_case "GET /jobs returns array via session cookie" $?

# 6. Posse status via cookie-backed auth
POSSE_TMP=$(mktemp)
POSSE_HTTP=$(rcurl -s -o "$POSSE_TMP" -w "%{http_code}" -b "$COOKIE_JAR" "$BASE_URL/posse" 2>/dev/null || true)
LAST_BODY="HTTP $POSSE_HTTP: $(dd if="$POSSE_TMP" bs=200 count=1 2>/dev/null)"
if [ "$POSSE_HTTP" = "200" ]; then
  jq -e '.self and (.agents | type == "array")' "$POSSE_TMP" > /dev/null 2>&1
  test_case "GET /posse returns JSON via session cookie" $?
elif [ "$POSSE_HTTP" = "404" ]; then
  test_case "GET /posse returns JSON via session cookie" 0
else
  test_case "GET /posse returns JSON via session cookie" 1
fi
rm -f "$POSSE_TMP"

# 7. Posse jobs via cookie-backed auth
POSSE_JOBS_TMP=$(mktemp)
POSSE_JOBS_HTTP=$(rcurl -s -o "$POSSE_JOBS_TMP" -w "%{http_code}" -b "$COOKIE_JAR" "$BASE_URL/posse/jobs" 2>/dev/null || true)
LAST_BODY="HTTP $POSSE_JOBS_HTTP: $(dd if="$POSSE_JOBS_TMP" bs=200 count=1 2>/dev/null)"
if [ "$POSSE_JOBS_HTTP" = "200" ]; then
  jq -e '.jobs | type == "array"' "$POSSE_JOBS_TMP" > /dev/null 2>&1
  test_case "GET /posse/jobs returns JSON via session cookie" $?
elif [ "$POSSE_JOBS_HTTP" = "404" ]; then
  test_case "GET /posse/jobs returns JSON via session cookie" 0
else
  test_case "GET /posse/jobs returns JSON via session cookie" 1
fi
rm -f "$POSSE_JOBS_TMP"

# 8. Mesh status via cookie-backed auth
COOKIE_MESH=$(rcurl -sf -b "$COOKIE_JAR" "$BASE_URL/mesh/status" 2>/dev/null || true)
LAST_BODY="$COOKIE_MESH"
echo "$COOKIE_MESH" | jq -e '.instances | type == "array"' > /dev/null 2>&1
test_case "GET /mesh/status returns JSON via session cookie" $?

# 9. Scheduler status via cookie-backed auth
LAST_BODY=$(rcurl -sf -b "$COOKIE_JAR" "$BASE_URL/scheduler" 2>/dev/null || true)
echo "$LAST_BODY" | jq -e '.' > /dev/null 2>&1
test_case "GET /scheduler returns JSON via session cookie" $?

# 10. Submit job
JOB_RESP=$(rcurl -sf -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"prompt":"echo hello"}' "$BASE_URL/job" || true)
JOB_ID=$(echo "$JOB_RESP" | jq -r '.id' 2>/dev/null || true)
LAST_BODY="$JOB_RESP"
test_case "POST /job returns job ID" $([ -n "$JOB_ID" ] && [ "$JOB_ID" != "null" ] && echo 0 || echo 1)

# 11. Get job (only if we got a valid job ID)
if [ -n "$JOB_ID" ] && [ "$JOB_ID" != "null" ]; then
  LAST_BODY=$(rcurl -sf -H "$AUTH" "$BASE_URL/job/$JOB_ID" 2>/dev/null || true)
  echo "$LAST_BODY" | jq -e '.id' > /dev/null 2>&1
  test_case "GET /job/:id returns job" $?
else
  LAST_BODY="no job ID from previous step"
  test_case "GET /job/:id returns job" 1
fi

# 12. List jobs — use -w to capture HTTP status alongside body
JOBS_TMP=$(mktemp)
JOBS_HTTP=$(rcurl -s -o "$JOBS_TMP" -w "%{http_code}" -H "$AUTH" "$BASE_URL/jobs" 2>/dev/null || true)
if [ "$JOBS_HTTP" != "200" ] && grep -qiE "Application not found|request_id" "$JOBS_TMP" 2>/dev/null; then
  sleep 2
  JOBS_HTTP=$(rcurl -s -o "$JOBS_TMP" -w "%{http_code}" -H "$AUTH" "$BASE_URL/jobs" 2>/dev/null || true)
fi
LAST_BODY="HTTP $JOBS_HTTP: $(dd if="$JOBS_TMP" bs=200 count=1 2>/dev/null)"
if [ "$JOBS_HTTP" = "200" ]; then
  jq -e 'type == "array"' "$JOBS_TMP" > /dev/null 2>&1
  test_case "GET /jobs returns array" $?
else
  test_case "GET /jobs returns array" 1
fi
rm -f "$JOBS_TMP"

# 13. Posse (single instance — should 404)
POSSE_STATUS=$(rcurl -s -o /dev/null -w "%{http_code}" -H "$AUTH" "$BASE_URL/posse" || true)
LAST_BODY="HTTP $POSSE_STATUS"
test_case "GET /posse returns 404 (no posse)" $([ "$POSSE_STATUS" = "404" ] && echo 0 || echo 1)

# 14. Scheduler status
LAST_BODY=$(rcurl -sf -H "$AUTH" "$BASE_URL/scheduler" 2>/dev/null || true)
echo "$LAST_BODY" | jq -e '.' > /dev/null 2>&1
test_case "GET /scheduler returns JSON" $?

# 15. Cron — create
LAST_BODY=$(rcurl -sf -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"name":"ci-test","schedule":{"every":"1h"},"prompt":"test"}' \
  "$BASE_URL/cron" 2>/dev/null || true)
echo "$LAST_BODY" | jq -e '.ok == true' > /dev/null 2>&1
test_case "POST /cron creates job" $?

# Small delay to let the cron job register before listing/deleting
sleep 1

# 16. Cron — list — accepts bare array or object wrapping one
CRON_TMP=$(mktemp)
CRON_HTTP=$(rcurl -s -o "$CRON_TMP" -w "%{http_code}" -H "$AUTH" "$BASE_URL/cron" 2>/dev/null || true)
if [ "$CRON_HTTP" != "200" ] && grep -qiE "Application not found|request_id" "$CRON_TMP" 2>/dev/null; then
  sleep 2
  CRON_HTTP=$(rcurl -s -o "$CRON_TMP" -w "%{http_code}" -H "$AUTH" "$BASE_URL/cron" 2>/dev/null || true)
fi
LAST_BODY="HTTP $CRON_HTTP: $(dd if="$CRON_TMP" bs=200 count=1 2>/dev/null)"
if [ "$CRON_HTTP" = "200" ]; then
  jq -e 'if type == "array" then true elif type == "object" then (.jobs // .crons // empty) | type == "array" else false end' "$CRON_TMP" > /dev/null 2>&1
  test_case "GET /cron returns array" $?
else
  test_case "GET /cron returns array" 1
fi
rm -f "$CRON_TMP"

# 17. Cron — delete
# Railway's edge proxy can return transient 404 "Application not found" for
# DELETE requests shortly after other operations.  Retry once after a delay.
DEL_TMP=$(mktemp)
DEL_HTTP=$(rcurl -s -o "$DEL_TMP" -w "%{http_code}" -X DELETE -H "$AUTH" "$BASE_URL/cron/ci-test" 2>/dev/null || true)
if [ "$DEL_HTTP" != "200" ] && grep -qiE "Application not found|request_id" "$DEL_TMP" 2>/dev/null; then
  sleep 2
  DEL_HTTP=$(rcurl -s -o "$DEL_TMP" -w "%{http_code}" -X DELETE -H "$AUTH" "$BASE_URL/cron/ci-test" 2>/dev/null || true)
fi
LAST_BODY="HTTP $DEL_HTTP: $(cat "$DEL_TMP" | head -c 200)"
if [ "$DEL_HTTP" = "200" ]; then
  cat "$DEL_TMP" | jq -e '.ok == true' > /dev/null 2>&1
  test_case "DELETE /cron/:name removes job" $?
else
  test_case "DELETE /cron/:name removes job" 1
fi
rm -f "$DEL_TMP"

# 18. Config (sanitized)
LAST_BODY=$(rcurl -sf -H "$AUTH" "$BASE_URL/config" 2>/dev/null || true)
echo "$LAST_BODY" | jq -e '.runner.defaultAgent' > /dev/null 2>&1
test_case "GET /config returns sanitized config" $?

# 19. SSE events — verify a real GET can open the stream with the session cookie
# Railway may buffer event bodies, so validate the GET response status and SSE content type.
SSE_HEADERS_TMP=$(mktemp)
SSE_BODY_TMP=$(mktemp)
rcurl -sS -N --max-time 5 -D "$SSE_HEADERS_TMP" -o "$SSE_BODY_TMP" -b "$COOKIE_JAR" "$BASE_URL/events" 2>/dev/null || true
SSE_STATUS=$(awk 'toupper($1) ~ /^HTTP\// { code=$2 } END { print code ? code : "000" }' "$SSE_HEADERS_TMP")
SSE_TYPE=$(grep -i '^content-type:' "$SSE_HEADERS_TMP" | grep -i 'text/event-stream' || true)
LAST_BODY="HTTP $SSE_STATUS: $(dd if="$SSE_HEADERS_TMP" bs=200 count=1 2>/dev/null)"
test_case "GET /events opens SSE via session cookie" $([ "$SSE_STATUS" = "200" ] && [ -n "$SSE_TYPE" ] && echo 0 || echo 1)
rm -f "$SSE_HEADERS_TMP" "$SSE_BODY_TMP"

# Results
echo ""
echo "========================================"
echo "Results: $PASS passed, $FAIL failed (of $((PASS + FAIL)) tests)"
echo "========================================"
[ "$FAIL" -eq 0 ]
