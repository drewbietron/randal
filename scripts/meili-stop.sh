#!/bin/bash
set -e
cd "$(dirname "$0")/.."

echo "Stopping Meilisearch (docker compose)..."
docker compose -f docker-compose.meili.yml down
