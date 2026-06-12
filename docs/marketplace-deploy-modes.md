# Marketplace Deploy Modes

Use `npm run marketplace:deploy -- <mode>` for remote dev-server deploys.

Target configuration is read from `.marketplace-deploy.env` by default. Copy
the example and edit it for the remote host:

```bash
cp .marketplace-deploy.env.example .marketplace-deploy.env
```

Required config:

- `MARKETPLACE_DEPLOY_HOST`
- `MARKETPLACE_DEPLOY_DIR`

Optional config:

- `MARKETPLACE_CONTAINER`, default `auto-browser`
- `MARKETPLACE_PORT`, default `21435`

You can also point at another config file with `--config` or
`MARKETPLACE_DEPLOY_CONFIG`, export the same variables in the environment, or
override values with CLI flags.

For the staging site, copy the staging example instead:

```bash
cp .marketplace-deploy.staging.env.example .marketplace-deploy.staging.env
```

The staging compose service is `auto-browser-staging` on port `21436`. It uses
separate runtime directories:

- `artifacts-staging/`
- `profiles-staging/`
- `secrets-staging/`

Keep staging tokens separate in the remote `.env`:

```bash
MARKETPLACE_STAGING_MONITOR_ADMIN_TOKEN=...
MARKETPLACE_STAGING_MONITOR_READONLY_TOKEN=...
```

## Static

```bash
npm run marketplace:deploy -- static
```

Use for frontend-only changes under `frontend/marketplace-monitor`.

Behavior:

- runs preflight checks;
- syncs source to the remote app directory;
- copies only frontend assets into the running container;
- verifies `/healthz` and the dashboard HTML;
- does not restart the container;
- does not rotate generated tokens.

If you are intentionally hot-deploying an uncommitted frontend patch:

```bash
npm run marketplace:deploy -- static --allow-dirty
```

## App

```bash
npm run marketplace:deploy -- app
```

Use for server/frontend JavaScript changes that do not need dependency or image
changes.

Behavior:

- syncs source;
- copies `frontend/`, `scripts/`, and package metadata into the container;
- restarts the compose service;
- verifies health after restart.

Generated tokens can rotate on restart unless the remote `.env` defines:

```bash
MARKETPLACE_MONITOR_ADMIN_TOKEN=...
MARKETPLACE_MONITOR_READONLY_TOKEN=...
```

## Full

```bash
npm run marketplace:deploy -- full
```

Use for dependency, Dockerfile, base image, or runtime environment changes.

Behavior:

- syncs source;
- runs `docker compose up -d --build --force-recreate`;
- verifies health after recreate.

To deploy only staging without touching the production container:

```bash
npm run marketplace:deploy -- full --config .marketplace-deploy.staging.env --allow-dirty
```

For server-only staging updates after the service exists:

```bash
npm run marketplace:deploy -- app --config .marketplace-deploy.staging.env --allow-dirty
```

## Preflight

The deploy command refuses dirty worktrees by default. This prevents accidental
sync of local runtime files or scratch output. Use `--allow-dirty` only for an
intentional hot patch, and keep `raw/`, `artifacts/`, profiles, secrets, and
local credentials out of source sync.

## Remote Maintenance

The dev server is expected to run as the `auto-browser` container on the remote
host configured by `.marketplace-deploy.env`. Keep target-specific values in
that ignored file, not in source:

```bash
MARKETPLACE_DEPLOY_HOST=auto-browser@10.10.20.3
MARKETPLACE_DEPLOY_DIR=/srv/auto-browser/app
MARKETPLACE_CONTAINER=auto-browser
MARKETPLACE_PORT=21435
```

Use the lightest operation that matches the change:

- Frontend-only dashboard edits: `npm run marketplace:deploy -- static --allow-dirty`
- Server JavaScript or schema/index edits: `npm run marketplace:deploy -- app --allow-dirty`
- Dependency, Dockerfile, or runtime image edits: `npm run marketplace:deploy -- full`
- Manual service restart only: `ssh "$MARKETPLACE_DEPLOY_HOST" "docker restart $MARKETPLACE_CONTAINER"`

After any restart or app/full deploy, verify the service from the remote host:

```bash
ssh "$MARKETPLACE_DEPLOY_HOST" "docker ps --filter name=$MARKETPLACE_CONTAINER"
ssh "$MARKETPLACE_DEPLOY_HOST" "curl -fsS http://127.0.0.1:$MARKETPLACE_PORT/healthz"
ssh "$MARKETPLACE_DEPLOY_HOST" "docker logs --tail 80 $MARKETPLACE_CONTAINER"
```

If `MARKETPLACE_MONITOR_ADMIN_TOKEN` and
`MARKETPLACE_MONITOR_READONLY_TOKEN` are not set in the remote runtime `.env`,
tokens are generated on process start and will rotate after `app`, `full`, or
manual container restarts. Read the current URLs from:

```bash
ssh "$MARKETPLACE_DEPLOY_HOST" "docker logs --tail 80 $MARKETPLACE_CONTAINER"
```

Operational checks:

- `/healthz` confirms the Node monitor is responding.
- `docker ps` should show the container as `healthy`.
- Slow `/api/events` or `/api/workflows` entries in logs usually indicate a
  heavy SQLite query or expensive worker audit calculation; check recent
  `request_timing` lines before adding more workers.
- Prefer static deploys for UI-only fixes because they avoid worker interruption
  and token rotation.
- Use app/full deploys when schema creation, server API behavior, scheduler
  code, or worker orchestration changes need to be loaded by the Node process.
