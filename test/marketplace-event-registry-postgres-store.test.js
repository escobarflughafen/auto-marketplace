const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createMarketplaceEventRegistryPostgresStore,
  normalizeEventRegistryLimit,
  normalizeEventRegistryOffset,
  normalizeEventRegistryRow,
  normalizeEventRegistrySource,
} = require('../scripts/marketplace-event-registry-postgres-store');

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

const listingRow = {
  source: 'listing',
  event_id: 'listing-event-1',
  event_type: 'listing_observed',
  event_at: '2026-06-05T00:00:10.000Z',
  status: 'done',
  subject_id: 'listing-1',
  title: 'Listing title',
  data_json: '{"index":1}',
};

test('normalizes event registry options and rows', () => {
  assert.equal(normalizeEventRegistrySource('listing'), 'listing');
  assert.equal(normalizeEventRegistrySource('bad-source'), 'all');
  assert.equal(normalizeEventRegistryLimit(10000), 500);
  assert.equal(normalizeEventRegistryLimit('bad'), 100);
  assert.equal(normalizeEventRegistryOffset(-1), 0);
  assert.deepEqual(normalizeEventRegistryRow({ ...listingRow, data_json: { already: 'parsed' } }), {
    source: 'listing',
    event_id: 'listing-event-1',
    event_type: 'listing_observed',
    event_at: '2026-06-05T00:00:10.000Z',
    status: 'done',
    subject_id: 'listing-1',
    title: 'Listing title',
    data: { already: 'parsed' },
  });
});

test('listEventRegistry reads source-specific listing events with bounded paging', async () => {
  const pool = createFakePool((sql, params) => {
    assert.match(sql, /FROM listing_events events/);
    assert.match(sql, /LEFT JOIN homepage_listings listings/);
    assert.match(sql, /LIMIT \$1/);
    assert.match(sql, /OFFSET \$2/);
    assert.deepEqual(params, [500, 7]);
    return [listingRow];
  });
  const store = createMarketplaceEventRegistryPostgresStore({ pool });
  const events = await store.listEventRegistry({ source: 'listing', limit: 10000, offset: 7 });

  assert.deepEqual(events, [{
    source: 'listing',
    event_id: 'listing-event-1',
    event_type: 'listing_observed',
    event_at: '2026-06-05T00:00:10.000Z',
    status: 'done',
    subject_id: 'listing-1',
    title: 'Listing title',
    data: { index: 1 },
  }]);
});

test('listEventRegistry merges all source windows by newest event', async () => {
  const pool = createFakePool((sql, params) => {
    assert.deepEqual(params, [3, 0]);
    if (/FROM workflow_events events/.test(sql)) {
      return [{
        source: 'workflow',
        event_id: 'workflow-latest',
        event_type: 'worker_completed',
        event_at: '2026-06-05T00:00:30.000Z',
        status: 'completed',
        subject_id: 'run-1',
        title: 'Run 1',
        data_json: '{"reason":"done"}',
      }];
    }
    if (/FROM listing_events events/.test(sql)) {
      return [{ ...listingRow, event_id: 'listing-newer', event_at: '2026-06-05T00:00:20.000Z' }];
    }
    if (/FROM purchase_history_events events/.test(sql)) {
      return [{
        source: 'inventory',
        event_id: 'inventory-older',
        event_type: 'inventory_imported',
        event_at: '2026-06-05T00:00:05.000Z',
        status: 'kept',
        subject_id: 'record-1',
        title: 'Record 1',
        data_json: '{}',
      }];
    }
    return [];
  });
  const store = createMarketplaceEventRegistryPostgresStore({ pool });
  const events = await store.listEventRegistry({ source: 'all', limit: 3 });

  assert.deepEqual(events.map((event) => event.event_id), [
    'workflow-latest',
    'listing-newer',
    'inventory-older',
  ]);
  assert.equal(pool.calls.length, 5);
});

test('countEventRegistry sums all PostgreSQL event sources and closes the pool', async () => {
  const counts = new Map([
    ['purchase_history_events', 2],
    ['listing_events', 3],
    ['resolve_queue_events', 5],
    ['purchase_history_match_events', 7],
    ['workflow_events', 11],
  ]);
  const pool = createFakePool((sql) => {
    for (const [table, count] of counts.entries()) {
      if (sql.includes(table)) return [{ total: String(count) }];
    }
    return [{ total: '0' }];
  });
  const store = createMarketplaceEventRegistryPostgresStore({ pool });

  assert.equal(await store.countEventRegistry({ source: 'all' }), 28);
  assert.equal(await store.countEventRegistry({ source: 'workflow' }), 11);
  await store.close();
  assert.equal(pool.ended, true);
});
