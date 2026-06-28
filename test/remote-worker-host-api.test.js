const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const {
  createServer,
} = require('../scripts/serve-marketplace-homepage');
const {
  openMarketplaceHomepageDatabase,
  closeMarketplaceHomepageDatabase,
  upsertHomepageListing,
} = require('../scripts/marketplace-homepage-db');

function createTempDbPath() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-worker-host-api-'));
  return {
    tempDir,
    dbPath: path.join(tempDir, 'marketplace.db'),
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address());
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function requestJson(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || 'GET',
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
  };
}

test('remote worker host API accepts legacy worker token env name for restarted containers', async () => {
  const { tempDir, dbPath } = createTempDbPath();
  const previousRemoteToken = process.env.MARKETPLACE_REMOTE_WORKER_TOKEN;
  const previousLegacyToken = process.env.MARKETPLACE_WORKER_TOKEN;
  delete process.env.MARKETPLACE_REMOTE_WORKER_TOKEN;
  process.env.MARKETPLACE_WORKER_TOKEN = 'legacy-worker-token';
  const seedDb = new DatabaseSync(dbPath);
  try {
    seedDb.exec(`
      CREATE TABLE remote_worker_sessions (
        session_id TEXT PRIMARY KEY,
        worker_id TEXT NOT NULL,
        worker_type TEXT NOT NULL,
        strategy TEXT NOT NULL,
        registered_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE remote_worker_event_ingest (
        event_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        batch_id TEXT NOT NULL DEFAULT '',
        event_at TEXT NOT NULL,
        event_scope TEXT NOT NULL,
        event_type TEXT NOT NULL,
        canonical_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        received_at TEXT NOT NULL
      );
      CREATE TABLE remote_worker_artifacts (
        artifact_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        sha256 TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        accepted_at TEXT NOT NULL
      );
    `);
  } finally {
    seedDb.close();
  }
  const server = createServer({
    dbPath,
    adminToken: 'admin-token',
    readOnlyToken: 'readonly-token',
    initialDelayMs: 60 * 60 * 1000,
  });
  const address = await listen(server);
  const baseUrl = `http://${address.address}:${address.port}`;

  try {
    const registered = await requestJson(baseUrl, '/api/v2/remote-workers/sessions', {
      method: 'POST',
      token: 'legacy-worker-token',
      body: {
        workerId: 'legacy-env-worker',
        workerType: 'backlog_indexer',
        strategy: 'resolved_metadata',
      },
    });
    assert.equal(registered.status, 201);
    assert.match(registered.body.sessionId, /^remote-session-/);

    const eventIngested = await requestJson(baseUrl, `/api/v2/remote-workers/sessions/${encodeURIComponent(registered.body.sessionId)}/events`, {
      method: 'POST',
      token: 'legacy-worker-token',
      body: {
        workerId: 'legacy-env-worker',
        batchId: 'legacy-env-batch',
        events: [{
          eventId: 'legacy-env-event-1',
          sequence: 1,
          eventAt: '2026-06-20T12:00:00.000Z',
          eventScope: 'workflow',
          eventType: 'worker_started',
          status: 'running',
          payload: {
            workerType: 'backlog_indexer',
            strategy: 'resolved_metadata',
          },
        }],
      },
    });
    assert.equal(eventIngested.status, 200);

    const artifactAccepted = await requestJson(baseUrl, `/api/v2/remote-workers/sessions/${encodeURIComponent(registered.body.sessionId)}/artifacts`, {
      method: 'POST',
      token: 'legacy-worker-token',
      body: {
        workerId: 'legacy-env-worker',
        artifacts: [{
          artifactId: 'legacy-env-artifact-1',
          eventId: 'legacy-env-event-1',
          artifactType: 'image',
          mediaRole: 'worker_screenshot',
          contentType: 'image/jpeg',
          sha256: 'd'.repeat(64),
          sizeBytes: 0,
          metadata: {
            legacySchema: true,
          },
        }],
      },
    });
    assert.equal(artifactAccepted.status, 200);
  } finally {
    await closeServer(server);
    if (previousRemoteToken === undefined) {
      delete process.env.MARKETPLACE_REMOTE_WORKER_TOKEN;
    } else {
      process.env.MARKETPLACE_REMOTE_WORKER_TOKEN = previousRemoteToken;
    }
    if (previousLegacyToken === undefined) {
      delete process.env.MARKETPLACE_WORKER_TOKEN;
    } else {
      process.env.MARKETPLACE_WORKER_TOKEN = previousLegacyToken;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('remote worker host API registers, heartbeats, ingests events, and projects compatibility events', async () => {
  const { tempDir, dbPath } = createTempDbPath();
  const workerToken = 'test-worker-token';
  const { db: seedDb } = openMarketplaceHomepageDatabase(dbPath);
  try {
    upsertHomepageListing(seedDb, {
      listingId: 'remote-listing-1',
      href: 'https://www.facebook.com/marketplace/item/remote-listing-1/',
      title: 'Remote listing',
      text: 'CA$100 | Remote listing',
      rank: 1,
    }, {
      seenAt: '2026-06-16T11:59:00.000Z',
    });
  } finally {
    closeMarketplaceHomepageDatabase(seedDb);
  }
  const server = createServer({
    dbPath,
    adminToken: 'admin-token',
    readOnlyToken: 'readonly-token',
    workerToken,
    initialDelayMs: 60 * 60 * 1000,
  });
  const address = await listen(server);
  const baseUrl = `http://${address.address}:${address.port}`;
  let sessionId = '';

  try {
    const unauthorized = await requestJson(baseUrl, '/api/v2/remote-workers/sessions', {
      method: 'POST',
      body: {
        workerId: 'remote-indexer-1',
        workerType: 'backlog_indexer',
        strategy: 'resolved_metadata',
      },
    });
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.body.error.code, 'invalid_worker_token');

    const registered = await requestJson(baseUrl, '/api/v2/remote-workers/sessions', {
      method: 'POST',
      token: workerToken,
      body: {
        workerId: 'remote-indexer-1',
        workerType: 'backlog_indexer',
        strategy: 'resolved_metadata',
        workerVersion: 'test-version',
        sourceId: 'test-remote-indexer',
        capabilities: {
          apiVersion: 'v1',
          localOutbox: true,
        },
        lastCheckpoint: {
          lastAckedSequence: 0,
        },
      },
    });
    assert.equal(registered.status, 201);
    assert.match(registered.body.sessionId, /^remote-session-/);
    assert.equal(registered.body.status, 'registered');
    assert.equal(registered.body.hostCheckpoint.lastAcceptedSequence, 0);
    sessionId = registered.body.sessionId;

    const heartbeat = await requestJson(baseUrl, `/api/v2/remote-workers/sessions/${encodeURIComponent(sessionId)}/heartbeat`, {
      method: 'POST',
      token: workerToken,
      body: {
        workerId: 'remote-indexer-1',
        runtimeState: 'working',
        lastLocalSequence: 2,
        lastAckedSequence: 0,
        pendingEventCount: 2,
      },
    });
    assert.equal(heartbeat.status, 200);
    assert.equal(heartbeat.body.status, 'ok');
    assert.equal(heartbeat.body.hostCheckpoint.lastAcceptedSequence, 0);

    const batch = {
      workerId: 'remote-indexer-1',
      batchId: 'batch-1',
      events: [
        {
          eventId: 'remote-test-event-1',
          sequence: 1,
          eventAt: '2026-06-16T12:00:01.000Z',
          eventScope: 'workflow',
          eventType: 'worker_started',
          status: 'running',
          payload: {
            mode: 'test',
          },
        },
        {
          eventId: 'remote-test-event-2',
          sequence: 2,
          eventAt: '2026-06-16T12:00:02.000Z',
          eventScope: 'listing',
          eventType: 'backlog_listing_metadata_indexed',
          listingId: 'remote-listing-1',
          status: 'done',
          payload: {
            indexerVersion: 'resolved-metadata-v1',
            listedAtMin: '2026-06-15T00:00:00.000Z',
            listedAtMax: '2026-06-15T23:59:59.999Z',
            confidence: 'high',
          },
        },
      ],
    };

    const ingested = await requestJson(baseUrl, `/api/v2/remote-workers/sessions/${encodeURIComponent(sessionId)}/events`, {
      method: 'POST',
      token: workerToken,
      body: batch,
    });
    assert.equal(ingested.status, 200);
    assert.equal(ingested.body.status, 'accepted');
    assert.deepEqual(ingested.body.accepted.map((event) => event.eventId), [
      'remote-test-event-1',
      'remote-test-event-2',
    ]);
    assert.deepEqual(ingested.body.rejected, []);
    assert.equal(ingested.body.checkpoint.lastAcceptedSequence, 2);

    const duplicate = await requestJson(baseUrl, `/api/v2/remote-workers/sessions/${encodeURIComponent(sessionId)}/events`, {
      method: 'POST',
      token: workerToken,
      body: batch,
    });
    assert.equal(duplicate.status, 200);
    assert.deepEqual(duplicate.body.duplicates.map((event) => event.eventId), [
      'remote-test-event-1',
      'remote-test-event-2',
    ]);
    assert.deepEqual(duplicate.body.rejected, []);

    const invalid = await requestJson(baseUrl, `/api/v2/remote-workers/sessions/${encodeURIComponent(sessionId)}/events`, {
      method: 'POST',
      token: workerToken,
      body: {
        workerId: 'remote-indexer-1',
        batchId: 'bad-batch',
        events: [{
          eventId: 'remote-test-event-bad',
          sequence: 3,
          eventType: 'backlog_listing_metadata_skipped',
          eventScope: 'listing',
          listingId: 'remote-listing-2',
          payload: {},
        }],
      },
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, 'invalid_event_batch');
    assert.match(invalid.body.error.message, /missing required payload keys: reason/);

    const ingestRows = await requestJson(baseUrl, `/api/v2/remote-workers/sessions/${encodeURIComponent(sessionId)}/ingest-events`, {
      token: workerToken,
    });
    assert.equal(ingestRows.status, 200);
    assert.equal(ingestRows.body.events.length, 2);
    assert.ok(ingestRows.body.events.every((event) => event.reduceStatus === 'reduced'));

    const workflows = await requestJson(baseUrl, '/api/workflows', {
      token: 'admin-token',
    });
    assert.equal(workflows.status, 200);
    const remoteRun = workflows.body.processes.find((process) => process.id === sessionId);
    assert.ok(remoteRun);
    assert.equal(remoteRun.workerType, 'remote_worker');
    assert.equal(remoteRun.status, 'running');

    const artifactBatch = {
      workerId: 'remote-indexer-1',
      artifacts: [{
        exchangeType: 'artifact_manifest',
        schemaVersion: 'remote-worker-artifact@1',
        artifactId: 'remote-artifact-1',
        eventId: 'remote-test-event-2',
        artifactType: 'image',
        mediaRole: 'listing_photo',
        contentType: 'image/jpeg',
        sha256: 'a'.repeat(64),
        sizeBytes: 1024,
        width: 320,
        height: 240,
        metadata: {
          listingId: 'remote-listing-1',
          position: 0,
        },
        storage: {
          requestedBackend: 'local_fs',
          uploadMode: 'metadata_only',
        },
      }],
    };
    const artifactAccepted = await requestJson(baseUrl, `/api/v2/remote-workers/sessions/${encodeURIComponent(sessionId)}/artifacts`, {
      method: 'POST',
      token: workerToken,
      body: artifactBatch,
    });
    assert.equal(artifactAccepted.status, 200);
    assert.deepEqual(artifactAccepted.body.accepted.map((artifact) => artifact.artifactId), ['remote-artifact-1']);
    assert.deepEqual(artifactAccepted.body.duplicates, []);

    const artifactDuplicate = await requestJson(baseUrl, `/api/v2/remote-workers/sessions/${encodeURIComponent(sessionId)}/artifacts`, {
      method: 'POST',
      token: workerToken,
      body: artifactBatch,
    });
    assert.equal(artifactDuplicate.status, 200);
    assert.deepEqual(artifactDuplicate.body.accepted, []);
    assert.deepEqual(artifactDuplicate.body.duplicates.map((artifact) => artifact.artifactId), ['remote-artifact-1']);

    const claims = await requestJson(baseUrl, `/api/v2/remote-workers/sessions/${encodeURIComponent(sessionId)}/claims`, {
      method: 'POST',
      token: workerToken,
      body: {
        workerId: 'remote-indexer-1',
        workerType: 'backlog_indexer',
        strategy: 'resolved_metadata',
        capacity: 1,
      },
    });
    assert.equal(claims.status, 200);
    assert.deepEqual(claims.body.claims, []);
    assert.equal(claims.body.drainRequested, false);

    const commandId = 'remote-command-1';
    const commandDb = new DatabaseSync(dbPath);
    try {
      commandDb.prepare(`
        INSERT INTO remote_worker_commands (
          command_id,
          session_id,
          worker_id,
          worker_type,
          strategy,
          command_type,
          payload_json,
          priority,
          status,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)
      `).run(
        commandId,
        sessionId,
        'remote-indexer-1',
        'backlog_indexer',
        'resolved_metadata',
        'drain',
        JSON.stringify({ reason: 'test' }),
        10,
        '2026-06-16T12:00:03.000Z',
      );
    } finally {
      commandDb.close();
    }

    const commands = await requestJson(baseUrl, `/api/v2/remote-workers/sessions/${encodeURIComponent(sessionId)}/commands`, {
      token: workerToken,
    });
    assert.equal(commands.status, 200);
    assert.deepEqual(commands.body.commands.map((command) => command.commandId), [commandId]);
    assert.equal(commands.body.commands[0].commandType, 'drain');

    const commandAck = await requestJson(baseUrl, `/api/v2/remote-workers/sessions/${encodeURIComponent(sessionId)}/commands/${encodeURIComponent(commandId)}/ack`, {
      method: 'POST',
      token: workerToken,
      body: {
        status: 'acked',
        payload: {
          accepted: true,
        },
      },
    });
    assert.equal(commandAck.status, 200);
    assert.equal(commandAck.body.status, 'acked');
    assert.equal(commandAck.body.commandId, commandId);
  } finally {
    await closeServer(server);
  }

  try {
    const db = new DatabaseSync(dbPath);
    const session = db.prepare('SELECT * FROM remote_worker_sessions WHERE session_id = ?').get(sessionId);
    assert.equal(session.worker_id, 'remote-indexer-1');
    assert.equal(session.liveness_state, 'online');
    assert.equal(session.last_acked_sequence, 2);

    const ingestCount = db.prepare('SELECT COUNT(*) AS count FROM remote_worker_event_ingest').get().count;
    assert.equal(ingestCount, 2);

    const workflowEvent = db.prepare('SELECT * FROM workflow_events WHERE event_id = ?').get('remote-test-event-1');
    assert.equal(workflowEvent.workflow_run_id, sessionId);
    assert.equal(workflowEvent.event_type, 'worker_started');

    const listingEvent = db.prepare('SELECT * FROM listing_events WHERE event_id = ?').get('remote-test-event-2');
    assert.equal(listingEvent.workflow_run_id, sessionId);
    assert.equal(listingEvent.worker_id, 'remote-indexer-1');
    assert.equal(listingEvent.listing_id, 'remote-listing-1');
    assert.equal(listingEvent.event_type, 'backlog_listing_metadata_indexed');

    const artifact = db.prepare('SELECT * FROM remote_worker_artifacts WHERE artifact_id = ?').get('remote-artifact-1');
    assert.equal(artifact.session_id, sessionId);
    assert.equal(artifact.worker_id, 'remote-indexer-1');
    assert.equal(artifact.event_id, 'remote-test-event-2');
    assert.equal(artifact.upload_status, 'manifest_accepted');

    const command = db.prepare('SELECT * FROM remote_worker_commands WHERE command_id = ?').get('remote-command-1');
    assert.equal(command.status, 'acked');
    assert.equal(command.ack_status, 'acked');
    db.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});



test('remote worker host API projects remote homepage collector listing events into central listings', async () => {
  const { tempDir, dbPath } = createTempDbPath();
  const workerToken = 'test-worker-token';
  const server = createServer({
    dbPath,
    adminToken: 'admin-token',
    readOnlyToken: 'readonly-token',
    workerToken,
    initialDelayMs: 60 * 60 * 1000,
  });
  const address = await listen(server);
  const baseUrl = `http://${address.address}:${address.port}`;
  let sessionId = '';

  try {
    const registered = await requestJson(baseUrl, '/api/v2/remote-workers/sessions', {
      method: 'POST',
      token: workerToken,
      body: {
        workerId: 'remote-feed-collector-1',
        workerType: 'collector',
        strategy: 'feed',
        workerVersion: 'collector-test',
        sourceId: 'remote-feed-test',
      },
    });
    assert.equal(registered.status, 201);
    sessionId = registered.body.sessionId;

    const ingested = await requestJson(baseUrl, `/api/v2/remote-workers/sessions/${encodeURIComponent(sessionId)}/events`, {
      method: 'POST',
      token: workerToken,
      body: {
        workerId: 'remote-feed-collector-1',
        batchId: 'remote-feed-batch-1',
        events: [{
          eventId: 'remote-feed-listing-event-1',
          sequence: 1,
          eventAt: '2026-06-20T12:00:00.000Z',
          eventScope: 'listing',
          eventType: 'listing_observed',
          listingId: 'remote-feed-listing-1',
          status: 'new',
          payload: {
            listingId: 'remote-feed-listing-1',
            href: 'https://www.facebook.com/marketplace/item/remote-feed-listing-1/',
            source: 'homepage',
            outcome: 'new',
            rank: 1,
            cardTitle: 'Remote feed listing',
            cardText: 'CA$100 | Remote feed listing',
            price: 'CA$100',
            photos: [{
              sourceUrl: 'https://example.test/feed.jpg',
              altText: 'feed photo',
              width: 640,
              height: 480,
              position: 0,
              source: 'collector_card',
            }],
          },
        }],
      },
    });
    assert.equal(ingested.status, 200, JSON.stringify(ingested.body));
    assert.deepEqual(ingested.body.rejected, []);
  } finally {
    await closeServer(server);
  }

  try {
    const db = new DatabaseSync(dbPath);
    const listing = db.prepare('SELECT * FROM homepage_listings WHERE listing_id = ?').get('remote-feed-listing-1');
    assert.equal(listing.source, 'homepage');
    assert.equal(listing.card_title, 'Remote feed listing');
    assert.equal(listing.card_text, 'CA$100 | Remote feed listing');
    assert.equal(listing.detail_price, 'CA$100');
    assert.equal(listing.detail_status, 'pending');

    const media = db.prepare('SELECT * FROM listing_media WHERE listing_id = ?').get('remote-feed-listing-1');
    assert.equal(media.source_url, 'https://example.test/feed.jpg');
    assert.equal(media.source, 'collector_card');

    const listingEvent = db.prepare('SELECT * FROM listing_events WHERE event_id = ?').get('remote-feed-listing-event-1');
    assert.equal(listingEvent.worker_id, 'remote-feed-collector-1');
    assert.equal(listingEvent.event_type, 'listing_observed');
    db.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('remote worker host API projects remote search explorer listing events into keyword indexes', async () => {
  const { tempDir, dbPath } = createTempDbPath();
  const workerToken = 'test-worker-token';
  const server = createServer({
    dbPath,
    adminToken: 'admin-token',
    readOnlyToken: 'readonly-token',
    workerToken,
    initialDelayMs: 60 * 60 * 1000,
  });
  const address = await listen(server);
  const baseUrl = `http://${address.address}:${address.port}`;
  let sessionId = '';

  try {
    const registered = await requestJson(baseUrl, '/api/v2/remote-workers/sessions', {
      method: 'POST',
      token: workerToken,
      body: {
        workerId: 'remote-search-collector-1',
        workerType: 'collector',
        strategy: 'explorer',
        workerVersion: 'collector-test',
        sourceId: 'remote-search-test',
      },
    });
    assert.equal(registered.status, 201);
    sessionId = registered.body.sessionId;

    const ingested = await requestJson(baseUrl, `/api/v2/remote-workers/sessions/${encodeURIComponent(sessionId)}/events`, {
      method: 'POST',
      token: workerToken,
      body: {
        workerId: 'remote-search-collector-1',
        batchId: 'remote-search-batch-1',
        events: [{
          eventId: 'remote-search-listing-event-1',
          sequence: 1,
          eventAt: '2026-06-20T12:01:00.000Z',
          eventScope: 'listing',
          eventType: 'listing_observed',
          listingId: 'remote-search-listing-1',
          status: 'new',
          payload: {
            listingId: 'remote-search-listing-1',
            href: 'https://www.facebook.com/marketplace/item/remote-search-listing-1/',
            source: 'search',
            sourceKeyword: 'pentax 67',
            outcome: 'new',
            rank: 3,
            cardTitle: 'Pentax 67 105mm kit',
            cardText: 'CA$1200 | Pentax 67 105mm kit',
            price: 'CA$1200',
          },
        }],
      },
    });
    assert.equal(ingested.status, 200, JSON.stringify(ingested.body));
    assert.deepEqual(ingested.body.rejected, []);
  } finally {
    await closeServer(server);
  }

  try {
    const db = new DatabaseSync(dbPath);
    const listing = db.prepare('SELECT * FROM homepage_listings WHERE listing_id = ?').get('remote-search-listing-1');
    assert.equal(listing.source, 'search');
    assert.equal(listing.source_keyword, 'pentax 67');
    assert.equal(listing.card_title, 'Pentax 67 105mm kit');

    const keyword = db.prepare('SELECT * FROM listing_search_keywords WHERE listing_id = ? AND normalized_keyword = ?')
      .get('remote-search-listing-1', 'pentax 67');
    assert.equal(keyword.keyword, 'pentax 67');

    const titleBag = db.prepare('SELECT * FROM search_title_bag WHERE normalized_keyword = ?').get('pentax 67');
    assert.equal(titleBag.keyword, 'pentax 67');
    assert.equal(titleBag.last_source_keyword, 'pentax 67');
    db.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('remote worker host API issues backlog indexer claims and protects stale leases', async () => {
  const { tempDir, dbPath } = createTempDbPath();
  const workerToken = 'test-worker-token';
  const legacyDb = new DatabaseSync(dbPath);
  try {
    legacyDb.exec(`
      CREATE TABLE remote_worker_commands (
        command_id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  } finally {
    legacyDb.close();
  }
  const { db: seedDb } = openMarketplaceHomepageDatabase(dbPath);
  try {
    upsertHomepageListing(seedDb, {
      listingId: 'claim-listing-1',
      href: 'https://www.facebook.com/marketplace/item/claim-listing-1/',
      title: 'Claim listing',
      text: 'CA$200 | Claim listing',
      rank: 1,
    }, {
      seenAt: '2026-06-16T11:59:00.000Z',
    });
    seedDb.prepare(`
      UPDATE homepage_listings
      SET
        detail_status = 'done',
        detail_title = 'Claim listing resolved',
        detail_price = 'CA$200',
        detail_location = 'Vancouver, BC',
        detail_condition = 'Used - like new',
        detail_listed_ago = '2 days ago',
        detail_completed_at = '2026-06-16T12:00:00.000Z',
        detail_json = ?
      WHERE listing_id = ?
    `).run(JSON.stringify({
      listingContent: {
        title: 'Claim listing resolved',
        price: 'CA$200',
        description: 'Resolved detail text',
      },
    }), 'claim-listing-1');
  } finally {
    closeMarketplaceHomepageDatabase(seedDb);
  }

  const server = createServer({
    dbPath,
    adminToken: 'admin-token',
    readOnlyToken: 'readonly-token',
    workerToken,
    initialDelayMs: 60 * 60 * 1000,
  });
  const address = await listen(server);
  const baseUrl = `http://${address.address}:${address.port}`;
  let sessionId = '';
  let leaseId = '';

  try {
    const registered = await requestJson(baseUrl, '/api/v2/remote-workers/sessions', {
      method: 'POST',
      token: workerToken,
      body: {
        workerId: 'claim-indexer-1',
        workerType: 'backlog_indexer',
        strategy: 'resolved_metadata',
        workerVersion: 'claim-test',
        sourceId: 'claim-test',
      },
    });
    assert.equal(registered.status, 201);
    sessionId = registered.body.sessionId;

    const claimed = await requestJson(baseUrl, `/api/v2/remote-workers/sessions/${encodeURIComponent(sessionId)}/claims`, {
      method: 'POST',
      token: workerToken,
      body: {
        workerId: 'claim-indexer-1',
        workerType: 'backlog_indexer',
        strategy: 'resolved_metadata',
        acceptedCommandTypes: ['index_resolved_listing_metadata_batch'],
        capacity: 1,
        batchSize: 1,
        leaseSeconds: 120,
      },
    });
    assert.equal(claimed.status, 200);
    assert.equal(claimed.body.claims.length, 1);
    assert.equal(claimed.body.claims[0].commandType, 'index_resolved_listing_metadata_batch');
    assert.equal(claimed.body.claims[0].payload.indexerVersion, 'resolved-metadata-v1');
    assert.equal(claimed.body.claims[0].payload.items.length, 1);
    assert.equal(claimed.body.claims[0].payload.items[0].listingId, 'claim-listing-1');
    assert.equal(claimed.body.claims[0].payload.items[0].detailListedAgo, '2 days ago');
    leaseId = claimed.body.claims[0].leaseId;

    const renewed = await requestJson(baseUrl, `/api/v2/remote-workers/sessions/${encodeURIComponent(sessionId)}/leases/${encodeURIComponent(leaseId)}/renew`, {
      method: 'POST',
      token: workerToken,
      body: {
        expiresAt: '2999-01-01T00:00:00.000Z',
      },
    });
    assert.equal(renewed.status, 200);
    assert.equal(renewed.body.status, 'renewed');

    const staleDb = new DatabaseSync(dbPath);
    try {
      staleDb.prepare(`
        UPDATE remote_worker_claims
        SET status = 'claimed', expires_at = '2000-01-01T00:00:00.000Z'
        WHERE lease_id = ?
      `).run(leaseId);
    } finally {
      staleDb.close();
    }

    const staleComplete = await requestJson(baseUrl, `/api/v2/remote-workers/sessions/${encodeURIComponent(sessionId)}/leases/${encodeURIComponent(leaseId)}/complete`, {
      method: 'POST',
      token: workerToken,
      body: {
        status: 'completed',
      },
    });
    assert.equal(staleComplete.status, 409);
    assert.equal(staleComplete.body.error.code, 'stale_remote_worker_lease');

    const freshDb = new DatabaseSync(dbPath);
    try {
      freshDb.prepare(`
        UPDATE remote_worker_claims
        SET status = 'claimed', expires_at = '2999-01-01T00:00:00.000Z'
        WHERE lease_id = ?
      `).run(leaseId);
    } finally {
      freshDb.close();
    }

    const completed = await requestJson(baseUrl, `/api/v2/remote-workers/sessions/${encodeURIComponent(sessionId)}/leases/${encodeURIComponent(leaseId)}/complete`, {
      method: 'POST',
      token: workerToken,
      body: {
        status: 'completed',
        result: {
          processedCount: 1,
        },
      },
    });
    assert.equal(completed.status, 200);
    assert.equal(completed.body.status, 'completed');

    const metadataEvent = await requestJson(baseUrl, `/api/v2/remote-workers/sessions/${encodeURIComponent(sessionId)}/events`, {
      method: 'POST',
      token: workerToken,
      body: {
        workerId: 'claim-indexer-1',
        batchId: 'claim-result-batch',
        events: [{
          eventId: 'claim-indexed-event-1',
          sequence: 1,
          eventAt: '2026-06-16T12:01:00.000Z',
          eventScope: 'listing',
          eventType: 'backlog_listing_metadata_indexed',
          listingId: 'claim-listing-1',
          status: 'done',
          payload: {
            indexerVersion: 'resolved-metadata-v1',
            detailListedAgo: '2 days ago',
            listedAtMin: '2026-06-14T00:00:00.000Z',
            listedAtMax: '2026-06-14T23:59:59.999Z',
            confidence: 'high',
          },
        }],
      },
    });
    assert.equal(metadataEvent.status, 200);
    assert.equal(metadataEvent.body.accepted.length, 1);
  } finally {
    await closeServer(server);
  }

  try {
    const db = new DatabaseSync(dbPath);
    const claim = db.prepare('SELECT * FROM remote_worker_claims WHERE lease_id = ?').get(leaseId);
    assert.equal(claim.status, 'completed');
    const command = db.prepare('SELECT * FROM remote_worker_commands WHERE command_id = ?').get(claim.command_id);
    assert.equal(command.status, 'completed');
    assert.equal(command.type, 'index_resolved_listing_metadata_batch');
    assert.equal(command.command_type, 'index_resolved_listing_metadata_batch');
    const listing = db.prepare('SELECT * FROM homepage_listings WHERE listing_id = ?').get('claim-listing-1');
    assert.equal(listing.detail_listed_at_raw, '2 days ago');
    assert.equal(listing.detail_listed_at_earliest_unix, Math.floor(Date.parse('2026-06-14T00:00:00.000Z') / 1000));
    assert.equal(listing.detail_listed_at_latest_unix, Math.floor(Date.parse('2026-06-14T23:59:59.999Z') / 1000));
    assert.equal(listing.detail_listed_at_confidence, 'high');
    assert.match(listing.detail_listed_at_source, /^remote:claim-indexer-1:/);
    db.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});


test('remote worker UI API exposes health and queues control commands', async () => {
  const { tempDir, dbPath } = createTempDbPath();
  const workerToken = 'ui-worker-token';
  const { db: seedDb } = openMarketplaceHomepageDatabase(dbPath);
  closeMarketplaceHomepageDatabase(seedDb);
  const server = createServer({
    dbPath,
    adminToken: 'admin-token',
    readOnlyToken: 'readonly-token',
    workerToken,
    initialDelayMs: 60 * 60 * 1000,
  });
  const address = await listen(server);
  const baseUrl = `http://${address.address}:${address.port}`;
  let sessionId = '';

  try {
    const registered = await requestJson(baseUrl, '/api/v2/remote-workers/sessions', {
      method: 'POST',
      token: workerToken,
      body: {
        workerId: 'ui-remote-collector-1',
        workerType: 'collector',
        strategy: 'homepage',
        workerVersion: 'ui-test-version',
        sourceId: 'facebook_marketplace',
        capabilities: {
          apiVersion: 'v2',
          acceptsCommands: ['drain', 'shutdown'],
        },
      },
    });
    assert.equal(registered.status, 201);
    sessionId = registered.body.sessionId;

    const heartbeat = await requestJson(baseUrl, `/api/v2/remote-workers/sessions/${encodeURIComponent(sessionId)}/heartbeat`, {
      method: 'POST',
      token: workerToken,
      body: {
        workerId: 'ui-remote-collector-1',
        runtimeState: 'idle',
        lastLocalSequence: 4,
        lastAckedSequence: 4,
        pendingEventCount: 0,
      },
    });
    assert.equal(heartbeat.status, 200);

    const workflows = await requestJson(baseUrl, '/api/workflows?config=0&stats=0&reconcile=0', {
      token: 'admin-token',
    });
    assert.equal(workflows.status, 200);
    const workflowWorker = workflows.body.remoteWorkers.find((worker) => worker.sessionId === sessionId);
    assert.ok(workflowWorker);
    assert.equal(workflowWorker.workerId, 'ui-remote-collector-1');
    assert.equal(workflowWorker.displayState, 'standby');
    assert.equal(workflowWorker.standby, true);
    assert.equal(workflowWorker.lastLocalSequence, 4);
    assert.equal(workflowWorker.lastAckedSequence, 0);

    const remoteWorkers = await requestJson(baseUrl, '/api/remote-workers?limit=10', {
      token: 'admin-token',
    });
    assert.equal(remoteWorkers.status, 200);
    assert.equal(remoteWorkers.body.workers.length, 1);
    assert.equal(remoteWorkers.body.workers[0].sessionId, sessionId);
    assert.equal(remoteWorkers.body.workers[0].displayState, 'standby');

    const readOnlyCommand = await requestJson(baseUrl, `/api/remote-workers/${encodeURIComponent(sessionId)}/commands`, {
      method: 'POST',
      token: 'readonly-token',
      body: { commandType: 'drain' },
    });
    assert.equal(readOnlyCommand.status, 403);

    const queued = await requestJson(baseUrl, `/api/remote-workers/${encodeURIComponent(sessionId)}/commands`, {
      method: 'POST',
      token: 'admin-token',
      body: { commandType: 'drain' },
    });
    assert.equal(queued.status, 202);
    assert.equal(queued.body.commandType, 'drain');
    assert.equal(queued.body.worker.sessionId, sessionId);
    assert.equal(queued.body.worker.displayState, 'queued');

    const commands = await requestJson(baseUrl, `/api/v2/remote-workers/sessions/${encodeURIComponent(sessionId)}/commands`, {
      token: workerToken,
    });
    assert.equal(commands.status, 200);
    assert.deepEqual(commands.body.commands.map((command) => command.commandType), ['drain']);
  } finally {
    await closeServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
