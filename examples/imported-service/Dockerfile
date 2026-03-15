# Extends the official Randal image.
# Meilisearch, Claude Code, and Randal are all included in the base image.
#
# Before publishing to GHCR, build locally:
#   docker build -t randal ../.. && docker build -t my-service .
FROM ghcr.io/drewbietron/randal:latest

# Copy your Randal config
COPY randal.config.yaml /app/randal.config.yaml

# Ship whatever files your agent needs — codebase, knowledge, data, etc.
# COPY knowledge/ /app/knowledge/
# COPY my-codebase/ /app/workspace/

# If you have custom pre-start logic (e.g., DB sync, setup scripts),
# place it in pre-start.sh — the Randal entrypoint will source it
# automatically before starting the agent.
# COPY pre-start.sh /app/pre-start.sh
