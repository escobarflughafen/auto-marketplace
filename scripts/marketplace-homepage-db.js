const fs = require('fs');
const path = require('path');
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
        WHEN homepage_listings.detail_status IN ('done', 'processing')
          THEN homepage_listings.detail_status
        ELSE 'pending'
      END,
      detail_last_error = CASE
        WHEN homepage_listings.detail_status IN ('done', 'processing')
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

function claimNextPendingHomepageListing(db, options = {}) {
  const now = options.claimedAt || new Date().toISOString();
  const staleAfterSeconds = Number.isFinite(options.staleAfterSeconds)
    ? options.staleAfterSeconds
    : 30 * 60;
  const staleBefore = new Date(Date.now() - (staleAfterSeconds * 1000)).toISOString();
  const workerId = String(options.workerId || `worker-${process.pid}`);

  db.exec('BEGIN IMMEDIATE');
  try {
    const candidate = db.prepare(`
      SELECT listing_id
      FROM homepage_listings
      WHERE detail_status IN ('pending', 'error')
        OR (
          detail_status = 'processing'
          AND COALESCE(detail_started_at, '') != ''
          AND detail_started_at <= ?
        )
      ORDER BY
        CASE detail_status
          WHEN 'pending' THEN 0
          WHEN 'error' THEN 1
          ELSE 2
        END,
        COALESCE(last_seen_rank, 999999) ASC,
        last_seen_at DESC,
        first_seen_at ASC
      LIMIT 1
    `).get(staleBefore);

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
  db.prepare(`
    UPDATE homepage_listings
    SET
      detail_status = 'error',
      detail_last_error = ?,
      claimed_by = ''
    WHERE listing_id = ?
  `).run(String(error || 'Unknown processing error').trim(), listingId);

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
  claimNextPendingHomepageListing,
  markHomepageListingProcessed,
  markHomepageListingFailed,
  getHomepageListingCounts,
  upsertListingSearchKeyword,
  upsertSearchTitleBagKeyword,
  getSearchTitleBagKeyword,
  pickRandomSearchTitleBagKeyword,
  getSearchTitleBagCounts,
};
