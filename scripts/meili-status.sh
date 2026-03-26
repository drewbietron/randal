#!/bin/bash
cd "$(dirname "$0")/.."

echo "Meilisearch status:"
docker compose -f docker-compose.meili.yml ps
curl -sf http://localhost:7701/health || echo "Health check failed"
