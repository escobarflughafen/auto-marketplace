const { createMarketplaceListingMediaPostgresStore } = require('./marketplace-listing-media-postgres-store');
const { createMarketplaceWorkerEventsPostgresStore } = require('./marketplace-worker-events-postgres-store');
const { listedAgoToUnixRange } = require('./marketplace-listed-time-normalizer');

function normalizeKeyword(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function serializeJson(value) {
  return JSON.stringify(value ?? {}, null, 2);
}

function extractListingId(url) {
  const match = String(url || '').match(/\/marketplace\/item\/(\d+)/);
  return match ? match[1] : '';
}

function extractGoofishListingId(url) {
  const text = String(url || '');
  const match = text.match(/[?&]id=(\d{9,})/i)
    || text.match(/[?&]itemId=(\d{9,})/i)
    || text.match(/[?&]item_id=(\d{9,})/i)
    || text.match(/\/item\/(\d{9,})/i);
  return match ? match[1] : '';
}

function canonicalizeListingUrl(url) {
  const listingId = extractListingId(url);
  if (listingId) {
    return `https://www.facebook.com/marketplace/item/${listingId}/`;
  }

  try {
    const parsed = new URL(String(url || ''));
    if (/goofish\.com$/i.test(parsed.hostname) && parsed.pathname === '/item') {
      const goofishListingId = extractGoofishListingId(parsed.toString());
      if (goofishListingId) {
        const categoryId = parsed.searchParams.get('categoryId') || '';
        return `https://www.goofish.com/item?id=${goofishListingId}${categoryId ? `&categoryId=${encodeURIComponent(categoryId)}` : ''}`;
      }
    }
    return `${parsed.origin}${parsed.pathname}`;
  } catch (_) {
    return String(url || '').trim();
  }
}

function summarizeHomepageListingComparable(listing = {}) {
  return {
    href: canonicalizeListingUrl(listing.href),
    cardTitle: String(listing.title || listing.card_title || '').trim(),
    cardText: String(listing.text || listing.card_text || '').trim(),
  };
}

function integerOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeHomepageListingRow(row) {
  if (!row) return null;
  return {
    ...row,
    last_seen_rank: integerOrNull(row.last_seen_rank),
    detail_attempts: integerOrNull(row.detail_attempts),
    detail_listed_at_earliest_unix: integerOrNull(row.detail_listed_at_earliest_unix),
    detail_listed_at_latest_unix: integerOrNull(row.detail_listed_at_latest_unix),
    detail_listed_at_anchor_unix: integerOrNull(row.detail_listed_at_anchor_unix),
    detail_listed_at_value: integerOrNull(row.detail_listed_at_value),
  };
}

function requirePgPool() {
  try {
    return require('pg').Pool;
  } catch (error) {
    const wrapped = new Error('PostgreSQL homepage listing store requires the pg package or an injected pool.');
    wrapped.cause = error;
    wrapped.code = 'missing_pg_dependency';
    throw wrapped;
  }
}

function createPoolFromOptions(options = {}) {
  if (options.pool) return options.pool;
  const connectionString = options.connectionString
    || process.env.MARKETPLACE_HOMEPAGE_LISTINGS_POSTGRES_URL
    || process.env.MARKETPLACE_POSTGRES_URL
    || process.env.DATABASE_URL
    || '';
  if (!connectionString) {
    const error = new Error('Missing PostgreSQL connection string. Set MARKETPLACE_HOMEPAGE_LISTINGS_POSTGRES_URL, MARKETPLACE_POSTGRES_URL, or pass connectionString.');
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

function placeholder(params, value) {
  params.push(value);
  return `$${params.length}`;
}

function placeholderList(params, values) {
  return values.map((value) => placeholder(params, value)).join(', ');
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

function isoBefore(options = {}, seconds = 0) {
  const base = options.now ? Date.parse(options.now) : Date.now();
  return new Date(base - (seconds * 1000)).toISOString();
}

function buildBacklogCandidateQueryParts(options = {}) {
  const staleAfterSeconds = Number.isFinite(options.staleAfterSeconds)
    ? options.staleAfterSeconds
    : 30 * 60;
  const staleBefore = isoBefore(options, staleAfterSeconds);
  const maxAttempts = Number.isFinite(options.maxAttempts)
    ? Math.max(1, options.maxAttempts)
    : null;
  const retryDelaySeconds = Number.isFinite(options.retryDelaySeconds)
    ? Math.max(0, options.retryDelaySeconds)
    : 0;
  const retryBefore = isoBefore(options, retryDelaySeconds);
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
            AND detail_started_at <= ${placeholder(params, staleBefore)}
          )
        )
      `;
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
        AND detail_started_at <= ${placeholder(params, staleBefore)}
      `;
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
    extraWhereSql += ` AND detail_attempts < ${placeholder(params, maxAttempts)}`;
  }
  if (retryDelaySeconds > 0) {
    extraWhereSql += `
      AND (
        detail_status != 'error'
        OR COALESCE(detail_completed_at, detail_started_at, first_seen_at) <= ${placeholder(params, retryBefore)}
      )
    `;
  }
  if (sourceFilter) {
    extraWhereSql += ` AND source = ${placeholder(params, sourceFilter)}`;
  }
  if (keywordFilter) {
    extraWhereSql += ` AND lower(source_keyword) LIKE ${placeholder(params, `%${keywordFilter}%`)}`;
  }
  if (listingIds.length > 0) {
    extraWhereSql += ` AND listing_id IN (${placeholderList(params, listingIds)})`;
  }
  if (listingIdTable) {
    extraWhereSql += ` AND listing_id IN (SELECT listing_id FROM ${listingIdTable})`;
  }
  if (seenAfter) {
    extraWhereSql += ` AND ${backlogTimeField} >= ${placeholder(params, seenAfter)}`;
  }
  if (seenBefore) {
    extraWhereSql += ` AND ${backlogTimeField} <= ${placeholder(params, seenBefore)}`;
  }

  return {
    statusWhereSql,
    extraWhereSql,
    params,
    orderSql: buildBacklogClaimOrderSql(backlogOrder, backlogTimeField),
    backlogOrder,
    backlogTimeField,
  };
}

function unixSecondsFromIso(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

async function writeListedTimeNormalization(pool, listingId, listedAgo, anchorIso, range) {
  const normalizedAt = range?.normalizedAt || new Date().toISOString();
  const anchorUnix = range?.anchorUnix ?? unixSecondsFromIso(anchorIso);
  await pool.query(`
    UPDATE homepage_listings
    SET
      detail_listed_at_raw = $1,
      detail_listed_at_earliest_unix = $2,
      detail_listed_at_latest_unix = $3,
      detail_listed_at_anchor_unix = $4,
      detail_listed_at_language = $5,
      detail_listed_at_unit = $6,
      detail_listed_at_value = $7,
      detail_listed_at_confidence = $8,
      detail_listed_at_source = $9,
      detail_listed_at_normalized_at = $10
    WHERE listing_id = $11
  `, [
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
  ]);
}

async function normalizeHomepageListingListedTime(pool, listingId) {
  const row = await queryOne(pool, `
    SELECT listing_id, detail_listed_ago, first_seen_at, last_seen_at
    FROM homepage_listings
    WHERE listing_id = $1
  `, [String(listingId)]);
  if (!row) return { status: 'missing', listingId: String(listingId) };

  const listedAgo = String(row.detail_listed_ago || '').trim();
  if (!listedAgo) {
    return { status: 'skipped', reason: 'empty_detail_listed_ago', listingId: row.listing_id };
  }

  const anchorIso = row.first_seen_at || row.last_seen_at || '';
  const range = listedAgoToUnixRange(listedAgo, anchorIso);
  await writeListedTimeNormalization(pool, row.listing_id, listedAgo, anchorIso, range);
  return {
    status: range ? 'normalized' : 'unparsed',
    listingId: row.listing_id,
    listedAgo,
    range,
  };
}
async function getHomepageListingFromClient(client, listingId) {
  const row = await queryOne(client, `
    SELECT *
    FROM homepage_listings
    WHERE listing_id = $1
  `, [String(listingId || '').trim()]);
  return normalizeHomepageListingRow(row);
}

function createMarketplaceHomepageListingsPostgresStore(options = {}) {
  const pool = createPoolFromOptions(options);
  const mediaStore = options.mediaStore || createMarketplaceListingMediaPostgresStore({ pool });
  const eventStore = options.eventStore || createMarketplaceWorkerEventsPostgresStore({ pool });
  const nowIso = typeof options.nowIso === 'function' ? options.nowIso : () => new Date().toISOString();

  return {
    dialect: 'postgres',
    pool,

    async upsertHomepageListingWithStatus(listing = {}, options = {}) {
      const now = options.seenAt || options.seen_at || nowIso();
      const href = canonicalizeListingUrl(listing.href);
      const listingId = String(listing.listingId || listing.listing_id || extractListingId(href) || href || '').trim();
      const rank = Number.isFinite(listing.rank) ? listing.rank : null;
      const cardTitle = String(listing.title || '').trim();
      const cardText = String(listing.text || '').trim();
      const cardPrice = String(listing.price || listing.detailPrice || listing.detail_price || '').trim();
      const source = normalizeKeyword(options.source || listing.source || 'homepage') || 'homepage';
      const sourceKeyword = normalizeKeyword(
        options.sourceKeyword
        || options.source_keyword
        || listing.sourceKeyword
        || listing.source_keyword,
      );
      const previousRow = await this.getHomepageListing(listingId);
      const previousComparable = previousRow ? summarizeHomepageListingComparable(previousRow) : null;
      const nextComparable = summarizeHomepageListingComparable({ href, title: cardTitle, text: cardText });
      const rawCardJson = serializeJson({
        ...listing,
        href,
        listingId,
        rank,
        source,
        sourceKeyword,
      });

      await pool.query(`
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
          detail_price,
          detail_last_error
        ) VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          'pending',
          $11,
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
          detail_price = CASE
            WHEN excluded.detail_price = ''
              THEN homepage_listings.detail_price
            WHEN homepage_listings.detail_status IN ('done', 'processing', 'sold', 'pending_sale')
              AND homepage_listings.detail_price <> ''
              THEN homepage_listings.detail_price
            ELSE excluded.detail_price
          END,
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
      `, [
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
        cardPrice,
      ]);

      if (mediaStore && typeof mediaStore.upsertListingMediaForListing === 'function') {
        await mediaStore.upsertListingMediaForListing(listingId, listing.photos || listing.media || [], {
          seenAt: now,
          source,
        });
      }

      const row = await this.getHomepageListing(listingId);
      const sameContent = Boolean(
        previousComparable
        && previousComparable.href === nextComparable.href
        && previousComparable.cardTitle === nextComparable.cardTitle
        && previousComparable.cardText === nextComparable.cardText,
      );
      const rankChanged = Boolean(previousRow && previousRow.last_seen_rank !== rank);

      return {
        row,
        previousRow,
        outcome: previousRow ? (sameContent && !rankChanged ? 'existing_same' : 'existing_updated') : 'new',
        sameContent,
        rankChanged,
      };
    },

    async upsertHomepageListing(listing = {}, options = {}) {
      return (await this.upsertHomepageListingWithStatus(listing, options)).row;
    },

    async getHomepageListing(listingId) {
      const row = await queryOne(pool, `
        SELECT *
        FROM homepage_listings
        WHERE listing_id = $1
      `, [String(listingId || '').trim()]);
      return normalizeHomepageListingRow(row);
    },

    async listBacklogCandidates(options = {}) {
      const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(options.limit, 200)) : 25;
      const parts = buildBacklogCandidateQueryParts(options);
      const params = [...parts.params];
      const rows = await queryRows(pool, `
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
        LIMIT ${placeholder(params, limit)}
      `, params);
      return rows.map(normalizeHomepageListingRow);
    },

    async claimNextPendingHomepageListing(options = {}) {
      const now = options.claimedAt || options.claimed_at || nowIso();
      const workerId = String(options.workerId || options.worker_id || `worker-${process.pid}`);
      const parts = buildBacklogCandidateQueryParts(options);
      const claimed = await withTransaction(pool, async (client) => {
        const candidate = await queryOne(client, `
          SELECT listing_id
          FROM homepage_listings
          WHERE ${parts.statusWhereSql}
            ${parts.extraWhereSql}
          ORDER BY
            ${parts.orderSql}
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        `, parts.params);

        if (!candidate) return null;

        await client.query(`
          UPDATE homepage_listings
          SET
            detail_status = 'processing',
            detail_attempts = detail_attempts + 1,
            detail_started_at = $1,
            claimed_by = $2,
            detail_last_error = ''
          WHERE listing_id = $3
        `, [now, workerId, candidate.listing_id]);

        return getHomepageListingFromClient(client, candidate.listing_id);
      });

      if (claimed && typeof options.startEventBuilder === 'function' && eventStore && typeof eventStore.appendListingEvent === 'function') {
        await eventStore.appendListingEvent(options.startEventBuilder(claimed));
      }
      return claimed;
    },

    async markHomepageListingProcessed(listingId, detailRecord = {}, options = {}) {
      const completedAt = options.completedAt || options.completed_at || nowIso();
      const listingContent = detailRecord.listingContent || {};
      const detailJson = serializeJson(detailRecord);
      await pool.query(`
        UPDATE homepage_listings
        SET
          detail_status = 'done',
          detail_last_error = '',
          detail_completed_at = $1,
          claimed_by = '',
          detail_title = $2,
          detail_price = $3,
          detail_location = $4,
          detail_condition = $5,
          detail_listed_ago = $6,
          detail_seller_name = $7,
          detail_json = $8,
          screenshot_path = $9,
          snapshot_path = $10
        WHERE listing_id = $11
      `, [
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
        String(listingId),
      ]);

      await normalizeHomepageListingListedTime(pool, listingId);
      return this.getHomepageListing(listingId);
    },

    async markHomepageListingInactive(listingId, status, detailRecord = {}, reason = '', options = {}) {
      const inactiveStatus = status === 'pending_sale' ? 'pending_sale' : 'sold';
      const completedAt = options.completedAt || options.completed_at || nowIso();
      const listingContent = detailRecord.listingContent || {};
      const detailLastError = reason || listingContent.availabilityReason || inactiveStatus;
      const detailJson = serializeJson(detailRecord);
      await pool.query(`
        UPDATE homepage_listings
        SET
          detail_status = $1,
          detail_last_error = $2,
          detail_completed_at = $3,
          claimed_by = '',
          detail_title = $4,
          detail_price = $5,
          detail_location = $6,
          detail_condition = $7,
          detail_listed_ago = $8,
          detail_seller_name = $9,
          detail_json = $10,
          screenshot_path = $11,
          snapshot_path = $12
        WHERE listing_id = $13
      `, [
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
        String(listingId),
      ]);

      await normalizeHomepageListingListedTime(pool, listingId);
      return this.getHomepageListing(listingId);
    },
    async markHomepageListingFailed(listingId, error, options = {}) {
      const completedAt = options.completedAt || options.completed_at || nowIso();
      await pool.query(`
        UPDATE homepage_listings
        SET
          detail_status = 'error',
          detail_last_error = $1,
          detail_completed_at = $2,
          claimed_by = ''
        WHERE listing_id = $3
      `, [String(error || 'Unknown processing error').trim(), completedAt, String(listingId)]);
      return this.getHomepageListing(listingId);
    },

    async releaseHomepageListingClaim(listingId, options = {}) {
      const completedAt = options.completedAt || options.completed_at || nowIso();
      const workerId = String(options.workerId || options.worker_id || '').trim();
      const nextStatus = String(options.nextStatus || options.next_status || 'pending').trim();
      const reason = String(options.reason || 'claim released').trim();
      const decrementAttempts = options.decrementAttempts === true;
      if (!['pending', 'error'].includes(nextStatus)) {
        throw new Error(`Unsupported released listing status: ${nextStatus}`);
      }
      const result = await pool.query(`
        UPDATE homepage_listings
        SET
          detail_status = $1,
          detail_last_error = $2,
          detail_completed_at = $3,
          claimed_by = '',
          detail_attempts = CASE
            WHEN $4 THEN GREATEST(detail_attempts - 1, 0)
            ELSE detail_attempts
          END
        WHERE listing_id = $5
          AND detail_status = 'processing'
          AND ($6 = '' OR claimed_by = $7)
      `, [
        nextStatus,
        reason,
        completedAt,
        decrementAttempts,
        String(listingId),
        workerId,
        workerId,
      ]);
      return {
        changed: (result.rowCount || 0) > 0,
        listing: await this.getHomepageListing(listingId),
      };
    },

    async listStaleProcessingHomepageListings(options = {}) {
      const staleAfterSeconds = Number.isFinite(options.staleAfterSeconds)
        ? Math.max(1, options.staleAfterSeconds)
        : 30 * 60;
      const limit = Number.isFinite(options.limit)
        ? Math.max(1, Math.min(options.limit, 1000))
        : 100;
      const now = options.now || nowIso();
      const staleBefore = new Date(Date.parse(now) - (staleAfterSeconds * 1000)).toISOString();
      const rows = await queryRows(pool, `
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
          AND detail_started_at <= $1
        ORDER BY detail_started_at ASC, listing_id ASC
        LIMIT $2
      `, [staleBefore, limit]);
      return rows.map(normalizeHomepageListingRow);
    },

    async recoverStaleProcessingHomepageListings(options = {}) {
      const dryRun = options.dryRun !== false;
      const nextStatus = String(options.nextStatus || options.next_status || 'pending').trim();
      const recoveredAt = options.recoveredAt || options.recovered_at || options.now || nowIso();
      const reason = String(options.reason || 'stale_processing_recovery').trim();
      if (!['pending', 'error'].includes(nextStatus)) {
        throw new Error(`Unsupported stale processing recovery status: ${nextStatus}`);
      }
      const rows = await this.listStaleProcessingHomepageListings(options);
      const recovered = [];
      if (!dryRun) {
        for (const row of rows) {
          if (eventStore && typeof eventStore.appendListingEvent === 'function') {
            await eventStore.appendListingEvent({
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
          }
          const release = await this.releaseHomepageListingClaim(row.listing_id, {
            nextStatus,
            reason,
            completedAt: recoveredAt,
            decrementAttempts: true,
          });
          if (release.changed) recovered.push(release.listing);
        }
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
    },
    async getHomepageListingCounts() {
      const rows = await queryRows(pool, `
        SELECT detail_status, COUNT(*)::BIGINT AS count
        FROM homepage_listings
        GROUP BY detail_status
      `);
      return rows.reduce((accumulator, row) => ({
        ...accumulator,
        [row.detail_status]: Number.parseInt(row.count, 10) || 0,
      }), {
        pending: 0,
        processing: 0,
        done: 0,
        error: 0,
        sold: 0,
        pending_sale: 0,
      });
    },

    async close() {
      if (typeof pool.end === 'function') await pool.end();
    },
  };
}

module.exports = {
  createMarketplaceHomepageListingsPostgresStore,
  canonicalizeListingUrl,
  extractListingId,
  normalizeHomepageListingRow,
  summarizeHomepageListingComparable,
  normalizeHomepageListingListedTime,
};
