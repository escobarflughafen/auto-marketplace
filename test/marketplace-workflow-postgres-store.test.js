const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createMarketplaceWorkflowPostgresStore,
  normalizeWorkflowRunRow,
  normalizeWorkflowRunLiveRow,
  boundedLimit,
} = require('../scripts/marketplace-workflow-postgres-store');

function createFakePool(initialRows = []) {
  const calls = [];
  const rows = new Map(initialRows.map((row) => [row.run_id, { ...row }]));
  return {
    calls,
    rows,
    ended: false,
    async query(sql, params = []) {
      calls.push({ sql, params });

      if (/^\s*SELECT\s+\*/.test(sql) && /WHERE run_id = \$1/.test(sql)) {
        return { rows: rows.has(params[0]) ? [{ ...rows.get(params[0]) }] : [] };
      }
      if (/^\s*SELECT\s+\*/.test(sql) && /ORDER BY started_at DESC/.test(sql)) {
        const limit = params[0];
        return {
          rows: [...rows.values()]
            .sort((left, right) => String(right.started_at).localeCompare(String(left.started_at)))
            .slice(0, limit)
            .map((row) => ({ ...row })),
        };
      }
      if (/SELECT\s+run_id,[\s\S]*AS log_count/.test(sql)) {
        const row = rows.get(params[0]);
        if (!row) return { rows: [] };
        let logCount = 0;
        try {
          const logs = JSON.parse(row.logs_json || '[]');
          logCount = Array.isArray(logs) ? logs.length : 0;
        } catch {
          logCount = 0;
        }
        return { rows: [{ ...row, log_count: String(logCount) }] };
      }
      if (/INSERT INTO workflow_runs/.test(sql)) {
        const [
          runId,
          workflowId,
          label,
          script,
          argsJson,
          pid,
          status,
          startedAt,
          updatedAt,
          osAlive,
          logsJson,
        ] = params;
        rows.set(runId, {
          run_id: runId,
          workflow_id: workflowId,
          label,
          script,
          args_json: argsJson,
          pid,
          status,
          started_at: startedAt,
          updated_at: updatedAt,
          exited_at: '',
          exit_code: null,
          signal: '',
          os_checked_at: '',
          os_alive: osAlive,
          logs_json: logsJson,
        });
        return { rows: [] };
      }
      if (/UPDATE workflow_runs/.test(sql)) {
        const [
          workflowId,
          label,
          script,
          argsJson,
          pid,
          status,
          updatedAt,
          exitedAt,
          exitCode,
          signal,
          osCheckedAt,
          osAlive,
          logsJson,
          runId,
        ] = params;
        const previous = rows.get(runId);
        if (previous) {
          rows.set(runId, {
            ...previous,
            workflow_id: workflowId,
            label,
            script,
            args_json: argsJson,
            pid,
            status,
            updated_at: updatedAt,
            exited_at: exitedAt,
            exit_code: exitCode,
            signal,
            os_checked_at: osCheckedAt,
            os_alive: osAlive,
            logs_json: logsJson,
          });
        }
        return { rows: [] };
      }
      return { rows: [] };
    },
    async end() {
      this.ended = true;
    },
  };
}

test('normalizes PostgreSQL workflow run rows to SQLite helper shape', () => {
  assert.deepEqual(normalizeWorkflowRunRow({
    run_id: 'run-1',
    workflow_id: 'search-explore',
    label: 'Search Explorer',
    script: 'marketplace:search:explore',
    args_json: '["--query","pentax"]',
    pid: '12345',
    status: 'running',
    started_at: '2026-05-08T00:00:00.000Z',
    updated_at: '2026-05-08T00:00:10.000Z',
    exited_at: '',
    exit_code: null,
    signal: '',
    os_checked_at: '',
    os_alive: '1',
    logs_json: '["started"]',
  }), {
    run_id: 'run-1',
    workflow_id: 'search-explore',
    label: 'Search Explorer',
    script: 'marketplace:search:explore',
    args: ['--query', 'pentax'],
    pid: 12345,
    status: 'running',
    started_at: '2026-05-08T00:00:00.000Z',
    updated_at: '2026-05-08T00:00:10.000Z',
    exited_at: '',
    exit_code: null,
    signal: '',
    os_checked_at: '',
    os_alive: true,
    logs: ['started'],
  });

  assert.deepEqual(normalizeWorkflowRunLiveRow({
    run_id: 'run-1',
    workflow_id: 'search-explore',
    label: 'Search Explorer',
    script: 'marketplace:search:explore',
    pid: '12345',
    status: 'running',
    started_at: '2026-05-08T00:00:00.000Z',
    updated_at: '2026-05-08T00:00:10.000Z',
    exited_at: '',
    exit_code: '',
    signal: '',
    os_checked_at: '',
    os_alive: '0',
    log_count: '3',
  }), {
    run_id: 'run-1',
    workflow_id: 'search-explore',
    label: 'Search Explorer',
    script: 'marketplace:search:explore',
    args: [],
    pid: 12345,
    status: 'running',
    started_at: '2026-05-08T00:00:00.000Z',
    updated_at: '2026-05-08T00:00:10.000Z',
    exited_at: '',
    exit_code: null,
    signal: '',
    os_checked_at: '',
    os_alive: false,
    logs: [],
    log_count: 3,
  });
});

test('workflow store inserts, updates, lists, and closes through an injected pool', async () => {
  const pool = createFakePool();
  const store = createMarketplaceWorkflowPostgresStore({
    pool,
    nowIso: () => '2026-05-08T00:01:01.000Z',
  });

  const created = await store.insertWorkflowRun({
    runId: 'run-1',
    workflowId: 'search-explore',
    label: 'Search Explorer',
    script: 'marketplace:search:explore',
    args: ['--query', 'pentax'],
    pid: 12345,
    status: 'running',
    startedAt: '2026-05-08T00:00:00.000Z',
    osAlive: true,
    logs: ['started'],
  });

  assert.equal(created.run_id, 'run-1');
  assert.deepEqual(created.args, ['--query', 'pentax']);
  assert.equal(created.os_alive, true);
  const insert = pool.calls.find((call) => /INSERT INTO workflow_runs/.test(call.sql));
  assert.ok(insert);
  assert.match(insert.sql, /\$11/);
  assert.deepEqual(insert.params, [
    'run-1',
    'search-explore',
    'Search Explorer',
    'marketplace:search:explore',
    JSON.stringify(['--query', 'pentax'], null, 2),
    12345,
    'running',
    '2026-05-08T00:00:00.000Z',
    '2026-05-08T00:00:00.000Z',
    1,
    JSON.stringify(['started'], null, 2),
  ]);

  const updated = await store.updateWorkflowRun('run-1', {
    status: 'exited',
    exitedAt: '2026-05-08T00:01:00.000Z',
    exitCode: 0,
    osAlive: false,
    osCheckedAt: '2026-05-08T00:01:01.000Z',
    logs: ['started', 'done'],
  });

  assert.equal(updated.status, 'exited');
  assert.equal(updated.exit_code, 0);
  assert.equal(updated.os_alive, false);
  assert.deepEqual(updated.logs, ['started', 'done']);
  const update = pool.calls.find((call) => /UPDATE workflow_runs/.test(call.sql));
  assert.ok(update);
  assert.deepEqual(update.params.slice(-4), [
    '2026-05-08T00:01:01.000Z',
    0,
    JSON.stringify(['started', 'done'], null, 2),
    'run-1',
  ]);

  const live = await store.getWorkflowRunLive('run-1');
  assert.deepEqual(live.args, []);
  assert.deepEqual(live.logs, []);
  assert.equal(live.log_count, 2);
  assert.equal((await store.listWorkflowRuns({ limit: 500 })).length, 1);
  assert.deepEqual(pool.calls.find((call) => /LIMIT \$1/.test(call.sql)).params, [100]);
  await store.close();
  assert.equal(pool.ended, true);
});

test('workflow store returns null for missing updates and bounds list limits', async () => {
  const pool = createFakePool();
  const store = createMarketplaceWorkflowPostgresStore({ pool });

  assert.equal(await store.updateWorkflowRun('missing-run', { status: 'exited' }), null);
  assert.equal(await store.getWorkflowRun('missing-run'), null);
  assert.equal(await store.getWorkflowRunLive('missing-run'), null);
  assert.equal(boundedLimit('bad', 25), 25);
  assert.equal(boundedLimit(0, 25), 1);
  assert.equal(boundedLimit(1000, 25), 100);
});
