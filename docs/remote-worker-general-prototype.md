# Remote Worker General Prototype

## Purpose

This document defines the general remote-worker prototype. Worker-specific code
should be a thin adapter. The runtime should not care whether work came from a
host queue, an operator command, a local schedule, a file import, or adapter
discovery. All work is normalized into a task envelope before execution.

Related docs:

- `docs/remote-worker-host-api-v2-design.md`
- `docs/remote-worker-installable-runtime-design.md`
- `docs/remote-worker-outbox-runtime-design.md`

## Core Shape

```text
remote-worker-runtime
  -> load config
  -> register/resume host session
  -> start heartbeat loop
  -> start event/artifact sync loop
  -> poll task injectors
  -> normalize task envelope
  -> reserve local task row
  -> execute adapter
  -> commit local state + outbox events
  -> upload event batches
  -> ACK/compact only after host accepts
```

The adapter owns domain behavior. The runtime owns durability, auth, liveness,
backpressure, retries, and event upload.

## Code-Directed Local Writes

Worker content and worker local DB writes are code-directed, not host-directed.
The host may inject tasks and configuration, but it must not send arbitrary SQL,
JavaScript, selectors, reducers, or write instructions for the worker to execute.

Allowed host influence:

- task type;
- task payload;
- adapter config;
- scheduling limits;
- lease duration;
- drain/shutdown command;
- operator input for interactive workers.

Disallowed host influence:

- raw SQL against the worker local DB;
- arbitrary code execution;
- arbitrary filesystem paths;
- direct mutation of local outbox rows;
- direct mutation of canonical host tables by the worker;
- unregistered event or payload shapes.

Local writes happen through runtime-owned repositories:

```text
TaskRepository
OutboxRepository
ArtifactRepository
StateRepository
CommandRepository
LeaseRepository
```

Adapters can request writes only through these repositories. This gives us one
place to enforce idempotency, transactions, status transitions, retention, and
crash recovery.

Example adapter boundary:

```js
async function executeTask(task, context) {
  const result = await computeDomainResult(task.payload);
  await context.transaction(async (tx) => {
    await tx.tasks.markCompleted(task.taskId);
    await tx.outbox.append({
      exchangeType: 'remote_event',
      eventType: 'backlog_listing_metadata_indexed',
      payload: result,
    });
  });
}
```

The adapter controls domain content. The runtime controls how that content is
persisted, synced, acknowledged, and compacted.

## Data Exchange Type Contracts

All data exchanged between host and worker must be one of a small number of
typed contracts. The type determines validation, storage, retry, ACK, and
projection behavior.

```text
WorkerEnrollmentRequest
WorkerTokenEnvelope
SessionRegisterRequest
SessionRegisterResponse
HeartbeatSnapshot
HeartbeatResponse
TaskEnvelope
HostClaimEnvelope
HostCommandEnvelope
LeaseRenewRequest
RemoteEventEnvelope
EventBatchEnvelope
EventBatchAck
ArtifactManifest
ArtifactUploadAck
TokenRotationRequest
TokenRotationResponse
ErrorEnvelope
```

Each type has:

- a `schemaVersion`;
- a stable identity key;
- required fields;
- maximum serialized size;
- idempotency behavior;
- retry behavior;
- storage table;
- projection/reducer rule.

Examples:

```text
TaskEnvelope
  identity: taskId
  dedupe: taskSource + dedupeKey
  local storage: worker_tasks
  host projection: none directly

RemoteEventEnvelope
  identity: eventId
  order: sessionId + sequence
  local storage: worker_outbox_events
  host storage: remote_worker_event_ingest
  host projection: workflow/listing/recommendation reducers

ArtifactManifest
  identity: artifactId
  dedupe: sha256
  local storage: worker_artifact_spool
  host storage: remote_worker_artifacts
  host projection: media/artifact reference after ACK

HeartbeatSnapshot
  identity: sessionId + heartbeatAt
  local storage: worker_state checkpoint
  host storage: remote_worker_sessions / heartbeat history
  host projection: worker health row
```

The central rule is:

```text
host sends typed tasks/config/commands
worker sends typed heartbeats/events/artifacts
host sends typed ACK/checkpoints
```

No side should infer state from untyped logs, raw screenshots, or free-form JSON
when a typed envelope exists.

## Runtime Plane Invariant

Communication, state management, and health control are the same for every
worker. Task injection changes only how a task enters the local queue.

Shared runtime plane:

```text
auth
session registration/resume
heartbeat
host command polling
claim polling
local task queue
local state machine
local outbox
artifact spool
event batch upload
ACK/checkpoint persistence
backpressure
health projection
shutdown/drain handling
```

Variable task plane:

```text
host claim injector
host command injector
local schedule injector
local file/CLI injector
adapter discovery injector
interactive input injector
```

All injectors must normalize into the same `TaskEnvelope`. After that point,
the runtime treats every task the same:

```text
TaskEnvelope
  -> validate
  -> dedupe
  -> persist local task
  -> reserve when scheduler allows
  -> execute adapter
  -> append local outbox events
  -> upload batch
  -> persist host ACK
  -> compact when safe
```

This keeps the central app simple: it receives the same remote session,
heartbeat, event batch, artifact, lease, and command protocol regardless of
whether the work originated from a host queue, a schedule, an operator command,
or page discovery.

## Prototype Implementation Slice

The first implementation slice is intentionally small and host-compatible:

- `scripts/remote-worker-contracts.js` validates exchange envelopes,
  task envelopes, remote event envelopes, and artifact manifests.
- `scripts/remote-worker-auth.js` provides bearer parsing plus the target HMAC
  canonical request/signature verifier.
- `scripts/remote-worker-scheduler.js` decides whether a remote worker can claim
  work and plans ordered event batches under count/byte budgets.
- `scripts/serve-marketplace-homepage.js` hosts the first
  `/api/v2/remote-workers/*` endpoints for session registration, heartbeat,
  event ingest, duplicate ACK-equivalence, and ingest inspection.
- `scripts/marketplace-worker-events.js` includes per-listing backlog indexer
  result events so remote task output can be validated with the same registry as
  local workers.

The host API currently accepts a scoped bearer worker token for the MVP
integration path. HMAC signed requests are implemented as a reusable helper and
should become the default once token storage/nonce persistence is added to the
host.

## Variable Task Content

Task-specific content is data, not executable behavior. Every adapter can define
its own payload schema, but the runtime boundary is fixed.

Common task fields:

```text
taskId
taskSource
taskType
workerType
strategy
dedupeKey
entityType
entityId
lease
payload
createdAt
```

Adapter-specific payload examples:

```text
backlog_indexer/resolved_metadata
  payload.items[]
    listingId
    resolvedDetail
    currentMetadata
    sourceVersion

collector/search
  payload.query
  payload.source
  payload.location
  payload.minPrice
  payload.maxPrice
  payload.maxItems

resolver/backlog
  payload.listingId
  payload.href
  payload.claimId
  payload.expectedContentHash

observe_generate_worker/external_workflow
  payload.url
  payload.recordingArtifactIds[]
  payload.goalLabel
  payload.allowedDomains[]
```

Disallowed payload fields are rejected at the contract layer:

```text
sql
statement
code
script
shell
commandLine
filesystemWrite
reducer
reducerPatch
```

This keeps adapter content variable while preserving one communication,
state-management, health, ACK, artifact, and backpressure model.

## Task Envelope

Every injected task becomes:

```json
{
  "taskId": "task-01J...",
  "taskSource": "host_claim",
  "taskType": "index_resolved_listing_metadata_batch",
  "workerType": "backlog_indexer",
  "strategy": "resolved_metadata",
  "priority": 100,
  "dedupeKey": "index:resolved_metadata:batch-01J",
  "entityType": "listing_batch",
  "entityId": "batch-01J",
  "lease": {
    "leaseId": "lease-01J...",
    "claimId": "claim-01J...",
    "commandId": "command-01J...",
    "expiresAt": "2026-06-27T12:03:00.000Z"
  },
  "payload": {},
  "constraints": {
    "deadlineAt": "",
    "maxRuntimeSeconds": 180,
    "requiresHostOnline": false,
    "requiresBrowserProfile": false,
    "requiresArtifactUpload": false
  },
  "createdAt": "2026-06-27T12:00:00.000Z"
}
```

Required fields:

- `taskId`
- `taskSource`
- `taskType`
- `workerType`
- `strategy`
- `dedupeKey`
- `payload`

Remote host queue work must include lease identity. Local scheduled tasks may
omit lease identity but still need deterministic `taskId` and `dedupeKey`.

## Task Injection Sources

### Host Claims

Host claims are the main production path.

```text
POST /api/v2/remote-workers/sessions/:sessionId/claims
```

Use for:

- backlog indexer batches;
- backlog resolver work;
- future recommendation indexer work;
- any task where the host owns canonical queue state.

Properties:

- host issues lease;
- worker must renew lease for long work;
- terminal events are valid only for that lease/claim/command envelope;
- host can reassign after lease expiry.

### Host Commands

Commands are operator or host-control inputs:

```text
GET /api/v2/remote-workers/sessions/:sessionId/commands
```

Use for:

- shutdown;
- drain;
- submit verification code;
- continue after manual browser approval;
- rotate token;
- run diagnostic task;
- change config revision.

Commands normalize into task envelopes when they require adapter work. Pure
runtime commands, such as drain or shutdown, can be handled directly by the
runtime.

### Local Schedule

Local schedule injection is useful when work is periodic and not tied to a
canonical host queue.

Examples:

- heartbeat diagnostics;
- local artifact compaction;
- retry outbox upload;
- browser session validation;
- source-specific exploration rounds when host allows autonomous collection.

Rules:

- scheduled tasks must respect host drain/shutdown flags;
- scheduled domain tasks should stop when host is offline unless explicitly
  allowed by config;
- deterministic `dedupeKey` prevents duplicate scheduled work after restart.

### Local File Or CLI Seed

A worker can be bootstrapped with local input:

```bash
marketplace-remote-worker run-once --task-file tasks.jsonl
marketplace-remote-worker run-once --listing-id 973408764691929
marketplace-remote-worker run-once --query "pentax 67 105"
```

Use for:

- development;
- one-shot diagnostics;
- controlled local import;
- recovering a small set of known tasks.

Rules:

- results still go through local outbox and host ACK;
- local task source must be visible in event payload/envelope;
- host may reject events if the worker token lacks permission for local tasks.

### Adapter Discovery

Some collectors discover work while navigating.

Examples:

- search collector discovers listing cards;
- homepage collector discovers feed items;
- eBay collector discovers result items;
- meta-observer discovers page interaction structure.

Discovered items should become either:

- direct local outbox events, if observation is the task result; or
- child task envelopes, if each item needs follow-up work.

The runtime must apply a local cap so adapter discovery cannot create an
unbounded local backlog.

### Interactive Operator Input

Profile onboarding and challenge handling may require user input.

Input path:

```text
host UI -> host command -> worker command poll -> task envelope
```

The worker should never expose an unauthenticated inbound control port for
operator input. Keeping input pull-based through the host works behind NAT and
keeps the host audit trail complete.

## Local Task Table

Minimum local task table:

```sql
CREATE TABLE worker_tasks (
  task_id TEXT PRIMARY KEY,
  task_source TEXT NOT NULL,
  task_type TEXT NOT NULL,
  worker_type TEXT NOT NULL,
  strategy TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  dedupe_key TEXT NOT NULL,
  entity_type TEXT NOT NULL DEFAULT '',
  entity_id TEXT NOT NULL DEFAULT '',
  lease_id TEXT NOT NULL DEFAULT '',
  claim_id TEXT NOT NULL DEFAULT '',
  command_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued',
  payload_json TEXT NOT NULL DEFAULT '{}',
  constraints_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT '',
  completed_at TEXT NOT NULL DEFAULT '',
  acked_at TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  UNIQUE(task_source, dedupe_key)
);
```

Task states:

```text
queued -> reserved -> running -> completed -> acked -> compacted
queued -> reserved -> running -> failed -> queued
queued -> canceled
running -> interrupted
running -> rejected
```

The worker should commit task state and outbox events in the same local
transaction whenever a domain action changes state.

## Adapter Interface

```js
const adapter = {
  workerType: 'backlog_indexer',
  strategy: 'resolved_metadata',
  supportedTaskTypes: [
    'index_resolved_listing_metadata_batch',
  ],
  async validateTask(task, context) {},
  async executeTask(task, context) {},
  async recoverTask(task, context) {},
  async canRun(context) {},
};
```

`context` provides:

- local DB transaction helpers;
- outbox event appender;
- artifact spooler;
- host checkpoint;
- logger;
- cancellation signal;
- lease renew helper;
- browser/profile lease helper when applicable.

Adapters must not call the host API directly for event ingestion. They append
events locally and let the runtime sync loop upload them.

## Runtime Scheduler

The scheduler chooses the next task from local `worker_tasks` only if:

- host auth is valid;
- session is connected or the task allows offline completion;
- local outbox is below threshold;
- artifact spool is below threshold;
- disk free space is above threshold;
- active task count is below capacity;
- worker is not draining or shutting down;
- adapter reports `canRun`.

Priority order:

```text
operator safety commands
lease renewals
running task recovery
host claims
host commands
local scheduled tasks
local file/CLI tasks
adapter discovery child tasks
```

## Idempotency And Deduplication

Each task source must produce stable dedupe keys.

Examples:

```text
host_claim:index_resolved_listing_metadata_batch:command-01J
host_command:submit_verification_code:command-01J
schedule:session_validation:2026-06-27T12:00
file:resolve_listing:973408764691929
discovery:listing_observed:ebay:366493525268
```

Duplicate injected tasks should return the existing local task row instead of
creating a new one.

## Health Reporting

Heartbeat should report task-injection health:

```json
{
  "taskQueues": {
    "queued": 12,
    "running": 1,
    "failed": 0,
    "bySource": {
      "host_claim": 8,
      "schedule": 2,
      "adapter_discovery": 2
    }
  },
  "activeTask": {
    "taskId": "task-01J...",
    "taskType": "index_resolved_listing_metadata_batch",
    "taskSource": "host_claim",
    "entityId": "batch-01J"
  }
}
```

This lets the dashboard show worker progress without scanning raw local task
events.

## First Prototype Scope

Build the prototype in this order:

1. `TaskEnvelope` normalizer and validator.
2. Local `worker_tasks` queue table.
3. Host-claim injector.
4. Local schedule injector.
5. Adapter interface with a mock adapter.
6. Event outbox append from adapter execution.
7. Heartbeat task summary.
8. Backlog indexer adapter.
9. Browser resolver adapter.

Do not start with browser automation. Prove task injection, local durability,
event ACK, and host health first.
