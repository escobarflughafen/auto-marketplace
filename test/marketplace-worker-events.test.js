const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  WORKER_TYPES,
  WORKER_STRATEGIES,
  EVENT_DEFINITIONS,
  getWorkerEventDefinition,
  listWorkerEventDefinitions,
  normalizeWorkerStrategy,
  validateWorkerEvent,
} = require('../scripts/marketplace-worker-events');
const {
  openMarketplaceHomepageDatabase,
  closeMarketplaceHomepageDatabase,
  upsertHomepageListing,
  listWorkflowEvents,
  getListingEvents,
} = require('../scripts/marketplace-homepage-db');
const {
  appendRegulatedWorkflowEvent,
  appendRegulatedListingEvent,
} = require('../scripts/marketplace-worker-event-writer');

function createTempDbPath() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-worker-events-'));
  return path.join(tempDir, 'events.db');
}

test('worker model exposes primary worker types with explicit strategies', () => {
  assert.deepEqual(Object.values(WORKER_TYPES).sort(), ['backlog_indexer', 'collector', 'profile_onboarder', 'resolver']);
  assert.deepEqual(WORKER_STRATEGIES.collector, ['feed', 'search', 'explorer']);
  assert.deepEqual(WORKER_STRATEGIES.resolver, ['queue', 'selected', 'filtered']);
  assert.deepEqual(WORKER_STRATEGIES.backlog_indexer, ['resolved_metadata']);
  assert.deepEqual(WORKER_STRATEGIES.profile_onboarder, ['guided_login']);
  assert.equal(normalizeWorkerStrategy('collector', 'SEARCH'), 'search');
  assert.equal(normalizeWorkerStrategy('backlog_indexer', 'RESOLVED_METADATA'), 'resolved_metadata');
  assert.equal(normalizeWorkerStrategy('profile_onboarder', 'GUIDED_LOGIN'), 'guided_login');
  assert.throws(
    () => normalizeWorkerStrategy('resolver', 'explorer'),
    /Unknown resolver strategy: explorer/,
  );
});

test('event registry has unique event types and required routing metadata', () => {
  const eventTypes = EVENT_DEFINITIONS.map((definition) => definition.eventType);
  assert.equal(new Set(eventTypes).size, eventTypes.length);

  for (const definition of EVENT_DEFINITIONS) {
    assert.ok(definition.eventType);
    assert.ok(definition.scope);
    assert.ok(definition.table);
    assert.ok(definition.workerTypes.length > 0);
    assert.ok(definition.channels.length > 0);
  }
});

test('collector strategy event list includes collector events and excludes resolver-only capture events', () => {
  const eventTypes = listWorkerEventDefinitions({
    workerType: 'collector',
    strategy: 'explorer',
  }).map((definition) => definition.eventType);

  assert.ok(eventTypes.includes('collector_cycle_started'));
  assert.ok(eventTypes.includes('collector_query_selected'));
  assert.ok(eventTypes.includes('listing_observed'));
  assert.ok(!eventTypes.includes('detail_capture_started'));
  assert.ok(!eventTypes.includes('detail_capture_succeeded'));
});

test('resolver strategy event list includes detail capture events and excludes collector-only events', () => {
  const eventTypes = listWorkerEventDefinitions({
    workerType: 'resolver',
    strategy: 'selected',
  }).map((definition) => definition.eventType);

  assert.ok(eventTypes.includes('detail_capture_started'));
  assert.ok(eventTypes.includes('detail_capture_succeeded'));
  assert.ok(eventTypes.includes('detail_capture_failed'));
  assert.ok(!eventTypes.includes('collector_cycle_started'));
  assert.ok(!eventTypes.includes('listing_observed'));
});

test('backlog indexer event list includes metadata indexing events and excludes browser capture events', () => {
  const eventTypes = listWorkerEventDefinitions({
    workerType: 'backlog_indexer',
    strategy: 'resolved_metadata',
  }).map((definition) => definition.eventType);

  assert.ok(eventTypes.includes('backlog_index_started'));
  assert.ok(eventTypes.includes('backlog_index_completed'));
  assert.ok(eventTypes.includes('worker_sleeping'));
  assert.ok(!eventTypes.includes('detail_capture_started'));
  assert.ok(!eventTypes.includes('browser_context_ready'));
});

test('profile onboarder event list includes interactive auth events', () => {
  const eventTypes = listWorkerEventDefinitions({
    workerType: 'profile_onboarder',
    strategy: 'guided_login',
  }).map((definition) => definition.eventType);

  assert.ok(eventTypes.includes('profile_onboarding_started'));
  assert.ok(eventTypes.includes('verification_required'));
  assert.ok(eventTypes.includes('user_command_received'));
  assert.ok(eventTypes.includes('profile_ready'));
  assert.ok(!eventTypes.includes('listing_observed'));
  assert.ok(!eventTypes.includes('backlog_index_started'));
});

test('event validation enforces worker type, strategy, and required payload keys', () => {
  const valid = validateWorkerEvent({
    eventType: 'collector_cycle_completed',
    workerType: 'collector',
    strategy: 'feed',
    payload: {
      strategy: 'feed',
      observedCount: 10,
    },
  });
  assert.equal(valid.eventType, 'collector_cycle_completed');
  assert.equal(valid.workerType, 'collector');
  assert.equal(valid.strategy, 'feed');

  assert.throws(
    () => validateWorkerEvent({
      eventType: 'collector_cycle_completed',
      workerType: 'resolver',
      strategy: 'queue',
      payload: {
        strategy: 'queue',
        observedCount: 1,
      },
    }),
    /not valid for worker type resolver/,
  );

  assert.throws(
    () => validateWorkerEvent({
      eventType: 'detail_capture_succeeded',
      workerType: 'resolver',
      strategy: 'queue',
      payload: {
        listingId: '123',
      },
    }),
    /missing required payload keys: attempt/,
  );
});

test('current live resolver event names are registered', () => {
  for (const eventType of [
    'detail_capture_started',
    'detail_capture_succeeded',
    'detail_capture_bypassed',
    'content_changed',
    'detail_capture_interrupted',
    'listing_unavailable',
    'detail_capture_failed',
    'worker_started',
    'browser_context_launch_started',
    'browser_context_ready',
    'session_ready',
    'shutdown_requested',
    'worker_completed',
    'worker_failed',
    'browser_context_closing',
    'browser_context_closed',
  ]) {
    assert.ok(getWorkerEventDefinition(eventType), `${eventType} should be registered`);
  }
});

test('resolve queue event names are registered', () => {
  for (const eventType of [
    'resolve_queue_added',
    'resolve_queue_requeued',
    'resolve_queue_dispatched',
    'resolve_queue_completed',
    'resolve_queue_failed',
    'resolve_queue_cleared',
  ]) {
    assert.ok(getWorkerEventDefinition(eventType), `${eventType} should be registered`);
  }
});

test('backlog indexer event names are registered', () => {
  for (const eventType of [
    'backlog_index_started',
    'backlog_index_completed',
    'backlog_index_failed',
  ]) {
    assert.ok(getWorkerEventDefinition(eventType), `${eventType} should be registered`);
  }
});

test('profile onboarder event names are registered', () => {
  for (const eventType of [
    'profile_onboarding_started',
    'profile_onboarding_step',
    'credentials_submitted',
    'verification_required',
    'external_approval_required',
    'user_command_received',
    'profile_ready',
    'profile_onboarding_failed',
  ]) {
    assert.ok(getWorkerEventDefinition(eventType), `${eventType} should be registered`);
  }
});

test('regulated event writer persists collector workflow and listing events', () => {
  const { db } = openMarketplaceHomepageDatabase(createTempDbPath());
  try {
    upsertHomepageListing(db, {
      listingId: 'event-writer-listing',
      href: 'https://www.facebook.com/marketplace/item/700001/',
      title: 'Event writer listing',
      text: 'CA$ 100',
      rank: 1,
    });

    const workflowEvent = appendRegulatedWorkflowEvent(db, {
      workflowRunId: 'collector-run-1',
      workerId: 'collector-run-1',
      workerType: 'collector',
      strategy: 'feed',
      eventType: 'collector_cycle_completed',
      status: 'completed',
      payload: {
        observedCount: 1,
        newCount: 1,
      },
    });
    assert.equal(workflowEvent.event_type, 'collector_cycle_completed');

    const listingEvent = appendRegulatedListingEvent(db, {
      workflowRunId: 'collector-run-1',
      workerId: 'collector-run-1',
      workerType: 'collector',
      strategy: 'feed',
      eventType: 'listing_observed',
      listingId: 'event-writer-listing',
      sourceUrl: 'https://www.facebook.com/marketplace/item/700001/',
      status: 'new',
      payload: {
        listingId: 'event-writer-listing',
        href: 'https://www.facebook.com/marketplace/item/700001/',
        source: 'homepage',
        outcome: 'new',
      },
    });
    assert.equal(listingEvent.event_type, 'listing_observed');
    assert.equal(listingEvent.worker_id, 'collector-run-1');

    assert.equal(listWorkflowEvents(db, 'collector-run-1')[0].event_type, 'collector_cycle_completed');
    assert.equal(getListingEvents(db, 'event-writer-listing')[0].event_type, 'listing_observed');
  } finally {
    closeMarketplaceHomepageDatabase(db);
  }
});
