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

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_listing_events_listing
    ON listing_events (listing_id, event_at DESC);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_listing_events_type_time
    ON listing_events (event_type, event_at DESC);
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

    db.exec('COMMIT');
    return getHomepageListing(db, candidate.listing_id);
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

  db.prepare(`
    INSERT INTO listing_events (
      event_id,
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventId,
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

function eventTypesForCategory(category) {
  switch (normalizeKeyword(category || 'all').toLowerCase()) {
    case 'done':
      return ['detail_capture_succeeded', 'content_changed'];
    case 'skipped':
    case 'skip':
      return ['detail_capture_bypassed', 'listing_unavailable'];
    case 'error':
    case 'errors':
      return ['detail_capture_failed'];
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

function listWorkerListingEvents(db, workerId, options = {}) {
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(options.limit, 200)) : 50;
  const eventTypes = eventTypesForCategory(options.category);
  const workerIds = options.workerIds || [workerId];
  const params = [];
  const workerSql = workerIdWhereSql(workerIds, params, 'e');
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
  const statsWorkerSql = workerIdWhereSql(workerIds, statsParams, 'listing_events');
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
  const latestWorkerSql = workerIdWhereSql(workerIds, latestParams, 'e');
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
  const latestPreviewWorkerSql = workerIdWhereSql(workerIds, latestPreviewParams, 'e');
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
  markHomepageListingInactive,
  getHomepageListingCounts,
  hashContent,
  appendListingEvent,
  getListingEvent,
  getListingEvents,
  getLatestListingEvent,
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
};
