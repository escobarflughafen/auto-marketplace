const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  openMarketplaceHomepageDatabase,
  closeMarketplaceHomepageDatabase,
  getWorkflowRun,
  listWorkflowEvents,
  getWorkerAuditEventStats,
} = require('../scripts/marketplace-homepage-db');
const {
  workflowLifecycleEventForStatus,
  insertWorkflowRunWithLifecycleEvent,
  updateWorkflowRunWithLifecycleEvent,
} = require('../scripts/serve-marketplace-homepage');

function createTempDbPath() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-workflow-lifecycle-'));
  return path.join(tempDir, 'workflow.db');
}

test('workflow lifecycle reducer maps run states to semantic events', () => {
  assert.deepEqual(
    workflowLifecycleEventForStatus('stopping', { workflowId: 'search-explore' }),
    {
      eventType: 'shutdown_requested',
      status: 'stopping',
      content: {
        workerType: 'collector',
        strategy: 'explorer',
        workflowId: 'search-explore',
        signal: 'SIGTERM',
      },
    },
  );

  assert.equal(
    workflowLifecycleEventForStatus('starting', { workflowId: 'search-explore' }),
    null,
  );
});

test('workflow lifecycle reducer commits run projection and event together', () => {
  const dbPath = createTempDbPath();
  const { db } = openMarketplaceHomepageDatabase(dbPath);

  try {
    insertWorkflowRunWithLifecycleEvent(db, {
      runId: 'workflow-reducer-run',
      workflowId: 'search-explore',
      label: 'Search Explorer',
      script: 'marketplace:search:explore',
      args: ['--query', 'pentax'],
      pid: 12345,
      status: 'running',
      startedAt: '2026-06-09T00:00:00.000Z',
      updatedAt: '2026-06-09T00:00:00.000Z',
      osAlive: true,
      logs: ['started marketplace:search:explore --query pentax'],
    }, {
      eventAt: '2026-06-09T00:00:00.000Z',
    });

    assert.equal(getWorkflowRun(db, 'workflow-reducer-run').status, 'running');
    let events = listWorkflowEvents(db, 'workflow-reducer-run');
    assert.equal(events.length, 1);
    assert.equal(events[0].event_type, 'worker_started');
    assert.equal(events[0].status, 'running');
    assert.equal(events[0].content.workerType, 'collector');
    assert.equal(events[0].content.strategy, 'explorer');

    updateWorkflowRunWithLifecycleEvent(db, 'workflow-reducer-run', {
      status: 'failed',
      exitedAt: '2026-06-09T00:00:12.000Z',
      exitCode: 1,
      osAlive: false,
      osCheckedAt: '2026-06-09T00:00:12.000Z',
      logs: ['started marketplace:search:explore --query pentax', 'process_exit code=1 signal='],
    }, {
      eventAt: '2026-06-09T00:00:12.000Z',
      reason: 'process_exit',
    });

    const updated = getWorkflowRun(db, 'workflow-reducer-run');
    assert.equal(updated.status, 'failed');
    assert.equal(updated.exit_code, 1);

    events = listWorkflowEvents(db, 'workflow-reducer-run');
    assert.equal(events.length, 2);
    assert.equal(events[0].event_type, 'worker_failed');
    assert.equal(events[0].status, 'failed');
    assert.equal(events[0].content.reason, 'process_exit');

    const stats = getWorkerAuditEventStats(db, 'workflow-reducer-run', { cacheOnly: true });
    assert.equal(stats.workflow, 2);
    assert.equal(stats.workflowReview, 1);
    assert.equal(stats.error, 1);
  } finally {
    closeMarketplaceHomepageDatabase(db);
  }
});

test('workflow lifecycle reducer records shutdown, terminated, and lost states distinctly', () => {
  const dbPath = createTempDbPath();
  const { db } = openMarketplaceHomepageDatabase(dbPath);

  try {
    insertWorkflowRunWithLifecycleEvent(db, {
      runId: 'workflow-stop-run',
      workflowId: 'backlog-resolve',
      label: 'Resolve Pending Backlog',
      script: 'marketplace:home:process',
      args: ['--drain'],
      pid: 23456,
      status: 'running',
      startedAt: '2026-06-09T01:00:00.000Z',
      updatedAt: '2026-06-09T01:00:00.000Z',
      osAlive: true,
      logs: ['started marketplace:home:process --drain'],
    }, {
      eventAt: '2026-06-09T01:00:00.000Z',
    });

    updateWorkflowRunWithLifecycleEvent(db, 'workflow-stop-run', {
      status: 'stopping',
      osAlive: true,
      osCheckedAt: '2026-06-09T01:00:05.000Z',
      logs: ['started marketplace:home:process --drain', 'stop requested'],
    }, {
      eventAt: '2026-06-09T01:00:05.000Z',
      reason: 'stop_requested',
      signal: 'SIGTERM',
    });

    updateWorkflowRunWithLifecycleEvent(db, 'workflow-stop-run', {
      status: 'terminated',
      exitedAt: '2026-06-09T01:00:06.000Z',
      signal: 'SIGTERM',
      osAlive: false,
      osCheckedAt: '2026-06-09T01:00:06.000Z',
      logs: ['started marketplace:home:process --drain', 'stop requested', 'process_exit code=null signal=SIGTERM'],
    }, {
      eventAt: '2026-06-09T01:00:06.000Z',
      reason: 'shutdown',
    });

    const stopEvents = listWorkflowEvents(db, 'workflow-stop-run');
    assert.deepEqual(
      stopEvents.map((event) => `${event.event_type}:${event.status}`).reverse(),
      [
        'worker_started:running',
        'shutdown_requested:stopping',
        'worker_completed:terminated',
      ],
    );
    assert.equal(stopEvents[1].content.signal, 'SIGTERM');

    insertWorkflowRunWithLifecycleEvent(db, {
      runId: 'workflow-lost-run',
      workflowId: 'home-collect',
      label: 'Homepage Collector',
      script: 'marketplace:home:collect',
      args: ['--once'],
      pid: 34567,
      status: 'running',
      startedAt: '2026-06-09T02:00:00.000Z',
      updatedAt: '2026-06-09T02:00:00.000Z',
      osAlive: true,
      logs: ['started marketplace:home:collect --once'],
    }, {
      eventAt: '2026-06-09T02:00:00.000Z',
    });

    updateWorkflowRunWithLifecycleEvent(db, 'workflow-lost-run', {
      status: 'lost',
      exitedAt: '2026-06-09T02:05:00.000Z',
      osAlive: false,
      osCheckedAt: '2026-06-09T02:05:00.000Z',
      logs: ['started marketplace:home:collect --once', 'workflow_reconciled status=lost reason=process_missing'],
    }, {
      eventAt: '2026-06-09T02:05:00.000Z',
      reason: 'process_missing',
    });

    const lostEvents = listWorkflowEvents(db, 'workflow-lost-run');
    assert.equal(lostEvents[0].event_type, 'worker_failed');
    assert.equal(lostEvents[0].status, 'lost');
    assert.equal(lostEvents[0].content.reason, 'process_missing');
  } finally {
    closeMarketplaceHomepageDatabase(db);
  }
});
