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

test('appendListingEvent writes PostgreSQL row and updates worker stats cache', async () => {
  const pool = createFakePool((sql, params) => {
    if (/INSERT INTO listing_events/.test(sql)) {
      assert.deepEqual(params, [
        'event-new-1',
        'run-1',
        'listing-1',
        'detail_capture_succeeded',
        '2026-05-08T00:00:20.000Z',
        'worker-a',
        'https://example.test/listing-1',
        3,
        'done',
        JSON.stringify({ title: 'Camera' }, null, 2),
        'content-hash-1',
        '/tmp/new.png',
        '/tmp/new.md',
        '',
      ]);
      return [];
    }
    if (/INSERT INTO worker_event_stats_cache/.test(sql)) {
      assert.deepEqual(params, [
        'run-1',
        'listing',
        'detail_capture_succeeded',
        'done',
        1,
        '2026-05-08T00:00:20.000Z',
      ]);
      return [];
    }
    if (/WHERE e\.event_id = \$1/.test(sql)) {
      assert.deepEqual(params, ['event-new-1']);
      return [{
        ...listingEventRow,
        event_id: 'event-new-1',
        event_type: 'detail_capture_succeeded',
        status: 'done',
      }];
    }
    throw new Error('unexpected SQL: ' + sql);
  });
  const store = createMarketplaceWorkerEventsPostgresStore({ pool });
  const event = await store.appendListingEvent({
    eventId: 'event-new-1',
    workflowRunId: 'run-1',
    listingId: 'listing-1',
    eventType: 'detail_capture_succeeded',
    eventAt: '2026-05-08T00:00:20.000Z',
    workerId: 'worker-a',
    sourceUrl: 'https://example.test/listing-1',
    attempt: 3,
    status: 'done',
    content: { title: 'Camera' },
    contentHash: 'content-hash-1',
    screenshotPath: '/tmp/new.png',
    snapshotPath: '/tmp/new.md',
  });

  assert.equal(event.event_id, 'event-new-1');
  assert.equal(event.event_type, 'detail_capture_succeeded');
  assert.equal(pool.calls.length, 3);
});

test('appendListingEvent rejects events without listing ids before querying', async () => {
  const store = createMarketplaceWorkerEventsPostgresStore({ pool: createFakePool(() => []) });
  await assert.rejects(() => store.appendListingEvent({ eventType: 'detail_capture_started' }), /requires listingId/);
  assert.equal(store.pool.calls.length, 0);
});

test('listing event read helpers use PostgreSQL listing filters', async () => {
  const pool = createFakePool((sql, params) => {
    if (/WHERE e\.event_id = \$1/.test(sql)) {
      assert.deepEqual(params, ['event-1']);
      return [listingEventRow];
    }
    if (/WHERE e\.listing_id = \$1\s+ORDER BY e\.event_at DESC\s+LIMIT \$2/.test(sql)) {
      assert.deepEqual(params, ['listing-1', 200]);
      return [listingEventRow, { ...listingEventRow, event_id: 'event-2' }];
    }
    if (/AND e\.event_type = \$2/.test(sql)) {
      assert.deepEqual(params, ['listing-1', 'detail_capture_succeeded']);
      return [{ ...listingEventRow, event_id: 'event-success', event_type: 'detail_capture_succeeded' }];
    }
    throw new Error('unexpected SQL: ' + sql);
  });
  const store = createMarketplaceWorkerEventsPostgresStore({ pool });

  const event = await store.getListingEvent('event-1');
  const events = await store.getListingEvents('listing-1', { limit: 500 });
  const latest = await store.getLatestListingEvent('listing-1', { eventType: 'detail_capture_succeeded' });

  assert.equal(event.event_id, 'event-1');
  assert.deepEqual(events.map((row) => row.event_id), ['event-1', 'event-2']);
  assert.equal(latest.event_id, 'event-success');
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

test('listWorkerAuditEvents composes listing and workflow events by category', async () => {
  const workflowEvent = {
    event_scope: 'workflow',
    event_id: 'workflow-newer',
    workflow_run_id: 'run-1',
    listing_id: '',
    event_type: 'browser_context_ready',
    event_at: '2026-05-08T00:00:12.000Z',
    worker_id: 'run-1',
    source_url: '',
    attempt: 0,
    status: 'running',
    content: {},
    content_hash: '',
    screenshot_path: '',
    snapshot_path: '',
    error: '',
    listing: {},
  };
  const failedWorkflowEvent = {
    ...workflowEvent,
    event_id: 'workflow-failed',
    event_type: 'browser_context_failed',
    event_at: '2026-05-08T00:00:11.000Z',
    status: 'failed',
    error: 'boom',
  };
  const workflowEventStore = {
    calls: [],
    async listWorkerWorkflowEvents(workerId, options = {}) {
      this.calls.push({ workerId, options });
      return options.category === 'workflow-only'
        ? [workflowEvent]
        : [workflowEvent, failedWorkflowEvent];
    },
  };
  const pool = createFakePool(() => [listingEventRow]);
  const store = createMarketplaceWorkerEventsPostgresStore({ pool, workflowEventStore });

  const all = await store.listWorkerAuditEvents('run-1', { limit: 3 });
  assert.deepEqual(all.map((event) => event.event_id), ['workflow-newer', 'workflow-failed', 'event-1']);

  const listingOnly = await store.listWorkerAuditEvents('run-1', { category: 'listing' });
  assert.deepEqual(listingOnly.map((event) => event.event_scope), ['listing']);

  const workflowOnly = await store.listWorkerAuditEvents('run-1', { category: 'workflow', categoryMarker: 'workflow-only' });
  assert.deepEqual(workflowOnly.map((event) => event.event_scope), ['workflow', 'workflow']);

  const review = await store.listWorkerAuditEvents('run-1', { category: 'review' });
  assert.deepEqual(review.map((event) => event.event_id), ['workflow-failed', 'event-1']);
});

test('getWorkerAuditEventStats reads cache when requested', async () => {
  const pool = createFakePool((sql) => {
    if (/FROM worker_event_stats_cache/.test(sql)) {
      return [
        { event_scope: 'listing', event_type: 'listing_observed', status: 'new', count: '2' },
        { event_scope: 'workflow', event_type: 'browser_context_failed', status: 'failed', count: '3' },
      ];
    }
    throw new Error(
      'cache-only audit stats should not read live tables',
    );
  });
  const store = createMarketplaceWorkerEventsPostgresStore({
    pool,
    workflowEventStore: { async listWorkerWorkflowEvents() { return []; } },
  });

  const stats = await store.getWorkerAuditEventStats('run-1', { preferCache: true });
  assert.equal(stats.source, 'cache');
  assert.equal(stats.listingTotal, 2);
  assert.equal(stats.workflow, 3);
  assert.equal(stats.workflowReview, 3);
  assert.equal(stats.error, 3);
  assert.equal(stats.total, 5);
  assert.deepEqual(stats.eventTypes.map((item) => item.eventScope), ['workflow', 'listing']);

  const missing = await createMarketplaceWorkerEventsPostgresStore({
    pool: createFakePool(() => []),
    workflowEventStore: { async listWorkerWorkflowEvents() { return []; } },
  }).getWorkerAuditEventStats('missing-run', { cacheOnly: true });
  assert.equal(missing.source, 'cache_miss');
  assert.equal(missing.total, 0);
});

test('getWorkerAuditEventStats merges live listing and workflow stats', async () => {
  const latestWorkflow = {
    event_scope: 'workflow',
    event_id: 'workflow-latest',
    workflow_run_id: 'run-1',
    event_type: 'browser_context_failed',
    event_at: '2026-05-08T00:00:20.000Z',
    worker_id: 'run-1',
    status: 'failed',
    error: 'boom',
    content: {},
    listing: {},
  };
  const workflowEventStore = {
    async listWorkerWorkflowEvents() {
      return [latestWorkflow];
    },
  };
  const pool = createFakePool((sql) => {
    if (/SELECT event_type, status, COUNT/.test(sql)) {
      return [
        { event_type: 'listing_observed', status: 'new', count: '2' },
        { event_type: 'detail_capture_failed', status: 'failed', count: '1' },
      ];
    }
    if (/SELECT event_type, COUNT/.test(sql)) {
      return [
        { event_type: 'browser_context_ready', count: '4' },
        { event_type: 'browser_context_failed', count: '1' },
      ];
    }
    if (/SELECT COUNT\(\*\)::BIGINT AS count/.test(sql)) return [{ count: '1' }];
    if (sql.includes('COALESCE(e.screenshot_path')) return [{ ...listingEventRow, event_id: 'preview-event' }];
    if (/ORDER BY e\.event_at DESC\s+LIMIT 1/.test(sql)) return [{ ...listingEventRow, event_id: 'listing-latest' }];
    return [];
  });
  const store = createMarketplaceWorkerEventsPostgresStore({ pool, workflowEventStore });
  const stats = await store.getWorkerAuditEventStats('run-1');

  assert.equal(stats.listingTotal, 3);
  assert.equal(stats.workflow, 5);
  assert.equal(stats.workflowReview, 1);
  assert.equal(stats.total, 8);
  assert.equal(stats.error, 2);
  assert.equal(stats.latestEvent.event_id, 'workflow-latest');
  assert.equal(stats.latestPreviewEvent.event_id, 'preview-event');
  assert.deepEqual(stats.eventTypes.find((item) => item.eventType === 'browser_context_ready'), {
    eventType: 'browser_context_ready',
    eventScope: 'workflow',
    count: 4,
  });
});
