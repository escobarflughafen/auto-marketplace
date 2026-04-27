#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

exec node "$ROOT_DIR/scripts/poll-marketplace-keywords.js" \
  --query "mamiya 645af" \
  --area "vancouver" \
  --capture-root "$ROOT_DIR/artifacts/mamiya-645af-poll" \
  --visit-limit 3 \
  --interval-seconds 300 \
  "$@"
