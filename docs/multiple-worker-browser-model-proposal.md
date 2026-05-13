# Multiple Worker Browser Model Proposal

## Goal

Support multiple concurrent marketplace workers without corrupting Chromium profiles, duplicating queue work, or losing auditability.

The core invariant:

> A browser profile has exactly one active owner. Multiple workers may run concurrently only when they either use different browser profiles or communicate through a single browser-owner process.

## Current Model

Today, the homepage collector, search explorer, auth bootstrap, onboarding, and backlog resolver all launch Playwright with a persistent Chromium profile under `profiles/facebook-marketplace`.

This creates an effective singleton:

- Chromium persistent profiles cannot safely be opened by multiple contexts at the same time.
- The shared profile contains the authenticated Facebook session.
- The UI server blocks concurrent managed workflows.
- Manual CLI commands can still bypass the UI guard and collide with the profile.

This is operationally simple, but it prevents parallel collection/resolution and makes the browser process responsible for too much work.

## Target Model

Separate the system into four responsibilities:

1. UI/API process

   Accepts user actions, appends command events, reads projections, and displays audit logs.

2. Scheduler/dispatcher

   Converts queue state into worker/browser commands, enforces concurrency limits, and assigns profile leases.

3. Browser owner

   Owns exactly one persistent Chromium profile. It opens pages, navigates, captures DOM/screenshot/snapshot data, and emits result events.

4. Projection reducers

   Convert immutable events into fast current-state tables such as `resolve_queue_items`, `workflow_runs`, and listing detail fields.

## Two Supported Execution Modes

### Mode A: Profile Pool

Run multiple independent browser workers, each with its own profile directory:

```text
profiles/
  marketplace-worker-01/
  marketplace-worker-02/
  marketplace-worker-03/
```

Each worker owns one profile:

```text
worker-01 -> profiles/marketplace-worker-01
worker-02 -> profiles/marketplace-worker-02
worker-03 -> profiles/marketplace-worker-03
```

Pros:

- True browser-level concurrency.
- Simple worker implementation.
- One crash affects one profile.

Cons:

- Each profile needs authentication.
- More Facebook session identities or profile state to maintain.
- Higher risk of behavior concentration if all profiles behave similarly.

### Mode B: Single Browser Broker

Run one browser-owner process for one profile. Other workers communicate with it through commands:

```text
UI/API -> command events -> browser broker -> result events -> projections
```

Pros:

- Keeps one authenticated session.
- Prevents profile lock problems.
- Good first step for separating listing browser from queue/worker logic.

Cons:

- Browser work is still serialized per profile.
- Broker is a bottleneck.
- More command/result protocol work.

Recommendation: implement Mode B first, then add Mode A as a profile-pool extension.

## Profile Lease Model

Add a profile lease table or event-derived projection:

```sql
CREATE TABLE browser_profile_leases (
  profile_id TEXT PRIMARY KEY,
  profile_dir TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  status TEXT NOT NULL,
  leased_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
```

Lease rules:

- A profile can have at most one active owner.
- Owners must heartbeat.
- Expired leases can be reclaimed.
- Startup must fail fast if Chromium singleton lock files exist and the lease is not owned by this process.
- Manual lock cleanup must stay explicit.

Lease events:

- `browser_profile_registered`
- `browser_profile_lease_requested`
- `browser_profile_lease_acquired`
- `browser_profile_lease_heartbeat`
- `browser_profile_lease_released`
- `browser_profile_lease_expired`
- `browser_profile_lease_rejected`

## Command Protocol

Commands should be immutable events. Results should also be immutable events.

Command envelope:

```json
{
  "event_id": "01J...",
  "event_type": "browser_command_requested",
  "entity_type": "browser_command",
  "entity_id": "command-id",
  "event_at": "2026-05-13T19:00:00.000Z",
  "source_id": "ui-server",
  "actor": "viewer",
  "correlation_id": "ui-action-id",
  "payload_json": {
    "command_type": "capture_listing_detail",
    "listing_id": "123",
    "url": "https://www.facebook.com/marketplace/item/123/",
    "profile_selector": "default",
    "timeout_ms": 60000
  }
}
```

Result events:

- `browser_command_claimed`
- `browser_command_started`
- `browser_command_progress`
- `browser_command_succeeded`
- `browser_command_failed`
- `browser_command_cancel_requested`
- `browser_command_cancelled`

The worker should not directly mutate final listing state. It should emit result events, and projection reducers should update current tables.

## Queue Flow

Backlog resolve flow:

1. User selects listings in query results.
2. UI appends `resolve_queue_added`.
3. Queue reducer projects rows into `resolve_queue_items`.
4. Scheduler sees queued rows.
5. Scheduler appends `browser_command_requested`.
6. Browser owner claims command if it has a matching profile lease.
7. Browser owner emits command lifecycle events.
8. Browser owner emits listing detail events:
   - `detail_capture_started`
   - `detail_capture_succeeded`
   - `detail_capture_failed`
   - `detail_capture_bypassed`
   - `content_changed`
9. Reducers update:
   - listing detail projection;
   - resolve queue projection;
   - workflow/browser status projection.

## Worker Roles

### Scheduler Worker

Responsibilities:

- watches `resolve_queue_items` or event projection;
- respects max concurrency;
- creates command events;
- assigns profile selector;
- marks commands timed out when stale.

Does not:

- launch Chromium;
- scrape pages;
- mutate listing details directly.

### Browser Owner Worker

Responsibilities:

- owns exactly one profile lease;
- launches one persistent Chromium context;
- claims matching browser commands;
- executes browser automation;
- writes screenshots/snapshots;
- emits lifecycle and result events.

Does not:

- decide global queue priority;
- mutate queue state directly except through events;
- share its profile with another process.

### Projection Worker

Responsibilities:

- reduces event streams into current state tables;
- can rebuild projections after merge/import;
- reports invalid transitions.

Initially, projection can run inline in the API/server process after each command. Later it can become its own worker.

## Concurrency Rules

Global:

- `max_active_browser_profiles`
- `max_commands_per_profile`
- `max_queue_dispatch_per_minute`

Per profile:

- one persistent context;
- one active command at a time for MVP;
- optional multiple pages later if page-level concurrency proves safe.

Per listing:

- one active resolve command per `listing_id`;
- requeue creates a new command, not a mutation of the old command;
- duplicate commands are deduped by reducer using `listing_id`, command status, and queue state.

## Database Changes

Phase 1 tables:

```sql
CREATE TABLE browser_profiles (
  profile_id TEXT PRIMARY KEY,
  profile_dir TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE browser_commands (
  command_id TEXT PRIMARY KEY,
  command_type TEXT NOT NULL,
  listing_id TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  profile_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  requested_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  claimed_by TEXT NOT NULL DEFAULT '',
  workflow_run_id TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT NOT NULL DEFAULT '{}',
  error TEXT NOT NULL DEFAULT ''
);

CREATE TABLE browser_command_events (
  event_id TEXT PRIMARY KEY,
  command_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_at TEXT NOT NULL,
  source_id TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL DEFAULT '',
  profile_id TEXT NOT NULL DEFAULT '',
  workflow_run_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  error TEXT NOT NULL DEFAULT ''
);
```

`browser_commands` is a projection. `browser_command_events` is the durable audit log.

## Profile Lock Helper

Add a shared helper used by all scripts that launch persistent Chromium:

```text
scripts/marketplace-browser-profile-lock.js
```

Responsibilities:

- resolve profile ID and directory;
- acquire DB lease;
- check Chromium singleton lock files;
- heartbeat while running;
- release lease on clean shutdown;
- provide clear failure messages when another owner is active.

All browser-launching scripts should use this helper:

- `collect-marketplace-homepage.js`
- `collect-marketplace-search-explorer.js`
- `process-marketplace-homepage-backlog.js`
- `bootstrap-marketplace-auth.js`
- `headless-marketplace-auth-onboarding.js`
- legacy capture/extract scripts if still supported.

## UI/API Changes

Add UI sections:

- Browser Profiles
- Active Browser Owners
- Command Queue
- Command Audit

Workflow start changes:

- Starting a collector/resolver no longer means directly owning the shared profile by default.
- UI creates commands and starts or wakes workers.
- The server can still offer a "single local worker" MVP mode that starts one browser owner.

Backlog tab changes:

- queue item status should show both resolve status and command status;
- selected listings should enqueue resolve events;
- command progress should appear in the sidebar and worker detail view.

## Failure Handling

Profile lease failure:

- emit `browser_profile_lease_rejected`;
- keep queued work queued;
- show actionable UI message.

Browser crash:

- emit `browser_command_failed` for active command;
- release or expire profile lease;
- keep command retryable if failure is browser-level.

Facebook checkpoint/session failure:

- emit `browser_session_blocked` or `browser_auth_required`;
- pause profile from new commands;
- leave queue items unresolved;
- require operator action.

Command timeout:

- emit `browser_command_failed` with timeout reason;
- retry according to queue policy.

## Implementation Plan

### Phase 1: Enforce One Owner Per Existing Profile

- Add profile lease helper.
- Use it in all persistent-context launch scripts.
- Add UI/API error handling for lease conflicts.
- Keep existing singleton UI guard.
- Add tests for lease acquire, heartbeat, expiry, and release.

### Phase 2: Browser Command Events

- Add `browser_command_events` and `browser_commands`.
- Add command append/list/claim helpers.
- Add deterministic command reducer.
- Add audit view for command events.
- Keep resolver execution mostly as-is, but have it emit command lifecycle events.

### Phase 3: Single Browser Broker

- Add `scripts/marketplace-browser-owner.js`.
- Browser owner acquires profile lease and processes browser commands.
- UI and scheduler stop launching detail resolver directly for selected queue items.
- Existing resolver logic is refactored into callable command handlers.

### Phase 4: Scheduler Worker

- Add scheduler that converts resolve queue items into browser commands.
- Enforce one active command per listing.
- Add retry/backoff policy.
- Add stale command recovery.

### Phase 5: Profile Pool

- Add profile registration UI/API.
- Allow multiple browser owners with different `profile_id`s.
- Add per-profile health and auth state.
- Add concurrency/rate controls.

## MVP Acceptance Criteria

- Two processes cannot open the same profile through project scripts.
- A rejected profile lease is visible in the UI and audit log.
- Browser commands have append-only audit events.
- Queue items can be converted into browser commands.
- A command can be claimed, run, succeed/fail, and update projections.
- The current singleton mode still works.
- Profile-pool mode can run two workers only when they use different profile directories.

## Open Decisions

- Whether command events should live in a shared `app_events` table or separate `browser_command_events`.
- Whether the scheduler runs inside the UI server at first or as a separate process.
- Whether a browser owner should support multiple pages per profile later.
- Whether profile registration should support multiple Facebook accounts or only cloned/manual profiles.
- How aggressively to pause profiles on challenge/session-health signals.
