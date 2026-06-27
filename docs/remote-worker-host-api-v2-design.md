# Remote Worker Host Receiving API v2

## Purpose

This document defines the central web app receiving API for installable remote
workers. It intentionally uses `/api/v2` to separate the new remote-worker
contract from the existing dashboard and compatibility APIs.

The central host is the only canonical database writer. Remote workers send
authenticated, ordered, idempotent messages over outbound HTTP(S). The host
validates, stores, acknowledges, and reduces those messages into canonical
projections.

Related docs:

- `docs/remote-worker-installable-runtime-design.md`
- `docs/remote-worker-outbox-runtime-design.md`
- `docs/remote-worker-liveness-and-offline-behavior.md`
- `docs/remote-worker-implementation-design.md`

## Design Goals

- Keep remote worker ingress separate from dashboard/admin APIs.
- Authenticate workers with scoped worker credentials, not admin tokens.
- Accept durable event batches with idempotent ACK semantics.
- Keep host writes short, bounded, and projection-oriented.
- Allow workers to run behind NAT with outbound-only connectivity.
- Support health and liveness without scanning raw event tables on every UI poll.
- Preserve current worker semantic events while adding a remote envelope.

## Route Summary

```text
POST /api/v2/remote-workers/enroll
POST /api/v2/remote-workers/sessions
POST /api/v2/remote-workers/sessions/:sessionId/heartbeat
POST /api/v2/remote-workers/sessions/:sessionId/events
POST /api/v2/remote-workers/sessions/:sessionId/artifacts
POST /api/v2/remote-workers/sessions/:sessionId/claims
POST /api/v2/remote-workers/sessions/:sessionId/leases/:leaseId/renew
POST /api/v2/remote-workers/sessions/:sessionId/leases/:leaseId/complete
GET  /api/v2/remote-workers/sessions/:sessionId/commands
POST /api/v2/remote-workers/sessions/:sessionId/commands/:commandId/ack
POST /api/v2/remote-workers/sessions/:sessionId/token-rotation
```

Routes are grouped by session. Workers should register/resume a session before
claiming work or uploading events.

## Authentication

Dashboard tokens must not authorize these routes.

Minimum MVP:

```http
Authorization: Bearer <worker_token>
```

Target signed request:

```http
Authorization: Bearer <worker_token>
X-Worker-Id: backlog-indexer-host103-01
X-Worker-Token-Id: wrk_tok_01J...
X-Worker-Timestamp: 2026-06-26T12:00:00.000Z
X-Worker-Nonce: 01J...
X-Worker-Signature: base64url(hmac_sha256(token_secret, canonical_request))
```

Canonical request:

```text
METHOD
PATH_WITH_QUERY
X-Worker-Id
X-Worker-Timestamp
X-Worker-Nonce
SHA256(body)
```

Validation:

- token exists, active, and not expired;
- token scope permits the route;
- token worker id matches `X-Worker-Id`;
- body `workerId` matches token worker id when present;
- path `sessionId` belongs to token worker id;
- timestamp is inside the allowed skew window;
- nonce has not been used for the token;
- signature matches when signed mode is enabled.

Standard auth error:

```json
{
  "error": {
    "code": "invalid_worker_token",
    "message": "Missing or invalid worker token"
  }
}
```

## Common Response Shape

Successful responses include server time and host checkpoint when relevant:

```json
{
  "status": "ok",
  "serverTime": "2026-06-26T12:00:00.000Z",
  "hostCheckpoint": {
    "lastAcceptedSequence": 42,
    "lastAcceptedEventId": "event-42",
    "missingSequences": []
  }
}
```

Error responses:

```json
{
  "error": {
    "code": "invalid_event_batch",
    "message": "Event sequence must be monotonic",
    "details": {}
  }
}
```

## Exchange Envelope Types

The v2 API accepts and returns typed envelopes only. Route handlers should
dispatch by route and `exchangeType`, then validate the corresponding schema.

Allowed exchange families:

```text
enrollment
session
heartbeat
task
claim
command
lease
remote_event
event_batch
event_ack
artifact_manifest
artifact_ack
token_rotation
error
```

The host must reject payloads that attempt to direct worker-local persistence or
execution, such as:

```text
sql
javascript
shell
filesystem_write
raw_reducer
```

Worker-local DB writes are code-directed inside the worker runtime. Host data
can select a registered task type and provide task payload, but it cannot
provide executable persistence instructions.

## Enrollment

```http
POST /api/v2/remote-workers/enroll
```

Purpose: exchange a short-lived enrollment token for a scoped worker token.

Request:

```json
{
  "workerId": "backlog-indexer-host103-01",
  "workerType": "backlog_indexer",
  "strategy": "resolved_metadata",
  "workerVersion": "2026.06.26",
  "sourceId": "remote:ubuntu103:backlog-indexer",
  "host": {
    "hostname": "ubuntu-dev-103",
    "os": "linux",
    "runtime": "node"
  }
}
```

Response:

```json
{
  "status": "enrolled",
  "workerToken": "wrk_secret_...",
  "tokenId": "wrk_tok_01J...",
  "scopes": [
    "remote_worker:session",
    "remote_worker:heartbeat",
    "remote_worker:events",
    "remote_worker:claims"
  ]
}
```

MVP can manually provision worker tokens and skip this route, but tests should
reserve the route shape.

## Register Or Resume Session

```http
POST /api/v2/remote-workers/sessions
```

Request:

```json
{
  "sessionId": "",
  "workerId": "backlog-indexer-host103-01",
  "workerType": "backlog_indexer",
  "strategy": "resolved_metadata",
  "workerVersion": "2026.06.26",
  "sourceId": "remote:ubuntu103:backlog-indexer",
  "profileId": "",
  "capabilities": {
    "apiVersion": "v2",
    "eventRegistryVersion": "marketplace-worker-events@1",
    "localOutbox": true,
    "artifactUpload": false,
    "signedRequests": true,
    "maxEventBatchSize": 100
  },
  "lastCheckpoint": {
    "lastAckedSequence": 0,
    "lastAckedEventId": ""
  }
}
```

Response:

```json
{
  "sessionId": "remote-session-01J...",
  "status": "registered",
  "serverTime": "2026-06-26T12:00:00.000Z",
  "heartbeatSeconds": 15,
  "sessionLeaseSeconds": 90,
  "maxEventBatchSize": 100,
  "maxEventBatchBytes": 524288,
  "maxArtifactBytes": 5242880,
  "hostCheckpoint": {
    "lastAcceptedSequence": 0,
    "missingSequences": []
  },
  "config": {
    "workerType": "backlog_indexer",
    "strategy": "resolved_metadata",
    "adapter": {
      "limit": 100
    }
  }
}
```

Host behavior:

- create or resume `remote_worker_sessions`;
- reject incompatible worker type, strategy, token scope, or API version;
- return host checkpoint so the worker can retry missing outbox events;
- do not spawn a local child process.

## Heartbeat

```http
POST /api/v2/remote-workers/sessions/:sessionId/heartbeat
```

Request:

```json
{
  "workerId": "backlog-indexer-host103-01",
  "runtimeState": "working",
  "hostState": "connected",
  "activeLeaseId": "lease-01J...",
  "activeEntityId": "batch-01J...",
  "lastLocalSequence": 42,
  "lastAckedSequence": 40,
  "pendingEventCount": 2,
  "pendingArtifactCount": 0,
  "pendingArtifactBytes": 0,
  "eventFlushLagMs": 2100,
  "metrics": {
    "rssMb": 180,
    "diskFreeMb": 42000
  },
  "lastError": ""
}
```

Response:

```json
{
  "status": "ok",
  "serverTime": "2026-06-26T12:00:15.000Z",
  "sessionLeaseExpiresAt": "2026-06-26T12:01:45.000Z",
  "shutdownRequested": false,
  "drainRequested": false,
  "commandsAvailable": true,
  "hostCheckpoint": {
    "lastAcceptedSequence": 40
  }
}
```

Host behavior:

- update session liveness and summary metrics only;
- avoid raw event scans;
- do not mark work completed from heartbeat;
- compute `online`, `degraded`, `offline`, and `lost` from session/work leases.

## Event Batch Ingestion

```http
POST /api/v2/remote-workers/sessions/:sessionId/events
```

Request:

```json
{
  "workerId": "backlog-indexer-host103-01",
  "batchId": "batch-01J...",
  "firstSequence": 41,
  "lastSequence": 60,
  "events": [
    {
      "eventId": "backlog-indexer-host103-01:41:worker_started:abcd1234",
      "sequence": 41,
      "eventAt": "2026-06-26T12:00:01.000Z",
      "eventScope": "workflow",
      "eventType": "worker_started",
      "status": "running",
      "entityType": "worker",
      "entityId": "backlog-indexer-host103-01",
      "leaseId": "",
      "claimId": "",
      "commandId": "",
      "payload": {}
    }
  ]
}
```

Response:

```json
{
  "status": "accepted",
  "accepted": [
    {
      "eventId": "backlog-indexer-host103-01:41:worker_started:abcd1234",
      "sequence": 41,
      "status": "acked"
    }
  ],
  "duplicates": [],
  "rejected": [],
  "hostCheckpoint": {
    "lastAcceptedSequence": 60,
    "missingSequences": []
  }
}
```

Host validation:

- session is active or resumable;
- worker id matches token and session;
- sequence is positive and monotonic per worker session;
- event id is unique or duplicate-identical;
- registry validation passes for worker type, strategy, and event type;
- remote envelope validation passes for lease/claim/command requirements;
- payload is JSON and size-limited.

Host write model:

1. Validate batch outside the DB transaction where possible.
2. Open a short transaction.
3. Insert idempotent rows into `remote_worker_event_ingest`.
4. Project compatible workflow/listing events or enqueue reducer work.
5. Update session checkpoint.
6. Commit and return ACK.

This keeps the main app read-responsive because worker writes are bounded and
host-controlled.

## Artifact Upload

```http
POST /api/v2/remote-workers/sessions/:sessionId/artifacts
```

Initial MVP should accept metadata-only artifact manifests first. Full binary
upload should be multipart or chunked and should be enabled only after
manifest consistency is stable.

Artifact ACK should be idempotent by `artifactId + sha256`.

### Artifact Consistency And Transfer Control

Binary artifacts must not be embedded inside event payloads. Events reference
artifact manifests by id and hash.

Manifest shape:

```json
{
  "exchangeType": "artifact_manifest",
  "schemaVersion": "remote-worker-artifact@1",
  "artifactId": "artifact-01J...",
  "workerId": "resolver-host103-01",
  "sessionId": "remote-session-01J...",
  "eventId": "event-01J...",
  "artifactType": "image",
  "mediaRole": "listing_photo",
  "contentType": "image/jpeg",
  "sha256": "hex",
  "sizeBytes": 184220,
  "width": 1280,
  "height": 960,
  "sourceUrl": "https://...",
  "localPath": "artifacts/...",
  "derivatives": [
    {
      "artifactId": "artifact-01J-thumb",
      "mediaRole": "thumbnail",
      "contentType": "image/jpeg",
      "sha256": "hex",
      "sizeBytes": 18220,
      "width": 320,
      "height": 240
    }
  ],
  "metadata": {
    "listingId": "973408764691929",
    "position": 0
  }
}
```

Consistency rules:

- `artifactId` is stable for the worker event and media role.
- `sha256 + sizeBytes` identify binary content.
- duplicate `artifactId` with identical hash is ACK-equivalent.
- duplicate `artifactId` with a different hash is a conflict and must be
  rejected or versioned.
- host projection may store manifest metadata before binary upload completes.
- projections that need displayable media wait for `artifact_ack`.
- worker can delete local files only after both the referencing event and the
  artifact upload are ACKed.

Transfer-control rules:

- upload manifests with event batches, not binary blobs.
- upload binary artifacts on a separate artifact lane with its own byte budget.
- prefer thumbnails/preview derivatives before original images.
- never upload full browser traces by default.
- enforce per-artifact and per-session byte limits.
- apply backpressure when `pendingArtifactBytes` exceeds threshold.
- allow host config to request one of:
  - `metadata_only`
  - `thumbnail`
  - `preview`
  - `original_on_demand`
  - `original_required`

Recommended defaults:

```text
manifest upload: inline with event or artifact metadata route
thumbnail max edge: 320px
preview max edge: 1280px
jpeg quality: 60-75
max artifact bytes: 5 MiB
max pending artifact bytes per worker: 1 GiB
original upload: on demand unless task requires it
```

This keeps event consistency strong while preventing multimedia transfer from
blocking the main event ACK path.

### CDN/Object Storage Boundary

The central web app should serve compute, metadata, reducers, access policy, and
small previews. It should not be the long-term bandwidth path for large
artifacts.

Host responsibilities:

- store canonical artifact metadata;
- validate worker/session/event ownership;
- decide artifact retention and access policy;
- issue upload/download grants;
- project artifact availability into listing/detail UI;
- audit artifact access decisions.

Object storage/CDN responsibilities:

- store binary blobs;
- serve thumbnails, previews, originals, traces, and video files;
- enforce short-lived signed URLs or signed cookies;
- provide cache headers and range requests;
- optionally perform lifecycle expiration for old originals.

Recommended model:

```text
worker -> host: ArtifactManifest
host -> worker: upload grant
worker -> object store: binary upload
worker -> host: upload completion
host -> UI: artifact metadata + signed read URL when authorized
UI -> CDN/object store: binary download
```

The host should keep a storage backend abstraction:

```text
local_fs
s3_compatible
cloudflare_r2
backblaze_b2
minio
```

Upload grant response:

```json
{
  "artifactId": "artifact-01J...",
  "uploadMode": "presigned_put",
  "uploadUrl": "https://object-store.example/...",
  "expiresAt": "2026-06-27T12:05:00.000Z",
  "requiredHeaders": {
    "content-type": "image/jpeg",
    "x-amz-checksum-sha256": "base64..."
  },
  "maxBytes": 5242880
}
```

Read grant response:

```json
{
  "artifactId": "artifact-01J...",
  "readUrl": "https://cdn.example/...",
  "expiresAt": "2026-06-27T12:10:00.000Z",
  "cachePolicy": "private-short"
}
```

Auth rules:

- workers authenticate to the host, not directly to storage credentials;
- host grants upload rights only for artifact manifests it accepted;
- upload grants are scoped to artifact id, hash, content type, and byte limit;
- UI read grants require dashboard token authorization;
- read URLs should be short-lived for private artifacts;
- public CDN caching is allowed only for explicitly non-sensitive artifacts;
- original/full-fidelity artifacts should default to private, on-demand access.

This preserves server authority over data and access while moving large binary
transfer and caching to infrastructure designed for it.

### Artifact Storage Migration Plan

The migration should be additive. Local filesystem hosting remains the default
until the manifest and backend abstraction are stable.

#### Phase 0: Current Local Files

Current behavior:

```text
artifact file on app host
  -> /files/... route
  -> browser downloads from central app server
```

Keep this working. Do not require CDN/object storage for the first remote-worker
slice.

#### Phase 1: Local Files With Manifest Metadata

Add `ArtifactManifest` records while still storing binaries locally.

Storage metadata:

```json
{
  "backend": "local_fs",
  "objectKey": "artifacts/marketplace-homepage/worker-screenshots/...",
  "publicUrl": "",
  "signedReadUrl": "",
  "cdnProvider": "",
  "uploadMode": "host_local",
  "expiresAt": ""
}
```

Acceptance criteria:

- existing `/files/...` URLs still work;
- artifact metadata is queryable by listing/event/session;
- thumbnails/previews can be distinguished from originals;
- event ACK and artifact ACK are tracked separately;
- no binary data is embedded in event payloads.

#### Phase 2: Storage Backend Interface

Introduce a host-side storage interface:

```text
putArtifact(manifest, stream)
getReadGrant(artifactId, viewer)
getUploadGrant(manifest, worker)
markUploadComplete(artifactId, checksum)
deleteArtifact(artifactId)
```

Initial implementation:

```text
local_fs
```

The UI and reducers should read through artifact metadata and read grants, not
hardcoded filesystem paths. `local_fs` read grants can still return `/files/...`.

#### Phase 3: Metadata-Only Remote Manifests

Remote workers upload artifact manifests first, but binaries may remain local to
the worker until requested.

Use for:

- low-value screenshots;
- large traces;
- original photos when thumbnail/preview is enough;
- offline periods.

The host can show:

```text
available: metadata only
thumbnail: pending
preview: pending
original: on demand
```

#### Phase 4: Presigned Uploads To Object Storage

Add one object storage backend behind the same interface, preferably
S3-compatible so MinIO/R2/B2 remain possible.

Storage metadata example:

```json
{
  "backend": "s3_compatible",
  "objectKey": "remote-workers/session-01J/artifacts/artifact-01J.jpeg",
  "publicUrl": "",
  "signedReadUrl": "",
  "cdnProvider": "",
  "uploadMode": "presigned_put",
  "expiresAt": "2026-06-27T12:05:00.000Z"
}
```

Acceptance criteria:

- worker never receives broad object-store credentials;
- upload grant is scoped to artifact id, content type, hash, and byte limit;
- host verifies upload completion by checksum/size;
- local filesystem backend can still be used in development.

#### Phase 5: CDN Read Grants

Add CDN read URL generation for private artifacts.

Storage metadata example:

```json
{
  "backend": "s3_compatible",
  "objectKey": "remote-workers/session-01J/artifacts/artifact-01J-preview.jpeg",
  "cdnProvider": "cloudflare_r2",
  "uploadMode": "presigned_put",
  "expiresAt": "",
  "readGrantMode": "signed_url"
}
```

Acceptance criteria:

- dashboard API returns artifact metadata and short-lived read URLs;
- private artifacts do not become public CDN assets by default;
- thumbnails/previews may use shorter cache TTLs;
- originals remain `original_on_demand` unless explicitly required.

#### Phase 6: Lifecycle And Backfill

Once CDN/object storage is proven:

- optionally backfill old local artifacts to object storage;
- preserve old local paths until migrated artifacts are verified;
- keep manifest ids stable;
- update storage metadata from `local_fs` to object backend;
- retain a rollback path to local `/files/...`;
- add lifecycle policy for old originals and traces.

Backfill should be incremental:

```text
select local_fs artifacts by age/size/type
copy one bounded batch
verify sha256 and size
update storage metadata
mark migrated_at
leave local file until retention window expires
```

#### Rollback Rule

The canonical artifact identity is the manifest, not the storage backend.
Rollback means changing storage metadata/read-grant behavior, not rewriting
events.

## Claim Work

```http
POST /api/v2/remote-workers/sessions/:sessionId/claims
```

Request:

```json
{
  "workerId": "backlog-indexer-host103-01",
  "workerType": "backlog_indexer",
  "strategy": "resolved_metadata",
  "capacity": 1,
  "acceptedCommandTypes": ["index_resolved_listing_metadata_batch"]
}
```

Response:

```json
{
  "claims": [
    {
      "leaseId": "lease-01J...",
      "claimId": "claim-01J...",
      "commandId": "command-01J...",
      "commandType": "index_resolved_listing_metadata_batch",
      "entityType": "listing_batch",
      "entityId": "batch-01J...",
      "expiresAt": "2026-06-26T12:03:00.000Z",
      "payload": {
        "indexerVersion": "resolved-metadata-v1",
        "items": []
      }
    }
  ],
  "drainRequested": false
}
```

Host behavior:

- issue claims only to online compatible sessions;
- lease every claim;
- do not assign work when worker heartbeat indicates backpressure;
- stale leases can be recovered and reassigned after expiry.

## Command Polling

The host should not require inbound access to the worker. Operator commands are
delivered through worker polling:

```http
GET /api/v2/remote-workers/sessions/:sessionId/commands
```

Command examples:

- `shutdown`
- `drain`
- `rotate_token`
- `submit_verification_code`
- `continue_after_external_approval`

## Host Tables

Minimum host tables:

```text
remote_worker_tokens
remote_worker_sessions
remote_worker_session_heartbeats
remote_worker_event_ingest
remote_worker_event_acks
remote_worker_claims
remote_worker_commands
remote_worker_artifacts
remote_worker_nonce_log
```

The dashboard should read current worker status from session/projection tables,
not from expensive raw event scans.

## Unit And Integration Test Targets

Unit tests:

- worker auth canonical request and HMAC verification;
- nonce replay rejection;
- worker id and scope validation;
- self-paced scheduler decisions;
- event batch selection by sequence, count, and byte budget.

Integration tests:

- bad worker token returns `invalid_worker_token`;
- session register returns session lease and checkpoint;
- heartbeat updates liveness without reducing domain work;
- event batch ingestion ACKs accepted events;
- duplicate identical event is ACK-equivalent;
- invalid event payload is rejected without partial projection;
- projected compatibility events appear in existing workflow/listing audit
  tables;
- dashboard/admin token cannot call remote-worker routes.

## MVP Implementation Order

1. Add unit tests for auth, scheduler, and batch planning.
2. Add integration tests for `/api/v2/remote-workers`.
3. Add host schema migrations.
4. Implement Bearer-token auth, then signed auth.
5. Implement session register and heartbeat.
6. Implement event ingestion and ACKs.
7. Implement first non-browser backlog indexer worker.
8. Add UI worker health projection.
