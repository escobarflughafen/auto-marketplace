const test = require('node:test');
const assert = require('node:assert/strict');

const {
  boundedMediaLimit,
  createMarketplaceListingMediaPostgresStore,
  normalizeListingMediaItems,
  normalizeListingMediaRow,
} = require('../scripts/marketplace-listing-media-postgres-store');

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

const mediaRow = {
  listing_id: 'listing-1',
  media_key: 'media-1',
  media_type: 'image',
  source: 'detail',
  source_url: 'https://example.test/image.jpg',
  artifact_path: '/tmp/image.jpg',
  alt_text: 'Front view',
  width: 640,
  height: 480,
  position: 2,
  first_seen_at: '2026-06-01T00:00:00.000Z',
  last_seen_at: '2026-06-02T00:00:00.000Z',
  metadata_json: '{"kind":"gallery"}',
};

test('normalizes listing media items and rows like the SQLite helper', () => {
  const items = normalizeListingMediaItems([
    { url: 'https://example.test/a.jpg', width: '100', height: 'bad', metadata: { index: 1 } },
    { artifactPath: '/tmp/b.png', mediaType: ' screenshot ', position: 5, alt: 'Preview' },
    { alt: 'empty item is skipped' },
  ]);

  assert.equal(items.length, 2);
  assert.equal(items[0].mediaKey.length, 40);
  assert.equal(items[0].mediaType, 'image');
  assert.equal(items[0].width, 100);
  assert.equal(items[0].height, null);
  assert.equal(items[0].position, 0);
  assert.equal(items[1].mediaType, 'screenshot');
  assert.equal(items[1].position, 5);
  assert.equal(boundedMediaLimit(500), 100);
  assert.equal(boundedMediaLimit('bad'), 50);
  assert.deepEqual(normalizeListingMediaRow(mediaRow), {
    listing_id: 'listing-1',
    media_key: 'media-1',
    media_type: 'image',
    source: 'detail',
    source_url: 'https://example.test/image.jpg',
    artifact_path: '/tmp/image.jpg',
    alt_text: 'Front view',
    width: 640,
    height: 480,
    position: 2,
    first_seen_at: '2026-06-01T00:00:00.000Z',
    last_seen_at: '2026-06-02T00:00:00.000Z',
    metadata: { kind: 'gallery' },
  });
});

test('upsertListingMediaForListing writes media rows and returns ordered media', async () => {
  const pool = createFakePool((sql, params, callNumber) => {
    if (/INSERT INTO listing_media/.test(sql)) {
      assert.match(sql, /ON CONFLICT\(listing_id, media_key\) DO UPDATE SET/);
      assert.doesNotMatch(sql, /first_seen_at = excluded.first_seen_at/);
      if (callNumber === 1) {
        assert.deepEqual(params, [
          'listing-1',
          'explicit-key',
          'image',
          'collector',
          'https://example.test/a.jpg',
          '',
          'Front',
          320,
          240,
          0,
          '2026-06-03T00:00:00.000Z',
          '2026-06-03T00:00:00.000Z',
          JSON.stringify({ index: 1 }, null, 2),
        ]);
      } else {
        assert.equal(params[0], 'listing-1');
        assert.equal(params[2], 'screenshot');
        assert.equal(params[3], 'detail');
        assert.equal(params[5], '/tmp/b.png');
        assert.equal(params[9], 4);
      }
      return [];
    }
    if (/FROM listing_media/.test(sql)) {
      assert.match(sql, /ORDER BY position ASC, last_seen_at DESC/);
      assert.deepEqual(params, ['listing-1', 50]);
      return [mediaRow];
    }
    throw new Error('unexpected SQL: ' + sql);
  });
  const store = createMarketplaceListingMediaPostgresStore({
    pool,
    nowIso: () => '2026-06-03T00:00:00.000Z',
  });

  const rows = await store.upsertListingMediaForListing(' listing-1 ', [
    { mediaKey: 'explicit-key', sourceUrl: 'https://example.test/a.jpg', altText: 'Front', width: 320, height: 240, metadata: { index: 1 } },
    { artifactPath: '/tmp/b.png', mediaType: 'screenshot', source: 'detail', position: 4 },
    { alt: 'skip me' },
  ], { source: 'collector' });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].media_key, 'media-1');
  assert.equal(pool.calls.length, 3);
});

test('upsertListingMediaForListing skips empty inputs before querying', async () => {
  const pool = createFakePool(() => { throw new Error('should not query'); });
  const store = createMarketplaceListingMediaPostgresStore({ pool });

  assert.deepEqual(await store.upsertListingMediaForListing('', [{ sourceUrl: 'https://example.test/a.jpg' }]), []);
  assert.deepEqual(await store.upsertListingMediaForListing('listing-1', [{ alt: 'empty' }]), []);
  assert.equal(pool.calls.length, 0);
});

test('listListingMedia bounds limits and closes pool', async () => {
  const pool = createFakePool((sql, params) => {
    assert.match(sql, /WHERE listing_id = \$1/);
    assert.match(sql, /LIMIT \$2/);
    assert.deepEqual(params, ['listing-1', 100]);
    return [mediaRow];
  });
  const store = createMarketplaceListingMediaPostgresStore({ pool });
  const rows = await store.listListingMedia('listing-1', { limit: 500 });

  assert.equal(rows[0].metadata.kind, 'gallery');
  await store.close();
  assert.equal(pool.ended, true);
});
