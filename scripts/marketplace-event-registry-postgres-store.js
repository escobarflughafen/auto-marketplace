function normalizeKeyword(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
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

const EVENT_REGISTRY_SOURCES = ['inventory', 'listing', 'resolve', 'recommendation', 'workflow'];
const EVENT_REGISTRY_DEFAULT_LIMIT = 100;
const EVENT_REGISTRY_MAX_LIMIT = 500;
const EVENT_REGISTRY_ALL_SOURCE_WINDOW = 2500;

function normalizeEventRegistrySource(source) {
  const normalized = normalizeKeyword(source || 'all').toLowerCase();
  if (normalized === 'all') return 'all';
  return EVENT_REGISTRY_SOURCES.includes(normalized) ? normalized : 'all';
}

function normalizeEventRegistryLimit(limit) {
  const value = Number.parseInt(limit, 10);
  return Number.isFinite(value)
    ? Math.max(1, Math.min(value, EVENT_REGISTRY_MAX_LIMIT))
    : EVENT_REGISTRY_DEFAULT_LIMIT;
}

function normalizeEventRegistryOffset(offset) {
  const value = Number.parseInt(offset, 10);
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function normalizeEventRegistryRow(row) {
  if (!row) return null;
  return {
    source: row.source,
    event_id: row.event_id,
    event_type: row.event_type,
    event_at: row.event_at,
    status: row.status || '',
    subject_id: row.subject_id || '',
    title: row.title || '',
    data: parseJsonObject(row.data_json),
  };
}

function requirePgPool() {
  try {
    return require('pg').Pool;
  } catch (error) {
    const wrapped = new Error('PostgreSQL event registry store requires the pg package or an injected pool.');
    wrapped.cause = error;
    wrapped.code = 'missing_pg_dependency';
    throw wrapped;
  }
}

function createPoolFromOptions(options = {}) {
  if (options.pool) return options.pool;
  const connectionString = options.connectionString
    || process.env.MARKETPLACE_EVENT_REGISTRY_POSTGRES_URL
    || process.env.MARKETPLACE_POSTGRES_URL
    || process.env.DATABASE_URL
    || '';
  if (!connectionString) {
    const error = new Error('Missing PostgreSQL connection string. Set MARKETPLACE_EVENT_REGISTRY_POSTGRES_URL, MARKETPLACE_POSTGRES_URL, or pass connectionString.');
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

function sourceRowsSql(source) {
  switch (source) {
    case 'inventory':
      return `
        SELECT
          'inventory' AS source,
          events.event_id,
          events.event_type,
          events.event_at,
          COALESCE(rows.outcome, '') AS status,
          events.record_id AS subject_id,
          COALESCE(NULLIF(rows.title, ''), events.record_id) AS title,
          events.data_json::text AS data_json
        FROM purchase_history_events events
        LEFT JOIN purchase_history_rows rows
          ON rows.document_id = events.document_id
          AND rows.record_id = events.record_id
        ORDER BY events.event_at DESC, events.created_at DESC
        LIMIT $1
        OFFSET $2
      `;
    case 'listing':
      return `
        SELECT
          'listing' AS source,
          events.event_id,
          events.event_type,
          events.event_at,
          events.status,
          events.listing_id AS subject_id,
          COALESCE(NULLIF(listings.detail_title, ''), NULLIF(listings.card_title, ''), events.listing_id) AS title,
          events.content_json::text AS data_json
        FROM listing_events events
        LEFT JOIN homepage_listings listings
          ON listings.listing_id = events.listing_id
        ORDER BY events.event_at DESC
        LIMIT $1
        OFFSET $2
      `;
    case 'resolve':
      return `
        SELECT
          'resolve' AS source,
          events.event_id,
          events.event_type,
          events.event_at,
          events.status,
          events.listing_id AS subject_id,
          COALESCE(NULLIF(listings.detail_title, ''), NULLIF(listings.card_title, ''), events.listing_id) AS title,
          (COALESCE(NULLIF(events.content_json::text, ''), '{}')::jsonb || jsonb_build_object(
            'workflow_run_id', events.workflow_run_id,
            'actor', events.actor,
            'error', events.error
          ))::text AS data_json
        FROM resolve_queue_events events
        LEFT JOIN homepage_listings listings
          ON listings.listing_id = events.listing_id
        ORDER BY events.event_at DESC
        LIMIT $1
        OFFSET $2
      `;
    case 'recommendation':
      return `
        SELECT
          'recommendation' AS source,
          events.event_id,
          events.event_type,
          events.event_at,
          queue.status,
          events.listing_id AS subject_id,
          COALESCE(NULLIF(listings.detail_title, ''), NULLIF(listings.card_title, ''), rows.title, events.listing_id) AS title,
          (COALESCE(NULLIF(events.content_json::text, ''), '{}')::jsonb || jsonb_build_object(
            'document_id', events.document_id,
            'record_id', events.record_id,
            'listing_id', events.listing_id,
            'actor', events.actor,
            'reason', events.reason
          ))::text AS data_json
        FROM purchase_history_match_events events
        LEFT JOIN purchase_history_match_queue queue
          ON queue.document_id = events.document_id
          AND queue.record_id = events.record_id
          AND queue.listing_id = events.listing_id
        LEFT JOIN purchase_history_rows rows
          ON rows.document_id = events.document_id
          AND rows.record_id = events.record_id
        LEFT JOIN homepage_listings listings
          ON listings.listing_id = events.listing_id
        ORDER BY events.event_at DESC
        LIMIT $1
        OFFSET $2
      `;
    case 'workflow':
      return `
        SELECT
          'workflow' AS source,
          events.event_id,
          events.event_type,
          events.event_at,
          events.status,
          events.workflow_run_id AS subject_id,
          COALESCE(NULLIF(runs.label, ''), events.workflow_run_id) AS title,
          events.content_json::text AS data_json
        FROM workflow_events events
        LEFT JOIN workflow_runs runs
          ON runs.run_id = events.workflow_run_id
        ORDER BY events.event_at DESC
        LIMIT $1
        OFFSET $2
      `;
    default:
      return '';
  }
}

function countSourceSql(source) {
  switch (source) {
    case 'inventory':
      return 'SELECT COUNT(*)::BIGINT AS total FROM purchase_history_events';
    case 'listing':
      return 'SELECT COUNT(*)::BIGINT AS total FROM listing_events';
    case 'resolve':
      return 'SELECT COUNT(*)::BIGINT AS total FROM resolve_queue_events';
    case 'recommendation':
      return 'SELECT COUNT(*)::BIGINT AS total FROM purchase_history_match_events';
    case 'workflow':
      return 'SELECT COUNT(*)::BIGINT AS total FROM workflow_events';
    default:
      return '';
  }
}

function sortRegistryRowsDesc(rows = []) {
  return [...rows].sort((left, right) => (
    String(right.event_at || '').localeCompare(String(left.event_at || ''))
    || String(right.event_id || '').localeCompare(String(left.event_id || ''))
  ));
}

function createMarketplaceEventRegistryPostgresStore(options = {}) {
  const pool = createPoolFromOptions(options);

  return {
    dialect: 'postgres',
    pool,

    async listEventRegistrySourceRows(source, options = {}) {
      const normalizedSource = normalizeEventRegistrySource(source);
      if (normalizedSource === 'all') return [];
      const limit = normalizeEventRegistryLimit(options.limit);
      const offset = normalizeEventRegistryOffset(options.offset);
      return queryRows(pool, sourceRowsSql(normalizedSource), [limit, offset]);
    },

    async listEventRegistry(options = {}) {
      const source = normalizeEventRegistrySource(options.source);
      const limit = normalizeEventRegistryLimit(options.limit);
      const offset = normalizeEventRegistryOffset(options.offset);
      if (source !== 'all') {
        const rows = await this.listEventRegistrySourceRows(source, { limit, offset });
        return rows.map(normalizeEventRegistryRow);
      }

      const perSourceLimit = Math.min(EVENT_REGISTRY_ALL_SOURCE_WINDOW, offset + limit);
      const rowGroups = await Promise.all(EVENT_REGISTRY_SOURCES.map((eventSource) => (
        this.listEventRegistrySourceRows(eventSource, { limit: perSourceLimit, offset: 0 })
      )));
      return sortRegistryRowsDesc(rowGroups.flat())
        .slice(offset, offset + limit)
        .map(normalizeEventRegistryRow);
    },

    async countEventRegistry(options = {}) {
      const source = normalizeEventRegistrySource(options.source);
      const countSource = async (eventSource) => {
        const row = await queryOne(pool, countSourceSql(eventSource));
        return integerValue(row?.total, 0);
      };
      if (source !== 'all') return countSource(source);
      const counts = await Promise.all(EVENT_REGISTRY_SOURCES.map(countSource));
      return counts.reduce((total, count) => total + count, 0);
    },

    async close() {
      if (typeof pool.end === 'function') await pool.end();
    },
  };
}

module.exports = {
  createMarketplaceEventRegistryPostgresStore,
  normalizeEventRegistryRow,
  normalizeEventRegistrySource,
  normalizeEventRegistryLimit,
  normalizeEventRegistryOffset,
  EVENT_REGISTRY_SOURCES,
};
