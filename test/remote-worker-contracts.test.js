const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyExchangeEnvelope,
  validateArtifactManifest,
  normalizeTaskEnvelope,
  validateRemoteEventEnvelope,
} = require('../scripts/remote-worker-contracts');

test('remote worker contract classifies allowed exchange envelope types', () => {
  assert.equal(classifyExchangeEnvelope({
    exchangeType: 'task',
    schemaVersion: 'remote-worker-task@1',
    taskId: 'task-1',
  }), 'TaskEnvelope');

  assert.equal(classifyExchangeEnvelope({
    exchangeType: 'remote_event',
    schemaVersion: 'remote-worker-event@1',
    eventId: 'event-1',
  }), 'RemoteEventEnvelope');

  assert.equal(classifyExchangeEnvelope({
    exchangeType: 'heartbeat',
    schemaVersion: 'remote-worker-heartbeat@1',
    sessionId: 'session-1',
  }), 'HeartbeatSnapshot');

  assert.equal(classifyExchangeEnvelope({
    exchangeType: 'artifact_manifest',
    schemaVersion: 'remote-worker-artifact@1',
    artifactId: 'artifact-1',
  }), 'ArtifactManifest');

  assert.throws(() => classifyExchangeEnvelope({
    exchangeType: 'sql',
    statement: 'DROP TABLE worker_tasks',
  }), /unsupported exchange type/i);
});

test('remote worker task envelope normalization rejects host-directed code or SQL', () => {
  const task = normalizeTaskEnvelope({
    taskId: 'task-1',
    taskSource: 'host_claim',
    taskType: 'index_resolved_listing_metadata_batch',
    workerType: 'backlog_indexer',
    strategy: 'resolved_metadata',
    dedupeKey: 'index:batch-1',
    entityType: 'listing_batch',
    entityId: 'batch-1',
    lease: {
      leaseId: 'lease-1',
      claimId: 'claim-1',
      commandId: 'command-1',
      expiresAt: '2026-06-27T12:03:00.000Z',
    },
    payload: {
      items: [],
    },
    createdAt: '2026-06-27T12:00:00.000Z',
  });

  assert.equal(task.schemaVersion, 'remote-worker-task@1');
  assert.equal(task.taskId, 'task-1');
  assert.equal(task.lease.leaseId, 'lease-1');

  assert.throws(() => normalizeTaskEnvelope({
    taskId: 'task-2',
    taskSource: 'host_claim',
    taskType: 'run_sql',
    workerType: 'backlog_indexer',
    strategy: 'resolved_metadata',
    dedupeKey: 'bad',
    payload: {
      sql: 'UPDATE worker_outbox_events SET status = "acked"',
    },
  }), /unsupported task type|disallowed payload/i);

  assert.throws(() => normalizeTaskEnvelope({
    taskId: 'task-3',
    taskSource: 'host_claim',
    taskType: 'index_resolved_listing_metadata_batch',
    workerType: 'backlog_indexer',
    strategy: 'resolved_metadata',
    dedupeKey: 'bad-code',
    payload: {
      code: 'process.exit(0)',
    },
  }), /disallowed payload/i);
});

test('remote worker event envelope requires typed event identity and remote ordering', () => {
  const event = validateRemoteEventEnvelope({
    exchangeType: 'remote_event',
    schemaVersion: 'remote-worker-event@1',
    sessionId: 'session-1',
    workerId: 'backlog-indexer-host103-01',
    workerType: 'backlog_indexer',
    strategy: 'resolved_metadata',
    eventId: 'backlog-indexer-host103-01:1:worker_started:abcd',
    sequence: 1,
    eventAt: '2026-06-27T12:00:01.000Z',
    eventScope: 'workflow',
    eventType: 'worker_started',
    status: 'running',
    payload: {},
  });

  assert.equal(event.sequence, 1);
  assert.equal(event.eventType, 'worker_started');

  assert.throws(() => validateRemoteEventEnvelope({
    exchangeType: 'remote_event',
    schemaVersion: 'remote-worker-event@1',
    sessionId: 'session-1',
    workerId: 'backlog-indexer-host103-01',
    eventId: 'missing-sequence',
    eventType: 'worker_started',
    payload: {},
  }), /sequence/i);
});

test('remote worker artifact manifest is content-addressed and budgeted separately from events', () => {
  const manifest = validateArtifactManifest({
    exchangeType: 'artifact_manifest',
    schemaVersion: 'remote-worker-artifact@1',
    artifactId: 'artifact-1',
    workerId: 'resolver-host103-01',
    sessionId: 'session-1',
    eventId: 'event-1',
    artifactType: 'image',
    mediaRole: 'listing_photo',
    contentType: 'image/jpeg',
    sha256: 'a'.repeat(64),
    sizeBytes: 184220,
    width: 1280,
    height: 960,
    derivatives: [{
      artifactId: 'artifact-1-thumb',
      mediaRole: 'thumbnail',
      contentType: 'image/jpeg',
      sha256: 'b'.repeat(64),
      sizeBytes: 18220,
      width: 320,
      height: 240,
    }],
    metadata: {
      listingId: '973408764691929',
      position: 0,
    },
    storage: {
      requestedBackend: 's3_compatible',
      uploadMode: 'grant_required',
    },
  }, {
    maxArtifactBytes: 5 * 1024 * 1024,
  });

  assert.equal(manifest.artifactId, 'artifact-1');
  assert.equal(manifest.derivatives[0].mediaRole, 'thumbnail');
  assert.equal(manifest.storage.uploadMode, 'grant_required');

  assert.throws(() => validateArtifactManifest({
    exchangeType: 'artifact_manifest',
    schemaVersion: 'remote-worker-artifact@1',
    artifactId: 'too-large',
    artifactType: 'image',
    mediaRole: 'listing_photo',
    contentType: 'image/jpeg',
    sha256: 'c'.repeat(64),
    sizeBytes: 10 * 1024 * 1024,
  }, {
    maxArtifactBytes: 5 * 1024 * 1024,
  }), /artifact.*too large/i);

  assert.throws(() => validateArtifactManifest({
    exchangeType: 'artifact_manifest',
    schemaVersion: 'remote-worker-artifact@1',
    artifactId: 'inline-binary',
    artifactType: 'image',
    mediaRole: 'listing_photo',
    contentType: 'image/jpeg',
    sha256: 'd'.repeat(64),
    sizeBytes: 100,
    bytesBase64: 'abcd',
  }), /binary.*not allowed|inline/i);

  assert.throws(() => validateArtifactManifest({
    exchangeType: 'artifact_manifest',
    schemaVersion: 'remote-worker-artifact@1',
    artifactId: 'provider-secret',
    artifactType: 'image',
    mediaRole: 'listing_photo',
    contentType: 'image/jpeg',
    sha256: 'e'.repeat(64),
    sizeBytes: 100,
    storage: {
      requestedBackend: 's3_compatible',
      accessKeyId: 'AKIA...',
      secretAccessKey: 'secret',
    },
  }), /storage credentials|secret/i);
});
