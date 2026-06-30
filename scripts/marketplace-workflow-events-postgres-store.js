const crypto = require('crypto');

function normalizeKeyword(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function serializeJson(value) {
  return JSON.stringify(value ?? {}, null, 2);
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

function boundedLimit(value, fallback = 50) {
  const parsed = Number.parseInt(value, 10);
  const limit = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(1, Math.min(limit, 200));
}

function buildWorkflowEventId(eventAt, runId, eventType) {
  const entropy = crypto.randomBytes(8).toString('hex');
  return [
    String(eventAt || new Date().toISOString()).replace(/[^0-9A-Za-z]/g, ''),
    String(runId || 'unknown'),
    String(eventType || 'event'),
    entropy,
  ].join('-');
}

function normalizeWorkflowEventRow(row) {
  if (!row) return null;
  return {
    event_scope: row.event_scope || 'workflow',
    event_id: row.event_id,
    workflow_run_id: row.workflow_run_id,
    listing_id: row.listing_id || '',
    event_type: row.event_type,
    event_at: row.event_at,
    worker_id: row.worker_id || row.workflow_run_id || '',
    source_url: row.source_url || '',
    attempt: integerValue(row.attempt, 0),
    status: row.status,
    content: parseJsonObject(row.content_json),
    content_hash: row.content_hash || '',
    screenshot_path: row.screenshot_path || '',
    snapshot_path: row.snapshot_path || '',
    error: row.error,
    listing: row.listing || {
      detail_status: '',
      card_title: '',
      detail_title: '',
      detail_price: '',
      detail_location: '',
      detail_seller_name: '',
      screenshot_path: '',
      snapshot_path: '',
    },
  };
}

function requirePgPool() {
  try {
    return require('pg').Pool;
  } catch (error) {
    const wrapped = new Error('PostgreSQL workflow event store requires the pg package or an injected pool.');
    wrapped.cause = error;
    wrapped.code = 'missing_pg_dependency';
    throw wrapped;
  }
}

function createPoolFromOptions(options = {}) {
  if (options.pool) return options.pool;
  const connectionString = options.connectionString
    || process.env.MARKETPLACE_WORKFLOW_EVENTS_POSTGRES_URL
    || process.env.MARKETPLACE_POSTGRES_URL
    || process.env.DATABASE_URL
    || '';
  if (!connectionString) {
    const error = new Error('Missing PostgreSQL connection string. Set MARKETPLACE_WORKFLOW_EVENTS_POSTGRES_URL, MARKETPLACE_POSTGRES_URL, or pass connectionString.');
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

async function incrementWorkerEventStatsCache(pool, options = {}) {
  const workerId = String(options.workerId || options.worker_id || '').trim();
  const eventScope = normalizeKeyword(options.eventScope || options.event_scope || '').toLowerCase();
  const eventType = normalizeKeyword(options.eventType || options.event_type || '');
  if (!workerId || !eventScope || !eventType) return;
  const status = String(options.status || '').trim();
  const count = Number.isFinite(options.count) ? Math.max(1, Math.floor(options.count)) : 1;
  const updatedAt = options.updatedAt || options.updated_at || new Date().toISOString();
  await pool.query(`
    INSERT INTO worker_event_stats_cache (
      worker_id,
      event_scope,
      event_type,
      status,
      count,
      updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT(worker_id, event_scope, event_type, status) DO UPDATE SET
      count = worker_event_stats_cache.count + excluded.count,
      updated_at = excluded.updated_at
  `, [workerId, eventScope, eventType, status, count, updatedAt]);
}

function createMarketplaceWorkflowEventsPostgresStore(options = {}) {
  const pool = createPoolFromOptions(options);
  const nowIso = typeof options.nowIso === 'function'
    ? options.nowIso
    : () => new Date().toISOString();

  return {
    dialect: 'postgres',
    pool,

    async appendWorkflowEvent(event = {}) {
      const eventAt = event.eventAt || event.event_at || nowIso();
      const workflowRunId = String(event.workflowRunId || event.workflow_run_id || '').trim();
      if (!workflowRunId) throw new Error('appendWorkflowEvent requires workflowRunId');

      const eventType = normalizeKeyword(event.eventType || event.event_type || 'workflow_event');
      const content = event.content || event.contentJson || {};
      const eventId = String(event.eventId || event.event_id || buildWorkflowEventId(eventAt, workflowRunId, eventType));
      const status = String(event.status || (event.error ? 'error' : '')).trim();
      const error = String(event.error || '').trim();

      await pool.query(`
        INSERT INTO workflow_events (
          event_id,
          workflow_run_id,
          event_type,
          event_at,
          status,
          content_json,
          error
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [
        eventId,
        workflowRunId,
        eventType,
        eventAt,
        status,
        serializeJson(content),
        error,
      ]);

      await incrementWorkerEventStatsCache(pool, {
        workerId: workflowRunId,
        eventScope: 'workflow',
        eventType,
        status,
        updatedAt: eventAt,
      });

      return this.getWorkflowEvent(eventId);
    },

    async getWorkflowEvent(eventId) {
      const row = await queryOne(pool, `
        SELECT *
        FROM workflow_events
        WHERE event_id = $1
      `, [String(eventId)]);
      return normalizeWorkflowEventRow(row);
    },

    async listWorkflowEvents(workflowRunId, options = {}) {
      const limit = boundedLimit(options.limit, 50);
      const eventType = String(options.eventType || '').trim();
      const params = [String(workflowRunId)];
      const eventTypeSql = eventType ? `AND event_type = $${params.length + 1}` : '';
      if (eventType) params.push(eventType);
      params.push(limit);
      const rows = await queryRows(pool, `
        SELECT *
        FROM workflow_events
        WHERE workflow_run_id = $1
          ${eventTypeSql}
        ORDER BY event_at DESC
        LIMIT $${params.length}
      `, params);
      return rows.map(normalizeWorkflowEventRow);
    },

    async listWorkerWorkflowEvents(workflowRunId, options = {}) {
      const limit = boundedLimit(options.limit, 50);
      const eventType = String(options.eventType || '').trim();
      const params = [String(workflowRunId)];
      const eventTypeSql = eventType ? `AND event_type = $${params.length + 1}` : '';
      if (eventType) params.push(eventType);
      params.push(limit);
      const rows = await queryRows(pool, `
        SELECT
          'workflow' AS event_scope,
          *
        FROM workflow_events
        WHERE workflow_run_id = $1
          ${eventTypeSql}
        ORDER BY event_at DESC
        LIMIT $${params.length}
      `, params);
      return rows.map(normalizeWorkflowEventRow);
    },

    async close() {
      if (typeof pool.end === 'function') await pool.end();
    },
  };
}

module.exports = {
  createMarketplaceWorkflowEventsPostgresStore,
  normalizeWorkflowEventRow,
  buildWorkflowEventId,
  boundedLimit,
};
