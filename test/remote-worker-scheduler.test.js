const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decideRemoteWorkerSchedulerState,
  planRemoteWorkerEventBatch,
} = require('../scripts/remote-worker-scheduler');

test('remote worker scheduler claims work only when host and local queues are healthy', () => {
  const decision = decideRemoteWorkerSchedulerState({
    hostState: 'connected',
    drainRequested: false,
    shutdownRequested: false,
    activeClaims: 0,
    maxConcurrentClaims: 1,
    pendingEventCount: 4,
    maxLocalPendingEvents: 100,
    pendingArtifactBytes: 1024,
    maxLocalArtifactBytes: 1024 * 1024,
    diskFreeMb: 4096,
    minDiskFreeMb: 512,
  });

  assert.equal(decision.state, 'claiming');
  assert.equal(decision.canClaim, true);
  assert.deepEqual(decision.reasons, []);
});

test('remote worker scheduler enters backpressure before claiming new work', () => {
  const decision = decideRemoteWorkerSchedulerState({
    hostState: 'connected',
    drainRequested: false,
    shutdownRequested: false,
    activeClaims: 0,
    maxConcurrentClaims: 2,
    pendingEventCount: 10001,
    maxLocalPendingEvents: 10000,
    pendingArtifactBytes: 10,
    maxLocalArtifactBytes: 1024 * 1024,
    diskFreeMb: 4096,
    minDiskFreeMb: 512,
  });

  assert.equal(decision.state, 'backpressure');
  assert.equal(decision.canClaim, false);
  assert.ok(decision.reasons.includes('pending_event_limit'));
});

test('remote worker scheduler stops claiming when host is offline or draining', () => {
  assert.equal(decideRemoteWorkerSchedulerState({
    hostState: 'offline',
    drainRequested: false,
    shutdownRequested: false,
    activeClaims: 0,
    maxConcurrentClaims: 1,
    pendingEventCount: 0,
    maxLocalPendingEvents: 100,
    pendingArtifactBytes: 0,
    maxLocalArtifactBytes: 1024,
    diskFreeMb: 4096,
    minDiskFreeMb: 512,
  }).state, 'offline');

  assert.equal(decideRemoteWorkerSchedulerState({
    hostState: 'connected',
    drainRequested: true,
    shutdownRequested: false,
    activeClaims: 0,
    maxConcurrentClaims: 1,
    pendingEventCount: 0,
    maxLocalPendingEvents: 100,
    pendingArtifactBytes: 0,
    maxLocalArtifactBytes: 1024,
    diskFreeMb: 4096,
    minDiskFreeMb: 512,
  }).state, 'draining');
});

test('remote worker event batch planner respects sequence order, batch size, and byte budget', () => {
  const events = [
    { eventId: 'event-3', sequence: 3, status: 'pending', payloadJson: '{"large":"1234567890"}' },
    { eventId: 'event-1', sequence: 1, status: 'pending', payloadJson: '{"ok":1}' },
    { eventId: 'event-2', sequence: 2, status: 'pending', payloadJson: '{"ok":2}' },
    { eventId: 'event-4', sequence: 4, status: 'acked', payloadJson: '{"ignored":true}' },
  ];

  const plan = planRemoteWorkerEventBatch(events, {
    maxEventBatchSize: 3,
    maxEventBatchBytes: 20,
  });

  assert.deepEqual(plan.events.map((event) => event.eventId), ['event-1', 'event-2']);
  assert.equal(plan.firstSequence, 1);
  assert.equal(plan.lastSequence, 2);
  assert.equal(plan.hasMore, true);
});
