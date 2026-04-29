#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cat >&2 <<'EOF'
[DEPRECATED] This Marketplace poll wrapper uses the legacy file-based multi-keyword poller.
Preferred replacement: npm run marketplace:search:explore -- --query "mamiya 645af"
EOF

exec node "$ROOT_DIR/scripts/poll-marketplace-keywords.js" \
  --query "mamiya 645af" \
  --area "vancouver" \
  --capture-root "$ROOT_DIR/artifacts/mamiya-645af-poll" \
  --visit-limit 3 \
  --interval-seconds 300 \
  "$@"
