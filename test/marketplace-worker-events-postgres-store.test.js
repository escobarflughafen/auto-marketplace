const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createMarketplaceWorkerEventsPostgresStore,
  normalizeListingEventRow,
  collectorOutcomeStatsFromRows,
  boundedLimit,
} = require('../scripts/marketplace-worker-events-postgres-store');

const listingEventRow = {
  event_scope: 'listing',
  event_id: 'event-1',
  workflow_run_id: 'run-1',
  listing_id: 'listing-1',
  event_type: 'listing_observed',
  event_at: '2026-05-08T00:00:10.000Z',
  worker_id: 'worker-a',
  source_url: 'https://example.test/listing-1',
  attempt: '2',
  status: 'new',
  content_json: '{"title":"Camera"}',
  content_hash: 'hash-1',
  screenshot_path: '/tmp/event.png',
  snapshot_path: '/tmp/event.md',
  error: '',
  detail_status: 'done',
  card_title: 'Card title',
  detail_title: 'Detail title',
  detail_price: 'CA$ 100',
  detail_location: 'Vancouver',
  detail_seller_name: 'Seller',
  listing_screenshot_path: '/tmp/listing.png',
  listing_snapshot_path: '/tmp/listing.md',
};

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

test('normalizes PostgreSQL listing event rows to existing worker event shape', () => {
  assert.deepEqual(normalizeListingEventRow(listingEventRow), {
    event_scope: 'listing',
    event_id: 'event-1',
    workflow_run_id: 'run-1',
    listing_id: 'listing-1',
    event_type: 'listing_observed',
    event_at: '2026-05-08T00:00:10.000Z',
    worker_id: 'worker-a',
    source_url: 'https://example.test/listing-1',
    attempt: 2,
    status: 'new',
    content: { title: 'Camera' },
    content_hash: 'hash-1',
    screenshot_path: '/tmp/event.png',
    snapshot_path: '/tmp/event.md',
    error: '',
    listing: {
      detail_status: 'done',
      card_title: 'Card title',
      detail_title: 'Detail title',
      detail_price: 'CA$ 100',
      detail_location: 'Vancouver',
      detail_seller_name: 'Seller',
      screenshot_path: '/tmp/listing.png',
      snapshot_path: '/tmp/listing.md',
    },
  });

  assert.deepEqual(collectorOutcomeStatsFromRows([
    { event_type: 'listing_observed', status: 'new', count: '2' },
    { event_type: 'listing_observed', status: 'existing_updated', count: '3' },
    { event_type: 'listing_observed', status: 'existing_same', count: '4' },
    { event_type: 'listing_observed', status: 'filtered', count: '5' },
    { event_type: 'listing_observed', status: 'error', count: '6' },
  ]), {
    observed: 20,
    appended: 2,
    updated: 3,
    unchanged: 4,
    rejected: 5,
    errors: 6,
  });
});

test('listWorkerListingEvents builds PostgreSQL worker/run and category filters', async () => {
  const pool = createFakePool((sql) => {
    assert.match(sql, /FROM listing_events e/);
    assert.match(sql, /e\.workflow_run_id = \$1/);
    assert.match(sql, /e\.worker_id IN \(\$2, \$3\)/);
    assert.match(sql, /e\.event_type IN \(\$4, \$5\)/);
    assert.match(sql, /e\.event_type = \$6/);
    assert.match(sql, /LIMIT \$11/);
    return [listingEventRow];
  });
  const store = createMarketplaceWorkerEventsPostgresStore({ pool });
  const events = await store.listWorkerListingEvents('run-1', {
    workerIds: ['worker-a', 'pid-1'],
    category: 'error',
    limit: 500,
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].event_id, 'event-1');
  assert.deepEqual(pool.calls[0].params, [
    'run-1',
    'worker-a',
    'pid-1',
    'detail_capture_failed',
    'detail_capture_interrupted',
    'listing_observed',
    'error',
    'failed',
    'malformed',
    'interrupted',
    200,
  ]);
});

test('listWorkerListingEvents supports explicit event type filters', async () => {
  const pool = createFakePool((sql) => {
    assert.match(sql, /AND e\.event_type = \$2/);
    assert.doesNotMatch(sql, /event_type IN/);
    return [listingEventRow];
  });
  const store = createMarketplaceWorkerEventsPostgresStore({ pool });
  await store.listWorkerListingEvents('run-1', {
    workerIds: [],
    eventType: 'detail_capture_started',
    limit: 10,
  });

  assert.deepEqual(pool.calls[0].params, ['run-1', 'detail_capture_started', 10]);
});

test('getWorkerListingEventStats aggregates counts and fetches latest events', async () => {
  const pool = createFakePool((sql) => {
    if (/SELECT event_type, status, COUNT/.test(sql)) {
      return [
        { event_type: 'listing_observed', status: 'new', count: '2' },
        { event_type: 'listing_observed', status: 'existing_same', count: '1' },
        { event_type: 'detail_capture_started', status: '', count: '3' },
        { event_type: 'detail_capture_succeeded', status: '', count: '4' },
        { event_type: 'detail_capture_failed', status: 'failed', count: '5' },
      ];
    }
    if (/COALESCE\(e\.screenshot_path/.test(sql)) {
      return [{ ...listingEventRow, event_id: 'preview-event', screenshot_path: '', listing_screenshot_path: '/tmp/listing.png' }];
    }
    if (/ORDER BY e\.event_at DESC\s+LIMIT 1/.test(sql)) {
      return [{ ...listingEventRow, event_id: 'latest-event' }];
    }
    return [];
  });
  const store = createMarketplaceWorkerEventsPostgresStore({ pool });
  const stats = await store.getWorkerListingEventStats('run-1', {
    workerIds: ['worker-a'],
  });

  assert.equal(stats.total, 15);
  assert.equal(stats.started, 6);
  assert.equal(stats.done, 6);
  assert.equal(stats.skipped, 1);
  assert.equal(stats.error, 5);
  assert.deepEqual(stats.collector, {
    observed: 3,
    appended: 2,
    updated: 0,
    unchanged: 1,
    rejected: 0,
    errors: 0,
  });
  assert.deepEqual(stats.workerIds, ['worker-a']);
  assert.deepEqual(stats.eventTypes.find((item) => item.eventType === 'listing_observed'), {
    eventType: 'listing_observed',
    eventScope: 'listing',
    count: 3,
  });
  assert.deepEqual(stats.statusTypes[0], {
    eventType: 'listing_observed',
    eventScope: 'listing',
    status: 'new',
    count: 2,
  });
  assert.equal(stats.latestEvent.event_id, 'latest-event');
  assert.equal(stats.latestPreviewEvent.event_id, 'preview-event');
  assert.equal(pool.calls.length, 3);
  await store.close();
  assert.equal(pool.ended, true);
});

test('boundedLimit matches worker event API bounds', () => {
  assert.equal(boundedLimit('bad', 50), 50);
  assert.equal(boundedLimit(0, 50), 1);
  assert.equal(boundedLimit(500, 50), 200);
});
