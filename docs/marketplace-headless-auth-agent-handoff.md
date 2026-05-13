# Marketplace Headless Auth Agent Handoff

Date: 2026-05-13

This document gives a local or remote agent enough context to continue Facebook Marketplace authenticated-worker operations over SSH.

## Runtime

- Host: `10.10.20.3`
- SSH user for app operations: `auto-browser`
- Project path: `/srv/auto-browser/app`
- Compose service: `auto-browser`
- Active browser profile in container: `/app/profiles/facebook-marketplace`
- Active browser profile on host: `/srv/auto-browser/app/profiles/facebook-marketplace`
- Credentials file in container: `/app/secrets/credentials.json`
- Production DB in container: `/app/artifacts/marketplace-homepage/marketplace-homepage.db`

Use Docker for real auth and worker checks. The authenticated profile must be created and verified in the same Linux/Chromium/container environment that the worker uses.

## Current Auth State

The active Playwright profile was reset during the latest auth review. The previous profile was moved aside on the server:

```text
/srv/auto-browser/app/profiles/reset-backups/facebook-marketplace-20260513T051700Z
```

A clean headless session was launched, then a one-off login was performed with a new account provided by the user. The active profile is now authenticated.

Successful auth result:

```json
{
  "loggedIn": true,
  "signedInUserId": "100052646015178",
  "currentUrl": "https://www.facebook.com/marketplace/",
  "userDataDir": "/app/profiles/facebook-marketplace"
}
```

Follow-up bootstrap verification passed:

```text
session_reuse_success source=navigate_marketplace url=https://www.facebook.com/marketplace/
auth_bootstrap_done logged_in=true signed_in_user_id=100052646015178 current_url=https://www.facebook.com/marketplace/
```

Update: `/home/aoi/new_cred.txt` was imported into `/app/secrets/credentials.json` as credential profile `app-review`, and `app-review` is now the active credential profile. The old credential remains available as profile `default`.

Current credential profile summary:

```json
{
  "activeProfileId": "app-review",
  "profiles": [
    {
      "id": "app-review",
      "hasPassword": true,
      "active": true
    },
    {
      "id": "default",
      "hasPassword": true,
      "active": false
    }
  ]
}
```

Current bootstrap verification shows the active credential profile and the authenticated browser session agree:

```json
{
  "loadedCredentialsProfile": "app-review",
  "signedInUserId": "100052646015178",
  "loggedIn": true
}
```

Treat `loadedEmail` as the selected credentials-file email, not as proof of active Facebook session identity. Use `signedInUserId` for the authenticated browser identity.

## Deployed Auth Tooling

The deployed code includes:

- `scripts/headless-marketplace-auth-onboarding.js`
- `scripts/import-marketplace-credential.js`
- package script: `marketplace:auth:headless-onboard`
- package script: `marketplace:credentials:import`
- Credential manager UI in the Workers tab

The headless onboarding script:

- launches persistent Chromium headless
- uses `/app/profiles/facebook-marketplace`
- reads credentials from `/app/secrets/credentials.json` unless overridden
- prints `[page_state]` summaries with visible inputs/buttons/hints
- fills email/password when visible
- asks for a 2FA code only when a visible code input exists
- logs `action_required type=external_approval` when Facebook requires trusted-device approval
- exits with JSON when `loggedIn` is true

Earlier testing reached Facebook pre-authentication two-step verification with no visible code input:

```text
https://www.facebook.com/two_step_verification/authentication/?flow=pre_authentication&next=https%3A%2F%2Fwww.facebook.com%2Fmarketplace%2F
```

When no visible code input or actionable alternate-method button exists, the agent cannot resolve the checkpoint from HTML alone. The correct deterministic action is to ask the user to approve the login from a trusted Facebook device/browser.

## Health Checks Already Observed

`marketplace:doctor` passed:

```text
Marketplace Doctor
Overall: ok
Counts: ok=8 warn=0 fail=0
```

Key doctor signals:

- Node runtime supports `node:sqlite`.
- Playwright Chromium is installed.
- Headless Chromium launches.
- SQLite database opens.
- Browser profile directory exists.
- Credentials file is parseable.
- Artifacts directory is writable.

Auth bootstrap passed with `--auth-mode required`:

```bash
cd /srv/auto-browser/app

docker compose run --rm auto-browser npm run marketplace:auth:bootstrap -- \
  --auth-mode required \
  --headless \
  --json \
  --login-timeout-seconds 60
```

A non-production collector smoke test also passed using temporary DB/log/snapshot paths:

```bash
cd /srv/auto-browser/app

docker compose run --rm auto-browser npm run marketplace:home:collect -- \
  --auth-mode required \
  --headless \
  --once \
  --max-items 3 \
  --first-load-only \
  --initial-load-wait-ms 2000 \
  --max-runtime-seconds 30 \
  --db-path /tmp/marketplace-review-smoke.db \
  --log-file /tmp/marketplace-review-smoke.log \
  --snapshot-file /tmp/marketplace-review-smoke.json
```

Observed smoke result:

```text
session_reuse_success source=navigate_marketplace url=https://www.facebook.com/marketplace/
collector_session_ready loaded_email=<selected credential email> signed_in_user_id=100052646015178 logged_in=true
cycle_done collected=3 stop_reason=max_items new=3 existing_same=0 existing_updated=0
```

Again, `loaded_email` is the selected credentials-file email, while `signed_in_user_id` is the active session identity.

## Production DB State

Observed detail-status counts:

```json
{
  "pending": 74993,
  "processing": 1,
  "done": 310,
  "error": 151,
  "sold": 6,
  "pending_sale": 0
}
```

One stale processing row was observed:

```json
{
  "listing_id": "1598141828178976",
  "href": "https://www.facebook.com/marketplace/item/1598141828178976/",
  "detail_status": "processing",
  "claimed_by": "pid-65616",
  "detail_attempts": 1,
  "detail_started_at": "2026-05-08T05:06:25.315Z",
  "detail_completed_at": null,
  "last_seen_at": "2026-04-30T09:17:19.137Z",
  "card_title": "Pentax 6x7 with 104mm lens"
}
```

This should be reclaimed by stale-claim logic or an explicit maintenance operation before treating the backlog as clean. Avoid ad hoc DB mutation unless the intended status transition is clear.

## Agent Operating Rules

Prefer production worker commands with `--auth-mode required` so commands reuse the existing authenticated profile and do not silently fall back to the stale credentials file.

Do not run multiple persistent Chromium contexts against `/app/profiles/facebook-marketplace` at the same time. One-off Docker runs and the main service share the same profile path, so concurrent browser use can lock or corrupt the profile.

Before auth onboarding or profile maintenance, stop or pause any worker that may launch Chromium with the same profile. At minimum, check for active one-off run containers:

```bash
cd /srv/auto-browser/app

docker ps -a --filter 'name=app-auto-browser-run' --format '{{.ID}} {{.Status}} {{.Names}}'
```

Do not delete the persistent profile unless explicitly instructed. If profile locks exist from a crashed session, clear only Chromium singleton lock files:

```bash
cd /srv/auto-browser/app

docker compose down
rm -f profiles/facebook-marketplace/SingletonCookie \
  profiles/facebook-marketplace/SingletonLock \
  profiles/facebook-marketplace/SingletonSocket
docker compose up -d
```

## Useful Commands

Verify the active profile still works:

```bash
cd /srv/auto-browser/app

docker compose run --rm auto-browser npm run marketplace:auth:bootstrap -- \
  --auth-mode required \
  --headless \
  --json \
  --login-timeout-seconds 60
```

Run a small authenticated worker batch:

```bash
cd /srv/auto-browser/app

docker compose exec -T auto-browser npm run marketplace:home:process -- \
  --auth-mode required \
  --drain \
  --batch-size 3 \
  --limit 10
```

Run the headless onboarding tool if the profile becomes logged out:

```bash
cd /srv/auto-browser/app

docker compose run --rm -i auto-browser npm run marketplace:auth:headless-onboard -- \
  --credentials-path /app/secrets/credentials.json \
  --login-timeout-seconds 900 \
  --poll-seconds 5 \
  --max-elements 40
```

The `-i` flag is required because the script may prompt for a 2FA code.

Check credentials shape without printing the password:

```bash
cd /srv/auto-browser/app

docker compose run --rm auto-browser node -e "const fs=require('fs');const c=JSON.parse(fs.readFileSync('/app/secrets/credentials.json','utf8'))['facebook-marketplace']||{};console.log({email:c.email,hasPassword:Boolean(c.password)})"
```

Expected shape:

```json
{
  "facebook-marketplace": {
    "email": "account@example.com",
    "password": "password"
  }
}
```

## Recommended Follow-Up Code Changes

No broad refactor is required. The app is usable, but these improvements would make future operations safer:

1. Rename `loadedEmail` or `loaded_email` to `credentialsEmail` in logs/results so it is not confused with the active Facebook session identity.
2. Add a no-fallback production auth mode/default for workers, or ensure production commands consistently use `--auth-mode required`.
3. Add a shared profile-lock/preflight helper used by onboarding, bootstrap, collector, and processor.
4. Add or expose a first-class stale-claim reclaim command for stuck `detail_status='processing'` rows.
5. Promote one-off onboarding with temporary credentials into a maintained script with options like `--credentials-path`, `--no-persist-credentials`, `--auth-mode credentials`, and `--cleanup-temp-credentials`.
