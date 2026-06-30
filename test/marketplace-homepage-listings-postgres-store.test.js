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
      return { rows: handler(sql, params, calls.length) || [] };
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
