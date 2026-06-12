const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { listedAgoToUnixRange } = require('./marketplace-listed-time-normalizer');

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
      detail_listed_at_raw TEXT NOT NULL DEFAULT '',
      detail_listed_at_earliest_unix INTEGER,
      detail_listed_at_latest_unix INTEGER,
      detail_listed_at_anchor_unix INTEGER,
      detail_listed_at_language TEXT NOT NULL DEFAULT '',
      detail_listed_at_unit TEXT NOT NULL DEFAULT '',
      detail_listed_at_value INTEGER,
      detail_listed_at_confidence TEXT NOT NULL DEFAULT '',
      detail_listed_at_source TEXT NOT NULL DEFAULT '',
      detail_listed_at_normalized_at TEXT NOT NULL DEFAULT '',
      detail_seller_name TEXT NOT NULL DEFAULT '',
      detail_json TEXT NOT NULL DEFAULT '{}',
      screenshot_path TEXT NOT NULL DEFAULT '',
      snapshot_path TEXT NOT NULL DEFAULT ''
    );
  `);

  ensureColumn(db, 'homepage_listings', 'source', "TEXT NOT NULL DEFAULT 'homepage'");
  ensureColumn(db, 'homepage_listings', 'source_keyword', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'homepage_listings', 'detail_listed_at_raw', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'homepage_listings', 'detail_listed_at_earliest_unix', 'INTEGER');
  ensureColumn(db, 'homepage_listings', 'detail_listed_at_latest_unix', 'INTEGER');
  ensureColumn(db, 'homepage_listings', 'detail_listed_at_anchor_unix', 'INTEGER');
  ensureColumn(db, 'homepage_listings', 'detail_listed_at_language', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'homepage_listings', 'detail_listed_at_unit', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'homepage_listings', 'detail_listed_at_value', 'INTEGER');
  ensureColumn(db, 'homepage_listings', 'detail_listed_at_confidence', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'homepage_listings', 'detail_listed_at_source', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'homepage_listings', 'detail_listed_at_normalized_at', "TEXT NOT NULL DEFAULT ''");

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
    CREATE INDEX IF NOT EXISTS idx_homepage_listings_match_seen
    ON homepage_listings (last_seen_at ASC, listing_id ASC);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_homepage_listings_match_completed
    ON homepage_listings (detail_completed_at ASC, listing_id ASC);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_homepage_listings_listed_latest
    ON homepage_listings (detail_listed_at_latest_unix DESC, last_seen_at DESC);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_homepage_listings_status_listed_latest
    ON homepage_listings (detail_status, detail_listed_at_latest_unix DESC);
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
    CREATE INDEX IF NOT EXISTS idx_listing_events_time
    ON listing_events (event_at DESC);
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
    CREATE INDEX IF NOT EXISTS idx_workflow_events_time
    ON workflow_events (event_at DESC);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_event_stats_cache (
      worker_id TEXT NOT NULL,
      event_scope TEXT NOT NULL,
      event_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT '',
      count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (worker_id, event_scope, event_type, status)
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_worker_event_stats_cache_worker
    ON worker_event_stats_cache (worker_id, event_scope);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_parameter_profiles (
      profile_id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      worker_type TEXT NOT NULL DEFAULT '',
      label TEXT NOT NULL,
      params_json TEXT NOT NULL DEFAULT '{}',
      args_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_worker_parameter_profiles_workflow_updated
    ON worker_parameter_profiles (workflow_id, updated_at DESC);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS summary_query_cards (
      card_id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      query TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_summary_query_cards_position_updated
    ON summary_query_cards (position ASC, updated_at DESC);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS saved_queries (
      query_id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      query TEXT NOT NULL,
      show_in_overview INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_saved_queries_overview_updated
    ON saved_queries (show_in_overview, updated_at DESC);
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
    CREATE INDEX IF NOT EXISTS idx_resolve_queue_events_time
    ON resolve_queue_events (event_at DESC);
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
    DROP INDEX IF EXISTS idx_purchase_history_events_once;
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_purchase_history_events_once
    ON purchase_history_events (document_id, record_id, event_type);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_purchase_history_events_document_time
    ON purchase_history_events (document_id, event_at DESC, created_at DESC);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_purchase_history_events_time
    ON purchase_history_events (event_at DESC, created_at DESC);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS purchase_history_listing_links (
      document_id TEXT NOT NULL,
      record_id TEXT NOT NULL,
      listing_id TEXT NOT NULL,
      relationship_type TEXT NOT NULL DEFAULT 'same_model',
      href TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      linked_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (document_id, record_id, listing_id, relationship_type),
      FOREIGN KEY (document_id, record_id) REFERENCES purchase_history_rows(document_id, record_id) ON DELETE CASCADE,
      FOREIGN KEY (listing_id) REFERENCES homepage_listings(listing_id)
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_purchase_history_listing_links_record
    ON purchase_history_listing_links (document_id, record_id, linked_at DESC);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_purchase_history_listing_links_listing
    ON purchase_history_listing_links (listing_id, linked_at DESC);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS purchase_history_match_queue (
      document_id TEXT NOT NULL,
      record_id TEXT NOT NULL,
      listing_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      listing_price_cad REAL,
      purchase_price_cad REAL,
      threshold_price_cad REAL,
      matched_terms_json TEXT NOT NULL DEFAULT '[]',
      listing_seen_at TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      source_keyword TEXT NOT NULL DEFAULT '',
      first_matched_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      queued_at TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (document_id, record_id, listing_id),
      FOREIGN KEY (document_id, record_id) REFERENCES purchase_history_rows(document_id, record_id) ON DELETE CASCADE,
      FOREIGN KEY (listing_id) REFERENCES homepage_listings(listing_id)
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_purchase_history_match_queue_status_updated
    ON purchase_history_match_queue (status, updated_at DESC);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_purchase_history_match_queue_listing
    ON purchase_history_match_queue (listing_id, updated_at DESC);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS purchase_history_match_scan_state (
      state_key TEXT PRIMARY KEY,
      cursor_at TEXT NOT NULL DEFAULT '',
      cursor_id TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS purchase_history_match_events (
      event_id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      record_id TEXT NOT NULL,
      listing_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_at TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT 'viewer',
      reason TEXT NOT NULL DEFAULT '',
      content_json TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (document_id, record_id, listing_id)
        REFERENCES purchase_history_match_queue(document_id, record_id, listing_id) ON DELETE CASCADE
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_purchase_history_match_events_time
    ON purchase_history_match_events (event_at DESC);
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

function incrementWorkerEventStatsCache(db, options = {}) {
  const workerId = String(options.workerId || options.worker_id || '').trim();
  const eventScope = normalizeKeyword(options.eventScope || options.event_scope || '').toLowerCase();
  const eventType = normalizeKeyword(options.eventType || options.event_type || '');
  if (!workerId || !eventScope || !eventType) {
    return;
  }
  const status = String(options.status || '').trim();
  const count = Number.isFinite(options.count) ? Math.max(1, Math.floor(options.count)) : 1;
  const updatedAt = options.updatedAt || options.updated_at || new Date().toISOString();
  db.prepare(`
    INSERT INTO worker_event_stats_cache (
      worker_id,
      event_scope,
      event_type,
      status,
      count,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(worker_id, event_scope, event_type, status) DO UPDATE SET
      count = count + excluded.count,
      updated_at = excluded.updated_at
  `).run(workerId, eventScope, eventType, status, count, updatedAt);
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
  const workerId = String(event.workerId || event.worker_id || '').trim();
  const status = String(event.status || '').trim();

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
    workerId,
    String(event.sourceUrl || event.source_url || '').trim(),
    Number.isFinite(event.attempt) ? event.attempt : 0,
    status,
    contentJson,
    contentHash,
    String(event.screenshotPath || event.screenshot_path || '').trim(),
    String(event.snapshotPath || event.snapshot_path || '').trim(),
    String(event.error || '').trim(),
  );

  incrementWorkerEventStatsCache(db, {
    workerId: workflowRunId || workerId,
    eventScope: 'listing',
    eventType,
    status,
    updatedAt: eventAt,
  });

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

function unixSecondsFromIso(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

function writeListedTimeNormalization(db, listingId, listedAgo, anchorIso, range) {
  const normalizedAt = range?.normalizedAt || new Date().toISOString();
  const anchorUnix = range?.anchorUnix ?? unixSecondsFromIso(anchorIso);
  db.prepare(`
    UPDATE homepage_listings
    SET
      detail_listed_at_raw = ?,
      detail_listed_at_earliest_unix = ?,
      detail_listed_at_latest_unix = ?,
      detail_listed_at_anchor_unix = ?,
      detail_listed_at_language = ?,
      detail_listed_at_unit = ?,
      detail_listed_at_value = ?,
      detail_listed_at_confidence = ?,
      detail_listed_at_source = ?,
      detail_listed_at_normalized_at = ?
    WHERE listing_id = ?
  `).run(
    String(listedAgo || '').trim(),
    range?.earliestUnix ?? null,
    range?.latestUnix ?? null,
    anchorUnix,
    range?.language || '',
    range?.unit || '',
    range?.value ?? null,
    range?.confidence || 'unparsed',
    range?.source || 'detail_listed_ago:first_seen_at',
    normalizedAt,
    String(listingId),
  );
}

function normalizeHomepageListingListedTime(db, listingId) {
  const row = db.prepare(`
    SELECT listing_id, detail_listed_ago, first_seen_at, last_seen_at
    FROM homepage_listings
    WHERE listing_id = ?
  `).get(String(listingId));
  if (!row) {
    return { status: 'missing', listingId: String(listingId) };
  }

  const listedAgo = String(row.detail_listed_ago || '').trim();
  if (!listedAgo) {
    return { status: 'skipped', reason: 'empty_detail_listed_ago', listingId: row.listing_id };
  }

  const anchorIso = row.first_seen_at || row.last_seen_at || '';
  const range = listedAgoToUnixRange(listedAgo, anchorIso);
  writeListedTimeNormalization(db, row.listing_id, listedAgo, anchorIso, range);
  return {
    status: range ? 'normalized' : 'unparsed',
    listingId: row.listing_id,
    listedAgo,
    range,
  };
}

function normalizeHomepageListedTimeRanges(db, options = {}) {
  const limit = Math.max(1, Math.min(Number.parseInt(options.limit, 10) || 1000, 10000));
  const staleOnly = options.staleOnly !== false;
  const staleSql = staleOnly
    ? "AND (detail_listed_at_normalized_at = '' OR detail_listed_at_raw != detail_listed_ago)"
    : '';
  const rows = db.prepare(`
    SELECT listing_id
    FROM homepage_listings
    WHERE LENGTH(TRIM(detail_listed_ago)) > 0
      ${staleSql}
    ORDER BY first_seen_at DESC
    LIMIT ?
  `).all(limit);

  const summary = {
    scanned: rows.length,
    normalized: 0,
    unparsed: 0,
    skipped: 0,
    missing: 0,
  };

  for (const row of rows) {
    const result = normalizeHomepageListingListedTime(db, row.listing_id);
    if (Object.prototype.hasOwnProperty.call(summary, result.status)) {
      summary[result.status] += 1;
    }
  }

  return summary;
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

  normalizeHomepageListingListedTime(db, listingId);
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

function listStaleProcessingHomepageListings(db, options = {}) {
  const staleAfterSeconds = Number.isFinite(options.staleAfterSeconds)
    ? Math.max(1, options.staleAfterSeconds)
    : 30 * 60;
  const limit = Number.isFinite(options.limit)
    ? Math.max(1, Math.min(options.limit, 1000))
    : 100;
  const now = options.now || new Date().toISOString();
  const staleBefore = new Date(Date.parse(now) - (staleAfterSeconds * 1000)).toISOString();
  return db.prepare(`
    SELECT
      listing_id,
      href,
      card_title,
      detail_title,
      detail_status,
      detail_attempts,
      detail_started_at,
      detail_completed_at,
      detail_last_error,
      claimed_by,
      first_seen_at,
      last_seen_at
    FROM homepage_listings
    WHERE detail_status = 'processing'
      AND COALESCE(detail_started_at, '') != ''
      AND detail_started_at <= ?
    ORDER BY detail_started_at ASC, listing_id ASC
    LIMIT ?
  `).all(staleBefore, limit);
}

function recoverStaleProcessingHomepageListings(db, options = {}) {
  const dryRun = options.dryRun !== false;
  const nextStatus = String(options.nextStatus || 'pending').trim();
  const recoveredAt = options.recoveredAt || options.now || new Date().toISOString();
  const reason = String(options.reason || 'stale_processing_recovery').trim();
  if (!['pending', 'error'].includes(nextStatus)) {
    throw new Error(`Unsupported stale processing recovery status: ${nextStatus}`);
  }
  const rows = listStaleProcessingHomepageListings(db, options);
  const recovered = [];
  if (!dryRun) {
    runTransaction(db, () => {
      for (const row of rows) {
        appendListingEvent(db, {
          workflowRunId: row.claimed_by || '',
          listingId: row.listing_id,
          eventType: 'detail_capture_interrupted',
          eventAt: recoveredAt,
          workerId: row.claimed_by || 'maintenance',
          sourceUrl: row.href,
          attempt: row.detail_attempts,
          status: 'interrupted',
          content: {
            recovery: {
              reason,
              nextStatus,
              previousStatus: row.detail_status,
              detailStartedAt: row.detail_started_at,
              claimedBy: row.claimed_by || '',
            },
          },
          error: reason,
        });
        const release = releaseHomepageListingClaim(db, row.listing_id, {
          nextStatus,
          reason,
          completedAt: recoveredAt,
          decrementAttempts: true,
        });
        if (release.changed) {
          recovered.push(release.listing);
        }
      }
    });
  }
  return {
    dryRun,
    staleAfterSeconds: Number.isFinite(options.staleAfterSeconds) ? options.staleAfterSeconds : 30 * 60,
    nextStatus,
    reason,
    scanned: rows.length,
    recovered: dryRun ? 0 : recovered.length,
    items: dryRun ? rows : recovered,
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

  normalizeHomepageListingListedTime(db, listingId);
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

function normalizePurchaseHistoryListingRelationship(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
  if (normalized === 'same_listing' || normalized === 'transaction' || normalized === 'exact') {
    return 'same_listing';
  }
  return 'same_model';
}

function normalizePurchaseHistoryListingLinkRow(row) {
  if (!row) {
    return null;
  }
  return {
    document_id: row.document_id,
    record_id: row.record_id,
    listing_id: row.listing_id,
    relationship_type: normalizePurchaseHistoryListingRelationship(row.relationship_type),
    href: canonicalizeListingUrl(row.href || row.listing_href || ''),
    note: row.note || '',
    linked_at: row.linked_at,
    updated_at: row.updated_at,
    listing: {
      href: canonicalizeListingUrl(row.listing_href || row.href || ''),
      source: row.source || '',
      source_keyword: row.source_keyword || '',
      card_title: row.card_title || '',
      detail_title: row.detail_title || '',
      detail_price: row.detail_price || '',
      detail_status: row.detail_status || '',
      detail_completed_at: row.detail_completed_at || '',
      screenshot_path: row.screenshot_path || '',
      snapshot_path: row.snapshot_path || '',
    },
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
    db.prepare('DELETE FROM purchase_history_listing_links WHERE document_id = ?').run(id);
    db.prepare('DELETE FROM purchase_history_events WHERE document_id = ?').run(id);
    db.prepare('DELETE FROM purchase_history_rows WHERE document_id = ?').run(id);
    const result = db.prepare('DELETE FROM purchase_history_documents WHERE document_id = ?').run(id);
    return { deleted: result.changes || 0 };
  });
}

function getPurchaseHistoryRow(db, documentId, recordId) {
  return normalizePurchaseHistoryRow(db.prepare(`
    SELECT *
    FROM purchase_history_rows
    WHERE document_id = ?
      AND record_id = ?
  `).get(String(documentId || '').trim(), String(recordId || '').trim()));
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

function listPurchaseHistoryListingLinks(db, options = {}) {
  const documentId = String(options.documentId || options.document_id || '').trim();
  const recordId = String(options.recordId || options.record_id || '').trim();
  const listingId = String(options.listingId || options.listing_id || '').trim();
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(options.limit, 10000)) : 10000;
  const filters = [];
  const params = [];
  if (documentId) {
    filters.push('links.document_id = ?');
    params.push(documentId);
  }
  if (recordId) {
    filters.push('links.record_id = ?');
    params.push(recordId);
  }
  if (listingId) {
    filters.push('links.listing_id = ?');
    params.push(listingId);
  }
  const whereSql = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  return db.prepare(`
    SELECT
      links.*,
      listings.href AS listing_href,
      listings.source,
      listings.source_keyword,
      listings.card_title,
      listings.detail_title,
      listings.detail_price,
      listings.detail_status,
      listings.detail_completed_at,
      listings.screenshot_path,
      listings.snapshot_path
    FROM purchase_history_listing_links links
    LEFT JOIN homepage_listings listings
      ON listings.listing_id = links.listing_id
    ${whereSql}
    ORDER BY links.linked_at DESC, links.listing_id ASC
    LIMIT ?
  `).all(...params, limit).map(normalizePurchaseHistoryListingLinkRow);
}

function parseCadMoney(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value).trim();
  if (!text) {
    return null;
  }
  if (/^free$/i.test(text)) {
    return 0;
  }
  const match = text.match(/(?:CA\$|\$)?\s*([0-9][0-9,\s]*(?:\.[0-9]{1,2})?)/i);
  if (!match) {
    return null;
  }
  const parsed = Number.parseFloat(match[1].replace(/[,\s]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeMatchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueMatchTerms(values) {
  const stopWords = new Set([
    'and', 'the', 'with', 'for', 'from', 'body', 'camera', 'lens', 'kit',
    'used', 'new', 'mint', 'good', 'excellent', 'condition', 'black', 'silver',
    'mount', 'adapter', 'adaptor', 'lenses', 'card', 'audio', 'dongle',
  ]);
  const terms = [];
  for (const value of values) {
    const normalized = normalizeMatchText(value);
    if (!normalized) {
      continue;
    }
    if (
      normalized.length >= 4
      && !stopWords.has(normalized)
      && !terms.includes(normalized)
    ) {
      terms.push(normalized);
    }
    for (const token of normalized.split(' ')) {
      if (
        (token.length >= 4 || (token.length >= 3 && /[a-z]/.test(token) && /\d/.test(token)))
        && /[a-z]/.test(token)
        && !stopWords.has(token)
        && !terms.includes(token)
      ) {
        terms.push(token);
      }
    }
  }
  return terms.slice(0, 40);
}

function uniqueMatchPhrases(values) {
  const phrases = [];
  for (const value of values) {
    const normalized = normalizeMatchText(value);
    if (
      normalized.length >= 6
      && normalized.includes(' ')
      && !phrases.includes(normalized)
    ) {
      phrases.push(normalized);
    }
  }
  return phrases.slice(0, 20);
}

function purchaseHistoryMatchTerms(row) {
  const data = parseJsonObject(row.data_json);
  return [
    ...uniqueMatchTerms([
      row.model,
      data.model,
      row.canonical_key,
    ]),
    ...uniqueMatchPhrases([
      row.title,
      data.title,
      data.description,
      data.product_description,
      data.notes,
      data.variant,
    ]),
  ];
}

function listingMatchHaystack(listing) {
  const detail = parseJsonObject(listing.detail_json);
  return normalizeMatchText([
    listing.card_title,
    listing.card_text,
    listing.detail_title,
    listing.detail_condition,
    listing.detail_seller_name,
    detail.title,
    detail.description,
    detail.text,
    detail.listingContent?.title,
    detail.listingContent?.description,
    detail.listingContent?.text,
  ].filter(Boolean).join(' '));
}

function listingPriceCad(listing) {
  return parseCadMoney(listing.detail_price)
    ?? parseCadMoney(listing.card_text)
    ?? parseCadMoney(listing.card_title)
    ?? parseCadMoney(listing.detail_json);
}

function purchaseHistoryPriceCad(row) {
  const data = parseJsonObject(row.data_json);
  return parseCadMoney(data.purchase_price_cad)
    ?? parseCadMoney(data.net_cost_cad)
    ?? parseCadMoney(data.price_cad);
}

function listPurchaseHistoryRowsForMatching(db, options = {}) {
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(options.limit, 10000)) : 5000;
  return db.prepare(`
    SELECT *
    FROM purchase_history_rows
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(limit);
}

function matchPurchaseHistoryListing(historyRow, listing, options = {}) {
  const listingPrice = listingPriceCad(listing);
  const purchasePrice = purchaseHistoryPriceCad(historyRow);
  const margin = Number.isFinite(options.margin) ? options.margin : 0.08;
  if (listingPrice === null || purchasePrice === null || purchasePrice <= 0) {
    return null;
  }
  const threshold = purchasePrice * (1 + margin);
  if (listingPrice > threshold) {
    return null;
  }
  const haystack = listingMatchHaystack(listing);
  if (!haystack) {
    return null;
  }
  const terms = purchaseHistoryMatchTerms(historyRow);
  const matchedTerms = terms.filter((term) => haystack.includes(term));
  const hasPhraseMatch = matchedTerms.some((term) => term.includes(' '));
  const hasCompactModelCode = matchedTerms.some((term) => (
    /[a-z]/.test(term)
    && /\d/.test(term)
    && /^[a-z0-9]{3,8}$/.test(term)
    && !/^\d+mm$/.test(term)
  ));
  if (!matchedTerms.length || (!hasPhraseMatch && matchedTerms.length < 2 && !hasCompactModelCode)) {
    return null;
  }
  return {
    documentId: historyRow.document_id,
    recordId: historyRow.record_id,
    listingId: listing.listing_id,
    listingPriceCad: listingPrice,
    purchasePriceCad: purchasePrice,
    thresholdPriceCad: threshold,
    matchedTerms: matchedTerms.slice(0, 12),
  };
}

function preparePurchaseHistoryMatchRow(historyRow) {
  return {
    row: historyRow,
    purchasePrice: purchaseHistoryPriceCad(historyRow),
    terms: purchaseHistoryMatchTerms(historyRow),
  };
}

function prepareListingMatchRow(listing) {
  return {
    row: listing,
    listingPrice: listingPriceCad(listing),
    haystack: listingMatchHaystack(listing),
  };
}

function matchPreparedPurchaseHistoryListing(history, listing, options = {}) {
  const margin = Number.isFinite(options.margin) ? options.margin : 0.08;
  if (
    listing.listingPrice === null
    || history.purchasePrice === null
    || history.purchasePrice <= 0
    || !listing.haystack
  ) {
    return null;
  }
  const threshold = history.purchasePrice * (1 + margin);
  if (listing.listingPrice > threshold) {
    return null;
  }
  const matchedTerms = history.terms.filter((term) => listing.haystack.includes(term));
  const hasPhraseMatch = matchedTerms.some((term) => term.includes(' '));
  const hasCompactModelCode = matchedTerms.some((term) => (
    /[a-z]/.test(term)
    && /\d/.test(term)
    && /^[a-z0-9]{3,8}$/.test(term)
    && !/^\d+mm$/.test(term)
  ));
  if (!matchedTerms.length || (!hasPhraseMatch && matchedTerms.length < 2 && !hasCompactModelCode)) {
    return null;
  }
  return {
    documentId: history.row.document_id,
    recordId: history.row.record_id,
    listingId: listing.row.listing_id,
    listingPriceCad: listing.listingPrice,
    purchasePriceCad: history.purchasePrice,
    thresholdPriceCad: threshold,
    matchedTerms: matchedTerms.slice(0, 12),
  };
}

function upsertPurchaseHistoryMatchQueueItem(db, match, options = {}) {
  const now = options.matchedAt || new Date().toISOString();
  const listing = getHomepageListing(db, match.listingId) || {};
  db.prepare(`
    INSERT INTO purchase_history_match_queue (
      document_id,
      record_id,
      listing_id,
      status,
      listing_price_cad,
      purchase_price_cad,
      threshold_price_cad,
      matched_terms_json,
      listing_seen_at,
      source,
      source_keyword,
      first_matched_at,
      updated_at,
      queued_at,
      note
    ) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(document_id, record_id, listing_id) DO UPDATE SET
      status = CASE
        WHEN purchase_history_match_queue.status IN ('cleared', 'ignored', 'saved', 'dismissed')
          THEN purchase_history_match_queue.status
        ELSE 'queued'
      END,
      listing_price_cad = excluded.listing_price_cad,
      purchase_price_cad = excluded.purchase_price_cad,
      threshold_price_cad = excluded.threshold_price_cad,
      matched_terms_json = excluded.matched_terms_json,
      listing_seen_at = excluded.listing_seen_at,
      source = excluded.source,
      source_keyword = excluded.source_keyword,
      updated_at = excluded.updated_at,
      note = excluded.note
  `).run(
    match.documentId,
    match.recordId,
    match.listingId,
    match.listingPriceCad,
    match.purchasePriceCad,
    match.thresholdPriceCad,
    serializeJson(match.matchedTerms || []),
    listing.last_seen_at || '',
    listing.source || '',
    listing.source_keyword || '',
    now,
    now,
    now,
    `price <= purchase + ${Math.round(((options.margin ?? 0.08) * 100))}%`,
  );
}

function normalizePurchaseHistoryMatchQueueRow(row) {
  if (!row) {
    return null;
  }
  return {
    document_id: row.document_id,
    record_id: row.record_id,
    listing_id: row.listing_id,
    status: row.status,
    listing_price_cad: Number.isFinite(row.listing_price_cad) ? row.listing_price_cad : Number(row.listing_price_cad || 0),
    purchase_price_cad: Number.isFinite(row.purchase_price_cad) ? row.purchase_price_cad : Number(row.purchase_price_cad || 0),
    threshold_price_cad: Number.isFinite(row.threshold_price_cad) ? row.threshold_price_cad : Number(row.threshold_price_cad || 0),
    matched_terms: parseJsonArray(row.matched_terms_json),
    listing_seen_at: row.listing_seen_at || '',
    source: row.source || '',
    source_keyword: row.source_keyword || '',
    first_matched_at: row.first_matched_at,
    updated_at: row.updated_at,
    queued_at: row.queued_at,
    note: row.note || '',
    title: row.detail_title || row.card_title || row.history_title || row.listing_id,
    href: row.href || '',
    card_title: row.card_title || '',
    card_text: row.card_text || '',
    detail_title: row.detail_title || '',
    detail_price: row.detail_price || '',
    detail_location: row.detail_location || '',
    detail_condition: row.detail_condition || '',
    detail_seller_name: row.detail_seller_name || '',
    detail_last_error: row.detail_last_error || '',
    first_seen_at: row.first_seen_at || '',
    last_seen_at: row.last_seen_at || '',
    detail_completed_at: row.detail_completed_at || '',
    screenshot_path: row.screenshot_path || '',
    snapshot_path: row.snapshot_path || '',
    detail_status: row.detail_status || '',
    history_title: row.history_title || '',
    history_category: row.history_category || '',
    history_subcategory: row.history_subcategory || '',
    history_brand: row.history_brand || '',
    history_model: row.history_model || '',
    history_mount: row.history_mount || '',
    history_purchase_at: row.history_purchase_at || '',
    history_sold_at: row.history_sold_at || '',
    history_outcome: row.history_outcome || '',
    history_data: parseJsonObject(row.history_data_json),
  };
}

function listPurchaseHistoryMatchQueue(db, options = {}) {
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(options.limit, 1000)) : 200;
  const offset = Number.isFinite(options.offset) ? Math.max(0, options.offset) : 0;
  const status = String(options.status || 'queued').trim();
  const filters = [];
  const params = [];
  if (status && status !== 'all') {
    filters.push('q.status = ?');
    params.push(status);
  }
  if (options.listingId || options.listing_id) {
    filters.push('q.listing_id = ?');
    params.push(String(options.listingId || options.listing_id).trim());
  }
  if (options.documentId || options.document_id) {
    filters.push('q.document_id = ?');
    params.push(String(options.documentId || options.document_id).trim());
  }
  if (options.recordId || options.record_id) {
    filters.push('q.record_id = ?');
    params.push(String(options.recordId || options.record_id).trim());
  }
  if (options.resolvedOnly || options.resolved_only) {
    filters.push("(l.detail_status = 'done' OR l.detail_completed_at IS NOT NULL OR NULLIF(l.snapshot_path, '') IS NOT NULL)");
  }
  params.push(limit, offset);
  return db.prepare(`
    SELECT
      q.*,
      h.title AS history_title,
      h.category AS history_category,
      h.subcategory AS history_subcategory,
      h.brand AS history_brand,
      h.model AS history_model,
      h.mount AS history_mount,
      h.purchase_at AS history_purchase_at,
      h.sold_at AS history_sold_at,
      h.outcome AS history_outcome,
      h.data_json AS history_data_json,
      l.href,
      l.card_title,
      l.card_text,
      l.detail_title,
      l.detail_price,
      l.detail_location,
      l.detail_condition,
      l.detail_seller_name,
      l.detail_last_error,
      l.first_seen_at,
      l.last_seen_at,
      l.detail_completed_at,
      l.screenshot_path,
      l.snapshot_path,
      l.detail_status
    FROM purchase_history_match_queue q
    LEFT JOIN purchase_history_rows h
      ON h.document_id = q.document_id AND h.record_id = q.record_id
    LEFT JOIN homepage_listings l
      ON l.listing_id = q.listing_id
    ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
    ORDER BY q.updated_at DESC
    LIMIT ?
    OFFSET ?
  `).all(...params).map(normalizePurchaseHistoryMatchQueueRow);
}

function listRandomPurchaseHistoryMatches(db, options = {}) {
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(options.limit, 10)) : 8;
  const statuses = Array.isArray(options.statuses) && options.statuses.length
    ? options.statuses.map((status) => String(status || '').trim()).filter(Boolean)
    : ['queued'];
  const filters = [];
  const params = [];
  if (statuses.length) {
    filters.push(`q.status IN (${statuses.map(() => '?').join(', ')})`);
    params.push(...statuses);
  }
  if (options.resolvedOnly || options.resolved_only) {
    filters.push("(l.detail_status = 'done' OR l.detail_completed_at IS NOT NULL OR NULLIF(l.snapshot_path, '') IS NOT NULL)");
  }
  return db.prepare(`
    SELECT
      q.*,
      h.title AS history_title,
      h.category AS history_category,
      h.subcategory AS history_subcategory,
      h.brand AS history_brand,
      h.model AS history_model,
      h.mount AS history_mount,
      h.purchase_at AS history_purchase_at,
      h.sold_at AS history_sold_at,
      h.outcome AS history_outcome,
      h.data_json AS history_data_json,
      l.href,
      l.card_title,
      l.card_text,
      l.detail_title,
      l.detail_price,
      l.detail_location,
      l.detail_condition,
      l.detail_seller_name,
      l.detail_last_error,
      l.first_seen_at,
      l.last_seen_at,
      l.detail_completed_at,
      l.screenshot_path,
      l.snapshot_path,
      l.detail_status
    FROM purchase_history_match_queue q
    LEFT JOIN purchase_history_rows h
      ON h.document_id = q.document_id AND h.record_id = q.record_id
    LEFT JOIN homepage_listings l
      ON l.listing_id = q.listing_id
    ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
    ORDER BY RANDOM()
    LIMIT ?
  `).all(...params, limit).map(normalizePurchaseHistoryMatchQueueRow);
}

function countPurchaseHistoryMatchQueue(db, options = {}) {
  const status = String(options.status || 'queued').trim();
  const filters = [];
  const params = [];
  if (status && status !== 'all') {
    filters.push('q.status = ?');
    params.push(status);
  }
  if (options.listingId || options.listing_id) {
    filters.push('q.listing_id = ?');
    params.push(String(options.listingId || options.listing_id).trim());
  }
  if (options.documentId || options.document_id) {
    filters.push('q.document_id = ?');
    params.push(String(options.documentId || options.document_id).trim());
  }
  if (options.recordId || options.record_id) {
    filters.push('q.record_id = ?');
    params.push(String(options.recordId || options.record_id).trim());
  }
  if (options.resolvedOnly || options.resolved_only) {
    filters.push("(l.detail_status = 'done' OR l.detail_completed_at IS NOT NULL OR NULLIF(l.snapshot_path, '') IS NOT NULL)");
  }
  return db.prepare(`
    SELECT COUNT(*) AS total
    FROM purchase_history_match_queue q
    ${options.resolvedOnly || options.resolved_only ? 'LEFT JOIN homepage_listings l ON l.listing_id = q.listing_id' : ''}
    ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
  `).get(...params).total || 0;
}

function buildPurchaseHistoryMatchEventId(eventAt, documentId, recordId, listingId, eventType) {
  const entropy = crypto.randomBytes(8).toString('hex');
  return [
    String(eventAt || new Date().toISOString()).replace(/[^0-9A-Za-z]/g, ''),
    String(documentId || 'document'),
    String(recordId || 'record'),
    String(listingId || 'listing'),
    String(eventType || 'event'),
    entropy,
  ].join('-');
}

function appendPurchaseHistoryMatchEvent(db, event) {
  const eventAt = event.eventAt || event.event_at || new Date().toISOString();
  const documentId = String(event.documentId || event.document_id || '').trim();
  const recordId = String(event.recordId || event.record_id || '').trim();
  const listingId = String(event.listingId || event.listing_id || '').trim();
  const eventType = normalizeKeyword(event.eventType || event.event_type || 'recommendation_event');
  if (!documentId || !recordId || !listingId) {
    throw new Error('recommendation event requires documentId, recordId, and listingId');
  }
  const eventId = String(
    event.eventId
    || event.event_id
    || buildPurchaseHistoryMatchEventId(eventAt, documentId, recordId, listingId, eventType),
  );
  db.prepare(`
    INSERT INTO purchase_history_match_events (
      event_id,
      document_id,
      record_id,
      listing_id,
      event_type,
      event_at,
      actor,
      reason,
      content_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventId,
    documentId,
    recordId,
    listingId,
    eventType,
    eventAt,
    String(event.actor || 'viewer').trim(),
    String(event.reason || '').trim(),
    serializeJson(event.content || {}),
  );
  return eventId;
}

function updatePurchaseHistoryMatchQueueStatus(db, match, options = {}) {
  const documentId = String(match.documentId || match.document_id || '').trim();
  const recordId = String(match.recordId || match.record_id || '').trim();
  const listingId = String(match.listingId || match.listing_id || '').trim();
  const status = normalizeKeyword(match.status || '').toLowerCase();
  if (!documentId || !recordId || !listingId) {
    throw new Error('recommendation action requires documentId, recordId, and listingId');
  }
  if (!['saved', 'dismissed', 'queued'].includes(status)) {
    throw new Error(`Unsupported recommendation status: ${status}`);
  }
  const now = options.updatedAt || new Date().toISOString();
  const reason = String(options.reason || '').trim();
  const eventType = status === 'saved'
    ? 'recommendation_saved'
    : status === 'dismissed'
      ? 'recommendation_dismissed'
      : 'recommendation_requeued';
  return runTransaction(db, () => {
    const result = db.prepare(`
      UPDATE purchase_history_match_queue
      SET status = ?,
          updated_at = ?,
          note = CASE WHEN ? = '' THEN note ELSE ? END
      WHERE document_id = ?
        AND record_id = ?
        AND listing_id = ?
    `).run(status, now, reason, reason, documentId, recordId, listingId);
    if (result.changes === 0) {
      throw new Error(`Unknown recommendation: ${listingId}`);
    }
    appendPurchaseHistoryMatchEvent(db, {
      documentId,
      recordId,
      listingId,
      eventType,
      eventAt: now,
      actor: options.actor || 'viewer',
      reason,
      content: {
        status,
        reason,
        customReason: options.customReason || '',
      },
    });
    return { changes: result.changes };
  });
}

function scanPurchaseHistoryMatchesForListings(db, listingIds, options = {}) {
  const ids = uniqueStrings(listingIds);
  if (!ids.length) {
    return { scanned: 0, matched: 0, queued: 0, listingIds: [] };
  }
  const listings = db.prepare(`
    SELECT *
    FROM homepage_listings
    WHERE listing_id IN (${ids.map(() => '?').join(', ')})
  `).all(...ids);
  if (!listings.length) {
    return { scanned: 0, matched: 0, queued: 0, listingIds: [] };
  }
  const historyRows = listPurchaseHistoryRowsForMatching(db, {
    limit: options.historyLimit,
  }).map(preparePurchaseHistoryMatchRow).filter((row) => (
    row.purchasePrice !== null
    && row.purchasePrice > 0
    && row.terms.length > 0
  ));
  const matchedListingIds = new Set();
  let matched = 0;
  const matchedAt = options.matchedAt || new Date().toISOString();
  const margin = Number.isFinite(options.margin) ? options.margin : 0.08;
  for (const listing of listings) {
    const preparedListing = prepareListingMatchRow(listing);
    if (preparedListing.listingPrice === null || !preparedListing.haystack) {
      continue;
    }
    for (const historyRow of historyRows) {
      const match = matchPreparedPurchaseHistoryListing(historyRow, preparedListing, { margin });
      if (!match) {
        continue;
      }
      upsertPurchaseHistoryMatchQueueItem(db, match, { matchedAt, margin });
      matched += 1;
      matchedListingIds.add(listing.listing_id);
    }
  }
  let queued = 0;
  if (matchedListingIds.size > 0 && options.enqueueResolve !== false) {
    const result = addResolveQueueItems(db, [...matchedListingIds], {
      actor: options.actor || 'history-watch',
      queuedAt: matchedAt,
    });
    queued = result.addedCount || 0;
  }
  return {
    scanned: listings.length,
    matched,
    queued,
    listingIds: [...matchedListingIds],
  };
}

function getPurchaseHistoryMatchScanState(db, stateKey, options = {}) {
  const key = String(stateKey || '').trim();
  const existing = db.prepare(`
    SELECT *
    FROM purchase_history_match_scan_state
    WHERE state_key = ?
  `).get(key);
  if (existing) {
    return existing;
  }
  const now = options.now || new Date().toISOString();
  const lookbackMs = Number.isFinite(options.initialLookbackMs)
    ? Math.max(0, options.initialLookbackMs)
    : 24 * 60 * 60 * 1000;
  const cursorAt = new Date(Date.parse(now) - lookbackMs).toISOString();
  db.prepare(`
    INSERT INTO purchase_history_match_scan_state (
      state_key,
      cursor_at,
      cursor_id,
      updated_at
    ) VALUES (?, ?, '', ?)
  `).run(key, cursorAt, now);
  return {
    state_key: key,
    cursor_at: cursorAt,
    cursor_id: '',
    updated_at: now,
  };
}

function updatePurchaseHistoryMatchScanState(db, stateKey, cursorAt, cursorId, options = {}) {
  const now = options.now || new Date().toISOString();
  db.prepare(`
    INSERT INTO purchase_history_match_scan_state (
      state_key,
      cursor_at,
      cursor_id,
      updated_at
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(state_key) DO UPDATE SET
      cursor_at = excluded.cursor_at,
      cursor_id = excluded.cursor_id,
      updated_at = excluded.updated_at
  `).run(String(stateKey || '').trim(), String(cursorAt || ''), String(cursorId || ''), now);
}

function listListingsForPurchaseHistoryMatchScan(db, stateKey, columnName, options = {}) {
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(options.limit, 1000)) : 250;
  const state = getPurchaseHistoryMatchScanState(db, stateKey, options);
  return {
    state,
    rows: db.prepare(`
      SELECT listing_id, ${columnName}
      FROM homepage_listings
      WHERE COALESCE(${columnName}, '') != ''
        AND (
          ${columnName} > ?
          OR (${columnName} = ? AND listing_id > ?)
        )
      ORDER BY ${columnName} ASC, listing_id ASC
      LIMIT ?
    `).all(state.cursor_at, state.cursor_at, state.cursor_id || '', limit),
  };
}

function scanPurchaseHistoryListingMatches(db, options = {}) {
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(options.limit, 1000)) : 250;
  const actor = options.actor || 'history-watch';
  const scans = [
    ['seen', 'last_seen_at'],
    ['detail', 'detail_completed_at'],
  ];
  const result = {
    scanned: 0,
    matched: 0,
    queued: 0,
    listingIds: [],
    cursors: {},
  };
  for (const [stateKey, columnName] of scans) {
    const { rows } = listListingsForPurchaseHistoryMatchScan(db, stateKey, columnName, {
      ...options,
      limit,
    });
    const listingIds = rows.map((row) => row.listing_id);
    const scanResult = scanPurchaseHistoryMatchesForListings(db, listingIds, {
      ...options,
      actor,
    });
    result.scanned += scanResult.scanned;
    result.matched += scanResult.matched;
    result.queued += scanResult.queued;
    result.listingIds.push(...scanResult.listingIds);
    if (rows.length > 0) {
      const last = rows[rows.length - 1];
      updatePurchaseHistoryMatchScanState(db, stateKey, last[columnName], last.listing_id, options);
      result.cursors[stateKey] = {
        cursorAt: last[columnName],
        cursorId: last.listing_id,
      };
    }
  }
  result.listingIds = uniqueStrings(result.listingIds);
  return result;
}

function upsertPurchaseHistoryListingLink(db, link, options = {}) {
  const documentId = String(link.documentId || link.document_id || '').trim();
  const recordId = String(link.recordId || link.record_id || '').trim();
  const listingId = String(link.listingId || link.listing_id || '').trim();
  const href = canonicalizeListingUrl(link.href || '');
  const relationshipType = normalizePurchaseHistoryListingRelationship(link.relationshipType || link.relationship_type);
  if (!documentId || !recordId || !listingId) {
    throw new Error('purchase history listing link requires documentId, recordId, and listingId');
  }
  const row = getPurchaseHistoryRow(db, documentId, recordId);
  if (!row) {
    throw new Error(`Unknown purchase history record: ${recordId}`);
  }
  const listing = getHomepageListing(db, listingId);
  if (!listing) {
    throw new Error(`Unknown listing: ${listingId}`);
  }
  const now = options.linkedAt || options.linked_at || new Date().toISOString();
  db.prepare(`
    INSERT INTO purchase_history_listing_links (
      document_id,
      record_id,
      listing_id,
      relationship_type,
      href,
      note,
      linked_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(document_id, record_id, listing_id, relationship_type) DO UPDATE SET
      href = excluded.href,
      note = excluded.note,
      updated_at = excluded.updated_at
  `).run(
    documentId,
    recordId,
    listingId,
    relationshipType,
    href || listing.href || '',
    String(link.note || '').trim(),
    now,
    now,
  );

  appendPurchaseHistoryEvent(db, {
    documentId,
    recordId,
    eventType: 'listing_linked',
    eventAt: now,
    createdAt: now,
    eventId: `${documentId}:${recordId}:listing_linked:${relationshipType}:${listingId}:${now}`,
    data: {
      listing_id: listingId,
      href: href || listing.href || '',
      relationship_type: relationshipType,
      title: row.title,
    },
  });

  return listPurchaseHistoryListingLinks(db, {
    documentId,
    recordId,
    listingId,
  }).find((item) => item.relationship_type === relationshipType) || null;
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

const EVENT_REGISTRY_SOURCES = ['inventory', 'listing', 'resolve', 'recommendation', 'workflow'];
const EVENT_REGISTRY_DEFAULT_LIMIT = 100;
const EVENT_REGISTRY_MAX_LIMIT = 500;
const EVENT_REGISTRY_ALL_SOURCE_WINDOW = 2500;

function normalizeEventRegistrySource(source) {
  const normalized = String(source || 'all').trim().toLowerCase();
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

function listEventRegistrySourceRows(db, source, options = {}) {
  const limit = normalizeEventRegistryLimit(options.limit);
  const offset = normalizeEventRegistryOffset(options.offset);
  switch (source) {
    case 'inventory':
      return db.prepare(`
        SELECT
          'inventory' AS source,
          events.event_id,
          events.event_type,
          events.event_at,
          COALESCE(rows.outcome, '') AS status,
          events.record_id AS subject_id,
          COALESCE(NULLIF(rows.title, ''), events.record_id) AS title,
          events.data_json
        FROM purchase_history_events events
        LEFT JOIN purchase_history_rows rows
          ON rows.document_id = events.document_id
          AND rows.record_id = events.record_id
        ORDER BY events.event_at DESC, events.created_at DESC
        LIMIT ?
        OFFSET ?
      `).all(limit, offset);
    case 'listing':
      return db.prepare(`
        SELECT
          'listing' AS source,
          events.event_id,
          events.event_type,
          events.event_at,
          events.status,
          events.listing_id AS subject_id,
          COALESCE(NULLIF(listings.detail_title, ''), NULLIF(listings.card_title, ''), events.listing_id) AS title,
          events.content_json AS data_json
        FROM listing_events events
        LEFT JOIN homepage_listings listings
          ON listings.listing_id = events.listing_id
        ORDER BY events.event_at DESC
        LIMIT ?
        OFFSET ?
      `).all(limit, offset);
    case 'resolve':
      return db.prepare(`
        SELECT
          'resolve' AS source,
          events.event_id,
          events.event_type,
          events.event_at,
          events.status,
          events.listing_id AS subject_id,
          COALESCE(NULLIF(listings.detail_title, ''), NULLIF(listings.card_title, ''), events.listing_id) AS title,
          json_patch(events.content_json, json_object(
            'workflow_run_id', events.workflow_run_id,
            'actor', events.actor,
            'error', events.error
          )) AS data_json
        FROM resolve_queue_events events
        LEFT JOIN homepage_listings listings
          ON listings.listing_id = events.listing_id
        ORDER BY events.event_at DESC
        LIMIT ?
        OFFSET ?
      `).all(limit, offset);
    case 'recommendation':
      return db.prepare(`
        SELECT
          'recommendation' AS source,
          events.event_id,
          events.event_type,
          events.event_at,
          queue.status,
          events.listing_id AS subject_id,
          COALESCE(NULLIF(listings.detail_title, ''), NULLIF(listings.card_title, ''), rows.title, events.listing_id) AS title,
          json_patch(events.content_json, json_object(
            'document_id', events.document_id,
            'record_id', events.record_id,
            'listing_id', events.listing_id,
            'actor', events.actor,
            'reason', events.reason
          )) AS data_json
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
        LIMIT ?
        OFFSET ?
      `).all(limit, offset);
    case 'workflow':
      return db.prepare(`
        SELECT
          'workflow' AS source,
          events.event_id,
          events.event_type,
          events.event_at,
          events.status,
          events.workflow_run_id AS subject_id,
          COALESCE(NULLIF(runs.label, ''), events.workflow_run_id) AS title,
          events.content_json AS data_json
        FROM workflow_events events
        LEFT JOIN workflow_runs runs
          ON runs.run_id = events.workflow_run_id
        ORDER BY events.event_at DESC
        LIMIT ?
        OFFSET ?
      `).all(limit, offset);
    default:
      return [];
  }
}

function listEventRegistry(db, options = {}) {
  const source = normalizeEventRegistrySource(options.source);
  const limit = normalizeEventRegistryLimit(options.limit);
  const offset = normalizeEventRegistryOffset(options.offset);
  if (source !== 'all') {
    return listEventRegistrySourceRows(db, source, { limit, offset }).map(normalizeEventRegistryRow);
  }
  const perSourceLimit = Math.min(EVENT_REGISTRY_ALL_SOURCE_WINDOW, offset + limit);
  const rows = EVENT_REGISTRY_SOURCES.flatMap((eventSource) => (
    listEventRegistrySourceRows(db, eventSource, { limit: perSourceLimit, offset: 0 })
  )).sort((left, right) => (
    String(right.event_at || '').localeCompare(String(left.event_at || ''))
    || String(right.event_id || '').localeCompare(String(left.event_id || ''))
  )).slice(offset, offset + limit);
  return rows.map(normalizeEventRegistryRow);
}

function countEventRegistry(db, options = {}) {
  const source = normalizeEventRegistrySource(options.source);
  const countSource = (eventSource) => {
    switch (eventSource) {
      case 'inventory':
        return db.prepare('SELECT COUNT(*) AS total FROM purchase_history_events').get().total || 0;
      case 'listing':
        return db.prepare('SELECT COUNT(*) AS total FROM listing_events').get().total || 0;
      case 'resolve':
        return db.prepare('SELECT COUNT(*) AS total FROM resolve_queue_events').get().total || 0;
      case 'recommendation':
        return db.prepare('SELECT COUNT(*) AS total FROM purchase_history_match_events').get().total || 0;
      case 'workflow':
        return db.prepare('SELECT COUNT(*) AS total FROM workflow_events').get().total || 0;
      default:
        return 0;
    }
  };
  if (source !== 'all') return countSource(source);
  return EVENT_REGISTRY_SOURCES.reduce((total, eventSource) => total + countSource(eventSource), 0);
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
    workflow_status: row.workflow_status || '',
    workflow_label: row.workflow_label || '',
    workflow_started_at: row.workflow_started_at || '',
    workflow_updated_at: row.workflow_updated_at || '',
    workflow_os_alive: row.workflow_os_alive === undefined ? null : Boolean(row.workflow_os_alive),
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
      h.last_seen_at,
      w.status AS workflow_status,
      w.label AS workflow_label,
      w.started_at AS workflow_started_at,
      w.updated_at AS workflow_updated_at,
      w.os_alive AS workflow_os_alive
    FROM resolve_queue_items q
    LEFT JOIN homepage_listings h ON h.listing_id = q.listing_id
    LEFT JOIN workflow_runs w ON w.run_id = q.workflow_run_id
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

function listListingResolverAssignments(db, listingIds = []) {
  const ids = uniqueStrings(listingIds);
  if (!ids.length) {
    return [];
  }
  return db.prepare(`
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
    WHERE q.listing_id IN (${ids.map(() => '?').join(', ')})
  `).all(...ids).map((row) => ({
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
    resolver_workflow_os_alive: row.workflow_os_alive === undefined ? null : Boolean(row.workflow_os_alive),
  }));
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

function normalizeWorkerParameterProfileRow(row) {
  if (!row) {
    return null;
  }

  return {
    profile_id: row.profile_id,
    workflow_id: row.workflow_id,
    worker_type: row.worker_type || '',
    label: row.label,
    params: parseJsonObject(row.params_json),
    args: parseJsonArray(row.args_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeSummaryQueryCardRow(row) {
  if (!row) {
    return null;
  }

  return {
    card_id: row.card_id,
    label: row.label,
    query: row.query,
    position: Number.isFinite(row.position) ? row.position : 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeSavedQueryRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.query_id,
    query_id: row.query_id,
    label: row.label,
    query: row.query,
    showInOverview: row.show_in_overview === 1,
    show_in_overview: row.show_in_overview === 1,
    source: 'server',
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
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
    event_scope: row.event_scope || 'listing',
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
    event_scope: row.event_scope || 'workflow',
    event_id: row.event_id,
    workflow_run_id: row.workflow_run_id,
    listing_id: row.listing_id || '',
    event_type: row.event_type,
    event_at: row.event_at,
    worker_id: row.worker_id || row.workflow_run_id || '',
    source_url: row.source_url || '',
    attempt: Number.isFinite(row.attempt) ? row.attempt : 0,
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

function normalizeWorkerParameterProfileId(value, fallback = '') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  if (normalized) {
    return normalized;
  }
  return fallback || `worker-profile-${crypto.randomBytes(8).toString('hex')}`;
}

function listWorkerParameterProfiles(db, options = {}) {
  const workflowId = String(options.workflowId || options.workflow_id || '').trim();
  if (workflowId) {
    return db.prepare(`
      SELECT *
      FROM worker_parameter_profiles
      WHERE workflow_id = ?
      ORDER BY updated_at DESC, label ASC
    `).all(workflowId).map(normalizeWorkerParameterProfileRow);
  }
  return db.prepare(`
    SELECT *
    FROM worker_parameter_profiles
    ORDER BY updated_at DESC, label ASC
  `).all().map(normalizeWorkerParameterProfileRow);
}

function getWorkerParameterProfile(db, profileId) {
  return normalizeWorkerParameterProfileRow(db.prepare(`
    SELECT *
    FROM worker_parameter_profiles
    WHERE profile_id = ?
  `).get(String(profileId || '').trim()));
}

function upsertWorkerParameterProfile(db, profile) {
  const now = profile.updatedAt || profile.updated_at || new Date().toISOString();
  const workflowId = String(profile.workflowId || profile.workflow_id || '').trim();
  if (!workflowId) {
    throw new Error('upsertWorkerParameterProfile requires workflowId');
  }
  const label = normalizeKeyword(profile.label || profile.name || '');
  if (!label) {
    throw new Error('upsertWorkerParameterProfile requires label');
  }
  const profileId = normalizeWorkerParameterProfileId(
    profile.profileId || profile.profile_id,
    normalizeWorkerParameterProfileId(`${workflowId}-${label}`),
  );
  const previous = getWorkerParameterProfile(db, profileId);
  const params = profile.params && typeof profile.params === 'object' && !Array.isArray(profile.params)
    ? profile.params
    : {};
  const args = Array.isArray(profile.args) ? profile.args : [];

  db.prepare(`
    INSERT INTO worker_parameter_profiles (
      profile_id,
      workflow_id,
      worker_type,
      label,
      params_json,
      args_json,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(profile_id) DO UPDATE SET
      workflow_id = excluded.workflow_id,
      worker_type = excluded.worker_type,
      label = excluded.label,
      params_json = excluded.params_json,
      args_json = excluded.args_json,
      updated_at = excluded.updated_at
  `).run(
    profileId,
    workflowId,
    String(profile.workerType || profile.worker_type || '').trim(),
    label,
    serializeJson(params),
    serializeArray(args),
    previous?.created_at || profile.createdAt || profile.created_at || now,
    now,
  );

  return getWorkerParameterProfile(db, profileId);
}

function deleteWorkerParameterProfile(db, profileId) {
  const id = String(profileId || '').trim();
  const previous = getWorkerParameterProfile(db, id);
  if (!previous) {
    return null;
  }
  db.prepare(`
    DELETE FROM worker_parameter_profiles
    WHERE profile_id = ?
  `).run(id);
  return previous;
}

function normalizeSummaryQueryCardId(value, fallback = '') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  if (normalized) {
    return normalized;
  }
  return fallback || `summary-card-${crypto.randomBytes(8).toString('hex')}`;
}

function listSummaryQueryCards(db) {
  return db.prepare(`
    SELECT *
    FROM summary_query_cards
    ORDER BY position ASC, updated_at DESC, label ASC
  `).all().map(normalizeSummaryQueryCardRow);
}

function getSummaryQueryCard(db, cardId) {
  return normalizeSummaryQueryCardRow(db.prepare(`
    SELECT *
    FROM summary_query_cards
    WHERE card_id = ?
  `).get(String(cardId || '').trim()));
}

function upsertSummaryQueryCard(db, card) {
  const now = card.updatedAt || card.updated_at || new Date().toISOString();
  const label = normalizeKeyword(card.label || card.name || '');
  if (!label) {
    throw new Error('upsertSummaryQueryCard requires label');
  }
  const query = String(card.query || '').trim();
  if (!query) {
    throw new Error('upsertSummaryQueryCard requires query');
  }
  const cardId = normalizeSummaryQueryCardId(
    card.cardId || card.card_id,
    normalizeSummaryQueryCardId(`summary-${label}`),
  );
  const previous = getSummaryQueryCard(db, cardId);
  const position = Number.isFinite(card.position)
    ? Math.max(0, Math.trunc(card.position))
    : previous?.position ?? 100;

  db.prepare(`
    INSERT INTO summary_query_cards (
      card_id,
      label,
      query,
      position,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(card_id) DO UPDATE SET
      label = excluded.label,
      query = excluded.query,
      position = excluded.position,
      updated_at = excluded.updated_at
  `).run(
    cardId,
    label,
    query,
    position,
    previous?.created_at || card.createdAt || card.created_at || now,
    now,
  );

  return getSummaryQueryCard(db, cardId);
}

function deleteSummaryQueryCard(db, cardId) {
  const id = String(cardId || '').trim();
  const previous = getSummaryQueryCard(db, id);
  if (!previous) {
    return null;
  }
  db.prepare(`
    DELETE FROM summary_query_cards
    WHERE card_id = ?
  `).run(id);
  return previous;
}

function normalizeSavedQueryId(value, fallback = '') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  if (normalized) return normalized;
  return fallback || `saved-query-${crypto.randomBytes(8).toString('hex')}`;
}

function listSavedQueries(db) {
  return db.prepare(`
    SELECT *
    FROM saved_queries
    ORDER BY updated_at DESC, label ASC
  `).all().map(normalizeSavedQueryRow);
}

function getSavedQuery(db, queryId) {
  return normalizeSavedQueryRow(db.prepare(`
    SELECT *
    FROM saved_queries
    WHERE query_id = ?
  `).get(String(queryId || '').trim()));
}

function upsertSavedQuery(db, query) {
  const now = query.updatedAt || query.updated_at || new Date().toISOString();
  const label = normalizeKeyword(query.label || query.name || '');
  if (!label) {
    throw new Error('upsertSavedQuery requires label');
  }
  const queryText = String(query.query || '').trim();
  if (!queryText) {
    throw new Error('upsertSavedQuery requires query');
  }
  const queryId = normalizeSavedQueryId(
    query.id || query.queryId || query.query_id,
    normalizeSavedQueryId(`saved-${label}`),
  );
  const previous = getSavedQuery(db, queryId);
  const showInOverview = query.showInOverview ?? query.show_in_overview ?? previous?.showInOverview ?? false;

  db.prepare(`
    INSERT INTO saved_queries (
      query_id,
      label,
      query,
      show_in_overview,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(query_id) DO UPDATE SET
      label = excluded.label,
      query = excluded.query,
      show_in_overview = excluded.show_in_overview,
      updated_at = excluded.updated_at
  `).run(
    queryId,
    label,
    queryText,
    showInOverview ? 1 : 0,
    previous?.created_at || query.createdAt || query.created_at || now,
    now,
  );

  return getSavedQuery(db, queryId);
}

function setSavedQueryOverview(db, queryId, showInOverview) {
  const previous = getSavedQuery(db, queryId);
  if (!previous) return null;
  db.prepare(`
    UPDATE saved_queries
    SET show_in_overview = ?, updated_at = ?
    WHERE query_id = ?
  `).run(showInOverview ? 1 : 0, new Date().toISOString(), previous.query_id);
  return getSavedQuery(db, previous.query_id);
}

function deleteSavedQuery(db, queryId) {
  const id = String(queryId || '').trim();
  const previous = getSavedQuery(db, id);
  if (!previous) return null;
  db.prepare('DELETE FROM saved_queries WHERE query_id = ?').run(id);
  return previous;
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
  const status = String(event.status || (event.error ? 'error' : '')).trim();

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
    status,
    serializeJson(content),
    String(event.error || '').trim(),
  );

  incrementWorkerEventStatsCache(db, {
    workerId: workflowRunId,
    eventScope: 'workflow',
    eventType,
    status,
    updatedAt: eventAt,
  });

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
  const eventType = String(options.eventType || '').trim();
  const params = [String(workflowRunId)];
  const eventTypeSql = eventType ? 'AND event_type = ?' : '';
  if (eventType) {
    params.push(eventType);
  }
  params.push(limit);
  return db.prepare(`
    SELECT *
    FROM workflow_events
    WHERE workflow_run_id = ?
      ${eventTypeSql}
    ORDER BY event_at DESC
    LIMIT ?
  `).all(...params).map(normalizeWorkflowEventRow);
}

function listWorkerWorkflowEvents(db, workflowRunId, options = {}) {
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(options.limit, 200)) : 50;
  const eventType = String(options.eventType || '').trim();
  const params = [String(workflowRunId)];
  const eventTypeSql = eventType ? 'AND event_type = ?' : '';
  if (eventType) {
    params.push(eventType);
  }
  params.push(limit);
  return db.prepare(`
    SELECT
      'workflow' AS event_scope,
      *
    FROM workflow_events
    WHERE workflow_run_id = ?
      ${eventTypeSql}
    ORDER BY event_at DESC
    LIMIT ?
  `).all(...params).map(normalizeWorkflowEventRow);
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

const COLLECTOR_OBSERVED_EVENT_TYPE = 'listing_observed';
const COLLECTOR_DONE_STATUSES = ['new', 'existing_updated', 'updated', 'match_queued', 'queued'];
const COLLECTOR_SKIPPED_STATUSES = ['existing_same', 'duplicate', 'filtered', 'ignored', 'already_seen'];
const COLLECTOR_ERROR_STATUSES = ['error', 'failed', 'malformed', 'interrupted'];

function listingCategorySql(category, alias = 'e') {
  const normalized = normalizeKeyword(category || 'all').toLowerCase();
  const detailTypes = eventTypesForCategory(normalized);
  const collectorStatusSql = (statuses) => (
    `${alias}.event_type = ? AND ${alias}.status IN (${statuses.map(() => '?').join(', ')})`
  );

  switch (normalized) {
    case 'done':
      return {
        sql: `AND (${alias}.event_type IN (${detailTypes.map(() => '?').join(', ')})
          OR (${collectorStatusSql(COLLECTOR_DONE_STATUSES)}))`,
        params: [...detailTypes, COLLECTOR_OBSERVED_EVENT_TYPE, ...COLLECTOR_DONE_STATUSES],
      };
    case 'skipped':
    case 'skip':
      return {
        sql: `AND (${alias}.event_type IN (${detailTypes.map(() => '?').join(', ')})
          OR (${collectorStatusSql(COLLECTOR_SKIPPED_STATUSES)}))`,
        params: [...detailTypes, COLLECTOR_OBSERVED_EVENT_TYPE, ...COLLECTOR_SKIPPED_STATUSES],
      };
    case 'error':
    case 'errors':
      return {
        sql: `AND (${alias}.event_type IN (${detailTypes.map(() => '?').join(', ')})
          OR (${collectorStatusSql(COLLECTOR_ERROR_STATUSES)}))`,
        params: [...detailTypes, COLLECTOR_OBSERVED_EVENT_TYPE, ...COLLECTOR_ERROR_STATUSES],
      };
    case 'started':
    case 'active':
      return {
        sql: `AND (${alias}.event_type IN (${detailTypes.map(() => '?').join(', ')})
          OR ${alias}.event_type = ?)`,
        params: [...detailTypes, COLLECTOR_OBSERVED_EVENT_TYPE],
      };
    case 'all':
    default:
      return { sql: '', params: [] };
  }
}

function workflowReviewSql(alias = 'workflow_events') {
  return `(${alias}.event_type LIKE '%failed%'
    OR ${alias}.event_type LIKE '%interrupted%'
    OR ${alias}.status IN ('error', 'failed', 'interrupted')
    OR COALESCE(${alias}.error, '') != '')`;
}

function listingEventSemanticBuckets(eventType, status) {
  const buckets = [];
  if (eventTypesForCategory('started').includes(eventType)) {
    buckets.push('started');
  }
  if (eventTypesForCategory('done').includes(eventType)) {
    buckets.push('done');
  }
  if (eventTypesForCategory('skipped').includes(eventType)) {
    buckets.push('skipped');
  }
  if (eventTypesForCategory('error').includes(eventType)) {
    buckets.push('error');
  }
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
  const eventType = String(options.eventType || '').trim();
  const workerIds = options.workerIds || [workerId];
  const params = [];
  const workerSql = workerRunWhereSql(workerId, workerIds, params, 'e');
  let eventTypeSql = '';

  if (eventType) {
    eventTypeSql = 'AND e.event_type = ?';
    params.push(eventType);
  } else {
    const categoryFilter = listingCategorySql(options.category, 'e');
    eventTypeSql = categoryFilter.sql;
    params.push(...categoryFilter.params);
  }

  params.push(limit);

  return db.prepare(`
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
    WHERE ${workerSql}
      ${eventTypeSql}
    ORDER BY e.event_at DESC
    LIMIT ?
  `).all(...params).map(normalizeListingEventRow);
}

function listWorkerAuditEvents(db, workerId, options = {}) {
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(options.limit, 200)) : 50;
  const category = normalizeKeyword(options.category || 'all').toLowerCase();

  if (category === 'workflow' || category === 'lifecycle') {
    return listWorkerWorkflowEvents(db, workerId, { ...options, limit });
  }

  if (category === 'listing') {
    return listWorkerListingEvents(db, workerId, {
      ...options,
      category: 'all',
      limit,
    });
  }

  if (category !== 'all') {
    if (['error', 'errors', 'review'].includes(category)) {
      const listingEvents = listWorkerListingEvents(db, workerId, {
        ...options,
        category: 'error',
        limit,
      });
      const workflowEvents = listWorkerWorkflowEvents(db, workerId, { ...options, limit })
        .filter((event) => (
          /failed|interrupted/.test(event.event_type || '')
          || ['error', 'failed', 'interrupted'].includes(event.status || '')
          || Boolean(event.error)
        ));
      return [...listingEvents, ...workflowEvents]
        .sort((left, right) => String(right.event_at || '').localeCompare(String(left.event_at || '')))
        .slice(0, limit);
    }
    return listWorkerListingEvents(db, workerId, {
      ...options,
      category,
      limit,
    });
  }

  const listingEvents = listWorkerListingEvents(db, workerId, {
    ...options,
    category: 'all',
    limit,
  });
  const workflowEvents = listWorkerWorkflowEvents(db, workerId, { ...options, limit });
  return [...listingEvents, ...workflowEvents]
    .sort((left, right) => String(right.event_at || '').localeCompare(String(left.event_at || '')))
    .slice(0, limit);
}

function getWorkerListingEventStats(db, workerId, options = {}) {
  const workerIds = uniqueStrings(options.workerIds || [workerId]);
  const statsParams = [];
  const statsWorkerSql = workerRunWhereSql(workerId, workerIds, statsParams, 'listing_events');
  const rows = db.prepare(`
    SELECT event_type, status, COUNT(*) AS count
    FROM listing_events
    WHERE ${statsWorkerSql}
    GROUP BY event_type, status
  `).all(...statsParams);
  const eventTypeCounts = new Map();

  const stats = {
    total: 0,
    done: 0,
    skipped: 0,
    error: 0,
    started: 0,
    workerIds,
    eventTypes: [],
    statusTypes: rows.map((row) => ({
      eventType: row.event_type,
      eventScope: 'listing',
      status: row.status || '',
      count: row.count,
    })),
  };

  for (const row of rows) {
    stats.total += row.count;
    eventTypeCounts.set(row.event_type, (eventTypeCounts.get(row.event_type) || 0) + row.count);
    for (const bucket of listingEventSemanticBuckets(row.event_type, row.status || '')) {
      if (bucket === 'done') stats.done += row.count;
      if (bucket === 'skipped') stats.skipped += row.count;
      if (bucket === 'error') stats.error += row.count;
      if (bucket === 'started') stats.started += row.count;
    }
  }
  stats.eventTypes = [...eventTypeCounts.entries()].map(([eventType, count]) => ({
    eventType,
    eventScope: 'listing',
    count,
  }));

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

function getWorkerAuditEventStatsFromCache(db, workerId) {
  const rows = db.prepare(`
    SELECT event_scope, event_type, status, count
    FROM worker_event_stats_cache
    WHERE worker_id = ?
  `).all(String(workerId || '').trim());
  if (rows.length === 0) {
    return null;
  }

  const listingStats = {
    total: 0,
    done: 0,
    skipped: 0,
    error: 0,
    started: 0,
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
    const count = Number(row.count) || 0;
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
      if (
        /failed|interrupted/i.test(row.event_type || '')
        || ['error', 'failed', 'interrupted'].includes(row.status || '')
      ) {
        workflowReview += count;
      }
      eventTypesByKey.set(`workflow:${row.event_type}`, {
        eventType: row.event_type,
        eventScope: 'workflow',
        count: (eventTypesByKey.get(`workflow:${row.event_type}`)?.count || 0) + count,
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

function getWorkerAuditEventStats(db, workerId, options = {}) {
  if ((options.preferCache || options.cacheOnly) && !options.includeLatestEvents && !options.workerIds) {
    const cached = getWorkerAuditEventStatsFromCache(db, workerId);
    if (cached) {
      return cached;
    }
    if (options.cacheOnly) {
      return {
        total: 0,
        listingTotal: 0,
        workflow: 0,
        workflowReview: 0,
        done: 0,
        skipped: 0,
        error: 0,
        started: 0,
        workerIds: [String(workerId || '').trim()].filter(Boolean),
        eventTypes: [],
        statusTypes: [],
        latestEvent: null,
        latestPreviewEvent: null,
        source: 'cache_miss',
      };
    }
  }
  const listingStats = getWorkerListingEventStats(db, workerId, options);
  const workflowRows = db.prepare(`
    SELECT event_type, COUNT(*) AS count
    FROM workflow_events
    WHERE workflow_run_id = ?
    GROUP BY event_type
  `).all(String(workerId));
  const workflowCount = workflowRows.reduce((sum, row) => sum + row.count, 0);
  const workflowReview = db.prepare(`
    SELECT COUNT(*) AS count
    FROM workflow_events
    WHERE workflow_run_id = ?
      AND ${workflowReviewSql('workflow_events')}
  `).get(String(workerId)).count || 0;
  const latestWorkflow = listWorkerWorkflowEvents(db, workerId, { limit: 1 })[0] || null;
  const latestCandidates = [listingStats.latestEvent, latestWorkflow].filter(Boolean);
  const latestEvent = latestCandidates
    .sort((left, right) => String(right.event_at || '').localeCompare(String(left.event_at || '')))[0] || null;
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
      count: (current?.count || 0) + row.count,
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

  if (options.recoverStaleProcessing) {
    const staleProcessing = recoverStaleProcessingHomepageListings(db, {
      dryRun: false,
      staleAfterSeconds: options.staleProcessingSeconds,
      limit: options.staleProcessingLimit,
      nextStatus: options.staleProcessingStatus,
      reason: options.staleProcessingReason,
    });
    actions.push({
      recoverStaleProcessing: staleProcessing,
    });
    options.staleProcessing = staleProcessing;
  }

  if (options.normalizeListedAt) {
    actions.push({
      normalizeListedAt: normalizeHomepageListedTimeRanges(db, {
        limit: options.normalizeListedAtLimit,
        staleOnly: options.normalizeListedAtStaleOnly !== false,
      }),
    });
  }

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
    ...(options.staleProcessing ? { staleProcessing: options.staleProcessing } : {}),
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
  listStaleProcessingHomepageListings,
  recoverStaleProcessingHomepageListings,
  markHomepageListingInactive,
  getHomepageListingCounts,
  createPurchaseHistoryDocument,
  listPurchaseHistoryDocuments,
  getPurchaseHistoryDocument,
  deletePurchaseHistoryDocument,
  getPurchaseHistoryRow,
  upsertPurchaseHistoryRows,
  listPurchaseHistoryRows,
  upsertPurchaseHistoryListingLink,
  listPurchaseHistoryListingLinks,
  scanPurchaseHistoryMatchesForListings,
  scanPurchaseHistoryListingMatches,
  listPurchaseHistoryMatchQueue,
  listRandomPurchaseHistoryMatches,
  countPurchaseHistoryMatchQueue,
  updatePurchaseHistoryMatchQueueStatus,
  mergePurchaseHistoryDocuments,
  appendPurchaseHistoryEvent,
  listPurchaseHistoryEvents,
  listEventRegistry,
  countEventRegistry,
  hashContent,
  runTransaction,
  appendListingEvent,
  appendWorkflowEvent,
  appendResolveQueueEvent,
  getWorkflowEvent,
  listWorkflowEvents,
  listWorkerWorkflowEvents,
  getListingEvent,
  getListingEvents,
  getLatestListingEvent,
  addResolveQueueItems,
  clearResolveQueueItems,
  markResolveQueueDispatched,
  refreshResolveQueueRunStatuses,
  listResolveQueueItems,
  listListingResolverAssignments,
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
  listWorkerParameterProfiles,
  getWorkerParameterProfile,
  upsertWorkerParameterProfile,
  deleteWorkerParameterProfile,
  listSummaryQueryCards,
  getSummaryQueryCard,
  upsertSummaryQueryCard,
  deleteSummaryQueryCard,
  listSavedQueries,
  getSavedQuery,
  upsertSavedQuery,
  setSavedQueryOverview,
  deleteSavedQuery,
  resolveWorkerEventIdsForRun,
  listWorkerListingEvents,
  listWorkerAuditEvents,
  getWorkerListingEventStats,
  getWorkerAuditEventStats,
  normalizeHomepageListingListedTime,
  normalizeHomepageListedTimeRanges,
  getDatabaseMaintenanceReport,
  runDatabaseMaintenance,
};
