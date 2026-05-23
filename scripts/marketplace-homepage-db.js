const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_DB_PATH = path.join(
  process.cwd(),
  'artifacts',
  'marketplace-homepage',
  'marketplace-homepage.db',
);

function resolveDbPath(dbPath = DEFAULT_DB_PATH) {
  return path.isAbsolute(dbPath)
    ? dbPath
    : path.join(process.cwd(), dbPath);
}

function extractListingId(url) {
  const match = String(url || '').match(/\/marketplace\/item\/(\d+)/);
  return match ? match[1] : '';
}

function canonicalizeListingUrl(url) {
  const listingId = extractListingId(url);
  if (listingId) {
    return `https://www.facebook.com/marketplace/item/${listingId}/`;
  }

  try {
    const parsed = new URL(String(url || ''));
    return `${parsed.origin}${parsed.pathname}`;
  } catch (_) {
    return String(url || '').trim();
  }
}

function serializeJson(value) {
  return JSON.stringify(value ?? {}, null, 2);
}

function hashContent(value) {
  return crypto
    .createHash('sha256')
    .update(serializeJson(value))
    .digest('hex');
}

function normalizeKeyword(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function summarizeHomepageListingComparable(listing) {
  return {
    href: canonicalizeListingUrl(listing.href),
    cardTitle: String(listing.title || listing.card_title || '').trim(),
    cardText: String(listing.text || listing.card_text || '').trim(),
  };
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS homepage_listings (
      listing_id TEXT PRIMARY KEY,
      href TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'homepage',
      source_keyword TEXT NOT NULL DEFAULT '',
      card_title TEXT NOT NULL DEFAULT '',
      card_text TEXT NOT NULL DEFAULT '',
      raw_card_json TEXT NOT NULL DEFAULT '{}',
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      last_seen_rank INTEGER,
      detail_status TEXT NOT NULL DEFAULT 'pending',
      detail_attempts INTEGER NOT NULL DEFAULT 0,
      detail_last_error TEXT NOT NULL DEFAULT '',
      detail_started_at TEXT,
      detail_completed_at TEXT,
      claimed_by TEXT NOT NULL DEFAULT '',
      detail_title TEXT NOT NULL DEFAULT '',
      detail_price TEXT NOT NULL DEFAULT '',
      detail_location TEXT NOT NULL DEFAULT '',
      detail_condition TEXT NOT NULL DEFAULT '',
      detail_listed_ago TEXT NOT NULL DEFAULT '',
      detail_seller_name TEXT NOT NULL DEFAULT '',
      detail_json TEXT NOT NULL DEFAULT '{}',
      screenshot_path TEXT NOT NULL DEFAULT '',
      snapshot_path TEXT NOT NULL DEFAULT ''
    );
  `);

  ensureColumn(db, 'homepage_listings', 'source', "TEXT NOT NULL DEFAULT 'homepage'");
  ensureColumn(db, 'homepage_listings', 'source_keyword', "TEXT NOT NULL DEFAULT ''");

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_homepage_listings_href
    ON homepage_listings (href);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_homepage_listings_source_keyword
    ON homepage_listings (source_keyword, last_seen_at DESC);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_homepage_listings_backlog
    ON homepage_listings (detail_status, last_seen_rank, last_seen_at);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_homepage_listings_status_last_seen
    ON homepage_listings (detail_status, last_seen_at DESC);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_homepage_listings_status_first_seen
    ON homepage_listings (detail_status, first_seen_at ASC);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_homepage_listings_source_status_last_seen
    ON homepage_listings (source, detail_status, last_seen_at DESC);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_homepage_listings_recent
    ON homepage_listings (last_seen_at DESC, first_seen_at DESC);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_homepage_listings_completed
    ON homepage_listings (detail_completed_at DESC, last_seen_at DESC);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS search_title_bag (
      normalized_keyword TEXT PRIMARY KEY,
      keyword TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      times_seen INTEGER NOT NULL DEFAULT 1,
      last_source_keyword TEXT NOT NULL DEFAULT ''
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_search_title_bag_last_seen
    ON search_title_bag (last_seen_at DESC);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS listing_search_keywords (
      listing_id TEXT NOT NULL,
      normalized_keyword TEXT NOT NULL,
      keyword TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      times_seen INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (listing_id, normalized_keyword)
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_listing_search_keywords_keyword
    ON listing_search_keywords (normalized_keyword, last_seen_at DESC);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS listing_events (
      event_id TEXT PRIMARY KEY,
      workflow_run_id TEXT NOT NULL DEFAULT '',
      listing_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_at TEXT NOT NULL,
      worker_id TEXT NOT NULL DEFAULT '',
      source_url TEXT NOT NULL DEFAULT '',
      attempt INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT '',
      content_json TEXT NOT NULL DEFAULT '{}',
      content_hash TEXT NOT NULL DEFAULT '',
      screenshot_path TEXT NOT NULL DEFAULT '',
      snapshot_path TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '',
      FOREIGN KEY (listing_id) REFERENCES homepage_listings(listing_id)
    );
  `);

  ensureColumn(db, 'listing_events', 'workflow_run_id', "TEXT NOT NULL DEFAULT ''");

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_listing_events_listing
    ON listing_events (listing_id, event_at DESC);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_listing_events_type_time
    ON listing_events (event_type, event_at DESC);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_listing_events_workflow_time
    ON listing_events (workflow_run_id, event_at DESC);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_listing_events_worker_time
    ON listing_events (worker_id, event_at DESC);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_runs (
      run_id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      label TEXT NOT NULL,
      script TEXT NOT NULL,
      args_json TEXT NOT NULL DEFAULT '[]',
      pid INTEGER,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      exited_at TEXT NOT NULL DEFAULT '',
      exit_code INTEGER,
      signal TEXT NOT NULL DEFAULT '',
      os_checked_at TEXT NOT NULL DEFAULT '',
      os_alive INTEGER NOT NULL DEFAULT 0,
      logs_json TEXT NOT NULL DEFAULT '[]'
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_status_updated
    ON workflow_runs (status, updated_at DESC);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_events (
      event_id TEXT PRIMARY KEY,
      workflow_run_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT '',
      content_json TEXT NOT NULL DEFAULT '{}',
      error TEXT NOT NULL DEFAULT ''
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_workflow_events_run_time
    ON workflow_events (workflow_run_id, event_at DESC);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_workflow_events_type_time
    ON workflow_events (event_type, event_at DESC);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS resolve_queue_items (
      listing_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'queued',
      queued_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      queued_by TEXT NOT NULL DEFAULT 'viewer',
      workflow_run_id TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      FOREIGN KEY (listing_id) REFERENCES homepage_listings(listing_id)
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_resolve_queue_items_status_updated
    ON resolve_queue_items (status, updated_at DESC);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_resolve_queue_items_run
    ON resolve_queue_items (workflow_run_id, status);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS resolve_queue_events (
      event_id TEXT PRIMARY KEY,
      listing_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_at TEXT NOT NULL,
      workflow_run_id TEXT NOT NULL DEFAULT '',
      actor TEXT NOT NULL DEFAULT 'viewer',
      status TEXT NOT NULL DEFAULT '',
      content_json TEXT NOT NULL DEFAULT '{}',
      error TEXT NOT NULL DEFAULT '',
      FOREIGN KEY (listing_id) REFERENCES homepage_listings(listing_id)
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_resolve_queue_events_listing_time
    ON resolve_queue_events (listing_id, event_at DESC);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_resolve_queue_events_type_time
    ON resolve_queue_events (event_type, event_at DESC);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_resolve_queue_events_run_time
    ON resolve_queue_events (workflow_run_id, event_at DESC);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS purchase_history_documents (
      document_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_purchase_history_documents_updated
    ON purchase_history_documents (updated_at DESC);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS purchase_history_rows (
      document_id TEXT NOT NULL,
      record_id TEXT NOT NULL,
      canonical_key TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '',
      subcategory TEXT NOT NULL DEFAULT '',
      brand TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      mount TEXT NOT NULL DEFAULT '',
      purchase_at TEXT NOT NULL DEFAULT '',
      sold_at TEXT NOT NULL DEFAULT '',
      outcome TEXT NOT NULL DEFAULT '',
      data_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (document_id, record_id),
      FOREIGN KEY (document_id) REFERENCES purchase_history_documents(document_id) ON DELETE CASCADE
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_purchase_history_rows_document_updated
    ON purchase_history_rows (document_id, updated_at DESC);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_purchase_history_rows_identity
    ON purchase_history_rows (document_id, brand, model, mount);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS purchase_history_events (
      event_id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      record_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_at TEXT NOT NULL,
      data_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY (document_id) REFERENCES purchase_history_documents(document_id) ON DELETE CASCADE
    );
  `);

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_purchase_history_events_once
    ON purchase_history_events (document_id, record_id, event_type);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_purchase_history_events_document_time
    ON purchase_history_events (document_id, event_at DESC, created_at DESC);
  `);
}

function ensureColumn(db, tableName, columnName, definitionSql) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (columns.some((column) => column.name === columnName)) {
    return;
  }

  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definitionSql}`);
}

function openMarketplaceHomepageDatabase(dbPath = DEFAULT_DB_PATH) {
  const resolvedPath = resolveDbPath(dbPath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  const db = new DatabaseSync(resolvedPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  ensureSchema(db);
  return { db, dbPath: resolvedPath };
}

function closeMarketplaceHomepageDatabase(db) {
  if (db && typeof db.close === 'function') {
    db.close();
  }
}

function upsertHomepageListingWithStatus(db, listing, options = {}) {
  const now = options.seenAt || new Date().toISOString();
  const href = canonicalizeListingUrl(listing.href);
  const listingId = listing.listingId || extractListingId(href) || href;
  const rank = Number.isFinite(listing.rank) ? listing.rank : null;
  const cardTitle = String(listing.title || '').trim();
  const cardText = String(listing.text || '').trim();
  const source = normalizeKeyword(options.source || listing.source || 'homepage') || 'homepage';
  const sourceKeyword = normalizeKeyword(
    options.sourceKeyword
    || listing.sourceKeyword
    || listing.source_keyword,
  );
  const previousRow = getHomepageListing(db, listingId);
  const previousComparable = previousRow
    ? summarizeHomepageListingComparable(previousRow)
    : null;
  const nextComparable = summarizeHomepageListingComparable({
    href,
    title: cardTitle,
    text: cardText,
  });
  const rawCardJson = serializeJson({
    ...listing,
    href,
    listingId,
    rank,
    source,
    sourceKeyword,
  });

  const statement = db.prepare(`
    INSERT INTO homepage_listings (
      listing_id,
      href,
      source,
      source_keyword,
      card_title,
      card_text,
      raw_card_json,
      first_seen_at,
      last_seen_at,
      last_seen_rank,
      detail_status,
      detail_last_error
    ) VALUES (
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      'pending',
      ''
    )
    ON CONFLICT(listing_id) DO UPDATE SET
      href = excluded.href,
      source = excluded.source,
      source_keyword = excluded.source_keyword,
      card_title = excluded.card_title,
      card_text = excluded.card_text,
      raw_card_json = excluded.raw_card_json,
      last_seen_at = excluded.last_seen_at,
      last_seen_rank = excluded.last_seen_rank,
      detail_status = CASE
        WHEN homepage_listings.detail_status IN ('done', 'processing', 'sold', 'pending_sale')
          THEN homepage_listings.detail_status
        ELSE 'pending'
      END,
      detail_last_error = CASE
        WHEN homepage_listings.detail_status IN ('done', 'processing', 'sold', 'pending_sale')
          THEN homepage_listings.detail_last_error
        ELSE ''
      END
  `);

  statement.run(
    listingId,
    href,
    source,
    sourceKeyword,
    cardTitle,
    cardText,
    rawCardJson,
    now,
    now,
    rank,
  );

  const row = getHomepageListing(db, listingId);
  const sameContent = Boolean(
    previousComparable
    && previousComparable.href === nextComparable.href
    && previousComparable.cardTitle === nextComparable.cardTitle
    && previousComparable.cardText === nextComparable.cardText
  );
  const rankChanged = Boolean(previousRow && previousRow.last_seen_rank !== rank);

  return {
    row,
    previousRow,
    outcome: previousRow
      ? (sameContent && !rankChanged ? 'existing_same' : 'existing_updated')
      : 'new',
    sameContent,
    rankChanged,
  };
}

function upsertHomepageListing(db, listing, options = {}) {
  return upsertHomepageListingWithStatus(db, listing, options).row;
}

function getHomepageListing(db, listingId) {
  return db.prepare(`
    SELECT *
    FROM homepage_listings
    WHERE listing_id = ?
  `).get(listingId);
}

function normalizeBacklogTimeField(value) {
  const normalized = normalizeKeyword(value || 'last_seen').toLowerCase().replace(/-/g, '_');
  switch (normalized) {
    case '':
    case 'last':
    case 'last_seen':
    case 'last_seen_at':
      return 'last_seen_at';
    case 'first':
    case 'first_seen':
    case 'first_seen_at':
      return 'first_seen_at';
    default:
      throw new Error(`Unknown backlog time field: ${value}`);
  }
}

function normalizeBacklogOrder(value) {
  const normalized = normalizeKeyword(value || 'priority').toLowerCase().replace(/-/g, '_');
  switch (normalized) {
    case '':
    case 'priority':
    case 'default':
      return 'priority';
    case 'rank':
    case 'ranked':
      return 'rank';
    case 'latest':
    case 'newest':
    case 'newest_seen':
      return 'latest';
    case 'earliest':
    case 'oldest':
    case 'oldest_seen':
      return 'earliest';
    default:
      throw new Error(`Unknown backlog order: ${value}`);
  }
}

function buildBacklogClaimOrderSql(order, timeColumn) {
  const statusPriority = `
        CASE detail_status
          WHEN 'pending' THEN 0
          WHEN 'error' THEN 1
          ELSE 2
        END`;

  switch (order) {
    case 'latest':
      return `${statusPriority},
        ${timeColumn} DESC,
        COALESCE(last_seen_rank, 999999) ASC,
        first_seen_at ASC`;
    case 'earliest':
      return `${statusPriority},
        ${timeColumn} ASC,
        COALESCE(last_seen_rank, 999999) ASC,
        first_seen_at ASC`;
    case 'rank':
    case 'priority':
    default:
      return `${statusPriority},
        COALESCE(last_seen_rank, 999999) ASC,
        last_seen_at DESC,
        first_seen_at ASC`;
  }
}

function buildBacklogCandidateQueryParts(options = {}) {
  const staleAfterSeconds = Number.isFinite(options.staleAfterSeconds)
    ? options.staleAfterSeconds
    : 30 * 60;
  const staleBefore = new Date(Date.now() - (staleAfterSeconds * 1000)).toISOString();
  const maxAttempts = Number.isFinite(options.maxAttempts)
    ? Math.max(1, options.maxAttempts)
    : null;
  const retryDelaySeconds = Number.isFinite(options.retryDelaySeconds)
    ? Math.max(0, options.retryDelaySeconds)
    : 0;
  const retryBefore = new Date(Date.now() - (retryDelaySeconds * 1000)).toISOString();
  const sourceFilter = normalizeKeyword(options.sourceFilter || '');
  const keywordFilter = normalizeKeyword(options.keywordFilter || '').toLowerCase();
  const statusFilter = normalizeKeyword(options.statusFilter || 'all').toLowerCase();
  const backlogOrder = normalizeBacklogOrder(options.backlogOrder || options.order || options.orderBy);
  const backlogTimeField = normalizeBacklogTimeField(options.seenTimeField || options.timeField || options.backlogTimeField);
  const seenAfter = normalizeKeyword(options.seenAfter || options.after || '');
  const seenBefore = normalizeKeyword(options.seenBefore || options.before || '');
  const listingIds = Array.isArray(options.listingIds)
    ? [...new Set(options.listingIds.map((id) => String(id || '').trim()).filter(Boolean))]
    : [];
  const listingIdTable = String(options.listingIdTable || '').trim();
  if (listingIdTable && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(listingIdTable)) {
    throw new Error(`Invalid listingIdTable: ${listingIdTable}`);
  }
  const params = [];
  let extraWhereSql = '';
  let statusWhereSql = '';

  switch (statusFilter) {
    case '':
    case 'all':
    case 'eligible':
      statusWhereSql = `
        (
          detail_status IN ('pending', 'error')
          OR (
            detail_status = 'processing'
            AND COALESCE(detail_started_at, '') != ''
            AND detail_started_at <= ?
          )
        )
      `;
      params.push(staleBefore);
      break;
    case 'pending':
      statusWhereSql = "detail_status = 'pending'";
      break;
    case 'error':
    case 'retryable-error':
    case 'retryable_errors':
      statusWhereSql = "detail_status = 'error'";
      break;
    case 'processing':
    case 'stale-processing':
    case 'stale_processing':
      statusWhereSql = `
        detail_status = 'processing'
        AND COALESCE(detail_started_at, '') != ''
        AND detail_started_at <= ?
      `;
      params.push(staleBefore);
      break;
    case 'sold':
      statusWhereSql = "detail_status = 'sold'";
      break;
    case 'pending_sale':
    case 'pending-sale':
      statusWhereSql = "detail_status = 'pending_sale'";
      break;
    case 'inactive':
      statusWhereSql = "detail_status IN ('sold', 'pending_sale')";
      break;
    default:
      throw new Error(`Unknown statusFilter: ${options.statusFilter}`);
  }

  if (maxAttempts !== null) {
    extraWhereSql += ' AND detail_attempts < ?';
    params.push(maxAttempts);
  }

  if (retryDelaySeconds > 0) {
    extraWhereSql += `
      AND (
        detail_status != 'error'
        OR COALESCE(detail_completed_at, detail_started_at, first_seen_at) <= ?
      )
    `;
    params.push(retryBefore);
  }

  if (sourceFilter) {
    extraWhereSql += ' AND source = ?';
    params.push(sourceFilter);
  }

  if (keywordFilter) {
    extraWhereSql += ' AND lower(source_keyword) LIKE ?';
    params.push(`%${keywordFilter}%`);
  }

  if (listingIds.length > 0) {
    extraWhereSql += ` AND listing_id IN (${listingIds.map(() => '?').join(', ')})`;
    params.push(...listingIds);
  }

  if (listingIdTable) {
    extraWhereSql += ` AND listing_id IN (SELECT listing_id FROM ${listingIdTable})`;
  }

  if (seenAfter) {
    extraWhereSql += ` AND ${backlogTimeField} >= ?`;
    params.push(seenAfter);
  }

  if (seenBefore) {
    extraWhereSql += ` AND ${backlogTimeField} <= ?`;
    params.push(seenBefore);
  }

  const orderSql = buildBacklogClaimOrderSql(backlogOrder, backlogTimeField);

  return {
    statusWhereSql,
    extraWhereSql,
    params,
    orderSql,
    backlogOrder,
    backlogTimeField,
  };
}

function listBacklogCandidates(db, options = {}) {
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(options.limit, 200)) : 25;
  const parts = buildBacklogCandidateQueryParts(options);
  return db.prepare(`
    SELECT
      listing_id,
      href,
      source,
      source_keyword,
      card_title,
      detail_title,
      detail_status,
      detail_attempts,
      first_seen_at,
      last_seen_at,
      last_seen_rank,
      detail_started_at,
      detail_completed_at
    FROM homepage_listings
    WHERE ${parts.statusWhereSql}
      ${parts.extraWhereSql}
    ORDER BY
      ${parts.orderSql}
    LIMIT ?
  `).all(...parts.params, limit);
}

function claimNextPendingHomepageListing(db, options = {}) {
  const now = options.claimedAt || new Date().toISOString();
  const workerId = String(options.workerId || `worker-${process.pid}`);
  const parts = buildBacklogCandidateQueryParts(options);

  db.exec('BEGIN IMMEDIATE');
  try {
    const candidate = db.prepare(`
      SELECT listing_id
      FROM homepage_listings
      WHERE ${parts.statusWhereSql}
        ${parts.extraWhereSql}
      ORDER BY
        ${parts.orderSql}
      LIMIT 1
    `).get(...parts.params);

    if (!candidate) {
      db.exec('COMMIT');
      return null;
    }

    db.prepare(`
      UPDATE homepage_listings
      SET
        detail_status = 'processing',
        detail_attempts = detail_attempts + 1,
        detail_started_at = ?,
        claimed_by = ?,
        detail_last_error = ''
      WHERE listing_id = ?
    `).run(now, workerId, candidate.listing_id);

    const claimed = getHomepageListing(db, candidate.listing_id);
    if (typeof options.startEventBuilder === 'function') {
      appendListingEvent(db, options.startEventBuilder(claimed));
    }

    db.exec('COMMIT');
    return claimed;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function buildListingEventId(eventAt, listingId, eventType) {
  const entropy = crypto.randomBytes(8).toString('hex');
  return [
    String(eventAt || new Date().toISOString()).replace(/[^0-9A-Za-z]/g, ''),
    String(listingId || 'unknown'),
    String(eventType || 'event'),
    entropy,
  ].join('-');
}

function appendListingEvent(db, event) {
  const eventAt = event.eventAt || new Date().toISOString();
  const listingId = String(event.listingId || event.listing_id || '').trim();
  if (!listingId) {
    throw new Error('appendListingEvent requires listingId');
  }

  const eventType = normalizeKeyword(event.eventType || event.event_type || 'detail_capture_event');
  const content = event.content || event.contentJson || {};
  const contentJson = serializeJson(content);
  const contentHash = String(event.contentHash || event.content_hash || hashContent(content)).trim();
  const eventId = String(event.eventId || event.event_id || buildListingEventId(eventAt, listingId, eventType));
  const workflowRunId = String(event.workflowRunId || event.workflow_run_id || '').trim();

  db.prepare(`
    INSERT INTO listing_events (
      event_id,
      workflow_run_id,
      listing_id,
      event_type,
      event_at,
      worker_id,
      source_url,
      attempt,
      status,
      content_json,
      content_hash,
      screenshot_path,
      snapshot_path,
      error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventId,
    workflowRunId,
    listingId,
    eventType,
    eventAt,
    String(event.workerId || event.worker_id || '').trim(),
    String(event.sourceUrl || event.source_url || '').trim(),
    Number.isFinite(event.attempt) ? event.attempt : 0,
    String(event.status || '').trim(),
    contentJson,
    contentHash,
    String(event.screenshotPath || event.screenshot_path || '').trim(),
    String(event.snapshotPath || event.snapshot_path || '').trim(),
    String(event.error || '').trim(),
  );

  return getListingEvent(db, eventId);
}

function getListingEvent(db, eventId) {
  return db.prepare(`
    SELECT *
    FROM listing_events
    WHERE event_id = ?
  `).get(String(eventId));
}

function getListingEvents(db, listingId, options = {}) {
  const limit = Number.isFinite(options.limit) ? Math.max(1, options.limit) : 50;
  return db.prepare(`
    SELECT *
    FROM listing_events
    WHERE listing_id = ?
    ORDER BY event_at DESC
    LIMIT ?
  `).all(String(listingId), limit);
}

function getLatestListingEvent(db, listingId, options = {}) {
  const eventType = normalizeKeyword(options.eventType || '');
  const params = [String(listingId)];
  let eventTypeSql = '';

  if (eventType) {
    eventTypeSql = 'AND event_type = ?';
    params.push(eventType);
  }

  return db.prepare(`
    SELECT *
    FROM listing_events
    WHERE listing_id = ?
      ${eventTypeSql}
    ORDER BY event_at DESC
    LIMIT 1
  `).get(...params) || null;
}

function markHomepageListingProcessed(db, listingId, detailRecord) {
  const completedAt = new Date().toISOString();
  const detailJson = serializeJson(detailRecord);
  const listingContent = detailRecord.listingContent || {};

  db.prepare(`
    UPDATE homepage_listings
    SET
      detail_status = 'done',
      detail_last_error = '',
      detail_completed_at = ?,
      claimed_by = '',
      detail_title = ?,
      detail_price = ?,
      detail_location = ?,
      detail_condition = ?,
      detail_listed_ago = ?,
      detail_seller_name = ?,
      detail_json = ?,
      screenshot_path = ?,
      snapshot_path = ?
    WHERE listing_id = ?
  `).run(
    completedAt,
    String(detailRecord.title || listingContent.title || '').trim(),
    String(listingContent.price || '').trim(),
    String(listingContent.location || '').trim(),
    String(listingContent.condition || '').trim(),
    String(listingContent.listedAgo || '').trim(),
    String(listingContent.sellerName || '').trim(),
    detailJson,
    String(detailRecord.screenshotPath || '').trim(),
    String(detailRecord.snapshotPath || '').trim(),
    listingId,
  );

  return getHomepageListing(db, listingId);
}

function markHomepageListingFailed(db, listingId, error) {
  const completedAt = new Date().toISOString();
  db.prepare(`
    UPDATE homepage_listings
    SET
      detail_status = 'error',
      detail_last_error = ?,
      detail_completed_at = ?,
      claimed_by = ''
    WHERE listing_id = ?
  `).run(String(error || 'Unknown processing error').trim(), completedAt, listingId);

  return getHomepageListing(db, listingId);
}

function releaseHomepageListingClaim(db, listingId, options = {}) {
  const completedAt = options.completedAt || new Date().toISOString();
  const workerId = String(options.workerId || '').trim();
  const nextStatus = String(options.nextStatus || 'pending').trim();
  const reason = String(options.reason || 'claim released').trim();
  const decrementAttempts = options.decrementAttempts === true;
  if (!['pending', 'error'].includes(nextStatus)) {
    throw new Error(`Unsupported released listing status: ${nextStatus}`);
  }

  const result = db.prepare(`
    UPDATE homepage_listings
    SET
      detail_status = ?,
      detail_last_error = ?,
      detail_completed_at = ?,
      claimed_by = '',
      detail_attempts = CASE
        WHEN ? THEN max(detail_attempts - 1, 0)
        ELSE detail_attempts
      END
    WHERE listing_id = ?
      AND detail_status = 'processing'
      AND (? = '' OR claimed_by = ?)
  `).run(
    nextStatus,
    reason,
    completedAt,
    decrementAttempts ? 1 : 0,
    listingId,
    workerId,
    workerId,
  );

  return {
    changed: result.changes > 0,
    listing: getHomepageListing(db, listingId),
  };
}

function markHomepageListingInactive(db, listingId, status, detailRecord, reason = '') {
  const inactiveStatus = status === 'pending_sale' ? 'pending_sale' : 'sold';
  const completedAt = new Date().toISOString();
  const detailJson = serializeJson(detailRecord);
  const listingContent = detailRecord.listingContent || {};
  const detailLastError = reason || listingContent.availabilityReason || inactiveStatus;

  db.prepare(`
    UPDATE homepage_listings
    SET
      detail_status = ?,
      detail_last_error = ?,
      detail_completed_at = ?,
      claimed_by = '',
      detail_title = ?,
      detail_price = ?,
      detail_location = ?,
      detail_condition = ?,
      detail_listed_ago = ?,
      detail_seller_name = ?,
      detail_json = ?,
      screenshot_path = ?,
      snapshot_path = ?
    WHERE listing_id = ?
  `).run(
    inactiveStatus,
    String(detailLastError || '').trim(),
    completedAt,
    String(detailRecord.title || listingContent.title || '').trim(),
    String(listingContent.price || '').trim(),
    String(listingContent.location || '').trim(),
    String(listingContent.condition || '').trim(),
    String(listingContent.listedAgo || '').trim(),
    String(listingContent.sellerName || '').trim(),
    detailJson,
    String(detailRecord.screenshotPath || '').trim(),
    String(detailRecord.snapshotPath || '').trim(),
    listingId,
  );

  return getHomepageListing(db, listingId);
}

function getHomepageListingCounts(db) {
  const rows = db.prepare(`
    SELECT detail_status, COUNT(*) AS count
    FROM homepage_listings
    GROUP BY detail_status
  `).all();

  return rows.reduce((accumulator, row) => ({
    ...accumulator,
    [row.detail_status]: row.count,
  }), {
    pending: 0,
    processing: 0,
    done: 0,
    error: 0,
    sold: 0,
    pending_sale: 0,
  });
}

function runTransaction(db, callback) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function normalizeDocumentId(value, fallback = 'history') {
  const text = String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  return text || fallback;
}

function uniquePurchaseHistoryDocumentId(db, name) {
  const base = normalizeDocumentId(name || 'history');
  let candidate = base;
  let suffix = 2;
  while (getPurchaseHistoryDocument(db, candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function normalizePurchaseHistoryDocumentRow(row) {
  if (!row) {
    return null;
  }
  return {
    document_id: row.document_id,
    name: row.name,
    description: row.description || '',
    created_at: row.created_at,
    updated_at: row.updated_at,
    row_count: row.row_count || 0,
  };
}

function normalizePurchaseHistoryRow(row) {
  if (!row) {
    return null;
  }
  return {
    document_id: row.document_id,
    record_id: row.record_id,
    canonical_key: row.canonical_key || '',
    title: row.title || '',
    category: row.category || '',
    subcategory: row.subcategory || '',
    brand: row.brand || '',
    model: row.model || '',
    mount: row.mount || '',
    purchase_at: row.purchase_at || '',
    sold_at: row.sold_at || '',
    outcome: row.outcome || '',
    data: parseJsonObject(row.data_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function createPurchaseHistoryDocument(db, document) {
  const now = document.createdAt || document.created_at || new Date().toISOString();
  const name = String(document.name || 'Purchase History').trim() || 'Purchase History';
  const documentId = String(document.documentId || document.document_id || uniquePurchaseHistoryDocumentId(db, name)).trim();
  db.prepare(`
    INSERT INTO purchase_history_documents (
      document_id,
      name,
      description,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(document_id) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      updated_at = excluded.updated_at
  `).run(
    documentId,
    name,
    String(document.description || '').trim(),
    now,
    document.updatedAt || document.updated_at || now,
  );
  return getPurchaseHistoryDocument(db, documentId);
}

function listPurchaseHistoryDocuments(db) {
  return db.prepare(`
    SELECT
      documents.*,
      COUNT(rows.record_id) AS row_count
    FROM purchase_history_documents documents
    LEFT JOIN purchase_history_rows rows
      ON rows.document_id = documents.document_id
    GROUP BY documents.document_id
    ORDER BY documents.updated_at DESC, documents.created_at DESC
  `).all().map(normalizePurchaseHistoryDocumentRow);
}

function getPurchaseHistoryDocument(db, documentId) {
  return normalizePurchaseHistoryDocumentRow(db.prepare(`
    SELECT
      documents.*,
      COUNT(rows.record_id) AS row_count
    FROM purchase_history_documents documents
    LEFT JOIN purchase_history_rows rows
      ON rows.document_id = documents.document_id
    WHERE documents.document_id = ?
    GROUP BY documents.document_id
  `).get(String(documentId || '').trim()));
}

function deletePurchaseHistoryDocument(db, documentId) {
  const id = String(documentId || '').trim();
  if (!id) {
    throw new Error('deletePurchaseHistoryDocument requires documentId');
  }
  return runTransaction(db, () => {
    db.prepare('DELETE FROM purchase_history_events WHERE document_id = ?').run(id);
    db.prepare('DELETE FROM purchase_history_rows WHERE document_id = ?').run(id);
    const result = db.prepare('DELETE FROM purchase_history_documents WHERE document_id = ?').run(id);
    return { deleted: result.changes || 0 };
  });
}

function purchaseHistoryRowProjection(row) {
  const data = row && typeof row === 'object' ? row : {};
  const recordId = String(data.record_id || data.recordId || '').trim();
  if (!recordId) {
    throw new Error('purchase history row requires record_id');
  }
  return {
    recordId,
    canonicalKey: String(data.canonical_key || data.canonicalKey || '').trim(),
    title: String(data.title || '').trim(),
    category: String(data.category || '').trim(),
    subcategory: String(data.subcategory || '').trim(),
    brand: String(data.brand || '').trim().toLowerCase(),
    model: String(data.model || '').trim().toLowerCase(),
    mount: String(data.mount || '').trim().toLowerCase(),
    purchaseAt: String(data.purchase_at || data.purchaseAt || '').trim(),
    soldAt: String(data.sold_at || data.soldAt || '').trim(),
    outcome: String(data.outcome || '').trim(),
    data: {
      ...data,
      record_id: recordId,
    },
  };
}

function normalizeInventoryStatus(data = {}) {
  const status = String(data.inventory_status || data.inventoryStatus || '').trim().toLowerCase();
  if (status === 'hold' || status === 'listed' || status === 'sold') {
    return status;
  }
  const outcome = String(data.outcome || '').trim();
  if (
    data.decision === 'sold'
    || data.sold_at
    || data.sold_price_cad
    || outcome === 'sold_profitable'
    || outcome === 'sold_break_even'
    || outcome === 'loss'
  ) {
    return 'sold';
  }
  if (data.listed_at || data.list_price_cad) {
    return 'listed';
  }
  return 'hold';
}

function purchaseHistoryLifecycleEvents(data = {}) {
  const status = normalizeInventoryStatus(data);
  const addedAt = String(data.purchase_at || data.decision_at || data.created_at || '').trim();
  const listedAt = String(data.listed_at || '').trim();
  const soldAt = String(data.sold_at || '').trim();
  const events = [{
    eventType: 'inventory_added',
    eventAt: addedAt || new Date().toISOString(),
  }];
  if (status === 'listed' || status === 'sold' || listedAt) {
    events.push({
      eventType: 'listed',
      eventAt: listedAt || addedAt || new Date().toISOString(),
    });
  }
  if (status === 'sold' || soldAt || data.sold_price_cad) {
    events.push({
      eventType: 'sold',
      eventAt: soldAt || listedAt || addedAt || new Date().toISOString(),
    });
  }
  return events;
}

function appendPurchaseHistoryEvent(db, event) {
  const documentId = String(event.documentId || event.document_id || '').trim();
  const recordId = String(event.recordId || event.record_id || '').trim();
  const eventType = String(event.eventType || event.event_type || '').trim();
  if (!documentId || !recordId || !eventType) {
    throw new Error('purchase history event requires documentId, recordId, and eventType');
  }
  const createdAt = event.createdAt || event.created_at || new Date().toISOString();
  const eventAt = String(event.eventAt || event.event_at || createdAt).trim();
  const eventId = String(event.eventId || event.event_id || `${documentId}:${recordId}:${eventType}`).trim();
  db.prepare(`
    INSERT OR IGNORE INTO purchase_history_events (
      event_id,
      document_id,
      record_id,
      event_type,
      event_at,
      data_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventId,
    documentId,
    recordId,
    eventType,
    eventAt,
    serializeJson(event.data || {}),
    createdAt,
  );
}

function emitPurchaseHistoryLifecycleEvents(db, documentId, projection, previousData, now) {
  const previousTypes = new Set(purchaseHistoryLifecycleEvents(previousData || {}).map((event) => event.eventType));
  for (const event of purchaseHistoryLifecycleEvents(projection.data)) {
    if (previousData && previousTypes.has(event.eventType)) {
      continue;
    }
    appendPurchaseHistoryEvent(db, {
      documentId,
      recordId: projection.recordId,
      eventType: event.eventType,
      eventAt: event.eventAt,
      createdAt: now,
      data: {
        title: projection.title,
        inventory_status: normalizeInventoryStatus(projection.data),
        price_cad: projection.data.sold_price_cad || projection.data.list_price_cad || '',
      },
    });
  }
}

function upsertPurchaseHistoryRows(db, documentId, rows, options = {}) {
  const id = String(documentId || '').trim();
  if (!id) {
    throw new Error('upsertPurchaseHistoryRows requires documentId');
  }
  const document = getPurchaseHistoryDocument(db, id);
  if (!document) {
    throw new Error(`Unknown purchase history document: ${id}`);
  }
  const incomingRows = Array.isArray(rows) ? rows : [rows];
  const now = options.updatedAt || new Date().toISOString();
  return runTransaction(db, () => {
    let inserted = 0;
    let updated = 0;
    const statement = db.prepare(`
      INSERT INTO purchase_history_rows (
        document_id,
        record_id,
        canonical_key,
        title,
        category,
        subcategory,
        brand,
        model,
        mount,
        purchase_at,
        sold_at,
        outcome,
        data_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(document_id, record_id) DO UPDATE SET
        canonical_key = excluded.canonical_key,
        title = excluded.title,
        category = excluded.category,
        subcategory = excluded.subcategory,
        brand = excluded.brand,
        model = excluded.model,
        mount = excluded.mount,
        purchase_at = excluded.purchase_at,
        sold_at = excluded.sold_at,
        outcome = excluded.outcome,
        data_json = excluded.data_json,
        updated_at = excluded.updated_at
    `);

    for (const row of incomingRows) {
      const projection = purchaseHistoryRowProjection(row);
      const previous = db.prepare(`
        SELECT record_id, data_json
        FROM purchase_history_rows
        WHERE document_id = ? AND record_id = ?
      `).get(id, projection.recordId);
      statement.run(
        id,
        projection.recordId,
        projection.canonicalKey,
        projection.title,
        projection.category,
        projection.subcategory,
        projection.brand,
        projection.model,
        projection.mount,
        projection.purchaseAt,
        projection.soldAt,
        projection.outcome,
        serializeJson(projection.data),
        now,
        now,
      );
      emitPurchaseHistoryLifecycleEvents(
        db,
        id,
        projection,
        previous ? parseJsonObject(previous.data_json) : null,
        now,
      );
      if (previous) {
        updated += 1;
      } else {
        inserted += 1;
      }
    }

    db.prepare(`
      UPDATE purchase_history_documents
      SET updated_at = ?
      WHERE document_id = ?
    `).run(now, id);

    return {
      document: getPurchaseHistoryDocument(db, id),
      inserted,
      updated,
      total: incomingRows.length,
    };
  });
}

function listPurchaseHistoryRows(db, documentId, options = {}) {
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(options.limit, 10000)) : 10000;
  return db.prepare(`
    SELECT *
    FROM purchase_history_rows
    WHERE document_id = ?
    ORDER BY COALESCE(purchase_at, '') DESC, updated_at DESC, record_id DESC
    LIMIT ?
  `).all(String(documentId || '').trim(), limit).map(normalizePurchaseHistoryRow);
}

function normalizePurchaseHistoryEventRow(row) {
  if (!row) {
    return null;
  }
  return {
    event_id: row.event_id,
    document_id: row.document_id,
    record_id: row.record_id,
    event_type: row.event_type,
    event_at: row.event_at,
    data: parseJsonObject(row.data_json),
    created_at: row.created_at,
  };
}

function listPurchaseHistoryEvents(db, options = {}) {
  const documentId = String(options.documentId || options.document_id || '').trim();
  const recordId = String(options.recordId || options.record_id || '').trim();
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(options.limit, 10000)) : 1000;
  const filters = [];
  const params = [];
  if (documentId) {
    filters.push('document_id = ?');
    params.push(documentId);
  }
  if (recordId) {
    filters.push('record_id = ?');
    params.push(recordId);
  }
  params.push(limit);
  return db.prepare(`
    SELECT *
    FROM purchase_history_events
    ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
    ORDER BY event_at DESC, created_at DESC
    LIMIT ?
  `).all(...params).map(normalizePurchaseHistoryEventRow);
}

function normalizeEventRegistryRow(row) {
  if (!row) {
    return null;
  }
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

function listEventRegistry(db, options = {}) {
  const source = String(options.source || 'all').trim().toLowerCase();
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(options.limit, 1000)) : 200;
  const rows = db.prepare(`
    SELECT *
    FROM (
      SELECT
        'inventory' AS source,
        events.event_id,
        events.event_type,
        events.event_at,
        COALESCE(rows.outcome, '') AS status,
        events.record_id AS subject_id,
        COALESCE(rows.title, events.record_id) AS title,
        events.data_json
      FROM purchase_history_events events
      LEFT JOIN purchase_history_rows rows
        ON rows.document_id = events.document_id
        AND rows.record_id = events.record_id
      UNION ALL
      SELECT
        'listing' AS source,
        events.event_id,
        events.event_type,
        events.event_at,
        events.status,
        events.listing_id AS subject_id,
        COALESCE(listings.detail_title, listings.card_title, events.listing_id) AS title,
        events.content_json AS data_json
      FROM listing_events events
      LEFT JOIN homepage_listings listings
        ON listings.listing_id = events.listing_id
      UNION ALL
      SELECT
        'workflow' AS source,
        events.event_id,
        events.event_type,
        events.event_at,
        events.status,
        events.workflow_run_id AS subject_id,
        COALESCE(runs.label, events.workflow_run_id) AS title,
        events.content_json AS data_json
      FROM workflow_events events
      LEFT JOIN workflow_runs runs
        ON runs.run_id = events.workflow_run_id
    )
    WHERE (? = 'all' OR source = ?)
    ORDER BY event_at DESC
    LIMIT ?
  `).all(source, source, limit);
  return rows.map(normalizeEventRegistryRow);
}

function mergePurchaseHistoryDocuments(db, options = {}) {
  const sourceDocumentId = String(options.sourceDocumentId || options.source_document_id || '').trim();
  const targetDocumentId = String(options.targetDocumentId || options.target_document_id || '').trim();
  if (!sourceDocumentId || !targetDocumentId) {
    throw new Error('mergePurchaseHistoryDocuments requires sourceDocumentId and targetDocumentId');
  }
  if (sourceDocumentId === targetDocumentId) {
    throw new Error('Cannot merge a purchase history document into itself');
  }
  const source = getPurchaseHistoryDocument(db, sourceDocumentId);
  const target = getPurchaseHistoryDocument(db, targetDocumentId);
  if (!source) {
    throw new Error(`Unknown source purchase history document: ${sourceDocumentId}`);
  }
  if (!target) {
    throw new Error(`Unknown target purchase history document: ${targetDocumentId}`);
  }
  const sourceRows = listPurchaseHistoryRows(db, sourceDocumentId).map((row) => row.data);
  const result = upsertPurchaseHistoryRows(db, targetDocumentId, sourceRows);
  return {
    source,
    target: getPurchaseHistoryDocument(db, targetDocumentId),
    inserted: result.inserted,
    updated: result.updated,
    total: result.total,
  };
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
  if (!row) {
    return null;
  }

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
  if (!row) {
    return null;
  }

  return {
    listing_id: row.listing_id,
    status: row.status,
    queued_at: row.queued_at,
    updated_at: row.updated_at,
    queued_by: row.queued_by,
    workflow_run_id: row.workflow_run_id || '',
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

function appendResolveQueueEvent(db, event) {
  const eventAt = event.eventAt || event.event_at || new Date().toISOString();
  const listingId = String(event.listingId || event.listing_id || '').trim();
  if (!listingId) {
    throw new Error('appendResolveQueueEvent requires listingId');
  }

  const eventType = normalizeKeyword(event.eventType || event.event_type || 'resolve_queue_event');
  const eventId = String(event.eventId || event.event_id || buildResolveQueueEventId(eventAt, listingId, eventType));

  db.prepare(`
    INSERT INTO resolve_queue_events (
      event_id,
      listing_id,
      event_type,
      event_at,
      workflow_run_id,
      actor,
      status,
      content_json,
      error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventId,
    listingId,
    eventType,
    eventAt,
    String(event.workflowRunId || event.workflow_run_id || '').trim(),
    String(event.actor || 'viewer').trim(),
    String(event.status || '').trim(),
    serializeJson(event.content || event.contentJson || {}),
    String(event.error || '').trim(),
  );

  return normalizeResolveQueueEventRow(db.prepare(`
    SELECT *
    FROM resolve_queue_events
    WHERE event_id = ?
  `).get(eventId));
}

function activeResolveQueueStatuses() {
  return ['queued', 'dispatched', 'failed'];
}

function listResolveQueueItems(db, options = {}) {
  const statuses = Array.isArray(options.statuses)
    ? uniqueStrings(options.statuses)
    : activeResolveQueueStatuses();
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(options.limit, 500)) : 200;
  const statusSql = statuses.length
    ? `WHERE q.status IN (${statuses.map(() => '?').join(', ')})`
    : '';
  return db.prepare(`
    SELECT
      q.*,
      h.href,
      h.detail_status,
      h.card_title,
      h.detail_title,
      h.source,
      h.source_keyword,
      h.last_seen_rank,
      h.last_seen_at
    FROM resolve_queue_items q
    LEFT JOIN homepage_listings h ON h.listing_id = q.listing_id
    ${statusSql}
    ORDER BY
      CASE q.status
        WHEN 'queued' THEN 0
        WHEN 'dispatched' THEN 1
        WHEN 'failed' THEN 2
        ELSE 3
      END,
      q.queued_at ASC
    LIMIT ?
  `).all(...statuses, limit).map(normalizeResolveQueueItemRow);
}

function listResolveQueueEvents(db, options = {}) {
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(options.limit, 200)) : 50;
  return db.prepare(`
    SELECT *
    FROM resolve_queue_events
    ORDER BY event_at DESC
    LIMIT ?
  `).all(limit).map(normalizeResolveQueueEventRow);
}

function getResolveQueueCounts(db) {
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM resolve_queue_items
    GROUP BY status
  `).all();
  return rows.reduce((accumulator, row) => ({
    ...accumulator,
    [row.status]: row.count,
  }), {
    queued: 0,
    dispatched: 0,
    failed: 0,
    completed: 0,
    cleared: 0,
  });
}

function validBacklogListingIds(db, listingIds) {
  const ids = uniqueStrings(listingIds);
  if (!ids.length) {
    return [];
  }

  return db.prepare(`
    SELECT listing_id
    FROM homepage_listings
    WHERE listing_id IN (${ids.map(() => '?').join(', ')})
      AND detail_status IN ('pending', 'error', 'processing')
  `).all(...ids).map((row) => row.listing_id);
}

function addResolveQueueItems(db, listingIds, options = {}) {
  const requestedIds = uniqueStrings(listingIds);
  const validIds = validBacklogListingIds(db, requestedIds);
  const validIdSet = new Set(validIds);
  const skippedIds = requestedIds.filter((listingId) => !validIdSet.has(listingId));
  const actor = String(options.actor || 'viewer').trim() || 'viewer';
  const now = options.queuedAt || new Date().toISOString();
  let addedCount = 0;

  runTransaction(db, () => {
    for (const listingId of validIds) {
      const previous = db.prepare(`
        SELECT status
        FROM resolve_queue_items
        WHERE listing_id = ?
      `).get(listingId);
      if (previous?.status !== 'queued') {
        addedCount += 1;
      }
      db.prepare(`
        INSERT INTO resolve_queue_items (
          listing_id,
          status,
          queued_at,
          updated_at,
          queued_by,
          workflow_run_id,
          note
        ) VALUES (?, 'queued', ?, ?, ?, '', '')
        ON CONFLICT(listing_id) DO UPDATE SET
          status = 'queued',
          queued_at = excluded.queued_at,
          updated_at = excluded.updated_at,
          queued_by = excluded.queued_by,
          workflow_run_id = '',
          note = ''
      `).run(listingId, now, now, actor);
      appendResolveQueueEvent(db, {
        listingId,
        eventType: previous ? 'resolve_queue_requeued' : 'resolve_queue_added',
        eventAt: now,
        actor,
        status: 'queued',
        content: {
          previousStatus: previous?.status || '',
        },
      });
    }
  });

  return {
    requestedIds,
    listingIds: validIds,
    skippedIds,
    addedCount,
    items: listResolveQueueItems(db),
    counts: getResolveQueueCounts(db),
  };
}

function clearResolveQueueItems(db, listingIds = [], options = {}) {
  const requestedIds = uniqueStrings(listingIds);
  const actor = String(options.actor || 'viewer').trim() || 'viewer';
  const now = options.clearedAt || new Date().toISOString();
  const params = ['queued', 'failed'];
  let idSql = '';
  if (requestedIds.length) {
    idSql = `AND listing_id IN (${requestedIds.map(() => '?').join(', ')})`;
    params.push(...requestedIds);
  }
  const rows = db.prepare(`
    SELECT listing_id, status
    FROM resolve_queue_items
    WHERE status IN (?, ?)
      ${idSql}
  `).all(...params);

  runTransaction(db, () => {
    for (const row of rows) {
      db.prepare(`
        UPDATE resolve_queue_items
        SET status = 'cleared',
          updated_at = ?,
          note = ''
        WHERE listing_id = ?
      `).run(now, row.listing_id);
      appendResolveQueueEvent(db, {
        listingId: row.listing_id,
        eventType: 'resolve_queue_cleared',
        eventAt: now,
        actor,
        status: 'cleared',
        content: {
          previousStatus: row.status,
        },
      });
    }
  });

  return {
    clearedCount: rows.length,
    listingIds: rows.map((row) => row.listing_id),
    items: listResolveQueueItems(db),
    counts: getResolveQueueCounts(db),
  };
}

function markResolveQueueDispatched(db, listingIds, workflowRunId, options = {}) {
  const ids = uniqueStrings(listingIds);
  const actor = String(options.actor || 'viewer').trim() || 'viewer';
  const now = options.dispatchedAt || new Date().toISOString();
  let dispatchedCount = 0;

  runTransaction(db, () => {
    for (const listingId of ids) {
      const result = db.prepare(`
        UPDATE resolve_queue_items
        SET status = 'dispatched',
          updated_at = ?,
          workflow_run_id = ?,
          note = ''
        WHERE listing_id = ?
          AND status = 'queued'
      `).run(now, String(workflowRunId || ''), listingId);
      if (result.changes > 0) {
        dispatchedCount += 1;
        appendResolveQueueEvent(db, {
          listingId,
          eventType: 'resolve_queue_dispatched',
          eventAt: now,
          workflowRunId,
          actor,
          status: 'dispatched',
        });
      }
    }
  });

  return {
    dispatchedCount,
    listingIds: ids,
    items: listResolveQueueItems(db),
    counts: getResolveQueueCounts(db),
  };
}

function refreshResolveQueueRunStatuses(db) {
  const rows = db.prepare(`
    SELECT q.listing_id, q.workflow_run_id, q.status, w.status AS workflow_status
    FROM resolve_queue_items q
    JOIN workflow_runs w ON w.run_id = q.workflow_run_id
    WHERE q.status = 'dispatched'
  `).all();
  const now = new Date().toISOString();
  let updatedCount = 0;

  runTransaction(db, () => {
    for (const row of rows) {
      const workflowStatus = String(row.workflow_status || '');
      let nextStatus = '';
      if (workflowStatus === 'exited') {
        nextStatus = 'completed';
      } else if (workflowStatus === 'failed' || workflowStatus === 'error' || workflowStatus === 'lost') {
        nextStatus = 'failed';
      }
      if (!nextStatus) {
        continue;
      }

      db.prepare(`
        UPDATE resolve_queue_items
        SET status = ?,
          updated_at = ?,
          note = ?
        WHERE listing_id = ?
          AND status = 'dispatched'
      `).run(nextStatus, now, `workflow ${workflowStatus}`, row.listing_id);
      appendResolveQueueEvent(db, {
        listingId: row.listing_id,
        eventType: nextStatus === 'completed' ? 'resolve_queue_completed' : 'resolve_queue_failed',
        eventAt: now,
        workflowRunId: row.workflow_run_id,
        actor: 'system',
        status: nextStatus,
        content: {
          workflowStatus,
        },
      });
      updatedCount += 1;
    }
  });

  return {
    updatedCount,
    items: listResolveQueueItems(db),
    counts: getResolveQueueCounts(db),
  };
}

function upsertListingSearchKeyword(db, listingId, keyword, options = {}) {
  const normalizedKeyword = normalizeKeyword(keyword).toLowerCase();
  if (!listingId || !normalizedKeyword) {
    return null;
  }

  const now = options.seenAt || new Date().toISOString();
  const canonicalKeyword = normalizeKeyword(keyword);
  db.prepare(`
    INSERT INTO listing_search_keywords (
      listing_id,
      normalized_keyword,
      keyword,
      first_seen_at,
      last_seen_at,
      times_seen
    ) VALUES (?, ?, ?, ?, ?, 1)
    ON CONFLICT(listing_id, normalized_keyword) DO UPDATE SET
      keyword = excluded.keyword,
      last_seen_at = excluded.last_seen_at,
      times_seen = listing_search_keywords.times_seen + 1
  `).run(
    String(listingId),
    normalizedKeyword,
    canonicalKeyword,
    now,
    now,
  );

  return db.prepare(`
    SELECT *
    FROM listing_search_keywords
    WHERE listing_id = ?
      AND normalized_keyword = ?
  `).get(String(listingId), normalizedKeyword);
}

function upsertSearchTitleBagKeyword(db, keyword, options = {}) {
  const normalizedKeyword = normalizeKeyword(keyword).toLowerCase();
  if (!normalizedKeyword) {
    return null;
  }

  const now = options.seenAt || new Date().toISOString();
  const canonicalKeyword = normalizeKeyword(keyword);
  const sourceKeyword = normalizeKeyword(options.sourceKeyword || '');
  db.prepare(`
    INSERT INTO search_title_bag (
      normalized_keyword,
      keyword,
      first_seen_at,
      last_seen_at,
      times_seen,
      last_source_keyword
    ) VALUES (?, ?, ?, ?, 1, ?)
    ON CONFLICT(normalized_keyword) DO UPDATE SET
      keyword = excluded.keyword,
      last_seen_at = excluded.last_seen_at,
      times_seen = search_title_bag.times_seen + 1,
      last_source_keyword = excluded.last_source_keyword
  `).run(
    normalizedKeyword,
    canonicalKeyword,
    now,
    now,
    sourceKeyword,
  );

  return getSearchTitleBagKeyword(db, canonicalKeyword);
}

function getSearchTitleBagKeyword(db, keyword) {
  const normalizedKeyword = normalizeKeyword(keyword).toLowerCase();
  if (!normalizedKeyword) {
    return null;
  }

  return db.prepare(`
    SELECT *
    FROM search_title_bag
    WHERE normalized_keyword = ?
  `).get(normalizedKeyword);
}

function pickRandomSearchTitleBagKeyword(db, options = {}) {
  const excludeKeywords = Array.isArray(options.excludeKeywords)
    ? options.excludeKeywords
        .map((value) => normalizeKeyword(value).toLowerCase())
        .filter(Boolean)
    : [];
  const minTimesSeen = Number.isFinite(options.minTimesSeen)
    ? Math.max(1, options.minTimesSeen)
    : 1;
  const params = [minTimesSeen];
  let exclusionSql = '';

  if (excludeKeywords.length > 0) {
    exclusionSql = `AND normalized_keyword NOT IN (${excludeKeywords.map(() => '?').join(', ')})`;
    params.push(...excludeKeywords);
  }

  return db.prepare(`
    SELECT *
    FROM search_title_bag
    WHERE times_seen >= ?
      ${exclusionSql}
    ORDER BY RANDOM()
    LIMIT 1
  `).get(...params) || null;
}

function getSearchTitleBagCounts(db) {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total_keywords,
      COALESCE(SUM(times_seen), 0) AS total_seen
    FROM search_title_bag
  `).get();

  return {
    totalKeywords: row?.total_keywords || 0,
    totalSeen: row?.total_seen || 0,
  };
}

function serializeArray(value) {
  return JSON.stringify(Array.isArray(value) ? value : [], null, 2);
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function normalizeWorkflowRunRow(row) {
  if (!row) {
    return null;
  }

  return {
    run_id: row.run_id,
    workflow_id: row.workflow_id,
    label: row.label,
    script: row.script,
    args: parseJsonArray(row.args_json),
    pid: row.pid,
    status: row.status,
    started_at: row.started_at,
    updated_at: row.updated_at,
    exited_at: row.exited_at,
    exit_code: row.exit_code,
    signal: row.signal,
    os_checked_at: row.os_checked_at,
    os_alive: Boolean(row.os_alive),
    logs: parseJsonArray(row.logs_json),
  };
}

function normalizeListingEventRow(row) {
  if (!row) {
    return null;
  }

  return {
    event_id: row.event_id,
    workflow_run_id: row.workflow_run_id || '',
    listing_id: row.listing_id,
    event_type: row.event_type,
    event_at: row.event_at,
    worker_id: row.worker_id,
    source_url: row.source_url,
    attempt: row.attempt,
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

function normalizeWorkflowEventRow(row) {
  if (!row) {
    return null;
  }

  return {
    event_id: row.event_id,
    workflow_run_id: row.workflow_run_id,
    event_type: row.event_type,
    event_at: row.event_at,
    status: row.status,
    content: parseJsonObject(row.content_json),
    error: row.error,
  };
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

function appendWorkflowEvent(db, event) {
  const eventAt = event.eventAt || event.event_at || new Date().toISOString();
  const workflowRunId = String(event.workflowRunId || event.workflow_run_id || '').trim();
  if (!workflowRunId) {
    throw new Error('appendWorkflowEvent requires workflowRunId');
  }

  const eventType = normalizeKeyword(event.eventType || event.event_type || 'workflow_event');
  const content = event.content || event.contentJson || {};
  const eventId = String(event.eventId || event.event_id || buildWorkflowEventId(eventAt, workflowRunId, eventType));

  db.prepare(`
    INSERT INTO workflow_events (
      event_id,
      workflow_run_id,
      event_type,
      event_at,
      status,
      content_json,
      error
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventId,
    workflowRunId,
    eventType,
    eventAt,
    String(event.status || '').trim(),
    serializeJson(content),
    String(event.error || '').trim(),
  );

  return getWorkflowEvent(db, eventId);
}

function getWorkflowEvent(db, eventId) {
  return normalizeWorkflowEventRow(db.prepare(`
    SELECT *
    FROM workflow_events
    WHERE event_id = ?
  `).get(String(eventId)));
}

function listWorkflowEvents(db, workflowRunId, options = {}) {
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(options.limit, 200)) : 50;
  return db.prepare(`
    SELECT *
    FROM workflow_events
    WHERE workflow_run_id = ?
    ORDER BY event_at DESC
    LIMIT ?
  `).all(String(workflowRunId), limit).map(normalizeWorkflowEventRow);
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

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function extractListingIdsFromLogs(logs = []) {
  return uniqueStrings(logs.flatMap((line) => (
    [...String(line || '').matchAll(/listing_id=([^\s]+)/g)].map((match) => match[1])
  )));
}

function resolveWorkerEventIdsForRun(db, workerId) {
  const primaryWorkerId = String(workerId || '').trim();
  const ids = primaryWorkerId ? [primaryWorkerId] : [];
  const run = primaryWorkerId ? getWorkflowRun(db, primaryWorkerId) : null;
  if (!run) {
    return ids;
  }

  const listingIds = extractListingIdsFromLogs(run.logs || []);
  if (listingIds.length === 0) {
    return ids;
  }

  const params = [...listingIds, primaryWorkerId];
  let timeSql = '';
  if (run.started_at) {
    timeSql += ' AND event_at >= ?';
    params.push(run.started_at);
  }
  if (run.exited_at) {
    timeSql += ' AND event_at <= ?';
    params.push(run.exited_at);
  }

  const legacyWorkerIds = db.prepare(`
    SELECT worker_id, COUNT(*) AS overlap_count
    FROM listing_events
    WHERE listing_id IN (${listingIds.map(() => '?').join(', ')})
      AND worker_id != ?
      AND worker_id LIKE 'pid-%'
      ${timeSql}
    GROUP BY worker_id
    ORDER BY overlap_count DESC, MAX(event_at) DESC
    LIMIT 5
  `).all(...params).map((row) => row.worker_id);

  return uniqueStrings([...ids, ...legacyWorkerIds]);
}

function workerIdWhereSql(workerIds, params, alias = 'e') {
  const ids = uniqueStrings(workerIds);
  if (ids.length === 0) {
    params.push('');
    return `${alias}.worker_id = ?`;
  }

  params.push(...ids);
  return `${alias}.worker_id IN (${ids.map(() => '?').join(', ')})`;
}

function workerRunWhereSql(workerId, workerIds, params, alias = 'e') {
  const runId = String(workerId || '').trim();
  const ids = uniqueStrings(workerIds);
  const clauses = [];
  if (runId) {
    params.push(runId);
    clauses.push(`${alias}.workflow_run_id = ?`);
  }
  if (ids.length > 0) {
    params.push(...ids);
    clauses.push(`${alias}.worker_id IN (${ids.map(() => '?').join(', ')})`);
  }
  if (clauses.length === 0) {
    params.push('');
    return `${alias}.worker_id = ?`;
  }
  return `(${clauses.join(' OR ')})`;
}

function listWorkerListingEvents(db, workerId, options = {}) {
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(options.limit, 200)) : 50;
  const eventTypes = eventTypesForCategory(options.category);
  const workerIds = options.workerIds || [workerId];
  const params = [];
  const workerSql = workerRunWhereSql(workerId, workerIds, params, 'e');
  let eventTypeSql = '';

  if (eventTypes.length > 0) {
    eventTypeSql = `AND e.event_type IN (${eventTypes.map(() => '?').join(', ')})`;
    params.push(...eventTypes);
  }

  params.push(limit);

  return db.prepare(`
    SELECT
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
    WHERE ${workerSql}
      ${eventTypeSql}
    ORDER BY e.event_at DESC
    LIMIT ?
  `).all(...params).map(normalizeListingEventRow);
}

function getWorkerListingEventStats(db, workerId, options = {}) {
  const workerIds = uniqueStrings(options.workerIds || [workerId]);
  const statsParams = [];
  const statsWorkerSql = workerRunWhereSql(workerId, workerIds, statsParams, 'listing_events');
  const rows = db.prepare(`
    SELECT event_type, COUNT(*) AS count
    FROM listing_events
    WHERE ${statsWorkerSql}
    GROUP BY event_type
  `).all(...statsParams);

  const stats = {
    total: 0,
    done: 0,
    skipped: 0,
    error: 0,
    started: 0,
    workerIds,
  };

  for (const row of rows) {
    stats.total += row.count;
    if (eventTypesForCategory('done').includes(row.event_type)) {
      stats.done += row.count;
    } else if (eventTypesForCategory('skipped').includes(row.event_type)) {
      stats.skipped += row.count;
    } else if (eventTypesForCategory('error').includes(row.event_type)) {
      stats.error += row.count;
    } else if (eventTypesForCategory('started').includes(row.event_type)) {
      stats.started += row.count;
    }
  }

  const latestParams = [];
  const latestWorkerSql = workerRunWhereSql(workerId, workerIds, latestParams, 'e');
  const latest = db.prepare(`
    SELECT
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
    WHERE ${latestWorkerSql}
    ORDER BY e.event_at DESC
    LIMIT 1
  `).get(...latestParams);

  const latestPreviewParams = [];
  const latestPreviewWorkerSql = workerRunWhereSql(workerId, workerIds, latestPreviewParams, 'e');
  const latestPreview = db.prepare(`
    SELECT
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
    WHERE ${latestPreviewWorkerSql}
      AND (
        COALESCE(e.screenshot_path, '') != ''
        OR COALESCE(h.screenshot_path, '') != ''
      )
    ORDER BY e.event_at DESC
    LIMIT 1
  `).get(...latestPreviewParams);

  return {
    ...stats,
    latestEvent: normalizeListingEventRow(latest),
    latestPreviewEvent: normalizeListingEventRow(latestPreview),
  };
}

function insertWorkflowRun(db, run) {
  const now = run.startedAt || new Date().toISOString();
  db.prepare(`
    INSERT INTO workflow_runs (
      run_id,
      workflow_id,
      label,
      script,
      args_json,
      pid,
      status,
      started_at,
      updated_at,
      os_alive,
      logs_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    run.runId,
    run.workflowId,
    run.label,
    run.script,
    serializeArray(run.args),
    Number.isFinite(run.pid) ? run.pid : null,
    run.status || 'starting',
    now,
    run.updatedAt || now,
    run.osAlive ? 1 : 0,
    serializeArray(run.logs),
  );
  return getWorkflowRun(db, run.runId);
}

function updateWorkflowRun(db, runId, changes = {}) {
  const previous = getWorkflowRun(db, runId);
  if (!previous) {
    return null;
  }

  const next = {
    workflow_id: changes.workflowId ?? previous.workflow_id,
    label: changes.label ?? previous.label,
    script: changes.script ?? previous.script,
    args: changes.args ?? previous.args,
    pid: changes.pid ?? previous.pid,
    status: changes.status ?? previous.status,
    updated_at: changes.updatedAt ?? new Date().toISOString(),
    exited_at: changes.exitedAt ?? previous.exited_at,
    exit_code: changes.exitCode ?? previous.exit_code,
    signal: changes.signal ?? previous.signal,
    os_checked_at: changes.osCheckedAt ?? previous.os_checked_at,
    os_alive: changes.osAlive ?? previous.os_alive,
    logs: changes.logs ?? previous.logs,
  };

  db.prepare(`
    UPDATE workflow_runs
    SET
      workflow_id = ?,
      label = ?,
      script = ?,
      args_json = ?,
      pid = ?,
      status = ?,
      updated_at = ?,
      exited_at = ?,
      exit_code = ?,
      signal = ?,
      os_checked_at = ?,
      os_alive = ?,
      logs_json = ?
    WHERE run_id = ?
  `).run(
    next.workflow_id,
    next.label,
    next.script,
    serializeArray(next.args),
    Number.isFinite(next.pid) ? next.pid : null,
    next.status,
    next.updated_at,
    next.exited_at,
    Number.isFinite(next.exit_code) ? next.exit_code : null,
    next.signal || '',
    next.os_checked_at || '',
    next.os_alive ? 1 : 0,
    serializeArray(next.logs),
    runId,
  );
  return getWorkflowRun(db, runId);
}

function getWorkflowRun(db, runId) {
  return normalizeWorkflowRunRow(db.prepare(`
    SELECT *
    FROM workflow_runs
    WHERE run_id = ?
  `).get(String(runId)));
}

function listWorkflowRuns(db, options = {}) {
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(options.limit, 100)) : 25;
  return db.prepare(`
    SELECT *
    FROM workflow_runs
    ORDER BY started_at DESC
    LIMIT ?
  `).all(limit).map(normalizeWorkflowRunRow);
}

function fileSizeBytes(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch (_) {
    return 0;
  }
}

function getDatabaseMaintenanceReport(db, dbPath = DEFAULT_DB_PATH) {
  const resolvedPath = resolveDbPath(dbPath);
  const pageCount = db.prepare('PRAGMA page_count').get().page_count;
  const pageSize = db.prepare('PRAGMA page_size').get().page_size;
  const freelistCount = db.prepare('PRAGMA freelist_count').get().freelist_count;
  const journalMode = db.prepare('PRAGMA journal_mode').get().journal_mode;
  const listingRows = db.prepare('SELECT COUNT(*) AS count FROM homepage_listings').get().count;
  const eventRows = db.prepare('SELECT COUNT(*) AS count FROM listing_events').get().count;
  const workflowRows = db.prepare('SELECT COUNT(*) AS count FROM workflow_runs').get().count;
  return {
    dbPath: resolvedPath,
    journalMode,
    pageCount,
    pageSize,
    freelistCount,
    estimatedDbBytes: pageCount * pageSize,
    files: {
      dbBytes: fileSizeBytes(resolvedPath),
      walBytes: fileSizeBytes(`${resolvedPath}-wal`),
      shmBytes: fileSizeBytes(`${resolvedPath}-shm`),
    },
    rows: {
      homepageListings: listingRows,
      listingEvents: eventRows,
      workflowRuns: workflowRows,
    },
  };
}

function runDatabaseMaintenance(db, dbPath = DEFAULT_DB_PATH, options = {}) {
  const startedAt = new Date().toISOString();
  const before = getDatabaseMaintenanceReport(db, dbPath);
  const actions = [];

  if (options.optimize !== false) {
    db.exec('PRAGMA optimize;');
    actions.push('optimize');
  }

  if (options.analyze) {
    db.exec('ANALYZE;');
    actions.push('analyze');
  }

  if (options.checkpoint !== false) {
    const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').all();
    actions.push({ checkpoint: 'truncate', result: checkpoint });
  }

  if (options.vacuum) {
    db.exec('VACUUM;');
    actions.push('vacuum');
  }

  return {
    startedAt,
    completedAt: new Date().toISOString(),
    actions,
    before,
    after: getDatabaseMaintenanceReport(db, dbPath),
  };
}

module.exports = {
  DEFAULT_DB_PATH,
  resolveDbPath,
  extractListingId,
  canonicalizeListingUrl,
  normalizeKeyword,
  openMarketplaceHomepageDatabase,
  closeMarketplaceHomepageDatabase,
  upsertHomepageListingWithStatus,
  upsertHomepageListing,
  getHomepageListing,
  listBacklogCandidates,
  claimNextPendingHomepageListing,
  markHomepageListingProcessed,
  markHomepageListingFailed,
  releaseHomepageListingClaim,
  markHomepageListingInactive,
  getHomepageListingCounts,
  createPurchaseHistoryDocument,
  listPurchaseHistoryDocuments,
  getPurchaseHistoryDocument,
  deletePurchaseHistoryDocument,
  upsertPurchaseHistoryRows,
  listPurchaseHistoryRows,
  mergePurchaseHistoryDocuments,
  appendPurchaseHistoryEvent,
  listPurchaseHistoryEvents,
  listEventRegistry,
  hashContent,
  runTransaction,
  appendListingEvent,
  appendWorkflowEvent,
  appendResolveQueueEvent,
  getWorkflowEvent,
  listWorkflowEvents,
  getListingEvent,
  getListingEvents,
  getLatestListingEvent,
  addResolveQueueItems,
  clearResolveQueueItems,
  markResolveQueueDispatched,
  refreshResolveQueueRunStatuses,
  listResolveQueueItems,
  listResolveQueueEvents,
  getResolveQueueCounts,
  upsertListingSearchKeyword,
  upsertSearchTitleBagKeyword,
  getSearchTitleBagKeyword,
  pickRandomSearchTitleBagKeyword,
  getSearchTitleBagCounts,
  insertWorkflowRun,
  updateWorkflowRun,
  getWorkflowRun,
  listWorkflowRuns,
  resolveWorkerEventIdsForRun,
  listWorkerListingEvents,
  getWorkerListingEventStats,
  getDatabaseMaintenanceReport,
  runDatabaseMaintenance,
};
