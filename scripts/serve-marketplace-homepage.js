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
  appendWorkflowEvent,
  insertWorkflowRun,
  runTransaction,
  updateWorkflowRun,
  getWorkflowRun,
  listWorkflowRuns,
  listWorkerParameterProfiles,
  getWorkerParameterProfile,
  upsertWorkerParameterProfile,
  deleteWorkerParameterProfile,
  listSummaryQueryCards,
  upsertSummaryQueryCard,
  deleteSummaryQueryCard,
  listSavedQueries,
  upsertSavedQuery,
  setSavedQueryOverview,
  deleteSavedQuery,
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
  buildListingsStatsQueries,
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
  createWorkerScheduler,
} = require('./worker-scheduler');
const {
  appendWorkerCommand,
} = require('./marketplace-worker-command-channel');

const FRONTEND_DIR = path.join(process.cwd(), 'frontend', 'marketplace-monitor');
const RESOLVE_BATCH_DIR = path.join(process.cwd(), 'artifacts', 'marketplace-homepage', 'resolve-batches');
const WORKER_SCREENSHOT_ROOT = path.join(process.cwd(), 'artifacts', 'marketplace-homepage', 'worker-screenshots');
const PERFORMANCE_REPORT_DIR = path.join(process.cwd(), 'output', 'perf');
const EVENT_REGISTRY_DEFAULT_LIMIT = 100;
const EVENT_REGISTRY_MAX_LIMIT = 500;
const EVENT_REGISTRY_ALL_SOURCE_WINDOW = 2500;
const TRADING_HISTORY_SCHEMA_PATH = path.join(process.cwd(), 'schemas', 'trading-history.schema.csv');
const PURCHASE_HISTORY_CSV_PATH = path.join(process.cwd(), 'output', 'trading-history.normalized.csv');
const DEFAULT_PURCHASE_HISTORY_DOCUMENT_ID = 'inventory-import';
const HISTORY_MATCH_SCAN_INTERVAL_MS = 60 * 60 * 1000;
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
      {
        id: 'collectionMode',
        label: 'Collection mode',
        kind: 'choice',
        defaultValue: 'feed',
        options: [
          { value: 'feed', label: 'Homepage feed', args: [] },
          { value: 'keywords', label: 'Keyword targets', args: [] },
        ],
      },
      {
        id: 'keywordTargets',
        label: 'Keyword targets',
        kind: 'textarea',
        editor: 'keywordTargets',
        flag: '--keyword-targets',
        defaultValue: '',
        activeWhen: { field: 'collectionMode', equals: 'keywords' },
      },
      { id: 'collectAll', label: 'Collect all visible rows', kind: 'boolean', flag: '--collect-all', defaultValue: true },
      { id: 'location', label: 'Location', kind: 'text', flag: '--location', defaultValue: '', options: MARKETPLACE_LOCATION_OPTIONS },
      { id: 'radiusMiles', label: 'Radius (miles)', kind: 'number', flag: '--radius-miles', defaultValue: '', min: 1 },
      { id: 'refreshSeconds', label: 'Refresh every (seconds)', kind: 'number', flag: '--refresh-seconds', defaultValue: 30, min: 1 },
      { id: 'refreshJitterMin', label: 'Refresh jitter low', kind: 'number', flag: '--refresh-jitter-min', defaultValue: 0.5, min: 0, step: 0.1 },
      { id: 'refreshJitterMax', label: 'Refresh jitter high', kind: 'number', flag: '--refresh-jitter-max', defaultValue: 1.5, min: 0, step: 0.1 },
      { id: 'maxRuntimeSeconds', label: 'Run window (seconds)', kind: 'number', flag: '--max-runtime-seconds', defaultValue: 120, min: 1 },
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
      { id: 'queryTargets', label: 'Keyword price targets', kind: 'textarea', editor: 'searchQueryTargets', flag: '--query-targets', defaultValue: '', activeWhen: { field: 'queryMode', equals: 'list' } },
      { id: 'randomWalksBetweenSeeds', label: 'Random walks between entries', kind: 'number', flag: '--random-walks-between-seeds', defaultValue: '', min: 0, activeWhen: { field: 'queryMode', equals: 'list' } },
      { id: 'location', label: 'Location', kind: 'text', flag: '--location', defaultValue: '', options: MARKETPLACE_LOCATION_OPTIONS },
      { id: 'radiusMiles', label: 'Radius (miles)', kind: 'number', flag: '--radius-miles', defaultValue: '', min: 1 },
      { id: 'minPrice', label: 'Min price', kind: 'number', flag: '--min-price', defaultValue: '', min: 0, activeWhen: { field: 'queryMode', equals: 'single' } },
      { id: 'maxPrice', label: 'Max price', kind: 'number', flag: '--max-price', defaultValue: '', min: 0, activeWhen: { field: 'queryMode', equals: 'single' } },
      { id: 'daysSinceListed', label: 'Listed within days', kind: 'number', flag: '--days-since-listed', defaultValue: '', min: 1 },
      { id: 'itemCondition', label: 'Condition filter', kind: 'text', flag: '--item-condition', defaultValue: '' },
      { id: 'collectAll', label: 'Collect all visible rows', kind: 'boolean', flag: '--collect-all', defaultValue: true },
      { id: 'refreshSeconds', label: 'Refresh every (seconds)', kind: 'number', flag: '--refresh-seconds', defaultValue: 30, min: 1 },
      { id: 'refreshJitterMin', label: 'Refresh jitter low', kind: 'number', flag: '--refresh-jitter-min', defaultValue: 0.5, min: 0, step: 0.1 },
      { id: 'refreshJitterMax', label: 'Refresh jitter high', kind: 'number', flag: '--refresh-jitter-max', defaultValue: 1.5, min: 0, step: 0.1 },
      { id: 'maxRuntimeSeconds', label: 'Run window (seconds)', kind: 'number', flag: '--max-runtime-seconds', defaultValue: 120, min: 1 },
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
      { id: 'retryDelaySeconds', label: 'Retry after (seconds)', kind: 'number', flag: '--retry-delay-seconds', defaultValue: 300, min: 0 },
      { id: 'itemDelaySeconds', label: 'Delay between items', kind: 'number', flag: '--item-delay-seconds', defaultValue: 8, min: 0, step: 0.5 },
      { id: 'itemJitterMin', label: 'Item delay jitter low', kind: 'number', flag: '--item-jitter-min', defaultValue: 0.5, min: 0, step: 0.1 },
      { id: 'itemJitterMax', label: 'Item delay jitter high', kind: 'number', flag: '--item-jitter-max', defaultValue: 1.5, min: 0, step: 0.1 },
      { id: 'resolveInactive', label: 'Resolve sold/pending signals', kind: 'boolean', flag: '--resolve-inactive', defaultValue: false },
      { id: 'workerId', label: 'Worker id', kind: 'text', flag: '--worker-id', defaultValue: '' },
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
      { id: 'pollIntervalSeconds', label: 'Check for work every (seconds)', kind: 'number', flag: '--poll-interval-seconds', defaultValue: 30, min: 1 },
      { id: 'pollJitterMin', label: 'Poll jitter low', kind: 'number', flag: '--poll-jitter-min', defaultValue: 0.5, min: 0, step: 0.1 },
      { id: 'pollJitterMax', label: 'Poll jitter high', kind: 'number', flag: '--poll-jitter-max', defaultValue: 1.5, min: 0, step: 0.1 },
      { id: 'limit', label: 'Max items per cycle', kind: 'number', flag: '--limit', defaultValue: '', min: 0 },
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
      { id: 'retryDelaySeconds', label: 'Retry after (seconds)', kind: 'number', flag: '--retry-delay-seconds', defaultValue: 300, min: 0 },
      { id: 'itemDelaySeconds', label: 'Delay between items', kind: 'number', flag: '--item-delay-seconds', defaultValue: 8, min: 0, step: 0.5 },
      { id: 'itemJitterMin', label: 'Item delay jitter low', kind: 'number', flag: '--item-jitter-min', defaultValue: 0.5, min: 0, step: 0.1 },
      { id: 'itemJitterMax', label: 'Item delay jitter high', kind: 'number', flag: '--item-jitter-max', defaultValue: 1.5, min: 0, step: 0.1 },
      { id: 'resolveInactive', label: 'Resolve sold/pending signals', kind: 'boolean', flag: '--resolve-inactive', defaultValue: false },
      { id: 'workerId', label: 'Worker id', kind: 'text', flag: '--worker-id', defaultValue: '' },
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
      { id: 'pollIntervalSeconds', label: 'Check for work every (seconds)', kind: 'number', flag: '--poll-interval-seconds', defaultValue: 300, min: 1 },
      { id: 'pollJitterMin', label: 'Poll jitter low', kind: 'number', flag: '--poll-jitter-min', defaultValue: 0.8, min: 0, step: 0.1 },
      { id: 'pollJitterMax', label: 'Poll jitter high', kind: 'number', flag: '--poll-jitter-max', defaultValue: 1.2, min: 0, step: 0.1 },
      { id: 'allRows', label: 'Re-index all resolved rows', kind: 'boolean', flag: '--all', defaultValue: false },
      { id: 'once', label: 'Run once', kind: 'boolean', flag: '--once', defaultValue: false },
      { id: 'workerId', label: 'Worker id', kind: 'text', flag: '--worker-id', defaultValue: '' },
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
      { id: 'loginTimeoutSeconds', label: 'Login timeout (seconds)', kind: 'number', flag: '--login-timeout-seconds', defaultValue: 900, min: 30 },
      { id: 'pollSeconds', label: 'Check login every (seconds)', kind: 'number', flag: '--poll-seconds', defaultValue: 3, min: 1 },
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

function elapsedMsSince(startedAt) {
  return Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6);
}

function logSlowSection(name, startedAt, details = {}) {
  const elapsedMs = elapsedMsSince(startedAt);
  if (elapsedMs < (details.thresholdMs || 250)) {
    return elapsedMs;
  }
  const detailText = Object.entries(details)
    .filter(([key]) => key !== 'thresholdMs')
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(' ');
  process.stderr.write(`[${nowIso()}] slow_section name=${name} elapsed_ms=${elapsedMs}${detailText ? ` ${detailText}` : ''}\n`);
  return elapsedMs;
}

function compactPerformanceApiRows(rows = []) {
  return rows.slice(0, 10).map((row) => ({
    path: String(row.path || ''),
    count: Number(row.count) || 0,
    p50Ms: Number(row.p50Ms) || 0,
    p95Ms: Number(row.p95Ms) || 0,
    maxMs: Number(row.maxMs) || 0,
  }));
}

function compactPerformanceStepRows(rows = []) {
  return rows.map((row) => ({
    name: String(row.name || ''),
    attempts: Number(row.attempts) || 0,
    ok: Number(row.ok) || 0,
    failed: Number(row.failed) || 0,
    skipped: Number(row.skipped) || 0,
    p50Ms: Number(row.p50Ms) || 0,
    p95Ms: Number(row.p95Ms) || 0,
    maxMs: Number(row.maxMs) || 0,
  }));
}

function normalizePerformanceReport(filePath, fileName) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  const stat = fs.statSync(filePath);
  return {
    file: fileName,
    updatedAt: stat.mtime.toISOString(),
    suite: String(parsed.suite || ''),
    timestamp: String(parsed.timestamp || stat.mtime.toISOString()),
    target: {
      url: String(parsed.target?.url || ''),
    },
    config: parsed.config || {},
    summary: {
      steps: compactPerformanceStepRows(parsed.summary?.steps || []),
      api: compactPerformanceApiRows(parsed.summary?.api || []),
      consoleIssueCount: Number(parsed.summary?.consoleIssueCount) || 0,
      failedRequestCount: Number(parsed.summary?.failedRequestCount) || 0,
      longTasks: parsed.summary?.longTasks || { count: 0, totalMs: 0, maxMs: 0 },
      maxCumulativeLayoutShift: Number(parsed.summary?.maxCumulativeLayoutShift) || 0,
    },
  };
}

function listPerformanceReports(options = {}) {
  const limit = Math.max(1, Math.min(Number.parseInt(options.limit || '10', 10) || 10, 50));
  if (!fs.existsSync(PERFORMANCE_REPORT_DIR)) {
    return { directory: PERFORMANCE_REPORT_DIR, reports: [] };
  }
  const files = fs.readdirSync(PERFORMANCE_REPORT_DIR)
    .filter((fileName) => fileName.endsWith('.json'))
    .map((fileName) => {
      const filePath = path.join(PERFORMANCE_REPORT_DIR, fileName);
      const stat = fs.statSync(filePath);
      return { fileName, filePath, mtimeMs: stat.mtimeMs };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, limit);
  const reports = files.flatMap(({ fileName, filePath }) => {
    try {
      return [normalizePerformanceReport(filePath, fileName)];
    } catch (error) {
      return [{
        file: fileName,
        updatedAt: new Date().toISOString(),
        error: error.message || 'Report could not be read.',
      }];
    }
  });
  return { directory: PERFORMANCE_REPORT_DIR, reports };
}

function performanceMonitorUrlForServer(options) {
  const loopbackHost = options.host === '0.0.0.0' || options.host === '::' ? '127.0.0.1' : options.host;
  const url = new URL(`http://${loopbackHost}:${options.port}/`);
  url.searchParams.set('token', options.adminToken);
  return url.toString();
}

function performanceReportFileName() {
  return `marketplace-ux-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
}

function runPerformanceMonitor(options, body = {}) {
  const timeoutMs = Math.max(5_000, Math.min(Number.parseInt(body.timeoutMs || '30000', 10) || 30_000, 120_000));
  const iterations = Math.max(1, Math.min(Number.parseInt(body.iterations || '1', 10) || 1, 3));
  const outputFile = performanceReportFileName();
  const outputPath = path.join(PERFORMANCE_REPORT_DIR, outputFile);
  const args = [
    path.join(process.cwd(), 'scripts', 'perf', 'marketplace-ux-monitor.js'),
    '--url',
    performanceMonitorUrlForServer(options),
    '--iterations',
    String(iterations),
    '--timeout-ms',
    String(timeoutMs),
    '--output',
    outputPath,
  ];

  if (body.skipWorkerDetail !== false) {
    args.push('--skip-worker-detail');
  }

  const hardTimeoutMs = Math.max(timeoutMs * 4, 90_000);
  fs.mkdirSync(PERFORMANCE_REPORT_DIR, { recursive: true });

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      if (!settled) {
        settled = true;
        reject(new Error(`Performance monitor timed out after ${Math.round(hardTimeoutMs / 1000)}s`));
      }
    }, hardTimeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 20_000) stdout = stdout.slice(-20_000);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `Performance monitor exited with code ${code}${signal ? ` signal ${signal}` : ''}`));
        return;
      }
      const report = fs.existsSync(outputPath)
        ? normalizePerformanceReport(outputPath, outputFile)
        : null;
      resolve({
        report,
        outputFile,
        stdout: stdout.trim().split('\n').slice(-20),
        stderr: stderr.trim().split('\n').filter(Boolean).slice(-20),
      });
    });
  });
}

function attachRequestTiming(request, response, requestUrl) {
  const startedAt = process.hrtime.bigint();
  response.on('finish', () => {
    const elapsedMs = elapsedMsSince(startedAt);
    const pathName = requestUrl.pathname;
    const tracked = pathName === '/healthz'
      || pathName === '/api/workflows'
      || pathName === '/api/workflows/start'
      || pathName === '/api/performance/run';
    if (!tracked && elapsedMs < 250) {
      return;
    }
    if (pathName === '/healthz' && elapsedMs < 250) {
      return;
    }
    process.stderr.write(
      `[${nowIso()}] request_timing method=${request.method} path=${pathName} status=${response.statusCode} elapsed_ms=${elapsedMs}\n`,
    );
  });
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

function scheduleManagedProcessSync(db, record, options = {}) {
  if (!record) {
    return;
  }
  if (options.immediate) {
    if (record.syncTimer) {
      clearTimeout(record.syncTimer);
      record.syncTimer = null;
    }
    record.syncPending = false;
    syncWorkflowRun(db, record, options.changes || {});
    return;
  }
  record.syncPending = true;
  if (record.syncTimer) {
    return;
  }
  record.syncTimer = setTimeout(() => {
    record.syncTimer = null;
    if (!record.syncPending) {
      return;
    }
    record.syncPending = false;
    syncWorkflowRun(db, record, options.changes || {});
  }, options.delayMs ?? 750);
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
    syncPending: false,
    syncTimer: null,
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

function syncWorkflowRunWithLifecycleEvent(db, record, changes = {}, eventOptions = {}) {
  return updateWorkflowRunWithLifecycleEvent(db, record.id, {
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
  }, eventOptions);
}

function workflowLifecycleEventForStatus(status, options = {}) {
  const normalizedStatus = String(status || '').trim();
  const workflowId = String(options.workflowId || '').trim();
  const workflow = WORKFLOWS[workflowId] || {};
  const workerType = workflow.workerType || workflowTypeForId(workflowId);
  const strategy = workflow.strategy || '';
  const baseContent = {
    workerType,
    strategy,
    workflowId,
    ...(options.pid ? { pid: options.pid } : {}),
    ...(options.script ? { script: options.script } : {}),
    ...(options.reason ? { reason: options.reason } : {}),
  };

  switch (normalizedStatus) {
    case 'running':
      return {
        eventType: 'worker_started',
        status: 'running',
        content: {
          ...baseContent,
          ...(Array.isArray(options.args) ? { args: options.args } : {}),
        },
      };
    case 'stopping':
      return {
        eventType: 'shutdown_requested',
        status: 'stopping',
        content: {
          ...baseContent,
          signal: options.signal || 'SIGTERM',
        },
      };
    case 'exited':
      return {
        eventType: 'worker_completed',
        status: 'exited',
        content: {
          ...baseContent,
          reason: options.reason || 'process_exited',
          ...(Number.isFinite(options.exitCode) ? { exitCode: options.exitCode } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        },
      };
    case 'terminated':
      return {
        eventType: 'worker_completed',
        status: 'terminated',
        content: {
          ...baseContent,
          reason: options.reason || 'shutdown',
          ...(Number.isFinite(options.exitCode) ? { exitCode: options.exitCode } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        },
      };
    case 'failed':
    case 'error':
    case 'lost':
    case 'stop_failed':
      return {
        eventType: 'worker_failed',
        status: normalizedStatus,
        content: {
          ...baseContent,
          reason: options.reason || normalizedStatus,
          ...(Number.isFinite(options.exitCode) ? { exitCode: options.exitCode } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        },
        error: options.error || '',
      };
    default:
      return null;
  }
}

function appendWorkflowLifecycleEvent(db, runId, lifecycleEvent, options = {}) {
  if (!lifecycleEvent) {
    return null;
  }
  return appendWorkflowEvent(db, {
    workflowRunId: runId,
    eventType: lifecycleEvent.eventType,
    eventAt: options.eventAt || nowIso(),
    status: lifecycleEvent.status,
    content: lifecycleEvent.content,
    error: lifecycleEvent.error || '',
  });
}

function insertWorkflowRunWithLifecycleEvent(db, run, options = {}) {
  return runTransaction(db, () => {
    const inserted = insertWorkflowRun(db, run);
    const lifecycleEvent = workflowLifecycleEventForStatus(inserted.status, {
      workflowId: inserted.workflow_id,
      args: inserted.args,
      pid: inserted.pid,
      script: inserted.script,
      reason: options.reason,
      eventAt: options.eventAt,
    });
    appendWorkflowLifecycleEvent(db, inserted.run_id, lifecycleEvent, options);
    return inserted;
  });
}

function updateWorkflowRunWithLifecycleEvent(db, runId, changes = {}, options = {}) {
  return runTransaction(db, () => {
    const updated = updateWorkflowRun(db, runId, changes);
    if (!updated) {
      return null;
    }
    const lifecycleEvent = workflowLifecycleEventForStatus(updated.status, {
      workflowId: updated.workflow_id,
      args: updated.args,
      pid: updated.pid,
      script: updated.script,
      signal: updated.signal || changes.signal || options.signal,
      exitCode: updated.exit_code,
      reason: options.reason,
      error: options.error,
    });
    appendWorkflowLifecycleEvent(db, updated.run_id, lifecycleEvent, options);
    return updated;
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
  const includeLatestEvents = options.includeLatestEvents === true;
  const workerIds = includeLatestEvents ? resolveWorkerEventIdsForRun(db, run.run_id) : null;
  const eventStats = includeLatestEvents
    ? getWorkerAuditEventStats(db, run.run_id, { workerIds, includeLatestEvents: true })
    : getWorkerAuditEventStats(db, run.run_id, { cacheOnly: true });
  record.runtimeStats = runtimeStatsFromEventStats(eventStats, record.runtimeStats);
  record.eventStats = includeLatestEvents
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
      updateWorkflowRunWithLifecycleEvent(db, run.run_id, {
        status: nextStatus,
        exitedAt: now,
        osCheckedAt: now,
        osAlive: false,
        logs: [
          ...(run.logs || []),
          `[${now}] workflow_reconciled status=${nextStatus} reason=process_missing previous_status=${run.status || ''} pid=${run.pid || ''}`,
        ],
      }, {
        eventAt: now,
        reason: 'process_missing',
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

function countListingsForSummaryQuery(db, query) {
  const countQuery = buildCountQuery({ query });
  return {
    total: db.prepare(countQuery.sql).get(...countQuery.params).total || 0,
    parsedQuery: countQuery.parsedQuery,
  };
}

function listSummaryQueryCardsWithCounts(db) {
  return listSummaryQueryCards(db).map((card) => {
    try {
      const result = countListingsForSummaryQuery(db, card.query);
      return {
        ...card,
        value: result.total,
        error: '',
      };
    } catch (error) {
      return {
        ...card,
        value: 0,
        error: error.message || 'Summary query could not be counted.',
      };
    }
  });
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

function argsWithoutManagedWorkerId(args) {
  const cleaned = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--worker-id') {
      index += 1;
      continue;
    }
    cleaned.push(args[index]);
  }
  return cleaned;
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

function validateKeywordTargetsValue(flag, value) {
  const text = String(value ?? '');
  if (!text || text.startsWith('--')) {
    throw workflowArgError(`Missing value for workflow argument ${flag}`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(text)) {
    throw workflowArgError(`Unsafe control character in workflow argument ${flag}`);
  }
  if (text.length > 12000) {
    throw workflowArgError(`Workflow argument value is too long for ${flag}`);
  }
  let rows;
  try {
    rows = JSON.parse(text);
  } catch (error) {
    throw workflowArgError(`Expected ${flag} to be JSON: ${error.message}`);
  }
  if (!Array.isArray(rows)) {
    throw workflowArgError(`Expected ${flag} to be a JSON array`);
  }
  for (const [index, row] of rows.entries()) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw workflowArgError(`Expected ${flag} row ${index + 1} to be an object`);
    }
    if (!String(row.keyword || row.query || '').trim()) {
      throw workflowArgError(`Expected ${flag} row ${index + 1} to include keyword`);
    }
    for (const name of ['minPrice', 'maxPrice', 'daysSinceListed', 'maxItems']) {
      const raw = row[name] ?? row[name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)];
      if (raw === undefined || raw === null || raw === '') {
        continue;
      }
      const numeric = Number(raw);
      if (!Number.isFinite(numeric) || numeric < 1) {
        throw workflowArgError(`Expected ${flag} row ${index + 1} ${name} to be >= 1`);
      }
    }
    if (row.minPrice !== undefined && row.maxPrice !== undefined && Number(row.maxPrice) < Number(row.minPrice)) {
      throw workflowArgError(`Expected ${flag} row ${index + 1} maxPrice to be >= minPrice`);
    }
  }
}

function validateSearchQueryTargetsValue(flag, value) {
  assertSafeWorkflowArgValue(flag, value);
  const text = String(value || '').trim();
  if (!text || text.startsWith('--')) {
    throw workflowArgError(`Missing value for workflow argument ${flag}`);
  }
  if (text.length > 12000) {
    throw workflowArgError(`Workflow argument value is too long for ${flag}`);
  }
  let rows;
  try {
    rows = JSON.parse(text);
  } catch (error) {
    throw workflowArgError(`Expected ${flag} to be JSON: ${error.message}`);
  }
  if (!Array.isArray(rows)) {
    throw workflowArgError(`Expected ${flag} to be a JSON array`);
  }
  for (const [index, row] of rows.entries()) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw workflowArgError(`Expected ${flag} row ${index + 1} to be an object`);
    }
    if (!String(row.keyword || row.query || '').trim()) {
      throw workflowArgError(`Expected ${flag} row ${index + 1} to include keyword`);
    }
    const minPrice = row.minPrice ?? row.min_price;
    const maxPrice = row.maxPrice ?? row.max_price;
    for (const [name, raw] of [['minPrice', minPrice], ['maxPrice', maxPrice]]) {
      if (raw === undefined || raw === null || raw === '') {
        continue;
      }
      const numeric = Number(raw);
      if (!Number.isFinite(numeric) || numeric < 0) {
        throw workflowArgError(`Expected ${flag} row ${index + 1} ${name} to be >= 0`);
      }
    }
    if (minPrice !== undefined && minPrice !== '' && maxPrice !== undefined && maxPrice !== '' && Number(maxPrice) < Number(minPrice)) {
      throw workflowArgError(`Expected ${flag} row ${index + 1} maxPrice to be >= minPrice`);
    }
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
    if (field.editor === 'keywordTargets') {
      addValueFlag(field.flag, (value) => validateKeywordTargetsValue(field.flag, value));
      continue;
    }
    if (field.editor === 'searchQueryTargets') {
      addValueFlag(field.flag, (value) => validateSearchQueryTargetsValue(field.flag, value));
      continue;
    }
    addValueFlag(field.flag, (value) => assertSafeWorkflowArgValue(field.flag, value));
  }

  if (workflow.id === 'search-explore') {
    addValueFlag('--queries', (value) => assertSafeWorkflowArgValue('--queries', value));
    addValueFlag('--seed-queries', (value) => assertSafeWorkflowArgValue('--seed-queries', value));
    addValueFlag('--seed-query-targets', (value) => validateSearchQueryTargetsValue('--seed-query-targets', value));
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

  insertWorkflowRunWithLifecycleEvent(db, {
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
    scheduleManagedProcessSync(db, record);
  });
  child.stderr.on('data', (chunk) => {
    appendProcessLog(record, chunk);
    scheduleManagedProcessSync(db, record);
  });
  child.on('error', (error) => {
    record.status = 'error';
    record.exitedAt = nowIso();
    appendProcessLog(record, `process_error ${error.message}`);
    updateWorkflowRunWithLifecycleEvent(db, record.id, {
      workflowId: record.workflowId,
      label: record.label,
      script: record.script,
      args: record.args,
      pid: record.pid,
      status: record.status,
      exitedAt: record.exitedAt,
      exitCode: record.exitCode,
      signal: record.signal,
      osAlive: false,
      osCheckedAt: nowIso(),
      logs: record.logs,
    }, {
      reason: 'process_error',
      error: error.message,
    });
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
    updateWorkflowRunWithLifecycleEvent(db, record.id, {
      workflowId: record.workflowId,
      label: record.label,
      script: record.script,
      args: record.args,
      pid: record.pid,
      status: record.status,
      exitedAt: record.exitedAt,
      exitCode: record.exitCode,
      signal: record.signal,
      osAlive: false,
      osCheckedAt: nowIso(),
      logs: record.logs,
    }, {
      reason: record.status === 'terminated' ? 'shutdown' : 'process_exit',
    });
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
      const stopRequestedAt = nowIso();
      updateWorkflowRunWithLifecycleEvent(db, processId, {
        status: 'stopping',
        osCheckedAt: stopRequestedAt,
        osAlive: true,
        logs: [...run.logs, `[${stopRequestedAt}] stop requested`],
      }, {
        eventAt: stopRequestedAt,
        reason: 'stop_requested',
        signal: 'SIGTERM',
      });
      try {
        if (process.platform === 'win32') {
          process.kill(run.pid, 'SIGTERM');
        } else {
          process.kill(-run.pid, 'SIGTERM');
        }
      } catch (error) {
        const stopFailedAt = nowIso();
        updateWorkflowRunWithLifecycleEvent(db, processId, {
          status: 'stop_failed',
          osCheckedAt: stopFailedAt,
          osAlive: pidIsAlive(run.pid),
          logs: [...run.logs, `[${stopRequestedAt}] stop requested`, `[${stopFailedAt}] stop_signal_error ${error.message}`],
        }, {
          eventAt: stopFailedAt,
          reason: 'stop_signal_error',
          error: error.message,
        });
        return publicWorkflowRunRecord(getWorkflowRun(db, processId));
      }
      return publicWorkflowRunRecord(getWorkflowRun(db, processId));
    }
    const nextStatus = alive
      ? 'stopping'
      : run.status === 'stopping'
        ? 'terminated'
        : 'lost';
    updateWorkflowRunWithLifecycleEvent(db, processId, {
      status: nextStatus,
      exitedAt: nextStatus === 'terminated' || nextStatus === 'lost' ? nowIso() : run.exited_at,
      osCheckedAt: nowIso(),
      osAlive: alive,
      logs: alive ? [...run.logs, `[${nowIso()}] stop requested`] : run.logs,
    }, {
      reason: alive
        ? 'stop_requested'
        : nextStatus === 'terminated'
          ? 'shutdown'
          : 'process_missing',
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
  syncWorkflowRunWithLifecycleEvent(db, record, {}, { reason: 'stop_requested', signal: 'SIGTERM' });
  try {
    if (process.platform === 'win32') {
      record.child.kill('SIGTERM');
    } else {
      process.kill(-record.child.pid, 'SIGTERM');
    }
  } catch (error) {
    appendProcessLog(record, `stop_signal_error ${error.message}`);
    record.status = 'stop_failed';
    syncWorkflowRunWithLifecycleEvent(db, record, {
      osCheckedAt: nowIso(),
      osAlive: pidIsAlive(record.pid),
    }, {
      reason: 'stop_signal_error',
      error: error.message,
    });
    return publicProcessRecord(record);
  }
  return publicProcessRecord(record);
}

function restartManagedWorkflow(db, processId) {
  const run = getWorkflowRun(db, processId);
  if (!run) {
    const error = new Error(`Unknown process: ${processId}`);
    error.statusCode = 404;
    throw error;
  }

  const workflow = WORKFLOWS[run.workflow_id];
  if (!workflow) {
    const error = new Error(`Unknown workflow: ${run.workflow_id}`);
    error.statusCode = 400;
    throw error;
  }

  const restartArgs = argsWithoutManagedWorkerId(run.args || []);
  const restarted = startManagedWorkflow(db, run.workflow_id, restartArgs, {
    allowInternalArgs: true,
  });
  return {
    ...restarted,
    restartedFrom: run.run_id,
  };
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

function normalizeBoundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(parsed, max));
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

function nullableNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeCountRows(rows) {
  return (rows || [])
    .map((row) => [String(row.label || 'unknown'), Number.parseInt(row.count, 10) || 0])
    .filter((item) => item[1] > 0);
}

function buildPriceHistogramFromBuckets(bucketRows, histogramQuery, pricedCount) {
  const min = nullableNumber(histogramQuery.min);
  const max = nullableNumber(histogramQuery.max);
  const total = Number.parseInt(pricedCount, 10) || 0;
  if (!total || min === null || max === null) {
    return [];
  }
  if (min === max) {
    return [{ min, max, count: total }];
  }

  const binCount = Math.max(2, histogramQuery.binCount || 6);
  const width = Number(histogramQuery.width) > 0 ? Number(histogramQuery.width) : (max - min) / binCount;
  const counts = new Map((bucketRows || []).map((row) => [
    Number.parseInt(row.bucket, 10) || 0,
    Number.parseInt(row.count, 10) || 0,
  ]));
  return Array.from({ length: binCount }, (_item, index) => ({
    min: min + width * index,
    max: index === binCount - 1 ? max : min + width * (index + 1),
    count: counts.get(index) || 0,
  }));
}

function readListingsResultStats(db, options = {}) {
  const queries = buildListingsStatsQueries(options);
  const summary = db.prepare(queries.priceSummary.sql).get(...queries.priceSummary.params) || {};
  const pricedCount = Number.parseInt(summary.pricedCount, 10) || 0;
  const priceMin = nullableNumber(summary.priceMin);
  const priceMax = nullableNumber(summary.priceMax);
  const histogramQuery = queries.priceHistogram({
    min: priceMin,
    max: priceMax,
    binCount: 6,
  });
  const histogramRows = pricedCount > 0
    ? db.prepare(histogramQuery.sql).all(...histogramQuery.params)
    : [];
  const median = pricedCount > 0
    ? db.prepare(queries.priceMedian.sql).get(...queries.priceMedian.params)
    : {};

  const totalRows = Number.parseInt(summary.totalRows, 10) || 0;
  return {
    pricedCount,
    unpricedCount: Math.max(0, totalRows - pricedCount),
    priceMin,
    priceMax,
    priceAverage: nullableNumber(summary.priceAverage),
    priceMedian: nullableNumber(median?.priceMedian),
    priceHistogram: buildPriceHistogramFromBuckets(histogramRows, histogramQuery, pricedCount),
    statusCounts: normalizeCountRows(db.prepare(queries.statusCounts.sql).all(...queries.statusCounts.params)),
    sourceCounts: normalizeCountRows(db.prepare(queries.sourceCounts.sql).all(...queries.sourceCounts.params)),
  };
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
  const scheduler = createWorkerScheduler({
    logger: (event) => {
      if (event.type === 'worker_scheduler_job_error') {
        process.stderr.write(
          `[${new Date().toISOString()}] ${event.type} job_id=${event.jobId} elapsed_ms=${event.elapsedMs} error=${JSON.stringify(event.error || '')}\n`,
        );
      }
    },
  });

  return scheduler.scheduleEvery('history-match-scan', intervalMs, async () => {
    const startedAt = process.hrtime.bigint();
    try {
      const result = scanPurchaseHistoryListingMatches(db, {
        limit: HISTORY_MATCH_SCAN_BATCH_SIZE,
        actor: 'history-watch-scheduler',
      });
      logSlowSection('history_match_scan', startedAt, {
        scanned: result.scanned,
        matched: result.matched,
        queued: result.queued,
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
    }
  }, {
    initialDelayMs: Number.isFinite(options.initialDelayMs) ? options.initialDelayMs : intervalMs,
  });
}

function createServer(options) {
  const { db } = openMarketplaceHomepageDatabase(options.dbPath);
  const stopPurchaseHistoryMatchScanner = startPurchaseHistoryMatchScanner(db);

  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    attachRequestTiming(request, response, requestUrl);
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

    if (requestUrl.pathname === '/api/performance/reports' && request.method === 'GET') {
      const limit = requestUrl.searchParams.get('limit') || '10';
      writeJson(response, 200, listPerformanceReports({ limit }));
      return;
    }

    if (requestUrl.pathname === '/api/performance/run' && request.method === 'POST') {
      if (!access.canWrite) {
        writeAuthError(response, access);
        return;
      }
      try {
        const body = await readRequestJson(request);
        const result = await runPerformanceMonitor(options, body);
        writeJson(response, 200, {
          ok: true,
          report: result.report,
          outputFile: result.outputFile,
          stdout: result.stdout,
          stderr: result.stderr,
        });
      } catch (error) {
        writeJson(response, 500, { error: error.message || 'Performance monitor failed.' });
      }
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
        summaryCards: listSummaryQueryCardsWithCounts(db),
        auth: authPayloadForAccess(access),
      });
      return;
    }

    if (requestUrl.pathname === '/api/summary/cards' && request.method === 'POST') {
      if (!access.canWrite) {
        writeAuthError(response, access);
        return;
      }
      try {
        const body = await readRequestJson(request);
        const label = String(body.label || body.name || '').trim();
        const query = String(body.query || '').trim();
        const counted = countListingsForSummaryQuery(db, query);
        const card = upsertSummaryQueryCard(db, {
          cardId: body.cardId || body.card_id,
          label,
          query,
          position: Number.isFinite(body.position) ? body.position : undefined,
        });
        writeJson(response, 200, {
          card: {
            ...card,
            value: counted.total,
            error: '',
          },
        });
      } catch (error) {
        writeJson(response, error.statusCode || 400, { error: error.message });
      }
      return;
    }

    const summaryCardMatch = requestUrl.pathname.match(/^\/api\/summary\/cards\/([^/]+)$/);
    if (summaryCardMatch && request.method === 'DELETE') {
      if (!access.canWrite) {
        writeAuthError(response, access);
        return;
      }
      const cardId = decodeURIComponent(summaryCardMatch[1]);
      const deleted = deleteSummaryQueryCard(db, cardId);
      if (!deleted) {
        writeJson(response, 404, { error: `Unknown summary card: ${cardId}` });
        return;
      }
      writeJson(response, 200, { deleted });
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

    if (requestUrl.pathname === '/api/query/counts' && request.method === 'POST') {
      try {
        const body = await readRequestJson(request);
        const queries = Array.isArray(body.queries) ? body.queries.slice(0, 40) : [];
        writeJson(response, 200, {
          cards: queries.map((item) => {
            const query = String(item.query || '').trim();
            try {
              const counted = countListingsForSummaryQuery(db, query);
              return {
                id: String(item.id || '').trim(),
                label: String(item.label || '').trim(),
                query,
                value: counted.total,
                showInOverview: item.showInOverview === true,
                source: item.source || '',
                error: '',
              };
            } catch (error) {
              return {
                id: String(item.id || '').trim(),
                label: String(item.label || '').trim(),
                query,
                value: 0,
                showInOverview: item.showInOverview === true,
                source: item.source || '',
                error: error.message || 'Query could not be counted.',
              };
            }
          }),
        });
      } catch (error) {
        writeJson(response, error.statusCode || 400, { error: error.message });
      }
      return;
    }

    if (requestUrl.pathname === '/api/saved-queries' && request.method === 'GET') {
      writeJson(response, 200, {
        queries: listSavedQueries(db),
      });
      return;
    }

    if (requestUrl.pathname === '/api/saved-queries' && request.method === 'POST') {
      if (!access.canWrite) {
        writeAuthError(response, access);
        return;
      }
      try {
        const body = await readRequestJson(request);
        const savedQuery = upsertSavedQuery(db, {
          id: body.id || body.queryId || body.query_id,
          label: body.label || body.name,
          query: body.query,
          showInOverview: body.showInOverview ?? body.show_in_overview,
        });
        writeJson(response, 200, { query: savedQuery });
      } catch (error) {
        writeJson(response, error.statusCode || 400, { error: error.message });
      }
      return;
    }

    const savedQueryMatch = requestUrl.pathname.match(/^\/api\/saved-queries\/([^/]+)$/);
    if (savedQueryMatch && request.method === 'PATCH') {
      if (!access.canWrite) {
        writeAuthError(response, access);
        return;
      }
      try {
        const body = await readRequestJson(request);
        const queryId = decodeURIComponent(savedQueryMatch[1]);
        const updated = setSavedQueryOverview(db, queryId, body.showInOverview ?? body.show_in_overview);
        if (!updated) {
          writeJson(response, 404, { error: `Unknown saved query: ${queryId}` });
          return;
        }
        writeJson(response, 200, { query: updated });
      } catch (error) {
        writeJson(response, error.statusCode || 400, { error: error.message });
      }
      return;
    }

    if (savedQueryMatch && request.method === 'DELETE') {
      if (!access.canWrite) {
        writeAuthError(response, access);
        return;
      }
      const queryId = decodeURIComponent(savedQueryMatch[1]);
      const deleted = deleteSavedQuery(db, queryId);
      if (!deleted) {
        writeJson(response, 404, { error: `Unknown saved query: ${queryId}` });
        return;
      }
      writeJson(response, 200, { deleted });
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
        const requestedSource = requestUrl.searchParams.get('source') || 'all';
        const source = String(requestedSource || 'all').trim().toLowerCase();
        const limit = normalizeBoundedInteger(
          requestUrl.searchParams.get('limit'),
          EVENT_REGISTRY_DEFAULT_LIMIT,
          1,
          EVENT_REGISTRY_MAX_LIMIT,
        );
        const offset = normalizeBoundedInteger(
          requestUrl.searchParams.get('offset'),
          0,
          0,
          source === 'all' ? Math.max(0, EVENT_REGISTRY_ALL_SOURCE_WINDOW - limit) : Number.MAX_SAFE_INTEGER,
        );
        const total = countEventRegistry(db, { source });
        const effectiveTotal = source === 'all' ? Math.min(total, EVENT_REGISTRY_ALL_SOURCE_WINDOW) : total;
        writeJson(response, 200, {
          events: listEventRegistry(db, {
            source,
            limit,
            offset,
          }),
          total: effectiveTotal,
          rawTotal: total,
          limit,
          offset,
          bounded: source === 'all' && total > effectiveTotal,
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

    if (requestUrl.pathname === '/api/listings/stats') {
      const query = requestUrl.searchParams.get('q') || '';
      const excludeListingIds = normalizeListingIds(requestUrl.searchParams.getAll('excludeListingId'));

      try {
        const startedAt = process.hrtime.bigint();
        const resultStats = readListingsResultStats(db, { query, excludeListingIds });
        const elapsedMs = Number((process.hrtime.bigint() - startedAt) / 1000000n);
        writeJson(response, 200, {
          query,
          resultStats,
          stats: {
            elapsedMs,
            totalRows: resultStats.pricedCount + resultStats.unpricedCount,
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
            resultStatsDeferred: true,
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
      const sectionStartedAt = process.hrtime.bigint();
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
      logSlowSection('api_workflows_build', sectionStartedAt, { reconcile, includeStats, includeConfig });
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

    if (requestUrl.pathname === '/api/workflows/profiles' && request.method === 'GET') {
      if (!requireReadAccess(response, access)) {
        return;
      }
      const workflowId = requestUrl.searchParams.get('workflowId') || '';
      writeJson(response, 200, {
        profiles: listWorkerParameterProfiles(db, { workflowId }),
      });
      return;
    }

    if (requestUrl.pathname === '/api/workflows/profiles' && request.method === 'POST') {
      if (!access.canWrite) {
        writeAuthError(response, access);
        return;
      }
      try {
        const body = await readRequestJson(request);
        const workflow = WORKFLOWS[body.workflowId || body.workflow_id];
        if (!workflow) {
          const error = new Error(`Unknown workflow: ${body.workflowId || body.workflow_id || ''}`);
          error.statusCode = 400;
          throw error;
        }
        const args = Array.isArray(body.args)
          ? validateWorkflowArgs(workflow, body.args)
          : validateWorkflowArgs(workflow, buildDefaultArgsFromFields(fieldsForWorkflow(workflow)));
        const profile = upsertWorkerParameterProfile(db, {
          profileId: body.profileId || body.profile_id,
          workflowId: body.workflowId || body.workflow_id,
          workerType: workflow.workerType || '',
          label: body.label || body.name,
          params: body.params || {},
          args,
        });
        writeJson(response, 200, { profile });
      } catch (error) {
        writeJson(response, error.statusCode || 400, { error: error.message });
      }
      return;
    }

    const workerProfileMatch = requestUrl.pathname.match(/^\/api\/workflows\/profiles\/([^/]+)$/);
    if (workerProfileMatch && request.method === 'DELETE') {
      if (!access.canWrite) {
        writeAuthError(response, access);
        return;
      }
      const profileId = decodeURIComponent(workerProfileMatch[1]);
      const deleted = deleteWorkerParameterProfile(db, profileId);
      if (!deleted) {
        writeJson(response, 404, { error: `Unknown worker parameter profile: ${profileId}` });
        return;
      }
      writeJson(response, 200, { deleted });
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
        const sectionStartedAt = process.hrtime.bigint();
        const body = await readRequestJson(request);
        const started = startManagedWorkflow(db, body.workflowId, body.args);
        logSlowSection('api_workflows_start', sectionStartedAt, { workflowId: body.workflowId || '' });
        writeJson(response, 201, { process: started });
      } catch (error) {
        writeJson(response, error.statusCode || 500, { error: error.message });
      }
      return;
    }

    if (requestUrl.pathname === '/api/workflows/restart' && request.method === 'POST') {
      if (!access.canWrite) {
        writeAuthError(response, access);
        return;
      }
      try {
        const sectionStartedAt = process.hrtime.bigint();
        const body = await readRequestJson(request);
        const restarted = restartManagedWorkflow(db, body.processId);
        logSlowSection('api_workflows_restart', sectionStartedAt, {
          processId: body.processId || '',
          restartedProcessId: restarted.id || '',
          workflowId: restarted.workflowId || '',
        });
        writeJson(response, 201, { process: restarted });
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
  argsWithoutManagedWorkerId,
  validateWorkflowStartArgs,
  buildDefaultArgsFromFields,
  fieldsForWorkflow,
  workflowConcurrencyLimit,
  workflowConcurrencyScope,
  workflowLifecycleEventForStatus,
  insertWorkflowRunWithLifecycleEvent,
  updateWorkflowRunWithLifecycleEvent,
  isBrowserWorkerType,
  isExclusiveBrowserWorkerType,
  createServer,
};
