#!/bin/bash
set -e
cd "$(dirname "$0")/.."

echo "Starting Meilisearch (docker compose)..."
MEILI_MASTER_KEY=${MEILI_MASTER_KEY:-randal-local-key} \
  docker compose -f docker-compose.meili.yml up -d

# Wait for health
for i in {1..10}; do
  if curl -sf http://localhost:7701/health > /dev/null 2>&1; then
    echo "Meilisearch is running on http://localhost:7701"
    exit 0
  fi
  sleep 1
  echo "Waiting for Meilisearch... ($i/10)"
done

echo "Meilisearch did not become healthy. Check logs:"
docker compose -f docker-compose.meili.yml logs --tail=50
exit 1
