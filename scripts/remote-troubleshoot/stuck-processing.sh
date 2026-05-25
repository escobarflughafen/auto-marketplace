#!/usr/bin/env bash
set -euo pipefail

CONTAINER="${AUTO_BROWSER_CONTAINER:-auto-browser}"
MINUTES="${1:-15}"
LIMIT="${2:-50}"

docker exec "$CONTAINER" node /app/scripts/marketplace-troubleshoot.js stuck-processing --minutes "$MINUTES" --limit "$LIMIT"
