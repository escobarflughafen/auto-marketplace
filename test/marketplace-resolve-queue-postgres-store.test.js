const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createMarketplaceResolveQueuePostgresStore,
  normalizeResolveQueueEventRow,
  normalizeResolveQueueItemRow,
  normalizeListingResolverAssignmentRow,
  activeResolveQueueStatuses,
  uniqueStrings,
} = require('../scripts/marketplace-resolve-queue-postgres-store');

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

const itemRow = {
  listing_id: 'listing-1',
  status: 'queued',
  queued_at: 'queued',
  updated_at: 'updated',
  queued_by: 'viewer',
  workflow_run_id: '',
  href: 'https://example.test/item',
  card_title: 'Card',
  workflow_os_alive: 1,
};

test('normalizes resolve queue rows and ids', () => {
  assert.deepEqual(uniqueStrings(['a', 'a', '', ' b ']), ['a', 'b']);
  assert.deepEqual(activeResolveQueueStatuses(), ['queued', 'dispatched', 'failed']);
  assert.equal(normalizeResolveQueueEventRow({ event_id: 'event-1', listing_id: 'listing-1', event_type: 'added', event_at: 'now', content_json: '{"ok":true}' }).content.ok, true);
  assert.equal(normalizeResolveQueueItemRow(itemRow).workflow_os_alive, true);
  assert.equal(normalizeListingResolverAssignmentRow({ listing_id: 'listing-1', os_alive: 0 }).resolver_status, '');
});

test('appends and lists PostgreSQL resolve queue events', async () => {
  const pool = createFakePool((sql, params) => {
    if (/INSERT INTO resolve_queue_events/.test(sql)) {
      assert.deepEqual(params, ['event-1', 'listing-1', 'resolve_queue_added', '2026-05-01T00:00:00.000Z', '', 'tester', 'queued', '{\n  "source": "test"\n}', '']);
      return { rows: [], rowCount: 1 };
    }
    if (/WHERE event_id = \$1/.test(sql)) return [{ event_id: 'event-1', listing_id: 'listing-1', event_type: 'resolve_queue_added', event_at: 'now', actor: 'tester', status: 'queued', content_json: '{"source":"test"}' }];
    if (/FROM resolve_queue_events/.test(sql)) {
      assert.deepEqual(params, [3]);
      return [{ event_id: 'event-2', listing_id: 'listing-2', event_type: 'resolve_queue_added', event_at: 'later', content_json: '{}' }];
    }
    throw new Error('unexpected SQL: ' + sql);
  });
  const store = createMarketplaceResolveQueuePostgresStore({ pool });
  const event = await store.appendResolveQueueEvent({ eventId: 'event-1', listingId: 'listing-1', eventType: 'resolve_queue_added', eventAt: '2026-05-01T00:00:00.000Z', actor: 'tester', status: 'queued', content: { source: 'test' } });
  const events = await store.listResolveQueueEvents({ limit: 3 });
  assert.equal(event.event_id, 'event-1');
  assert.equal(events[0].listing_id, 'listing-2');
});

test('lists items, assignments, counts, and closes pool', async () => {
  const pool = createFakePool((sql, params) => {
    if (/FROM resolve_queue_items q/.test(sql) && /ORDER BY/.test(sql)) {
      assert.deepEqual(params, ['queued', 'failed', 10]);
      assert.match(sql, /q\.status IN \(\$1, \$2\)/);
      assert.match(sql, /LIMIT \$3/);
      return [itemRow];
    }
    if (/FROM resolve_queue_items q/.test(sql) && /WHERE q\.listing_id IN/.test(sql)) {
      assert.deepEqual(params, ['listing-1', 'listing-2']);
      return [{ listing_id: 'listing-1', status: 'queued', workflow_os_alive: 0 }];
    }
    if (/SELECT status, COUNT\(\*\)::BIGINT AS count/.test(sql)) return [{ status: 'queued', count: '2' }, { status: 'failed', count: '1' }];
    throw new Error('unexpected SQL: ' + sql);
  });
  const store = createMarketplaceResolveQueuePostgresStore({ pool });
  const items = await store.listResolveQueueItems({ statuses: ['queued', 'failed'], limit: 10 });
  const assignments = await store.listListingResolverAssignments(['listing-1', 'listing-1', 'listing-2']);
  const counts = await store.getResolveQueueCounts();
  await store.close();
  assert.equal(items[0].listing_id, 'listing-1');
  assert.equal(assignments[0].resolver_status, 'queued');
  assert.equal(counts.queued, 2);
  assert.equal(pool.ended, true);
});

test('adds, clears, dispatches, and refreshes resolve queue items transactionally', async () => {
  const pool = createFakePool((sql, params) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return [];
    if (/FROM homepage_listings/.test(sql)) {
      assert.deepEqual(params, ['listing-1', 'listing-2']);
      return [{ listing_id: 'listing-1' }];
    }
    if (/SELECT status FROM resolve_queue_items WHERE listing_id/.test(sql)) return [];
    if (/INSERT INTO resolve_queue_items/.test(sql)) {
      assert.deepEqual(params, ['listing-1', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', 'tester']);
      return { rows: [], rowCount: 1 };
    }
    if (/INSERT INTO resolve_queue_events/.test(sql)) return { rows: [], rowCount: 1 };
    if (/WHERE event_id = \$1/.test(sql)) return [{ event_id: params[0], listing_id: 'listing-1', event_type: 'resolve_queue_added', event_at: 'now', content_json: '{}' }];
    if (/FROM resolve_queue_items q/.test(sql) && /ORDER BY/.test(sql)) return [itemRow];
    if (/SELECT status, COUNT\(\*\)::BIGINT AS count/.test(sql)) return [{ status: 'queued', count: '1' }];
    if (/SELECT listing_id, status\s+FROM resolve_queue_items/.test(sql)) return [{ listing_id: 'listing-1', status: 'queued' }];
    if (/SET status = 'cleared'/.test(sql)) return { rows: [], rowCount: 1 };
    if (/SET status = 'dispatched'/.test(sql)) return { rows: [], rowCount: 1 };
    if (/JOIN workflow_runs/.test(sql) && /WHERE q\.status = 'dispatched'/.test(sql)) return [{ listing_id: 'listing-1', workflow_run_id: 'run-1', workflow_status: 'exited' }];
    if (/SET status = \$1/.test(sql)) {
      assert.deepEqual(params, ['completed', '2026-05-04T00:00:00.000Z', 'workflow exited', 'listing-1']);
      return { rows: [], rowCount: 1 };
    }
    throw new Error('unexpected SQL: ' + sql);
  });
  const store = createMarketplaceResolveQueuePostgresStore({ pool, nowIso: () => '2026-05-04T00:00:00.000Z' });
  const added = await store.addResolveQueueItems(['listing-1', 'listing-2'], { actor: 'tester', queuedAt: '2026-05-01T00:00:00.000Z' });
  const cleared = await store.clearResolveQueueItems(['listing-1'], { actor: 'tester', clearedAt: '2026-05-02T00:00:00.000Z' });
  const dispatched = await store.markResolveQueueDispatched(['listing-1'], 'run-1', { actor: 'tester', dispatchedAt: '2026-05-03T00:00:00.000Z' });
  const refreshed = await store.refreshResolveQueueRunStatuses();
  assert.deepEqual(added.skippedIds, ['listing-2']);
  assert.equal(cleared.clearedCount, 1);
  assert.equal(dispatched.dispatchedCount, 1);
  assert.equal(refreshed.updatedCount, 1);
});
