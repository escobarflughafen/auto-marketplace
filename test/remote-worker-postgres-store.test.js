const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createRemoteWorkerPostgresStore,
  remoteBacklogIndexerPayloadItem,
} = require('../scripts/remote-worker-postgres-store');

function createFakePool(handler) {
  const calls = [];
  const client = {
    released: false,
    async query(sql, params = []) {
      calls.push({ sql, params, client: true });
      return { rows: handler(sql, params, calls.length) || [] };
    },
    release() {
      this.released = true;
    },
  };
  return {
    calls,
    client,
    ended: false,
    async connect() {
      calls.push({ sql: 'CONNECT', params: [], connect: true });
      return client;
    },
    async query(sql, params = []) {
      calls.push({ sql, params, pool: true });
      return { rows: handler(sql, params, calls.length) || [] };
    },
    async end() {
      this.ended = true;
    },
  };
}

const sessionRow = {
  session_id: 'session-1',
  worker_id: 'worker-1',
  worker_type: 'backlog_indexer',
  strategy: 'resolved_metadata',
};

const listingRow = {
  listing_id: 'listing-1',
  href: 'https://example.test/listing-1',
  source: 'search',
  source_keyword: 'camera',
  card_title: 'Card title',
  card_text: 'Card text',
  detail_title: 'Detail title',
  detail_price: 'CA$ 100',
  detail_location: 'Vancouver',
  detail_condition: 'used',
  detail_listed_ago: '1 hour ago',
  detail_completed_at: '2026-01-01T00:00:00.000Z',
  detail_json: JSON.stringify({ listingContent: { description: 'indexed description' } }),
  snapshot_path: '/tmp/listing-1.md',
  first_seen_at: '2026-01-01T00:00:00.000Z',
  last_seen_at: '2026-01-02T00:00:00.000Z',
};


test('registerRemoteWorkerSession writes PostgreSQL session and workflow run in one transaction', async () => {
  const pool = createFakePool(() => []);
  const store = createRemoteWorkerPostgresStore({
    pool,
    nowIso: () => '2026-01-03T00:00:00.000Z',
    idFactory: {
      sessionId: () => 'session-created',
    },
  });

  const result = await store.registerRemoteWorkerSession({
    workerId: 'worker-1',
    workerType: 'collector',
    strategy: 'feed',
    workerVersion: 'v1',
    sourceId: 'host-a',
    capabilities: { commands: true },
    lastCheckpoint: { lastLocalSequence: 7, lastAckedSequence: 5 },
  });

  assert.equal(result.sessionId, 'session-created');
  assert.equal(result.hostCheckpoint.lastAcceptedSequence, 5);
  assert.ok(pool.calls.some((call) => call.sql === 'BEGIN'));
  assert.ok(pool.calls.some((call) => call.sql === 'COMMIT'));
  const sessionInsert = pool.calls.find((call) => /INSERT INTO remote_worker_sessions/.test(call.sql));
  assert.ok(sessionInsert);
  assert.deepEqual(sessionInsert.params.slice(0, 7), [
    'session-created',
    'worker-1',
    'collector',
    'feed',
    'v1',
    'host-a',
    '{"commands":true}',
  ]);
  assert.deepEqual(sessionInsert.params.slice(7), [7, 5, '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z']);
  const workflowInsert = pool.calls.find((call) => /INSERT INTO workflow_runs/.test(call.sql));
  assert.ok(workflowInsert);
  assert.deepEqual(workflowInsert.params, [
    'session-created',
    'remote-collector',
    'Remote collector',
    '2026-01-03T00:00:00.000Z',
    '2026-01-03T00:00:00.000Z',
  ]);
});

test('updateRemoteWorkerHeartbeat updates session liveness and workflow projection', async () => {
  const pool = createFakePool((sql) => {
    if (/FROM remote_worker_sessions/.test(sql)) {
      return [{ ...sessionRow, last_acked_sequence: 9 }];
    }
    return [];
  });
  const store = createRemoteWorkerPostgresStore({
    pool,
    nowIso: () => '2026-01-03T00:00:00.000Z',
  });

  const result = await store.updateRemoteWorkerHeartbeat('session-1', {
    workerId: 'worker-1',
    runtimeState: 'idle',
    lastLocalSequence: 12,
    pendingEventCount: 3,
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.hostCheckpoint.lastAcceptedSequence, 9);
  const sessionUpdate = pool.calls.find((call) => /UPDATE remote_worker_sessions/.test(call.sql) && /runtime_state/.test(call.sql));
  assert.ok(sessionUpdate);
  assert.deepEqual(sessionUpdate.params, ['idle', 12, 3, '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z', 'session-1']);
  const workflowUpdate = pool.calls.find((call) => /UPDATE workflow_runs/.test(call.sql));
  assert.ok(workflowUpdate);
  assert.deepEqual(workflowUpdate.params, ['2026-01-03T00:00:00.000Z', 'session-1']);
});

test('create, list, and ack remote worker commands through PostgreSQL', async () => {
  const commandRow = {
    command_id: 'command-1',
    session_id: 'session-1',
    worker_id: 'worker-1',
    worker_type: 'backlog_indexer',
    strategy: 'resolved_metadata',
    command_type: 'drain',
    payload_json: '{"reason":"test"}',
    priority: 10,
    created_at: '2026-01-02T00:00:00.000Z',
    delivered_at: '',
  };
  const pool = createFakePool((sql) => {
    if (/FROM remote_worker_sessions/.test(sql)) return [sessionRow];
    if (/FROM remote_worker_commands/.test(sql)) return [commandRow];
    return [];
  });
  const store = createRemoteWorkerPostgresStore({
    pool,
    nowIso: () => '2026-01-03T00:00:00.000Z',
    idFactory: { commandId: () => 'command-created' },
  });

  const commandId = await store.createRemoteWorkerCommand({
    sessionId: 'session-1',
    workerId: 'worker-1',
    workerType: 'backlog_indexer',
    strategy: 'resolved_metadata',
    commandType: 'drain',
    payload: { reason: 'test' },
    priority: 10,
  });
  assert.equal(commandId, 'command-created');
  const insert = pool.calls.find((call) => /INSERT INTO remote_worker_commands/.test(call.sql));
  assert.ok(insert);
  assert.deepEqual(insert.params, [
    'command-created',
    'session-1',
    'worker-1',
    'backlog_indexer',
    'resolved_metadata',
    'drain',
    'drain',
    '{"reason":"test"}',
    10,
    '2026-01-03T00:00:00.000Z',
  ]);

  const listed = await store.listRemoteWorkerCommands('session-1', { limit: 5 });
  assert.equal(listed.commands.length, 1);
  assert.deepEqual(listed.commands[0], {
    commandId: 'command-1',
    commandType: 'drain',
    payload: { reason: 'test' },
    priority: 10,
    createdAt: '2026-01-02T00:00:00.000Z',
    deliveredAt: '2026-01-03T00:00:00.000Z',
  });
  assert.ok(pool.calls.some((call) => /SET delivered_at = CASE/.test(call.sql)));

  const acked = await store.ackRemoteWorkerCommand('session-1', 'command-1', {
    status: 'failed',
    payload: { retry: false },
    error: 'nope',
  });
  assert.equal(acked.status, 'failed');
  assert.equal(acked.ackStatus, 'failed');
  const update = pool.calls.find((call) => /ack_payload_json/.test(call.sql));
  assert.ok(update);
  assert.deepEqual(update.params, ['failed', 'failed', '{"retry":false}', '2026-01-03T00:00:00.000Z', 'nope', 'command-1']);
});

test('remoteBacklogIndexerPayloadItem normalizes listing rows for claim payloads', () => {
  const item = remoteBacklogIndexerPayloadItem(listingRow);
  assert.equal(item.listingId, 'listing-1');
  assert.equal(item.title, 'Detail title');
  assert.equal(item.description, 'indexed description');
  assert.equal(item.sourceKeyword, 'camera');
  assert.match(item.contentHash, /^[a-f0-9]{64}$/);
});

test('listRemoteBacklogIndexerCandidates uses PostgreSQL JSON active-claim exclusion', async () => {
  const pool = createFakePool((sql) => {
    if (/FROM homepage_listings h/.test(sql)) return [listingRow];
    return [];
  });
  const store = createRemoteWorkerPostgresStore({
    pool,
    nowIso: () => '2026-01-03T00:00:00.000Z',
  });

  const rows = await store.listRemoteBacklogIndexerCandidates({
    limit: 10,
    excludeListingIds: ['listing-x'],
  });

  assert.equal(rows.length, 1);
  const call = pool.calls.find((item) => /FROM homepage_listings h/.test(item.sql));
  assert.ok(call);
  assert.match(call.sql, /jsonb_array_elements/);
  assert.match(call.sql, /AS active_item\(item\)/);
  assert.match(call.sql, /active\.listing_id IS NULL/);
  assert.match(call.sql, /ANY\(\$3::text\[\]\)/);
  assert.doesNotMatch(call.sql, /LIKE '%' \|\|/);
  assert.deepEqual(call.params, [['claimed', 'renewed'], '2026-01-03T00:00:00.000Z', ['listing-x'], 10]);
});

test('claimRemoteWorkerWork creates PostgreSQL commands and claims in a transaction', async () => {
  const pool = createFakePool((sql) => {
    if (/FROM remote_worker_sessions/.test(sql)) return [sessionRow];
    if (/FROM homepage_listings h/.test(sql)) return [listingRow];
    return [];
  });
  const store = createRemoteWorkerPostgresStore({
    pool,
    nowIso: () => '2026-01-03T00:00:00.000Z',
    idFactory: {
      commandId: () => 'command-1',
      claimId: () => 'claim-1',
      leaseId: () => 'lease-1',
    },
  });

  const result = await store.claimRemoteWorkerWork('session-1', {
    workerId: 'worker-1',
    capacity: 1,
    batchSize: 5,
    leaseSeconds: 60,
  });

  assert.equal(result.reason, '');
  assert.equal(result.claims.length, 1);
  assert.equal(result.claims[0].claimId, 'claim-1');
  assert.equal(result.claims[0].leaseId, 'lease-1');
  assert.equal(result.claims[0].payload.items[0].listingId, 'listing-1');
  assert.ok(pool.calls.some((call) => call.sql === 'BEGIN'));
  assert.ok(pool.calls.some((call) => call.sql === 'COMMIT'));
  assert.equal(pool.client.released, true);

  const commandInsert = pool.calls.find((call) => /INSERT INTO remote_worker_commands/.test(call.sql));
  assert.ok(commandInsert);
  assert.equal(commandInsert.params[0], 'command-1');
  assert.equal(commandInsert.params[1], 'session-1');
  assert.equal(commandInsert.params[8], 0);
  const commandPayload = JSON.parse(commandInsert.params[7]);
  assert.equal(commandPayload.items[0].listingId, 'listing-1');

  const claimInsert = pool.calls.find((call) => /INSERT INTO remote_worker_claims/.test(call.sql));
  assert.ok(claimInsert);
  assert.equal(claimInsert.params[0], 'claim-1');
  assert.equal(claimInsert.params[1], 'lease-1');
  assert.equal(claimInsert.params[8], commandInsert.params[7]);
});

test('claimRemoteWorkerWork touches unsupported sessions without claiming', async () => {
  const pool = createFakePool((sql) => {
    if (/FROM remote_worker_sessions/.test(sql)) {
      return [{ ...sessionRow, worker_type: 'collector', strategy: 'feed' }];
    }
    return [];
  });
  const store = createRemoteWorkerPostgresStore({
    pool,
    nowIso: () => '2026-01-03T00:00:00.000Z',
  });

  const result = await store.claimRemoteWorkerWork('session-1', { workerId: 'worker-1' });

  assert.equal(result.reason, 'unsupported_remote_claim_worker');
  assert.deepEqual(result.claims, []);
  const update = pool.calls.find((call) => /UPDATE remote_worker_sessions/.test(call.sql));
  assert.ok(update);
  assert.deepEqual(update.params, ['2026-01-03T00:00:00.000Z', 'session-1']);
});


test('ingestRemoteWorkerEvents stores workflow events and updates checkpoint', async () => {
  const pool = createFakePool((sql) => {
    if (/FROM remote_worker_sessions/.test(sql)) return [sessionRow];
    if (/FROM remote_worker_event_ingest\s+WHERE event_id/.test(sql)) return [];
    if (/MAX\(sequence\)/.test(sql)) return [{ lastAcceptedSequence: '7' }];
    return [];
  });
  const store = createRemoteWorkerPostgresStore({ pool, nowIso: () => '2026-01-03T00:00:00.000Z' });

  const result = await store.ingestRemoteWorkerEvents('session-1', {
    workerId: 'worker-1',
    batchId: 'batch-1',
    events: [{
      eventId: 'event-1',
      sequence: 7,
      eventScope: 'workflow',
      eventType: 'worker_heartbeat',
      eventAt: '2026-01-03T00:00:01.000Z',
      status: 'ok',
      payload: { workerType: 'backlog_indexer', strategy: 'resolved_metadata', step: 'poll' },
    }],
  });

  assert.equal(result.status, 'accepted');
  assert.deepEqual(result.accepted, [{ eventId: 'event-1', sequence: 7 }]);
  assert.equal(result.checkpoint.lastAcceptedSequence, 7);
  const ingestInsert = pool.calls.find((call) => /INSERT INTO remote_worker_event_ingest/.test(call.sql));
  assert.ok(ingestInsert);
  assert.equal(ingestInsert.params[0], 'event-1');
  assert.equal(ingestInsert.params[5], 'batch-1');
  assert.equal(ingestInsert.params[7], 'workflow');
  assert.equal(ingestInsert.params[15], 'reduced');
  const workflowInsert = pool.calls.find((call) => /INSERT INTO workflow_events/.test(call.sql));
  assert.ok(workflowInsert);
  assert.deepEqual(workflowInsert.params.slice(0, 5), ['event-1', 'session-1', 'worker_heartbeat', '2026-01-03T00:00:01.000Z', 'ok']);
  const sessionUpdate = pool.calls.find((call) => /last_acked_sequence/.test(call.sql));
  assert.ok(sessionUpdate);
  assert.deepEqual(sessionUpdate.params, [7, '2026-01-03T00:00:00.000Z', 'session-1']);
});

test('ingestRemoteWorkerEvents handles duplicates without rewriting projections', async () => {
  const pool = createFakePool((sql) => {
    if (/FROM remote_worker_sessions/.test(sql)) return [sessionRow];
    if (/FROM remote_worker_event_ingest\s+WHERE event_id/.test(sql)) return [{ event_id: 'event-dup', sequence: 3 }];
    if (/MAX\(sequence\)/.test(sql)) return [{ lastAcceptedSequence: '3' }];
    return [];
  });
  const store = createRemoteWorkerPostgresStore({ pool, nowIso: () => '2026-01-03T00:00:00.000Z' });

  const result = await store.ingestRemoteWorkerEvents('session-1', {
    workerId: 'worker-1',
    events: [{
      eventId: 'event-dup',
      sequence: 3,
      eventScope: 'workflow',
      eventType: 'worker_heartbeat',
      payload: { workerType: 'backlog_indexer', strategy: 'resolved_metadata' },
    }],
  });

  assert.deepEqual(result.accepted, []);
  assert.deepEqual(result.duplicates, [{ eventId: 'event-dup', sequence: 3 }]);
  assert.equal(pool.calls.some((call) => /INSERT INTO workflow_events/.test(call.sql)), false);
});

test('ingestRemoteWorkerEvents projects collector listing observations into PostgreSQL listing tables', async () => {
  const collectorSession = {
    ...sessionRow,
    worker_type: 'collector',
    strategy: 'explorer',
  };
  const pool = createFakePool((sql) => {
    if (/FROM remote_worker_sessions/.test(sql)) return [collectorSession];
    if (/FROM remote_worker_event_ingest\s+WHERE event_id/.test(sql)) return [];
    if (/MAX\(sequence\)/.test(sql)) return [{ lastAcceptedSequence: '12' }];
    return [];
  });
  const store = createRemoteWorkerPostgresStore({ pool, nowIso: () => '2026-01-03T00:00:00.000Z' });

  const result = await store.ingestRemoteWorkerEvents('session-1', {
    workerId: 'worker-1',
    batchId: 'batch-listing-observed',
    events: [{
      eventId: 'event-observed',
      sequence: 12,
      eventScope: 'listing',
      eventType: 'listing_observed',
      eventAt: '2026-01-03T00:02:00.000Z',
      listingId: '1234567890',
      status: 'ok',
      payload: {
        listingId: '1234567890',
        href: 'https://www.facebook.com/marketplace/item/1234567890/?ref=search',
        source: 'search',
        sourceKeyword: 'camera bag',
        outcome: 'new',
        rank: 2,
        cardTitle: 'Nikon camera bag',
        cardText: 'Clean bag in Vancouver',
      },
    }],
  });

  assert.equal(result.accepted.length, 1);
  const homepageInsert = pool.calls.find((call) => /INSERT INTO homepage_listings/.test(call.sql));
  assert.ok(homepageInsert);
  assert.deepEqual(homepageInsert.params.slice(0, 6), [
    '1234567890',
    'https://www.facebook.com/marketplace/item/1234567890/',
    'search',
    'camera bag',
    'Nikon camera bag',
    'Clean bag in Vancouver',
  ]);
  assert.equal(homepageInsert.params[7], '2026-01-03T00:02:00.000Z');
  assert.equal(homepageInsert.params[8], '2026-01-03T00:02:00.000Z');
  assert.equal(homepageInsert.params[9], 2);
  assert.match(homepageInsert.sql, /ON CONFLICT\(listing_id\) DO UPDATE/);

  const searchKeywordInsert = pool.calls.find((call) => /INSERT INTO listing_search_keywords/.test(call.sql));
  assert.ok(searchKeywordInsert);
  assert.deepEqual(searchKeywordInsert.params, [
    '1234567890',
    'camera bag',
    'camera bag',
    '2026-01-03T00:02:00.000Z',
    '2026-01-03T00:02:00.000Z',
  ]);

  const titleBagInserts = pool.calls.filter((call) => /INSERT INTO search_title_bag/.test(call.sql));
  assert.equal(titleBagInserts.length, 2);
  assert.deepEqual(titleBagInserts.map((call) => call.params.slice(0, 2)), [
    ['nikon camera bag', 'Nikon camera bag'],
    ['camera bag', 'camera bag'],
  ]);
  assert.equal(titleBagInserts[0].params[4], 'camera bag');

  const listingEventInsert = pool.calls.find((call) => /INSERT INTO listing_events/.test(call.sql));
  assert.ok(listingEventInsert);
  assert.deepEqual(listingEventInsert.params.slice(0, 6), [
    'event-observed',
    'session-1',
    '1234567890',
    'listing_observed',
    '2026-01-03T00:02:00.000Z',
    'worker-1',
  ]);
  assert.ok(pool.calls.findIndex((call) => /INSERT INTO homepage_listings/.test(call.sql))
    < pool.calls.findIndex((call) => /INSERT INTO listing_events/.test(call.sql)));
});

test('ingestRemoteWorkerEvents projects listing metadata updates for backlog indexer', async () => {
  const pool = createFakePool((sql) => {
    if (/FROM remote_worker_sessions/.test(sql)) return [sessionRow];
    if (/FROM remote_worker_event_ingest\s+WHERE event_id/.test(sql)) return [];
    if (/MAX\(sequence\)/.test(sql)) return [{ lastAcceptedSequence: '11' }];
    return [];
  });
  const store = createRemoteWorkerPostgresStore({ pool, nowIso: () => '2026-01-03T00:00:00.000Z' });

  const result = await store.ingestRemoteWorkerEvents('session-1', {
    workerId: 'worker-1',
    events: [{
      eventId: 'event-listing',
      sequence: 11,
      eventScope: 'listing',
      eventType: 'backlog_listing_metadata_indexed',
      eventAt: '2026-01-03T00:01:00.000Z',
      listingId: 'listing-1',
      status: 'ok',
      payload: {
        detailListedAgo: '2 hours ago',
        listedAtEarliestUnix: 1760000000,
        listedAtLatestUnix: 1760003600,
        listedAtAnchorUnix: 1760007200,
        language: 'en',
        unit: 'hour',
        value: 2,
        confidence: 'high',
        indexerVersion: 'resolved-metadata-v1',
      },
    }],
  });

  assert.equal(result.accepted.length, 1);
  const listingInsert = pool.calls.find((call) => /INSERT INTO listing_events/.test(call.sql));
  assert.ok(listingInsert);
  assert.deepEqual(listingInsert.params.slice(0, 6), ['event-listing', 'session-1', 'listing-1', 'backlog_listing_metadata_indexed', '2026-01-03T00:01:00.000Z', 'worker-1']);
  const metadataUpdate = pool.calls.find((call) => /UPDATE homepage_listings/.test(call.sql));
  assert.ok(metadataUpdate);
  assert.deepEqual(metadataUpdate.params, [
    '2 hours ago',
    1760000000,
    1760003600,
    1760007200,
    'en',
    'hour',
    2,
    'high',
    'remote:worker-1:resolved-metadata-v1',
    '2026-01-03T00:01:00.000Z',
    'listing-1',
  ]);
});

test('listRemoteWorkerIngestEvents maps PostgreSQL rows to API envelopes', async () => {
  const pool = createFakePool((sql) => {
    if (/FROM remote_worker_event_ingest/.test(sql)) return [{
      event_id: 'event-1',
      session_id: 'session-1',
      worker_id: 'worker-1',
      worker_type: 'backlog_indexer',
      strategy: 'resolved_metadata',
      sequence: '2',
      event_scope: 'workflow',
      event_type: 'worker_heartbeat',
      event_at: '2026-01-03T00:00:00.000Z',
      listing_id: '',
      status: 'ok',
      payload_json: '{"step":"poll"}',
      reduce_status: 'reduced',
      reduce_error: '',
    }];
    return [];
  });
  const store = createRemoteWorkerPostgresStore({ pool });
  const rows = await store.listRemoteWorkerIngestEvents('session-1');

  assert.deepEqual(rows, [{
    eventId: 'event-1',
    sessionId: 'session-1',
    workerId: 'worker-1',
    workerType: 'backlog_indexer',
    strategy: 'resolved_metadata',
    sequence: 2,
    eventScope: 'workflow',
    eventType: 'worker_heartbeat',
    eventAt: '2026-01-03T00:00:00.000Z',
    listingId: '',
    status: 'ok',
    payload: { step: 'poll' },
    reduceStatus: 'reduced',
    reduceError: '',
  }]);
});

test('ingestRemoteWorkerArtifacts accepts manifests and handles duplicates', async () => {
  const digest = 'a'.repeat(64);
  const pool = createFakePool((sql) => {
    if (/FROM remote_worker_sessions/.test(sql)) return [sessionRow];
    if (/FROM remote_worker_artifacts/.test(sql)) return [];
    return [];
  });
  const store = createRemoteWorkerPostgresStore({ pool, nowIso: () => '2026-01-03T00:00:00.000Z' });

  const result = await store.ingestRemoteWorkerArtifacts('session-1', {
    workerId: 'worker-1',
    artifactId: 'artifact-1',
    artifactType: 'image',
    mediaRole: 'screenshot',
    contentType: 'image/jpeg',
    sha256: digest,
    sizeBytes: 123,
    width: 800,
    height: 600,
    localPath: '/tmp/a.jpg',
    sourceUrl: 'https://example.test/a.jpg',
    metadata: { page: 1 },
  });

  assert.equal(result.status, 'accepted');
  assert.deepEqual(result.accepted, [{ artifactId: 'artifact-1', sha256: digest, uploadStatus: 'manifest_accepted' }]);
  const insert = pool.calls.find((call) => /INSERT INTO remote_worker_artifacts/.test(call.sql));
  assert.ok(insert);
  assert.equal(insert.params[0], 'artifact-1');
  assert.equal(insert.params[8], digest);
  assert.equal(insert.params[9], 123);
  assert.equal(insert.params[16], '{"page":1}');
  assert.ok(pool.calls.some((call) => /UPDATE remote_worker_sessions/.test(call.sql)));

  const duplicatePool = createFakePool((sql) => {
    if (/FROM remote_worker_sessions/.test(sql)) return [sessionRow];
    if (/FROM remote_worker_artifacts/.test(sql)) return [{ artifact_id: 'artifact-1', sha256: digest, size_bytes: 123 }];
    return [];
  });
  const duplicateStore = createRemoteWorkerPostgresStore({ pool: duplicatePool, nowIso: () => '2026-01-03T00:00:00.000Z' });
  const duplicate = await duplicateStore.ingestRemoteWorkerArtifacts('session-1', {
    workerId: 'worker-1',
    artifactId: 'artifact-1',
    artifactType: 'image',
    mediaRole: 'screenshot',
    contentType: 'image/jpeg',
    sha256: digest,
    sizeBytes: 123,
  });
  assert.deepEqual(duplicate.duplicates, [{ artifactId: 'artifact-1', sha256: digest }]);
  assert.equal(duplicatePool.calls.some((call) => /INSERT INTO remote_worker_artifacts/.test(call.sql)), false);
});

test('renewRemoteWorkerLease and completeRemoteWorkerLease update PostgreSQL lease state', async () => {
  const leaseRow = {
    claim_id: 'claim-1',
    lease_id: 'lease-1',
    session_id: 'session-1',
    command_id: 'command-1',
    status: 'claimed',
    expires_at: '2999-01-01T00:00:00.000Z',
  };
  const pool = createFakePool((sql) => {
    if (/FROM remote_worker_sessions/.test(sql)) return [sessionRow];
    if (/FROM remote_worker_claims/.test(sql)) return [leaseRow];
    return [];
  });
  const store = createRemoteWorkerPostgresStore({
    pool,
    nowIso: () => '2026-01-03T00:00:00.000Z',
  });

  const renewed = await store.renewRemoteWorkerLease('session-1', 'lease-1', {
    expiresAt: '2026-01-03T00:03:00.000Z',
  });
  assert.equal(renewed.status, 'renewed');
  const renewUpdate = pool.calls.find((call) => /SET status = 'renewed'/.test(call.sql));
  assert.ok(renewUpdate);
  assert.deepEqual(renewUpdate.params, ['2026-01-03T00:00:00.000Z', '2026-01-03T00:03:00.000Z', 'claim-1']);

  const completed = await store.completeRemoteWorkerLease('session-1', 'lease-1', {
    status: 'failed',
    error: 'boom',
    result: { ok: false },
  });
  assert.equal(completed.status, 'failed');
  const claimUpdate = pool.calls.find((call) => /UPDATE remote_worker_claims/.test(call.sql) && /completed_at/.test(call.sql));
  assert.ok(claimUpdate);
  assert.deepEqual(claimUpdate.params, ['failed', '2026-01-03T00:00:00.000Z', '{"ok":false}', 'boom', 'claim-1']);
  const commandUpdate = pool.calls.find((call) => /UPDATE remote_worker_commands/.test(call.sql));
  assert.ok(commandUpdate);
  assert.deepEqual(commandUpdate.params, ['failed', 'failed', '{"ok":false}', '2026-01-03T00:00:00.000Z', 'boom', 'command-1']);
});
