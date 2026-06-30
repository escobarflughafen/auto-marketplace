const crypto = require('crypto');
const { canonicalizeListingUrl } = require('./marketplace-homepage-listings-postgres-store');

function serializeJson(value) { return JSON.stringify(value ?? {}, null, 2); }

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function normalizeKeyword(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }

function integerValue(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeDocumentId(value, fallback = 'history') {
  const text = String(value || fallback).trim().toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
  return text || fallback;
}

function normalizePurchaseHistoryDocumentRow(row) {
  if (!row) return null;
  return {
    document_id: row.document_id,
    name: row.name,
    description: row.description || '',
    created_at: row.created_at,
    updated_at: row.updated_at,
    row_count: integerValue(row.row_count, 0),
  };
}

function normalizePurchaseHistoryRow(row) {
  if (!row) return null;
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
  if (normalized === 'same_listing' || normalized === 'transaction' || normalized === 'exact') return 'same_listing';
  return 'same_model';
}

function normalizePurchaseHistoryListingLinkRow(row) {
  if (!row) return null;
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

function normalizePurchaseHistoryEventRow(row) {
  if (!row) return null;
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

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizePurchaseHistoryMatchQueueRow(row) {
  if (!row) return null;
  return {
    document_id: row.document_id,
    record_id: row.record_id,
    listing_id: row.listing_id,
    status: row.status,
    listing_price_cad: numberValue(row.listing_price_cad),
    purchase_price_cad: numberValue(row.purchase_price_cad),
    threshold_price_cad: numberValue(row.threshold_price_cad),
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

function purchaseHistoryRowProjection(row) {
  const data = row && typeof row === 'object' ? row : {};
  const recordId = String(data.record_id || data.recordId || '').trim();
  if (!recordId) throw new Error('purchase history row requires record_id');
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
    data: { ...data, record_id: recordId },
  };
}

function normalizeInventoryStatus(data = {}) {
  const status = String(data.inventory_status || data.inventoryStatus || '').trim().toLowerCase();
  if (status === 'hold' || status === 'listed' || status === 'sold') return status;
  const outcome = String(data.outcome || '').trim();
  if (data.decision === 'sold' || data.sold_at || data.sold_price_cad || outcome === 'sold_profitable' || outcome === 'sold_break_even' || outcome === 'loss') return 'sold';
  if (data.listed_at || data.list_price_cad) return 'listed';
  return 'hold';
}

function purchaseHistoryLifecycleEvents(data = {}) {
  const status = normalizeInventoryStatus(data);
  const addedAt = String(data.purchase_at || data.decision_at || data.created_at || '').trim();
  const listedAt = String(data.listed_at || '').trim();
  const soldAt = String(data.sold_at || '').trim();
  const events = [{ eventType: 'inventory_added', eventAt: addedAt || new Date().toISOString() }];
  if (status === 'listed' || status === 'sold' || listedAt) events.push({ eventType: 'listed', eventAt: listedAt || addedAt || new Date().toISOString() });
  if (status === 'sold' || soldAt || data.sold_price_cad) events.push({ eventType: 'sold', eventAt: soldAt || listedAt || addedAt || new Date().toISOString() });
  return events;
}

function requirePgPool() {
  try { return require('pg').Pool; } catch (error) { const wrapped = new Error('PostgreSQL purchase history store requires the pg package or an injected pool.'); wrapped.cause = error; wrapped.code = 'missing_pg_dependency'; throw wrapped; }
}

function createPoolFromOptions(options = {}) {
  if (options.pool) return options.pool;
  const connectionString = options.connectionString || process.env.MARKETPLACE_PURCHASE_HISTORY_POSTGRES_URL || process.env.MARKETPLACE_POSTGRES_URL || process.env.DATABASE_URL || '';
  if (!connectionString) { const error = new Error('Missing PostgreSQL connection string. Set MARKETPLACE_PURCHASE_HISTORY_POSTGRES_URL, MARKETPLACE_POSTGRES_URL, or pass connectionString.'); error.code = 'missing_postgres_connection_string'; throw error; }
  const Pool = requirePgPool();
  return new Pool({ connectionString });
}

async function queryRows(pool, sql, params = []) { const result = await pool.query(sql, params); return result.rows || []; }
async function queryOne(pool, sql, params = []) { const rows = await queryRows(pool, sql, params); return rows[0] || null; }

async function uniquePurchaseHistoryDocumentId(store, name) {
  const base = normalizeDocumentId(name || 'history');
  let candidate = base;
  let suffix = 2;
  while (await store.getPurchaseHistoryDocument(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

async function withTransaction(pool, callback) {
  const client = typeof pool.connect === 'function' ? await pool.connect() : pool;
  try { await client.query('BEGIN'); const result = await callback(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { if (client !== pool && typeof client.release === 'function') client.release(); }
}

function queueSelectSql(whereSql, suffixSql = '') {
  return `
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
    ${whereSql}
    ${suffixSql}
  `;
}

function pushQueueFilters(options = {}, params = []) {
  const filters = [];
  const status = String(options.status || 'queued').trim();
  if (status && status !== 'all') { params.push(status); filters.push(`q.status = $${params.length}`); }
  if (options.listingId || options.listing_id) { params.push(String(options.listingId || options.listing_id).trim()); filters.push(`q.listing_id = $${params.length}`); }
  if (options.documentId || options.document_id) { params.push(String(options.documentId || options.document_id).trim()); filters.push(`q.document_id = $${params.length}`); }
  if (options.recordId || options.record_id) { params.push(String(options.recordId || options.record_id).trim()); filters.push(`q.record_id = $${params.length}`); }
  if (options.resolvedOnly || options.resolved_only) filters.push("(l.detail_status = 'done' OR l.detail_completed_at IS NOT NULL OR NULLIF(l.snapshot_path, '') IS NOT NULL)");
  return filters;
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

async function appendPurchaseHistoryMatchEvent(client, event = {}) {
  const eventAt = event.eventAt || event.event_at || new Date().toISOString();
  const documentId = String(event.documentId || event.document_id || '').trim();
  const recordId = String(event.recordId || event.record_id || '').trim();
  const listingId = String(event.listingId || event.listing_id || '').trim();
  const eventType = normalizeKeyword(event.eventType || event.event_type || 'recommendation_event');
  if (!documentId || !recordId || !listingId) throw new Error('recommendation event requires documentId, recordId, and listingId');
  const eventId = String(event.eventId || event.event_id || buildPurchaseHistoryMatchEventId(eventAt, documentId, recordId, listingId, eventType));
  await client.query(`
    INSERT INTO purchase_history_match_events (event_id, document_id, record_id, listing_id, event_type, event_at, actor, reason, content_json)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  `, [eventId, documentId, recordId, listingId, eventType, eventAt, String(event.actor || 'viewer').trim(), String(event.reason || '').trim(), serializeJson(event.content || {})]);
  return eventId;
}

function createMarketplacePurchaseHistoryPostgresStore(options = {}) {
  const pool = createPoolFromOptions(options);
  const nowIso = typeof options.nowIso === 'function' ? options.nowIso : () => new Date().toISOString();

  const store = {
    dialect: 'postgres',
    pool,

    async createPurchaseHistoryDocument(document = {}) {
      const now = document.createdAt || document.created_at || nowIso();
      const name = String(document.name || 'Purchase History').trim() || 'Purchase History';
      const requestedId = String(document.documentId || document.document_id || '').trim();
      const documentId = requestedId || await uniquePurchaseHistoryDocumentId(this, name);
      await pool.query(`
        INSERT INTO purchase_history_documents (document_id, name, description, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT(document_id) DO UPDATE SET
          name = excluded.name,
          description = excluded.description,
          updated_at = excluded.updated_at
      `, [documentId, name, String(document.description || '').trim(), now, document.updatedAt || document.updated_at || now]);
      return this.getPurchaseHistoryDocument(documentId);
    },

    async listPurchaseHistoryDocuments() {
      const rows = await queryRows(pool, `
        SELECT documents.*, COUNT(rows.record_id)::BIGINT AS row_count
        FROM purchase_history_documents documents
        LEFT JOIN purchase_history_rows rows ON rows.document_id = documents.document_id
        GROUP BY documents.document_id
        ORDER BY documents.updated_at DESC, documents.created_at DESC
      `);
      return rows.map(normalizePurchaseHistoryDocumentRow);
    },

    async getPurchaseHistoryDocument(documentId) {
      const row = await queryOne(pool, `
        SELECT documents.*, COUNT(rows.record_id)::BIGINT AS row_count
        FROM purchase_history_documents documents
        LEFT JOIN purchase_history_rows rows ON rows.document_id = documents.document_id
        WHERE documents.document_id = $1
        GROUP BY documents.document_id
      `, [String(documentId || '').trim()]);
      return normalizePurchaseHistoryDocumentRow(row);
    },

    async deletePurchaseHistoryDocument(documentId) {
      const id = String(documentId || '').trim();
      if (!id) throw new Error('deletePurchaseHistoryDocument requires documentId');
      return withTransaction(pool, async (client) => {
        await client.query('DELETE FROM purchase_history_listing_links WHERE document_id = $1', [id]);
        await client.query('DELETE FROM purchase_history_events WHERE document_id = $1', [id]);
        await client.query('DELETE FROM purchase_history_rows WHERE document_id = $1', [id]);
        const result = await client.query('DELETE FROM purchase_history_documents WHERE document_id = $1', [id]);
        return { deleted: result.rowCount || 0 };
      });
    },

    async getPurchaseHistoryRow(documentId, recordId) {
      const row = await queryOne(pool, `
        SELECT * FROM purchase_history_rows
        WHERE document_id = $1 AND record_id = $2
      `, [String(documentId || '').trim(), String(recordId || '').trim()]);
      return normalizePurchaseHistoryRow(row);
    },

    async appendPurchaseHistoryEvent(event = {}, client = pool) {
      const documentId = String(event.documentId || event.document_id || '').trim();
      const recordId = String(event.recordId || event.record_id || '').trim();
      const eventType = String(event.eventType || event.event_type || '').trim();
      if (!documentId || !recordId || !eventType) throw new Error('purchase history event requires documentId, recordId, and eventType');
      const createdAt = event.createdAt || event.created_at || nowIso();
      const eventAt = String(event.eventAt || event.event_at || createdAt).trim();
      const eventId = String(event.eventId || event.event_id || `${documentId}:${recordId}:${eventType}`).trim();
      await client.query(`
        INSERT INTO purchase_history_events (event_id, document_id, record_id, event_type, event_at, data_json, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT(event_id) DO NOTHING
      `, [eventId, documentId, recordId, eventType, eventAt, serializeJson(event.data || {}), createdAt]);
    },

    async upsertPurchaseHistoryRows(documentId, rows, options = {}) {
      const id = String(documentId || '').trim();
      if (!id) throw new Error('upsertPurchaseHistoryRows requires documentId');
      const document = await this.getPurchaseHistoryDocument(id);
      if (!document) throw new Error(`Unknown purchase history document: ${id}`);
      const incomingRows = Array.isArray(rows) ? rows : [rows];
      const now = options.updatedAt || options.updated_at || nowIso();
      return withTransaction(pool, async (client) => {
        let inserted = 0; let updated = 0;
        for (const row of incomingRows) {
          const projection = purchaseHistoryRowProjection(row);
          const previous = await queryOne(client, 'SELECT record_id, data_json FROM purchase_history_rows WHERE document_id = $1 AND record_id = $2', [id, projection.recordId]);
          await client.query(`
            INSERT INTO purchase_history_rows (document_id, record_id, canonical_key, title, category, subcategory, brand, model, mount, purchase_at, sold_at, outcome, data_json, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
            ON CONFLICT(document_id, record_id) DO UPDATE SET
              canonical_key = excluded.canonical_key, title = excluded.title, category = excluded.category, subcategory = excluded.subcategory,
              brand = excluded.brand, model = excluded.model, mount = excluded.mount, purchase_at = excluded.purchase_at, sold_at = excluded.sold_at,
              outcome = excluded.outcome, data_json = excluded.data_json, updated_at = excluded.updated_at
          `, [id, projection.recordId, projection.canonicalKey, projection.title, projection.category, projection.subcategory, projection.brand, projection.model, projection.mount, projection.purchaseAt, projection.soldAt, projection.outcome, serializeJson(projection.data), now, now]);
          if (previous) updated += 1; else inserted += 1;
          const previousData = previous ? parseJsonObject(previous.data_json) : null;
          const previousTypes = new Set(purchaseHistoryLifecycleEvents(previousData || {}).map((item) => item.eventType));
          for (const lifecycleEvent of purchaseHistoryLifecycleEvents(projection.data)) {
            if (previousData && previousTypes.has(lifecycleEvent.eventType)) continue;
            await this.appendPurchaseHistoryEvent({ documentId: id, recordId: projection.recordId, eventType: lifecycleEvent.eventType, eventAt: lifecycleEvent.eventAt, createdAt: now, data: { title: projection.title, inventory_status: normalizeInventoryStatus(projection.data), price_cad: projection.data.sold_price_cad || projection.data.list_price_cad || '' } }, client);
          }
        }
        await client.query('UPDATE purchase_history_documents SET updated_at = $1 WHERE document_id = $2', [now, id]);
        return { document: await this.getPurchaseHistoryDocument(id), inserted, updated, total: incomingRows.length };
      });
    },

    async listPurchaseHistoryRows(documentId, options = {}) {
      const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(options.limit, 10000)) : 10000;
      const rows = await queryRows(pool, `
        SELECT * FROM purchase_history_rows
        WHERE document_id = $1
        ORDER BY COALESCE(purchase_at, '') DESC, updated_at DESC, record_id DESC
        LIMIT $2
      `, [String(documentId || '').trim(), limit]);
      return rows.map(normalizePurchaseHistoryRow);
    },

    async listPurchaseHistoryListingLinks(options = {}) {
      const documentId = String(options.documentId || options.document_id || '').trim();
      const recordId = String(options.recordId || options.record_id || '').trim();
      const listingId = String(options.listingId || options.listing_id || '').trim();
      const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(options.limit, 10000)) : 10000;
      const filters = [];
      const params = [];
      if (documentId) { params.push(documentId); filters.push(`links.document_id = $${params.length}`); }
      if (recordId) { params.push(recordId); filters.push(`links.record_id = $${params.length}`); }
      if (listingId) { params.push(listingId); filters.push(`links.listing_id = $${params.length}`); }
      params.push(limit);
      const rows = await queryRows(pool, `
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
        ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
        ORDER BY links.linked_at DESC, links.listing_id ASC
        LIMIT $${params.length}
      `, params);
      return rows.map(normalizePurchaseHistoryListingLinkRow);
    },

    async upsertPurchaseHistoryListingLink(link = {}, options = {}) {
      const documentId = String(link.documentId || link.document_id || '').trim();
      const recordId = String(link.recordId || link.record_id || '').trim();
      const listingId = String(link.listingId || link.listing_id || '').trim();
      const href = canonicalizeListingUrl(link.href || '');
      const relationshipType = normalizePurchaseHistoryListingRelationship(link.relationshipType || link.relationship_type);
      if (!documentId || !recordId || !listingId) throw new Error('purchase history listing link requires documentId, recordId, and listingId');
      const row = await this.getPurchaseHistoryRow(documentId, recordId);
      if (!row) throw new Error(`Unknown purchase history record: ${recordId}`);
      const listing = await queryOne(pool, 'SELECT * FROM homepage_listings WHERE listing_id = $1', [listingId]);
      if (!listing) throw new Error(`Unknown listing: ${listingId}`);
      const now = options.linkedAt || options.linked_at || nowIso();
      await pool.query(`
        INSERT INTO purchase_history_listing_links (document_id, record_id, listing_id, relationship_type, href, note, linked_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT(document_id, record_id, listing_id, relationship_type) DO UPDATE SET
          href = excluded.href,
          note = excluded.note,
          updated_at = excluded.updated_at
      `, [documentId, recordId, listingId, relationshipType, href || listing.href || '', String(link.note || '').trim(), now, now]);
      await this.appendPurchaseHistoryEvent({
        documentId,
        recordId,
        eventType: 'listing_linked',
        eventAt: now,
        createdAt: now,
        eventId: `${documentId}:${recordId}:listing_linked:${relationshipType}:${listingId}:${now}`,
        data: { listing_id: listingId, href: href || listing.href || '', relationship_type: relationshipType, title: row.title },
      });
      return (await this.listPurchaseHistoryListingLinks({ documentId, recordId, listingId })).find((item) => item.relationship_type === relationshipType) || null;
    },
    async listPurchaseHistoryMatchQueue(options = {}) {
      const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(options.limit, 1000)) : 200;
      const offset = Number.isFinite(options.offset) ? Math.max(0, options.offset) : 0;
      const params = [];
      const filters = pushQueueFilters(options, params);
      params.push(limit);
      const limitPlaceholder = `$${params.length}`;
      params.push(offset);
      const offsetPlaceholder = `$${params.length}`;
      const rows = await queryRows(pool, queueSelectSql(filters.length ? `WHERE ${filters.join(' AND ')}` : '', `ORDER BY q.updated_at DESC LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}`), params);
      return rows.map(normalizePurchaseHistoryMatchQueueRow);
    },

    async listRandomPurchaseHistoryMatches(options = {}) {
      const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(options.limit, 10)) : 8;
      const statuses = Array.isArray(options.statuses) && options.statuses.length ? options.statuses.map((status) => String(status || '').trim()).filter(Boolean) : ['queued'];
      const filters = [];
      const params = [];
      if (statuses.length) {
        const placeholders = statuses.map((status) => { params.push(status); return `$${params.length}`; });
        filters.push(`q.status IN (${placeholders.join(', ')})`);
      }
      if (options.resolvedOnly || options.resolved_only) filters.push("(l.detail_status = 'done' OR l.detail_completed_at IS NOT NULL OR NULLIF(l.snapshot_path, '') IS NOT NULL)");
      params.push(limit);
      const rows = await queryRows(pool, queueSelectSql(filters.length ? `WHERE ${filters.join(' AND ')}` : '', `ORDER BY RANDOM() LIMIT $${params.length}`), params);
      return rows.map(normalizePurchaseHistoryMatchQueueRow);
    },

    async countPurchaseHistoryMatchQueue(options = {}) {
      const params = [];
      const filters = pushQueueFilters(options, params);
      const row = await queryOne(pool, `
        SELECT COUNT(*)::BIGINT AS total
        FROM purchase_history_match_queue q
        ${options.resolvedOnly || options.resolved_only ? 'LEFT JOIN homepage_listings l ON l.listing_id = q.listing_id' : ''}
        ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
      `, params);
      return integerValue(row && row.total, 0);
    },

    async updatePurchaseHistoryMatchQueueStatus(match = {}, options = {}) {
      const documentId = String(match.documentId || match.document_id || '').trim();
      const recordId = String(match.recordId || match.record_id || '').trim();
      const listingId = String(match.listingId || match.listing_id || '').trim();
      const status = normalizeKeyword(match.status || '').toLowerCase();
      if (!documentId || !recordId || !listingId) throw new Error('recommendation action requires documentId, recordId, and listingId');
      if (!['saved', 'dismissed', 'queued'].includes(status)) throw new Error(`Unsupported recommendation status: ${status}`);
      const now = options.updatedAt || options.updated_at || new Date().toISOString();
      const reason = String(options.reason || '').trim();
      const eventType = status === 'saved' ? 'recommendation_saved' : status === 'dismissed' ? 'recommendation_dismissed' : 'recommendation_requeued';
      return withTransaction(pool, async (client) => {
        const result = await client.query(`
          UPDATE purchase_history_match_queue
          SET status = $1,
              updated_at = $2,
              note = CASE WHEN $3 = '' THEN note ELSE $4 END
          WHERE document_id = $5
            AND record_id = $6
            AND listing_id = $7
        `, [status, now, reason, reason, documentId, recordId, listingId]);
        if ((result.rowCount || 0) === 0) throw new Error(`Unknown recommendation: ${listingId}`);
        await appendPurchaseHistoryMatchEvent(client, { documentId, recordId, listingId, eventType, eventAt: now, actor: options.actor || 'viewer', reason, content: { status, reason, customReason: options.customReason || '' } });
        return { changes: result.rowCount || 0 };
      });
    },
    async listPurchaseHistoryEvents(options = {}) {
      const documentId = String(options.documentId || options.document_id || '').trim();
      const recordId = String(options.recordId || options.record_id || '').trim();
      const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(options.limit, 10000)) : 1000;
      const filters = []; const params = [];
      if (documentId) { params.push(documentId); filters.push(`document_id = $${params.length}`); }
      if (recordId) { params.push(recordId); filters.push(`record_id = $${params.length}`); }
      params.push(limit);
      const rows = await queryRows(pool, `
        SELECT * FROM purchase_history_events
        ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
        ORDER BY event_at DESC, created_at DESC
        LIMIT $${params.length}
      `, params);
      return rows.map(normalizePurchaseHistoryEventRow);
    },

    async close() { if (typeof pool.end === 'function') await pool.end(); },
  };
  return store;
}

module.exports = {
  createMarketplacePurchaseHistoryPostgresStore,
  normalizeDocumentId,
  normalizePurchaseHistoryDocumentRow,
  normalizePurchaseHistoryRow,
  normalizePurchaseHistoryListingRelationship,
  normalizePurchaseHistoryListingLinkRow,
  normalizePurchaseHistoryEventRow,
  normalizePurchaseHistoryMatchQueueRow,
  purchaseHistoryRowProjection,
  normalizeInventoryStatus,
  purchaseHistoryLifecycleEvents,
  uniquePurchaseHistoryDocumentId,
};
