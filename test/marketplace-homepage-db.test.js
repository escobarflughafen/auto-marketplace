const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractListingId,
  canonicalizeListingUrl,
  openMarketplaceHomepageDatabase,
  closeMarketplaceHomepageDatabase,
  normalizeKeyword,
  upsertHomepageListingWithStatus,
  upsertHomepageListing,
  claimNextPendingHomepageListing,
  markHomepageListingProcessed,
  markHomepageListingFailed,
  getHomepageListingCounts,
  appendListingEvent,
  getListingEvents,
  getLatestListingEvent,
  hashContent,
  upsertListingSearchKeyword,
  upsertSearchTitleBagKeyword,
  getSearchTitleBagKeyword,
  pickRandomSearchTitleBagKeyword,
  getSearchTitleBagCounts,
} = require('../scripts/marketplace-homepage-db');

function createTempDbPath() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-homepage-db-'));
  return path.join(tempDir, 'queue.db');
}

test('extractListingId and canonicalizeListingUrl normalize Marketplace links', () => {
  const sourceUrl = 'https://www.facebook.com/marketplace/item/123456789/?ref=search&tracking=abc';
  assert.equal(extractListingId(sourceUrl), '123456789');
  assert.equal(
    canonicalizeListingUrl(sourceUrl),
    'https://www.facebook.com/marketplace/item/123456789/',
  );
});

test('listing events are append-only detail history', () => {
  const dbPath = createTempDbPath();
  const { db } = openMarketplaceHomepageDatabase(dbPath);

  try {
    upsertHomepageListing(db, {
      listingId: 'event-1',
      href: 'https://www.facebook.com/marketplace/item/601/',
      title: 'Pentax 67',
      text: 'CA$ 1500 | Pentax 67',
      rank: 1,
    });

    const content = {
      detail: {
        title: 'Pentax 67',
        price: 'CA$ 1500',
      },
    };
    const contentHash = hashContent(content.detail);
    const event = appendListingEvent(db, {
      listingId: 'event-1',
      eventType: 'detail_capture_succeeded',
      eventAt: '2026-05-07T00:00:00.000Z',
      workerId: 'worker-a',
      sourceUrl: 'https://www.facebook.com/marketplace/item/601/',
      attempt: 1,
      status: 'done',
      content,
      contentHash,
      screenshotPath: '/tmp/601.png',
      snapshotPath: '/tmp/601.md',
    });

    assert.equal(event.listing_id, 'event-1');
    assert.equal(event.event_type, 'detail_capture_succeeded');
    assert.equal(event.content_hash, contentHash);

    appendListingEvent(db, {
      listingId: 'event-1',
      eventType: 'content_changed',
      eventAt: '2026-05-07T00:01:00.000Z',
      workerId: 'worker-a',
      sourceUrl: 'https://www.facebook.com/marketplace/item/601/',
      attempt: 2,
      status: 'changed',
      content: {
        previousContentHash: contentHash,
        nextContentHash: 'next-hash',
      },
      contentHash: 'next-hash',
    });

    const events = getListingEvents(db, 'event-1');
    assert.equal(events.length, 2);
    assert.equal(events[0].event_type, 'content_changed');

    const latestSuccess = getLatestListingEvent(db, 'event-1', {
      eventType: 'detail_capture_succeeded',
    });
    assert.equal(latestSuccess.event_id, event.event_id);
  } finally {
    closeMarketplaceHomepageDatabase(db);
  }
});

test('normalizeKeyword trims and collapses whitespace', () => {
  assert.equal(normalizeKeyword('  nikon   d850  body  '), 'nikon d850 body');
});

test('upsertHomepageListing stores and refreshes homepage queue rows', () => {
  const dbPath = createTempDbPath();
  const { db } = openMarketplaceHomepageDatabase(dbPath);

  try {
    const first = upsertHomepageListing(db, {
      listingId: '100',
      href: 'https://www.facebook.com/marketplace/item/100/?ref=browse',
      title: 'First title',
      text: 'First card text',
      rank: 1,
    }, {
      seenAt: '2026-04-27T00:00:00.000Z',
    });

    assert.equal(first.listing_id, '100');
    assert.equal(first.detail_status, 'pending');
    assert.equal(first.last_seen_rank, 1);

    markHomepageListingProcessed(db, '100', {
      title: 'Processed title',
      listingContent: {
        title: 'Processed title',
        price: 'CA$100',
      },
      screenshotPath: '/tmp/100.png',
      snapshotPath: '/tmp/100.md',
    });

    const refreshed = upsertHomepageListing(db, {
      listingId: '100',
      href: 'https://www.facebook.com/marketplace/item/100/?ref=feed',
      title: 'Updated title',
      text: 'Updated card text',
      rank: 2,
    }, {
      seenAt: '2026-04-27T01:00:00.000Z',
    });

    assert.equal(refreshed.detail_status, 'done');
    assert.equal(refreshed.href, 'https://www.facebook.com/marketplace/item/100/');
    assert.equal(refreshed.card_title, 'Updated title');
    assert.equal(refreshed.last_seen_rank, 2);
  } finally {
    closeMarketplaceHomepageDatabase(db);
  }
});

test('upsertHomepageListingWithStatus reports new vs same vs updated content', () => {
  const dbPath = createTempDbPath();
  const { db } = openMarketplaceHomepageDatabase(dbPath);

  try {
    const created = upsertHomepageListingWithStatus(db, {
      listingId: '300',
      href: 'https://www.facebook.com/marketplace/item/300/?ref=browse',
      title: 'Same title',
      text: 'Same text',
      rank: 1,
    });
    assert.equal(created.outcome, 'new');

    const same = upsertHomepageListingWithStatus(db, {
      listingId: '300',
      href: 'https://www.facebook.com/marketplace/item/300/?ref=feed',
      title: 'Same title',
      text: 'Same text',
      rank: 1,
    });
    assert.equal(same.outcome, 'existing_same');
    assert.equal(same.sameContent, true);

    const updated = upsertHomepageListingWithStatus(db, {
      listingId: '300',
      href: 'https://www.facebook.com/marketplace/item/300/?ref=feed',
      title: 'Updated title',
      text: 'Updated text',
      rank: 2,
    });
    assert.equal(updated.outcome, 'existing_updated');
    assert.equal(updated.sameContent, false);
    assert.equal(updated.rankChanged, true);
  } finally {
    closeMarketplaceHomepageDatabase(db);
  }
});

test('upsertHomepageListingWithStatus stores source and source keyword for search rows', () => {
  const dbPath = createTempDbPath();
  const { db } = openMarketplaceHomepageDatabase(dbPath);

  try {
    const created = upsertHomepageListingWithStatus(db, {
      listingId: 'search-1',
      href: 'https://www.facebook.com/marketplace/item/400/?ref=search',
      title: 'Leica M6',
      text: 'CA$ 3800 | Leica M6',
    }, {
      source: 'search',
      sourceKeyword: 'leica m6',
      seenAt: '2026-04-29T00:00:00.000Z',
    });

    assert.equal(created.row.source, 'search');
    assert.equal(created.row.source_keyword, 'leica m6');
  } finally {
    closeMarketplaceHomepageDatabase(db);
  }
});

test('search keyword helpers keep title bag and listing keyword associations', () => {
  const dbPath = createTempDbPath();
  const { db } = openMarketplaceHomepageDatabase(dbPath);

  try {
    const row = upsertHomepageListing(db, {
      listingId: '500',
      href: 'https://www.facebook.com/marketplace/item/500/',
      title: 'Ricoh GR III',
      text: 'CA$ 1200 | Ricoh GR III',
      rank: 1,
    }, {
      source: 'search',
      sourceKeyword: 'ricoh gr',
      seenAt: '2026-04-29T00:00:00.000Z',
    });
    assert.equal(row.listing_id, '500');

    const bagEntry = upsertSearchTitleBagKeyword(db, 'Ricoh GR III', {
      sourceKeyword: 'ricoh gr',
      seenAt: '2026-04-29T00:00:00.000Z',
    });
    assert.equal(bagEntry.keyword, 'Ricoh GR III');
    assert.equal(bagEntry.times_seen, 1);

    upsertSearchTitleBagKeyword(db, 'Ricoh GR III', {
      sourceKeyword: 'ricoh gr',
      seenAt: '2026-04-29T01:00:00.000Z',
    });
    const refreshedBagEntry = getSearchTitleBagKeyword(db, 'ricoh gr iii');
    assert.equal(refreshedBagEntry.times_seen, 2);
    assert.equal(refreshedBagEntry.last_source_keyword, 'ricoh gr');

    const keywordLink = upsertListingSearchKeyword(db, '500', 'ricoh gr', {
      seenAt: '2026-04-29T00:00:00.000Z',
    });
    assert.equal(keywordLink.keyword, 'ricoh gr');
    assert.equal(keywordLink.times_seen, 1);

    const randomKeyword = pickRandomSearchTitleBagKeyword(db, {
      minTimesSeen: 2,
    });
    assert.equal(randomKeyword.keyword, 'Ricoh GR III');

    const bagCounts = getSearchTitleBagCounts(db);
    assert.equal(bagCounts.totalKeywords, 1);
    assert.equal(bagCounts.totalSeen, 2);
  } finally {
    closeMarketplaceHomepageDatabase(db);
  }
});

test('claimNextPendingHomepageListing prioritizes pending rows and tracks failures', () => {
  const dbPath = createTempDbPath();
  const { db } = openMarketplaceHomepageDatabase(dbPath);

  try {
    upsertHomepageListing(db, {
      listingId: '200',
      href: 'https://www.facebook.com/marketplace/item/200/',
      title: 'Second',
      text: 'Second card',
      rank: 2,
    });
    upsertHomepageListing(db, {
      listingId: '150',
      href: 'https://www.facebook.com/marketplace/item/150/',
      title: 'First',
      text: 'First card',
      rank: 1,
    });

    const claimed = claimNextPendingHomepageListing(db, {
      workerId: 'worker-a',
      staleAfterSeconds: 60,
      claimedAt: '2026-04-27T02:00:00.000Z',
    });
    assert.equal(claimed.listing_id, '150');
    assert.equal(claimed.detail_status, 'processing');
    assert.equal(claimed.claimed_by, 'worker-a');
    assert.equal(claimed.detail_attempts, 1);

    markHomepageListingFailed(db, claimed.listing_id, 'temporary failure');
    const counts = getHomepageListingCounts(db);
    assert.equal(counts.pending, 1);
    assert.equal(counts.error, 1);

    const next = claimNextPendingHomepageListing(db, {
      workerId: 'worker-b',
      staleAfterSeconds: 60,
      claimedAt: '2026-04-27T02:05:00.000Z',
    });
    assert.equal(next.listing_id, '200');
  } finally {
    closeMarketplaceHomepageDatabase(db);
  }
});

test('claimNextPendingHomepageListing respects max attempts and source filters', () => {
  const dbPath = createTempDbPath();
  const { db } = openMarketplaceHomepageDatabase(dbPath);

  try {
    upsertHomepageListing(db, {
      listingId: 'source-home',
      href: 'https://www.facebook.com/marketplace/item/701/',
      title: 'Homepage row',
      text: 'Homepage card',
      rank: 1,
    }, {
      source: 'homepage',
    });
    upsertHomepageListing(db, {
      listingId: 'source-search',
      href: 'https://www.facebook.com/marketplace/item/702/',
      title: 'Search row',
      text: 'Search card',
      rank: 2,
    }, {
      source: 'search',
      sourceKeyword: 'pentax',
    });

    const searchClaim = claimNextPendingHomepageListing(db, {
      workerId: 'worker-search',
      sourceFilter: 'search',
      keywordFilter: 'pentax',
      maxAttempts: 1,
      claimedAt: '2026-05-07T00:00:00.000Z',
    });
    assert.equal(searchClaim.listing_id, 'source-search');

    markHomepageListingFailed(db, 'source-search', 'temporary failure');
    const skippedAfterMaxAttempts = claimNextPendingHomepageListing(db, {
      workerId: 'worker-search',
      sourceFilter: 'search',
      keywordFilter: 'pentax',
      maxAttempts: 1,
      claimedAt: '2026-05-07T00:01:00.000Z',
    });
    assert.equal(skippedAfterMaxAttempts, null);

    const homepageClaim = claimNextPendingHomepageListing(db, {
      workerId: 'worker-home',
      sourceFilter: 'homepage',
      claimedAt: '2026-05-07T00:02:00.000Z',
    });
    assert.equal(homepageClaim.listing_id, 'source-home');
  } finally {
    closeMarketplaceHomepageDatabase(db);
  }
});
