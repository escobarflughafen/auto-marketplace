#!/usr/bin/env bash
set -euo pipefail

CONTAINER="${AUTO_BROWSER_CONTAINER:-auto-browser}"

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 RUN_ID" >&2
  exit 2
fi

docker exec "$CONTAINER" node /app/scripts/marketplace-troubleshoot.js worker --run-id "$1"
