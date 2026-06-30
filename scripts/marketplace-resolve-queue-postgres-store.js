const crypto = require('crypto');

function serializeJson(value) {
  return JSON.stringify(value ?? {}, null, 2);
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

function normalizeKeyword(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function integerValue(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolOrNull(value) {
  if (value === undefined || value === null) return null;
  return value === true || value === 1 || value === '1';
}

function buildResolveQueueEventId(eventAt, listingId, eventType) {
  const entropy = crypto.randomBytes(8).toString('hex');
  return [
    String(eventAt || new Date().toISOString()).replace(/[^0-9A-Za-z]/g, ''),
    String(listingId || 'unknown'),
    String(eventType || 'resolve_queue_event'),
    entropy,
  ].join('-');
}

function normalizeResolveQueueEventRow(row) {
  if (!row) return null;
  return {
    event_id: row.event_id,
    listing_id: row.listing_id,
    event_type: row.event_type,
    event_at: row.event_at,
    workflow_run_id: row.workflow_run_id || '',
    actor: row.actor || '',
    status: row.status || '',
    content: parseJsonObject(row.content_json),
    error: row.error || '',
  };
}

function normalizeResolveQueueItemRow(row) {
  if (!row) return null;
  return {
    listing_id: row.listing_id,
    status: row.status,
    queued_at: row.queued_at,
    updated_at: row.updated_at,
    queued_by: row.queued_by,
    workflow_run_id: row.workflow_run_id || '',
    workflow_status: row.workflow_status || '',
    workflow_label: row.workflow_label || '',
    workflow_started_at: row.workflow_started_at || '',
    workflow_updated_at: row.workflow_updated_at || '',
    workflow_os_alive: boolOrNull(row.workflow_os_alive),
    note: row.note || '',
    href: row.href || '',
    detail_status: row.detail_status || '',
    card_title: row.card_title || '',
    detail_title: row.detail_title || '',
    source: row.source || '',
    source_keyword: row.source_keyword || '',
    last_seen_rank: row.last_seen_rank,
    last_seen_at: row.last_seen_at || '',
  };
}

function normalizeListingResolverAssignmentRow(row) {
  return {
    listing_id: row.listing_id,
    resolver_status: row.status || '',
    resolver_queued_at: row.queued_at || '',
    resolver_updated_at: row.updated_at || '',
    resolver_queued_by: row.queued_by || '',
    resolver_workflow_run_id: row.workflow_run_id || '',
    resolver_note: row.note || '',
    resolver_workflow_status: row.workflow_status || '',
    resolver_workflow_label: row.workflow_label || '',
    resolver_workflow_started_at: row.workflow_started_at || '',
    resolver_workflow_updated_at: row.workflow_updated_at || '',
    resolver_workflow_os_alive: boolOrNull(row.workflow_os_alive),
  };
}

function activeResolveQueueStatuses() {
  return ['queued', 'dispatched', 'failed'];
}

function requirePgPool() {
  try {
    return require('pg').Pool;
  } catch (error) {
    const wrapped = new Error('PostgreSQL resolve queue store requires the pg package or an injected pool.');
    wrapped.cause = error;
    wrapped.code = 'missing_pg_dependency';
    throw wrapped;
  }
}

function createPoolFromOptions(options = {}) {
  if (options.pool) return options.pool;
  const connectionString = options.connectionString
    || process.env.MARKETPLACE_RESOLVE_QUEUE_POSTGRES_URL
    || process.env.MARKETPLACE_POSTGRES_URL
    || process.env.DATABASE_URL
    || '';
  if (!connectionString) {
    const error = new Error('Missing PostgreSQL connection string. Set MARKETPLACE_RESOLVE_QUEUE_POSTGRES_URL, MARKETPLACE_POSTGRES_URL, or pass connectionString.');
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

async function withTransaction(pool, callback) {
  const client = typeof pool.connect === 'function' ? await pool.connect() : pool;
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    if (client !== pool && typeof client.release === 'function') client.release();
  }
}

function resolveQueueItemSelectSql(whereSql = '', suffixSql = '') {
  return `
    SELECT
      q.*,
      h.href,
      h.detail_status,
      h.card_title,
      h.detail_title,
      h.source,
      h.source_keyword,
      h.last_seen_rank,
      h.last_seen_at,
      w.status AS workflow_status,
      w.label AS workflow_label,
      w.started_at AS workflow_started_at,
      w.updated_at AS workflow_updated_at,
      w.os_alive AS workflow_os_alive
    FROM resolve_queue_items q
    LEFT JOIN homepage_listings h ON h.listing_id = q.listing_id
    LEFT JOIN workflow_runs w ON w.run_id = q.workflow_run_id
    ${whereSql}
    ${suffixSql}
  `;
}

function createMarketplaceResolveQueuePostgresStore(options = {}) {
  const pool = createPoolFromOptions(options);
  const nowIso = typeof options.nowIso === 'function' ? options.nowIso : () => new Date().toISOString();

  const store = {
    dialect: 'postgres',
    pool,

    async appendResolveQueueEvent(event = {}, client = pool) {
      const eventAt = event.eventAt || event.event_at || nowIso();
      const listingId = String(event.listingId || event.listing_id || '').trim();
      if (!listingId) throw new Error('appendResolveQueueEvent requires listingId');
      const eventType = normalizeKeyword(event.eventType || event.event_type || 'resolve_queue_event');
      const eventId = String(event.eventId || event.event_id || buildResolveQueueEventId(eventAt, listingId, eventType));
      await client.query(`
        INSERT INTO resolve_queue_events (event_id, listing_id, event_type, event_at, workflow_run_id, actor, status, content_json, error)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [eventId, listingId, eventType, eventAt, String(event.workflowRunId || event.workflow_run_id || '').trim(), String(event.actor || 'viewer').trim(), String(event.status || '').trim(), serializeJson(event.content || event.contentJson || {}), String(event.error || '').trim()]);
      const row = await queryOne(client, 'SELECT * FROM resolve_queue_events WHERE event_id = $1', [eventId]);
      return normalizeResolveQueueEventRow(row);
    },

    async listResolveQueueItems(options = {}) {
      const statuses = Array.isArray(options.statuses) ? uniqueStrings(options.statuses) : activeResolveQueueStatuses();
      const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(options.limit, 500)) : 200;
      const params = [];
      let whereSql = '';
      if (statuses.length) {
        const placeholders = statuses.map((status) => {
          params.push(status);
          return `$${params.length}`;
        });
        whereSql = `WHERE q.status IN (${placeholders.join(', ')})`;
      }
      params.push(limit);
      const rows = await queryRows(pool, resolveQueueItemSelectSql(whereSql, `
        ORDER BY
          CASE q.status
            WHEN 'queued' THEN 0
            WHEN 'dispatched' THEN 1
            WHEN 'failed' THEN 2
            ELSE 3
          END,
          q.queued_at ASC
        LIMIT $${params.length}
      `), params);
      return rows.map(normalizeResolveQueueItemRow);
    },

    async listListingResolverAssignments(listingIds = []) {
      const ids = uniqueStrings(listingIds);
      if (!ids.length) return [];
      const params = [];
      const placeholders = ids.map((id) => {
        params.push(id);
        return `$${params.length}`;
      });
      const rows = await queryRows(pool, `
        SELECT
          q.listing_id,
          q.status,
          q.queued_at,
          q.updated_at,
          q.queued_by,
          q.workflow_run_id,
          q.note,
          w.status AS workflow_status,
          w.label AS workflow_label,
          w.started_at AS workflow_started_at,
          w.updated_at AS workflow_updated_at,
          w.os_alive AS workflow_os_alive
        FROM resolve_queue_items q
        LEFT JOIN workflow_runs w ON w.run_id = q.workflow_run_id
        WHERE q.listing_id IN (${placeholders.join(', ')})
      `, params);
      return rows.map(normalizeListingResolverAssignmentRow);
    },

    async listResolveQueueEvents(options = {}) {
      const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(options.limit, 200)) : 50;
      const rows = await queryRows(pool, `
        SELECT *
        FROM resolve_queue_events
        ORDER BY event_at DESC
        LIMIT $1
      `, [limit]);
      return rows.map(normalizeResolveQueueEventRow);
    },

    async getResolveQueueCounts() {
      const rows = await queryRows(pool, `
        SELECT status, COUNT(*)::BIGINT AS count
        FROM resolve_queue_items
        GROUP BY status
      `);
      return rows.reduce((accumulator, row) => ({
        ...accumulator,
        [row.status]: integerValue(row.count, 0),
      }), { queued: 0, dispatched: 0, failed: 0, completed: 0, cleared: 0 });
    },

    async validBacklogListingIds(listingIds = [], client = pool) {
      const ids = uniqueStrings(listingIds);
      if (!ids.length) return [];
      const params = [];
      const placeholders = ids.map((id) => {
        params.push(id);
        return `$${params.length}`;
      });
      const rows = await queryRows(client, `
        SELECT listing_id
        FROM homepage_listings
        WHERE listing_id IN (${placeholders.join(', ')})
          AND detail_status IN ('pending', 'error', 'processing')
      `, params);
      return rows.map((row) => row.listing_id);
    },

    async addResolveQueueItems(listingIds = [], options = {}) {
      const requestedIds = uniqueStrings(listingIds);
      const actor = String(options.actor || 'viewer').trim() || 'viewer';
      const now = options.queuedAt || options.queued_at || nowIso();
      let validIds = [];
      let addedCount = 0;
      const summary = await withTransaction(pool, async (client) => {
        validIds = await this.validBacklogListingIds(requestedIds, client);
        for (const listingId of validIds) {
          const previous = await queryOne(client, 'SELECT status FROM resolve_queue_items WHERE listing_id = $1', [listingId]);
          if ((previous && previous.status) !== 'queued') addedCount += 1;
          await client.query(`
            INSERT INTO resolve_queue_items (listing_id, status, queued_at, updated_at, queued_by, workflow_run_id, note)
            VALUES ($1, 'queued', $2, $3, $4, '', '')
            ON CONFLICT(listing_id) DO UPDATE SET
              status = 'queued',
              queued_at = excluded.queued_at,
              updated_at = excluded.updated_at,
              queued_by = excluded.queued_by,
              workflow_run_id = '',
              note = ''
          `, [listingId, now, now, actor]);
          await this.appendResolveQueueEvent({ listingId, eventType: previous ? 'resolve_queue_requeued' : 'resolve_queue_added', eventAt: now, actor, status: 'queued', content: { previousStatus: (previous && previous.status) || '' } }, client);
        }
        const validIdSet = new Set(validIds);
        const skippedIds = requestedIds.filter((listingId) => !validIdSet.has(listingId));
        return { requestedIds, listingIds: validIds, skippedIds, addedCount };
      });
      return { ...summary, items: await this.listResolveQueueItems(), counts: await this.getResolveQueueCounts() };
    },

    async clearResolveQueueItems(listingIds = [], options = {}) {
      const requestedIds = uniqueStrings(listingIds);
      const actor = String(options.actor || 'viewer').trim() || 'viewer';
      const now = options.clearedAt || options.cleared_at || nowIso();
      const summary = await withTransaction(pool, async (client) => {
        const params = ['queued', 'failed'];
        let idSql = '';
        if (requestedIds.length) {
          const placeholders = requestedIds.map((id) => {
            params.push(id);
            return `$${params.length}`;
          });
          idSql = `AND listing_id IN (${placeholders.join(', ')})`;
        }
        const rows = await queryRows(client, `
          SELECT listing_id, status
          FROM resolve_queue_items
          WHERE status IN ($1, $2)
            ${idSql}
        `, params);
        for (const row of rows) {
          await client.query(`
            UPDATE resolve_queue_items
            SET status = 'cleared', updated_at = $1, note = ''
            WHERE listing_id = $2
          `, [now, row.listing_id]);
          await this.appendResolveQueueEvent({ listingId: row.listing_id, eventType: 'resolve_queue_cleared', eventAt: now, actor, status: 'cleared', content: { previousStatus: row.status } }, client);
        }
        return { clearedCount: rows.length, listingIds: rows.map((row) => row.listing_id) };
      });
      return { ...summary, items: await this.listResolveQueueItems(), counts: await this.getResolveQueueCounts() };
    },

    async markResolveQueueDispatched(listingIds = [], workflowRunId = '', options = {}) {
      const ids = uniqueStrings(listingIds);
      const actor = String(options.actor || 'viewer').trim() || 'viewer';
      const now = options.dispatchedAt || options.dispatched_at || nowIso();
      const runId = String(workflowRunId || '');
      let dispatchedCount = 0;
      const summary = await withTransaction(pool, async (client) => {
        for (const listingId of ids) {
          const result = await client.query(`
            UPDATE resolve_queue_items
            SET status = 'dispatched', updated_at = $1, workflow_run_id = $2, note = ''
            WHERE listing_id = $3
              AND status = 'queued'
          `, [now, runId, listingId]);
          if ((result.rowCount || 0) > 0) {
            dispatchedCount += 1;
            await this.appendResolveQueueEvent({ listingId, eventType: 'resolve_queue_dispatched', eventAt: now, workflowRunId: runId, actor, status: 'dispatched' }, client);
          }
        }
        return { dispatchedCount, listingIds: ids };
      });
      return { ...summary, items: await this.listResolveQueueItems(), counts: await this.getResolveQueueCounts() };
    },

    async refreshResolveQueueRunStatuses() {
      const rows = await queryRows(pool, `
        SELECT q.listing_id, q.workflow_run_id, q.status, w.status AS workflow_status
        FROM resolve_queue_items q
        JOIN workflow_runs w ON w.run_id = q.workflow_run_id
        WHERE q.status = 'dispatched'
      `);
      const now = nowIso();
      let updatedCount = 0;
      const summary = await withTransaction(pool, async (client) => {
        for (const row of rows) {
          const workflowStatus = String(row.workflow_status || '');
          let nextStatus = '';
          if (workflowStatus === 'exited') nextStatus = 'completed';
          else if (workflowStatus === 'failed' || workflowStatus === 'error' || workflowStatus === 'lost') nextStatus = 'failed';
          if (!nextStatus) continue;
          await client.query(`
            UPDATE resolve_queue_items
            SET status = $1, updated_at = $2, note = $3
            WHERE listing_id = $4
              AND status = 'dispatched'
          `, [nextStatus, now, `workflow ${workflowStatus}`, row.listing_id]);
          await this.appendResolveQueueEvent({ listingId: row.listing_id, eventType: nextStatus === 'completed' ? 'resolve_queue_completed' : 'resolve_queue_failed', eventAt: now, workflowRunId: row.workflow_run_id, actor: 'system', status: nextStatus, content: { workflowStatus } }, client);
          updatedCount += 1;
        }
        return { updatedCount };
      });
      return { ...summary, items: await this.listResolveQueueItems(), counts: await this.getResolveQueueCounts() };
    },

    async close() {
      if (typeof pool.end === 'function') await pool.end();
    },
  };
  return store;
}

module.exports = {
  createMarketplaceResolveQueuePostgresStore,
  buildResolveQueueEventId,
  normalizeResolveQueueEventRow,
  normalizeResolveQueueItemRow,
  normalizeListingResolverAssignmentRow,
  activeResolveQueueStatuses,
  uniqueStrings,
};
