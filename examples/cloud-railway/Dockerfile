# Extends the official Randal image with your deployment config.
# Before publishing to GHCR, build locally:
#   docker build -t randal ../.. && docker build -t my-agent .
FROM ghcr.io/drewbietron/randal:latest

# Copy Railway-optimized config
COPY randal.config.railway.yaml /app/randal.config.yaml

# Copy knowledge files (if any)
# COPY knowledge/ /app/knowledge/

# Install any additional custom tools here (optional)
# RUN apt-get update && apt-get install -y --no-install-recommends \
#     your-custom-package \
#     && rm -rf /var/lib/apt/lists/*
