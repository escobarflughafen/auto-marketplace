const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const { spawn } = require('child_process');

const {
  DEFAULT_DB_PATH,
  extractListingId,
  canonicalizeListingUrl,
  openMarketplaceHomepageDatabase,
  closeMarketplaceHomepageDatabase,
  getHomepageListingCounts,
  upsertHomepageListingWithStatus,
  createPurchaseHistoryDocument,
  listPurchaseHistoryDocuments,
  getPurchaseHistoryDocument,
  upsertPurchaseHistoryRows,
  listPurchaseHistoryRows,
  upsertPurchaseHistoryListingLink,
  listPurchaseHistoryListingLinks,
  mergePurchaseHistoryDocuments,
  listPurchaseHistoryEvents,
  listEventRegistry,
  countEventRegistry,
  appendListingEvent,
  insertWorkflowRun,
  updateWorkflowRun,
  getWorkflowRun,
  listWorkflowRuns,
  resolveWorkerEventIdsForRun,
  listWorkerAuditEvents,
  getWorkerAuditEventStats,
  listBacklogCandidates,
  addResolveQueueItems,
  clearResolveQueueItems,
  markResolveQueueDispatched,
  refreshResolveQueueRunStatuses,
  listResolveQueueItems,
  listListingResolverAssignments,
  listResolveQueueEvents,
  getResolveQueueCounts,
  scanPurchaseHistoryListingMatches,
  listPurchaseHistoryMatchQueue,
  listRandomPurchaseHistoryMatches,
  countPurchaseHistoryMatchQueue,
  updatePurchaseHistoryMatchQueueStatus,
} = require('./marketplace-homepage-db');
const {
  buildListingsQuery,
  buildListingIdsQuery,
  buildCountQuery,
} = require('./marketplace-homepage-query');
const {
  completeLiteKql,
} = require('./lite-kql-authoring');
const {
  getMarketplaceLocationOptions,
} = require('./marketplace-utils');
const {
  parseCsv,
} = require('./marketplace-tier3-verdict-dry-run');
const {
  DEFAULT_CREDENTIALS_PATH,
  listCredentialProfiles,
  normalizeCredentialProfileId,
  setActiveCredentialProfile,
  upsertCredentialProfile,
} = require('./marketplace-profile-auth');
const {
  appendWorkerCommand,
} = require('./marketplace-worker-command-channel');

const FRONTEND_DIR = path.join(process.cwd(), 'frontend', 'marketplace-monitor');
const RESOLVE_BATCH_DIR = path.join(process.cwd(), 'artifacts', 'marketplace-homepage', 'resolve-batches');
const WORKER_SCREENSHOT_ROOT = path.join(process.cwd(), 'artifacts', 'marketplace-homepage', 'worker-screenshots');
const TRADING_HISTORY_SCHEMA_PATH = path.join(process.cwd(), 'schemas', 'trading-history.schema.csv');
const PURCHASE_HISTORY_CSV_PATH = path.join(process.cwd(), 'output', 'trading-history.normalized.csv');
const DEFAULT_PURCHASE_HISTORY_DOCUMENT_ID = 'inventory-import';
const HISTORY_MATCH_SCAN_INTERVAL_MS = 5 * 60 * 1000;
const HISTORY_MATCH_SCAN_BATCH_SIZE = 250;
const BACKLOG_STATUSES = new Set(['pending', 'error', 'processing']);
const MARKETPLACE_LOCATION_OPTIONS = getMarketplaceLocationOptions();
const AUTH_MODE_FIELD = {
  id: 'authMode',
  label: 'Authentication',
  kind: 'choice',
  defaultValue: 'credentials',
  options: [
    { value: 'credentials', label: 'Credentials required', args: ['--auth-mode', 'credentials'] },
    { value: 'required', label: 'Profile required', args: ['--auth-mode', 'required'] },
    { value: 'optional', label: 'Optional', args: ['--auth-mode', 'optional'] },
    { value: 'none', label: 'Unauthenticated', args: ['--auth-mode', 'none'] },
  ],
};
const CREDENTIAL_PROFILE_FIELD = {
  id: 'credentialsProfile',
  label: 'Credential',
  kind: 'choice',
  defaultValue: '',
  options: [],
};

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
    adminToken: process.env.MARKETPLACE_MONITOR_ADMIN_TOKEN || '',
    readOnlyToken: process.env.MARKETPLACE_MONITOR_READONLY_TOKEN || '',
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
      case '--admin-token':
        options.adminToken = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--read-only-token':
      case '--readonly-token':
        options.readOnlyToken = readFlagValue(argv, index, arg);
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  options.adminToken ||= generateAccessToken();
  options.readOnlyToken ||= generateAccessToken();
  if (options.adminToken === options.readOnlyToken) {
    throw new Error('Admin and read-only tokens must be different');
  }

  return options;
}

function generateAccessToken() {
  return crypto.randomBytes(24).toString('base64url');
}

const WORKFLOWS = {
  'home-collect': {
    label: 'Homepage Collector',
    script: 'marketplace:home:collect',
    workerType: 'collector',
    strategy: 'feed',
    fields: [
      AUTH_MODE_FIELD,
      CREDENTIAL_PROFILE_FIELD,
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
      { id: 'location', label: 'Location', kind: 'text', flag: '--location', defaultValue: '', options: MARKETPLACE_LOCATION_OPTIONS },
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
    workerType: 'collector',
    strategy: 'explorer',
    fields: [
      AUTH_MODE_FIELD,
      CREDENTIAL_PROFILE_FIELD,
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
      {
        id: 'queryMode',
        label: 'Query mode',
        kind: 'choice',
        defaultValue: 'single',
        options: [
          { value: 'single', label: 'Single query', args: [] },
          { value: 'list', label: 'Keyword list', args: [] },
        ],
      },
      { id: 'query', label: 'Search query', kind: 'text', flag: '--query', defaultValue: 'pentax', activeWhen: { field: 'queryMode', equals: 'single' } },
      { id: 'queries', label: 'Keyword list', kind: 'textarea', editor: 'list', flag: '--queries', defaultValue: '', activeWhen: { field: 'queryMode', equals: 'list' } },
      { id: 'randomWalksBetweenSeeds', label: 'Random walks between entries', kind: 'number', flag: '--random-walks-between-seeds', defaultValue: '', min: 0, activeWhen: { field: 'queryMode', equals: 'list' } },
      { id: 'location', label: 'Location', kind: 'text', flag: '--location', defaultValue: '', options: MARKETPLACE_LOCATION_OPTIONS },
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
    workerType: 'resolver',
    strategy: 'filtered',
    fields: [
      AUTH_MODE_FIELD,
      CREDENTIAL_PROFILE_FIELD,
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
    workerType: 'resolver',
    strategy: 'queue',
    fields: [
      AUTH_MODE_FIELD,
      CREDENTIAL_PROFILE_FIELD,
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
  'backlog-indexer': {
    label: 'Backlog Indexer',
    script: 'marketplace:home:index',
    workerType: 'backlog_indexer',
    strategy: 'resolved_metadata',
    fields: [
      { id: 'limit', label: 'Batch size', kind: 'number', flag: '--limit', defaultValue: 250, min: 1 },
      { id: 'pollIntervalSeconds', label: 'Poll interval seconds', kind: 'number', flag: '--poll-interval-seconds', defaultValue: 300, min: 1 },
      { id: 'pollJitterMin', label: 'Poll jitter min', kind: 'number', flag: '--poll-jitter-min', defaultValue: 0.8, min: 0, step: 0.1 },
      { id: 'pollJitterMax', label: 'Poll jitter max', kind: 'number', flag: '--poll-jitter-max', defaultValue: 1.2, min: 0, step: 0.1 },
      { id: 'allRows', label: 'Re-index all resolved rows', kind: 'boolean', flag: '--all', defaultValue: false },
      { id: 'once', label: 'Run once', kind: 'boolean', flag: '--once', defaultValue: false },
      { id: 'workerId', label: 'Worker ID', kind: 'text', flag: '--worker-id', defaultValue: '' },
    ],
  },
  'profile-onboarder': {
    label: 'Profile Onboarder',
    script: 'marketplace:auth:profile-onboarder',
    workerType: 'profile_onboarder',
    strategy: 'guided_login',
    fields: [
      CREDENTIAL_PROFILE_FIELD,
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
      { id: 'loginTimeoutSeconds', label: 'Login timeout seconds', kind: 'number', flag: '--login-timeout-seconds', defaultValue: 900, min: 30 },
      { id: 'pollSeconds', label: 'Poll seconds', kind: 'number', flag: '--poll-seconds', defaultValue: 3, min: 1 },
    ],
  },
};

const WORKFLOW_CONCURRENCY_LIMITS = {
  'search-explore': 2,
  'profile-onboarder': 1,
};
const WORKER_TYPE_CONCURRENCY_LIMITS = {
  resolver: 2,
};
const BROWSER_WORKER_TYPES = new Set(['collector', 'resolver', 'profile_onboarder']);
const EXCLUSIVE_BROWSER_WORKER_TYPES = new Set(['profile_onboarder']);
const WORKFLOW_SCRIPTS_WITH_WORKER_ID = new Set([
  'marketplace:home:collect',
  'marketplace:search:explore',
  'marketplace:home:process',
  'marketplace:home:index',
  'marketplace:auth:profile-onboarder',
]);
const COMMON_WORKER_SCREENSHOT_VALUE_FLAGS = new Set([
  '--worker-screenshot-format',
  '--worker-screenshot-quality',
]);
const PROCESS_SCREENSHOT_VALUE_FLAGS = new Set([
  '--screenshot-format',
  '--screenshot-quality',
  '--artifact-budget-kb',
]);
const PROCESS_SCREENSHOT_BOOLEAN_FLAGS = new Set([
  '--screenshot-full-page',
  '--full-page-screenshot',
  '--screenshot-viewport',
  '--viewport-screenshot',
]);

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

function getCredentialProfilesForUi() {
  try {
    return listCredentialProfiles(DEFAULT_CREDENTIALS_PATH);
  } catch (error) {
    return {
      credentialsPath: DEFAULT_CREDENTIALS_PATH,
      activeProfileId: '',
      profiles: [],
      error: error.message,
    };
  }
}

function credentialProfileOptions(credentials = getCredentialProfilesForUi()) {
  const active = credentials.profiles.find((profile) => profile.id === credentials.activeProfileId);
  return [
    {
      value: '',
      label: active ? `Active (${active.label || active.email || active.id})` : 'Active credential',
      args: [],
    },
    ...credentials.profiles.map((profile) => ({
      value: profile.id,
      label: profile.active
        ? `${profile.label || profile.email || profile.id} (active)`
        : profile.label || profile.email || profile.id,
      args: ['--credentials-profile', profile.id],
    })),
  ];
}

function fieldsForWorkflow(workflow, options = {}) {
  return (workflow.fields || []).map((field) => {
    if (field.id !== CREDENTIAL_PROFILE_FIELD.id) {
      return field;
    }
    return {
      ...field,
      options: typeof options.credentialOptions === 'function'
        ? options.credentialOptions()
        : options.credentialOptions || credentialProfileOptions(),
    };
  });
}

function buildWorkflowDefinitions() {
  let credentialOptionsCache = null;
  const getCredentialOptions = () => {
    if (!credentialOptionsCache) {
      credentialOptionsCache = credentialProfileOptions();
    }
    return credentialOptionsCache;
  };
  return Object.entries(WORKFLOWS).map(([id, workflow]) => {
    const fields = fieldsForWorkflow(workflow, {
      credentialOptions: getCredentialOptions,
    });
    return {
      id,
      label: workflow.label,
      script: workflow.script,
      workerType: workflow.workerType || '',
      strategy: workflow.strategy || '',
      fields,
      defaultArgs: buildDefaultArgsFromFields(fields),
    };
  });
}

function defaultDraftFromFields(fields = []) {
  const draft = {};
  for (const field of fields) {
    if (field.kind === 'boolean') {
      draft[field.id] = Boolean(field.defaultValue);
    } else if (field.kind === 'choice') {
      draft[field.id] = field.defaultValue ?? field.options?.[0]?.value ?? '';
    } else {
      draft[field.id] = field.defaultValue ?? '';
    }
  }
  return draft;
}

function workflowFieldActive(field, draft = {}) {
  const rule = field?.activeWhen;
  if (!rule) {
    return true;
  }
  const actual = draft[rule.field];
  if (Object.prototype.hasOwnProperty.call(rule, 'equals')) {
    return actual === rule.equals;
  }
  if (Array.isArray(rule.oneOf)) {
    return rule.oneOf.includes(actual);
  }
  if (Object.prototype.hasOwnProperty.call(rule, 'notEquals')) {
    return actual !== rule.notEquals;
  }
  return true;
}

function buildDefaultArgsFromFields(fields = []) {
  const args = [];
  const draft = defaultDraftFromFields(fields);
  for (const field of fields) {
    if (!workflowFieldActive(field, draft)) {
      continue;
    }
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

function workflowTypeForId(workflowId) {
  return WORKFLOWS[workflowId]?.workerType || 'worker';
}

function workflowConcurrencyLimit(workflowId, workerType) {
  if (Object.prototype.hasOwnProperty.call(WORKFLOW_CONCURRENCY_LIMITS, workflowId)) {
    return WORKFLOW_CONCURRENCY_LIMITS[workflowId];
  }
  if (Object.prototype.hasOwnProperty.call(WORKER_TYPE_CONCURRENCY_LIMITS, workerType)) {
    return WORKER_TYPE_CONCURRENCY_LIMITS[workerType];
  }
  return Number.POSITIVE_INFINITY;
}

function workflowConcurrencyScope(workflowId, workerType) {
  if (Object.prototype.hasOwnProperty.call(WORKFLOW_CONCURRENCY_LIMITS, workflowId)) {
    return 'workflow';
  }
  if (Object.prototype.hasOwnProperty.call(WORKER_TYPE_CONCURRENCY_LIMITS, workerType)) {
    return 'workerType';
  }
  return 'none';
}

function isBrowserWorkerType(workerType) {
  return BROWSER_WORKER_TYPES.has(String(workerType || ''));
}

function isExclusiveBrowserWorkerType(workerType) {
  return EXCLUSIVE_BROWSER_WORKER_TYPES.has(String(workerType || ''));
}

function isManagedStatusActive(status) {
  return status === 'starting' || status === 'running' || status === 'stopping' || status === 'stop_failed';
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
    stopRequested: false,
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
    workerType: workflowTypeForId(record.workflowId),
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
    workerType: workflowTypeForId(run.workflow_id),
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
  const eventStats = getWorkerAuditEventStats(db, run.run_id, { workerIds });
  record.runtimeStats = runtimeStatsFromEventStats(eventStats, record.runtimeStats);
  record.eventStats = options.includeLatestEvents
    ? eventStats
    : {
      total: eventStats.total,
      listingTotal: eventStats.listingTotal,
      workflow: eventStats.workflow,
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
  return logs.slice().reverse().find((line) => /job_start|job_done|job_error|job_bypassed|backlog_sleep|backlog_item_sleep|backlog_exit|cycle_start|cycle_done|collector_sleep|collector_exit|round_start|round_done|search_explorer_sleep|search_explorer_exit/.test(line))
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
    const collectedMatch = line.match(/\bcollected=(\d+)/);
    const newMatch = line.match(/\bnew=(\d+)/);
    const sameMatch = line.match(/\bexisting_same=(\d+)/);
    const updatedMatch = line.match(/\bexisting_updated=(\d+)/);
    const queryMatch = line.match(/\bquery="([^"]+)"/);
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
    } else if (/cycle_start/.test(line)) {
      stats.attempted += 1;
      stats.currentListingId = 'feed';
    } else if (/round_start/.test(line)) {
      stats.attempted += 1;
      stats.currentListingId = queryMatch?.[1] ? `search: ${queryMatch[1]}` : 'search';
    } else if (/cycle_done|round_done/.test(line)) {
      stats.done += collectedMatch ? Number.parseInt(collectedMatch[1], 10) : 0;
      stats.bypassed += (sameMatch ? Number.parseInt(sameMatch[1], 10) : 0)
        + (updatedMatch ? Number.parseInt(updatedMatch[1], 10) : 0);
      if (newMatch) {
        stats.currentListingId = `${newMatch[1]} new`;
      } else {
        stats.currentListingId = '';
      }
    } else if (/collector_sleep|search_explorer_sleep/.test(line)) {
      stats.sleeps += 1;
      stats.currentListingId = 'sleeping';
    } else if (/collector_exit|search_explorer_exit/.test(line)) {
      stats.currentListingId = '';
    } else if (/collect_marketplace_search_explorer_error|collector_.*error|search_explorer_.*error/.test(line)) {
      stats.errors += 1;
    }
  }
  return stats;
}

function runtimeStatsFromEventStats(eventStats, fallbackStats = {}) {
  const hasAuditStats = Boolean(eventStats && (
    eventStats.listingTotal > 0
    || eventStats.workflow > 0
    || eventStats.started > 0
    || eventStats.done > 0
    || eventStats.skipped > 0
    || eventStats.error > 0
  ));
  if (!hasAuditStats) {
    return fallbackStats || { attempted: 0, done: 0, bypassed: 0, errors: 0, sleeps: 0, currentListingId: '' };
  }
  return {
    attempted: eventStats.started || 0,
    done: eventStats.done || 0,
    bypassed: eventStats.skipped || 0,
    errors: eventStats.error || 0,
    sleeps: fallbackStats.sleeps || 0,
    currentListingId: fallbackStats.currentListingId || '',
    source: 'events',
  };
}

function publicWorkflowRunRecords(db, runs, options = {}) {
  if (options.includeStats === false) {
    return runs.map((run) => publicWorkflowRunRecord(run));
  }
  return runs.map((run) => publicWorkflowRunRecordWithStats(db, run));
}

function reconcileWorkflowRuns(db, options = {}) {
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
      const nextStatus = run.status === 'stopping' ? 'terminated' : 'lost';
      updateWorkflowRun(db, run.run_id, {
        status: nextStatus,
        exitedAt: now,
        osCheckedAt: now,
        osAlive: false,
        logs: [
          ...(run.logs || []),
          `[${now}] workflow_reconciled status=${nextStatus} reason=process_missing previous_status=${run.status || ''} pid=${run.pid || ''}`,
        ],
      });
    } else {
      updateWorkflowRun(db, run.run_id, {
        osCheckedAt: now,
        osAlive: alive,
      });
    }
  }

  return publicWorkflowRunRecords(db, listWorkflowRuns(db, { limit: 50 }), options);
}

function listManagedProcesses(db, options = {}) {
  if (options.reconcile === false) {
    return publicWorkflowRunRecords(db, listWorkflowRuns(db, { limit: 50 }), options);
  }
  return reconcileWorkflowRuns(db, options);
}

function getRunningManagedProcesses(db) {
  const runs = reconcileWorkflowRuns(db);
  return runs.filter((record) => isManagedStatusActive(record.status) && (record.osAlive || record.managed));
}

function getWorkflowRuntimeSummary(db, options = {}) {
  const reconcile = options.reconcile !== false;
  const runs = reconcile
    ? reconcileWorkflowRuns(db, { includeStats: false })
    : publicWorkflowRunRecords(db, listWorkflowRuns(db, { limit: 50 }), { includeStats: false });
  const statuses = runs.reduce((accumulator, run) => {
    const status = run.status || 'unknown';
    accumulator[status] = (accumulator[status] || 0) + 1;
    return accumulator;
  }, {});
  const activeRuns = runs.filter((run) => isManagedStatusActive(run.status));
  const workingRuns = activeRuns.filter((run) => run.osAlive || run.managed);
  return {
    working: workingRuns.length,
    active: activeRuns.length,
    totalRecent: runs.length,
    running: statuses.running || 0,
    starting: statuses.starting || 0,
    stopping: statuses.stopping || 0,
    lost: statuses.lost || 0,
    failed: (statuses.failed || 0) + (statuses.error || 0),
  };
}

function ensureManagedWorkerIdArg(args, runId, workflow) {
  const supportsWorkerId = WORKFLOW_SCRIPTS_WITH_WORKER_ID.has(workflow.script)
    || fieldsForWorkflow(workflow)
    .some((field) => field.flag === '--worker-id'
      || field.args?.includes?.('--worker-id')
      || field.options?.some((option) => option.args?.includes?.('--worker-id')));
  if (!supportsWorkerId) {
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

function workflowArgError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function normalizeArgToken(arg) {
  return String(arg || '').trim();
}

function validateFlagToken(flag) {
  if (!/^--[a-z0-9][a-z0-9-]*$/i.test(flag)) {
    throw workflowArgError(`Unsafe workflow argument flag: ${flag || '(empty)'}`);
  }
}

function assertSafeWorkflowArgValue(flag, value) {
  const text = String(value ?? '');
  if (!text || text.startsWith('--')) {
    throw workflowArgError(`Missing value for workflow argument ${flag}`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(text)) {
    throw workflowArgError(`Unsafe control character in workflow argument ${flag}`);
  }
  if (/^[=+@]/u.test(text) || /^-[-+=@]/u.test(text)) {
    throw workflowArgError(`Unsafe workflow argument value for ${flag}`);
  }
  if (text.length > 2000) {
    throw workflowArgError(`Workflow argument value is too long for ${flag}`);
  }
}

function validateNumberFieldValue(flag, value, field = {}) {
  assertSafeWorkflowArgValue(flag, value);
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw workflowArgError(`Expected numeric value for workflow argument ${flag}`);
  }
  if (field.min !== undefined && numeric < Number(field.min)) {
    throw workflowArgError(`Expected ${flag} to be >= ${field.min}`);
  }
  if (field.max !== undefined && numeric > Number(field.max)) {
    throw workflowArgError(`Expected ${flag} to be <= ${field.max}`);
  }
}

function validateEnumValue(flag, value, allowedValues) {
  assertSafeWorkflowArgValue(flag, value);
  if (!allowedValues.has(String(value))) {
    throw workflowArgError(`Unexpected value for workflow argument ${flag}`);
  }
}

function validateWorkflowPathValue(flag, value, rootDir) {
  assertSafeWorkflowArgValue(flag, value);
  const resolved = path.resolve(String(value));
  const root = path.resolve(rootDir);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw workflowArgError(`Workflow argument ${flag} must stay under ${root}`);
  }
}

function workflowArgSpec(workflow, options = {}) {
  const booleanFlags = new Set();
  const valueValidators = new Map();

  const addBooleanFlag = (flag) => {
    if (!flag) return;
    validateFlagToken(flag);
    booleanFlags.add(flag);
  };
  const addValueFlag = (flag, validator) => {
    if (!flag) return;
    validateFlagToken(flag);
    valueValidators.set(flag, validator);
  };

  for (const field of fieldsForWorkflow(workflow)) {
    if (field.kind === 'boolean') {
      addBooleanFlag(field.flag);
      continue;
    }
    if (field.kind === 'choice') {
      for (const option of field.options || []) {
        const optionArgs = Array.isArray(option.args) ? option.args : [];
        for (let index = 0; index < optionArgs.length; index += 1) {
          const flag = String(optionArgs[index] || '');
          if (!flag.startsWith('--')) {
            continue;
          }
          const next = optionArgs[index + 1];
          if (next && !String(next).startsWith('--')) {
            const allowedValues = new Set(
              (field.options || [])
                .flatMap((item) => item.args || [])
                .filter((item, itemIndex, allArgs) => itemIndex > 0 && String(allArgs[itemIndex - 1]) === flag),
            );
            addValueFlag(flag, (value) => validateEnumValue(flag, value, allowedValues));
            index += 1;
          } else {
            addBooleanFlag(flag);
          }
        }
      }
      continue;
    }
    if (field.kind === 'number') {
      addValueFlag(field.flag, (value) => validateNumberFieldValue(field.flag, value, field));
      continue;
    }
    addValueFlag(field.flag, (value) => assertSafeWorkflowArgValue(field.flag, value));
  }

  for (const flag of COMMON_WORKER_SCREENSHOT_VALUE_FLAGS) {
    if (flag === '--worker-screenshot-format') {
      addValueFlag(flag, (value) => validateEnumValue(flag, value, new Set(['jpeg', 'jpg', 'png'])));
    } else {
      addValueFlag(flag, (value) => validateNumberFieldValue(flag, value, { min: 1, max: 100 }));
    }
  }

  if (workflow.script === 'marketplace:home:process') {
    for (const flag of PROCESS_SCREENSHOT_BOOLEAN_FLAGS) {
      addBooleanFlag(flag);
    }
    for (const flag of PROCESS_SCREENSHOT_VALUE_FLAGS) {
      if (flag === '--screenshot-format') {
        addValueFlag(flag, (value) => validateEnumValue(flag, value, new Set(['jpeg', 'jpg', 'png'])));
      } else {
        addValueFlag(flag, (value) => validateNumberFieldValue(flag, value, {
          min: flag.includes('quality') ? 1 : 0,
          max: flag.includes('quality') ? 100 : undefined,
        }));
      }
    }
  }

  if (options.allowInternalArgs && workflow.script === 'marketplace:home:process') {
    addBooleanFlag('--use-credentials');
    addBooleanFlag('--drain');
    addValueFlag('--listing-id-file', (value) => validateWorkflowPathValue('--listing-id-file', value, RESOLVE_BATCH_DIR));
  }

  return { booleanFlags, valueValidators };
}

function validateWorkflowArgs(workflow, args, options = {}) {
  const { booleanFlags, valueValidators } = workflowArgSpec(workflow, options);
  const normalized = normalizeWorkflowArgs(args).map(normalizeArgToken).filter(Boolean);
  const safeArgs = [];

  for (let index = 0; index < normalized.length; index += 1) {
    const flag = normalized[index];
    validateFlagToken(flag);
    if (booleanFlags.has(flag)) {
      safeArgs.push(flag);
      continue;
    }
    const validator = valueValidators.get(flag);
    if (!validator) {
      throw workflowArgError(`Unsupported workflow argument: ${flag}`);
    }
    const value = normalized[index + 1];
    validator(value);
    safeArgs.push(flag, String(value));
    index += 1;
  }

  return safeArgs;
}

function validateWorkflowStartArgs(workflowId, args, options = {}) {
  const workflow = WORKFLOWS[workflowId];
  if (!workflow) {
    throw workflowArgError(`Unknown workflow: ${workflowId}`);
  }
  return validateWorkflowArgs(workflow, args, options);
}

function normalizeScreenshotRuntimeArgs(value) {
  const args = normalizeWorkflowArgs(value);
  const normalized = [];
  const valuedFlags = new Set([
    '--screenshot-format',
    '--screenshot-quality',
    '--artifact-budget-kb',
    '--worker-screenshot-format',
    '--worker-screenshot-quality',
  ]);
  const booleanFlags = new Set([
    '--screenshot-full-page',
    '--full-page-screenshot',
    '--screenshot-viewport',
    '--viewport-screenshot',
  ]);

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (booleanFlags.has(flag)) {
      normalized.push(flag);
      continue;
    }
    if (!valuedFlags.has(flag)) {
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      continue;
    }
    normalized.push(flag, value);
    index += 1;
  }

  return normalized;
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

function getListingIdsByIds(db, listingIds) {
  const ids = normalizeListingIds(listingIds);
  if (ids.length === 0) {
    return [];
  }

  return db.prepare(`
    SELECT listing_id
    FROM homepage_listings
    WHERE listing_id IN (${placeholdersFor(ids)})
    ORDER BY last_seen_at DESC, first_seen_at ASC
  `).all(...ids).map((row) => row.listing_id);
}

function getBacklogListingIdsByQuery(db, options = {}) {
  const query = buildListingIdsQuery({
    query: options.query || '',
    sort: options.sort || '',
    sortDirection: options.sortDirection || options.sortDir || '',
    excludeListingIds: options.excludeListingIds || [],
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
  const excludeListingIds = normalizeListingIds(body.excludeListingIds || body.excludeListingId);
  const sort = String(body.sort || '').trim();
  const sortDirection = String(body.sortDirection || body.sortDir || '').trim();
  const query = String(body.query || body.q || '').trim();
  let listingIds = [];

  if (mode === 'listing' || mode === 'selected') {
    listingIds = getBacklogListingIdsByIds(db, requestedIds);
  } else if (mode === 'update') {
    listingIds = getListingIdsByIds(db, requestedIds);
  } else if (mode === 'query') {
    listingIds = getBacklogListingIdsByQuery(db, { query, sort, sortDirection, excludeListingIds });
  } else {
    const error = new Error('Expected resolve mode to be listing, selected, update, or query');
    error.statusCode = 400;
    throw error;
  }

  if (listingIds.length === 0) {
    const error = new Error(mode === 'update'
      ? 'No listing rows matched the update request'
      : 'No pending, error, or processing backlog rows matched the resolve request');
    error.statusCode = 400;
    throw error;
  }

  const filePath = writeResolveBatchFile(listingIds, {
    mode,
    query,
    sort,
    sortDirection,
    requestedCount: mode === 'query' ? null : requestedIds.length,
    excludedCount: excludeListingIds.length,
  });
  const args = [
    '--use-credentials',
    '--drain',
    '--status-filter', 'all',
    '--listing-id-file', filePath,
    '--limit', String(listingIds.length),
    '--batch-size', mode === 'listing' ? '1' : '3',
    ...normalizeScreenshotRuntimeArgs(body.runtimeArgs),
  ];

  const started = startManagedWorkflow(db, mode === 'listing' || mode === 'update' ? 'backlog-resolve' : 'backlog-worker', args, {
    allowInternalArgs: true,
  });
  return {
    process: started,
    listingIds,
    listingCount: listingIds.length,
    batchFile: filePath,
  };
}

function resolveQueuedListingsFromViewer(db, body = {}) {
  refreshResolveQueueRunStatuses(db);
  const queuedItems = listResolveQueueItems(db, { statuses: ['queued'], limit: 500 });
  const queuedIds = queuedItems.map((item) => item.listing_id);
  if (queuedIds.length === 0) {
    const error = new Error('Resolve queue is empty');
    error.statusCode = 400;
    throw error;
  }

  const result = resolveListingsFromViewer(db, {
    mode: 'selected',
    listingIds: queuedIds,
    runtimeArgs: body.runtimeArgs,
  });
  const dispatchedIds = new Set(result.listingIds);
  const skippedIds = queuedIds.filter((listingId) => !dispatchedIds.has(listingId));
  if (skippedIds.length > 0) {
    clearResolveQueueItems(db, skippedIds, {
      actor: 'system',
    });
  }
  markResolveQueueDispatched(db, result.listingIds, result.process?.id || '', {
    actor: 'viewer',
  });
  return {
    ...result,
    queue: {
      items: listResolveQueueItems(db),
      counts: getResolveQueueCounts(db),
      events: listResolveQueueEvents(db, { limit: 20 }),
    },
  };
}

function startManagedWorkflow(db, workflowId, extraArgs = [], options = {}) {
  const workflow = WORKFLOWS[workflowId];
  if (!workflow) {
    const error = new Error(`Unknown workflow: ${workflowId}`);
    error.statusCode = 400;
    throw error;
  }

  const running = getRunningManagedProcesses(db);
  const workerType = workflow.workerType || 'worker';
  const limit = workflowConcurrencyLimit(workflowId, workerType);
  const limitScope = workflowConcurrencyScope(workflowId, workerType);
  const runningForLimit = limitScope === 'workflow'
    ? running.filter((record) => record.workflowId === workflowId)
    : limitScope === 'workerType'
      ? running.filter((record) => (record.workerType || workflowTypeForId(record.workflowId)) === workerType)
      : [];
  if (Number.isFinite(limit) && runningForLimit.length >= limit) {
    const limitLabel = limitScope === 'workflow' ? workflow.label : `${workerType} worker`;
    const error = new Error(`${limitLabel} limit reached: ${runningForLimit.length}/${limit} running`);
    error.statusCode = 409;
    throw error;
  }
  const browserConflict = running.find((record) => {
    const runningWorkerType = record.workerType || workflowTypeForId(record.workflowId);
    if (!isBrowserWorkerType(workerType) || !isBrowserWorkerType(runningWorkerType)) {
      return false;
    }
    return isExclusiveBrowserWorkerType(workerType) || isExclusiveBrowserWorkerType(runningWorkerType);
  });
  if (browserConflict) {
    const error = new Error(
      `Interactive browser worker conflict: ${browserConflict.label || browserConflict.workflowId || browserConflict.id}. `
      + 'Profile onboarder needs exclusive browser access; stop it or wait until it finishes before starting another browser worker.',
    );
    error.statusCode = 409;
    throw error;
  }

  const rawInitialArgs = extraArgs.length > 0 ? extraArgs : buildDefaultArgsFromFields(fieldsForWorkflow(workflow));
  const initialArgs = validateWorkflowArgs(workflow, rawInitialArgs, {
    allowInternalArgs: options.allowInternalArgs === true,
  });
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
    record.status = record.stopRequested || record.status === 'stopping'
      ? 'terminated'
      : code === 0
        ? 'exited'
        : 'failed';
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
    const nextStatus = alive
      ? 'stopping'
      : run.status === 'stopping'
        ? 'terminated'
        : 'lost';
    updateWorkflowRun(db, processId, {
      status: nextStatus,
      exitedAt: nextStatus === 'terminated' || nextStatus === 'lost' ? nowIso() : run.exited_at,
      osCheckedAt: nowIso(),
      osAlive: alive,
      logs: alive ? [...run.logs, `[${nowIso()}] stop requested`] : run.logs,
    });
    return publicWorkflowRunRecord(getWorkflowRun(db, processId));
  }

  if (!record.child || (record.status !== 'running' && record.status !== 'starting')) {
    syncWorkflowRun(db, record);
    return publicProcessRecord(record);
  }

  record.status = 'stopping';
  record.stopRequested = true;
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

function tokenFromRequest(request, requestUrl) {
  const queryToken = requestUrl.searchParams.get('token') || requestUrl.searchParams.get('apiToken');
  if (queryToken) {
    return queryToken;
  }

  const headerToken = request.headers['x-api-token'];
  if (headerToken) {
    return Array.isArray(headerToken) ? headerToken[0] : headerToken;
  }

  const authorization = request.headers.authorization || '';
  const match = String(authorization).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function accessForRequest(options, request, requestUrl) {
  const token = tokenFromRequest(request, requestUrl);
  if (token && token === options.adminToken) {
    return { role: 'admin', canWrite: true };
  }
  if (token && token === options.readOnlyToken) {
    return { role: 'readonly', canWrite: false };
  }
  return { role: '', canWrite: false };
}

function authPayloadForAccess(access) {
  const canWrite = Boolean(access.canWrite);
  return {
    role: access.role,
    capabilities: {
      canRead: Boolean(access.role),
      canWrite,
      canManageQueue: canWrite,
      canManageWorkers: canWrite,
      canManageCredentials: canWrite,
      canManageHistory: canWrite,
    },
  };
}

function csvEscape(value) {
  const text = String(value ?? '');
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function renderCsv(rows, fields) {
  return [
    fields.join(','),
    ...rows.map((row) => fields.map((field) => csvEscape(row[field] ?? '')).join(',')),
  ].join('\n');
}

function readTradingHistoryFields() {
  return parseCsv(fs.readFileSync(TRADING_HISTORY_SCHEMA_PATH, 'utf8'))
    .map((row) => row.field_name)
    .filter(Boolean);
}

function rowLookupValue(row, names) {
  const entries = Object.entries(row || {});
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(row || {}, name) && row[name] !== '') {
      return row[name];
    }
    const match = entries.find(([key, value]) => key.toLowerCase() === name.toLowerCase() && value !== '');
    if (match) {
      return match[1];
    }
  }
  return '';
}

function rowLooksSold(row = {}) {
  const statusText = String(rowLookupValue(row, ['inventory_status', 'sale_status', 'status', 'decision', 'outcome']) || '').toLowerCase();
  return statusText === 'sold'
    || statusText === 'sold_profitable'
    || statusText === 'sold_break_even'
    || statusText === 'loss'
    || Boolean(rowLookupValue(row, ['sold_at', 'sold_price_cad', 'sold_price', 'sold']));
}

function normalizeInventoryStatus(row = {}) {
  const status = String(rowLookupValue(row, ['inventory_status', 'sale_status', 'status']) || '').trim().toLowerCase();
  if (status === 'hold' || status === 'listed' || status === 'sold') {
    return status;
  }
  if (rowLooksSold(row)) {
    return 'sold';
  }
  if (rowLookupValue(row, ['listed_at', 'list_price_cad', 'price_cad', 'price'])) {
    return 'listed';
  }
  return 'hold';
}

function normalizeRowsToFields(rows, fields) {
  const aliases = {
    inventory_status: ['sale_status', 'status', 'inventory status'],
    purchase_price_cad: ['cost', 'cost_cad', 'purchase_price', 'purchase price', 'purchase'],
    list_price_cad: ['price_cad', 'price', 'list_price', 'list price', 'listed', 'listed_cad'],
    sold_price_cad: ['sold', 'sold_cad', 'sold_price', 'sold price'],
    purchase_at: ['date', 'purchased', 'purchased_at', 'purchase date'],
    listed_at: ['listed date', 'listed_date'],
    sold_at: ['sold date', 'sold_date'],
    subcategory: ['kind', 'type'],
  };
  return rows.map((row) => Object.fromEntries(fields.map((field) => {
    const exact = row?.[field];
    if (exact !== undefined && exact !== '') {
      return [field, exact];
    }
    if (field === 'inventory_status') {
      return [field, normalizeInventoryStatus(row)];
    }
    if (field === 'sold_price_cad' && rowLooksSold(row)) {
      return [field, rowLookupValue(row, aliases.sold_price_cad) || rowLookupValue(row, ['price_cad', 'price'])];
    }
    if (field === 'list_price_cad' && rowLooksSold(row)) {
      return [field, rowLookupValue(row, aliases.list_price_cad)];
    }
    return [field, rowLookupValue(row, aliases[field] || [])];
  })));
}

function parseTradingHistoryCsv(text, fields = readTradingHistoryFields()) {
  return normalizeRowsToFields(parseCsv(text), fields);
}

function historyDbRowsToCsvRows(rows, fields) {
  return rows.map((row) => {
    const data = row.data || {};
    const normalized = Object.fromEntries(fields.map((field) => [field, data[field] ?? '']));
    if (!normalized.inventory_status) {
      normalized.inventory_status = normalizeInventoryStatus(normalized);
    }
    if (Array.isArray(row.listing_links)) {
      normalized._listing_links = row.listing_links;
    }
    return normalized;
  });
}

function attachPurchaseHistoryListingLinks(db, rows, documentId) {
  const links = listPurchaseHistoryListingLinks(db, { documentId });
  const linksByRecord = links.reduce((accumulator, link) => {
    accumulator[link.record_id] ||= [];
    accumulator[link.record_id].push(link);
    return accumulator;
  }, {});
  return rows.map((row) => ({
    ...row,
    listing_links: linksByRecord[row.record_id] || [],
  }));
}

function ensurePurchaseHistorySeedDocument(db, fields = readTradingHistoryFields()) {
  let documents = listPurchaseHistoryDocuments(db);
  if (documents.length > 0) {
    return documents;
  }

  const seeded = createPurchaseHistoryDocument(db, {
    documentId: DEFAULT_PURCHASE_HISTORY_DOCUMENT_ID,
    name: 'Inventory Import',
    description: 'Seeded from output/trading-history.normalized.csv',
  });

  if (fs.existsSync(PURCHASE_HISTORY_CSV_PATH)) {
    const rows = parseTradingHistoryCsv(fs.readFileSync(PURCHASE_HISTORY_CSV_PATH, 'utf8'), fields);
    if (rows.length > 0) {
      upsertPurchaseHistoryRows(db, seeded.document_id, rows);
    }
  }

  documents = listPurchaseHistoryDocuments(db);
  return documents;
}

function selectedPurchaseHistoryDocument(db, requestedDocumentId, fields = readTradingHistoryFields()) {
  const documents = ensurePurchaseHistorySeedDocument(db, fields);
  if (!documents.length) {
    return null;
  }
  if (requestedDocumentId) {
    const requested = documents.find((document) => document.document_id === requestedDocumentId)
      || getPurchaseHistoryDocument(db, requestedDocumentId);
    if (requested) {
      return requested;
    }
  }
  return documents[0];
}

function nextPurchaseHistoryRecordId(rows) {
  const prefix = `manual-history-${new Date().getFullYear()}-`;
  const next = rows.reduce((max, row) => {
    const match = String(row.record_id || '').match(/^manual-history-\d{4}-(\d+)$/);
    return match ? Math.max(max, Number.parseInt(match[1], 10)) : max;
  }, 0) + 1;
  return `${prefix}${String(next).padStart(3, '0')}`;
}

function parseHistoryNumber(value) {
  const text = String(value ?? '').replace(/[$,%\s,]/g, '');
  if (!text) {
    return null;
  }
  const number = Number.parseFloat(text);
  return Number.isFinite(number) ? number : null;
}

function formatHistoryNumber(value, digits = 2) {
  if (!Number.isFinite(value)) {
    return '';
  }
  return String(Number(value.toFixed(digits)));
}

function daysBetweenDates(startDate, endDate) {
  if (!startDate || !endDate) {
    return '';
  }
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return '';
  }
  return String(Math.round((end - start) / 86400000));
}

function applyPurchaseHistoryCalculations(row) {
  const purchase = parseHistoryNumber(row.purchase_price_cad);
  let sold = parseHistoryNumber(row.sold_price_cad);
  const list = parseHistoryNumber(row.list_price_cad);
  const inventoryStatus = normalizeInventoryStatus(row);
  const isSold = inventoryStatus === 'sold';
  row.inventory_status = inventoryStatus;
  const extraCostFields = [
    'fees_cad',
    'shipping_cad',
    'tax_cad',
    'travel_cost_cad',
    'repair_cost_cad',
    'other_cost_cad',
  ];
  const extraCosts = extraCostFields
    .map((field) => parseHistoryNumber(row[field]) || 0)
    .reduce((sum, value) => sum + value, 0);
  const netCost = purchase !== null || extraCosts > 0 ? (purchase || 0) + extraCosts : null;
  if (netCost !== null) {
    row.net_cost_cad = formatHistoryNumber(netCost, 0);
  }

  if (isSold && sold === null && list !== null) {
    sold = list;
    row.sold_price_cad = formatHistoryNumber(sold, 0);
  }

  const expectedSell = (isSold ? sold : null) ?? list;
  if (expectedSell !== null) {
    row.expected_sell_price_cad = formatHistoryNumber(expectedSell, 0);
  }
  if (expectedSell !== null && netCost !== null) {
    row.expected_net_margin_cad = formatHistoryNumber(expectedSell - netCost, 0);
  }
  if (isSold && sold !== null && netCost !== null) {
    const profit = sold - netCost;
    row.realized_profit_cad = formatHistoryNumber(profit, 0);
    row.roi_percent = netCost > 0 ? formatHistoryNumber((profit / netCost) * 100, 1) : '';
    row.outcome = profit > 0 ? 'sold_profitable' : profit < 0 ? 'loss' : 'sold_break_even';
    row.decision = 'sold';
  } else if (!isSold) {
    row.realized_profit_cad = '';
    row.roi_percent = '';
    if (!row.outcome || row.outcome === 'sold_profitable' || row.outcome === 'sold_break_even' || row.outcome === 'loss') {
      row.outcome = 'pending';
    }
    if (row.decision === 'sold') {
      row.decision = 'bought';
    }
  } else if (!row.outcome) {
    row.outcome = 'pending';
  }

  const startDate = row.listed_at || row.purchase_at || row.decision_at;
  row.days_to_sell = daysBetweenDates(startDate, row.sold_at);
  return row;
}

function sanitizePurchaseHistoryRow(input, fields, existingRows) {
  const row = Object.fromEntries(fields.map((field) => [field, String(input?.[field] ?? '').trim()]));
  const now = new Date().toISOString();
  row.record_id ||= nextPurchaseHistoryRecordId(existingRows);
  row.record_version ||= '1';
  row.record_source ||= 'manual';
  row.source_platform ||= 'other';
  row.transaction_type ||= 'buy';
  row.inventory_status ||= normalizeInventoryStatus(row);
  row.decision ||= row.inventory_status === 'sold' ? 'sold' : 'bought';
  row.outcome ||= 'pending';
  row.category ||= 'camera_gear';
  row.subcategory ||= 'camera_body';
  row.bundle_type ||= 'single';
  row.seller_type ||= 'unknown';
  row.location_region ||= 'BC';
  row.location_country ||= 'CA';
  row.confidence_score ||= '0.75';
  row.price_confidence_score ||= row.sold_price_cad ? '0.9' : '0.7';
  row.identity_confidence_score ||= '0.85';
  row.condition_risk_score ||= '0.2';
  row.seller_risk_score ||= '0.1';
  row.watchlist_match ||= 'true';
  row.created_at ||= now;
  row.updated_at = now;
  if (!row.title) {
    row.title = [row.brand, row.model, row.variant].filter(Boolean).join(' ');
  }
  if (!row.canonical_key) {
    row.canonical_key = [row.brand, row.model, row.mount]
      .filter(Boolean)
      .join('-')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }
  return applyPurchaseHistoryCalculations(row);
}

function purchaseHistoryPayload(db, access, requestedDocumentId = '') {
  const fields = readTradingHistoryFields();
  const documents = ensurePurchaseHistorySeedDocument(db, fields);
  const document = selectedPurchaseHistoryDocument(db, requestedDocumentId, fields);
  const dbRows = document
    ? attachPurchaseHistoryListingLinks(db, listPurchaseHistoryRows(db, document.document_id), document.document_id)
    : [];
  const rows = historyDbRowsToCsvRows(dbRows, fields);
  return {
    fields,
    documents,
    document,
    rows,
    stats: {
      totalRows: rows.length,
    },
    auth: authPayloadForAccess(access),
  };
}

function relationshipLabel(value) {
  return value === 'same_listing' ? 'same listing' : 'same model';
}

function addManualListingLink(db, body = {}) {
  const documentId = String(body.documentId || body.document_id || '').trim();
  const recordId = String(body.recordId || body.record_id || '').trim();
  const sourceUrl = String(body.url || body.href || '').trim();
  const listingId = extractListingId(sourceUrl);
  if (!documentId || !recordId) {
    const error = new Error('Choose an inventory record before linking a listing.');
    error.statusCode = 400;
    throw error;
  }
  if (!listingId) {
    const error = new Error('Expected a Facebook Marketplace item URL.');
    error.statusCode = 400;
    throw error;
  }
  const href = canonicalizeListingUrl(sourceUrl);
  const relationshipType = String(body.relationshipType || body.relationship_type || 'same_model')
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, '_') === 'same_listing'
    ? 'same_listing'
    : 'same_model';
  const linkedAt = new Date().toISOString();
  const inventoryRow = listPurchaseHistoryRows(db, documentId).find((row) => row.record_id === recordId);
  if (!inventoryRow) {
    const error = new Error(`Unknown purchase history record: ${recordId}`);
    error.statusCode = 404;
    throw error;
  }
  const inventoryData = inventoryRow.data || {};
  const title = inventoryData.title || inventoryRow.title || [inventoryData.brand, inventoryData.model].filter(Boolean).join(' ');
  const listingResult = upsertHomepageListingWithStatus(db, {
    listingId,
    href,
    title,
    text: [
      relationshipLabel(relationshipType),
      inventoryData.brand || '',
      inventoryData.model || '',
      inventoryData.mount || '',
    ].filter(Boolean).join(' / '),
    source: 'manual',
    sourceKeyword: relationshipType,
  }, {
    source: 'manual',
    sourceKeyword: relationshipType,
    seenAt: linkedAt,
  });
  appendListingEvent(db, {
    listingId,
    eventType: 'listing_observed',
    eventAt: linkedAt,
    workerId: 'manual',
    sourceUrl: href,
    status: listingResult.row?.detail_status || 'pending',
    content: {
      listingId,
      href,
      source: 'manual',
      relationshipType,
      documentId,
      recordId,
    },
  });
  const link = upsertPurchaseHistoryListingLink(db, {
    documentId,
    recordId,
    listingId,
    href,
    relationshipType,
    note: body.note || '',
  }, {
    linkedAt,
  });
  let fetch = null;
  if (body.fetchNow) {
    fetch = resolveListingsFromViewer(db, {
      mode: 'listing',
      listingId,
      runtimeArgs: body.runtimeArgs,
    });
  }
  return {
    listing: listingResult.row,
    link,
    fetch,
  };
}

function addManualBacklogListing(db, body = {}) {
  const sourceUrl = String(body.url || body.href || '').trim();
  const listingId = extractListingId(sourceUrl);
  if (!listingId) {
    const error = new Error('Expected a Facebook Marketplace item URL.');
    error.statusCode = 400;
    throw error;
  }
  const href = canonicalizeListingUrl(sourceUrl);
  const addedAt = new Date().toISOString();
  const title = String(body.title || '').trim();
  const sourceKeyword = String(body.sourceKeyword || body.source_keyword || 'manual_url').trim() || 'manual_url';
  const listingResult = upsertHomepageListingWithStatus(db, {
    listingId,
    href,
    title,
    text: title || 'Manually added Marketplace URL',
    source: 'manual',
    sourceKeyword,
  }, {
    source: 'manual',
    sourceKeyword,
    seenAt: addedAt,
  });
  appendListingEvent(db, {
    listingId,
    eventType: 'listing_observed',
    eventAt: addedAt,
    workerId: 'manual',
    sourceUrl: href,
    status: listingResult.row?.detail_status || 'pending',
    content: {
      listingId,
      href,
      source: 'manual',
      sourceKeyword,
    },
  });
  let fetch = null;
  if (body.fetchNow) {
    fetch = resolveListingsFromViewer(db, {
      mode: 'listing',
      listingId,
      runtimeArgs: body.runtimeArgs,
    });
  }
  return {
    listing: listingResult.row,
    outcome: listingResult.outcome,
    fetch,
  };
}

function writeCsv(response, filename, rows, fields) {
  response.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
  });
  response.end(`${renderCsv(rows, fields)}\n`);
}

function writeAuthError(response, access) {
  if (!access.role) {
    writeJson(response, 401, { error: 'Missing or invalid API token' });
    return;
  }
  writeJson(response, 403, { error: 'Read-only token cannot perform this action' });
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

function isPublicScriptOrStylePath(filePath) {
  return ['.css', '.js', '.mjs'].includes(path.extname(filePath).toLowerCase());
}

function requireReadAccess(response, access) {
  if (access.role) {
    return true;
  }
  writeAuthError(response, access);
  return false;
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
  const screenshotPath = event?.screenshot_path || event?.content?.screenshotPath || event?.content?.screenshot_path || event?.listing?.screenshot_path || '';
  const snapshotPath = event?.snapshot_path || event?.content?.snapshotPath || event?.content?.snapshot_path || event?.listing?.snapshot_path || '';
  return {
    ...event,
    screenshotPath,
    snapshotPath,
    screenshotUrl: formatPathLink(screenshotPath),
    snapshotUrl: formatPathLink(snapshotPath),
  };
}

function enrichMatchQueueItemPaths(item) {
  if (!item) {
    return item;
  }
  return {
    ...item,
    screenshotPath: item.screenshot_path || '',
    snapshotPath: item.snapshot_path || '',
    screenshotUrl: formatPathLink(item.screenshot_path),
    snapshotUrl: formatPathLink(item.snapshot_path),
  };
}

function safeWorkerPathSegment(workerId) {
  return String(workerId || 'worker')
    .replace(/[^a-z0-9_.-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 160) || 'worker';
}

function listWorkerScreenshots(workerId, options = {}) {
  const limit = options.limit || 100;
  const directory = path.join(WORKER_SCREENSHOT_ROOT, safeWorkerPathSegment(workerId));
  let entries = [];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  return entries
    .filter((entry) => entry.isFile() && /\.(?:png|jpe?g)$/i.test(entry.name))
    .map((entry) => {
      const filePath = path.join(directory, entry.name);
      const stat = fs.statSync(filePath);
      return {
        name: entry.name,
        path: filePath,
        url: formatPathLink(filePath),
        capturedAt: stat.mtime.toISOString(),
        size: stat.size,
      };
    })
    .sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt))
    .slice(0, limit);
}

function startPurchaseHistoryMatchScanner(db, options = {}) {
  const intervalMs = Number.isFinite(options.intervalMs)
    ? Math.max(30_000, options.intervalMs)
    : HISTORY_MATCH_SCAN_INTERVAL_MS;
  let timer = null;
  let stopped = false;
  let inFlight = false;

  const schedule = (delay = intervalMs) => {
    if (stopped) return;
    timer = setTimeout(tick, delay);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  };

  const tick = () => {
    if (stopped) return;
    if (inFlight) {
      schedule(intervalMs);
      return;
    }
    inFlight = true;
    try {
      const result = scanPurchaseHistoryListingMatches(db, {
        limit: HISTORY_MATCH_SCAN_BATCH_SIZE,
        actor: 'history-watch-scheduler',
      });
      if (result.matched > 0 || result.queued > 0) {
        process.stdout.write(
          `[${new Date().toISOString()}] history_match_scan scanned=${result.scanned} matched=${result.matched} queued=${result.queued}\n`,
        );
      }
    } catch (error) {
      process.stderr.write(
        `[${new Date().toISOString()}] history_match_scan_error ${error instanceof Error ? error.message : String(error)}\n`,
      );
    } finally {
      inFlight = false;
      schedule(intervalMs);
    }
  };

  schedule(Math.min(15_000, intervalMs));
  return () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
    }
  };
}

function createServer(options) {
  const { db } = openMarketplaceHomepageDatabase(options.dbPath);
  const stopPurchaseHistoryMatchScanner = startPurchaseHistoryMatchScanner(db);

  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    const access = accessForRequest(options, request, requestUrl);

    if (requestUrl.pathname === '/healthz') {
      writeJson(response, 200, {
        ok: true,
        service: 'marketplace-homepage-monitor',
      });
      return;
    }

    if (requestUrl.pathname === '/') {
      serveStaticFrontend(response, 'index.html');
      return;
    }

    if (requestUrl.pathname.startsWith('/app/')) {
      const relativePath = decodeURIComponent(requestUrl.pathname.replace(/^\/app\//, ''));
      if (!isPublicScriptOrStylePath(relativePath) && !requireReadAccess(response, access)) {
        return;
      }
      serveStaticFrontend(response, relativePath);
      return;
    }

    if (requestUrl.pathname.startsWith('/vendor/tabulator/')) {
      const relativePath = decodeURIComponent(requestUrl.pathname.replace(/^\/vendor\/tabulator\//, ''));
      if (!isPublicScriptOrStylePath(relativePath) && !requireReadAccess(response, access)) {
        return;
      }
      serveVendorAsset(response, relativePath);
      return;
    }

    if (requestUrl.pathname.startsWith('/api/') && !access.role) {
      writeAuthError(response, access);
      return;
    }

    if (requestUrl.pathname === '/api/summary') {
      if (access.canWrite) {
        refreshResolveQueueRunStatuses(db);
      }
      const total = db.prepare('SELECT COUNT(*) AS total FROM homepage_listings').get().total;
      const latest = db.prepare('SELECT MAX(last_seen_at) AS latest_seen_at FROM homepage_listings').get();
      writeJson(response, 200, {
        dbPath: options.dbPath,
        totalRows: total,
        latestSeenAt: latest.latest_seen_at,
        queueCounts: getHomepageListingCounts(db),
        resolveQueueCounts: getResolveQueueCounts(db),
        workerStats: getWorkflowRuntimeSummary(db, { reconcile: access.canWrite }),
        auth: authPayloadForAccess(access),
      });
      return;
    }

    if (requestUrl.pathname === '/api/query-fields') {
      writeJson(response, 200, {
        fields: QUERY_FIELDS,
      });
      return;
    }

    if (requestUrl.pathname === '/api/query/complete' && request.method === 'POST') {
      try {
        const body = await readRequestJson(request);
        writeJson(response, 200, completeLiteKql({
          source: body.source || 'listings',
          query: body.query || '',
          cursor: body.cursor,
        }));
      } catch (error) {
        writeJson(response, error.statusCode || 500, {
          error: error.message,
          diagnostics: error.diagnostics || [],
        });
      }
      return;
    }

    if (requestUrl.pathname === '/api/purchase-history/documents' && request.method === 'GET') {
      try {
        const fields = readTradingHistoryFields();
        writeJson(response, 200, {
          fields,
          documents: ensurePurchaseHistorySeedDocument(db, fields),
          auth: authPayloadForAccess(access),
        });
      } catch (error) {
        writeJson(response, error.statusCode || 500, { error: error.message });
      }
      return;
    }

    if (requestUrl.pathname === '/api/purchase-history/documents' && request.method === 'POST') {
      if (!access.canWrite) {
        writeAuthError(response, access);
        return;
      }
      try {
        const body = await readRequestJson(request);
        const document = createPurchaseHistoryDocument(db, {
          name: body.name || 'Purchase History',
          description: body.description || '',
        });
        writeJson(response, 201, {
          ...purchaseHistoryPayload(db, access, document.document_id),
          document,
        });
      } catch (error) {
        writeJson(response, error.statusCode || 400, { error: error.message });
      }
      return;
    }

    if (requestUrl.pathname === '/api/purchase-history/export' && request.method === 'GET') {
      try {
        const fields = readTradingHistoryFields();
        const document = selectedPurchaseHistoryDocument(db, requestUrl.searchParams.get('documentId') || '', fields);
        if (!document) {
          writeJson(response, 404, { error: 'No purchase history document available' });
          return;
        }
        const rows = historyDbRowsToCsvRows(listPurchaseHistoryRows(db, document.document_id), fields);
        writeCsv(response, `${document.document_id}.csv`, rows, fields);
      } catch (error) {
        writeJson(response, error.statusCode || 500, { error: error.message });
      }
      return;
    }

    if (requestUrl.pathname === '/api/purchase-history/import' && request.method === 'POST') {
      if (!access.canWrite) {
        writeAuthError(response, access);
        return;
      }
      try {
        const body = await readRequestJson(request);
        const fields = readTradingHistoryFields();
        ensurePurchaseHistorySeedDocument(db, fields);
        let document = body.createDocument
          ? createPurchaseHistoryDocument(db, {
            name: body.name || 'Imported History',
            description: body.description || 'Imported from CSV',
          })
          : selectedPurchaseHistoryDocument(db, body.documentId || '', fields);
        if (!document) {
          document = createPurchaseHistoryDocument(db, {
            name: body.name || 'Imported History',
            description: body.description || 'Imported from CSV',
          });
        }
        const existingRows = listPurchaseHistoryRows(db, document.document_id).map((row) => row.data);
        const importedRows = parseTradingHistoryCsv(body.csvText || '', fields);
        const rows = [...existingRows];
        const sanitizedRows = importedRows.map((row) => {
          const sanitized = sanitizePurchaseHistoryRow(row, fields, rows);
          rows.push(sanitized);
          return sanitized;
        });
        const result = upsertPurchaseHistoryRows(db, document.document_id, sanitizedRows);
        writeJson(response, 201, {
          ...purchaseHistoryPayload(db, access, document.document_id),
          import: {
            insertedRows: result.inserted,
            updatedRows: result.updated,
            totalRows: result.total,
          },
        });
      } catch (error) {
        writeJson(response, error.statusCode || 400, { error: error.message });
      }
      return;
    }

    if (requestUrl.pathname === '/api/purchase-history/merge' && request.method === 'POST') {
      if (!access.canWrite) {
        writeAuthError(response, access);
        return;
      }
      try {
        const body = await readRequestJson(request);
        const result = mergePurchaseHistoryDocuments(db, {
          sourceDocumentId: body.sourceDocumentId,
          targetDocumentId: body.targetDocumentId,
        });
        writeJson(response, 200, {
          ...purchaseHistoryPayload(db, access, body.targetDocumentId),
          merge: result,
        });
      } catch (error) {
        writeJson(response, error.statusCode || 400, { error: error.message });
      }
      return;
    }

    if (requestUrl.pathname === '/api/purchase-history/listing-links' && request.method === 'POST') {
      if (!access.canWrite) {
        writeAuthError(response, access);
        return;
      }
      try {
        const body = await readRequestJson(request);
        const result = addManualListingLink(db, body);
        writeJson(response, 201, {
          ...purchaseHistoryPayload(db, access, body.documentId || body.document_id || ''),
          listingLink: result,
          backlog: {
            rows: listBacklogCandidates(db, {
              statusFilter: 'all',
              sourceFilter: 'manual',
              limit: 25,
            }),
            resolveQueueCounts: getResolveQueueCounts(db),
          },
        });
      } catch (error) {
        writeJson(response, error.statusCode || 400, { error: error.message });
      }
      return;
    }

    if (requestUrl.pathname === '/api/purchase-history/events' && request.method === 'GET') {
      try {
        writeJson(response, 200, {
          events: listPurchaseHistoryEvents(db, {
            documentId: requestUrl.searchParams.get('documentId') || '',
            recordId: requestUrl.searchParams.get('recordId') || '',
          }),
          auth: authPayloadForAccess(access),
        });
      } catch (error) {
        writeJson(response, error.statusCode || 500, { error: error.message });
      }
      return;
    }

    if (requestUrl.pathname === '/api/events' && request.method === 'GET') {
      try {
        const source = requestUrl.searchParams.get('source') || 'all';
        const limit = Number.parseInt(requestUrl.searchParams.get('limit') || '200', 10);
        const offset = Number.parseInt(requestUrl.searchParams.get('offset') || '0', 10);
        writeJson(response, 200, {
          events: listEventRegistry(db, {
            source,
            limit,
            offset,
          }),
          total: countEventRegistry(db, { source }),
          limit,
          offset,
          auth: authPayloadForAccess(access),
        });
      } catch (error) {
        writeJson(response, error.statusCode || 500, { error: error.message });
      }
      return;
    }

    if (requestUrl.pathname === '/api/purchase-history' && request.method === 'GET') {
      try {
        writeJson(response, 200, purchaseHistoryPayload(db, access, requestUrl.searchParams.get('documentId') || ''));
      } catch (error) {
        writeJson(response, error.statusCode || 500, { error: error.message });
      }
      return;
    }

    if (requestUrl.pathname === '/api/purchase-history' && request.method === 'POST') {
      if (!access.canWrite) {
        writeAuthError(response, access);
        return;
      }
      try {
        const body = await readRequestJson(request);
        const fields = readTradingHistoryFields();
        const document = selectedPurchaseHistoryDocument(db, body.documentId || '', fields);
        if (!document) {
          writeJson(response, 404, { error: 'No purchase history document available' });
          return;
        }
        const existingRows = listPurchaseHistoryRows(db, document.document_id).map((row) => row.data);
        const incomingRows = Array.isArray(body.rows) ? body.rows : [body.row || body];
        const rows = [...existingRows];
        const sanitizedRows = incomingRows.map((incomingRow) => {
          const sanitized = sanitizePurchaseHistoryRow(incomingRow, fields, rows);
          rows.push(sanitized);
          return sanitized;
        });
        const result = upsertPurchaseHistoryRows(db, document.document_id, sanitizedRows);
        writeJson(response, 201, {
          ...purchaseHistoryPayload(db, access, document.document_id),
          write: {
            insertedRows: result.inserted,
            updatedRows: result.updated,
            totalRows: result.total,
          },
        });
      } catch (error) {
        writeJson(response, error.statusCode || 400, { error: error.message });
      }
      return;
    }

    if (requestUrl.pathname === '/api/listings') {
      const query = requestUrl.searchParams.get('q') || '';
      const limit = requestUrl.searchParams.get('limit') || '50';
      const offset = requestUrl.searchParams.get('offset') || '0';
      const sort = requestUrl.searchParams.get('sort') || '';
      const sortDirection = requestUrl.searchParams.get('sortDir') || '';
      const excludeListingIds = normalizeListingIds(requestUrl.searchParams.getAll('excludeListingId'));

      try {
        const startedAt = process.hrtime.bigint();
        const listingsQuery = buildListingsQuery({ query, limit, offset, sort, sortDirection, excludeListingIds });
        const countQuery = buildCountQuery({ query, excludeListingIds });
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
        writeJson(response, error.statusCode || 400, {
          error: error.message,
          query,
          diagnostics: error.diagnostics || [],
        });
      }
      return;
    }

    if (requestUrl.pathname === '/api/listings/manual' && request.method === 'POST') {
      if (!access.canWrite) {
        writeAuthError(response, access);
        return;
      }
      try {
        const body = await readRequestJson(request);
        const result = addManualBacklogListing(db, body);
        writeJson(response, 201, {
          manualListing: result,
          backlog: {
            rows: listBacklogCandidates(db, {
              statusFilter: 'all',
              sourceFilter: 'manual',
              limit: 25,
            }),
            resolveQueueCounts: getResolveQueueCounts(db),
          },
        });
      } catch (error) {
        writeJson(response, error.statusCode || 400, { error: error.message });
      }
      return;
    }

    if (requestUrl.pathname === '/api/backlog') {
      try {
        const limit = parseIntegerFlag(requestUrl.searchParams.get('limit') || '50', 'limit', 1);
        const maxAttemptsRaw = requestUrl.searchParams.get('maxAttempts') || '';
        const retryDelayRaw = requestUrl.searchParams.get('retryDelaySeconds') || '';
        const maxAttempts = maxAttemptsRaw
          ? parseIntegerFlag(maxAttemptsRaw, 'maxAttempts', 1)
          : undefined;
        const retryDelaySeconds = retryDelayRaw
          ? parseIntegerFlag(retryDelayRaw, 'retryDelaySeconds', 0)
          : 0;
        const options = {
          statusFilter: requestUrl.searchParams.get('statusFilter') || 'all',
          sourceFilter: requestUrl.searchParams.get('sourceFilter') || '',
          keywordFilter: requestUrl.searchParams.get('keywordFilter') || '',
          backlogOrder: requestUrl.searchParams.get('backlogOrder') || 'priority',
          seenTimeField: requestUrl.searchParams.get('seenTimeField') || 'last_seen',
          seenAfter: requestUrl.searchParams.get('seenAfter') || '',
          seenBefore: requestUrl.searchParams.get('seenBefore') || '',
          limit,
          retryDelaySeconds,
          ...(maxAttempts !== undefined ? { maxAttempts } : {}),
        };
        if (access.canWrite) {
          refreshResolveQueueRunStatuses(db);
        }
        const startedAt = process.hrtime.bigint();
        const rows = listBacklogCandidates(db, options);
        const elapsedMs = Number((process.hrtime.bigint() - startedAt) / 1000000n);
        writeJson(response, 200, {
          options,
          rows,
          stats: {
            elapsedMs,
            returnedRows: rows.length,
          },
          resolveQueueCounts: getResolveQueueCounts(db),
        });
      } catch (error) {
        writeJson(response, error.statusCode || 400, { error: error.message });
      }
      return;
    }

    if (requestUrl.pathname === '/api/listings/resolve' && request.method === 'POST') {
      if (!access.canWrite) {
        writeAuthError(response, access);
        return;
      }
      try {
        const body = await readRequestJson(request);
        const result = resolveListingsFromViewer(db, body);
        writeJson(response, 201, result);
      } catch (error) {
        writeJson(response, error.statusCode || 500, { error: error.message });
      }
      return;
    }

    if (requestUrl.pathname === '/api/listings/resolver-status' && request.method === 'GET') {
      if (access.canWrite) {
        refreshResolveQueueRunStatuses(db);
      }
      const listingIds = [
        ...requestUrl.searchParams.getAll('listingId'),
        ...String(requestUrl.searchParams.get('listingIds') || '').split(','),
      ];
      writeJson(response, 200, {
        items: listListingResolverAssignments(db, normalizeListingIds(listingIds)),
      });
      return;
    }

    if (requestUrl.pathname === '/api/resolve-queue' && request.method === 'GET') {
      if (access.canWrite) {
        refreshResolveQueueRunStatuses(db);
      }
      writeJson(response, 200, {
        items: listResolveQueueItems(db),
        counts: getResolveQueueCounts(db),
        events: listResolveQueueEvents(db, { limit: 30 }),
      });
      return;
    }

    if (requestUrl.pathname === '/api/resolve-queue' && request.method === 'POST') {
      if (!access.canWrite) {
        writeAuthError(response, access);
        return;
      }
      try {
        const body = await readRequestJson(request);
        const result = addResolveQueueItems(db, normalizeListingIds(body.listingIds || body.listingId), {
          actor: 'viewer',
        });
        writeJson(response, 201, {
          ...result,
          events: listResolveQueueEvents(db, { limit: 30 }),
        });
      } catch (error) {
        writeJson(response, error.statusCode || 500, { error: error.message });
      }
      return;
    }

    if (requestUrl.pathname === '/api/resolve-queue' && request.method === 'DELETE') {
      if (!access.canWrite) {
        writeAuthError(response, access);
        return;
      }
      try {
        const body = await readRequestJson(request);
        const result = clearResolveQueueItems(db, normalizeListingIds(body.listingIds || body.listingId), {
          actor: 'viewer',
        });
        writeJson(response, 200, {
          ...result,
          events: listResolveQueueEvents(db, { limit: 30 }),
        });
      } catch (error) {
        writeJson(response, error.statusCode || 500, { error: error.message });
      }
      return;
    }

    if (requestUrl.pathname === '/api/resolve-queue/run' && request.method === 'POST') {
      if (!access.canWrite) {
        writeAuthError(response, access);
        return;
      }
      try {
        const body = await readRequestJson(request);
        const result = resolveQueuedListingsFromViewer(db, body);
        writeJson(response, 201, result);
      } catch (error) {
        writeJson(response, error.statusCode || 500, { error: error.message });
      }
      return;
    }

    if (requestUrl.pathname === '/api/purchase-history-match-queue' && request.method === 'GET') {
      const status = requestUrl.searchParams.get('status') || 'queued';
      const limit = Number.parseInt(requestUrl.searchParams.get('limit') || '200', 10);
      const offset = Number.parseInt(requestUrl.searchParams.get('offset') || '0', 10);
      const listingId = requestUrl.searchParams.get('listingId') || '';
      const documentId = requestUrl.searchParams.get('documentId') || '';
      const recordId = requestUrl.searchParams.get('recordId') || '';
      const resolvedOnly = ['1', 'true', 'yes', 'resolved'].includes(String(requestUrl.searchParams.get('resolved') || '').toLowerCase());
      const filters = { status, listingId, documentId, recordId, resolvedOnly };
      writeJson(response, 200, {
        status,
        total: countPurchaseHistoryMatchQueue(db, filters),
        limit,
        offset,
        items: listPurchaseHistoryMatchQueue(db, { ...filters, limit, offset }).map(enrichMatchQueueItemPaths),
      });
      return;
    }

    if (requestUrl.pathname === '/api/purchase-history-match-queue/matches' && request.method === 'GET') {
      const limit = Number.parseInt(requestUrl.searchParams.get('limit') || '8', 10);
      const statuses = (requestUrl.searchParams.get('statuses') || 'queued')
        .split(',')
        .map((status) => status.trim())
        .filter(Boolean);
      const resolvedOnly = ['1', 'true', 'yes', 'resolved'].includes(String(requestUrl.searchParams.get('resolved') || '').toLowerCase());
      writeJson(response, 200, {
        statuses,
        resolvedOnly,
        total: countPurchaseHistoryMatchQueue(db, { status: statuses.length === 1 ? statuses[0] : 'queued', resolvedOnly }),
        limit,
        items: listRandomPurchaseHistoryMatches(db, { statuses, limit, resolvedOnly }).map(enrichMatchQueueItemPaths),
      });
      return;
    }

    if (requestUrl.pathname === '/api/purchase-history-match-queue/action' && request.method === 'POST') {
      if (!access.canWrite) {
        writeAuthError(response, access);
        return;
      }
      try {
        const body = await readRequestJson(request);
        const status = String(body.action || body.status || '').trim().toLowerCase() === 'save'
          ? 'saved'
          : String(body.action || body.status || '').trim().toLowerCase() === 'reject'
            ? 'dismissed'
            : String(body.status || body.action || '').trim().toLowerCase();
        const reason = [
          body.reason,
          body.customReason,
        ].filter(Boolean).join(': ');
        updatePurchaseHistoryMatchQueueStatus(db, {
          documentId: body.documentId || body.document_id,
          recordId: body.recordId || body.record_id,
          listingId: body.listingId || body.listing_id,
          status,
        }, {
          reason,
          customReason: body.customReason || '',
          actor: 'viewer',
        });
        const responseStatus = requestUrl.searchParams.get('status') || 'queued';
        const limit = Number.parseInt(requestUrl.searchParams.get('limit') || '200', 10);
        const offset = Number.parseInt(requestUrl.searchParams.get('offset') || '0', 10);
        writeJson(response, 200, {
          ok: true,
          status: responseStatus,
          total: countPurchaseHistoryMatchQueue(db, { status: responseStatus }),
          limit,
          offset,
          items: listPurchaseHistoryMatchQueue(db, { status: responseStatus, limit, offset }).map(enrichMatchQueueItemPaths),
        });
      } catch (error) {
        writeJson(response, error.statusCode || 400, { error: error.message });
      }
      return;
    }

    if (requestUrl.pathname === '/api/purchase-history-match-queue/scan' && request.method === 'POST') {
      if (!access.canWrite) {
        writeAuthError(response, access);
        return;
      }
      const result = scanPurchaseHistoryListingMatches(db, {
        limit: HISTORY_MATCH_SCAN_BATCH_SIZE,
        actor: 'history-watch-manual',
      });
      writeJson(response, 200, {
        ...result,
        total: countPurchaseHistoryMatchQueue(db, { status: 'queued' }),
        items: listPurchaseHistoryMatchQueue(db, { status: 'queued', limit: 200 }).map(enrichMatchQueueItemPaths),
      });
      return;
    }

    if (requestUrl.pathname === '/api/workflows/config' && request.method === 'GET') {
      writeJson(response, 200, {
        workflows: buildWorkflowDefinitions(),
      });
      return;
    }

    if (requestUrl.pathname === '/api/workflows' && request.method === 'GET') {
      const reconcile = requestUrl.searchParams.get('reconcile') !== '0';
      const includeStats = requestUrl.searchParams.get('stats') !== '0';
      const includeConfig = requestUrl.searchParams.get('config') !== '0';
      if (access.canWrite && reconcile) {
        refreshResolveQueueRunStatuses(db);
      }
      const payload = {
        processes: access.canWrite
          ? listManagedProcesses(db, { reconcile, includeStats })
          : publicWorkflowRunRecords(db, listWorkflowRuns(db, { limit: 50 }), { includeStats }),
      };
      if (includeConfig) {
        payload.workflows = buildWorkflowDefinitions();
      }
      writeJson(response, 200, payload);
      return;
    }

    if (requestUrl.pathname === '/api/credentials' && request.method === 'GET') {
      const result = getCredentialProfilesForUi();
      writeJson(response, result.error ? 500 : 200, result.error ? { error: result.error } : result);
      return;
    }

    if (requestUrl.pathname === '/api/credentials' && request.method === 'POST') {
      if (!access.canWrite) {
        writeAuthError(response, access);
        return;
      }
      try {
        const body = await readRequestJson(request);
        const result = upsertCredentialProfile(DEFAULT_CREDENTIALS_PATH, {
          id: body.id || body.email,
          label: body.label || body.email,
          email: body.email,
          password: body.password,
        }, {
          activate: body.activate !== false,
        });
        writeJson(response, 200, result);
      } catch (error) {
        writeJson(response, error.statusCode || 400, { error: error.message });
      }
      return;
    }

    if (requestUrl.pathname === '/api/credentials/active' && request.method === 'POST') {
      if (!access.canWrite) {
        writeAuthError(response, access);
        return;
      }
      try {
        const body = await readRequestJson(request);
        const result = setActiveCredentialProfile(DEFAULT_CREDENTIALS_PATH, normalizeCredentialProfileId(body.id));
        writeJson(response, 200, result);
      } catch (error) {
        writeJson(response, error.statusCode || 400, { error: error.message });
      }
      return;
    }

    if (requestUrl.pathname === '/api/workflows/reconcile' && request.method === 'POST') {
      if (!access.canWrite) {
        writeAuthError(response, access);
        return;
      }
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
      const processRecord = publicWorkflowRunRecordWithStats(db, run, {
        includeLogs: true,
        includeLatestEvents: true,
      });
      processRecord.screenshots = listWorkerScreenshots(workerId);
      writeJson(response, 200, {
        process: processRecord,
      });
      return;
    }

    const workerStatsMatch = requestUrl.pathname.match(/^\/api\/workflows\/([^/]+)\/stats$/);
    if (workerStatsMatch && request.method === 'GET') {
      const workerId = decodeURIComponent(workerStatsMatch[1]);
      const workerIds = resolveWorkerEventIdsForRun(db, workerId);
      const stats = getWorkerAuditEventStats(db, workerId, { workerIds });
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
      const eventType = requestUrl.searchParams.get('eventType') || '';
      const limit = Number.parseInt(requestUrl.searchParams.get('limit') || '50', 10);
      const workerIds = resolveWorkerEventIdsForRun(db, workerId);
      writeJson(response, 200, {
        workerId,
        category,
        eventType,
        workerIds,
        events: listWorkerAuditEvents(db, workerId, { category, eventType, limit, workerIds }).map(enrichEventPaths),
      });
      return;
    }

    const workerCommandsMatch = requestUrl.pathname.match(/^\/api\/workflows\/([^/]+)\/commands$/);
    if (workerCommandsMatch && request.method === 'POST') {
      if (!access.canWrite) {
        writeAuthError(response, access);
        return;
      }
      try {
        const workerId = decodeURIComponent(workerCommandsMatch[1]);
        const run = getWorkflowRun(db, workerId);
        if (!run) {
          writeJson(response, 404, { error: `Unknown workflow run: ${workerId}` });
          return;
        }
        const body = await readRequestJson(request);
        const command = await appendWorkerCommand(workerId, {
          type: body.type || body.command || body.action,
          payload: body.payload || {},
          actor: 'viewer',
        });
        writeJson(response, 202, {
          ok: true,
          command: {
            commandId: command.commandId,
            commandAt: command.commandAt,
            type: command.type,
            actor: command.actor,
          },
        });
      } catch (error) {
        writeJson(response, error.statusCode || 400, { error: error.message });
      }
      return;
    }

    if (requestUrl.pathname === '/api/workflows/start' && request.method === 'POST') {
      if (!access.canWrite) {
        writeAuthError(response, access);
        return;
      }
      try {
        const body = await readRequestJson(request);
        const started = startManagedWorkflow(db, body.workflowId, body.args);
        writeJson(response, 201, { process: started });
      } catch (error) {
        writeJson(response, error.statusCode || 500, { error: error.message });
      }
      return;
    }

    if (requestUrl.pathname === '/api/workflows/stop' && request.method === 'POST') {
      if (!access.canWrite) {
        writeAuthError(response, access);
        return;
      }
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
      if (!requireReadAccess(response, access)) {
        return;
      }
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
    stopPurchaseHistoryMatchScanner();
    closeMarketplaceHomepageDatabase(db);
  });

  return server;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const server = createServer(options);

  server.listen(options.port, options.host, () => {
    const baseUrl = `http://${options.host}:${options.port}`;
    process.stdout.write(`Marketplace homepage browser running at ${baseUrl}\n`);
    process.stdout.write(`Admin URL: ${baseUrl}/?token=${encodeURIComponent(options.adminToken)}\n`);
    process.stdout.write(`Read-only URL: ${baseUrl}/?token=${encodeURIComponent(options.readOnlyToken)}\n`);
    process.stdout.write(`DB: ${path.isAbsolute(options.dbPath) ? options.dbPath : path.join(process.cwd(), options.dbPath)}\n`);
  });

  process.once('SIGINT', () => server.close(() => process.exit(0)));
  process.once('SIGTERM', () => server.close(() => process.exit(0)));
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  normalizeWorkflowArgs,
  validateWorkflowStartArgs,
  buildDefaultArgsFromFields,
  fieldsForWorkflow,
  workflowConcurrencyLimit,
  workflowConcurrencyScope,
  isBrowserWorkerType,
  isExclusiveBrowserWorkerType,
};
