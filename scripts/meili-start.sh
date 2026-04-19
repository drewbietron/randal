#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

LOCAL_MEILI_URL="http://localhost:7701"
COMPOSE_FILE="docker-compose.meili.yml"

echo "Starting Meilisearch (docker compose)..."
mkdir -p meili-data
MEILI_MASTER_KEY=${MEILI_MASTER_KEY:-randal-local-key} \
  docker compose -f "$COMPOSE_FILE" up -d

# Wait for health
HEALTHY=false
for i in {1..10}; do
  if curl -sf "$LOCAL_MEILI_URL/health" > /dev/null 2>&1; then
    echo "Meilisearch is running on $LOCAL_MEILI_URL"
    HEALTHY=true
    break
  fi
  sleep 1
  echo "Waiting for Meilisearch... ($i/10)"
done

if [ "$HEALTHY" != "true" ]; then
  echo "❌ Meilisearch did not become healthy. Check logs:"
  docker compose -f "$COMPOSE_FILE" logs --tail=50
  exit 1
fi

# Validate API key authentication
echo "Validating API key..."
MEILI_KEY="${MEILI_MASTER_KEY:-randal-local-key}"
HTTP_CODE=$(curl -sf -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $MEILI_KEY" \
  "$LOCAL_MEILI_URL/indexes" 2>/dev/null || true)

if [ "$HTTP_CODE" = "200" ]; then
  echo "✅ API key validated — Meilisearch is ready"
elif [ "$HTTP_CODE" = "401" ] || [ "$HTTP_CODE" = "403" ]; then
  echo "❌ API key validation failed (HTTP $HTTP_CODE — authentication rejected)"
  echo ""
  echo "   The MEILI_MASTER_KEY used by clients does not match the key Meilisearch started with."
  echo ""
  echo "   MEILI_MASTER_KEY in environment: ${MEILI_KEY:0:8}... (${#MEILI_KEY} chars)"
  echo "   Docker container key: set via MEILI_MASTER_KEY in docker-compose.meili.yml"
  echo ""
  echo "   To fix:"
  echo "   1. Ensure MEILI_MASTER_KEY in .env matches the key in docker-compose.meili.yml"
  echo "   2. Restart: docker compose -f docker-compose.meili.yml down && docker compose -f docker-compose.meili.yml up -d"
  exit 1
else
  echo "❌ API key validation failed (HTTP $HTTP_CODE — unexpected response)"
  echo ""
  echo "   Could not verify API key against $LOCAL_MEILI_URL/indexes"
  echo "   Expected HTTP 200, got: ${HTTP_CODE:-no response}"
  echo ""
  echo "   Check Meilisearch logs: docker compose -f $COMPOSE_FILE logs --tail=50"
  exit 1
fi
