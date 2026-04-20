#!/bin/bash
# update.sh — pull the latest homelab-dashboard image and redeploy
# Run this on the NAS (DS423+) to deploy new versions pushed to main.
#
# Usage:  bash /volume2/docker/homelab-dashboard/update.sh
# Cron:   (optional) every hour — 0 * * * * bash /volume2/docker/homelab-dashboard/update.sh >> /volume2/docker/homelab-dashboard/update.log 2>&1

set -euo pipefail

IMAGE="ghcr.io/loswastaken/homelab-dashboard:latest"
COMPOSE_FILE="/volume2/docker/homelab-dashboard/docker-compose.yml"

echo ""
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting update..."

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Pulling $IMAGE..."
docker pull "$IMAGE"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Redeploying container..."
docker compose -f "$COMPOSE_FILE" up -d --remove-orphans

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Pruning old images..."
docker image prune -f --filter "label=org.opencontainers.image.source=https://github.com/loswastaken/homelab-dashboard" 2>/dev/null || true

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Done."
docker ps --filter name=homelab-dashboard --format "  container: {{.Names}}  status: {{.Status}}"
echo ""
