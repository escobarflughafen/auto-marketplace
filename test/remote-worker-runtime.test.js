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
const {
  parseArgs,
  run,
  RemoteWorkerRuntime,
  collectorDbNameForStrategy,
  collectorScriptForStrategy,
  isCollectorRuntime,
} = require('../scripts/remote-worker-runtime');
const {
  openRemoteWorkerLocalStore,
  setState,
  appendOutboxEvent,
} = require('../scripts/remote-worker-local-store');

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'remote-worker-runtime-'));
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

function seedResolvedListing(dbPath, listingId = 'runtime-listing-1') {
  const { db } = openMarketplaceHomepageDatabase(dbPath);
  try {
    upsertHomepageListing(db, {
      listingId,
      href: `https://www.facebook.com/marketplace/item/${listingId}/`,
      title: 'Runtime listing',
      text: 'CA$300 | Runtime listing',
      rank: 1,
    }, {
      seenAt: '2026-06-20T12:00:00.000Z',
    });
    db.prepare(`
      UPDATE homepage_listings
      SET
        detail_status = 'done',
        detail_title = 'Runtime listing resolved',
        detail_price = 'CA$300',
        detail_location = 'Vancouver, BC',
        detail_condition = 'Used - good',
        detail_listed_ago = '2 days ago',
        detail_completed_at = '2026-06-20T12:30:00.000Z',
        detail_json = ?
      WHERE listing_id = ?
    `).run(JSON.stringify({
      listingContent: {
        title: 'Runtime listing resolved',
        price: 'CA$300',
        description: 'Runtime resolved detail text',
      },
    }), listingId);
  } finally {
    closeMarketplaceHomepageDatabase(db);
  }
}

test('remote worker runtime maps Goofish collector strategy to adapter script and DB', () => {
  assert.equal(isCollectorRuntime({ workerType: 'collector', strategy: 'goofish_search' }), true);
  assert.equal(collectorScriptForStrategy('goofish_search'), 'scripts/collect-goofish-search-explorer.js');
  assert.equal(collectorDbNameForStrategy('goofish_search'), 'goofish-search-explorer.db');
});

test('remote worker runtime maps task envelopes to collector command execution', async () => {
  const tempDir = createTempDir();
  const workerDbPath = path.join(tempDir, 'worker-task-envelope.db');
  const runtime = new RemoteWorkerRuntime({
    hostUrl: 'http://127.0.0.1:1',
    workerToken: 'task-envelope-token',
    localDbPath: workerDbPath,
    workerId: 'runtime-task-envelope-1',
    workerType: 'worker_endpoint',
    strategy: '',
    sourceId: 'runtime-task-envelope-test',
  });
  let forwardedCommand = null;
  runtime.executeCollectorCommand = async (command) => {
    forwardedCommand = command;
    return { ok: true, commandId: command.commandId };
  };

  try {
    const result = await runtime.executeTaskCommand({
      commandId: 'task-command-1',
      commandType: 'execute_task',
      payload: {
        task: {
          exchangeType: 'task',
          taskId: 'task-envelope-1',
          taskSource: 'test',
          taskType: 'collect_search_results',
          workerType: 'collector',
          strategy: 'explorer',
          payload: {
            workflowId: 'search-explore',
            adapterArgs: ['--query', 'pentax 67', '--collect-all'],
          },
        },
      },
    });
    assert.deepEqual(result, { ok: true, commandId: 'task-command-1' });
    assert.equal(forwardedCommand.commandId, 'task-command-1');
    assert.equal(forwardedCommand.payload.workflowId, 'search-explore');
    assert.equal(forwardedCommand.payload.strategy, 'explorer');
    assert.equal(forwardedCommand.payload.taskId, 'task-envelope-1');
    assert.equal(forwardedCommand.payload.taskType, 'collect_search_results');
    assert.deepEqual(forwardedCommand.payload.adapterArgs, ['--query', 'pentax 67', '--collect-all']);
  } finally {
    runtime.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('remote worker runtime claims backlog indexer work, syncs events, and completes lease', async () => {
  const tempDir = createTempDir();
  const dbPath = path.join(tempDir, 'marketplace.db');
  const workerDbPath = path.join(tempDir, 'worker.db');
  const workerToken = 'runtime-worker-token';
  seedResolvedListing(dbPath);
  const server = createServer({
    dbPath,
    adminToken: 'admin-token',
    readOnlyToken: 'readonly-token',
    workerToken,
    initialDelayMs: 60 * 60 * 1000,
  });
  const address = await listen(server);

  try {
    const result = await run({
      hostUrl: `http://${address.address}:${address.port}`,
      workerToken,
      localDbPath: workerDbPath,
      workerId: 'runtime-indexer-1',
      workerType: 'backlog_indexer',
      strategy: 'resolved_metadata',
      sourceId: 'runtime-test',
      once: true,
      capacity: 1,
      batchSize: 1,
    });
    assert.equal(result.claims.length, 1);
    assert.equal(result.claimResults[0].processedCount, 1);
  } finally {
    await closeServer(server);
  }

  try {
    const db = new DatabaseSync(dbPath);
    const listing = db.prepare('SELECT * FROM homepage_listings WHERE listing_id = ?').get('runtime-listing-1');
    assert.equal(listing.detail_listed_at_unit, 'day');
    assert.equal(listing.detail_listed_at_value, 2);
    assert.equal(listing.detail_listed_at_confidence, 'range');
    assert.match(listing.detail_listed_at_source, /^remote:runtime-indexer-1:/);

    const claim = db.prepare('SELECT * FROM remote_worker_claims WHERE worker_id = ?').get('runtime-indexer-1');
    assert.equal(claim.status, 'completed');
    const listingEvent = db.prepare(`
      SELECT *
      FROM listing_events
      WHERE workflow_run_id = ? AND event_type = 'backlog_listing_metadata_indexed'
    `).get(claim.session_id);
    assert.equal(listingEvent.listing_id, 'runtime-listing-1');
    db.close();

    const workerDb = new DatabaseSync(workerDbPath);
    const pending = workerDb.prepare("SELECT COUNT(*) AS count FROM worker_outbox_events WHERE sync_status = 'pending'").get().count;
    const acked = workerDb.prepare("SELECT COUNT(*) AS count FROM worker_outbox_events WHERE sync_status = 'acked'").get().count;
    assert.equal(pending, 0);
    assert.ok(acked >= 3);
    workerDb.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('remote worker runtime uploads pending local outbox events after restart', async () => {
  const tempDir = createTempDir();
  const dbPath = path.join(tempDir, 'marketplace.db');
  const workerDbPath = path.join(tempDir, 'worker-retry.db');
  const workerToken = 'runtime-worker-token';
  seedResolvedListing(dbPath, 'runtime-retry-listing');
  const server = createServer({
    dbPath,
    adminToken: 'admin-token',
    readOnlyToken: 'readonly-token',
    workerToken,
    initialDelayMs: 60 * 60 * 1000,
  });
  const address = await listen(server);
  const hostUrl = `http://${address.address}:${address.port}`;
  let runtime;

  try {
    runtime = new RemoteWorkerRuntime({
      hostUrl,
      workerToken,
      localDbPath: workerDbPath,
      workerId: 'runtime-retry-1',
      workerType: 'backlog_indexer',
      strategy: 'resolved_metadata',
      sourceId: 'runtime-retry-test',
      once: true,
      capacity: 1,
      batchSize: 1,
    });
    await runtime.registerSession();
    const sessionId = runtime.sessionId;
    const { db: workerDb } = openRemoteWorkerLocalStore(workerDbPath);
    try {
      setState(workerDb, 'session', { sessionId });
      setState(workerDb, 'checkpoint', { lastLocalSequence: 1, lastAckedSequence: 0 });
      appendOutboxEvent(workerDb, {
        eventId: 'runtime-retry-event-1',
        sessionId,
        workerId: 'runtime-retry-1',
        workerType: 'backlog_indexer',
        strategy: 'resolved_metadata',
        sequence: 1,
        eventScope: 'workflow',
        eventType: 'worker_started',
        eventAt: '2026-06-20T12:00:01.000Z',
        status: 'running',
        payload: {
          workerType: 'backlog_indexer',
          strategy: 'resolved_metadata',
          mode: 'retry-test',
        },
      });
    } finally {
      workerDb.close();
    }
    runtime.close();
    runtime = null;

    const restarted = new RemoteWorkerRuntime({
      hostUrl,
      workerToken,
      localDbPath: workerDbPath,
      workerId: 'runtime-retry-1',
      workerType: 'backlog_indexer',
      strategy: 'resolved_metadata',
      sourceId: 'runtime-retry-test',
      once: true,
      capacity: 1,
      batchSize: 1,
    });
    try {
      await restarted.registerSession();
      await restarted.uploadPendingEvents();
    } finally {
      restarted.close();
    }
  } finally {
    if (runtime) runtime.close();
    await closeServer(server);
  }

  try {
    const db = new DatabaseSync(dbPath);
    const event = db.prepare('SELECT * FROM workflow_events WHERE event_id = ?').get('runtime-retry-event-1');
    assert.equal(event.event_type, 'worker_started');
    db.close();

    const workerDb = new DatabaseSync(workerDbPath);
    const row = workerDb.prepare('SELECT sync_status FROM worker_outbox_events WHERE event_id = ?').get('runtime-retry-event-1');
    assert.equal(row.sync_status, 'acked');
    workerDb.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('remote worker runtime uploads artifact manifests and persists local ACKs', async () => {
  const tempDir = createTempDir();
  const dbPath = path.join(tempDir, 'marketplace.db');
  const workerDbPath = path.join(tempDir, 'worker-artifacts.db');
  const workerToken = 'runtime-worker-token';
  const server = createServer({
    dbPath,
    adminToken: 'admin-token',
    readOnlyToken: 'readonly-token',
    workerToken,
    initialDelayMs: 60 * 60 * 1000,
  });
  const address = await listen(server);
  const runtime = new RemoteWorkerRuntime({
    hostUrl: `http://${address.address}:${address.port}`,
    workerToken,
    localDbPath: workerDbPath,
    workerId: 'runtime-artifacts-1',
    workerType: 'backlog_indexer',
    strategy: 'resolved_metadata',
    sourceId: 'runtime-artifact-test',
    once: true,
    artifactBatchSize: 5,
  });

  try {
    await runtime.registerSession();
    runtime.appendArtifactManifest({
      exchangeType: 'artifact_manifest',
      schemaVersion: 'remote-worker-artifact@1',
      artifactId: 'runtime-artifact-1',
      eventId: 'runtime-artifact-event-1',
      artifactType: 'image',
      mediaRole: 'listing_photo',
      contentType: 'image/jpeg',
      sha256: 'b'.repeat(64),
      sizeBytes: 2048,
      width: 640,
      height: 480,
      metadata: {
        listingId: 'runtime-artifact-listing',
        position: 0,
      },
    });
    const result = await runtime.uploadPendingArtifacts();
    assert.deepEqual(result.accepted.map((artifact) => artifact.artifactId), ['runtime-artifact-1']);
    assert.deepEqual(result.duplicates, []);
  } finally {
    runtime.close();
    await closeServer(server);
  }

  try {
    const db = new DatabaseSync(dbPath);
    const artifact = db.prepare('SELECT * FROM remote_worker_artifacts WHERE artifact_id = ?').get('runtime-artifact-1');
    assert.equal(artifact.worker_id, 'runtime-artifacts-1');
    assert.equal(artifact.event_id, 'runtime-artifact-event-1');
    assert.equal(artifact.upload_status, 'manifest_accepted');
    assert.equal(artifact.sha256, 'b'.repeat(64));
    db.close();

    const workerDb = new DatabaseSync(workerDbPath);
    const row = workerDb.prepare('SELECT sync_status, acked_at, last_error FROM worker_artifact_spool WHERE artifact_id = ?').get('runtime-artifact-1');
    assert.equal(row.sync_status, 'acked');
    assert.notEqual(row.acked_at, '');
    assert.equal(row.last_error, '');
    workerDb.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});


test('remote worker runtime writes emitted events and true artifacts to debug file', () => {
  const tempDir = createTempDir();
  const workerDbPath = path.join(tempDir, 'worker-debug.db');
  const debugFile = path.join(tempDir, 'debug', 'emissions.ndjson');
  const runtime = new RemoteWorkerRuntime({
    hostUrl: 'http://127.0.0.1:1',
    workerToken: 'debug-worker-token',
    localDbPath: workerDbPath,
    workerId: 'runtime-debug-1',
    workerType: 'backlog_indexer',
    strategy: 'resolved_metadata',
    sourceId: 'runtime-debug-test',
    eventsFile: debugFile,
  });

  try {
    runtime.appendEvent({
      eventScope: 'workflow',
      eventType: 'debug_worker_started',
      status: 'running',
      payload: {
        mode: 'debug-test',
        photos: [{
          artifactPath: '/tmp/runtime-debug-photo-1.jpg',
          mediaRole: 'listing_photo',
          position: 0,
        }],
      },
      eventAt: '2026-06-28T19:00:00.000Z',
    });
    runtime.appendArtifactManifest({
      exchangeType: 'artifact_manifest',
      schemaVersion: 'remote-worker-artifact@1',
      artifactId: 'runtime-debug-artifact-1',
      eventId: 'runtime-debug-event-1',
      artifactType: 'image',
      mediaRole: 'worker_screenshot',
      contentType: 'image/jpeg',
      sha256: 'd'.repeat(64),
      sizeBytes: 4096,
      storage: {
        localPath: '/tmp/runtime-debug-artifact-1.jpg',
      },
      metadata: {
        workflowId: 'remote-search-explore',
      },
    });
  } finally {
    runtime.close();
  }

  try {
    const lines = fs.readFileSync(debugFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(lines.length, 3);
    assert.equal(lines[0].kind, 'event_emitted');
    assert.equal(lines[0].workerId, 'runtime-debug-1');
    assert.equal(lines[0].event.eventType, 'debug_worker_started');
    assert.equal(lines[0].event.payload.mode, 'debug-test');
    assert.equal(lines[1].kind, 'artifact_observed');
    assert.equal(lines[1].artifact.artifactPath, '/tmp/runtime-debug-photo-1.jpg');
    assert.equal(lines[1].artifact.mediaRole, 'listing_photo');
    assert.equal(lines[2].kind, 'artifact_emitted');
    assert.equal(lines[2].artifact.artifactId, 'runtime-debug-artifact-1');
    assert.equal(lines[2].artifact.storage.localPath, '/tmp/runtime-debug-artifact-1.jpg');
    assert.equal(lines[2].artifact.metadata.workflowId, 'remote-search-explore');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('remote worker runtime applies artifact spool backpressure before claiming work', async () => {
  const tempDir = createTempDir();
  const dbPath = path.join(tempDir, 'marketplace.db');
  const workerDbPath = path.join(tempDir, 'worker-artifact-backpressure.db');
  const workerToken = 'runtime-worker-token';
  seedResolvedListing(dbPath, 'runtime-backpressure-listing');
  const server = createServer({
    dbPath,
    adminToken: 'admin-token',
    readOnlyToken: 'readonly-token',
    workerToken,
    initialDelayMs: 60 * 60 * 1000,
  });
  const address = await listen(server);
  const runtime = new RemoteWorkerRuntime({
    hostUrl: `http://${address.address}:${address.port}`,
    workerToken,
    localDbPath: workerDbPath,
    workerId: 'runtime-artifact-backpressure-1',
    workerType: 'backlog_indexer',
    strategy: 'resolved_metadata',
    sourceId: 'runtime-artifact-test',
    once: true,
    capacity: 1,
    batchSize: 1,
    maxPendingArtifactBytes: 1024,
  });

  try {
    await runtime.registerSession();
    runtime.appendArtifactManifest({
      exchangeType: 'artifact_manifest',
      schemaVersion: 'remote-worker-artifact@1',
      artifactId: 'runtime-large-artifact-1',
      eventId: 'runtime-large-artifact-event-1',
      artifactType: 'image',
      mediaRole: 'listing_photo',
      contentType: 'image/jpeg',
      sha256: 'c'.repeat(64),
      sizeBytes: 2048,
      metadata: {
        listingId: 'runtime-backpressure-listing',
      },
    });
    const result = await runtime.claimWork();
    assert.deepEqual(result.claims, []);
    assert.equal(result.backpressure.reason, 'pending_artifact_bytes');
    assert.equal(result.backpressure.pendingArtifactBytes, 2048);
  } finally {
    runtime.close();
    await closeServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});


test('remote worker runtime keeps completed command and outbox pending while host is offline, then syncs on reconnect', async () => {
  const tempDir = createTempDir();
  const workerDbPath = path.join(tempDir, 'worker-offline-command.db');
  const runtime = new RemoteWorkerRuntime({
    hostUrl: 'http://127.0.0.1:1',
    workerToken: 'offline-worker-token',
    localDbPath: workerDbPath,
    workerId: 'runtime-offline-command-1',
    workerType: 'worker_endpoint',
    strategy: '',
    sourceId: 'runtime-offline-test',
  });
  const offlineError = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1'), { code: 'ECONNREFUSED' });

  try {
    runtime.sessionId = 'remote-session-offline-command-1';
    runtime.api.heartbeat = async () => { throw offlineError; };
    runtime.api.uploadEvents = async () => { throw offlineError; };
    runtime.api.uploadArtifacts = async () => ({ accepted: [], duplicates: [] });
    runtime.api.ackCommand = async () => { throw offlineError; };
    runtime.executeCollectorAdapterRun = async () => {
      runtime.appendEvent({
        eventScope: 'workflow',
        eventType: 'offline_task_completed',
        status: 'completed',
        payload: { commandId: 'offline-command-1' },
        eventAt: '2026-06-28T22:00:00.000Z',
      });
      return {
        adapterRunId: 'offline-adapter-run-1',
        replay: { workflowEvents: 1, listingEvents: 0 },
        exitCode: 0,
        signal: '',
      };
    };

    const result = await runtime.executeCollectorCommand({
      commandId: 'offline-command-1',
      commandType: 'execute_task',
      payload: {
        workflowId: 'search-explore',
        strategy: 'explorer',
        adapterArgs: ['--query', 'pentax'],
      },
    });
    assert.equal(result.adapterRunId, 'offline-adapter-run-1');
  } finally {
    runtime.close();
  }

  try {
    let db = new DatabaseSync(workerDbPath);
    let pendingEventCount = db.prepare("SELECT COUNT(*) AS count FROM worker_outbox_events WHERE sync_status = 'pending'").get().count;
    let command = db.prepare('SELECT status, ack_status, acked_at, last_error, ack_error FROM worker_commands WHERE command_id = ?').get('offline-command-1');
    assert.equal(pendingEventCount, 1);
    assert.equal(command.status, 'completed');
    assert.equal(command.ack_status, 'completed');
    assert.equal(command.acked_at, '');
    assert.equal(command.last_error, '');
    assert.match(command.ack_error, /ECONNREFUSED/);
    db.close();

    const restarted = new RemoteWorkerRuntime({
      hostUrl: 'http://127.0.0.1:1',
      workerToken: 'offline-worker-token',
      localDbPath: workerDbPath,
      workerId: 'runtime-offline-command-1',
      workerType: 'worker_endpoint',
      strategy: '',
      sourceId: 'runtime-offline-test',
    });
    const uploadedEvents = [];
    const commandAcks = [];
    try {
      restarted.sessionId = 'remote-session-offline-command-1';
      restarted.api.uploadEvents = async (_sessionId, body) => {
        uploadedEvents.push(...body.events);
        return {
          accepted: body.events.map((event) => ({ eventId: event.eventId })),
          duplicates: [],
          checkpoint: { lastAcceptedSequence: body.events.at(-1)?.sequence || 0 },
        };
      };
      restarted.api.uploadArtifacts = async () => ({ accepted: [], duplicates: [] });
      restarted.api.ackCommand = async (_sessionId, commandId, body) => {
        commandAcks.push({ commandId, body });
        return { status: body.status };
      };

      await restarted.syncPendingUploads({ drainAll: true });
      await restarted.syncPendingCommandAcks();
    } finally {
      restarted.close();
    }

    assert.equal(uploadedEvents.length, 1);
    assert.equal(uploadedEvents[0].eventType, 'offline_task_completed');
    assert.deepEqual(commandAcks, [{
      commandId: 'offline-command-1',
      body: {
        status: 'completed',
        payload: {
          accepted: true,
          workflowId: 'search-explore',
          strategy: 'explorer',
          adapterRunId: 'offline-adapter-run-1',
          replay: { workflowEvents: 1, listingEvents: 0 },
        },
      },
    }]);

    db = new DatabaseSync(workerDbPath);
    pendingEventCount = db.prepare("SELECT COUNT(*) AS count FROM worker_outbox_events WHERE sync_status = 'pending'").get().count;
    command = db.prepare('SELECT acked_at, ack_error FROM worker_commands WHERE command_id = ?').get('offline-command-1');
    assert.equal(pendingEventCount, 0);
    assert.notEqual(command.acked_at, '');
    assert.equal(command.ack_error, '');
    db.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('remote worker continuous mode waits through transient host disconnects', async () => {
  const tempDir = createTempDir();
  const workerDbPath = path.join(tempDir, 'worker-reconnect-loop.db');
  const runtime = new RemoteWorkerRuntime({
    hostUrl: 'http://127.0.0.1:1',
    workerToken: 'reconnect-worker-token',
    localDbPath: workerDbPath,
    workerId: 'runtime-reconnect-loop-1',
    workerType: 'worker_endpoint',
    strategy: '',
    sourceId: 'runtime-reconnect-test',
    pollIntervalMs: 1,
  });
  let attempts = 0;

  try {
    runtime.runOnce = async () => {
      attempts += 1;
      if (attempts < 3) {
        throw Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET' });
      }
      runtime.shutdownRequested = true;
      return { ok: true };
    };

    const result = await runtime.runContinuous();
    assert.equal(result.stopped, true);
    assert.equal(attempts, 3);
  } finally {
    runtime.close();
  }

  try {
    const db = new DatabaseSync(workerDbPath);
    const connection = JSON.parse(db.prepare("SELECT value_json FROM worker_state WHERE key = 'connection'").get().value_json);
    assert.equal(connection.state, 'online');
    db.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('parseArgs accepts legacy worker token env for container compatibility', () => {
  const previousRemoteToken = process.env.MARKETPLACE_REMOTE_WORKER_TOKEN;
  const previousLegacyToken = process.env.MARKETPLACE_WORKER_TOKEN;
  delete process.env.MARKETPLACE_REMOTE_WORKER_TOKEN;
  process.env.MARKETPLACE_WORKER_TOKEN = 'legacy-runtime-token';
  try {
    const options = parseArgs(['--host-url', 'http://127.0.0.1:3080', '--local-db', '/tmp/worker.db']);
    assert.equal(options.workerToken, 'legacy-runtime-token');
  } finally {
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
  }
});

test('parseArgs forwards collector-specific flags to the adapter runtime', () => {
  const options = parseArgs([
    '--host-url', 'http://127.0.0.1:3080',
    '--worker-token', 'runtime-token',
    '--local-db', '/tmp/remote-worker.db',
    '--worker-type', 'collector',
    '--strategy', 'explorer',
    '--query', 'pentax 67',
    '--max-items', '2',
    '--headless',
    '--events-stdout',
    '--events-file', '/tmp/remote-worker-events.ndjson',
  ]);
  assert.equal(options.workerType, 'collector');
  assert.equal(options.strategy, 'explorer');
  assert.equal(options.eventsStdout, true);
  assert.equal(options.eventsFile, '/tmp/remote-worker-events.ndjson');
  assert.deepEqual(options.adapterArgs, [
    '--query', 'pentax 67',
    '--max-items', '2',
    '--headless',
  ]);

  const xvfbOptions = parseArgs([
    '--host-url', 'http://127.0.0.1:3080',
    '--worker-token', 'runtime-token',
    '--local-db', '/tmp/remote-worker.db',
    '--worker-type', 'collector',
    '--strategy', 'goofish_search',
    '--browser-mode', 'xvfb',
    '--query', 'ricoh gr1',
    '--homepage-search',
  ]);
  assert.deepEqual(xvfbOptions.adapterArgs, [
    '--browser-mode', 'xvfb',
    '--query', 'ricoh gr1',
    '--homepage-search',
  ]);
});
