const fs = require('fs');
const path = require('path');
const http = require('http');
const { URL } = require('url');
const { spawn } = require('child_process');

const {
  DEFAULT_DB_PATH,
  openMarketplaceHomepageDatabase,
  closeMarketplaceHomepageDatabase,
  getHomepageListingCounts,
  insertWorkflowRun,
  updateWorkflowRun,
  getWorkflowRun,
  listWorkflowRuns,
  resolveWorkerEventIdsForRun,
  listWorkerListingEvents,
  getWorkerListingEventStats,
} = require('./marketplace-homepage-db');
const {
  buildListingsQuery,
  buildListingIdsQuery,
  buildCountQuery,
} = require('./marketplace-homepage-query');

const FRONTEND_DIR = path.join(process.cwd(), 'frontend', 'marketplace-monitor');
const RESOLVE_BATCH_DIR = path.join(process.cwd(), 'artifacts', 'marketplace-homepage', 'resolve-batches');
const BACKLOG_STATUSES = new Set(['pending', 'error', 'processing']);

function readFlagValue(argv, index, flagName) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flagName}`);
  }

  return value;
}

function parseIntegerFlag(value, flagName, minimum = 0) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new Error(`Expected ${flagName} to be an integer >= ${minimum}`);
  }

  return parsed;
}

function parseArgs(argv) {
  const options = {
    host: '127.0.0.1',
    port: 3080,
    dbPath: DEFAULT_DB_PATH,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--host':
        options.host = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--port':
        options.port = parseIntegerFlag(readFlagValue(argv, index, arg), arg, 1);
        index += 1;
        break;
      case '--db-path':
        options.dbPath = readFlagValue(argv, index, arg);
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

const WORKFLOWS = {
  'home-collect': {
    label: 'Homepage Collector',
    script: 'marketplace:home:collect',
    fields: [
      { id: 'useCredentials', label: 'Use credentials', kind: 'boolean', flag: '--use-credentials', defaultValue: true },
      {
        id: 'browserMode',
        label: 'Browser mode',
        kind: 'choice',
        defaultValue: 'headless',
        options: [
          { value: 'headless', label: 'Headless', args: ['--headless'] },
          { value: 'headed', label: 'Headed', args: ['--headed'] },
        ],
      },
      { id: 'collectAll', label: 'Collect all visible rows', kind: 'boolean', flag: '--collect-all', defaultValue: true },
      { id: 'location', label: 'Location', kind: 'text', flag: '--location', defaultValue: '' },
      { id: 'radiusMiles', label: 'Radius miles', kind: 'number', flag: '--radius-miles', defaultValue: '', min: 1 },
      { id: 'refreshSeconds', label: 'Refresh seconds', kind: 'number', flag: '--refresh-seconds', defaultValue: 30, min: 1 },
      { id: 'refreshJitterMin', label: 'Refresh jitter min', kind: 'number', flag: '--refresh-jitter-min', defaultValue: 0.5, min: 0, step: 0.1 },
      { id: 'refreshJitterMax', label: 'Refresh jitter max', kind: 'number', flag: '--refresh-jitter-max', defaultValue: 1.5, min: 0, step: 0.1 },
      { id: 'maxRuntimeSeconds', label: 'Max runtime seconds', kind: 'number', flag: '--max-runtime-seconds', defaultValue: 120, min: 1 },
      { id: 'once', label: 'Run once', kind: 'boolean', flag: '--once', defaultValue: false },
    ],
  },
  'search-explore': {
    label: 'Search Explorer',
    script: 'marketplace:search:explore',
    fields: [
      { id: 'useCredentials', label: 'Use credentials', kind: 'boolean', flag: '--use-credentials', defaultValue: true },
      {
        id: 'browserMode',
        label: 'Browser mode',
        kind: 'choice',
        defaultValue: 'headless',
        options: [
          { value: 'headless', label: 'Headless', args: ['--headless'] },
          { value: 'headed', label: 'Headed', args: ['--headed'] },
        ],
      },
      { id: 'query', label: 'Search query', kind: 'text', flag: '--query', defaultValue: 'pentax' },
      { id: 'location', label: 'Location', kind: 'text', flag: '--location', defaultValue: '' },
      { id: 'radiusMiles', label: 'Radius miles', kind: 'number', flag: '--radius-miles', defaultValue: '', min: 1 },
      { id: 'collectAll', label: 'Collect all visible rows', kind: 'boolean', flag: '--collect-all', defaultValue: true },
      { id: 'refreshSeconds', label: 'Refresh seconds', kind: 'number', flag: '--refresh-seconds', defaultValue: 30, min: 1 },
      { id: 'refreshJitterMin', label: 'Refresh jitter min', kind: 'number', flag: '--refresh-jitter-min', defaultValue: 0.5, min: 0, step: 0.1 },
      { id: 'refreshJitterMax', label: 'Refresh jitter max', kind: 'number', flag: '--refresh-jitter-max', defaultValue: 1.5, min: 0, step: 0.1 },
      { id: 'maxRuntimeSeconds', label: 'Max runtime seconds', kind: 'number', flag: '--max-runtime-seconds', defaultValue: 120, min: 1 },
      { id: 'once', label: 'Run once', kind: 'boolean', flag: '--once', defaultValue: false },
    ],
  },
  'backlog-resolve': {
    label: 'Resolve Pending Backlog',
    script: 'marketplace:home:process',
    fields: [
      { id: 'useCredentials', label: 'Use credentials', kind: 'boolean', flag: '--use-credentials', defaultValue: true },
      {
        id: 'browserMode',
        label: 'Browser mode',
        kind: 'choice',
        defaultValue: 'headless',
        options: [
          { value: 'headless', label: 'Headless', args: ['--headless'] },
          { value: 'headed', label: 'Headed', args: ['--headed'] },
        ],
      },
      { id: 'drain', label: 'Drain eligible backlog then exit', kind: 'boolean', flag: '--drain', defaultValue: true },
      { id: 'batchSize', label: 'Batch size', kind: 'number', flag: '--batch-size', defaultValue: 5, min: 1 },
      { id: 'limit', label: 'Max items for this run', kind: 'number', flag: '--limit', defaultValue: 50, min: 0 },
      {
        id: 'statusFilter',
        label: 'Queue status',
        kind: 'choice',
        defaultValue: 'pending',
        options: [
          { value: 'pending', label: 'Pending only', args: ['--status-filter', 'pending'] },
          { value: 'all', label: 'All eligible', args: ['--status-filter', 'all'] },
          { value: 'error', label: 'Retry errors', args: ['--status-filter', 'error'] },
          { value: 'processing', label: 'Stale processing', args: ['--status-filter', 'processing'] },
          { value: 'sold', label: 'Sold rows', args: ['--status-filter', 'sold'] },
          { value: 'pending_sale', label: 'Pending-sale rows', args: ['--status-filter', 'pending_sale'] },
        ],
      },
      {
        id: 'sourceFilter',
        label: 'Source',
        kind: 'choice',
        defaultValue: '',
        options: [
          { value: '', label: 'All sources', args: [] },
          { value: 'homepage', label: 'Homepage', args: ['--source-filter', 'homepage'] },
          { value: 'search', label: 'Search', args: ['--source-filter', 'search'] },
        ],
      },
      { id: 'keywordFilter', label: 'Keyword filter', kind: 'text', flag: '--keyword-filter', defaultValue: '' },
      {
        id: 'backlogOrder',
        label: 'Backlog start',
        kind: 'choice',
        defaultValue: 'priority',
        options: [
          { value: 'priority', label: 'Priority index', args: ['--backlog-order', 'priority'] },
          { value: 'rank', label: 'Rank index', args: ['--backlog-order', 'rank'] },
          { value: 'latest', label: 'Latest first', args: ['--backlog-order', 'latest'] },
          { value: 'earliest', label: 'Earliest first', args: ['--backlog-order', 'earliest'] },
        ],
      },
      {
        id: 'seenTimeField',
        label: 'Time index',
        kind: 'choice',
        defaultValue: 'last_seen',
        options: [
          { value: 'last_seen', label: 'Last seen', args: ['--seen-time-field', 'last_seen'] },
          { value: 'first_seen', label: 'First seen', args: ['--seen-time-field', 'first_seen'] },
        ],
      },
      { id: 'seenAfter', label: 'Seen after', kind: 'text', flag: '--seen-after', defaultValue: '' },
      { id: 'seenBefore', label: 'Seen before', kind: 'text', flag: '--seen-before', defaultValue: '' },
      { id: 'maxAttempts', label: 'Max attempts', kind: 'number', flag: '--max-attempts', defaultValue: 5, min: 1 },
      { id: 'retryDelaySeconds', label: 'Retry delay seconds', kind: 'number', flag: '--retry-delay-seconds', defaultValue: 300, min: 0 },
      { id: 'itemDelaySeconds', label: 'Delay between items', kind: 'number', flag: '--item-delay-seconds', defaultValue: 8, min: 0, step: 0.5 },
      { id: 'itemJitterMin', label: 'Item jitter min', kind: 'number', flag: '--item-jitter-min', defaultValue: 0.5, min: 0, step: 0.1 },
      { id: 'itemJitterMax', label: 'Item jitter max', kind: 'number', flag: '--item-jitter-max', defaultValue: 1.5, min: 0, step: 0.1 },
      { id: 'resolveInactive', label: 'Resolve sold/pending signals', kind: 'boolean', flag: '--resolve-inactive', defaultValue: false },
      { id: 'workerId', label: 'Worker ID', kind: 'text', flag: '--worker-id', defaultValue: '' },
    ],
  },
  'backlog-worker': {
    label: 'Continuous Backlog Worker',
    script: 'marketplace:home:process',
    fields: [
      { id: 'useCredentials', label: 'Use credentials', kind: 'boolean', flag: '--use-credentials', defaultValue: true },
      {
        id: 'browserMode',
        label: 'Browser mode',
        kind: 'choice',
        defaultValue: 'headless',
        options: [
          { value: 'headless', label: 'Headless', args: ['--headless'] },
          { value: 'headed', label: 'Headed', args: ['--headed'] },
        ],
      },
      { id: 'batchSize', label: 'Batch size', kind: 'number', flag: '--batch-size', defaultValue: 1, min: 1 },
      { id: 'pollIntervalSeconds', label: 'Poll interval seconds', kind: 'number', flag: '--poll-interval-seconds', defaultValue: 30, min: 1 },
      { id: 'pollJitterMin', label: 'Poll jitter min', kind: 'number', flag: '--poll-jitter-min', defaultValue: 0.5, min: 0, step: 0.1 },
      { id: 'pollJitterMax', label: 'Poll jitter max', kind: 'number', flag: '--poll-jitter-max', defaultValue: 1.5, min: 0, step: 0.1 },
      { id: 'limit', label: 'Limit', kind: 'number', flag: '--limit', defaultValue: '', min: 0 },
      {
        id: 'statusFilter',
        label: 'Queue status',
        kind: 'choice',
        defaultValue: 'pending',
        options: [
          { value: 'pending', label: 'Pending only', args: ['--status-filter', 'pending'] },
          { value: 'all', label: 'All eligible', args: ['--status-filter', 'all'] },
          { value: 'error', label: 'Retry errors', args: ['--status-filter', 'error'] },
          { value: 'processing', label: 'Stale processing', args: ['--status-filter', 'processing'] },
          { value: 'sold', label: 'Sold rows', args: ['--status-filter', 'sold'] },
          { value: 'pending_sale', label: 'Pending-sale rows', args: ['--status-filter', 'pending_sale'] },
        ],
      },
      {
        id: 'sourceFilter',
        label: 'Source',
        kind: 'choice',
        defaultValue: '',
        options: [
          { value: '', label: 'All sources', args: [] },
          { value: 'homepage', label: 'Homepage', args: ['--source-filter', 'homepage'] },
          { value: 'search', label: 'Search', args: ['--source-filter', 'search'] },
        ],
      },
      { id: 'keywordFilter', label: 'Keyword filter', kind: 'text', flag: '--keyword-filter', defaultValue: '' },
      {
        id: 'backlogOrder',
        label: 'Backlog start',
        kind: 'choice',
        defaultValue: 'priority',
        options: [
          { value: 'priority', label: 'Priority index', args: ['--backlog-order', 'priority'] },
          { value: 'rank', label: 'Rank index', args: ['--backlog-order', 'rank'] },
          { value: 'latest', label: 'Latest first', args: ['--backlog-order', 'latest'] },
          { value: 'earliest', label: 'Earliest first', args: ['--backlog-order', 'earliest'] },
        ],
      },
      {
        id: 'seenTimeField',
        label: 'Time index',
        kind: 'choice',
        defaultValue: 'last_seen',
        options: [
          { value: 'last_seen', label: 'Last seen', args: ['--seen-time-field', 'last_seen'] },
          { value: 'first_seen', label: 'First seen', args: ['--seen-time-field', 'first_seen'] },
        ],
      },
      { id: 'seenAfter', label: 'Seen after', kind: 'text', flag: '--seen-after', defaultValue: '' },
      { id: 'seenBefore', label: 'Seen before', kind: 'text', flag: '--seen-before', defaultValue: '' },
      { id: 'maxAttempts', label: 'Max attempts', kind: 'number', flag: '--max-attempts', defaultValue: 5, min: 1 },
      { id: 'retryDelaySeconds', label: 'Retry delay seconds', kind: 'number', flag: '--retry-delay-seconds', defaultValue: 300, min: 0 },
      { id: 'itemDelaySeconds', label: 'Delay between items', kind: 'number', flag: '--item-delay-seconds', defaultValue: 8, min: 0, step: 0.5 },
      { id: 'itemJitterMin', label: 'Item jitter min', kind: 'number', flag: '--item-jitter-min', defaultValue: 0.5, min: 0, step: 0.1 },
      { id: 'itemJitterMax', label: 'Item jitter max', kind: 'number', flag: '--item-jitter-max', defaultValue: 1.5, min: 0, step: 0.1 },
      { id: 'resolveInactive', label: 'Resolve sold/pending signals', kind: 'boolean', flag: '--resolve-inactive', defaultValue: false },
      { id: 'workerId', label: 'Worker ID', kind: 'text', flag: '--worker-id', defaultValue: '' },
      { id: 'once', label: 'Run once', kind: 'boolean', flag: '--once', defaultValue: false },
    ],
  },
};

const QUERY_FIELDS = [
  { value: 'id', label: 'Listing ID', type: 'text' },
  { value: 'status', label: 'Status', type: 'enum', values: ['pending', 'processing', 'done', 'error', 'sold', 'pending_sale'] },
  { value: 'title', label: 'Title', type: 'text' },
  { value: 'text', label: 'Card/detail text', type: 'text' },
  { value: 'seller', label: 'Seller', type: 'text' },
  { value: 'location', label: 'Location', type: 'text' },
  { value: 'condition', label: 'Condition', type: 'text' },
  { value: 'source', label: 'Source', type: 'enum', values: ['homepage', 'search'] },
  { value: 'keyword', label: 'Source keyword', type: 'text' },
  { value: 'price', label: 'Price', type: 'number' },
  { value: 'rank', label: 'Rank', type: 'number' },
  { value: 'attempts', label: 'Attempts', type: 'number' },
  { value: 'before', label: 'Seen before', type: 'date' },
  { value: 'after', label: 'Seen after', type: 'date' },
];

const managedProcesses = new Map();

function buildDefaultArgsFromFields(fields = []) {
  const args = [];
  for (const field of fields) {
    if (field.kind === 'boolean') {
      if (field.defaultValue && field.flag) {
        args.push(field.flag);
      }
      continue;
    }

    if (field.kind === 'choice') {
      const option = (field.options || []).find((item) => item.value === field.defaultValue);
      args.push(...(option?.args || []));
      continue;
    }

    if (field.defaultValue !== undefined && field.defaultValue !== '') {
      args.push(field.flag, String(field.defaultValue));
    }
  }
  return args;
}

function nowIso() {
  return new Date().toISOString();
}

function isManagedStatusActive(status) {
  return status === 'starting' || status === 'running' || status === 'stopping';
}

function pidIsAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function appendProcessLog(record, chunk) {
  const text = String(chunk || '');
  if (!text) {
    return;
  }

  record.logs.push(...text.split(/\r?\n/).filter(Boolean).map((line) => `[${nowIso()}] ${line}`));
  if (record.logs.length > 400) {
    record.logs.splice(0, record.logs.length - 400);
  }
}

function buildManagedProcessRecord(workflowId, args) {
  const workflow = WORKFLOWS[workflowId];
  const id = `${workflowId}-${Date.now()}`;
  return {
    id,
    workflowId,
    label: workflow.label,
    script: workflow.script,
    args,
    pid: null,
    status: 'starting',
    startedAt: nowIso(),
    exitedAt: '',
    exitCode: null,
    signal: '',
    logs: [],
    child: null,
  };
}

function syncWorkflowRun(db, record, changes = {}) {
  updateWorkflowRun(db, record.id, {
    workflowId: record.workflowId,
    label: record.label,
    script: record.script,
    args: record.args,
    pid: record.pid,
    status: record.status,
    exitedAt: record.exitedAt,
    exitCode: record.exitCode,
    signal: record.signal,
    osAlive: pidIsAlive(record.pid),
    logs: record.logs,
    ...changes,
  });
}

function publicProcessRecord(record) {
  const logs = record.logs || [];
  return {
    id: record.id,
    workflowId: record.workflowId,
    label: record.label,
    script: record.script,
    args: record.args,
    pid: record.pid,
    status: record.status,
    startedAt: record.startedAt,
    exitedAt: record.exitedAt,
    exitCode: record.exitCode,
    signal: record.signal,
    osCheckedAt: record.osCheckedAt || '',
    osAlive: Boolean(record.osAlive),
    managed: record.managed !== false,
    runtimeStats: runtimeStatsFromLogs(logs),
    latestAction: latestActionFromLogs(logs),
    failureSummary: failureSummaryFromLogs(logs),
    logCount: logs.length,
  };
}

function publicWorkflowRunRecord(run, options = {}) {
  const logs = run.logs || [];
  return {
    id: run.run_id,
    workflowId: run.workflow_id,
    label: run.label,
    script: run.script,
    args: run.args,
    pid: run.pid,
    status: run.status,
    startedAt: run.started_at,
    exitedAt: run.exited_at,
    exitCode: run.exit_code,
    signal: run.signal,
    osCheckedAt: run.os_checked_at,
    osAlive: run.os_alive,
    managed: managedProcesses.has(run.run_id),
    runtimeStats: runtimeStatsFromLogs(logs),
    latestAction: latestActionFromLogs(logs),
    failureSummary: failureSummaryFromLogs(logs),
    logCount: logs.length,
    ...(options.includeLogs ? { logs: logs.slice(-120) } : {}),
  };
}

function publicWorkflowRunRecordWithStats(db, run, options = {}) {
  const record = publicWorkflowRunRecord(run, options);
  const workerIds = resolveWorkerEventIdsForRun(db, run.run_id);
  const eventStats = getWorkerListingEventStats(db, run.run_id, { workerIds });
  record.eventStats = options.includeLatestEvents
    ? eventStats
    : {
      total: eventStats.total,
      done: eventStats.done,
      skipped: eventStats.skipped,
      error: eventStats.error,
      started: eventStats.started,
      workerIds: eventStats.workerIds,
    };
  return record;
}

function stripLogPrefix(line) {
  return String(line || '').replace(/^\[[^\]]+\]\s*/, '').replace(/^\[[^\]]+\]\s*/, '');
}

function latestActionFromLogs(logs = []) {
  return logs.slice().reverse().find((line) => /job_start|job_done|job_error|job_bypassed|backlog_sleep|backlog_item_sleep|backlog_exit/.test(line))
    || logs[logs.length - 1]
    || '';
}

function failureSummaryFromLogs(logs = []) {
  const line = logs.slice().reverse().find((item) => /process_marketplace_homepage_backlog_error|error/i.test(item)
    && !/process_exit|npm error|^\[[^\]]+\]\s*>/.test(item));
  return stripLogPrefix(line || '').replace(/^process_marketplace_homepage_backlog_error\s+/, '').trim();
}

function runtimeStatsFromLogs(logs = []) {
  const stats = { attempted: 0, done: 0, bypassed: 0, errors: 0, sleeps: 0, currentListingId: '' };
  for (const line of logs) {
    const listingMatch = line.match(/listing_id=([^\s]+)/);
    if (/job_start/.test(line)) {
      stats.attempted += 1;
      stats.currentListingId = listingMatch?.[1] || stats.currentListingId;
    } else if (/job_done/.test(line)) {
      stats.done += 1;
      stats.currentListingId = '';
    } else if (/job_bypassed/.test(line)) {
      stats.bypassed += 1;
      stats.currentListingId = '';
    } else if (/job_error/.test(line)) {
      stats.errors += 1;
      stats.currentListingId = '';
    } else if (/backlog_sleep|backlog_item_sleep/.test(line)) {
      stats.sleeps += 1;
    }
  }
  return stats;
}

function reconcileWorkflowRuns(db) {
  const now = nowIso();
  const runs = listWorkflowRuns(db, { limit: 50 });
  for (const run of runs) {
    const active = isManagedStatusActive(run.status);
    const alive = pidIsAlive(run.pid);
    const managed = managedProcesses.get(run.run_id);

    if (managed) {
      managed.osAlive = alive;
      managed.osCheckedAt = now;
      syncWorkflowRun(db, managed, { osCheckedAt: now, osAlive: alive });
      continue;
    }

    if (active && !alive) {
      updateWorkflowRun(db, run.run_id, {
        status: 'lost',
        exitedAt: now,
        osCheckedAt: now,
        osAlive: false,
      });
    } else {
      updateWorkflowRun(db, run.run_id, {
        osCheckedAt: now,
        osAlive: alive,
      });
    }
  }

  return listWorkflowRuns(db, { limit: 50 }).map((run) => publicWorkflowRunRecordWithStats(db, run));
}

function listManagedProcesses(db) {
  return reconcileWorkflowRuns(db);
}

function getRunningManagedProcesses(db) {
  const runs = reconcileWorkflowRuns(db);
  return runs.filter((record) => isManagedStatusActive(record.status) && (record.osAlive || record.managed));
}

function ensureManagedWorkerIdArg(args, runId, workflow) {
  if (workflow.script !== 'marketplace:home:process') {
    return args;
  }

  if (args.includes('--worker-id')) {
    return args;
  }

  return [...args, '--worker-id', runId];
}

function normalizeWorkflowArgs(value) {
  if (Array.isArray(value)) {
    return value.map((arg) => String(arg)).filter(Boolean);
  }

  if (typeof value !== 'string') {
    return [];
  }

  return value.match(/(?:[^\s"]+|"[^"]*")+/g)
    ?.map((arg) => arg.replace(/^"|"$/g, ''))
    .filter(Boolean) || [];
}

function normalizeListingIds(value) {
  const source = Array.isArray(value) ? value : [value];
  return [...new Set(source
    .flatMap((item) => String(item || '').split(','))
    .map((item) => item.trim())
    .filter(Boolean))];
}

function placeholdersFor(values) {
  return values.map(() => '?').join(', ');
}

function getBacklogListingIdsByIds(db, listingIds) {
  const ids = normalizeListingIds(listingIds);
  if (ids.length === 0) {
    return [];
  }

  return db.prepare(`
    SELECT listing_id
    FROM homepage_listings
    WHERE listing_id IN (${placeholdersFor(ids)})
      AND detail_status IN ('pending', 'error', 'processing')
    ORDER BY
      CASE detail_status
        WHEN 'pending' THEN 0
        WHEN 'error' THEN 1
        ELSE 2
      END,
      COALESCE(last_seen_rank, 999999) ASC,
      last_seen_at DESC,
      first_seen_at ASC
  `).all(...ids).map((row) => row.listing_id);
}

function getBacklogListingIdsByQuery(db, options = {}) {
  const query = buildListingIdsQuery({
    query: options.query || '',
    sort: options.sort || '',
    sortDirection: options.sortDirection || options.sortDir || '',
    backlogOnly: true,
  });
  return db.prepare(query.sql).all(...query.params).map((row) => row.listing_id);
}

function writeResolveBatchFile(listingIds, metadata = {}) {
  fs.mkdirSync(RESOLVE_BATCH_DIR, { recursive: true });
  const createdAt = new Date().toISOString();
  const safeStamp = createdAt.replace(/[^0-9A-Za-z]/g, '');
  const filePath = path.join(RESOLVE_BATCH_DIR, `resolve-${safeStamp}-${cryptoRandomSuffix()}.json`);
  fs.writeFileSync(filePath, JSON.stringify({
    createdAt,
    listingIds,
    metadata,
  }, null, 2));
  return filePath;
}

function cryptoRandomSuffix() {
  return Math.random().toString(36).slice(2, 10);
}

function resolveListingsFromViewer(db, body = {}) {
  const mode = String(body.mode || '').trim();
  const requestedIds = normalizeListingIds(body.listingIds || body.listingId);
  const sort = String(body.sort || '').trim();
  const sortDirection = String(body.sortDirection || body.sortDir || '').trim();
  const query = String(body.query || body.q || '').trim();
  let listingIds = [];

  if (mode === 'listing' || mode === 'selected') {
    listingIds = getBacklogListingIdsByIds(db, requestedIds);
  } else if (mode === 'query') {
    listingIds = getBacklogListingIdsByQuery(db, { query, sort, sortDirection });
  } else {
    const error = new Error('Expected resolve mode to be listing, selected, or query');
    error.statusCode = 400;
    throw error;
  }

  if (listingIds.length === 0) {
    const error = new Error('No pending, error, or processing backlog rows matched the resolve request');
    error.statusCode = 400;
    throw error;
  }

  const filePath = writeResolveBatchFile(listingIds, {
    mode,
    query,
    sort,
    sortDirection,
    requestedCount: mode === 'query' ? null : requestedIds.length,
  });
  const args = [
    '--use-credentials',
    '--drain',
    '--status-filter', 'all',
    '--listing-id-file', filePath,
    '--limit', String(listingIds.length),
    '--batch-size', mode === 'listing' ? '1' : '3',
  ];

  const started = startManagedWorkflow(db, mode === 'listing' ? 'backlog-resolve' : 'backlog-worker', args);
  return {
    process: started,
    listingIds,
    listingCount: listingIds.length,
    batchFile: filePath,
  };
}

function startManagedWorkflow(db, workflowId, extraArgs = []) {
  const workflow = WORKFLOWS[workflowId];
  if (!workflow) {
    const error = new Error(`Unknown workflow: ${workflowId}`);
    error.statusCode = 400;
    throw error;
  }

  const running = getRunningManagedProcesses(db);
  if (running.length > 0) {
    const error = new Error(`A workflow is already running: ${running[0].label}`);
    error.statusCode = 409;
    throw error;
  }

  const initialArgs = extraArgs.length > 0 ? extraArgs : buildDefaultArgsFromFields(workflow.fields);
  const record = buildManagedProcessRecord(workflowId, initialArgs);
  const args = ensureManagedWorkerIdArg(initialArgs, record.id, workflow);
  record.args = args;
  const child = spawn('npm', ['run', workflow.script, '--', ...args], {
    cwd: process.cwd(),
    env: process.env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  record.child = child;
  record.pid = child.pid;
  record.status = 'running';
  appendProcessLog(record, `started ${workflow.script} ${args.join(' ')}`);
  record.osAlive = pidIsAlive(record.pid);
  record.osCheckedAt = nowIso();

  insertWorkflowRun(db, {
    runId: record.id,
    workflowId: record.workflowId,
    label: record.label,
    script: record.script,
    args: record.args,
    pid: record.pid,
    status: record.status,
    startedAt: record.startedAt,
    updatedAt: record.osCheckedAt,
    osAlive: record.osAlive,
    logs: record.logs,
  });

  child.stdout.on('data', (chunk) => {
    appendProcessLog(record, chunk);
    syncWorkflowRun(db, record);
  });
  child.stderr.on('data', (chunk) => {
    appendProcessLog(record, chunk);
    syncWorkflowRun(db, record);
  });
  child.on('error', (error) => {
    record.status = 'error';
    record.exitedAt = nowIso();
    appendProcessLog(record, `process_error ${error.message}`);
    syncWorkflowRun(db, record, { osAlive: false });
  });
  child.on('exit', (code, signal) => {
    record.status = code === 0 ? 'exited' : 'failed';
    record.exitedAt = nowIso();
    record.exitCode = code;
    record.signal = signal || '';
    record.child = null;
    appendProcessLog(record, `process_exit code=${code} signal=${signal || ''}`);
    syncWorkflowRun(db, record, { osAlive: false, osCheckedAt: nowIso() });
  });

  managedProcesses.set(record.id, record);
  return publicProcessRecord(record);
}

function stopManagedWorkflow(db, processId) {
  const record = managedProcesses.get(processId);
  const run = getWorkflowRun(db, processId);
  if (!record && !run) {
    const error = new Error(`Unknown process: ${processId}`);
    error.statusCode = 404;
    throw error;
  }

  if (!record) {
    const alive = pidIsAlive(run.pid);
    if (alive && isManagedStatusActive(run.status)) {
      try {
        if (process.platform === 'win32') {
          process.kill(run.pid, 'SIGTERM');
        } else {
          process.kill(-run.pid, 'SIGTERM');
        }
      } catch (error) {
        updateWorkflowRun(db, processId, {
          status: 'stop_failed',
          osCheckedAt: nowIso(),
          osAlive: pidIsAlive(run.pid),
          logs: [...run.logs, `[${nowIso()}] stop_signal_error ${error.message}`],
        });
        return publicWorkflowRunRecord(getWorkflowRun(db, processId));
      }
    }
    updateWorkflowRun(db, processId, {
      status: alive ? 'stopping' : 'lost',
      osCheckedAt: nowIso(),
      osAlive: alive,
    });
    return publicWorkflowRunRecord(getWorkflowRun(db, processId));
  }

  if (!record.child || (record.status !== 'running' && record.status !== 'starting')) {
    syncWorkflowRun(db, record);
    return publicProcessRecord(record);
  }

  record.status = 'stopping';
  appendProcessLog(record, 'stop requested');
  try {
    if (process.platform === 'win32') {
      record.child.kill('SIGTERM');
    } else {
      process.kill(-record.child.pid, 'SIGTERM');
    }
  } catch (error) {
    appendProcessLog(record, `stop_signal_error ${error.message}`);
  }
  syncWorkflowRun(db, record);
  return publicProcessRecord(record);
}

async function readRequestJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text ? JSON.parse(text) : {};
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload, null, 2));
}

function contentTypeForPath(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.md':
      return 'text/markdown; charset=utf-8';
    case '.txt':
      return 'text/plain; charset=utf-8';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    default:
      return 'application/octet-stream';
  }
}

function serveStaticFrontend(response, relativePath) {
  const requestedPath = path.resolve(FRONTEND_DIR, relativePath);
  const relative = path.relative(FRONTEND_DIR, requestedPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    writeJson(response, 404, { error: 'Not found' });
    return;
  }

  if (!fs.existsSync(requestedPath) || !fs.statSync(requestedPath).isFile()) {
    writeJson(response, 404, { error: 'Not found' });
    return;
  }

  response.writeHead(200, { 'content-type': contentTypeForPath(requestedPath) });
  fs.createReadStream(requestedPath).pipe(response);
}

function serveVendorAsset(response, relativePath) {
  const vendorRoot = path.join(process.cwd(), 'node_modules', 'tabulator-tables', 'dist');
  const requestedPath = path.resolve(vendorRoot, relativePath);
  const relative = path.relative(vendorRoot, requestedPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    writeJson(response, 404, { error: 'Not found' });
    return;
  }

  if (!fs.existsSync(requestedPath) || !fs.statSync(requestedPath).isFile()) {
    writeJson(response, 404, { error: 'Not found' });
    return;
  }

  response.writeHead(200, { 'content-type': contentTypeForPath(requestedPath) });
  fs.createReadStream(requestedPath).pipe(response);
}

function formatPathLink(filePath) {
  if (!filePath) {
    return '';
  }

  const relativePath = filePath.startsWith(process.cwd())
    ? filePath.slice(process.cwd().length).replace(/^\/+/, '')
    : filePath;
  return `/files/${relativePath.split(path.sep).map(encodeURIComponent).join('/')}`;
}

function isPriceLike(value) {
  const text = String(value || '').trim();
  return /^(?:CA\$|\$)\s*[\d,]+(?:\.\d{2})?$/.test(text)
    || /^(?:CA\$|\$)?\s*[\d,]+\s*(?:-|to|–|—)\s*(?:CA\$|\$)?\s*[\d,]+$/i.test(text)
    || /^(?:CA\$|\$)\s*[\d,]+(?:CA\$|\$)\s*[\d,]+$/i.test(text)
    || /^free$/i.test(text);
}

function isFreshnessLike(value) {
  return /^(?:just listed|new listing|today|yesterday|listed .* ago|刚刚上架|刚刚发布|剛剛上架|剛剛發布)$/i
    .test(String(value || '').trim());
}

function displayTitleForRow(row) {
  if (row.detail_title) {
    return row.detail_title;
  }

  const candidates = String(row.card_text || '')
    .split(/\s+\|\s+|\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (row.card_title) {
    candidates.push(String(row.card_title).trim());
  }

  return candidates.find((line) => !isPriceLike(line) && !isFreshnessLike(line))
    || row.card_title
    || row.listing_id
    || '';
}

function resolveFilePathFromRequest(urlPath) {
  const relativePath = decodeURIComponent(urlPath.replace(/^\/files\//, ''));
  const resolvedPath = relativePath.startsWith('/')
    ? path.resolve(relativePath)
    : path.resolve(process.cwd(), relativePath);
  const allowedRoots = [
    process.cwd(),
    path.join(process.cwd(), 'artifacts'),
  ];
  if (!allowedRoots.some((root) => resolvedPath.startsWith(root))) {
    return null;
  }
  return resolvedPath;
}

function enrichRowPaths(row) {
  return {
    ...row,
    displayTitle: displayTitleForRow(row),
    screenshotPath: row.screenshot_path,
    snapshotPath: row.snapshot_path,
    screenshotUrl: formatPathLink(row.screenshot_path),
    snapshotUrl: formatPathLink(row.snapshot_path),
  };
}

function enrichEventPaths(event) {
  if (!event) {
    return null;
  }
  const screenshotPath = event?.screenshot_path || event?.listing?.screenshot_path || '';
  const snapshotPath = event?.snapshot_path || event?.listing?.snapshot_path || '';
  return {
    ...event,
    screenshotPath,
    snapshotPath,
    screenshotUrl: formatPathLink(screenshotPath),
    snapshotUrl: formatPathLink(snapshotPath),
  };
}

function createServer(options) {
  const { db } = openMarketplaceHomepageDatabase(options.dbPath);

  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

    if (requestUrl.pathname === '/') {
      serveStaticFrontend(response, 'index.html');
      return;
    }

    if (requestUrl.pathname.startsWith('/app/')) {
      serveStaticFrontend(response, decodeURIComponent(requestUrl.pathname.replace(/^\/app\//, '')));
      return;
    }

    if (requestUrl.pathname.startsWith('/vendor/tabulator/')) {
      serveVendorAsset(response, decodeURIComponent(requestUrl.pathname.replace(/^\/vendor\/tabulator\//, '')));
      return;
    }

    if (requestUrl.pathname === '/api/summary') {
      const total = db.prepare('SELECT COUNT(*) AS total FROM homepage_listings').get().total;
      const latest = db.prepare('SELECT MAX(last_seen_at) AS latest_seen_at FROM homepage_listings').get();
      writeJson(response, 200, {
        dbPath: options.dbPath,
        totalRows: total,
        latestSeenAt: latest.latest_seen_at,
        queueCounts: getHomepageListingCounts(db),
      });
      return;
    }

    if (requestUrl.pathname === '/api/query-fields') {
      writeJson(response, 200, {
        fields: QUERY_FIELDS,
      });
      return;
    }

    if (requestUrl.pathname === '/api/listings') {
      const query = requestUrl.searchParams.get('q') || '';
      const limit = requestUrl.searchParams.get('limit') || '50';
      const offset = requestUrl.searchParams.get('offset') || '0';
      const sort = requestUrl.searchParams.get('sort') || '';
      const sortDirection = requestUrl.searchParams.get('sortDir') || '';

      try {
        const startedAt = process.hrtime.bigint();
        const listingsQuery = buildListingsQuery({ query, limit, offset, sort, sortDirection });
        const countQuery = buildCountQuery({ query });
        const rows = db.prepare(listingsQuery.sql).all(...listingsQuery.params).map(enrichRowPaths);
        const total = db.prepare(countQuery.sql).get(...countQuery.params).total;
        const elapsedMs = Number((process.hrtime.bigint() - startedAt) / 1000000n);

        writeJson(response, 200, {
          query,
          parsedQuery: listingsQuery.parsedQuery,
          sort: listingsQuery.parsedQuery.sort,
          sortDirection: listingsQuery.parsedQuery.sortDirection,
          limit: listingsQuery.limit,
          offset: listingsQuery.offset,
          total,
          rows,
          stats: {
            elapsedMs,
            returnedRows: rows.length,
            totalRows: total,
            limit: listingsQuery.limit,
            offset: listingsQuery.offset,
          },
        });
      } catch (error) {
        writeJson(response, 400, {
          error: error.message,
          query,
        });
      }
      return;
    }

    if (requestUrl.pathname === '/api/listings/resolve' && request.method === 'POST') {
      try {
        const body = await readRequestJson(request);
        const result = resolveListingsFromViewer(db, body);
        writeJson(response, 201, result);
      } catch (error) {
        writeJson(response, error.statusCode || 500, { error: error.message });
      }
      return;
    }

    if (requestUrl.pathname === '/api/workflows' && request.method === 'GET') {
      writeJson(response, 200, {
        workflows: Object.entries(WORKFLOWS).map(([id, workflow]) => ({
          id,
          label: workflow.label,
          script: workflow.script,
          fields: workflow.fields,
          defaultArgs: buildDefaultArgsFromFields(workflow.fields),
        })),
        processes: listManagedProcesses(db),
      });
      return;
    }

    if (requestUrl.pathname === '/api/workflows/reconcile' && request.method === 'POST') {
      writeJson(response, 200, {
        processes: reconcileWorkflowRuns(db),
      });
      return;
    }

    const workerDetailMatch = requestUrl.pathname.match(/^\/api\/workflows\/([^/]+)$/);
    if (workerDetailMatch && request.method === 'GET') {
      const workerId = decodeURIComponent(workerDetailMatch[1]);
      const run = getWorkflowRun(db, workerId);
      if (!run) {
        writeJson(response, 404, { error: `Unknown workflow run: ${workerId}` });
        return;
      }
      writeJson(response, 200, {
        process: publicWorkflowRunRecordWithStats(db, run, {
          includeLogs: true,
          includeLatestEvents: true,
        }),
      });
      return;
    }

    const workerStatsMatch = requestUrl.pathname.match(/^\/api\/workflows\/([^/]+)\/stats$/);
    if (workerStatsMatch && request.method === 'GET') {
      const workerId = decodeURIComponent(workerStatsMatch[1]);
      const workerIds = resolveWorkerEventIdsForRun(db, workerId);
      const stats = getWorkerListingEventStats(db, workerId, { workerIds });
      writeJson(response, 200, {
        workerId,
        stats: {
          ...stats,
          latestEvent: enrichEventPaths(stats.latestEvent),
          latestPreviewEvent: enrichEventPaths(stats.latestPreviewEvent),
        },
      });
      return;
    }

    const workerEventsMatch = requestUrl.pathname.match(/^\/api\/workflows\/([^/]+)\/events$/);
    if (workerEventsMatch && request.method === 'GET') {
      const workerId = decodeURIComponent(workerEventsMatch[1]);
      const category = requestUrl.searchParams.get('category') || 'all';
      const limit = Number.parseInt(requestUrl.searchParams.get('limit') || '50', 10);
      const workerIds = resolveWorkerEventIdsForRun(db, workerId);
      writeJson(response, 200, {
        workerId,
        category,
        workerIds,
        events: listWorkerListingEvents(db, workerId, { category, limit, workerIds }).map(enrichEventPaths),
      });
      return;
    }

    if (requestUrl.pathname === '/api/workflows/start' && request.method === 'POST') {
      try {
        const body = await readRequestJson(request);
        const started = startManagedWorkflow(db, body.workflowId, normalizeWorkflowArgs(body.args));
        writeJson(response, 201, { process: started });
      } catch (error) {
        writeJson(response, error.statusCode || 500, { error: error.message });
      }
      return;
    }

    if (requestUrl.pathname === '/api/workflows/stop' && request.method === 'POST') {
      try {
        const body = await readRequestJson(request);
        const stopped = stopManagedWorkflow(db, body.processId);
        writeJson(response, 200, { process: stopped });
      } catch (error) {
        writeJson(response, error.statusCode || 500, { error: error.message });
      }
      return;
    }

    if (requestUrl.pathname.startsWith('/files/')) {
      const filePath = resolveFilePathFromRequest(requestUrl.pathname);
      if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        writeJson(response, 404, { error: 'File not found' });
        return;
      }

      const extension = path.extname(filePath).toLowerCase();
      const contentType = extension === '.png'
        ? 'image/png'
        : extension === '.jpg' || extension === '.jpeg'
          ? 'image/jpeg'
          : extension === '.md'
            ? 'text/markdown; charset=utf-8'
            : 'application/octet-stream';
      response.writeHead(200, { 'content-type': contentType });
      fs.createReadStream(filePath).pipe(response);
      return;
    }

    writeJson(response, 404, { error: 'Not found' });
  });

  server.on('close', () => {
    closeMarketplaceHomepageDatabase(db);
  });

  return server;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const server = createServer(options);

  server.listen(options.port, options.host, () => {
    process.stdout.write(`Marketplace homepage browser running at http://${options.host}:${options.port}\n`);
    process.stdout.write(`DB: ${path.isAbsolute(options.dbPath) ? options.dbPath : path.join(process.cwd(), options.dbPath)}\n`);
  });

  process.once('SIGINT', () => server.close(() => process.exit(0)));
  process.once('SIGTERM', () => server.close(() => process.exit(0)));
}

main();
