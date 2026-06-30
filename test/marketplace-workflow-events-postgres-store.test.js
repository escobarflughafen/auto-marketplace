const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createMarketplaceWorkflowEventsPostgresStore,
  normalizeWorkflowEventRow,
  boundedLimit,
} = require('../scripts/marketplace-workflow-events-postgres-store');

function createFakePool(initialRows = []) {
  const calls = [];
  const rows = new Map(initialRows.map((row) => [row.event_id, { ...row }]));
  return {
    calls,
    rows,
    ended: false,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/INSERT INTO workflow_events/.test(sql)) {
        const [eventId, workflowRunId, eventType, eventAt, status, contentJson, error] = params;
        rows.set(eventId, {
          event_id: eventId,
          workflow_run_id: workflowRunId,
          event_type: eventType,
          event_at: eventAt,
          status,
          content_json: contentJson,
          error,
        });
        return { rows: [] };
      }
      if (/INSERT INTO worker_event_stats_cache/.test(sql)) {
        return { rows: [] };
      }
      if (/WHERE event_id = \$1/.test(sql)) {
        return { rows: rows.has(params[0]) ? [{ ...rows.get(params[0]) }] : [] };
      }
      if (/FROM workflow_events/.test(sql) && /WHERE workflow_run_id = \$1/.test(sql)) {
        const workflowRunId = params[0];
        const eventType = /AND event_type = \$2/.test(sql) ? params[1] : '';
        const limit = params[params.length - 1];
        const filtered = [...rows.values()]
          .filter((row) => row.workflow_run_id === workflowRunId)
          .filter((row) => !eventType || row.event_type === eventType)
          .sort((left, right) => String(right.event_at).localeCompare(String(left.event_at)))
          .slice(0, limit)
          .map((row) => ({ ...row }));
        return { rows: filtered };
      }
      return { rows: [] };
    },
    async end() {
      this.ended = true;
    },
  };
}

test('normalizes workflow event rows to existing SQLite helper shape', () => {
  assert.deepEqual(normalizeWorkflowEventRow({
    event_scope: 'workflow',
    event_id: 'event-1',
    workflow_run_id: 'run-1',
    event_type: 'browser_context_ready',
    event_at: '2026-05-11T00:00:01.000Z',
    status: 'running',
    content_json: '{"pageCount":1}',
    error: '',
  }), {
    event_scope: 'workflow',
    event_id: 'event-1',
    workflow_run_id: 'run-1',
    listing_id: '',
    event_type: 'browser_context_ready',
    event_at: '2026-05-11T00:00:01.000Z',
    worker_id: 'run-1',
    source_url: '',
    attempt: 0,
    status: 'running',
    content: { pageCount: 1 },
    content_hash: '',
    screenshot_path: '',
    snapshot_path: '',
    error: '',
    listing: {
      detail_status: '',
      card_title: '',
      detail_title: '',
      detail_price: '',
      detail_location: '',
      detail_seller_name: '',
      screenshot_path: '',
      snapshot_path: '',
    },
  });
});

test('appendWorkflowEvent writes event and increments workflow stats cache', async () => {
  const pool = createFakePool();
  const store = createMarketplaceWorkflowEventsPostgresStore({
    pool,
    nowIso: () => '2026-05-11T00:00:01.000Z',
  });

  const event = await store.appendWorkflowEvent({
    eventId: 'event-created',
    workflowRunId: 'run-1',
    eventType: 'browser_context_ready',
    status: 'running',
    content: { pageCount: 1 },
  });

  assert.equal(event.event_id, 'event-created');
  assert.deepEqual(event.content, { pageCount: 1 });
  const insert = pool.calls.find((call) => /INSERT INTO workflow_events/.test(call.sql));
  assert.ok(insert);
  assert.deepEqual(insert.params, [
    'event-created',
    'run-1',
    'browser_context_ready',
    '2026-05-11T00:00:01.000Z',
    'running',
    JSON.stringify({ pageCount: 1 }, null, 2),
    '',
  ]);
  const cache = pool.calls.find((call) => /INSERT INTO worker_event_stats_cache/.test(call.sql));
  assert.ok(cache);
  assert.deepEqual(cache.params, [
    'run-1',
    'workflow',
    'browser_context_ready',
    'running',
    1,
    '2026-05-11T00:00:01.000Z',
  ]);
});

test('workflow event listing supports event type filters and worker event shape', async () => {
  const pool = createFakePool([
    {
      event_id: 'older-event',
      workflow_run_id: 'run-1',
      event_type: 'browser_context_launch_started',
      event_at: '2026-05-11T00:00:00.000Z',
      status: 'starting',
      content_json: '{"headless":true}',
      error: '',
    },
    {
      event_id: 'ready-event',
      workflow_run_id: 'run-1',
      event_type: 'browser_context_ready',
      event_at: '2026-05-11T00:00:01.000Z',
      status: 'running',
      content_json: '{"pageCount":1}',
      error: '',
    },
  ]);
  const store = createMarketplaceWorkflowEventsPostgresStore({ pool });

  const filtered = await store.listWorkflowEvents('run-1', {
    eventType: 'browser_context_ready',
    limit: 500,
  });
  assert.deepEqual(filtered.map((event) => event.event_id), ['ready-event']);
  assert.deepEqual(pool.calls[0].params, ['run-1', 'browser_context_ready', 200]);
  assert.match(pool.calls[0].sql, /AND event_type = \$2/);
  assert.match(pool.calls[0].sql, /LIMIT \$3/);

  const workerRows = await store.listWorkerWorkflowEvents('run-1', { limit: 10 });
  assert.deepEqual(workerRows.map((event) => event.event_scope), ['workflow', 'workflow']);
  assert.deepEqual(workerRows.map((event) => event.event_id), ['ready-event', 'older-event']);
});

test('workflow event store validates required workflow id and closes pool', async () => {
  const pool = createFakePool();
  const store = createMarketplaceWorkflowEventsPostgresStore({ pool });

  await assert.rejects(
    () => store.appendWorkflowEvent({ eventType: 'bad' }),
    /appendWorkflowEvent requires workflowRunId/,
  );
  assert.equal(await store.getWorkflowEvent('missing-event'), null);
  assert.equal(boundedLimit('bad', 50), 50);
  assert.equal(boundedLimit(0, 50), 1);
  assert.equal(boundedLimit(500, 50), 200);
  await store.close();
  assert.equal(pool.ended, true);
});
