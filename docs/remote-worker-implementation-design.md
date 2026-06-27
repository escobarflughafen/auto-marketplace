# Remote Worker Implementation Design

## Purpose

This document begins the concrete design for remote workers. It keeps the same
worker goals, worker types, strategies, profile model, and event skills that the
current managed workers already use.

Related design docs:

- `docs/remote-worker-api-v1-design-review-ticket.md`
- `docs/remote-worker-outbox-runtime-design.md`
- `docs/remote-worker-liveness-and-offline-behavior.md`
- `docs/remote-worker-installable-runtime-design.md`

## Design Rule

Remote workers are not a new kind of worker.

They are the same worker responsibilities running through a safer runtime:

```text
current worker skill
  + local durable state
  + local outbox
  + host API transport
  + host reducer ACK
  = remote worker
```

The remote runtime must preserve the current registry in
`scripts/marketplace-worker-events.js`:

```text
collector
- feed
- search
- explorer

resolver
- queue
- selected
- filtered

backlog_indexer
- resolved_metadata

profile_onboarder
- guided_login
```

Worker scripts may change transport, but they should not change the semantic
event vocabulary.

Remote-specific transport identifiers such as `leaseId`, `claimId`,
`commandId`, `sessionId`, and local `sequence` are part of the normalized remote
event envelope. They should not be forced into every event payload definition in
`scripts/marketplace-worker-events.js`.

Validation has two layers:

1. registry validation: `workerType + strategy + eventType + required payload`;
2. remote envelope validation: session, sequence, lease, claim, command, and
   ACK/checkpoint requirements.

For compatibility with current resolver events, `claimId` may still be copied
into payload where the registry already allows it. `leaseId` and `commandId`
should stay envelope-level unless the registry is intentionally expanded.

## Current Worker Skills To Preserve

### Collector

Existing workflow ids:

- `home-collect`
- `search-explore`

Remote worker type:

- `workerType = collector`

Remote strategies:

- `feed`: homepage feed collection;
- `search`: explicit query collection;
- `explorer`: seed query plus random walk collection.

Required skills:

- launch a browser context with the saved profile;
- reuse or establish Facebook session;
- navigate homepage/search pages;
- apply location, radius, condition, listed-within-days, and keyword price
  target settings;
- collect visible listing cards;
- emit `collector_cycle_started`;
- emit `collector_query_selected` when search/explorer chooses a query;
- emit one `listing_observed` event per observed listing;
- emit `collector_cycle_completed` or `collector_cycle_failed`;
- write screenshots/snapshots as artifacts, not direct canonical state.

Remote-specific behavior:

- collection can continue only while local outbox backlog is below configured
  limits;
- random walks should not inherit per-keyword price filters unless that is part
  of the selected seed target;
- high-volume `listing_observed` events should flush in batches.

### Resolver

Existing workflow ids:

- `backlog-resolve`
- `backlog-worker`

Remote worker type:

- `workerType = resolver`

Remote strategies:

- `queue`: continuously claim eligible host work;
- `selected`: resolve explicit listing ids;
- `filtered`: resolve items matching host filters.

First remote implementation:

- implement only backlog queue mode;
- do not implement selected/list-driven resolver mode yet;
- do not implement filtered resolver mode until the host query/claim contract is
  revised.

Required skills:

- launch a browser context with the saved profile;
- reuse or establish Facebook session;
- claim or receive listing detail work;
- persist `leaseId` and `claimId` locally before opening the page;
- emit `detail_capture_started`;
- capture title, price, seller/location text, description, listed-time text,
  availability, screenshot, snapshot, and content hash when available;
- emit `detail_capture_succeeded`, `detail_capture_bypassed`,
  `detail_capture_failed`, `detail_capture_interrupted`, or
  `listing_unavailable`;
- emit `content_changed` when a resolved listing's content hash changes;
- emit command lifecycle events when work is dispatcher-driven.

Remote-specific behavior:

- finish the current listing during brief host outages only if local disk can
  durably store events and artifacts;
- never claim another listing while the host is offline;
- terminal events for host-queue work must include `leaseId`, `claimId`, and
  `commandId` in the remote event envelope;
- stale terminal events are retained for audit but skipped by host projection if
  the claim was reassigned.

### Backlog Indexer

Existing workflow id:

- `backlog-indexer`

Remote worker type:

- `workerType = backlog_indexer`

Remote strategy:

- `resolved_metadata`

Required skills:

- process already resolved listing data;
- compute post-resolution metadata such as listed-time normalization;
- emit `backlog_index_started`;
- emit `backlog_index_completed` or `backlog_index_failed`;
- avoid browser profile leasing.

Remote-specific behavior:

- this is the first recommended real worker to move because it does not require
  Facebook browser state;
- it should receive resolved listing payloads or host commands, not open the
  central SQLite database directly;
- it can tolerate longer offline periods, but still pauses at outbox limits.

### Backlog Indexer First Slice Contract

The first non-mock remote worker should be `backlog_indexer`, but it needs a
concrete command and result contract before implementation.

Host command type:

```text
index_resolved_listing_metadata_batch
```

Command payload:

```json
{
  "items": [
    {
      "listingId": "973408764691929",
      "title": "Mint Leica 35mm 1.4 summilux pre-a titanium",
      "price": 4200,
      "description": "Resolved markdown or plain text",
      "detailListedAgo": "Listed 3 days ago",
      "detailLocation": "Vancouver, BC",
      "resolvedAt": "2026-06-16T12:00:00.000Z",
      "contentHash": "hex"
    }
  ],
  "indexerVersion": "resolved-metadata-v1"
}
```

Required output events:

```text
backlog_index_started
backlog_listing_metadata_indexed
backlog_listing_metadata_skipped
backlog_index_completed
backlog_index_failed
```

`backlog_listing_metadata_indexed` should be a listing-scope event registered
for `workerType = backlog_indexer` and `strategy = resolved_metadata`.

Payload:

```json
{
  "listingId": "973408764691929",
  "indexerVersion": "resolved-metadata-v1",
  "listedAtMin": "2026-06-13T00:00:00.000Z",
  "listedAtMax": "2026-06-13T23:59:59.999Z",
  "listedAgeSecondsMin": 172800,
  "listedAgeSecondsMax": 259199,
  "sourceFields": ["detailListedAgo", "resolvedAt"],
  "confidence": "high"
}
```

`backlog_listing_metadata_skipped` should include:

```json
{
  "listingId": "973408764691929",
  "reason": "missing_detail_listed_ago"
}
```

Host projection rule:

- reduce indexed metadata events into the canonical listing metadata projection;
- do not let the worker write the projection table directly;
- command completion ACK happens only after result events are durably ingested;
- duplicate result events are idempotent by event id and listing id.

Before coding this worker, add the two per-listing metadata events to
`scripts/marketplace-worker-events.js` and tests.

### Profile Onboarder

Existing workflow id:

- `profile-onboarder`

Remote worker type:

- `workerType = profile_onboarder`

Remote strategy:

- `guided_login`

Required skills:

- open the saved browser profile in headed or headless mode;
- submit configured credentials when allowed;
- detect login, checkpoint, two-factor, and external approval states;
- emit `profile_onboarding_started`;
- emit `profile_onboarding_step`;
- emit `credentials_submitted`;
- emit `verification_required` or `external_approval_required`;
- receive dashboard commands;
- emit `user_command_received` before acting on user input;
- emit `profile_ready` or `profile_onboarding_failed`.

Remote-specific behavior:

- this worker remains interactive and should be exclusive for a profile lease;
- if the host is offline, it must not auto-submit sensitive user inputs;
- it may keep the browser open while waiting, but should preserve screenshots and
  step events locally until host ACK.

## Shared Profile Model

The remote worker can share the saved profile model with the current workers.
Do not invent a separate profile concept.

Current profile assets:

```text
profiles/facebook-marketplace
credentials.json
AUTO_BROWSER_CREDENTIALS_PATH
AUTO_BROWSER_CREDENTIALS_PROFILE
```

Remote profile config should resolve to the same concepts:

```json
{
  "profile": {
    "profileId": "facebook-marketplace",
    "profileDir": "profiles/facebook-marketplace",
    "credentialsPath": "credentials.json",
    "credentialsProfile": "default",
    "authMode": "credentials"
  }
}
```

On the remote machine, `profileDir` may be a local copy of the saved profile.
The host should treat `profileId` as the logical identity and `profileDir` as
worker-local storage.

### Profile Sharing Rules

1. Browser workers must acquire a host profile lease before opening the profile.
2. The lease key is `profileId`, not local path.
3. `collector`, `resolver`, and `profile_onboarder` require profile lease
   support.
4. `backlog_indexer` does not require a profile lease.
5. `profile_onboarder` is exclusive and can block other browser workers for the
   same profile.
6. `collector` and `resolver` may share the same saved profile over time, but
   not by opening the exact same profile directory concurrently on the same
   machine unless the browser runtime supports it safely.
7. A remote worker should report both `profileId` and `profileDir` in lifecycle
   events.

Recommended host profile lease states:

```text
available
leased
renewing
draining
expired
released
rejected
```

Lease events should reuse existing registry events:

- `profile_lease_acquired`
- `profile_lease_rejected`
- `profile_lease_released`

`renewing`, `draining`, and `expired` are host lease table states for the MVP.
They do not require new worker-originated events unless the UI needs an
auditable transition later.

## Worker Package Boundary

The worker runtime should be a common package-like module used by worker
adapters:

```text
RemoteWorkerRuntime
- owns local DB
- registers/resumes session
- sends heartbeats
- claims/renews/releases leases
- appends outbox events
- uploads artifacts
- flushes events
- handles shutdown
- exposes worker context to adapters

WorkerAdapter
- declares workerType and strategy
- validates config
- starts domain work
- emits only registered semantic events
- never writes central DB
```

Adapter shape:

```js
{
  workerType: 'resolver',
  strategy: 'queue',
  requiredCapabilities: ['browser', 'profileLease', 'artifactUpload'],
  async prepare(context) {},
  async run(context) {},
  async stop(context, reason) {}
}
```

The `context` object should expose:

```text
context.config
context.session
context.profile
context.browser
context.claimWork()
context.renewLease()
context.emitEvent()
context.spoolArtifact()
context.flushOutbox()
context.isShutdownRequested()
context.setRuntimeState()
```

Adapters should not receive a central DB handle.

## Worker Startup Contract

All remote workers follow the same startup:

1. Load config from CLI/env/profile.
2. Open local worker SQLite database.
3. Register or resume host session.
4. Negotiate capabilities and API version.
5. Emit `worker_started` after the host accepts the session and the process is
   booting.
6. Reconcile host checkpoint.
7. Acquire profile lease if required.
8. Launch browser if required.
9. Run adapter loop.
10. Flush terminal events before shutdown when possible.

Collector and resolver browser workers additionally emit the common browser
lifecycle events already registered for those worker types:

- `browser_context_launch_started`
- `browser_context_ready`
- `session_ready`
- `browser_context_closing`
- `browser_context_closed`

`profile_onboarder` is browser-capable, but for the MVP it should keep using the
onboarding-specific registered events: `profile_onboarding_started`,
`profile_onboarding_step`, `credentials_submitted`, `verification_required`,
`external_approval_required`, `profile_ready`, and
`profile_onboarding_failed`. Expand the registry later if we want common
`browser_context_*` events for onboarder too.

## Capability Negotiation

Each worker registers capabilities so the host can reject incompatible workers
before they start domain work.

Example:

```json
{
  "workerType": "resolver",
  "strategy": "queue",
  "capabilities": {
    "apiVersion": "v1",
    "eventRegistryVersion": "marketplace-worker-events@1",
    "localOutbox": true,
    "artifactUpload": true,
    "profileLease": true,
    "browser": true,
    "interactiveCommands": false,
    "maxEventBatchSize": 100,
    "supportedEventTypes": [
      "worker_started",
      "worker_heartbeat",
      "worker_sleeping",
      "worker_completed",
      "worker_failed",
      "shutdown_requested",
      "profile_lease_acquired",
      "profile_lease_rejected",
      "profile_lease_released",
      "browser_context_launch_started",
      "browser_context_ready",
      "browser_context_closing",
      "browser_context_closed",
      "session_ready",
      "auth_required",
      "resolver_idle",
      "detail_capture_started",
      "detail_capture_succeeded",
      "detail_capture_bypassed",
      "detail_capture_failed",
      "detail_capture_interrupted",
      "listing_unavailable",
      "content_changed",
      "browser_command_claimed",
      "browser_command_started",
      "browser_command_succeeded",
      "browser_command_failed"
    ]
  }
}
```

If `supportedEventTypes` is treated as a strict allowlist, it must be generated
from `scripts/marketplace-worker-events.js` for the selected worker type and
strategy plus any registered lifecycle events. A hand-written partial list is
only documentation, not a safe implementation source.

The host validates:

- worker type and strategy are known;
- event types are registered for that type/strategy;
- required host features are available;
- profile lease can be granted for browser workers;
- worker version is accepted.

If negotiation fails, the worker enters `incompatible` and does not start domain
work.

## Configuration Sources

Remote workers should support the same user-facing configuration as the current
worker setup page, but serialized into a portable profile.

Sources in precedence order:

1. bootstrap CLI/env: worker id, host URL, token env var, local DB path;
2. host-issued worker parameter profile and safety limits;
3. local config defaults;
4. one-off CLI adapter overrides only when the host explicitly allows them.

For remote workers, host-issued config owns strategy, profile identity,
concurrency/safety limits, and adapter behavior. CLI flags should not silently
override central scheduling policy.

Example config:

```json
{
  "runtime": {
    "workerId": "resolver-host103-01",
    "workerType": "resolver",
    "strategy": "queue",
    "localDbPath": "artifacts/remote-workers/resolver-host103-01/worker.db"
  },
  "transport": {
    "hostBaseUrl": "http://10.10.20.3:21435",
    "apiVersion": "v1",
    "workerTokenEnv": "MARKETPLACE_WORKER_TOKEN"
  },
  "profile": {
    "profileId": "facebook-marketplace",
    "profileDir": "profiles/facebook-marketplace",
    "authMode": "credentials",
    "credentialsPath": "credentials.json",
    "credentialsProfile": "default",
    "headless": true
  },
  "adapter": {
    "batchSize": 1,
    "pollIntervalSeconds": 30,
    "pollJitterMin": 0.5,
    "pollJitterMax": 1.5,
    "itemDelaySeconds": 8
  }
}
```

Saved worker parameter profiles in the central app can be reused as the source
for `adapter` and `profile` fields. The remote worker should receive a resolved
copy at session start so it does not need direct DB access.

## Event Emission Rule

All remote worker events must pass through the same validation rule as local
worker events:

```text
workerType + strategy + eventType + required payload keys
```

The worker runtime should validate locally before putting an event into the
outbox. The host validates again before ACK.

This gives fast local feedback and protects the canonical database.

## Debugging And Logging Model

Do not make product events, debug logs, and Docker logs the same thing.

Use three layers:

```text
semantic events
  -> local outbox
  -> host event ingest
  -> reducer/audit/UI

process logs
  -> stdout/stderr as structured lines
  -> Docker/systemd log driver
  -> operator debugging

local diagnostic traces
  -> worker-local rolling files or SQLite rows
  -> optional host-uploaded excerpts
  -> deep debugging after failure
```

### Semantic Events

Semantic events are durable facts that the product can reduce:

- `worker_started`
- `profile_lease_acquired`
- `detail_capture_started`
- `detail_capture_succeeded`
- `backlog_listing_metadata_indexed`
- `worker_failed`

These must go through the outbox and ACK protocol. They are not optional and
must not depend on Docker log retention.

### Process Logs

Process logs are operational debugging output:

- browser launch command and PID;
- Playwright/browser stderr summaries;
- retry/backoff messages;
- request latency to the host API;
- memory/CPU snapshots;
- unhandled exception stack traces;
- signal handling;
- local outbox flush summaries.

Remote workers should write process logs to stdout/stderr as one structured
line per record. Docker, Compose, systemd, or another supervisor should own log
capture, rotation, and retention.

Recommended JSONL shape:

```json
{
  "ts": "2026-06-16T12:00:00.000Z",
  "level": "info",
  "workerId": "resolver-host103-01",
  "sessionId": "remote-session-01J...",
  "workerType": "resolver",
  "strategy": "queue",
  "component": "event-sync",
  "message": "flush accepted",
  "fields": {
    "batchId": "batch-01J...",
    "accepted": 25,
    "duplicates": 0,
    "rejected": 0,
    "elapsedMs": 184
  }
}
```

Human text logs are acceptable for early prototypes, but production remote
workers should prefer JSONL so Docker logs can be filtered by `workerId`,
`sessionId`, `level`, and `component`.

### Local Diagnostic Traces

Some debugging data is too noisy or sensitive for the host event stream:

- full Playwright traces;
- browser console/network samples;
- raw page text around auth checkpoints;
- screenshots that may include account state;
- repeated low-level selector attempts.

Store these locally under the worker artifact directory and reference them from
process logs or semantic events by artifact id/path. Upload only bounded,
operator-requested excerpts to the host.

### Host Visibility

The host should not ingest full Docker logs into the canonical event tables.
Instead, it should expose:

- latest semantic worker events from event ingest;
- worker liveness, pending outbox, and last error from heartbeat/session state;
- optional recent process-log excerpts for the selected worker/session;
- links or artifact ids for screenshots/traces.

For MVP, recent process-log excerpts can be best-effort and non-reducing. They
should help explain why a worker exited, not define canonical listing state.

### Docker Responsibility

Docker or the service supervisor should handle:

- process stdout/stderr capture;
- container start/stop/restart logs;
- exit code and signal;
- log rotation;
- coarse resource metrics.

The worker should still emit a terminal semantic event when it can. If the
process crashes before that event, the host liveness reducer and supervisor logs
together explain the failure:

```text
host view: heartbeat expired, session became lost
docker view: process exited with code/signal and stack trace in stderr
worker local view: unacked outbox rows remain for recovery
```

### What Not To Do

- Do not rely on Docker logs as the durable audit trail.
- Do not put high-volume debug logs into the outbox.
- Do not let reducers parse text logs to infer listing/workflow state.
- Do not upload full browser traces automatically on every failure.
- Do not block event ACK on process-log upload.

## Browser Profile Lease Flow

```text
worker starts
  -> register session
  -> request profile lease(profileId)
  -> host grants lease with expiry
  -> worker emits profile_lease_acquired
  -> worker launches persistent context(profileDir)
  -> worker emits browser_context_ready
  -> worker verifies session/auth
  -> worker runs adapter work
  -> worker closes browser
  -> worker releases profile lease
  -> worker emits profile_lease_released
```

If lease is rejected:

```text
host response: rejected(ownerId, leaseExpiresAt, reason)
  -> worker emits profile_lease_rejected
  -> worker sleeps or exits depending on mode
```

Profile lease renewal should be independent from work lease renewal. A resolver
may have both:

- profile lease: permission to use the browser profile;
- work lease: permission to resolve a specific listing command.

## Worker Type Rollout Order

Recommended order:

1. Mock remote worker with test commands only.
2. `backlog_indexer`, because it does not need browser/profile state.
3. `resolver` backlog queue mode with one item at a time.
4. `collector` search/explorer mode with strict event batch and backlog limits.
5. `profile_onboarder`, after interactive command transport is proven.

This order reduces risk while proving the outbox, ACK, lease, and reducer model.

## Acceptance Criteria

- Remote worker types and strategies match the existing event registry.
- Browser-capable workers can reuse the saved profile and credential profile.
- Profile usage is protected by a host-issued profile lease.
- Worker adapters never receive a central DB handle.
- Worker adapters emit the same semantic events as current local workers.
- Local validation and host validation use the same event registry semantics.
- The first implementation can run without Facebook by using a mock adapter.
- The first browser implementation can run with the existing
  `profiles/facebook-marketplace` profile model.
