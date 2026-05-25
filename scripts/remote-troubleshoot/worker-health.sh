#!/usr/bin/env bash
set -euo pipefail

CONTAINER="${AUTO_BROWSER_CONTAINER:-auto-browser}"
PORT="${AUTO_BROWSER_PORT:-21435}"

echo "== container =="
docker ps --filter "name=$CONTAINER" --format '{{.Names}} {{.Status}} {{.Ports}}'

echo
echo "== health endpoint =="
curl -fsS "http://127.0.0.1:${PORT}/healthz"

echo
echo "== recent workers =="
docker exec "$CONTAINER" node /app/scripts/marketplace-troubleshoot.js recent-workers --limit 8

echo
echo "== container logs =="
docker logs --tail 80 "$CONTAINER"
