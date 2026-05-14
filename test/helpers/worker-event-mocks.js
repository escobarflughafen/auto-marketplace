function createMockWorkerEvent(overrides = {}) {
  const eventId = overrides.eventId || overrides.event_id || 'test-event-worker-001';
  const eventType = overrides.eventType || overrides.event_type || 'worker_test_event';
  const labels = [...new Set(['test_event', ...(overrides.labels || [])])];
  return {
    eventId,
    eventType,
    eventAt: overrides.eventAt || overrides.event_at || '2026-05-13T20:00:00.000Z',
    workerId: overrides.workerId || overrides.worker_id || 'test-worker-1',
    sourceId: overrides.sourceId || overrides.source_id || 'test-suite',
    labels,
    payload: {
      testEvent: true,
      fixture: 'worker-event-mocks',
      ...(overrides.payload || {}),
    },
  };
}

function createMockCaptureEventSet(workerId = 'test-worker-1') {
  return [
    createMockWorkerEvent({
      eventId: 'test-event-command-started',
      eventType: 'browser_command_started',
      workerId,
      payload: {
        commandId: 'test-command-1',
        listingId: 'test-listing-1',
      },
    }),
    createMockWorkerEvent({
      eventId: 'test-event-capture-succeeded',
      eventType: 'listing_capture_succeeded',
      eventAt: '2026-05-13T20:00:01.000Z',
      workerId,
      payload: {
        commandId: 'test-command-1',
        listingId: 'test-listing-1',
        detailStatus: 'done',
      },
    }),
  ];
}

function createMockBrowserCommand(overrides = {}) {
  const commandId = overrides.commandId || overrides.command_id || 'test-command-1';
  const labels = [...new Set(['test_event', ...(overrides.labels || [])])];
  return {
    commandId,
    commandType: overrides.commandType || overrides.command_type || 'capture_listing_detail',
    entityId: overrides.entityId || overrides.entity_id || 'test-listing-1',
    priority: overrides.priority ?? 0,
    requestedAt: overrides.requestedAt || overrides.requested_at || '2026-05-13T20:01:00.000Z',
    sourceId: overrides.sourceId || overrides.source_id || 'test-suite',
    actor: overrides.actor || 'test-runner',
    labels,
    payload: {
      testEvent: true,
      fixture: 'worker-event-mocks',
      listingId: overrides.listingId || overrides.listing_id || 'test-listing-1',
      url: overrides.url || 'https://example.test/marketplace/item/test-listing-1/',
      ...(overrides.payload || {}),
    },
  };
}

module.exports = {
  createMockWorkerEvent,
  createMockCaptureEventSet,
  createMockBrowserCommand,
};
