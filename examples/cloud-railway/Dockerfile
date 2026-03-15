# Extends the official Randal image with your deployment config.
# Before publishing to GHCR, build locally:
#   docker build -t randal ../.. && docker build -t my-agent .
FROM ghcr.io/drewbietron/randal:latest

# Copy deployment config
COPY randal.config.yaml /app/randal.config.yaml

# Copy knowledge files (if any)
# COPY knowledge/ /app/knowledge/
