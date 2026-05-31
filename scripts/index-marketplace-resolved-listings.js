const {
  DEFAULT_DB_PATH,
  openMarketplaceHomepageDatabase,
  closeMarketplaceHomepageDatabase,
  normalizeHomepageListedTimeRanges,
  appendWorkflowEvent,
} = require('./marketplace-homepage-db');

function readFlagValue(argv, index, flagName) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flagName}`);
  }
  return value;
}

function parseInteger(value, flagName, minimum = 0) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new Error(`Expected ${flagName} to be an integer >= ${minimum}`);
  }
  return parsed;
}

function parseNumber(value, flagName, minimum = 0) {
  const parsed = Number(String(value));
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new Error(`Expected ${flagName} to be a number >= ${minimum}`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = {
    dbPath: DEFAULT_DB_PATH,
    limit: 250,
    staleOnly: true,
    once: false,
    pollIntervalSeconds: 300,
    pollJitterMin: 0.8,
    pollJitterMax: 1.2,
    workerId: '',
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--db-path':
        options.dbPath = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--limit':
        options.limit = parseInteger(readFlagValue(argv, index, arg), arg, 1);
        index += 1;
        break;
      case '--all':
        options.staleOnly = false;
        break;
      case '--once':
        options.once = true;
        break;
      case '--poll-interval-seconds':
        options.pollIntervalSeconds = parseNumber(readFlagValue(argv, index, arg), arg, 1);
        index += 1;
        break;
      case '--poll-jitter-min':
        options.pollJitterMin = parseNumber(readFlagValue(argv, index, arg), arg, 0);
        index += 1;
        break;
      case '--poll-jitter-max':
        options.pollJitterMax = parseNumber(readFlagValue(argv, index, arg), arg, 0);
        index += 1;
        break;
      case '--worker-id':
        options.workerId = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--json':
        options.json = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.pollJitterMax < options.pollJitterMin) {
    throw new Error('Expected --poll-jitter-max to be >= --poll-jitter-min');
  }

  return options;
}

function nowIso() {
  return new Date().toISOString();
}

function log(message) {
  process.stdout.write(`[${nowIso()}] ${message}\n`);
}

function workerRunId(options) {
  return String(options.workerId || `backlog-indexer-${Date.now()}`).trim();
}

function appendIndexerEvent(db, runId, eventType, event = {}) {
  try {
    return appendWorkflowEvent(db, {
      workflowRunId: runId,
      eventType,
      status: event.status || '',
      content: {
        workerType: 'backlog_indexer',
        strategy: 'resolved_metadata',
        ...(event.content || {}),
      },
      error: event.error instanceof Error ? event.error.message : String(event.error || ''),
    });
  } catch (error) {
    log(`indexer_event_append_failed type=${eventType} error=${error.message}`);
    return null;
  }
}

function computeJitteredPollMs(options) {
  const multiplier = options.pollJitterMin + (Math.random() * (options.pollJitterMax - options.pollJitterMin));
  return {
    waitMs: Math.ceil(options.pollIntervalSeconds * multiplier * 1000),
    multiplier,
  };
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function runIndexCycle(db, options, runId) {
  appendIndexerEvent(db, runId, 'backlog_index_started', {
    status: 'running',
    content: {
      strategy: 'resolved_metadata',
      limit: options.limit,
      staleOnly: options.staleOnly,
    },
  });
  const summary = normalizeHomepageListedTimeRanges(db, {
    limit: options.limit,
    staleOnly: options.staleOnly,
  });
  const processedCount = (summary.normalized || 0) + (summary.unparsed || 0);
  appendIndexerEvent(db, runId, 'backlog_index_completed', {
    status: 'completed',
    content: {
      strategy: 'resolved_metadata',
      processedCount,
      ...summary,
    },
  });
  log(`index_done scanned=${summary.scanned} normalized=${summary.normalized} unparsed=${summary.unparsed} skipped=${summary.skipped} missing=${summary.missing}`);
  return summary;
}

async function run(options) {
  const runId = workerRunId(options);
  const { db } = openMarketplaceHomepageDatabase(options.dbPath);
  const lifecycle = { shutdownRequested: false, signal: '' };

  const handleSignal = (signal) => {
    if (lifecycle.shutdownRequested) return;
    lifecycle.shutdownRequested = true;
    lifecycle.signal = signal;
    appendIndexerEvent(db, runId, 'shutdown_requested', {
      status: 'stopping',
      content: { signal },
    });
  };
  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);

  try {
    appendIndexerEvent(db, runId, 'worker_started', {
      status: 'running',
      content: {
        workerType: 'backlog_indexer',
        strategy: 'resolved_metadata',
        mode: options.once ? 'once' : 'continuous',
        args: process.argv.slice(2),
      },
    });
    log(`indexer_start db_path=${options.dbPath} mode=${options.once ? 'once' : 'continuous'} limit=${options.limit} stale_only=${options.staleOnly} poll_interval_seconds=${options.pollIntervalSeconds} worker_id=${runId}`);

    do {
      runIndexCycle(db, options, runId);
      if (options.once || lifecycle.shutdownRequested) {
        break;
      }
      const wait = computeJitteredPollMs(options);
      appendIndexerEvent(db, runId, 'worker_sleeping', {
        status: 'sleeping',
        content: {
          seconds: Math.ceil(wait.waitMs / 1000),
          reason: 'poll_interval',
          jitterMultiplier: Number(wait.multiplier.toFixed(3)),
        },
      });
      log(`indexer_sleep seconds=${Math.ceil(wait.waitMs / 1000)} jitter_multiplier=${wait.multiplier.toFixed(3)}`);
      await sleep(wait.waitMs);
    } while (!lifecycle.shutdownRequested);

    appendIndexerEvent(db, runId, 'worker_completed', {
      status: lifecycle.shutdownRequested ? 'stopped' : 'completed',
      content: {
        reason: lifecycle.shutdownRequested ? `signal:${lifecycle.signal}` : 'completed',
      },
    });
  } catch (error) {
    appendIndexerEvent(db, runId, 'backlog_index_failed', {
      status: 'error',
      content: {
        strategy: 'resolved_metadata',
        reason: error.message,
      },
      error,
    });
    appendIndexerEvent(db, runId, 'worker_failed', {
      status: 'error',
      content: { reason: error.message },
      error,
    });
    throw error;
  } finally {
    closeMarketplaceHomepageDatabase(db);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await run(options);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  runIndexCycle,
  run,
};
