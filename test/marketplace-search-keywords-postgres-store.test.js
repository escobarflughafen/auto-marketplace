const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createMarketplaceSearchKeywordsPostgresStore,
  normalizeKeyword,
  normalizeListingSearchKeywordRow,
  normalizeSearchTitleBagKeywordRow,
} = require('../scripts/marketplace-search-keywords-postgres-store');

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

test('normalizes PostgreSQL search keyword rows', () => {
  assert.equal(normalizeKeyword('  Ricoh   GR III  '), 'Ricoh GR III');
  assert.equal(normalizeListingSearchKeywordRow({ listing_id: 'listing-1', normalized_keyword: 'ricoh', keyword: 'Ricoh', times_seen: '3' }).times_seen, 3);
  assert.equal(normalizeSearchTitleBagKeywordRow({ normalized_keyword: 'ricoh', keyword: 'Ricoh', times_seen: '4' }).last_source_keyword, '');
});

test('upserts listing search keywords and title bag keywords', async () => {
  const pool = createFakePool((sql, params) => {
    if (/INSERT INTO listing_search_keywords/.test(sql)) {
      assert.match(sql, /ON CONFLICT\(listing_id, normalized_keyword\) DO UPDATE SET/);
      assert.deepEqual(params, ['listing-1', 'ricoh gr', 'Ricoh GR', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z']);
      return { rows: [], rowCount: 1 };
    }
    if (/FROM listing_search_keywords/.test(sql)) return [{ listing_id: 'listing-1', normalized_keyword: 'ricoh gr', keyword: 'Ricoh GR', first_seen_at: 'first', last_seen_at: 'last', times_seen: '2' }];
    if (/INSERT INTO search_title_bag/.test(sql)) {
      assert.match(sql, /times_seen = search_title_bag\.times_seen \+ 1/);
      assert.deepEqual(params, ['ricoh gr iii', 'Ricoh GR III', '2026-05-02T00:00:00.000Z', '2026-05-02T00:00:00.000Z', 'Ricoh GR']);
      return { rows: [], rowCount: 1 };
    }
    if (/FROM search_title_bag\s+WHERE normalized_keyword = \$1/.test(sql)) return [{ normalized_keyword: params[0], keyword: 'Ricoh GR III', first_seen_at: 'first', last_seen_at: 'last', times_seen: '3', last_source_keyword: 'Ricoh GR' }];
    throw new Error('unexpected SQL: ' + sql);
  });
  const store = createMarketplaceSearchKeywordsPostgresStore({ pool });
  const listingKeyword = await store.upsertListingSearchKeyword('listing-1', 'Ricoh GR', { seenAt: '2026-05-01T00:00:00.000Z' });
  const titleBag = await store.upsertSearchTitleBagKeyword('Ricoh GR III', { sourceKeyword: 'Ricoh GR', seenAt: '2026-05-02T00:00:00.000Z' });
  assert.equal(listingKeyword.times_seen, 2);
  assert.equal(titleBag.normalized_keyword, 'ricoh gr iii');
});

test('reads random title bag keyword, counts title bag rows, and closes pool', async () => {
  const pool = createFakePool((sql, params) => {
    if (/ORDER BY RANDOM\(\)/.test(sql)) {
      assert.deepEqual(params, [2, 'ricoh gr']);
      assert.match(sql, /normalized_keyword NOT IN \(\$2\)/);
      return [{ normalized_keyword: 'pentax 67', keyword: 'Pentax 67', first_seen_at: 'first', last_seen_at: 'last', times_seen: '5', last_source_keyword: '' }];
    }
    if (/COUNT\(\*\)::BIGINT AS total_keywords/.test(sql)) return [{ total_keywords: '4', total_seen: '12' }];
    throw new Error('unexpected SQL: ' + sql);
  });
  const store = createMarketplaceSearchKeywordsPostgresStore({ pool });
  const picked = await store.pickRandomSearchTitleBagKeyword({ minTimesSeen: 2, excludeKeywords: ['Ricoh GR'] });
  const counts = await store.getSearchTitleBagCounts();
  await store.close();
  assert.equal(picked.keyword, 'Pentax 67');
  assert.deepEqual(counts, { totalKeywords: 4, totalSeen: 12 });
  assert.equal(pool.ended, true);
});
