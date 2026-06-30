const crypto = require('crypto');

function normalizeKeyword(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

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

function normalizeNumberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function boundedMediaLimit(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(parsed, 100)) : 50;
}

function normalizeListingMediaItems(items = []) {
  return (Array.isArray(items) ? items : [])
    .map((item, index) => {
      const sourceUrl = String(item.sourceUrl || item.source_url || item.src || item.url || '').trim();
      const artifactPath = String(item.artifactPath || item.artifact_path || item.screenshotPath || item.screenshot_path || '').trim();
      if (!sourceUrl && !artifactPath) return null;
      const mediaKey = String(item.mediaKey || item.media_key || '').trim()
        || crypto.createHash('sha1').update(`${sourceUrl}\n${artifactPath}`).digest('hex');
      return {
        mediaKey,
        mediaType: normalizeKeyword(item.mediaType || item.media_type || 'image') || 'image',
        source: normalizeKeyword(item.source || ''),
        sourceUrl,
        artifactPath,
        altText: String(item.altText || item.alt_text || item.alt || '').trim(),
        width: normalizeNumberOrNull(item.width),
        height: normalizeNumberOrNull(item.height),
        position: Number.isFinite(Number(item.position)) ? Number(item.position) : index,
        metadata: item.metadata || item.metadata_json || {},
      };
    })
    .filter(Boolean);
}

function normalizeListingMediaRow(row) {
  if (!row) return null;
  return {
    listing_id: row.listing_id,
    media_key: row.media_key,
    media_type: row.media_type,
    source: row.source || '',
    source_url: row.source_url || '',
    artifact_path: row.artifact_path || '',
    alt_text: row.alt_text || '',
    width: row.width,
    height: row.height,
    position: row.position || 0,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    metadata: parseJsonObject(row.metadata_json),
  };
}

function requirePgPool() {
  try {
    return require('pg').Pool;
  } catch (error) {
    const wrapped = new Error('PostgreSQL listing media store requires the pg package or an injected pool.');
    wrapped.cause = error;
    wrapped.code = 'missing_pg_dependency';
    throw wrapped;
  }
}

function createPoolFromOptions(options = {}) {
  if (options.pool) return options.pool;
  const connectionString = options.connectionString
    || process.env.MARKETPLACE_LISTING_MEDIA_POSTGRES_URL
    || process.env.MARKETPLACE_POSTGRES_URL
    || process.env.DATABASE_URL
    || '';
  if (!connectionString) {
    const error = new Error('Missing PostgreSQL connection string. Set MARKETPLACE_LISTING_MEDIA_POSTGRES_URL, MARKETPLACE_POSTGRES_URL, or pass connectionString.');
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

function createMarketplaceListingMediaPostgresStore(options = {}) {
  const pool = createPoolFromOptions(options);
  const nowIso = typeof options.nowIso === 'function' ? options.nowIso : () => new Date().toISOString();

  return {
    dialect: 'postgres',
    pool,

    async upsertListingMediaForListing(listingId, items = [], options = {}) {
      const normalizedListingId = String(listingId || '').trim();
      const mediaItems = normalizeListingMediaItems(items);
      if (!normalizedListingId || mediaItems.length === 0) return [];
      const seenAt = options.seenAt || options.seen_at || nowIso();
      const sourceFallback = normalizeKeyword(options.source || '');

      for (const item of mediaItems) {
        await pool.query(`
          INSERT INTO listing_media (
            listing_id,
            media_key,
            media_type,
            source,
            source_url,
            artifact_path,
            alt_text,
            width,
            height,
            position,
            first_seen_at,
            last_seen_at,
            metadata_json
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          ON CONFLICT(listing_id, media_key) DO UPDATE SET
            media_type = excluded.media_type,
            source = excluded.source,
            source_url = excluded.source_url,
            artifact_path = excluded.artifact_path,
            alt_text = excluded.alt_text,
            width = excluded.width,
            height = excluded.height,
            position = excluded.position,
            last_seen_at = excluded.last_seen_at,
            metadata_json = excluded.metadata_json
        `, [
          normalizedListingId,
          item.mediaKey,
          item.mediaType,
          item.source || sourceFallback,
          item.sourceUrl,
          item.artifactPath,
          item.altText,
          item.width,
          item.height,
          item.position,
          seenAt,
          seenAt,
          serializeJson(item.metadata || {}),
        ]);
      }

      return this.listListingMedia(normalizedListingId);
    },

    async listListingMedia(listingId, options = {}) {
      const limit = boundedMediaLimit(options.limit);
      const rows = await queryRows(pool, `
        SELECT *
        FROM listing_media
        WHERE listing_id = $1
        ORDER BY position ASC, last_seen_at DESC
        LIMIT $2
      `, [String(listingId || '').trim(), limit]);
      return rows.map(normalizeListingMediaRow);
    },

    async close() {
      if (typeof pool.end === 'function') await pool.end();
    },
  };
}

module.exports = {
  createMarketplaceListingMediaPostgresStore,
  normalizeListingMediaItems,
  normalizeListingMediaRow,
  boundedMediaLimit,
};
