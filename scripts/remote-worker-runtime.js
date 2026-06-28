#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { listedAgoToUnixRange } = require('./marketplace-listed-time-normalizer');
const { RemoteWorkerApiClient } = require('./remote-worker-api-client');
const {
  listListingMedia,
} = require('./marketplace-homepage-db');
const {
  openRemoteWorkerLocalStore,
  getState,
  setState,
  appendOutboxEvent,
  listPendingOutboxEvents,
  markOutboxEventsAcked,
  markOutboxEventsFailed,
  countPendingOutboxEvents,
  appendLocalCommand,
  appendArtifactManifest,
  listPendingArtifactManifests,
  markArtifactsAcked,
  markArtifactsFailed,
  countPendingArtifacts,
} = require('./remote-worker-local-store');

function usage() {
  process.stdout.write(`Usage:
  node scripts/remote-worker-runtime.js --host-url URL --token-file FILE --local-db PATH [options]

Options:
  --worker-id ID             Default: remote-worker-<timestamp>
  --worker-type TYPE         Default: backlog_indexer
  --strategy STRATEGY        Default: resolved_metadata
  --source-id ID             Default: installable-runtime
  --once                     Run one claim/sync cycle and exit.
  --capacity N               Claim capacity. Default: 1
  --batch-size N             Listing batch size per claim. Default: 10
  --artifact-batch-size N    Artifact manifests per upload. Default: 25
  --max-pending-artifact-bytes N
                            Stop claiming above this local spool size. Default: 1073741824
  --heartbeat-interval-ms N  Continuous mode heartbeat interval. Default: 30000
  --poll-interval-ms N       Continuous mode poll interval. Default: 5000
  --json                     Print JSON summary.
`);
}

function readArg(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function parseArgs(argv) {
  const options = {
    hostUrl: process.env.REMOTE_WORKER_HOST_URL || '',
    tokenFile: process.env.REMOTE_WORKER_TOKEN_FILE || '',
    workerToken: process.env.MARKETPLACE_REMOTE_WORKER_TOKEN || process.env.MARKETPLACE_WORKER_TOKEN || '',
    localDbPath: process.env.REMOTE_WORKER_DB_PATH || '',
    workerId: process.env.REMOTE_WORKER_ID || '',
    workerType: 'backlog_indexer',
    strategy: 'resolved_metadata',
    sourceId: 'installable-runtime',
    once: false,
    capacity: 1,
    batchSize: 10,
    artifactBatchSize: 25,
    maxPendingArtifactBytes: 1024 * 1024 * 1024,
    heartbeatIntervalMs: 30000,
    pollIntervalMs: 5000,
    json: false,
    adapterArgs: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--host-url':
        options.hostUrl = readArg(argv, index, arg);
        index += 1;
        break;
      case '--token-file':
        options.tokenFile = readArg(argv, index, arg);
        index += 1;
        break;
      case '--worker-token':
        options.workerToken = readArg(argv, index, arg);
        index += 1;
        break;
      case '--local-db':
      case '--local-db-path':
        options.localDbPath = readArg(argv, index, arg);
        index += 1;
        break;
      case '--worker-id':
        options.workerId = readArg(argv, index, arg);
        index += 1;
        break;
      case '--worker-type':
        options.workerType = readArg(argv, index, arg);
        index += 1;
        break;
      case '--strategy':
        options.strategy = readArg(argv, index, arg);
        index += 1;
        break;
      case '--source-id':
        options.sourceId = readArg(argv, index, arg);
        index += 1;
        break;
      case '--capacity':
        options.capacity = Number.parseInt(readArg(argv, index, arg), 10);
        index += 1;
        break;
      case '--batch-size':
        options.batchSize = Number.parseInt(readArg(argv, index, arg), 10);
        index += 1;
        break;
      case '--artifact-batch-size':
        options.artifactBatchSize = Number.parseInt(readArg(argv, index, arg), 10);
        index += 1;
        break;
      case '--max-pending-artifact-bytes':
        options.maxPendingArtifactBytes = Number.parseInt(readArg(argv, index, arg), 10);
        index += 1;
        break;
      case '--heartbeat-interval-ms':
        options.heartbeatIntervalMs = Number.parseInt(readArg(argv, index, arg), 10);
        index += 1;
        break;
      case '--poll-interval-ms':
        options.pollIntervalMs = Number.parseInt(readArg(argv, index, arg), 10);
        index += 1;
        break;
      case '--once':
        options.once = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '-h':
      case '--help':
        usage();
        process.exit(0);
        break;
      default:
        if (arg.startsWith('--')) {
          options.adapterArgs.push(arg);
          const next = argv[index + 1];
          if (next && !next.startsWith('--')) {
            options.adapterArgs.push(next);
            index += 1;
          }
          break;
        }
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.workerId) {
    options.workerId = `remote-worker-${Date.now().toString(36)}`;
  }
  if (!options.localDbPath) {
    options.localDbPath = path.join(process.cwd(), 'artifacts', 'remote-workers', options.workerId, 'worker.db');
  }
  options.capacity = Math.max(1, Math.min(Number.isFinite(options.capacity) ? options.capacity : 1, 5));
  options.batchSize = Math.max(1, Math.min(Number.isFinite(options.batchSize) ? options.batchSize : 10, 100));
  options.artifactBatchSize = Math.max(1, Math.min(Number.isFinite(options.artifactBatchSize) ? options.artifactBatchSize : 25, 100));
  options.maxPendingArtifactBytes = Math.max(
    0,
    Number.isFinite(options.maxPendingArtifactBytes) ? options.maxPendingArtifactBytes : 1024 * 1024 * 1024,
  );
  return options;
}

function loadWorkerToken(options) {
  if (options.workerToken) return options.workerToken;
  if (options.tokenFile) {
    return fs.readFileSync(options.tokenFile, 'utf8').trim();
  }
  throw new Error('Missing --worker-token, --token-file, or MARKETPLACE_REMOTE_WORKER_TOKEN');
}

function isoFromUnix(value) {
  return Number.isFinite(value) ? new Date(value * 1000).toISOString() : '';
}

function buildEventId(workerId, sequence, eventType, entity = '') {
  const hash = crypto.createHash('sha256')
    .update(`${workerId}:${sequence}:${eventType}:${entity}:${Date.now()}:${crypto.randomBytes(4).toString('hex')}`)
    .digest('hex')
    .slice(0, 12);
  return `${workerId}:${sequence}:${eventType}:${hash}`;
}


function isCollectorRuntime(options = {}) {
  return String(options.workerType || '') === 'collector'
    && ['feed', 'explorer', 'goofish_search'].includes(String(options.strategy || ''));
}

function collectorScriptForStrategy(strategy) {
  switch (String(strategy || '')) {
    case 'feed':
      return 'scripts/collect-marketplace-homepage.js';
    case 'explorer':
      return 'scripts/collect-marketplace-search-explorer.js';
    case 'goofish_search':
      return 'scripts/collect-goofish-search-explorer.js';
    default:
      throw new Error(`Unsupported collector strategy for remote runtime: ${strategy}`);
  }
}

function collectorDbNameForStrategy(strategy) {
  switch (String(strategy || '')) {
    case 'explorer':
      return 'search-explorer.db';
    case 'goofish_search':
      return 'goofish-search-explorer.db';
    default:
      return 'homepage-collector.db';
  }
}

function stripManagedCollectorArgs(args = []) {
  const managedValueFlags = new Set([
    '--db-path',
    '--worker-id',
    '--log-file',
    '--snapshot-file',
    '--host-url',
    '--worker-token',
    '--token-file',
    '--local-db',
    '--local-db-path',
    '--worker-type',
    '--strategy',
    '--source-id',
    '--capacity',
    '--batch-size',
    '--artifact-batch-size',
    '--max-pending-artifact-bytes',
    '--heartbeat-interval-ms',
    '--poll-interval-ms',
  ]);
  const managedBooleanFlags = new Set(['--once', '--json']);
  const out = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index] || '');
    if (managedBooleanFlags.has(arg)) {
      continue;
    }
    if (managedValueFlags.has(arg)) {
      if (args[index + 1] && !String(args[index + 1]).startsWith('--')) {
        index += 1;
      }
      continue;
    }
    out.push(arg);
  }
  return out;
}

function runNodeScript(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => {
      stdout.push(chunk);
      if (!options.quiet) process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr.push(chunk);
      if (!options.quiet) process.stderr.write(chunk);
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function readCollectorRunEvents(dbPath, adapterRunId) {
  if (!fs.existsSync(dbPath)) {
    return { workflowEvents: [], listingEvents: [] };
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const workflowEvents = db.prepare(`
      SELECT event_id, event_type, event_at, status, content_json, error
      FROM workflow_events
      WHERE workflow_run_id = ?
      ORDER BY event_at ASC, event_id ASC
    `).all(adapterRunId).map((row) => ({
      eventId: row.event_id,
      eventType: row.event_type,
      eventAt: row.event_at,
      status: row.status || '',
      payload: parseJsonObject(row.content_json),
      error: row.error || '',
    }));
    const listingEvents = db.prepare(`
      SELECT event_id, listing_id, event_type, event_at, status, source_url, content_json, error
      FROM listing_events
      WHERE workflow_run_id = ?
      ORDER BY event_at ASC, event_id ASC
    `).all(adapterRunId).map((row) => {
      const payload = parseJsonObject(row.content_json);
      const listing = db.prepare(`
        SELECT listing_id, href, source, source_keyword, card_title, card_text, detail_price, last_seen_rank
        FROM homepage_listings
        WHERE listing_id = ?
      `).get(row.listing_id) || {};
      const media = listListingMedia(db, row.listing_id, { limit: 20 }).map((item) => ({
        mediaKey: item.media_key,
        mediaType: item.media_type,
        source: item.source,
        sourceUrl: item.source_url,
        artifactPath: item.artifact_path,
        altText: item.alt_text,
        width: item.width,
        height: item.height,
        position: item.position,
        metadata: item.metadata || {},
      }));
      return {
        eventId: row.event_id,
        listingId: row.listing_id,
        eventType: row.event_type,
        eventAt: row.event_at,
        status: row.status || '',
        sourceUrl: row.source_url || listing.href || payload.href || '',
        payload: {
          ...payload,
          listingId: payload.listingId || listing.listing_id || row.listing_id,
          href: payload.href || listing.href || row.source_url || '',
          source: payload.source || listing.source || '',
          sourceKeyword: payload.sourceKeyword || listing.source_keyword || '',
          rank: payload.rank ?? listing.last_seen_rank ?? null,
          cardTitle: payload.cardTitle || listing.card_title || '',
          cardText: payload.cardText || listing.card_text || '',
          price: payload.price || listing.detail_price || '',
          photos: media,
        },
        error: row.error || '',
      };
    });
    return { workflowEvents, listingEvents };
  } finally {
    db.close();
  }
}

class RemoteWorkerRuntime {
  constructor(options = {}) {
    this.options = {
      ...options,
      workerToken: loadWorkerToken(options),
    };
    const { db } = openRemoteWorkerLocalStore(this.options.localDbPath);
    this.db = db;
    this.api = new RemoteWorkerApiClient({
      hostUrl: this.options.hostUrl,
      workerToken: this.options.workerToken,
      timeoutMs: this.options.timeoutMs,
    });
    this.sessionId = getState(this.db, 'session', {})?.sessionId || '';
    this.shutdownRequested = false;
    this.drainRequested = false;
  }

  close() {
    this.db.close();
  }

  async registerSession() {
    if (this.sessionId) {
      return { sessionId: this.sessionId, resumed: true };
    }
    const registered = await this.api.registerSession({
      workerId: this.options.workerId,
      workerType: this.options.workerType,
      strategy: this.options.strategy,
      workerVersion: 'remote-worker-runtime@1',
      sourceId: this.options.sourceId,
      capabilities: {
        apiVersion: 'v2',
        localOutbox: true,
        commands: true,
        claims: true,
        artifactManifests: true,
      },
      lastCheckpoint: {
        lastAckedSequence: getState(this.db, 'checkpoint', { lastAckedSequence: 0 })?.lastAckedSequence || 0,
      },
    });
    this.sessionId = registered.sessionId;
    setState(this.db, 'session', {
      sessionId: this.sessionId,
      registeredAt: new Date().toISOString(),
    });
    return registered;
  }

  async sendHeartbeat(runtimeState = 'working') {
    const pendingEventCount = countPendingOutboxEvents(this.db);
    const pendingArtifacts = countPendingArtifacts(this.db);
    return this.api.heartbeat(this.sessionId, {
      workerId: this.options.workerId,
      runtimeState,
      lastLocalSequence: getState(this.db, 'checkpoint', { lastLocalSequence: 0 })?.lastLocalSequence || 0,
      lastAckedSequence: getState(this.db, 'checkpoint', { lastAckedSequence: 0 })?.lastAckedSequence || 0,
      pendingEventCount,
      pendingArtifactCount: pendingArtifacts.count,
      pendingArtifactBytes: pendingArtifacts.bytes,
    });
  }

  appendEvent(event) {
    const sequence = getState(this.db, 'checkpoint', { lastLocalSequence: 0 }).lastLocalSequence + 1;
    const record = appendOutboxEvent(this.db, {
      ...event,
      eventId: event.eventId || buildEventId(this.options.workerId, sequence, event.eventType, event.listingId || ''),
      sessionId: this.sessionId,
      workerId: this.options.workerId,
      workerType: event.workerType || this.options.workerType,
      strategy: event.strategy || this.options.strategy,
      sequence,
      eventAt: event.eventAt || new Date().toISOString(),
    });
    setState(this.db, 'checkpoint', {
      ...getState(this.db, 'checkpoint', {}),
      lastLocalSequence: record.sequence,
    });
    return record;
  }

  async uploadPendingEvents() {
    const events = listPendingOutboxEvents(this.db, {
      limit: 100,
    });
    if (events.length === 0) {
      return { accepted: [], duplicates: [] };
    }
    try {
      const result = await this.api.uploadEvents(this.sessionId, {
        workerId: this.options.workerId,
        batchId: `${this.options.workerId}:${Date.now().toString(36)}`,
        events,
      });
      const ackedIds = [
        ...(result.accepted || []).map((event) => event.eventId),
        ...(result.duplicates || []).map((event) => event.eventId),
      ];
      markOutboxEventsAcked(this.db, ackedIds);
      const checkpoint = getState(this.db, 'checkpoint', {});
      setState(this.db, 'checkpoint', {
        ...checkpoint,
        lastAckedSequence: result.checkpoint?.lastAcceptedSequence || checkpoint.lastAckedSequence || 0,
      });
      return result;
    } catch (error) {
      markOutboxEventsFailed(this.db, events.map((event) => event.eventId), error);
      throw error;
    }
  }

  appendArtifactManifest(manifest) {
    return appendArtifactManifest(this.db, {
      ...manifest,
      workerId: manifest.workerId || this.options.workerId,
      sessionId: manifest.sessionId || this.sessionId,
      storage: {
        requestedBackend: 'local_fs',
        uploadMode: 'metadata_only',
        ...(manifest.storage || {}),
      },
    });
  }

  async uploadPendingArtifacts() {
    const artifacts = listPendingArtifactManifests(this.db, {
      limit: this.options.artifactBatchSize,
    });
    if (artifacts.length === 0) {
      return { accepted: [], duplicates: [] };
    }
    const artifactIds = artifacts.map((artifact) => artifact.artifactId);
    try {
      const result = await this.api.uploadArtifacts(this.sessionId, {
        workerId: this.options.workerId,
        artifacts: artifacts.map((artifact) => artifact.manifest),
      });
      const ackedIds = [
        ...(result.accepted || []).map((artifact) => artifact.artifactId),
        ...(result.duplicates || []).map((artifact) => artifact.artifactId),
      ];
      markArtifactsAcked(this.db, ackedIds);
      return result;
    } catch (error) {
      markArtifactsFailed(this.db, artifactIds, error);
      throw error;
    }
  }

  async pollCommands() {
    const result = await this.api.pollCommands(this.sessionId, { limit: 25 });
    const commands = result.commands || [];
    for (const command of commands) {
      appendLocalCommand(this.db, command);
      if (command.commandType === 'drain') {
        this.drainRequested = true;
      }
      if (command.commandType === 'shutdown') {
        this.shutdownRequested = true;
      }
      if (command.commandType !== 'run_collector_once') {
        await this.api.ackCommand(this.sessionId, command.commandId, {
          status: 'acked',
          payload: {
            accepted: true,
          },
        });
      }
    }
    return commands;
  }

  async claimWork() {
    if (this.drainRequested || this.shutdownRequested) {
      return { claims: [], drainRequested: this.drainRequested };
    }
    const pendingArtifacts = countPendingArtifacts(this.db);
    if (pendingArtifacts.bytes > this.options.maxPendingArtifactBytes) {
      return {
        claims: [],
        backpressure: {
          reason: 'pending_artifact_bytes',
          pendingArtifactBytes: pendingArtifacts.bytes,
          maxPendingArtifactBytes: this.options.maxPendingArtifactBytes,
        },
      };
    }
    return this.api.claim(this.sessionId, {
      workerId: this.options.workerId,
      workerType: this.options.workerType,
      strategy: this.options.strategy,
      acceptedCommandTypes: ['index_resolved_listing_metadata_batch'],
      capacity: this.options.capacity,
      batchSize: this.options.batchSize,
      leaseSeconds: 180,
    });
  }


  collectorAdapterPaths(strategyOverride = '') {
    const baseDir = path.dirname(this.options.localDbPath);
    const strategy = String(strategyOverride || this.options.strategy || '');
    return {
      adapterDbPath: path.join(baseDir, collectorDbNameForStrategy(strategy)),
      logFile: path.join(baseDir, `${strategy}-collector.log`),
      snapshotFile: path.join(baseDir, `${strategy}-collector-latest-cycle.json`),
    };
  }

  async executeCollectorAdapterRun(overrides = {}) {
    const strategy = String(overrides.strategy || this.options.strategy || '');
    const script = collectorScriptForStrategy(strategy);
    const adapterRunId = String(overrides.adapterRunId || `${this.options.workerId}:collector:${Date.now().toString(36)}`);
    const paths = this.collectorAdapterPaths(strategy);
    await fs.promises.mkdir(path.dirname(paths.adapterDbPath), { recursive: true });
    const args = [
      script,
      ...stripManagedCollectorArgs(overrides.adapterArgs || this.options.adapterArgs),
      '--db-path', paths.adapterDbPath,
      '--worker-id', adapterRunId,
      '--log-file', paths.logFile,
      '--snapshot-file', paths.snapshotFile,
      '--once',
    ];
    const result = await runNodeScript(args);
    const replay = await this.replayCollectorAdapterRun(paths.adapterDbPath, adapterRunId, {
      workerType: overrides.workerType || 'collector',
      strategy,
    });
    await this.uploadPendingEvents();
    if (result.code !== 0) {
      const message = result.stderr.trim().split('\n').slice(-1)[0] || `collector adapter exited with code ${result.code}`;
      const error = new Error(message);
      error.exitCode = result.code;
      error.signal = result.signal;
      error.replay = replay;
      throw error;
    }
    return {
      adapterRunId,
      adapterDbPath: paths.adapterDbPath,
      replay,
      exitCode: result.code,
      signal: result.signal || '',
    };
  }

  async replayCollectorAdapterRun(adapterDbPath, adapterRunId, context = {}) {
    const { workflowEvents, listingEvents } = readCollectorRunEvents(adapterDbPath, adapterRunId);
    const replayWorkerType = context.workerType || 'collector';
    const replayStrategy = context.strategy || this.options.strategy;
    for (const event of workflowEvents) {
      this.appendEvent({
        eventId: `${this.options.workerId}:remote:${event.eventId}`,
        workerType: replayWorkerType,
        strategy: replayStrategy,
        eventScope: 'workflow',
        eventType: event.eventType,
        eventAt: event.eventAt,
        status: event.status,
        payload: event.payload,
        error: event.error,
      });
    }
    for (const event of listingEvents) {
      this.appendEvent({
        eventId: `${this.options.workerId}:remote:${event.eventId}`,
        workerType: replayWorkerType,
        strategy: replayStrategy,
        eventScope: 'listing',
        eventType: event.eventType,
        eventAt: event.eventAt,
        listingId: event.listingId,
        status: event.status,
        payload: event.payload,
        error: event.error,
      });
    }
    return {
      workflowEvents: workflowEvents.length,
      listingEvents: listingEvents.length,
    };
  }

  executeBacklogIndexerClaim(claim) {
    const startedAt = new Date().toISOString();
    this.appendEvent({
      eventScope: 'workflow',
      eventType: 'backlog_index_started',
      status: 'running',
      payload: {
        strategy: this.options.strategy,
        claimId: claim.claimId,
        commandId: claim.commandId,
        leaseId: claim.leaseId,
        limit: claim.payload?.items?.length || 0,
      },
      eventAt: startedAt,
    });

    let indexed = 0;
    let skipped = 0;
    for (const item of claim.payload?.items || []) {
      const listedAgo = String(item.detailListedAgo || '').trim();
      const anchor = item.resolvedAt || item.firstSeenAt || item.lastSeenAt || startedAt;
      const range = listedAgo ? listedAgoToUnixRange(listedAgo, anchor) : null;
      if (!listedAgo || !range) {
        skipped += 1;
        this.appendEvent({
          eventScope: 'listing',
          eventType: 'backlog_listing_metadata_skipped',
          listingId: item.listingId,
          status: 'skipped',
          payload: {
            listingId: item.listingId,
            reason: listedAgo ? 'unparsed_detail_listed_ago' : 'missing_detail_listed_ago',
            indexerVersion: claim.payload?.indexerVersion || 'resolved-metadata-v1',
            claimId: claim.claimId,
            commandId: claim.commandId,
            leaseId: claim.leaseId,
          },
        });
        continue;
      }
      indexed += 1;
      this.appendEvent({
        eventScope: 'listing',
        eventType: 'backlog_listing_metadata_indexed',
        listingId: item.listingId,
        status: 'done',
        payload: {
          listingId: item.listingId,
          indexerVersion: claim.payload?.indexerVersion || 'resolved-metadata-v1',
          detailListedAgo: listedAgo,
          listedAtMin: isoFromUnix(range.earliestUnix),
          listedAtMax: isoFromUnix(range.latestUnix),
          listedAtEarliestUnix: range.earliestUnix,
          listedAtLatestUnix: range.latestUnix,
          listedAtAnchorUnix: range.anchorUnix,
          language: range.language,
          unit: range.unit,
          value: range.value,
          confidence: range.confidence,
          sourceFields: ['detailListedAgo', 'resolvedAt'],
          claimId: claim.claimId,
          commandId: claim.commandId,
          leaseId: claim.leaseId,
        },
      });
    }

    this.appendEvent({
      eventScope: 'workflow',
      eventType: 'backlog_index_completed',
      status: 'completed',
      payload: {
        strategy: this.options.strategy,
        claimId: claim.claimId,
        commandId: claim.commandId,
        leaseId: claim.leaseId,
        processedCount: indexed + skipped,
        normalized: indexed,
        skipped,
      },
    });
    return {
      indexed,
      skipped,
      processedCount: indexed + skipped,
    };
  }

  async executeCollectorCommand(command) {
    const payload = command.payload || {};
    const strategy = String(payload.strategy || '').trim();
    const adapterArgs = Array.isArray(payload.adapterArgs) ? payload.adapterArgs : [];
    if (!['feed', 'explorer', 'goofish_search'].includes(strategy)) {
      await this.api.ackCommand(this.sessionId, command.commandId, {
        status: 'failed',
        error: `Unsupported collector strategy: ${strategy || '(empty)'}`,
      });
      return { failed: true, commandId: command.commandId };
    }
    try {
      await this.sendHeartbeat('working');
      const result = await this.executeCollectorAdapterRun({
        strategy,
        adapterArgs,
        adapterRunId: `${this.options.workerId}:command:${command.commandId}`,
      });
      await this.uploadPendingEvents();
      await this.uploadPendingArtifacts();
      await this.api.ackCommand(this.sessionId, command.commandId, {
        status: 'completed',
        payload: {
          accepted: true,
          workflowId: payload.workflowId || '',
          strategy,
          adapterRunId: result.adapterRunId,
          replay: result.replay,
        },
      });
      return result;
    } catch (error) {
      await this.uploadPendingEvents().catch(() => null);
      await this.api.ackCommand(this.sessionId, command.commandId, {
        status: 'failed',
        error: error.message || String(error),
        payload: {
          workflowId: payload.workflowId || '',
          strategy,
          exitCode: error.exitCode ?? null,
          signal: error.signal || '',
          replay: error.replay || null,
        },
      });
      return { failed: true, commandId: command.commandId, error: error.message || String(error) };
    }
  }

  async executeClaim(claim) {
    if (claim.commandType !== 'index_resolved_listing_metadata_batch') {
      await this.api.completeLease(this.sessionId, claim.leaseId, {
        status: 'failed',
        error: `Unsupported command type: ${claim.commandType}`,
      });
      return { processedCount: 0, failed: true };
    }
    const result = this.executeBacklogIndexerClaim(claim);
    await this.uploadPendingEvents();
    await this.api.completeLease(this.sessionId, claim.leaseId, {
      status: 'completed',
      result,
    });
    return result;
  }

  async runOnce() {
    await this.registerSession();
    await this.sendHeartbeat('starting');
    await this.uploadPendingEvents();
    await this.uploadPendingArtifacts();
    const commands = await this.pollCommands();
    const collectorCommands = commands.filter((command) => command.commandType === 'run_collector_once');
    const commandResults = [];
    for (const command of collectorCommands) {
      commandResults.push(await this.executeCollectorCommand(command));
    }
    if (collectorCommands.length > 0) {
      await this.sendHeartbeat(this.shutdownRequested ? 'stopping' : 'idle');
      return {
        sessionId: this.sessionId,
        commands,
        commandResults,
        claims: [],
        claimResults: [],
        drainRequested: this.drainRequested,
        backpressure: null,
      };
    }
    if (isCollectorRuntime(this.options)) {
      const collectorResult = await this.executeCollectorAdapterRun();
      await this.sendHeartbeat(this.shutdownRequested ? 'stopping' : 'idle');
      return {
        sessionId: this.sessionId,
        commands,
        claims: [],
        claimResults: [],
        commandResults,
        collectorResult,
        drainRequested: this.drainRequested,
        backpressure: null,
      };
    }
    const claimsResult = await this.claimWork();
    const claimResults = [];
    for (const claim of claimsResult.claims || []) {
      claimResults.push(await this.executeClaim(claim));
    }
    await this.sendHeartbeat(this.shutdownRequested ? 'stopping' : 'idle');
    return {
      sessionId: this.sessionId,
      commands,
      claims: claimsResult.claims || [],
      commandResults,
      claimResults,
      drainRequested: this.drainRequested || claimsResult.drainRequested === true,
      backpressure: claimsResult.backpressure || null,
    };
  }

  async runContinuous() {
    await this.registerSession();
    while (!this.shutdownRequested) {
      await this.runOnce();
      if (this.options.once) break;
      await new Promise((resolve) => setTimeout(resolve, this.options.pollIntervalMs));
    }
    return {
      sessionId: this.sessionId,
      stopped: true,
    };
  }
}

async function run(options) {
  const runtime = new RemoteWorkerRuntime(options);
  try {
    return await (options.once ? runtime.runOnce() : runtime.runContinuous());
  } finally {
    runtime.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await run(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`remote_worker_runtime_done session=${result.sessionId} claims=${result.claims?.length || 0}\n`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  loadWorkerToken,
  RemoteWorkerRuntime,
  collectorDbNameForStrategy,
  collectorScriptForStrategy,
  isCollectorRuntime,
  run,
};
