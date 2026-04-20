#!/bin/bash
# update-agent.sh — pull new pm2-agent code from GitHub and restart if changed
# Cron (every 15 min): */15 * * * * bash ~/homelab-dashboard/pm2-agent/update-agent.sh >> ~/pm2-agent-update.log 2>&1

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

cd "$REPO_DIR"
git fetch origin main --quiet

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" = "$REMOTE" ]; then
  exit 0  # nothing new — silent exit
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] New commit detected — updating..."
git pull --ff-only origin main

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Restarting pm2-agent..."
pm2 restart pm2-agent --update-env

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Done. $(git log -1 --pretty='%h %s')"
