const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createMarketplacePurchaseHistoryPostgresStore,
  uniquePurchaseHistoryDocumentId,
  normalizeDocumentId,
  normalizePurchaseHistoryDocumentRow,
  normalizePurchaseHistoryListingRelationship,
  normalizePurchaseHistoryListingLinkRow,
  normalizePurchaseHistoryMatchQueueRow,
  parseCadMoney,
  normalizeMatchText,
  matchPreparedPurchaseHistoryListing,
  purchaseHistoryLifecycleEvents,
} = require('../scripts/marketplace-purchase-history-postgres-store');

function createFakePool(handler) {
  const calls = [];
  return {
    calls,
    ended: false,
    async query(sql, params = []) {
      calls.push({ sql, params });
      const response = handler(sql, params, calls.length);
      if (response && !Array.isArray(response) && (Object.prototype.hasOwnProperty.call(response, 'rows') || Object.prototype.hasOwnProperty.call(response, 'rowCount'))) {
        return { rows: response.rows || [], rowCount: response.rowCount || 0 };
      }
      return { rows: response || [], rowCount: Array.isArray(response) ? response.length : 0 };
    },
    async end() { this.ended = true; },
  };
}

test('normalizes purchase history ids, documents, and lifecycle events', () => {
  assert.equal(normalizeDocumentId('Primary & Imported CSV!'), 'primary-and-imported-csv');
  assert.deepEqual(normalizePurchaseHistoryDocumentRow({ document_id: 'doc-1', name: 'Doc', row_count: '2' }).row_count, 2);
  assert.deepEqual(purchaseHistoryLifecycleEvents({ purchase_at: '2026-05-01', listed_at: '2026-05-03', sold_at: '2026-05-05' }).map((event) => event.eventType), ['inventory_added', 'listed', 'sold']);
  assert.equal(normalizePurchaseHistoryListingRelationship('exact'), 'same_listing');
  assert.equal(normalizePurchaseHistoryListingRelationship('same model'), 'same_model');
  assert.equal(normalizePurchaseHistoryListingLinkRow({ document_id: 'doc-1', record_id: 'trade-001', listing_id: 'listing-1', relationship_type: 'transaction', href: 'https://www.facebook.com/marketplace/item/123/?x=1', listing_href: 'https://www.facebook.com/marketplace/item/123/?x=1' }).href, 'https://www.facebook.com/marketplace/item/123/');
  assert.deepEqual(normalizePurchaseHistoryMatchQueueRow({ document_id: 'doc-1', record_id: 'trade-001', listing_id: 'listing-1', status: 'queued', listing_price_cad: '100', purchase_price_cad: '90', threshold_price_cad: '97.2', matched_terms_json: '[\"nikon\"]', history_data_json: '{\"record_id\":\"trade-001\"}' }).matched_terms, ['nikon']);
  assert.equal(parseCadMoney('CA$ 1,250'), 1250);
  assert.equal(normalizeMatchText('Nikon & FM2!!'), 'nikon and fm2');
  assert.equal(matchPreparedPurchaseHistoryListing({ row: { document_id: 'doc-1', record_id: 'trade-001' }, purchasePrice: 100, terms: ['fm2'] }, { row: { listing_id: 'listing-1' }, listingPrice: 90, haystack: 'nikon fm2 camera' }).listingId, 'listing-1');
});

test('generates suffixed PostgreSQL purchase history document ids', async () => {
  const existing = new Set(['primary-history', 'primary-history-2']);
  const store = {
    async getPurchaseHistoryDocument(documentId) {
      return existing.has(documentId) ? { document_id: documentId } : null;
    },
  };

  assert.equal(await uniquePurchaseHistoryDocumentId(store, 'Primary History'), 'primary-history-3');
});

test('creates and lists PostgreSQL purchase history documents', async () => {
  let inserted = false;
  const pool = createFakePool((sql, params) => {
    if (/INSERT INTO purchase_history_documents/.test(sql)) {
      assert.match(sql, /ON CONFLICT\(document_id\) DO UPDATE SET/);
      assert.deepEqual(params, ['primary-history', 'Primary History', 'Main import', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z']);
      inserted = true;
      return [];
    }
    if (/WHERE documents\.document_id = \$1/.test(sql)) {
      if (!inserted) return [];
      return [{ document_id: 'primary-history', name: 'Primary History', description: 'Main import', created_at: 'c', updated_at: 'u', row_count: '0' }];
    }
    if (/ORDER BY documents\.updated_at DESC/.test(sql)) return [{ document_id: 'primary-history', name: 'Primary History', description: '', created_at: 'c', updated_at: 'u', row_count: '3' }];
    throw new Error('unexpected SQL: ' + sql);
  });
  const store = createMarketplacePurchaseHistoryPostgresStore({ pool });
  const created = await store.createPurchaseHistoryDocument({ name: 'Primary History', description: 'Main import', createdAt: '2026-05-01T00:00:00.000Z' });
  const docs = await store.listPurchaseHistoryDocuments();
  assert.equal(created.document_id, 'primary-history');
  assert.equal(docs[0].row_count, 3);
});

test('upsertPurchaseHistoryRows writes rows and lifecycle events in a transaction', async () => {
  const pool = createFakePool((sql, params) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return [];
    if (/WHERE documents\.document_id = \$1/.test(sql)) return [{ document_id: 'doc-1', name: 'Doc', description: '', created_at: 'c', updated_at: 'u', row_count: '1' }];
    if (/SELECT record_id, data_json/.test(sql)) return [];
    if (/INSERT INTO purchase_history_rows/.test(sql)) {
      assert.equal(params[0], 'doc-1');
      assert.equal(params[1], 'trade-001');
      assert.equal(params[6], 'nikon');
      assert.equal(params[7], 'fm2');
      assert.equal(JSON.parse(params[12]).record_id, 'trade-001');
      return { rows: [], rowCount: 1 };
    }
    if (/INSERT INTO purchase_history_events/.test(sql)) {
      assert.equal(params[1], 'doc-1');
      assert.equal(params[2], 'trade-001');
      assert.ok(['inventory_added', 'listed', 'sold'].includes(params[3]));
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE purchase_history_documents SET updated_at/.test(sql)) return { rows: [], rowCount: 1 };
    throw new Error('unexpected SQL: ' + sql);
  });
  const store = createMarketplacePurchaseHistoryPostgresStore({ pool });
  const result = await store.upsertPurchaseHistoryRows('doc-1', [{
    record_id: 'trade-001', title: 'Nikon FM2', brand: 'NIKON', model: 'FM2', purchase_at: '2026-05-01', listed_at: '2026-05-03', sold_at: '2026-05-05', outcome: 'sold_profitable',
  }], { updatedAt: '2026-05-06T00:00:00.000Z' });
  assert.equal(result.inserted, 1);
  assert.equal(result.updated, 0);
  assert.equal(result.total, 1);
  assert.deepEqual(pool.calls.map((call) => call.sql).filter((sql) => sql === 'BEGIN' || sql === 'COMMIT'), ['BEGIN', 'COMMIT']);
});

test('upserts and lists PostgreSQL purchase history listing links', async () => {
  const pool = createFakePool((sql, params) => {
    if (/SELECT \* FROM purchase_history_rows/.test(sql)) return [{ document_id: 'doc-1', record_id: 'trade-001', title: 'Nikon FM2', data_json: '{}', created_at: 'c', updated_at: 'u' }];
    if (/SELECT \* FROM homepage_listings WHERE listing_id = \$1/.test(sql)) return [{ listing_id: 'listing-1', href: 'https://www.facebook.com/marketplace/item/123/' }];
    if (/INSERT INTO purchase_history_listing_links/.test(sql)) {
      assert.deepEqual(params, ['doc-1', 'trade-001', 'listing-1', 'same_listing', 'https://www.facebook.com/marketplace/item/123/', 'manual link', '2026-05-07T00:00:00.000Z', '2026-05-07T00:00:00.000Z']);
      return { rows: [], rowCount: 1 };
    }
    if (/INSERT INTO purchase_history_events/.test(sql)) {
      assert.equal(params[0], 'doc-1:trade-001:listing_linked:same_listing:listing-1:2026-05-07T00:00:00.000Z');
      assert.equal(params[3], 'listing_linked');
      assert.equal(JSON.parse(params[5]).relationship_type, 'same_listing');
      return { rows: [], rowCount: 1 };
    }
    if (/FROM purchase_history_listing_links links/.test(sql)) {
      assert.deepEqual(params, ['doc-1', 'trade-001', 'listing-1', 10000]);
      assert.match(sql, /links\.document_id = \$1/);
      assert.match(sql, /LIMIT \$4/);
      return [{ document_id: 'doc-1', record_id: 'trade-001', listing_id: 'listing-1', relationship_type: 'transaction', href: 'https://www.facebook.com/marketplace/item/123/', note: 'manual link', linked_at: 'linked', updated_at: 'updated', listing_href: 'https://www.facebook.com/marketplace/item/123/', source: 'facebook', card_title: 'Nikon FM2' }];
    }
    throw new Error('unexpected SQL: ' + sql);
  });
  const store = createMarketplacePurchaseHistoryPostgresStore({ pool });
  const link = await store.upsertPurchaseHistoryListingLink({ documentId: 'doc-1', recordId: 'trade-001', listingId: 'listing-1', relationshipType: 'exact', note: 'manual link' }, { linkedAt: '2026-05-07T00:00:00.000Z' });
  assert.equal(link.relationship_type, 'same_listing');
  assert.equal(link.listing.card_title, 'Nikon FM2');
});

test('scans PostgreSQL purchase history matches and enqueues resolver work', async () => {
  const resolveQueueStore = {
    calls: [],
    async addResolveQueueItems(listingIds, options) {
      this.calls.push({ listingIds, options });
      return { addedCount: listingIds.length };
    },
  };
  const listingRow = { listing_id: 'listing-1', card_title: 'Nikon FM2 camera', card_text: '$90', detail_json: '{}', last_seen_at: 'seen', source: 'facebook', source_keyword: 'nikon' };
  const historyRow = { document_id: 'doc-1', record_id: 'trade-001', canonical_key: '', title: 'Nikon FM2', model: 'fm2', data_json: '{\"purchase_price_cad\":\"100\"}', updated_at: 'updated' };
  const pool = createFakePool((sql, params) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return [];
    if (/SELECT \* FROM homepage_listings WHERE listing_id IN/.test(sql)) {
      assert.deepEqual(params, ['listing-1']);
      assert.match(sql, /\$1/);
      return [listingRow];
    }
    if (/FROM purchase_history_rows ORDER BY updated_at DESC/.test(sql)) {
      assert.deepEqual(params, [5000]);
      return [historyRow];
    }
    if (/SELECT \* FROM homepage_listings WHERE listing_id = \$1/.test(sql)) return [listingRow];
    if (/INSERT INTO purchase_history_match_queue/.test(sql)) {
      assert.equal(params[0], 'doc-1');
      assert.equal(params[1], 'trade-001');
      assert.equal(params[2], 'listing-1');
      assert.equal(params[3], 90);
      assert.equal(params[4], 100);
      assert.deepEqual(JSON.parse(params[6]), ['fm2', 'nikon fm2']);
      assert.equal(params[8], 'facebook');
      return { rows: [], rowCount: 1 };
    }
    throw new Error('unexpected SQL: ' + sql);
  });
  const store = createMarketplacePurchaseHistoryPostgresStore({ pool, resolveQueueStore, nowIso: () => '2026-05-09T00:00:00.000Z' });
  const result = await store.scanPurchaseHistoryMatchesForListings(['listing-1', 'listing-1'], { actor: 'scanner' });
  assert.deepEqual(result, { scanned: 1, matched: 1, queued: 1, listingIds: ['listing-1'] });
  assert.deepEqual(resolveQueueStore.calls[0].listingIds, ['listing-1']);
  assert.equal(resolveQueueStore.calls[0].options.actor, 'scanner');
});

test('scans PostgreSQL purchase history listing cursors', async () => {
  const pool = createFakePool((sql, params) => {
    if (/FROM purchase_history_match_scan_state/.test(sql)) return [{ state_key: params[0], cursor_at: '2026-05-01T00:00:00.000Z', cursor_id: '', updated_at: 'state' }];
    if (/SELECT listing_id, last_seen_at/.test(sql)) {
      assert.deepEqual(params, ['2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', '', 2]);
      return [{ listing_id: 'listing-1', last_seen_at: '2026-05-02T00:00:00.000Z' }];
    }
    if (/SELECT listing_id, detail_completed_at/.test(sql)) return [];
    if (/SELECT \* FROM homepage_listings WHERE listing_id IN/.test(sql)) return [];
    if (/INSERT INTO purchase_history_match_scan_state/.test(sql)) {
      assert.deepEqual(params, ['seen', '2026-05-02T00:00:00.000Z', 'listing-1', '2026-05-10T00:00:00.000Z']);
      return { rows: [], rowCount: 1 };
    }
    throw new Error('unexpected SQL: ' + sql);
  });
  const store = createMarketplacePurchaseHistoryPostgresStore({ pool });
  const result = await store.scanPurchaseHistoryListingMatches({ limit: 2, enqueueResolve: false, now: '2026-05-10T00:00:00.000Z' });
  assert.deepEqual(result.cursors.seen, { cursorAt: '2026-05-02T00:00:00.000Z', cursorId: 'listing-1' });
  assert.equal(result.scanned, 0);
});

test('lists, counts, randomizes, and updates PostgreSQL purchase history match queue', async () => {
  const queueRow = {
    document_id: 'doc-1', record_id: 'trade-001', listing_id: 'listing-1', status: 'queued',
    listing_price_cad: '100', purchase_price_cad: '90', threshold_price_cad: '97.2', matched_terms_json: '[\"nikon\",\"fm2\"]',
    listing_seen_at: 'seen', source: 'facebook', source_keyword: 'camera', first_matched_at: 'first', updated_at: 'updated', queued_at: 'queued', note: '',
    detail_title: 'Nikon FM2', history_data_json: '{}',
  };
  const pool = createFakePool((sql, params) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return [];
    if (/FROM purchase_history_match_queue q/.test(sql) && /ORDER BY q\.updated_at DESC/.test(sql)) {
      assert.deepEqual(params, ['queued', 'listing-1', 5, 2]);
      assert.match(sql, /q\.status = \$1/);
      assert.match(sql, /q\.listing_id = \$2/);
      assert.match(sql, /LIMIT \$3 OFFSET \$4/);
      return [queueRow];
    }
    if (/FROM purchase_history_match_queue q/.test(sql) && /ORDER BY RANDOM()/.test(sql)) {
      assert.deepEqual(params, ['queued', 'saved', 2]);
      assert.match(sql, /q\.status IN \(\$1, \$2\)/);
      assert.match(sql, /LIMIT \$3/);
      return [{ ...queueRow, listing_id: 'listing-2' }];
    }
    if (/SELECT COUNT\(\*\)::BIGINT AS total/.test(sql)) {
      assert.deepEqual(params, ['doc-1']);
      assert.match(sql, /q\.document_id = \$1/);
      return [{ total: '7' }];
    }
    if (/UPDATE purchase_history_match_queue/.test(sql)) {
      assert.deepEqual(params, ['saved', '2026-05-08T00:00:00.000Z', 'keeper', 'keeper', 'doc-1', 'trade-001', 'listing-1']);
      return { rows: [], rowCount: 1 };
    }
    if (/INSERT INTO purchase_history_match_events/.test(sql)) {
      assert.equal(params[1], 'doc-1');
      assert.equal(params[4], 'recommendation_saved');
      assert.equal(params[6], 'tester');
      assert.equal(JSON.parse(params[8]).status, 'saved');
      return { rows: [], rowCount: 1 };
    }
    throw new Error('unexpected SQL: ' + sql);
  });
  const store = createMarketplacePurchaseHistoryPostgresStore({ pool });
  const rows = await store.listPurchaseHistoryMatchQueue({ listingId: 'listing-1', limit: 5, offset: 2 });
  const randomRows = await store.listRandomPurchaseHistoryMatches({ statuses: ['queued', 'saved'], resolvedOnly: true, limit: 2 });
  const total = await store.countPurchaseHistoryMatchQueue({ status: 'all', documentId: 'doc-1' });
  const updated = await store.updatePurchaseHistoryMatchQueueStatus({ documentId: 'doc-1', recordId: 'trade-001', listingId: 'listing-1', status: 'saved' }, { updatedAt: '2026-05-08T00:00:00.000Z', reason: 'keeper', actor: 'tester' });
  assert.equal(rows[0].listing_price_cad, 100);
  assert.equal(randomRows[0].listing_id, 'listing-2');
  assert.equal(total, 7);
  assert.equal(updated.changes, 1);
});

test('lists rows, appends events, filters events, deletes documents, and closes pool', async () => {
  const pool = createFakePool((sql, params) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return [];
    if (/SELECT \* FROM purchase_history_rows/.test(sql)) return [{ document_id: 'doc-1', record_id: 'trade-001', title: 'Nikon FM2', data_json: '{"record_id":"trade-001"}', created_at: 'c', updated_at: 'u' }];
    if (/INSERT INTO purchase_history_events/.test(sql)) { assert.equal(params[0], 'event-1'); return { rows: [], rowCount: 1 }; }
    if (/SELECT \* FROM purchase_history_events/.test(sql)) { assert.deepEqual(params, ['doc-1', 'trade-001', 10]); return [{ event_id: 'event-1', document_id: 'doc-1', record_id: 'trade-001', event_type: 'sold', event_at: '2026-05-05', data_json: '{}', created_at: 'c' }]; }
    if (/DELETE FROM purchase_history_documents/.test(sql)) return { rows: [], rowCount: 1 };
    if (/DELETE FROM purchase_history_/.test(sql)) return { rows: [], rowCount: 2 };
    throw new Error('unexpected SQL: ' + sql);
  });
  const store = createMarketplacePurchaseHistoryPostgresStore({ pool });
  const rows = await store.listPurchaseHistoryRows('doc-1', { limit: 50000 });
  await store.appendPurchaseHistoryEvent({ eventId: 'event-1', documentId: 'doc-1', recordId: 'trade-001', eventType: 'sold', eventAt: '2026-05-05' });
  const events = await store.listPurchaseHistoryEvents({ documentId: 'doc-1', recordId: 'trade-001', limit: 10 });
  const deleted = await store.deletePurchaseHistoryDocument('doc-1');
  await store.close();
  assert.equal(rows[0].record_id, 'trade-001');
  assert.equal(events[0].event_type, 'sold');
  assert.equal(deleted.deleted, 1);
  assert.equal(pool.ended, true);
});
