#!/usr/bin/env bash
set -euo pipefail

CONTAINER="${AUTO_BROWSER_CONTAINER:-auto-browser}"
LIMIT="${1:-10}"

docker exec "$CONTAINER" node /app/scripts/marketplace-troubleshoot.js recent-workers --limit "$LIMIT"
