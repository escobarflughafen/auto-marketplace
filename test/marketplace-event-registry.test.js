const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  openMarketplaceHomepageDatabase,
  closeMarketplaceHomepageDatabase,
  upsertHomepageListing,
  appendListingEvent,
  appendWorkflowEvent,
  listEventRegistry,
  countEventRegistry,
} = require('../scripts/marketplace-homepage-db');

function createTempDbPath() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-event-registry-'));
  return {
    dbPath: path.join(tempDir, 'events.db'),
    tempDir,
  };
}

test('event registry clamps oversized pages and merges newest all-source events', () => {
  const { dbPath, tempDir } = createTempDbPath();
  const { db } = openMarketplaceHomepageDatabase(dbPath);
  try {
    upsertHomepageListing(db, {
      href: 'https://www.facebook.com/marketplace/item/100/',
      title: 'Registry test listing',
      text: '$100',
      rank: 1,
    }, { seenAt: '2026-06-05T00:00:00.000Z' });

    for (let index = 0; index < 600; index += 1) {
      appendListingEvent(db, {
        eventId: `listing-event-${index}`,
        listingId: '100',
        eventType: 'listing_observed',
        eventAt: new Date(Date.UTC(2026, 5, 5, 0, 0, index)).toISOString(),
        status: 'done',
        content: { index },
      });
    }

    appendWorkflowEvent(db, {
      eventId: 'workflow-event-latest',
      workflowRunId: 'worker-registry-test',
      eventType: 'worker_completed',
      eventAt: '2026-06-05T01:00:00.000Z',
      status: 'completed',
      content: { reason: 'test' },
    });

    const listingEvents = listEventRegistry(db, { source: 'listing', limit: 10000 });
    assert.equal(listingEvents.length, 500);
    assert.equal(listingEvents[0].event_id, 'listing-event-599');
    assert.equal(listingEvents.at(-1).event_id, 'listing-event-100');

    const allEvents = listEventRegistry(db, { source: 'all', limit: 3 });
    assert.deepEqual(allEvents.map((event) => event.event_id), [
      'workflow-event-latest',
      'listing-event-599',
      'listing-event-598',
    ]);
    assert.equal(countEventRegistry(db, { source: 'all' }), 601);
  } finally {
    closeMarketplaceHomepageDatabase(db);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
