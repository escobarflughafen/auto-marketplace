const { createMarketplaceWorkflowEventsPostgresStore } = require('./marketplace-workflow-events-postgres-store');

const COLLECTOR_OBSERVED_EVENT_TYPE = 'listing_observed';
const COLLECTOR_DONE_STATUSES = ['new', 'existing_updated', 'updated', 'match_queued', 'queued'];
const COLLECTOR_SKIPPED_STATUSES = ['existing_same', 'duplicate', 'filtered', 'ignored', 'already_seen'];
const COLLECTOR_ERROR_STATUSES = ['error', 'failed', 'malformed', 'interrupted'];

function normalizeKeyword(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function uniqueStrings(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function integerValue(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeListingEventRow(row) {
  if (!row) return null;
  return {
    event_scope: row.event_scope || 'listing',
    event_id: row.event_id,
    workflow_run_id: row.workflow_run_id || '',
    listing_id: row.listing_id,
    event_type: row.event_type,
    event_at: row.event_at,
    worker_id: row.worker_id,
    source_url: row.source_url,
    attempt: integerValue(row.attempt, 0),
    status: row.status,
    content: parseJsonObject(row.content_json),
    content_hash: row.content_hash,
    screenshot_path: row.screenshot_path,
    snapshot_path: row.snapshot_path,
    error: row.error,
    listing: {
      detail_status: row.detail_status || '',
      card_title: row.card_title || '',
      detail_title: row.detail_title || '',
      detail_price: row.detail_price || '',
      detail_location: row.detail_location || '',
      detail_seller_name: row.detail_seller_name || '',
      screenshot_path: row.listing_screenshot_path || '',
      snapshot_path: row.listing_snapshot_path || '',
    },
  };
}

function eventTypesForCategory(category) {
  switch (normalizeKeyword(category || 'all').toLowerCase()) {
    case 'done':
      return ['detail_capture_succeeded', 'content_changed'];
    case 'skipped':
    case 'skip':
      return ['detail_capture_bypassed', 'listing_unavailable'];
    case 'error':
    case 'errors':
      return ['detail_capture_failed', 'detail_capture_interrupted'];
    case 'started':
    case 'active':
      return ['detail_capture_started'];
    case 'all':
    default:
      return [];
  }
}

function listingEventSemanticBuckets(eventType, status) {
  const buckets = [];
  if (eventTypesForCategory('started').includes(eventType)) buckets.push('started');
  if (eventTypesForCategory('done').includes(eventType)) buckets.push('done');
  if (eventTypesForCategory('skipped').includes(eventType)) buckets.push('skipped');
  if (eventTypesForCategory('error').includes(eventType)) buckets.push('error');
  if (eventType === COLLECTOR_OBSERVED_EVENT_TYPE) {
    buckets.push('started');
    if (COLLECTOR_DONE_STATUSES.includes(status)) {
      buckets.push('done');
    } else if (COLLECTOR_SKIPPED_STATUSES.includes(status)) {
      buckets.push('skipped');
    } else if (COLLECTOR_ERROR_STATUSES.includes(status)) {
      buckets.push('error');
    }
  }
  return buckets;
}

function isWorkflowReviewEvent(event = {}) {
  return /failed|interrupted/i.test(event.event_type || '')
    || ['error', 'failed', 'interrupted'].includes(event.status || '')
    || Boolean(event.error);
}

function sortEventsDesc(events = []) {
  return [...events].sort((left, right) => String(right.event_at || '').localeCompare(String(left.event_at || '')));
}

function workflowReviewSql(alias = 'workflow_events') {
  return `(${alias}.event_type LIKE '%failed%'
    OR ${alias}.event_type LIKE '%interrupted%'
    OR ${alias}.status IN ('error', 'failed', 'interrupted')
    OR COALESCE(${alias}.error, '') != '')`;
}

function collectorOutcomeStatsFromRows(rows = []) {
  const stats = {
    observed: 0,
    appended: 0,
    updated: 0,
    unchanged: 0,
    rejected: 0,
    errors: 0,
  };
  for (const row of rows) {
    if (row.event_type !== COLLECTOR_OBSERVED_EVENT_TYPE) continue;
    const count = integerValue(row.count, 0);
    const status = String(row.status || '').trim();
    stats.observed += count;
    if (status === 'new' || status === 'queued' || status === 'match_queued') {
      stats.appended += count;
    } else if (status === 'existing_updated' || status === 'updated') {
      stats.updated += count;
    } else if (status === 'existing_same' || status === 'duplicate' || status === 'already_seen') {
      stats.unchanged += count;
    } else if (status === 'filtered' || status === 'ignored') {
      stats.rejected += count;
    } else if (COLLECTOR_ERROR_STATUSES.includes(status)) {
      stats.errors += count;
    }
  }
  return stats;
}

function boundedLimit(value, fallback = 50) {
  const parsed = Number.parseInt(value, 10);
  const limit = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(1, Math.min(limit, 200));
}

function placeholder(params, value) {
  params.push(value);
  return `$${params.length}`;
}

function placeholderList(params, values) {
  return values.map((value) => placeholder(params, value)).join(', ');
}

function workerRunWhereSql(workerId, workerIds, params, alias = 'e') {
  const runId = String(workerId || '').trim();
  const ids = uniqueStrings(workerIds);
  const clauses = [];
  if (runId) {
    clauses.push(`${alias}.workflow_run_id = ${placeholder(params, runId)}`);
  }
  if (ids.length > 0) {
    clauses.push(`${alias}.worker_id IN (${placeholderList(params, ids)})`);
  }
  if (clauses.length === 0) {
    return `${alias}.worker_id = ${placeholder(params, '')}`;
  }
  return `(${clauses.join(' OR ')})`;
}

function listingCategorySql(category, params, alias = 'e') {
  const normalized = normalizeKeyword(category || 'all').toLowerCase();
  const detailTypes = eventTypesForCategory(normalized);
  const collectorStatusSql = (statuses) => (
    `${alias}.event_type = ${placeholder(params, COLLECTOR_OBSERVED_EVENT_TYPE)} AND ${alias}.status IN (${placeholderList(params, statuses)})`
  );

  switch (normalized) {
    case 'done':
      return `AND (${alias}.event_type IN (${placeholderList(params, detailTypes)})
        OR (${collectorStatusSql(COLLECTOR_DONE_STATUSES)}))`;
    case 'skipped':
    case 'skip':
      return `AND (${alias}.event_type IN (${placeholderList(params, detailTypes)})
        OR (${collectorStatusSql(COLLECTOR_SKIPPED_STATUSES)}))`;
    case 'error':
    case 'errors':
      return `AND (${alias}.event_type IN (${placeholderList(params, detailTypes)})
        OR (${collectorStatusSql(COLLECTOR_ERROR_STATUSES)}))`;
    case 'started':
    case 'active':
      return `AND (${alias}.event_type IN (${placeholderList(params, detailTypes)})
        OR ${alias}.event_type = ${placeholder(params, COLLECTOR_OBSERVED_EVENT_TYPE)})`;
    case 'all':
    default:
      return '';
  }
}

function requirePgPool() {
  try {
    return require('pg').Pool;
  } catch (error) {
    const wrapped = new Error('PostgreSQL worker event store requires the pg package or an injected pool.');
    wrapped.cause = error;
    wrapped.code = 'missing_pg_dependency';
    throw wrapped;
  }
}

function createPoolFromOptions(options = {}) {
  if (options.pool) return options.pool;
  const connectionString = options.connectionString
    || process.env.MARKETPLACE_WORKER_EVENTS_POSTGRES_URL
    || process.env.MARKETPLACE_POSTGRES_URL
    || process.env.DATABASE_URL
    || '';
  if (!connectionString) {
    const error = new Error('Missing PostgreSQL connection string. Set MARKETPLACE_WORKER_EVENTS_POSTGRES_URL, MARKETPLACE_POSTGRES_URL, or pass connectionString.');
    error.code = 'missing_postgres_connection_string';
    throw error;
  }
  const Pool = requirePgPool();
  return new Pool({ connectionString });
}

async function queryRows(pool, sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows || [];
}

async function queryOne(pool, sql, params = []) {
  const rows = await queryRows(pool, sql, params);
  return rows[0] || null;
}

function listingEventSelectSql() {
  return `
    SELECT
      'listing' AS event_scope,
      e.*,
      h.detail_status,
      h.card_title,
      h.detail_title,
      h.detail_price,
      h.detail_location,
      h.detail_seller_name,
      h.screenshot_path AS listing_screenshot_path,
      h.snapshot_path AS listing_snapshot_path
    FROM listing_events e
    LEFT JOIN homepage_listings h
      ON h.listing_id = e.listing_id
  `;
}

function emptyAuditStats(workerId, source = 'cache_miss') {
  return {
    total: 0,
    listingTotal: 0,
    workflow: 0,
    workflowReview: 0,
    done: 0,
    skipped: 0,
    error: 0,
    started: 0,
    collector: {
      observed: 0,
      appended: 0,
      updated: 0,
      unchanged: 0,
      rejected: 0,
      errors: 0,
    },
    workerIds: [String(workerId || '').trim()].filter(Boolean),
    eventTypes: [],
    statusTypes: [],
    latestEvent: null,
    latestPreviewEvent: null,
    source,
  };
}

function buildAuditStatsFromCacheRows(workerId, rows = []) {
  if (rows.length === 0) return null;

  const listingStats = {
    total: 0,
    done: 0,
    skipped: 0,
    error: 0,
    started: 0,
    collector: collectorOutcomeStatsFromRows(rows),
    workerIds: [String(workerId || '').trim()].filter(Boolean),
    eventTypes: [],
    statusTypes: [],
    latestEvent: null,
    latestPreviewEvent: null,
  };
  const listingEventTypeCounts = new Map();
  const eventTypesByKey = new Map();
  let workflowCount = 0;
  let workflowReview = 0;

  for (const row of rows) {
    const count = integerValue(row.count, 0);
    if (row.event_scope === 'listing') {
      listingStats.total += count;
      listingEventTypeCounts.set(row.event_type, (listingEventTypeCounts.get(row.event_type) || 0) + count);
      listingStats.statusTypes.push({
        eventType: row.event_type,
        eventScope: 'listing',
        status: row.status || '',
        count,
      });
      for (const bucket of listingEventSemanticBuckets(row.event_type, row.status || '')) {
        if (bucket === 'done') listingStats.done += count;
        if (bucket === 'skipped') listingStats.skipped += count;
        if (bucket === 'error') listingStats.error += count;
        if (bucket === 'started') listingStats.started += count;
      }
    } else if (row.event_scope === 'workflow') {
      workflowCount += count;
      if (isWorkflowReviewEvent(row)) workflowReview += count;
      const key = `workflow:${row.event_type}`;
      eventTypesByKey.set(key, {
        eventType: row.event_type,
        eventScope: 'workflow',
        count: (eventTypesByKey.get(key)?.count || 0) + count,
      });
    }
  }

  listingStats.eventTypes = [...listingEventTypeCounts.entries()].map(([eventType, count]) => ({
    eventType,
    eventScope: 'listing',
    count,
  }));
  for (const item of listingStats.eventTypes) {
    eventTypesByKey.set(`listing:${item.eventType}`, item);
  }

  return {
    ...listingStats,
    listingTotal: listingStats.total,
    workflow: workflowCount,
    workflowReview,
    error: listingStats.error + workflowReview,
    total: listingStats.total + workflowCount,
    eventTypes: [...eventTypesByKey.values()]
      .sort((left, right) => right.count - left.count || String(left.eventType).localeCompare(String(right.eventType))),
    latestEvent: null,
    latestPreviewEvent: null,
    source: 'cache',
  };
}

function createMarketplaceWorkerEventsPostgresStore(options = {}) {
  const pool = createPoolFromOptions(options);
  const workflowEventStore = options.workflowEventStore || createMarketplaceWorkflowEventsPostgresStore({ pool });

  return {
    dialect: 'postgres',
    pool,

    async listWorkerListingEvents(workerId, options = {}) {
      const limit = boundedLimit(options.limit, 50);
      const eventType = String(options.eventType || '').trim();
      const workerIds = options.workerIds || [workerId];
      const params = [];
      const workerSql = workerRunWhereSql(workerId, workerIds, params, 'e');
      let eventTypeSql = '';

      if (eventType) {
        eventTypeSql = `AND e.event_type = ${placeholder(params, eventType)}`;
      } else {
        eventTypeSql = listingCategorySql(options.category, params, 'e');
      }

      const limitPlaceholder = placeholder(params, limit);
      const rows = await queryRows(pool, `
        ${listingEventSelectSql()}
        WHERE ${workerSql}
          ${eventTypeSql}
        ORDER BY e.event_at DESC
        LIMIT ${limitPlaceholder}
      `, params);
      return rows.map(normalizeListingEventRow);
    },

    async listWorkerAuditEvents(workerId, options = {}) {
      const limit = boundedLimit(options.limit, 50);
      const category = normalizeKeyword(options.category || 'all').toLowerCase();

      if (category === 'workflow' || category === 'lifecycle') {
        return workflowEventStore.listWorkerWorkflowEvents(workerId, { ...options, limit });
      }

      if (category === 'listing') {
        return this.listWorkerListingEvents(workerId, {
          ...options,
          category: 'all',
          limit,
        });
      }

      if (category !== 'all') {
        if (['error', 'errors', 'review'].includes(category)) {
          const [listingEvents, workflowEvents] = await Promise.all([
            this.listWorkerListingEvents(workerId, {
              ...options,
              category: 'error',
              limit,
            }),
            workflowEventStore.listWorkerWorkflowEvents(workerId, { ...options, limit }),
          ]);
          return sortEventsDesc([
            ...listingEvents,
            ...workflowEvents.filter(isWorkflowReviewEvent),
          ]).slice(0, limit);
        }
        return this.listWorkerListingEvents(workerId, {
          ...options,
          category,
          limit,
        });
      }

      const [listingEvents, workflowEvents] = await Promise.all([
        this.listWorkerListingEvents(workerId, {
          ...options,
          category: 'all',
          limit,
        }),
        workflowEventStore.listWorkerWorkflowEvents(workerId, { ...options, limit }),
      ]);
      return sortEventsDesc([...listingEvents, ...workflowEvents]).slice(0, limit);
    },

    async getWorkerListingEventStats(workerId, options = {}) {
      const workerIds = uniqueStrings(options.workerIds || [workerId]);
      const statsParams = [];
      const statsWorkerSql = workerRunWhereSql(workerId, workerIds, statsParams, 'listing_events');
      const rows = await queryRows(pool, `
        SELECT event_type, status, COUNT(*)::BIGINT AS count
        FROM listing_events
        WHERE ${statsWorkerSql}
        GROUP BY event_type, status
      `, statsParams);
      const eventTypeCounts = new Map();
      const stats = {
        total: 0,
        done: 0,
        skipped: 0,
        error: 0,
        started: 0,
        collector: collectorOutcomeStatsFromRows(rows),
        workerIds,
        eventTypes: [],
        statusTypes: rows.map((row) => ({
          eventType: row.event_type,
          eventScope: 'listing',
          status: row.status || '',
          count: integerValue(row.count, 0),
        })),
      };

      for (const row of rows) {
        const count = integerValue(row.count, 0);
        stats.total += count;
        eventTypeCounts.set(row.event_type, (eventTypeCounts.get(row.event_type) || 0) + count);
        for (const bucket of listingEventSemanticBuckets(row.event_type, row.status || '')) {
          if (bucket === 'done') stats.done += count;
          if (bucket === 'skipped') stats.skipped += count;
          if (bucket === 'error') stats.error += count;
          if (bucket === 'started') stats.started += count;
        }
      }
      stats.eventTypes = [...eventTypeCounts.entries()].map(([eventType, count]) => ({
        eventType,
        eventScope: 'listing',
        count,
      }));

      const latestParams = [];
      const latestWorkerSql = workerRunWhereSql(workerId, workerIds, latestParams, 'e');
      const latest = await queryOne(pool, `
        ${listingEventSelectSql()}
        WHERE ${latestWorkerSql}
        ORDER BY e.event_at DESC
        LIMIT 1
      `, latestParams);

      const latestPreviewParams = [];
      const latestPreviewWorkerSql = workerRunWhereSql(workerId, workerIds, latestPreviewParams, 'e');
      const latestPreview = await queryOne(pool, `
        ${listingEventSelectSql()}
        WHERE ${latestPreviewWorkerSql}
          AND (
            COALESCE(e.screenshot_path, '') != ''
            OR COALESCE(h.screenshot_path, '') != ''
          )
        ORDER BY e.event_at DESC
        LIMIT 1
      `, latestPreviewParams);

      return {
        ...stats,
        latestEvent: normalizeListingEventRow(latest),
        latestPreviewEvent: normalizeListingEventRow(latestPreview),
      };
    },

    async getWorkerAuditEventStats(workerId, options = {}) {
      if ((options.preferCache || options.cacheOnly) && !options.includeLatestEvents && !options.workerIds) {
        const cacheRows = await queryRows(pool, `
          SELECT event_scope, event_type, status, count
          FROM worker_event_stats_cache
          WHERE worker_id = $1
        `, [String(workerId || '').trim()]);
        const cached = buildAuditStatsFromCacheRows(workerId, cacheRows);
        if (cached) return cached;
        if (options.cacheOnly) return emptyAuditStats(workerId, 'cache_miss');
      }

      const listingStats = await this.getWorkerListingEventStats(workerId, options);
      const workflowRows = await queryRows(pool, `
        SELECT event_type, COUNT(*)::BIGINT AS count
        FROM workflow_events
        WHERE workflow_run_id = $1
        GROUP BY event_type
      `, [String(workerId)]);
      const workflowCount = workflowRows.reduce((sum, row) => sum + integerValue(row.count, 0), 0);
      const workflowReviewRow = await queryOne(pool, `
        SELECT COUNT(*)::BIGINT AS count
        FROM workflow_events
        WHERE workflow_run_id = $1
          AND ${workflowReviewSql('workflow_events')}
      `, [String(workerId)]);
      const workflowReview = integerValue(workflowReviewRow?.count, 0);
      const latestWorkflow = (await workflowEventStore.listWorkerWorkflowEvents(workerId, { limit: 1 }))[0] || null;
      const latestCandidates = [listingStats.latestEvent, latestWorkflow].filter(Boolean);
      const latestEvent = sortEventsDesc(latestCandidates)[0] || null;
      const eventTypesByKey = new Map();
      for (const item of listingStats.eventTypes || []) {
        eventTypesByKey.set(`${item.eventScope}:${item.eventType}`, item);
      }
      for (const row of workflowRows) {
        const key = `workflow:${row.event_type}`;
        const current = eventTypesByKey.get(key);
        eventTypesByKey.set(key, {
          eventType: row.event_type,
          eventScope: 'workflow',
          count: (current?.count || 0) + integerValue(row.count, 0),
        });
      }

      return {
        ...listingStats,
        listingTotal: listingStats.total,
        workflow: workflowCount,
        workflowReview,
        error: listingStats.error + workflowReview,
        total: listingStats.total + workflowCount,
        eventTypes: [...eventTypesByKey.values()]
          .sort((left, right) => right.count - left.count || String(left.eventType).localeCompare(String(right.eventType))),
        latestEvent,
        latestPreviewEvent: listingStats.latestPreviewEvent,
      };
    },

    async close() {
      if (typeof pool.end === 'function') await pool.end();
    },
  };
}

module.exports = {
  createMarketplaceWorkerEventsPostgresStore,
  normalizeListingEventRow,
  listingEventSemanticBuckets,
  collectorOutcomeStatsFromRows,
  isWorkflowReviewEvent,
  buildAuditStatsFromCacheRows,
  boundedLimit,
};
