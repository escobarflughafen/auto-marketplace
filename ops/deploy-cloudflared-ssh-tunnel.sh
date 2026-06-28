#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  ops/deploy-cloudflared-ssh-tunnel.sh [options]

Interactively deploy Cloudflare Tunnel SSH access on a remote Ubuntu host.
Default target is 10.10.20.3.

Recommended flow:
  1. In Cloudflare Zero Trust, create a Tunnel.
  2. Add a Public Hostname for SSH:
       hostname: ssh.example.com
       service:  ssh://127.0.0.1:22
  3. Copy the connector token from the dashboard.
  4. Run this script and choose token mode.

Options:
  --host TARGET       SSH target. Default: 10.10.20.3.
  --hostname NAME     Cloudflare SSH hostname, for example ssh.example.com.
  --origin SERVICE    Origin service. Default: ssh://127.0.0.1:22.
  --mode MODE         token or local. Default: token.
  --yes              Accept prompts that are safe to default.
  --dry-run          Print planned commands without changing the remote host.
  -h, --help         Show this help.

Modes:
  token   Installs cloudflared and registers the service using a Cloudflare
          dashboard connector token. Ingress/public hostname config is managed
          in the Cloudflare dashboard.

  local   Writes /etc/cloudflared/config.yml on the remote host and starts the
          cloudflared service. Requires an existing tunnel credentials JSON on
          the remote host.
USAGE
}

SSH_TARGET="10.10.20.3"
ACCESS_HOSTNAME=""
ORIGIN_SERVICE="ssh://127.0.0.1:22"
MODE="token"
ASSUME_YES=0
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)
      SSH_TARGET="${2:?Missing value for --host}"
      shift 2
      ;;
    --hostname)
      ACCESS_HOSTNAME="${2:?Missing value for --hostname}"
      shift 2
      ;;
    --origin)
      ORIGIN_SERVICE="${2:?Missing value for --origin}"
      shift 2
      ;;
    --mode)
      MODE="${2:?Missing value for --mode}"
      shift 2
      ;;
    --yes|-y)
      ASSUME_YES=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$MODE" != "token" && "$MODE" != "local" ]]; then
  echo "Expected --mode to be token or local." >&2
  exit 2
fi

prompt_default() {
  local label="$1"
  local default_value="$2"
  local value
  if [[ "$ASSUME_YES" -eq 1 && -n "$default_value" ]]; then
    printf '%s' "$default_value"
    return 0
  fi
  if [[ -n "$default_value" ]]; then
    read -r -p "$label [$default_value]: " value
    printf '%s' "${value:-$default_value}"
  else
    read -r -p "$label: " value
    printf '%s' "$value"
  fi
}

prompt_secret() {
  local label="$1"
  local value
  read -r -s -p "$label: " value
  printf '\n' >&2
  printf '%s' "$value"
}

confirm() {
  local label="$1"
  local default_value="${2:-n}"
  local value
  if [[ "$ASSUME_YES" -eq 1 ]]; then
    return 0
  fi
  read -r -p "$label [$default_value]: " value
  value="${value:-$default_value}"
  [[ "$value" == "y" || "$value" == "Y" || "$value" == "yes" || "$value" == "YES" ]]
}

remote_quote() {
  printf '%q' "$1"
}

run_remote() {
  local command_string="$1"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf 'DRY-RUN ssh %s %s\n' "$SSH_TARGET" "$command_string"
    return 0
  fi
  ssh "$SSH_TARGET" "$command_string"
}

run_remote_stdin() {
  local command_string="$1"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf 'DRY-RUN ssh %s %s < stdin\n' "$SSH_TARGET" "$command_string"
    cat >/dev/null
    return 0
  fi
  ssh "$SSH_TARGET" "$command_string"
}

require_non_empty() {
  local name="$1"
  local value="$2"
  if [[ -z "$value" ]]; then
    echo "Missing required value: $name" >&2
    exit 2
  fi
}

install_cloudflared_script() {
  cat <<'REMOTE'
set -euo pipefail

if command -v cloudflared >/dev/null 2>&1; then
  cloudflared --version
  exit 0
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "This installer expects an apt-based Ubuntu/Debian host." >&2
  exit 1
fi

sudo apt-get update
sudo apt-get install -y curl ca-certificates gnupg
sudo install -m 0755 -d /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
  | sudo tee /etc/apt/sources.list.d/cloudflared.list >/dev/null
sudo apt-get update
sudo apt-get install -y cloudflared
cloudflared --version
REMOTE
}

install_cloudflared() {
  echo "==> Installing/verifying cloudflared on $SSH_TARGET"
  run_remote "bash -s" < <(install_cloudflared_script)
}

service_status() {
  run_remote "if command -v systemctl >/dev/null 2>&1; then systemctl status cloudflared --no-pager --lines=8 || true; else service cloudflared status || true; fi"
}

deploy_token_mode() {
  local token="$1"
  require_non_empty "Cloudflare tunnel token" "$token"

  install_cloudflared

  echo "==> Registering cloudflared service with dashboard tunnel token"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "DRY-RUN would install cloudflared service with the provided token"
    return 0
  fi

  printf '%s' "$token" | ssh "$SSH_TARGET" 'set -euo pipefail
token_file="$(mktemp)"
cat > "$token_file"
if systemctl list-unit-files cloudflared.service >/dev/null 2>&1; then
  if systemctl is-active --quiet cloudflared 2>/dev/null; then
    sudo systemctl stop cloudflared
  fi
  sudo cloudflared service uninstall >/dev/null 2>&1 || true
fi
sudo cloudflared service install "$(cat "$token_file")"
rm -f "$token_file"
sudo systemctl enable --now cloudflared
systemctl status cloudflared --no-pager --lines=8 || true'
}

write_local_config() {
  local tunnel="$1"
  local credentials_file="$2"
  local hostname="$3"
  local origin="$4"
  local config_path="$5"

  require_non_empty "tunnel id/name" "$tunnel"
  require_non_empty "credentials file" "$credentials_file"
  require_non_empty "hostname" "$hostname"
  require_non_empty "origin service" "$origin"
  require_non_empty "config path" "$config_path"

  local tmp_config
  tmp_config="$(mktemp)"
  trap 'rm -f "${tmp_config:-}"' RETURN

  cat >"$tmp_config" <<CONFIG
tunnel: $tunnel
credentials-file: $credentials_file

ingress:
  - hostname: $hostname
    service: $origin
  - service: http_status:404
CONFIG

  echo "==> Writing remote config $config_path"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "DRY-RUN config:"
    cat "$tmp_config"
  else
    run_remote "sudo install -d -m 0755 /etc/cloudflared"
    run_remote_stdin "sudo tee $(remote_quote "$config_path") >/dev/null" <"$tmp_config"
    run_remote "sudo chmod 0644 $(remote_quote "$config_path")"
  fi
}

deploy_local_mode() {
  local tunnel="$1"
  local credentials_file="$2"
  local hostname="$3"
  local origin="$4"
  local config_path="$5"
  local route_dns="$6"

  install_cloudflared
  write_local_config "$tunnel" "$credentials_file" "$hostname" "$origin" "$config_path"

  if [[ "$route_dns" == "1" ]]; then
    echo "==> Creating/updating Cloudflare DNS route"
    run_remote "cloudflared tunnel route dns $(remote_quote "$tunnel") $(remote_quote "$hostname")"
  fi

  echo "==> Installing/enabling cloudflared service"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "DRY-RUN would install/restart cloudflared service"
    return 0
  fi

  run_remote "if ! systemctl list-unit-files cloudflared.service >/dev/null 2>&1; then sudo cloudflared service install; fi"
  run_remote "sudo systemctl daemon-reload && sudo systemctl enable --now cloudflared && sudo systemctl restart cloudflared"
}

print_client_config() {
  local hostname="$1"
  cat <<CONFIG

Client SSH config:

  Host dev-cloudflare
    HostName $hostname
    User <remote-user>
    ProxyCommand /usr/local/bin/cloudflared access ssh --hostname %h

Test:

  ssh dev-cloudflare

Best practices:
  - Protect $hostname with a Cloudflare Access policy and MFA.
  - Keep SSH key authentication enabled on the origin.
  - Disable direct public inbound SSH if this tunnel is the intended access path.
  - Use a non-root dev user.
CONFIG
}

echo "Cloudflare Tunnel SSH deployment"
echo
SSH_TARGET="$(prompt_default "Remote SSH target" "$SSH_TARGET")"
MODE="$(prompt_default "Setup mode: token or local" "$MODE")"
ACCESS_HOSTNAME="$(prompt_default "Cloudflare SSH hostname" "$ACCESS_HOSTNAME")"
ORIGIN_SERVICE="$(prompt_default "Origin SSH service" "$ORIGIN_SERVICE")"

require_non_empty "remote SSH target" "$SSH_TARGET"
require_non_empty "Cloudflare SSH hostname" "$ACCESS_HOSTNAME"
require_non_empty "origin SSH service" "$ORIGIN_SERVICE"

echo
echo "Plan:"
echo "  remote target: $SSH_TARGET"
echo "  mode:          $MODE"
echo "  hostname:      $ACCESS_HOSTNAME"
echo "  origin:        $ORIGIN_SERVICE"
echo

if ! confirm "Proceed with remote cloudflared deployment?" "n"; then
  echo "Cancelled."
  exit 0
fi

case "$MODE" in
  token)
    echo
    echo "Paste the Cloudflare Tunnel connector token from Zero Trust."
    echo "The dashboard tunnel should have public hostname $ACCESS_HOSTNAME -> $ORIGIN_SERVICE."
    TUNNEL_TOKEN="$(prompt_secret "Cloudflare tunnel token")"
    deploy_token_mode "$TUNNEL_TOKEN"
    ;;
  local)
    TUNNEL_NAME="$(prompt_default "Tunnel id or name" "dev-ssh")"
    CREDENTIALS_FILE="$(prompt_default "Remote credentials file" "/etc/cloudflared/${TUNNEL_NAME}.json")"
    CONFIG_PATH="$(prompt_default "Remote config path" "/etc/cloudflared/config.yml")"
    ROUTE_DNS=0
    if confirm "Run cloudflared tunnel route dns for $ACCESS_HOSTNAME?" "n"; then
      ROUTE_DNS=1
    fi
    deploy_local_mode "$TUNNEL_NAME" "$CREDENTIALS_FILE" "$ACCESS_HOSTNAME" "$ORIGIN_SERVICE" "$CONFIG_PATH" "$ROUTE_DNS"
    ;;
  *)
    echo "Expected mode to be token or local." >&2
    exit 2
    ;;
esac

echo
echo "==> Remote service status"
service_status
print_client_config "$ACCESS_HOSTNAME"
