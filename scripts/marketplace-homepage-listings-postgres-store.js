const { createMarketplaceListingMediaPostgresStore } = require('./marketplace-listing-media-postgres-store');

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

function createMarketplaceHomepageListingsPostgresStore(options = {}) {
  const pool = createPoolFromOptions(options);
  const mediaStore = options.mediaStore || createMarketplaceListingMediaPostgresStore({ pool });
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
};
