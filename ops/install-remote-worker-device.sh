#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  ops/install-remote-worker-device.sh --host-url URL --worker-id ID [options]

Installs this repo as a remote worker runtime on an Ubuntu device. Run from a checked-out repo on the worker device.

Options:
  --host-url URL             Host app URL reachable from the worker.
  --worker-id ID             Stable worker identity.
  --worker-token TOKEN       Worker token. Prefer --worker-token-file for history safety.
  --worker-token-file FILE   Existing token file. Default: /etc/marketplace-remote-worker/<worker-id>.token
  --worker-type TYPE         Default: backlog_indexer.
  --strategy STRATEGY        Default: resolved_metadata.
  --source-id ID             Default: remote:<hostname>:<worker-id>.
  --install-dir DIR          Default: /opt/marketplace-remote-worker.
  --state-dir DIR            Default: /var/lib/marketplace-remote-worker.
  --log-dir DIR              Default: /var/log/marketplace-remote-worker.
  --service-user USER        Default: current user.
  --poll-interval-ms N       Default: 5000.
  --heartbeat-interval-ms N  Default: 30000.
  --batch-size N             Default: 10.
  --capacity N               Default: 1.
  --once                     Configure a one-shot systemd service command.
  --no-systemd               Only write files and print the run command.
  -h, --help                 Show this help.
USAGE
}

HOST_URL=""
WORKER_ID=""
WORKER_TOKEN=""
WORKER_TOKEN_FILE=""
WORKER_TYPE="backlog_indexer"
STRATEGY="resolved_metadata"
SOURCE_ID=""
INSTALL_DIR="/opt/marketplace-remote-worker"
STATE_DIR="/var/lib/marketplace-remote-worker"
LOG_DIR="/var/log/marketplace-remote-worker"
SERVICE_USER="${USER:-aoi}"
POLL_INTERVAL_MS="5000"
HEARTBEAT_INTERVAL_MS="30000"
BATCH_SIZE="10"
CAPACITY="1"
ONCE=0
SYSTEMD=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host-url) HOST_URL="${2:?Missing value for --host-url}"; shift 2 ;;
    --worker-id) WORKER_ID="${2:?Missing value for --worker-id}"; shift 2 ;;
    --worker-token) WORKER_TOKEN="${2:?Missing value for --worker-token}"; shift 2 ;;
    --worker-token-file) WORKER_TOKEN_FILE="${2:?Missing value for --worker-token-file}"; shift 2 ;;
    --worker-type) WORKER_TYPE="${2:?Missing value for --worker-type}"; shift 2 ;;
    --strategy) STRATEGY="${2:?Missing value for --strategy}"; shift 2 ;;
    --source-id) SOURCE_ID="${2:?Missing value for --source-id}"; shift 2 ;;
    --install-dir) INSTALL_DIR="${2:?Missing value for --install-dir}"; shift 2 ;;
    --state-dir) STATE_DIR="${2:?Missing value for --state-dir}"; shift 2 ;;
    --log-dir) LOG_DIR="${2:?Missing value for --log-dir}"; shift 2 ;;
    --service-user) SERVICE_USER="${2:?Missing value for --service-user}"; shift 2 ;;
    --poll-interval-ms) POLL_INTERVAL_MS="${2:?Missing value for --poll-interval-ms}"; shift 2 ;;
    --heartbeat-interval-ms) HEARTBEAT_INTERVAL_MS="${2:?Missing value for --heartbeat-interval-ms}"; shift 2 ;;
    --batch-size) BATCH_SIZE="${2:?Missing value for --batch-size}"; shift 2 ;;
    --capacity) CAPACITY="${2:?Missing value for --capacity}"; shift 2 ;;
    --once) ONCE=1; shift ;;
    --no-systemd) SYSTEMD=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "$HOST_URL" || -z "$WORKER_ID" ]]; then
  echo "Missing required --host-url or --worker-id." >&2
  usage >&2
  exit 2
fi

if [[ -z "$SOURCE_ID" ]]; then
  SOURCE_ID="remote:$(hostname -s 2>/dev/null || hostname):$WORKER_ID"
fi
if [[ -z "$WORKER_TOKEN_FILE" ]]; then
  WORKER_TOKEN_FILE="/etc/marketplace-remote-worker/$WORKER_ID.token"
fi

RUN_DIR="$STATE_DIR/$WORKER_ID"
LOCAL_DB="$RUN_DIR/worker.db"
ARTIFACT_DIR="$RUN_DIR/artifacts"
ENV_FILE="/etc/marketplace-remote-worker/$WORKER_ID.env"
SERVICE_NAME="marketplace-remote-worker@$WORKER_ID.service"

sudo install -d -m 0755 -o "$SERVICE_USER" -g "$SERVICE_USER" "$INSTALL_DIR" "$RUN_DIR" "$ARTIFACT_DIR" "$LOG_DIR"
sudo install -d -m 0750 /etc/marketplace-remote-worker

if [[ "$PWD" != "$INSTALL_DIR" ]]; then
  rsync -az --delete --exclude .git --exclude node_modules --exclude artifacts --exclude output --exclude profiles --exclude raw --exclude = ./ "$INSTALL_DIR/"
fi

if [[ -n "$WORKER_TOKEN" ]]; then
  printf '%s\n' "$WORKER_TOKEN" | sudo tee "$WORKER_TOKEN_FILE" >/dev/null
  sudo chmod 0600 "$WORKER_TOKEN_FILE"
  sudo chown "$SERVICE_USER:$SERVICE_USER" "$WORKER_TOKEN_FILE"
elif [[ ! -f "$WORKER_TOKEN_FILE" ]]; then
  echo "Token file does not exist: $WORKER_TOKEN_FILE" >&2
  echo "Pass --worker-token or create the token file before starting the service." >&2
  exit 1
fi

sudo tee "$ENV_FILE" >/dev/null <<ENV
REMOTE_WORKER_HOST_URL=$HOST_URL
REMOTE_WORKER_ID=$WORKER_ID
REMOTE_WORKER_DB_PATH=$LOCAL_DB
REMOTE_WORKER_TOKEN_FILE=$WORKER_TOKEN_FILE
REMOTE_WORKER_WORKER_TYPE=$WORKER_TYPE
REMOTE_WORKER_STRATEGY=$STRATEGY
REMOTE_WORKER_SOURCE_ID=$SOURCE_ID
REMOTE_WORKER_POLL_INTERVAL_MS=$POLL_INTERVAL_MS
REMOTE_WORKER_HEARTBEAT_INTERVAL_MS=$HEARTBEAT_INTERVAL_MS
REMOTE_WORKER_BATCH_SIZE=$BATCH_SIZE
REMOTE_WORKER_CAPACITY=$CAPACITY
ENV
sudo chmod 0640 "$ENV_FILE"
sudo chown "$SERVICE_USER:$SERVICE_USER" "$ENV_FILE"

sudo -u "$SERVICE_USER" bash -lc "cd '$INSTALL_DIR' && npm ci --omit=dev"

ONCE_ARG=""
if [[ "$ONCE" -eq 1 ]]; then
  ONCE_ARG="--once"
fi
RUN_COMMAND="cd '$INSTALL_DIR' && node scripts/remote-worker-runtime.js --host-url \"\$REMOTE_WORKER_HOST_URL\" --token-file \"\$REMOTE_WORKER_TOKEN_FILE\" --local-db \"\$REMOTE_WORKER_DB_PATH\" --worker-id \"\$REMOTE_WORKER_ID\" --worker-type \"\$REMOTE_WORKER_WORKER_TYPE\" --strategy \"\$REMOTE_WORKER_STRATEGY\" --source-id \"\$REMOTE_WORKER_SOURCE_ID\" --poll-interval-ms \"\$REMOTE_WORKER_POLL_INTERVAL_MS\" --heartbeat-interval-ms \"\$REMOTE_WORKER_HEARTBEAT_INTERVAL_MS\" --batch-size \"\$REMOTE_WORKER_BATCH_SIZE\" --capacity \"\$REMOTE_WORKER_CAPACITY\" $ONCE_ARG"

if [[ "$SYSTEMD" -eq 1 ]]; then
  sudo tee "/etc/systemd/system/$SERVICE_NAME" >/dev/null <<SERVICE
[Unit]
Description=Marketplace Remote Worker $WORKER_ID
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/env bash -lc '$RUN_COMMAND'
Restart=always
RestartSec=10
StandardOutput=append:$LOG_DIR/$WORKER_ID.log
StandardError=append:$LOG_DIR/$WORKER_ID.log

[Install]
WantedBy=multi-user.target
SERVICE
  sudo systemctl daemon-reload
  echo "Installed $SERVICE_NAME"
  echo "Start with: sudo systemctl enable --now $SERVICE_NAME"
  echo "Logs: sudo journalctl -u $SERVICE_NAME -f"
else
  echo "Run command:"
  echo "$RUN_COMMAND"
fi

cat <<SUMMARY
Remote worker install prepared.
  host:        $HOST_URL
  worker id:   $WORKER_ID
  worker type: $WORKER_TYPE
  strategy:    $STRATEGY
  local db:    $LOCAL_DB
  token file:  $WORKER_TOKEN_FILE
SUMMARY
