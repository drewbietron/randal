#!/bin/bash
set -e

# ──────────────────────────────────────────────────────
# Randal Official Docker Entrypoint
#
# Manages the Meilisearch + Randal lifecycle:
#   1. Starts embedded Meilisearch (unless RANDAL_SKIP_MEILISEARCH=true)
#   2. Runs consumer's pre-start hook (if /app/pre-start.sh exists)
#   3. Starts Randal via `randal serve`
#
# Environment Variables:
#   MEILI_MASTER_KEY        — Meilisearch API key (default: randal-dev-key)
#   RANDAL_SKIP_MEILISEARCH — Set to "true" to skip embedded Meilisearch
#                             (use when connecting to an external instance)
# ──────────────────────────────────────────────────────

# ──────────────────────────────────────────────────────
# 1. Start embedded Meilisearch
# ──────────────────────────────────────────────────────
if [ "${RANDAL_SKIP_MEILISEARCH}" != "true" ]; then
  MEILI_KEY="${MEILI_MASTER_KEY:-randal-dev-key}"

  echo "[randal] Starting Meilisearch..."
  meilisearch \
    --db-path /app/meili-data \
    --master-key "$MEILI_KEY" \
    --http-addr "127.0.0.1:7700" \
    --no-analytics \
    --log-level WARN &
  MEILI_PID=$!

  # Wait for Meilisearch to be ready (up to 10 seconds)
  for i in $(seq 1 100); do
    if curl -sf http://127.0.0.1:7700/health > /dev/null 2>&1; then
      echo "[randal] Meilisearch ready"
      break
    fi
    if [ "$i" -eq 100 ]; then
      echo "[randal] WARNING: Meilisearch failed to start within 10s"
    fi
    sleep 0.1
  done
fi

# ──────────────────────────────────────────────────────
# 2. Run consumer's pre-start hook (if present)
# ──────────────────────────────────────────────────────
if [ -f /app/pre-start.sh ]; then
  echo "[randal] Running pre-start script..."
  source /app/pre-start.sh
fi

# ──────────────────────────────────────────────────────
# 3. Start Randal
# ──────────────────────────────────────────────────────
echo "[randal] Starting Randal..."
exec bun run /app/packages/cli/src/index.ts serve "$@"
