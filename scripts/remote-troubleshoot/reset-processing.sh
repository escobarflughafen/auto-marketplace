#!/usr/bin/env bash
set -euo pipefail

CONTAINER="${AUTO_BROWSER_CONTAINER:-auto-browser}"

if [[ $# -lt 1 ]]; then
  cat >&2 <<'USAGE'
Usage:
  reset-processing.sh LISTING_ID [--apply]
  reset-processing.sh --older-than-minutes N [--apply]

Default is dry-run. Add --apply to update DB rows back to pending.
USAGE
  exit 2
fi

if [[ "$1" == "--older-than-minutes" ]]; then
  docker exec "$CONTAINER" node /app/scripts/marketplace-troubleshoot.js reset-processing --older-than-minutes "${2:?missing minutes}" "${@:3}"
else
  docker exec "$CONTAINER" node /app/scripts/marketplace-troubleshoot.js reset-processing --listing-id "$1" "${@:2}"
fi
