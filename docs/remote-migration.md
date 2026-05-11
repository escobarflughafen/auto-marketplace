# Remote Migration

This project can run on Ubuntu under a dedicated `auto-browser` service user.
The service user owns the project/runtime files and belongs to the Docker group,
but it does not receive passwordless sudo.

## Target Layout

```text
/srv/auto-browser/
  app/       # repo checkout / deployed source
  backups/   # runtime backups created before migration/restart
```

Docker Compose mounts runtime data from:

```text
/srv/auto-browser/app/artifacts
/srv/auto-browser/app/profiles
/srv/auto-browser/app/credentials.json
```

## One-Time Server Setup

From local:

```bash
rsync -az ops/ubuntu-create-auto-browser-user.sh 10.10.20.3:/tmp/
```

On the Ubuntu server:

```bash
ssh 10.10.20.3
sudo bash /tmp/ubuntu-create-auto-browser-user.sh
```

This creates:

- user: `auto-browser`
- group: `auto-browser`
- project dir: `/srv/auto-browser/app`
- Docker access through the `docker` group

It also copies the existing project from `/home/aoi/services/auto-browser` if
`/srv/auto-browser/app` is empty.

If Docker commands fail for `auto-browser` immediately after setup, start a new
SSH login session so group membership is refreshed.

## Container Name Conflict

The Compose file uses:

```yaml
container_name: auto-browser
```

Only one Docker container can use that name. If the old deployment under
`/home/aoi/services/auto-browser` is still running, the new `/srv` deployment
will fail with:

```text
Conflict. The container name "/auto-browser" is already in use
```

Stop the old deployment:

```bash
ssh 10.10.20.3
cd /home/aoi/services/auto-browser
docker compose down
```

If permissions block that command, use sudo once:

```bash
sudo docker stop auto-browser
sudo docker rm auto-browser
```

Then start the new deployment:

```bash
cd /srv/auto-browser/app
docker compose up -d auto-browser
docker compose ps auto-browser
```

## Local-To-Remote Migration

Run from the local repo:

```bash
cd /Users/aoi/Workspaces/auto-browser
ops/migrate-marketplace-runtime-to-remote.sh --execute --remote-user auto-browser
```

The migration script:

- checkpoints the local SQLite DB
- backs up remote `artifacts/marketplace-homepage`
- syncs source to `/srv/auto-browser/app`
- syncs local `artifacts/marketplace-homepage` to the remote runtime directory
- rebuilds/restarts Docker Compose
- runs remote DB maintenance/checkpoint

It excludes:

- `.git`
- `node_modules`
- `credentials.json`
- `profiles`
- `output`
- source-side generated artifacts from the source sync

The runtime sync intentionally includes:

- `artifacts/marketplace-homepage/marketplace-homepage.db`
- detail markdown
- screenshots
- thumbnails
- logs
- resolve batch files

## Dry Run

Before a real migration:

```bash
ops/migrate-marketplace-runtime-to-remote.sh --remote-user auto-browser
```

No files are written during the dry run.

## Verify

```bash
ssh auto-browser@10.10.20.3 'cd /srv/auto-browser/app && docker compose ps auto-browser'
ssh auto-browser@10.10.20.3 "curl -fsS 'http://127.0.0.1:21435/api/listings?limit=1' | head -c 500"
```

Open:

```text
http://10.10.20.3:21435
```

## Maintenance

Run on the remote:

```bash
ssh auto-browser@10.10.20.3 'cd /srv/auto-browser/app && docker compose exec -T auto-browser npm run marketplace:home:db:maintain -- --json'
```

For scheduled maintenance, use the Ubuntu systemd templates in `ops/`:

- `ops/marketplace-db-maintenance.service.example`
- `ops/marketplace-db-maintenance.timer.example`
- `ops/marketplace-db-analyze.service.example`
- `ops/marketplace-db-analyze.timer.example`

Adjust paths from `/home/aoi/services/auto-browser` to `/srv/auto-browser/app`
before installing them.
