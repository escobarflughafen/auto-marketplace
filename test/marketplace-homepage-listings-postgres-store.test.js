const test = require('node:test');
const assert = require('node:assert/strict');

const {
  canonicalizeListingUrl,
  createMarketplaceHomepageListingsPostgresStore,
  normalizeHomepageListingRow,
} = require('../scripts/marketplace-homepage-listings-postgres-store');

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
    async end() {
      this.ended = true;
    },
  };
}

function listingRow(overrides = {}) {
  return {
    listing_id: '100',
    href: 'https://www.facebook.com/marketplace/item/100/',
    source: 'homepage',
    source_keyword: '',
    card_title: 'First title',
    card_text: 'First card text',
    raw_card_json: '{}',
    first_seen_at: '2026-04-27T00:00:00.000Z',
    last_seen_at: '2026-04-27T00:00:00.000Z',
    last_seen_rank: '1',
    detail_status: 'pending',
    detail_attempts: '0',
    detail_price: 'CA$ 10',
    detail_last_error: '',
    ...overrides,
  };
}

test('canonicalizes listing URLs and normalizes numeric listing fields', () => {
  assert.equal(
    canonicalizeListingUrl('https://www.facebook.com/marketplace/item/100/?ref=feed'),
    'https://www.facebook.com/marketplace/item/100/',
  );
  assert.equal(
    canonicalizeListingUrl('https://www.goofish.com/item?id=1058700807807&categoryId=126864790&spm=abc'),
    'https://www.goofish.com/item?id=1058700807807&categoryId=126864790',
  );
  assert.equal(normalizeHomepageListingRow(listingRow()).last_seen_rank, 1);
  assert.equal(normalizeHomepageListingRow(listingRow()).detail_attempts, 0);
});

test('upsertHomepageListingWithStatus inserts homepage row, writes media, and reports new outcome', async () => {
  const mediaCalls = [];
  const mediaStore = {
    async upsertListingMediaForListing(...args) {
      mediaCalls.push(args);
      return [];
    },
  };
  const pool = createFakePool((sql, params, callNumber) => {
    if (/SELECT \*/.test(sql)) {
      assert.deepEqual(params, ['100']);
      return callNumber === 1 ? [] : [listingRow({
        card_title: 'First title',
        card_text: 'First card text',
        last_seen_rank: '1',
      })];
    }
    if (/INSERT INTO homepage_listings/.test(sql)) {
      assert.match(sql, /ON CONFLICT\(listing_id\) DO UPDATE SET/);
      assert.match(sql, /detail_status = CASE/);
      assert.deepEqual(params.slice(0, 6), [
        '100',
        'https://www.facebook.com/marketplace/item/100/',
        'search',
        'leica m6',
        'First title',
        'First card text',
      ]);
      const raw = JSON.parse(params[6]);
      assert.equal(raw.href, 'https://www.facebook.com/marketplace/item/100/');
      assert.equal(raw.listingId, '100');
      assert.equal(raw.source, 'search');
      assert.equal(raw.sourceKeyword, 'leica m6');
      assert.deepEqual(params.slice(7), [
        '2026-04-27T00:00:00.000Z',
        '2026-04-27T00:00:00.000Z',
        1,
        'CA$ 10',
      ]);
      return [];
    }
    throw new Error('unexpected SQL: ' + sql);
  });
  const store = createMarketplaceHomepageListingsPostgresStore({ pool, mediaStore });

  const result = await store.upsertHomepageListingWithStatus({
    listingId: '100',
    href: 'https://www.facebook.com/marketplace/item/100/?ref=browse',
    title: 'First title',
    text: 'First card text',
    price: 'CA$ 10',
    rank: 1,
    photos: [{ sourceUrl: 'https://example.test/100.jpg' }],
  }, {
    source: 'search',
    sourceKeyword: 'leica m6',
    seenAt: '2026-04-27T00:00:00.000Z',
  });

  assert.equal(result.outcome, 'new');
  assert.equal(result.sameContent, false);
  assert.equal(result.row.listing_id, '100');
  assert.deepEqual(mediaCalls, [[
    '100',
    [{ sourceUrl: 'https://example.test/100.jpg' }],
    { seenAt: '2026-04-27T00:00:00.000Z', source: 'search' },
  ]]);
});

test('upsertHomepageListingWithStatus detects unchanged content and preserves processed status SQL', async () => {
  const previous = listingRow({
    card_title: 'Same title',
    card_text: 'Same text',
    last_seen_rank: '2',
    detail_status: 'done',
    detail_price: 'CA$ 99',
  });
  const refreshed = { ...previous, last_seen_at: '2026-04-27T01:00:00.000Z' };
  const pool = createFakePool((sql, params, callNumber) => {
    if (/SELECT \*/.test(sql)) return callNumber === 1 ? [previous] : [refreshed];
    if (/INSERT INTO homepage_listings/.test(sql)) {
      assert.match(sql, /WHEN homepage_listings\.detail_status IN \('done', 'processing', 'sold', 'pending_sale'\)/);
      assert.equal(params[10], '');
      return [];
    }
    throw new Error('unexpected SQL: ' + sql);
  });
  const store = createMarketplaceHomepageListingsPostgresStore({
    pool,
    mediaStore: { async upsertListingMediaForListing() { return []; } },
  });

  const result = await store.upsertHomepageListingWithStatus({
    listingId: '100',
    href: 'https://www.facebook.com/marketplace/item/100/?ref=feed',
    title: 'Same title',
    text: 'Same text',
    rank: 2,
  });

  assert.equal(result.outcome, 'existing_same');
  assert.equal(result.sameContent, true);
  assert.equal(result.rankChanged, false);
  assert.equal(result.previousRow.detail_status, 'done');
});

test('upsertHomepageListing returns row and getHomepageListingCounts maps PostgreSQL counts', async () => {
  const pool = createFakePool((sql, params, callNumber) => {
    if (/SELECT \*/.test(sql)) return callNumber === 1 ? [] : [listingRow({ listing_id: '200', last_seen_rank: null })];
    if (/INSERT INTO homepage_listings/.test(sql)) return [];
    if (/GROUP BY detail_status/.test(sql)) {
      return [
        { detail_status: 'pending', count: '4' },
        { detail_status: 'error', count: '2' },
        { detail_status: 'done', count: '7' },
      ];
    }
    throw new Error('unexpected SQL: ' + sql);
  });
  const store = createMarketplaceHomepageListingsPostgresStore({
    pool,
    mediaStore: { async upsertListingMediaForListing() { return []; } },
  });

  const row = await store.upsertHomepageListing({
    listingId: '200',
    href: 'https://www.facebook.com/marketplace/item/200/',
    title: 'Second',
    text: 'Second card',
  });
  const counts = await store.getHomepageListingCounts();

  assert.equal(row.listing_id, '200');
  assert.deepEqual(counts, {
    pending: 4,
    processing: 0,
    done: 7,
    error: 2,
    sold: 0,
    pending_sale: 0,
  });
  await store.close();
  assert.equal(pool.ended, true);
});

test('listBacklogCandidates builds PostgreSQL filters and bounded limits', async () => {
  const pool = createFakePool((sql, params) => {
    assert.match(sql, /FROM homepage_listings/);
    assert.match(sql, /detail_status = 'pending'/);
    assert.match(sql, /source = \$1/);
    assert.match(sql, /lower\(source_keyword\) LIKE \$2/);
    assert.match(sql, /listing_id IN \(\$3, \$4\)/);
    assert.match(sql, /last_seen_at >= \$5/);
    assert.match(sql, /LIMIT \$6/);
    assert.deepEqual(params, [
      'search',
      '%pentax%',
      'listing-a',
      'listing-b',
      '2026-05-01T00:00:00.000Z',
      200,
    ]);
    return [listingRow({ listing_id: 'listing-a', detail_attempts: '1' })];
  });
  const store = createMarketplaceHomepageListingsPostgresStore({ pool });
  const rows = await store.listBacklogCandidates({
    statusFilter: 'pending',
    sourceFilter: 'search',
    keywordFilter: 'pentax',
    listingIds: ['listing-a', 'listing-b', 'listing-a'],
    seenAfter: '2026-05-01T00:00:00.000Z',
    limit: 500,
  });

  assert.equal(rows[0].listing_id, 'listing-a');
  assert.equal(rows[0].detail_attempts, 1);
});

test('claimNextPendingHomepageListing claims a row inside a PostgreSQL transaction', async () => {
  const events = [];
  const pool = createFakePool((sql, params) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return [];
    if (/SELECT listing_id/.test(sql)) {
      assert.match(sql, /FOR UPDATE SKIP LOCKED/);
      assert.match(sql, /detail_status IN \('pending', 'error'\)/);
      assert.deepEqual(params, ['2026-05-11T01:30:00.000Z']);
      return [{ listing_id: 'claim-1' }];
    }
    if (/UPDATE homepage_listings/.test(sql)) {
      assert.deepEqual(params, ['2026-05-11T02:00:00.000Z', 'worker-a', 'claim-1']);
      return { rows: [], rowCount: 1 };
    }
    if (/SELECT \*/.test(sql)) {
      assert.deepEqual(params, ['claim-1']);
      return [listingRow({
        listing_id: 'claim-1',
        detail_status: 'processing',
        detail_attempts: '2',
        claimed_by: 'worker-a',
      })];
    }
    throw new Error('unexpected SQL: ' + sql);
  });
  const store = createMarketplaceHomepageListingsPostgresStore({
    pool,
    eventStore: { async appendListingEvent(event) { events.push(event); } },
  });

  const claimed = await store.claimNextPendingHomepageListing({
    workerId: 'worker-a',
    claimedAt: '2026-05-11T02:00:00.000Z',
    now: '2026-05-11T02:00:00.000Z',
    staleAfterSeconds: 1800,
    startEventBuilder: (row) => ({ listingId: row.listing_id, eventType: 'detail_capture_started' }),
  });

  assert.equal(claimed.listing_id, 'claim-1');
  assert.equal(claimed.detail_attempts, 2);
  assert.deepEqual(events, [{ listingId: 'claim-1', eventType: 'detail_capture_started' }]);
  assert.deepEqual(pool.calls.map((call) => call.sql.trim()).filter((sql) => ['BEGIN', 'COMMIT'].includes(sql)), ['BEGIN', 'COMMIT']);
});

test('markHomepageListingFailed and releaseHomepageListingClaim update status rows', async () => {
  const pool = createFakePool((sql, params, callNumber) => {
    if (/detail_status = 'error'/.test(sql)) {
      assert.deepEqual(params, ['temporary failure', '2026-05-11T02:05:00.000Z', 'claim-1']);
      return { rows: [], rowCount: 1 };
    }
    if (/SELECT \*/.test(sql) && callNumber === 2) {
      return [listingRow({ listing_id: 'claim-1', detail_status: 'error', detail_last_error: 'temporary failure' })];
    }
    if (/GREATEST\(detail_attempts - 1, 0\)/.test(sql)) {
      assert.deepEqual(params, [
        'pending',
        'worker shutdown',
        '2026-05-11T02:06:00.000Z',
        true,
        'claim-1',
        'worker-a',
        'worker-a',
      ]);
      return { rows: [], rowCount: 1 };
    }
    if (/SELECT \*/.test(sql)) {
      return [listingRow({ listing_id: 'claim-1', detail_status: 'pending', detail_attempts: '0', claimed_by: '' })];
    }
    throw new Error('unexpected SQL: ' + sql);
  });
  const store = createMarketplaceHomepageListingsPostgresStore({ pool });

  const failed = await store.markHomepageListingFailed('claim-1', 'temporary failure', {
    completedAt: '2026-05-11T02:05:00.000Z',
  });
  const released = await store.releaseHomepageListingClaim('claim-1', {
    workerId: 'worker-a',
    nextStatus: 'pending',
    reason: 'worker shutdown',
    completedAt: '2026-05-11T02:06:00.000Z',
    decrementAttempts: true,
  });

  assert.equal(failed.detail_status, 'error');
  assert.equal(released.changed, true);
  assert.equal(released.listing.detail_attempts, 0);
});

test('recoverStaleProcessingHomepageListings emits interrupted events and releases claims', async () => {
  const events = [];
  const pool = createFakePool((sql, params) => {
    if (/FROM homepage_listings/.test(sql) && /detail_started_at <= \$1/.test(sql)) {
      assert.deepEqual(params, ['2026-05-11T01:30:00.000Z', 100]);
      return [{
        listing_id: 'stale-1',
        href: 'https://www.facebook.com/marketplace/item/9101/',
        detail_status: 'processing',
        detail_attempts: '1',
        detail_started_at: '2026-05-11T01:00:00.000Z',
        claimed_by: 'stale-worker',
      }];
    }
    if (/GREATEST\(detail_attempts - 1, 0\)/.test(sql)) {
      return { rows: [], rowCount: 1 };
    }
    if (/SELECT \*/.test(sql)) {
      return [listingRow({ listing_id: 'stale-1', detail_status: 'pending', detail_attempts: '0', claimed_by: '' })];
    }
    throw new Error('unexpected SQL: ' + sql);
  });
  const store = createMarketplaceHomepageListingsPostgresStore({
    pool,
    eventStore: { async appendListingEvent(event) { events.push(event); } },
  });

  const recovered = await store.recoverStaleProcessingHomepageListings({
    dryRun: false,
    now: '2026-05-11T02:00:00.000Z',
    staleAfterSeconds: 1800,
    reason: 'alpha_stale_claim_recovery',
  });

  assert.equal(recovered.scanned, 1);
  assert.equal(recovered.recovered, 1);
  assert.equal(recovered.items[0].listing_id, 'stale-1');
  assert.equal(events[0].eventType, 'detail_capture_interrupted');
  assert.equal(events[0].status, 'interrupted');
  assert.equal(events[0].content.recovery.reason, 'alpha_stale_claim_recovery');
});
